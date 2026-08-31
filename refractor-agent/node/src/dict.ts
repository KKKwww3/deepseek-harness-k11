/** Dictionary loading, validation, and row building.
 *
 * TypeScript port of `scripts/embed.py` (minus the CLI). One dict entry maps
 * to one database row; the (pattern, color) pairs are the controlled values
 * for VLM validation. `yml` files are the employee-maintained source of truth.
 */

import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import type { NameRow, StoreRow } from "./store.ts";

export const DICT_FILE = "refractions.yml";

export interface DictEntry {
  pattern: string;
  color: string;
  keywords: string[];
  names?: Record<string, { name: string; name_en: string }>;
}

export interface RefractionDoc {
  refractions?: DictEntry[];
}

export async function loadDictionary(path: string): Promise<RefractionDoc> {
  const doc = parse(await readFile(path, "utf8")) as unknown;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${path} is not a YAML mapping`);
  }
  return doc as RefractionDoc;
}

/** Check enum derivability, (pattern,color) uniqueness, keywords, names keys. */
export function validateDictionary(doc: RefractionDoc, path: string): string[] {
  const errors: string[] = [];
  const entries = doc.refractions ?? [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const { pattern, color } = entry;
    const key = `${pattern}\u0000${color}`;
    if (seen.has(key)) {
      errors.push(`[${path}] duplicate (pattern,color)=(${pattern},${color}) at #${index}`);
    }
    seen.add(key);
    if (!pattern || !color) {
      errors.push(`[${path}] #${index} needs pattern and color`);
    }
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
      errors.push(`[${path}] #${index} (${pattern},${color}) needs non-empty keywords`);
    }
    for (const [seriesKey, naming] of Object.entries(entry.names ?? {})) {
      if (!naming?.name || !naming?.name_en) {
        errors.push(`[${path}] #${index} series '${seriesKey}' needs name+name_en`);
      }
    }
  }
  if (seen.size === 0) {
    errors.push(`[${path}] no refractions defined`);
  }
  return errors;
}

/** Controlled pattern/color values (plus sentinels) and registered pairs. */
export function controlledValues(doc: RefractionDoc): {
  patterns: Set<string>;
  colors: Set<string>;
  pairs: Set<string>;
} {
  const patterns = new Set<string>();
  const colors = new Set<string>();
  const pairs = new Set<string>();
  for (const entry of doc.refractions ?? []) {
    if (typeof entry.pattern === "string") patterns.add(entry.pattern);
    if (typeof entry.color === "string") colors.add(entry.color);
    if (typeof entry.pattern === "string" && typeof entry.color === "string") {
      pairs.add(`${entry.pattern}\u0000${entry.color}`);
    }
  }
  return { patterns, colors, pairs };
}

/** First-seen-ordered pattern/color lists for prompt construction.
 *
 * Port of `vlm.controlled_enum`: the legal sets are every registered value
 * plus the sentinels, so adding a refraction to the dict automatically extends
 * the VLM prompt — no separate enum file to maintain.
 */
export function controlledEnumLists(doc: RefractionDoc): {
  patterns: string[];
  colors: string[];
} {
  const patterns: string[] = [];
  const colors: string[] = [];
  for (const entry of doc.refractions ?? []) {
    if (typeof entry.pattern === "string" && !patterns.includes(entry.pattern)) {
      patterns.push(entry.pattern);
    }
    if (typeof entry.color === "string" && !colors.includes(entry.color)) {
      colors.push(entry.color);
    }
  }
  for (const value of ["平卡", "其他"]) {
    if (!patterns.includes(value)) patterns.push(value);
  }
  for (const value of ["无", "其他"]) {
    if (!colors.includes(value)) colors.push(value);
  }
  return { patterns, colors };
}

/** Build the vector-table rows; `vector` is filled in by the caller's embedder. */
export function buildRows(doc: RefractionDoc): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const entry of doc.refractions ?? []) {
    const { pattern, color } = entry;
    const text = [pattern, color, ...entry.keywords].join(" ");
    rows.push({
      id: `${pattern}-${color}`,
      pattern,
      color,
      keywords: entry.keywords,
      text,
      vector: [],
    });
  }
  return rows;
}

/** Build the series-naming rows; series keys are `brand-series` (first dash). */
export function buildNameRows(doc: RefractionDoc): NameRow[] {
  const names: NameRow[] = [];
  for (const entry of doc.refractions ?? []) {
    for (const [seriesKey, naming] of Object.entries(entry.names ?? {})) {
      const dash = seriesKey.indexOf("-");
      const brand = dash === -1 ? seriesKey : seriesKey.slice(0, dash);
      const series = dash === -1 ? "" : seriesKey.slice(dash + 1);
      names.push({
        brand,
        series,
        pattern: entry.pattern,
        color: entry.color,
        name: naming.name,
        name_en: naming.name_en,
      });
    }
  }
  return names;
}
