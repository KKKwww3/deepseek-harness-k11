/** Match a refractor recognition to the standard industry name.
 *
 * TypeScript port of `scripts/match.py`. Query text = `pattern + color + desc`.
 * The vector table holds one vector per registered refraction (`refractor_types`),
 * so matching is a single cosine search. After the best match clears the
 * threshold, the series naming table (`refraction_names`) maps the brand x
 * series to the customer-facing term (same refractor, different series =
 * different name, e.g. 银折 vs 普折射).
 */

import { LOCAL_THRESHOLD, REMOTE_THRESHOLD, type BaseStore, type Embedder, type TypeHit } from "./store.ts";

/** Lowercase, strip, and collapse inner whitespace. */
export function norm(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** `pattern + color + desc`, the embedding query text. */
export function queryText(rec: Record<string, unknown>): string {
  const parts = [rec.pattern, rec.color, rec.desc].map(
    (value) => (typeof value === "string" ? value : ""),
  );
  return parts.filter((part) => part).join(" ");
}

/** Round to 4 decimals, mirroring Python `round(score, 4)` for display. */
function round4(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/** Turn a store hit into the match result dict (or null below threshold). */
export function bestType(
  hit: readonly [number, TypeHit] | null,
  threshold: number,
): { matched: true; pattern: string; color: string; matchScore: number } | null {
  if (hit === null) return null;
  const [score, row] = hit;
  if (score < threshold) return null;
  return { matched: true, pattern: row.pattern, color: row.color, matchScore: round4(score) };
}

/** Look up the customer-facing name for this brand x series in the DB.
 *
 * brand/series come from the VLM as stable text (panini/prizm); they are
 * lowercased + whitespace-collapsed defensively before querying.
 */
export async function seriesName(
  rec: Record<string, unknown>,
  pattern: string,
  color: string,
  store: BaseStore,
): Promise<{ refraction: string; name_en: string | null } | null> {
  const rawBrand = typeof rec.brand === "string" ? rec.brand : "";
  const rawSeries = typeof rec.series === "string" ? rec.series : "";
  const brand = norm(rawBrand);
  const series = norm(rawSeries);
  if (!brand || !series) return null;
  const naming = await store.namesFor(brand, series, pattern, color);
  if (naming === null) return null;
  return { refraction: naming.name, name_en: naming.name_en };
}

export interface MatchResult {
  matched: boolean;
  refraction: string | null;
  name_en?: string | null;
  pattern?: string;
  color?: string;
  matchScore?: number;
  needsReview: boolean;
}

export interface MatchOptions {
  threshold?: number;
}

/** Full matching flow for one structured recognition (match.py main logic). */
export async function matchRecognition(
  rec: Record<string, unknown>,
  embedder: Embedder,
  store: BaseStore,
  { threshold }: MatchOptions = {},
): Promise<MatchResult> {
  // a plain card is not a refraction and not a failure
  if (rec.pattern === "平卡") {
    return { matched: false, refraction: null, needsReview: false };
  }

  const effectiveThreshold =
    threshold ?? (embedder.remote ? REMOTE_THRESHOLD : LOCAL_THRESHOLD);

  const query = queryText(rec);
  const qv = (await embedder.embed([query]))[0] as number[];
  const hit = await store.top1(qv);
  if (hit === null) {
    throw new Error("empty store; run the embed step first");
  }

  const typ = bestType(hit, effectiveThreshold);
  if (typ === null) {
    return { matched: false, refraction: null, needsReview: true };
  }

  const naming = await seriesName(rec, typ.pattern, typ.color, store);
  if (naming === null) {
    // type matched, but we cannot name it for this series (unknown brand/series
    // or the series does not sell this refractor) → needs review
    return { ...typ, refraction: null, needsReview: true };
  }

  return { ...typ, ...naming, needsReview: false };
}
