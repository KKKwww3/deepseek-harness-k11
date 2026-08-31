/** Vector store + embedder for refractor-agent.
 *
 * TypeScript port of `scripts/refract_store.py`. Production uses the Volcano
 * Ark multimodal embeddings endpoint (`EMBED_BASE_URL` / `EMBED_API_KEY` /
 * `EMBED_MODEL`). Vectors live in an external store selected by
 * `VECTOR_STORE`: `pgvector` (default, Supabase/Postgres, cloud-durable) or
 * `lance` (local LanceDB fallback when no Supabase URL is configured).
 *
 * The multimodal embedding endpoint returns ONE vector per request (the whole
 * `input` list is treated as one multimodal document), so `embed()` issues one
 * request per text — dicts are small (tens of entries), so this is fine.
 *
 * Deployment-varying values come from the environment (no hardcoded tunables).
 * The Python version is the behavioral contract; the local-fallback hashing
 * must stay bit-identical to `Embedder._local` (see test/fixtures/parity.json).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import * as lancedb from "@lancedb/lancedb";

import { AGENT_ROOT, env } from "./env.ts";

export const TABLE = "refractor_types";
export const NAMES_TABLE = "refraction_names";
export const LOCAL_DIM = 256;
// Remote embedding dimension. doubao-embedding-vision-251215 supports MRL
// (dimensions param); 1024 stays under pgvector's 2000-dim HNSW/ivfflat cap
// while keeping quality. Must match the vector column in the PgStore DDL.
export const REMOTE_DIM_DEFAULT = 1024;
// Cosine thresholds calibrated for doubao-embedding-vision-251215 on the seed
// golden set. Re-run the evaluation sweep after enlarging the golden set.
export const REMOTE_THRESHOLD = 0.7;
export const LOCAL_THRESHOLD = 0.5;

export const FINGERPRINT_FILE = "vector_fingerprint.json";

function parseIntStrict(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : fallback;
}

/** Cosine similarity; 0 when either vector is zero-length or all-zero. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export class Embedder {
  private readonly base: string;
  private readonly key: string;
  private readonly model: string;
  private readonly isRemote: boolean;
  private readonly dims: number;

  constructor() {
    this.base = (env("EMBED_BASE_URL", "OPENAI_BASE_URL") ?? "").replace(/\/+$/, "");
    this.key = env("EMBED_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY") ?? "";
    this.model = env("EMBED_MODEL") ?? "";
    this.isRemote = Boolean(this.base && this.key && this.model);
    this.dims = parseIntStrict(env("EMBED_DIMENSIONS"), REMOTE_DIM_DEFAULT);
  }

  get remote(): boolean {
    return this.isRemote;
  }

  get dimensions(): number {
    return this.dims;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) {
      vectors.push(this.isRemote ? await this.remoteOne(text) : localEmbed(text));
    }
    return vectors;
  }

  private async remoteOne(text: string): Promise<number[]> {
    const response = await fetch(`${this.base}/embeddings/multimodal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        dimensions: this.dims,
        input: [{ type: "text", text }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`embedding API error ${response.status}: ${detail}`);
    }
    const body = (await response.json()) as { data?: unknown };
    const data = body.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return Array.from((data as { embedding: number[] }).embedding);
    }
    if (Array.isArray(data) && data.length > 0) {
      return Array.from((data[0] as { embedding: number[] }).embedding);
    }
    throw new Error(`unexpected embedding response: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

/** Character n-gram count hashing; bit-identical to `Embedder._local` in Python.
 *
 * Shared substrings ("红", "碎冰") yield meaningful cosine so the local
 * fallback can discriminate same-pattern/different-color entries offline.
 * Production should set EMBED_* to a real embeddings endpoint.
 */
export function localEmbed(text: string): number[] {
  const vec = new Array<number>(LOCAL_DIM).fill(0);
  const chars = [...text];
  const grams = [...chars];
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push((chars[i] as string) + (chars[i + 1] as string));
  }
  for (const gram of grams) {
    const digest = createHash("sha256").update(gram, "utf8").digest();
    // Python: int.from_bytes(digest[:3], "big") % LOCAL_DIM — the modulo keeps
    // only the last of the three bytes, but compute the full value for clarity.
    const index = ((digest[0] as number) << 16 | (digest[1] as number) << 8 | (digest[2] as number)) % LOCAL_DIM;
    vec[index] = (vec[index] as number) + 1;
  }
  let sumSquares = 0;
  for (const value of vec) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares) || 1;
  return vec.map((value) => value / norm);
}

export interface StoreRow {
  id: string;
  pattern: string;
  color: string;
  keywords: string[];
  text: string;
  vector: number[];
}

export interface NameRow {
  brand: string;
  series: string;
  pattern: string;
  color: string;
  name: string;
  name_en?: string | null;
}

export interface NamedRow {
  name: string;
  name_en: string | null;
}

export interface TypeHit {
  pattern: string;
  color: string;
}

/** Minimal store contract used by embed/match/evaluate/batch. */
export abstract class BaseStore {
  /** Idempotent rebuild; each row carries a `vector` number[]. */
  abstract reset(rows: readonly StoreRow[]): Promise<void>;
  abstract rows(): Promise<StoreRow[]>;
  /** Idempotent rebuild of the series-naming table. */
  abstract resetNames(names: readonly NameRow[]): Promise<void>;
  abstract namesFor(
    brand: string,
    series: string,
    pattern: string,
    color: string,
  ): Promise<NamedRow | null>;

  /** Highest-similarity refraction as `[cosineScore, hit]`, or null when empty.
   *
   * Default scans all rows in JS (local backend); PgStore overrides with a
   * server-side pgvector search.
   */
  async top1(qv: readonly number[]): Promise<[number, TypeHit] | null> {
    const hits = await this.topK(qv, 1);
    return hits[0] ?? null;
  }

  async topK(qv: readonly number[], k: number): Promise<Array<[number, TypeHit]>> {
    const rows = await this.rows();
    if (rows.length === 0) return [];
    return rows
      .map(
        (row) => [cosine(qv, row.vector), { pattern: row.pattern, color: row.color }] as [number, TypeHit],
      )
      .sort((a, b) => b[0] - a[0])
      .slice(0, k);
  }
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? [...(value as number[])] : Array.from(value as ArrayLike<number>);
}

function asStoreRow(record: Record<string, unknown>): StoreRow {
  return {
    id: record.id as string,
    pattern: record.pattern as string,
    color: record.color as string,
    keywords: (record.keywords ?? []) as string[],
    text: (record.text ?? "") as string,
    vector: asNumberArray(record.vector),
  };
}

/** Local LanceDB-backed store (offline fallback, VECTOR_STORE=lance). */
export class LanceStore extends BaseStore {
  private readonly db: lancedb.Connection;

  private constructor(db: lancedb.Connection) {
    super();
    this.db = db;
  }

  static async connect(dbPath: string): Promise<LanceStore> {
    return new LanceStore(await lancedb.connect(dbPath));
  }

  private async tableExists(name: string): Promise<boolean> {
    return (await this.db.tableNames()).includes(name);
  }

  private async writeTable(name: string, data: readonly Record<string, unknown>[]): Promise<void> {
    if (await this.tableExists(name)) {
      await this.db.dropTable(name);
    }
    // The dict validator guarantees non-empty input; an empty rebuild just
    // leaves no table behind (rows() then reports an empty store).
    if (data.length > 0) {
      await this.db.createTable(name, data as Record<string, unknown>[], { mode: "overwrite" });
    }
  }

  async reset(rows: readonly StoreRow[]): Promise<void> {
    await this.writeTable(
      TABLE,
      rows.map((row) => row as unknown as Record<string, unknown>),
    );
  }

  async rows(): Promise<StoreRow[]> {
    if (!(await this.tableExists(TABLE))) return [];
    try {
      const table = await this.db.openTable(TABLE);
      const records = (await table.query().toArray()) as Record<string, unknown>[];
      return records.map(asStoreRow);
    } catch {
      return [];
    }
  }

  async resetNames(names: readonly NameRow[]): Promise<void> {
    await this.writeTable(
      NAMES_TABLE,
      names.map((row) => row as unknown as Record<string, unknown>),
    );
  }

  async namesFor(
    brand: string,
    series: string,
    pattern: string,
    color: string,
  ): Promise<NamedRow | null> {
    if (!(await this.tableExists(NAMES_TABLE))) return null;
    try {
      const table = await this.db.openTable(NAMES_TABLE);
      const records = (await table.query().toArray()) as Array<Record<string, unknown>>;
      for (const record of records) {
        if (
          record.brand === brand &&
          record.series === series &&
          record.pattern === pattern &&
          record.color === color
        ) {
          return { name: record.name as string, name_en: (record.name_en ?? null) as string | null };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

function pgDdl(dim: number): string[] {
  return [
    "CREATE EXTENSION IF NOT EXISTS vector",
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id       TEXT PRIMARY KEY,
        pattern  TEXT NOT NULL,
        color    TEXT NOT NULL,
        keywords JSONB,
        text     TEXT,
        vector   VECTOR(${dim})
    )`,
    `CREATE TABLE IF NOT EXISTS ${NAMES_TABLE} (
        brand    TEXT NOT NULL,
        series   TEXT NOT NULL,
        pattern  TEXT NOT NULL,
        color    TEXT NOT NULL,
        name     TEXT NOT NULL,
        name_en  TEXT,
        PRIMARY KEY (brand, series, pattern, color)
    )`,
  ];
}

/** Supabase/Postgres + pgvector store (VECTOR_STORE=pgvector, default).
 *
 * Durable in the cloud: the vector column survives local disk loss. The table
 * schema and HNSW index are created idempotently on first `reset`. Rows are
 * GLOBAL refractor types (one per pattern+color, no brand/series); the
 * `refraction_names` table stores the brand/series-specific output names.
 */
export class PgStore extends BaseStore {
  private readonly dsn: string;
  private readonly dim: number;

  constructor(dsn?: string, dim?: number) {
    super();
    this.dsn = dsn ?? env("SUPABASE_DB_URL") ?? "";
    if (!this.dsn) {
      throw new Error("pgvector store needs SUPABASE_DB_URL (or pass dsn to createStore)");
    }
    this.dim = dim ?? parseIntStrict(env("EMBED_DIMENSIONS"), REMOTE_DIM_DEFAULT);
  }

  private async withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: this.dsn });
    await client.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }

  private async ensureSchema(client: pg.Client, createIndex = false): Promise<void> {
    for (const statement of pgDdl(this.dim)) {
      await client.query(statement);
    }
    if (createIndex) {
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_vector_hnsw ON ${TABLE} USING hnsw (vector vector_cosine_ops)`,
      );
    }
  }

  async reset(rows: readonly StoreRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.withClient(async (client) => {
      await this.ensureSchema(client);
      await client.query(`DELETE FROM ${TABLE}`);
      for (const row of rows) {
        await client.query(
          `INSERT INTO ${TABLE} (id, pattern, color, keywords, text, vector)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::vector)`,
          [
            row.id,
            row.pattern,
            row.color,
            JSON.stringify(row.keywords),
            row.text,
            JSON.stringify(row.vector),
          ],
        );
      }
    });
  }

  async rows(): Promise<StoreRow[]> {
    return this.withClient(async (client) => {
      await this.ensureSchema(client);
      const result = await client.query(
        `SELECT id, pattern, color, keywords, text, vector::text AS vector FROM ${TABLE}`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        pattern: row.pattern,
        color: row.color,
        keywords: typeof row.keywords === "string" ? (JSON.parse(row.keywords) as string[]) : row.keywords ?? [],
        text: row.text ?? "",
        vector: JSON.parse(row.vector) as number[],
      }));
    });
  }

  async resetNames(names: readonly NameRow[]): Promise<void> {
    await this.withClient(async (client) => {
      await this.ensureSchema(client);
      await client.query(`DELETE FROM ${NAMES_TABLE}`);
      for (const row of names) {
        await client.query(
          `INSERT INTO ${NAMES_TABLE} (brand, series, pattern, color, name, name_en)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.brand, row.series, row.pattern, row.color, row.name, row.name_en ?? null],
        );
      }
    });
  }

  async namesFor(
    brand: string,
    series: string,
    pattern: string,
    color: string,
  ): Promise<NamedRow | null> {
    return this.withClient(async (client) => {
      await this.ensureSchema(client);
      const result = await client.query(
        `SELECT name, name_en FROM ${NAMES_TABLE}
         WHERE brand = $1 AND series = $2 AND pattern = $3 AND color = $4`,
        [brand, series, pattern, color],
      );
      const row = result.rows[0];
      return row ? { name: row.name, name_en: row.name_en ?? null } : null;
    });
  }

  /** Server-side cosine search: pgvector `<=>` distance over the table. */
  override async topK(qv: readonly number[], k: number): Promise<Array<[number, TypeHit]>> {
    return this.withClient(async (client) => {
      await this.ensureSchema(client);
      const vector = JSON.stringify(qv);
      const result = await client.query(
        `SELECT pattern, color, 1 - (vector <=> $1::vector) AS sim
         FROM ${TABLE}
         ORDER BY vector <=> $2::vector
         LIMIT ${Math.max(1, Math.floor(k))}`,
        [vector, vector],
      );
      return result.rows.map(
        (row) => [Number(row.sim), { pattern: row.pattern, color: row.color }] as [number, TypeHit],
      );
    });
  }
}

/** Build the configured store: pgvector by default, lance as fallback.
 *
 * `VECTOR_STORE` selects explicitly (`pgvector` / `lance` / a DSN value);
 * otherwise pgvector wins when a Supabase URL is configured, else lance.
 */
export async function createStore(dbPath?: string, dsn?: string): Promise<BaseStore> {
  const defaultDb = join(AGENT_ROOT, "db", "refractors.lance");
  const vs = env("VECTOR_STORE")?.trim().toLowerCase();
  if (vs === "lance") return LanceStore.connect(dbPath ?? defaultDb);
  if (vs === "pgvector") return new PgStore(dsn ?? env("SUPABASE_DB_URL"));
  if (vs) return new PgStore(vs); // an explicit DSN value
  if (dsn || env("SUPABASE_DB_URL")) return new PgStore(dsn);
  return LanceStore.connect(dbPath ?? defaultDb);
}

// ── dict→store self-healing sync ────────────────────────────────────────────

async function collectYmlFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectYmlFiles(join(dir, entry.name), relative, out);
    } else if (entry.name.endsWith(".yml")) {
      out.push(relative);
    }
  }
}

/** SHA-1 over every dict *.yml (relative path + bytes) — detects any edit. */
export async function dictFingerprint(dictDir: string): Promise<string> {
  const paths: string[] = [];
  await collectYmlFiles(dictDir, "", paths);
  paths.sort();
  const hash = createHash("sha1");
  for (const relative of paths) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(await readFile(join(dictDir, relative)));
  }
  return hash.digest("hex");
}

export function fingerprintPath(): string {
  return join(AGENT_ROOT, "db", FINGERPRINT_FILE);
}

export async function writeFingerprint(dictDir: string, file?: string): Promise<void> {
  const target = file ?? fingerprintPath();
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, await dictFingerprint(dictDir), "utf8");
}

export type SyncState = "synced" | "rebuilt" | "rebuild-failed";

/** Rebuild the vector store when the dicts changed (idempotent).
 *
 * Returns `synced` (fingerprint matches), `rebuilt` (dicts were newer and the
 * injected rebuild ran), or `rebuild-failed` (offline/error; callers may keep
 * serving the stale store). The rebuild is injected (normally the embed module)
 * so this module stays free of import cycles.
 */
export async function ensureSynced(
  dictDir: string,
  rebuild: () => Promise<void>,
  file: string = fingerprintPath(),
): Promise<SyncState> {
  const current = await dictFingerprint(dictDir);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing === current) return "synced";
  } catch {
    // missing or unreadable fingerprint file → rebuild below
  }
  try {
    await rebuild();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, current, "utf8");
    return "rebuilt";
  } catch {
    return "rebuild-failed";
  }
}
