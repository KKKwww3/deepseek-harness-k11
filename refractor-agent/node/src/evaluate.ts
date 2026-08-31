/** Evaluate the refractor matching logic against the golden dataset.
 *
 * TypeScript port of `scripts/evaluate.py` (match mode; live mode needs the
 * VLM adapter, which is not ported yet). Prints a metrics table and writes
 * metrics.json / errors.jsonl / confusion.json under the output dir. The
 * Python version is the behavioral contract — the golden double-run compares
 * metrics, detail rows, and confusion output for exact equality.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { AGENT_ROOT, loadEnv } from "./env.ts";
import { bestType, queryText, seriesName } from "./match.ts";
import {
  BaseStore,
  Embedder,
  LOCAL_THRESHOLD,
  REMOTE_THRESHOLD,
  createStore,
  ensureSynced,
  type TypeHit,
} from "./store.ts";
import { rebuildStore } from "./embed.ts";

export interface GoldenCase {
  id: string;
  front?: string;
  back?: string;
  expected?: Record<string, unknown>;
  rec?: Record<string, unknown>;
}

export interface PreparedItem {
  case: GoldenCase;
  rec?: Record<string, unknown>;
  qv?: number[];
  hit?: [number, TypeHit] | null;
  error?: string;
}

export interface MatchOutput {
  matched?: boolean;
  refraction?: string | null;
  name_en?: string | null;
  pattern?: string;
  color?: string;
  matchScore?: number;
  needsReview?: boolean;
  error?: string;
}

export interface DetailRow {
  id: string;
  error?: string;
  stage?: string;
  expected?: Record<string, unknown>;
  rec?: Record<string, unknown>;
  predicted?: MatchOutput;
  correct?: Record<string, boolean>;
}

export type Confusion = Record<string, Record<string, number>>;

export interface Metrics {
  total: number;
  det_acc: number | null;
  term_acc: number | null;
  pattern_acc: number | null;
  color_acc: number | null;
  series_acc: number | null;
  review_rate: number | null;
  precision: number | null;
  recall: number | null;
  non_plain: number;
  predicted_terms: number;
}

/** Python `round(value, digits)` — half-even on the decimal representation. */
export function roundHalfEven(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / factor;
}

export async function loadCases(goldenPath: string): Promise<GoldenCase[]> {
  const doc = parse(await readFile(goldenPath, "utf8")) as { cases?: GoldenCase[] };
  return doc.cases ?? [];
}

/** Recognize (live) and embed the query once per case; reused per threshold. */
export async function prepareMatch(
  cases: readonly GoldenCase[],
  embedder: Embedder,
): Promise<PreparedItem[]> {
  const prepared: PreparedItem[] = [];
  for (const caseItem of cases) {
    const item: PreparedItem = { case: caseItem };
    try {
      const rec = caseItem.rec;
      if (!rec) {
        item.error = "case has no rec (match mode)";
      } else {
        item.rec = rec;
        if (rec.pattern !== "平卡") {
          item.qv = (await embedder.embed([queryText(rec)]))[0];
        }
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      delete item.rec;
    }
    prepared.push(item);
  }
  return prepared;
}

/** Match a prepared case: top1 hit + series naming (same logic as match). */
export async function runMatchPrepared(
  item: PreparedItem,
  store: BaseStore,
  threshold: number,
): Promise<MatchOutput> {
  const rec = item.rec;
  if (rec === undefined) return { error: item.error ?? "no rec" };
  if (rec.pattern === "平卡") {
    return { matched: false, refraction: null, needsReview: false };
  }

  const typ = bestType(item.hit ?? null, threshold);
  if (typ === null) {
    return { matched: false, needsReview: true };
  }

  const naming = await seriesName(rec, typ.pattern, typ.color, store);
  if (naming === null) {
    return { ...typ, refraction: null, needsReview: true };
  }
  return { ...typ, ...naming, needsReview: false };
}

/** Run matching over prepared cases at one threshold and aggregate metrics. */
export async function aggregate(
  prepared: readonly PreparedItem[],
  store: BaseStore,
  threshold: number,
): Promise<{ metrics: Metrics; details: DetailRow[]; confusion: Confusion }> {
  const details: DetailRow[] = [];
  const confusion: Confusion = {};
  let detCount = 0;
  let termCount = 0;
  let patternCount = 0;
  let colorCount = 0;
  let seriesCount = 0;
  let nonPlain = 0;
  let predictedTerms = 0;
  let reviewCount = 0;
  let total = 0;

  for (const item of prepared) {
    total += 1;
    const expected = item.case.expected ?? {};
    const pred = await runMatchPrepared(item, store, threshold);
    if (pred.error !== undefined) {
      details.push({ id: item.case.id, error: pred.error, stage: "recognize" });
      continue;
    }
    const expRefr = typeof expected.refraction === "string" ? expected.refraction : null;
    const predRefr = typeof pred.refraction === "string" ? pred.refraction : null;

    const detOk = (expRefr === null) === (predRefr === null);
    detCount += detOk ? 1 : 0;

    const expKey = expRefr ?? "(plain)";
    const predKey = predRefr ?? "(none)";
    const row = (confusion[expKey] ??= {});
    row[predKey] = (row[predKey] ?? 0) + 1;

    const fields: Record<string, boolean> = {};
    if (predRefr !== null) predictedTerms += 1;
    const rec = item.rec ?? {};
    if (expRefr !== null) {
      nonPlain += 1;
      const termOk = predRefr === expRefr;
      termCount += termOk ? 1 : 0;
      fields.term = termOk;
      if (expected.pattern != null) {
        const patternOk = pred.pattern === expected.pattern;
        patternCount += patternOk ? 1 : 0;
        fields.pattern = patternOk;
      }
      if (expected.color != null) {
        const colorOk = pred.color === expected.color;
        colorCount += colorOk ? 1 : 0;
        fields.color = colorOk;
      }
      // series accuracy: does the RECOGNITION self-determine the right
      // brand x series? (that decides which naming table to look up)
      if (expected.brand != null && expected.series != null) {
        const seriesOk =
          rec.brand === expected.brand && rec.series === expected.series;
        seriesCount += seriesOk ? 1 : 0;
        fields.series = seriesOk;
      }
    }
    if (pred.needsReview === true) reviewCount += 1;
    fields.review = pred.needsReview === true;

    details.push({
      id: item.case.id,
      expected,
      rec,
      predicted: pred,
      correct: fields,
    });
  }

  const pct = (count: number, denominator: number): number | null =>
    denominator > 0 ? roundHalfEven(count / denominator, 4) : null;

  const metrics: Metrics = {
    total,
    det_acc: pct(detCount, total),
    term_acc: pct(termCount, nonPlain),
    pattern_acc: pct(patternCount, nonPlain),
    color_acc: pct(colorCount, nonPlain),
    series_acc: pct(seriesCount, nonPlain),
    review_rate: pct(reviewCount, total),
    precision: pct(termCount, predictedTerms),
    recall: pct(termCount, nonPlain),
    non_plain: nonPlain,
    predicted_terms: predictedTerms,
  };
  return { metrics, details, confusion };
}

export interface RunMatchOptions {
  golden?: string;
  db?: string;
  threshold?: number;
  out?: string;
  dictDir?: string;
}

export interface MatchRunResult {
  metrics: Metrics;
  details: DetailRow[];
  confusion: Confusion;
}

/** Full match-mode evaluation flow (evaluate.py main, match branch). */
export async function runMatchEvaluation(options: RunMatchOptions = {}): Promise<MatchRunResult> {
  loadEnv();
  const dictDir = options.dictDir ?? join(AGENT_ROOT, "dicts");
  const dbPath = options.db ?? join(AGENT_ROOT, "db", "refractors.lance");
  const goldenPath = options.golden ?? join(AGENT_ROOT, "eval", "golden.yaml");

  // Unlike the Python version, the self-healing rebuild is bound to the same
  // store path being evaluated (the Python rebuild always targets the default
  // store, even when --db points elsewhere).
  const sync = await ensureSynced(dictDir, () => rebuildStore(dictDir, dbPath));
  if (sync !== "synced") {
    console.error(`[sync] vector store ${sync}`);
  }

  const embedder = new Embedder();
  const store = await createStore(dbPath);
  const cases = await loadCases(goldenPath);
  if (cases.length === 0) {
    throw new Error(`no cases in ${goldenPath}`);
  }

  const prepared = await prepareMatch(cases, embedder);
  for (const item of prepared) {
    if (item.qv !== undefined) {
      item.hit = await store.top1(item.qv);
    }
  }

  const threshold =
    options.threshold ?? (embedder.remote ? REMOTE_THRESHOLD : LOCAL_THRESHOLD);
  const { metrics, details, confusion } = await aggregate(prepared, store, threshold);

  const outDir = options.out ?? join(AGENT_ROOT, "eval", "out");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "metrics.json"),
    JSON.stringify(metrics, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(outDir, "errors.jsonl"),
    details.map((detail) => JSON.stringify(detail)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(outDir, "confusion.json"),
    JSON.stringify(confusion, null, 2) + "\n",
    "utf8",
  );
  return { metrics, details, confusion };
}

function printMetrics(metrics: Metrics): void {
  const fmt = (value: number | null): string =>
    value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  console.log("=".repeat(46));
  console.log(`  total cases      : ${metrics.total}`);
  for (const key of ["det_acc", "term_acc", "pattern_acc", "color_acc", "series_acc"] as const) {
    console.log(`  ${key.padEnd(18)}: ${fmt(metrics[key])}`);
  }
  console.log(`  review_rate      : ${fmt(metrics.review_rate)}`);
  console.log(`  precision        : ${fmt(metrics.precision)}`);
  console.log(`  recall           : ${fmt(metrics.recall)}`);
  console.log("=".repeat(46));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let mode = "match";
  let golden: string | undefined;
  let db: string | undefined;
  let threshold: number | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") mode = argv[++i] as string;
    else if (argv[i] === "--golden") golden = argv[++i] as string;
    else if (argv[i] === "--db") db = argv[++i] as string;
    else if (argv[i] === "--threshold") threshold = Number(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i] as string;
    else if (argv[i] === "--images-root" || argv[i] === "--sweep") {
      // accepted for CLI parity; match mode ignores them (sweep support pending)
    }
  }
  if (mode !== "match") {
    console.error("live mode is not ported yet (requires the VLM adapter)");
    return 2;
  }

  const { metrics } = await runMatchEvaluation({ golden, db, threshold, out });
  printMetrics(metrics);
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
