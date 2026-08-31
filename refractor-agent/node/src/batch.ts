/** Batch refractor normalization over the SQLite job store.
 *
 * TypeScript port of `scripts/run_batch.py` with production-grade state: the
 * manifest JSONL is replaced by the transactional job store (lease, attempt,
 * idempotency), match runs in-process instead of a subprocess, and
 * result.jsonl / review.jsonl are demoted to export files written only when a
 * state transition actually happened.
 *
 * Failure classification (contract from the Python version):
 * business_validation_failed → review_required (never retried); retryable VLM
 * errors → retryable_failed while attempts remain; everything else, and the
 * attempt limit, → terminal_failed.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { env, loadEnv } from "./env.ts";
import { matchRecognition } from "./match.ts";
import { Embedder, createStore } from "./store.ts";
import { IMAGE_EXTS, VLMResponseError, recognize } from "./vlm.ts";
import { JobStore, PIPELINE_VERSION_DEFAULT, type ClaimedItem } from "./jobStore.ts";

const REVIEW_ERROR_CODES = new Set(["business_validation_failed"]);
const ATTEMPT_LIMIT_DEFAULT = 3;
const ATTEMPT_LIMIT_MAX = 10;
const LEASE_MS_DEFAULT = 5 * 60 * 1000;
const RETRY_COOLDOWN_MS_DEFAULT = 5 * 1000;

export interface FailureClassification {
  status: "review_required" | "retryable_failed" | "terminal_failed";
  retryable: boolean;
}

export function classifyFailure(error: unknown, attempt: number, limit: number): FailureClassification {
  const code = error instanceof VLMResponseError ? error.code : undefined;
  if (code !== undefined && REVIEW_ERROR_CODES.has(code)) {
    return { status: "review_required", retryable: false };
  }
  const retryable = error instanceof VLMResponseError && error.retryable;
  if (retryable && attempt < limit) {
    return { status: "retryable_failed", retryable: true };
  }
  return { status: "terminal_failed", retryable: false };
}

export function errorCodeOf(error: unknown): string {
  return error instanceof VLMResponseError ? error.code : "batch_error";
}

export function lastErrorOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export function failureRecord(
  itemId: string,
  attempt: number,
  status: string,
  retryable: boolean,
  error: unknown,
): Record<string, unknown> {
  return {
    itemId,
    status,
    attempt,
    errorCode: errorCodeOf(error),
    retryable,
    lastError: lastErrorOf(error),
  };
}

/** Whole-item attempt limit: BATCH_MAX_ATTEMPTS, bounded 1..10, fails loud. */
export function attemptLimit(): number {
  const raw = env("BATCH_MAX_ATTEMPTS");
  if (raw === undefined) return ATTEMPT_LIMIT_DEFAULT;
  if (!/^[+-]?\d+$/.test(raw.trim())) throw new Error("BATCH_MAX_ATTEMPTS must be an integer");
  const parsed = Number.parseInt(raw.trim(), 10);
  if (parsed < 1 || parsed > ATTEMPT_LIMIT_MAX) {
    throw new Error(`BATCH_MAX_ATTEMPTS must be between 1 and ${ATTEMPT_LIMIT_MAX}`);
  }
  return parsed;
}

export interface ProcessTask {
  id: string;
  path: string;
  images: string[];
}

export interface ProcessOutcome {
  result: Record<string, unknown>;
  needsReview: boolean;
}

export type BatchProcess = (task: ProcessTask) => Promise<ProcessOutcome>;

/** Real pipeline binding: VLM recognition → in-process vector match. */
export async function createRefractorProcess(
  options: { threshold?: number } = {},
): Promise<BatchProcess> {
  loadEnv();
  const embedder = new Embedder();
  const store = await createStore();
  const threshold = options.threshold;
  return async (task: ProcessTask): Promise<ProcessOutcome> => {
    const rec = await recognize(task.images);
    const match = await matchRecognition(rec, embedder, store, { threshold });
    const result: Record<string, unknown> = { itemId: task.id };
    for (const key of ["brand", "series", "pattern", "color", "desc"] as const) {
      result[key] = rec[key];
    }
    Object.assign(result, match);
    return { result, needsReview: match.needsReview === true };
  };
}

/** Content identity of a task: SHA-256 over sorted image paths + bytes. */
export async function hashImages(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function listImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()))
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function discoverAndRegister(input: string, store: JobStore): Promise<number> {
  const entries = await readdir(input, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const items: Array<{ id: string; path: string; inputHash: string }> = [];
  for (const name of dirs) {
    const path = join(input, name);
    const images = await listImages(path);
    if (images.length === 0) continue;
    items.push({ id: name, path, inputHash: await hashImages(images) });
  }
  return store.register(items);
}

async function appendJsonl(path: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export interface BatchOptions {
  input: string;
  work: string;
  dbPath?: string;
  threshold?: number;
  attempts?: number;
  leaseMs?: number;
  /** Cooldown before a retryable_failed item is claimable again. */
  retryCooldownMs?: number;
  workerId?: string;
  process?: BatchProcess;
  dryRun?: boolean;
  pipelineVersion?: string;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

export interface BatchSummary {
  registered: number;
  ok: number;
  review: number;
  fail: number;
  skippedDuplicates: number;
  stats: Record<string, number>;
}

export async function runBatch(options: BatchOptions): Promise<BatchSummary> {
  loadEnv();
  await mkdir(options.work, { recursive: true });
  const dbPath = options.dbPath ?? join(options.work, "refractor.sqlite3");
  const pipelineVersion = options.pipelineVersion ?? env("REFACTOR_PIPELINE_VERSION") ?? PIPELINE_VERSION_DEFAULT;
  const store = new JobStore(dbPath, { pipelineVersion, now: options.now });
  const resultPath = join(options.work, "result.jsonl");
  const reviewPath = join(options.work, "review.jsonl");

  const registered = await discoverAndRegister(options.input, store);
  if (options.dryRun) {
    const stats = store.stats();
    store.close();
    return { registered, ok: 0, review: 0, fail: 0, skippedDuplicates: 0, stats };
  }

  const limit = options.attempts ?? attemptLimit();
  const leaseMs = options.leaseMs ?? Number(env("BATCH_LEASE_MS") ?? LEASE_MS_DEFAULT);
  const retryCooldownMs =
    options.retryCooldownMs ?? Number(env("BATCH_RETRY_COOLDOWN_MS") ?? RETRY_COOLDOWN_MS_DEFAULT);
  const workerId = options.workerId ?? `worker-${globalThis.process?.pid ?? 0}-${Date.now() % 100000}`;
  const processItem = options.process ?? (await createRefractorProcess({ threshold: options.threshold }));

  store.addEvent("batch-start", null, { input: options.input, workerId, pipelineVersion });
  let ok = 0;
  let review = 0;
  let fail = 0;
  let skippedDuplicates = 0;

  for (;;) {
    const item = store.claim(workerId, leaseMs);
    if (item === null) break;
    try {
      const images = await listImages(item.path);
      const { result, needsReview } = await processItem({ id: item.id, path: item.path, images });
      const { inserted } = store.complete(item, result, needsReview);
      if (inserted) {
        await appendJsonl(resultPath, result);
        if (needsReview) {
          await appendJsonl(reviewPath, result);
          review += 1;
        }
        ok += 1;
      } else {
        skippedDuplicates += 1;
      }
    } catch (error) {
      const { status, retryable } = classifyFailure(error, item.attempt, limit);
      store.fail(item, status, errorCodeOf(error), lastErrorOf(error), retryCooldownMs);
      await appendJsonl(reviewPath, failureRecord(item.id, item.attempt, status, retryable, error));
      if (status === "review_required") review += 1;
      else fail += 1;
    }
  }

  const stats = store.stats();
  store.addEvent("batch-done", null, { ok, review, fail, skippedDuplicates });
  store.close();
  return { registered, ok, review, fail, skippedDuplicates, stats };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let input: string | undefined;
  let work: string | undefined;
  let dbPath: string | undefined;
  let threshold: number | undefined;
  let attempts: number | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") input = argv[++i];
    else if (argv[i] === "--work") work = argv[++i];
    else if (argv[i] === "--db") dbPath = argv[++i];
    else if (argv[i] === "--threshold") threshold = Number(argv[++i]);
    else if (argv[i] === "--attempts") attempts = Number(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!input || !work) {
    console.log("usage: node src/batch.ts --input <customer dir> --work <work dir> [--db path] [--threshold x] [--attempts n] [--dry-run]");
    return 2;
  }
  const summary = await runBatch({ input, work, dbPath, threshold, attempts, dryRun });
  if (summary.registered === 0) {
    console.error("nothing to process");
    return 0;
  }
  console.log(JSON.stringify(summary));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
