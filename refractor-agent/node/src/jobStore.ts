/** Durable job state for the refractor batch pipeline.
 *
 * SQLite (WAL) replaces the JSONL manifest as the source of truth: transactions
 * make result writes and status transitions atomic, the (id, input_hash,
 * pipeline_version) primary key makes reprocessing idempotent, and claims carry
 * a worker id + lease so crashed workers are reclaimed and two workers never
 * take the same item. `events` is an append-only audit trail that the future
 * DSH domain-event projection reads.
 *
 * States: pending → claimed → done | review_required | retryable_failed |
 * terminal_failed. `retryable_failed` is claimable again on the next run;
 * done/review_required/terminal_failed never are.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export const PIPELINE_VERSION_DEFAULT = "refractor-v1";

export type ItemStatus =
  | "pending"
  | "claimed"
  | "done"
  | "review_required"
  | "retryable_failed"
  | "terminal_failed";

export interface RegisterItem {
  id: string;
  path: string;
  inputHash: string;
}

export interface ClaimedItem {
  id: string;
  path: string;
  inputHash: string;
  attempt: number;
}

export interface JobStoreOptions {
  pipelineVersion?: string;
  /** Injectable clock for lease tests. */
  now?: () => number;
}

interface ItemRow {
  id: string;
  path: string;
  input_hash: string;
  status: string;
  attempt: number;
}

export class JobStore {
  private readonly db: Database.Database;
  private readonly pipelineVersion: string;
  private readonly now: () => number;

  constructor(path: string, options: JobStoreOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.pipelineVersion = options.pipelineVersion ?? PIPELINE_VERSION_DEFAULT;
    this.now = options.now ?? Date.now;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id               TEXT NOT NULL,
        path             TEXT NOT NULL,
        input_hash       TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        attempt          INTEGER NOT NULL DEFAULT 0,
        worker_id        TEXT,
        claimed_at       INTEGER,
        lease_until      INTEGER,
        error_code       TEXT,
        last_error       TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (id, input_hash, pipeline_version)
      );
      CREATE TABLE IF NOT EXISTS results (
        item_id          TEXT NOT NULL,
        input_hash       TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        result           TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (item_id, input_hash, pipeline_version)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        item_id TEXT,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  /** Idempotent registration; returns how many rows were newly added. */
  register(items: readonly RegisterItem[]): number {
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO items (id, path, input_hash, pipeline_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    );
    const run = this.db.transaction((list: readonly RegisterItem[]) => {
      let added = 0;
      for (const item of list) {
        added += insert.run(item.id, item.path, item.inputHash, this.pipelineVersion, now, now).changes;
      }
      return added;
    });
    return run(items);
  }

  /** Atomically claim the next workable item, or null when nothing is left.
   *
   * Claimable = pending, retryable_failed whose cooldown has passed, or a
   * claimed item whose lease has expired (crashed worker). The claim bumps
   * `attempt` and takes a lease. For `retryable_failed` rows the `lease_until`
   * column doubles as the retry not-before timestamp.
   */
  claim(workerId: string, leaseMs: number): ClaimedItem | null {
    const now = this.now();
    const claimTx = this.db.transaction((): ClaimedItem | null => {
      const row = this.db
        .prepare(
          `SELECT id, path, input_hash, attempt FROM items
           WHERE pipeline_version = ?
             AND (status = 'pending'
                  OR (status = 'retryable_failed' AND (lease_until IS NULL OR lease_until <= ?))
                  OR (status = 'claimed' AND (lease_until IS NULL OR lease_until <= ?)))
           ORDER BY created_at, id
           LIMIT 1`,
        )
        .get(this.pipelineVersion, now, now) as ItemRow | undefined;
      if (row === undefined) return null;
      this.db
        .prepare(
          `UPDATE items
           SET status = 'claimed', attempt = attempt + 1, worker_id = ?, claimed_at = ?,
               lease_until = ?, updated_at = ?
           WHERE id = ? AND input_hash = ? AND pipeline_version = ?`,
        )
        .run(workerId, now, now + leaseMs, now, row.id, row.input_hash, this.pipelineVersion);
      this.addEvent("item-claimed", row.id, { workerId, attempt: row.attempt + 1 });
      return { id: row.id, path: row.path, inputHash: row.input_hash, attempt: row.attempt + 1 };
    });
    return claimTx.immediate();
  }

  /** Atomically store the result and mark done. Returns whether the result row
   * was newly inserted (a duplicate completion is a no-op). */
  complete(
    item: ClaimedItem,
    result: Record<string, unknown>,
    needsReview: boolean,
  ): { inserted: boolean } {
    const now = this.now();
    const completeTx = this.db.transaction((): { inserted: boolean } => {
      const inserted =
        this.db
          .prepare(
            `INSERT OR IGNORE INTO results (item_id, input_hash, pipeline_version, result, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(item.id, item.inputHash, this.pipelineVersion, JSON.stringify(result), now).changes > 0;
      this.db
        .prepare(
          `UPDATE items SET status = 'done', error_code = NULL, last_error = NULL,
             lease_until = NULL, worker_id = NULL, updated_at = ?
           WHERE id = ? AND input_hash = ? AND pipeline_version = ?`,
        )
        .run(now, item.id, item.inputHash, this.pipelineVersion);
      this.addEvent(needsReview ? "review-required" : "item-completed", item.id, {
        duplicate: !inserted,
      });
      return { inserted };
    });
    return completeTx.immediate();
  }

  /** Record a classified failure; terminal and review states are final.
   *
   * `retryable_failed` rows get a not-before cooldown (`retryCooldownMs`) so a
   * live worker does not hammer a failing provider without backoff; the next
   * run (or this one, after the cooldown) reclaims them.
   */
  fail(
    item: ClaimedItem,
    status: "review_required" | "retryable_failed" | "terminal_failed",
    errorCode: string,
    lastError: string,
    retryCooldownMs = 0,
  ): void {
    const now = this.now();
    const notBefore = status === "retryable_failed" ? now + retryCooldownMs : null;
    const failTx = this.db.transaction((): void => {
      this.db
        .prepare(
          `UPDATE items SET status = ?, error_code = ?, last_error = ?,
             lease_until = ?, worker_id = NULL, updated_at = ?
           WHERE id = ? AND input_hash = ? AND pipeline_version = ?`,
        )
        .run(status, errorCode, lastError, notBefore, now, item.id, item.inputHash, this.pipelineVersion);
      this.addEvent(
        status === "review_required" ? "review-required" : "item-failed",
        item.id,
        { status, errorCode, retryNotBefore: notBefore },
      );
    });
    failTx.immediate();
  }

  /** Item counts by status (whole table, across pipeline versions). */
  stats(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM items GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  results(): Array<{ itemId: string; inputHash: string; result: Record<string, unknown> }> {
    const rows = this.db
      .prepare("SELECT item_id, input_hash, result FROM results ORDER BY created_at, item_id")
      .all() as Array<{ item_id: string; input_hash: string; result: string }>;
    return rows.map((row) => ({
      itemId: row.item_id,
      inputHash: row.input_hash,
      result: JSON.parse(row.result) as Record<string, unknown>,
    }));
  }

  addEvent(kind: string, itemId: string | null, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO events (ts, item_id, kind, payload) VALUES (?, ?, ?, ?)")
      .run(this.now(), itemId, kind, JSON.stringify(payload));
  }

  events(): Array<{ seq: number; itemId: string | null; kind: string; payload: unknown }> {
    const rows = this.db
      .prepare("SELECT seq, item_id, kind, payload FROM events ORDER BY seq")
      .all() as Array<{ seq: number; item_id: string | null; kind: string; payload: string }>;
    return rows.map((row) => ({
      seq: row.seq,
      itemId: row.item_id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  close(): void {
    this.db.close();
  }
}
