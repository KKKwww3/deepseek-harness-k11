/** Build the refractor vector library from the single editable dict.
 *
 * TypeScript port of `scripts/embed.py` (CLI included). Reads
 * `dicts/refractions.yml` (one entry per database row), validates it, and
 * idempotently rebuilds the vector store (Supabase pgvector by default, lance
 * fallback). Each entry's `pattern` / `color` / `keywords` are
 * employee-edited; `id` / `text` / `vector` are generated here.
 */

import { join } from "node:path";

import { AGENT_ROOT, loadEnv } from "./env.ts";
import {
  DICT_FILE,
  buildNameRows,
  buildRows,
  loadDictionary,
  validateDictionary,
} from "./dict.ts";
import { BaseStore, Embedder, createStore, writeFingerprint } from "./store.ts";

export interface EmbedResult {
  rows: number;
  names: number;
}

/** Validate the dict, embed every row, and idempotently rebuild both tables. */
export async function embedDictIntoStore(
  dictDir: string,
  store: BaseStore,
  embedder: Embedder,
): Promise<EmbedResult> {
  const path = join(dictDir, DICT_FILE);
  const doc = await loadDictionary(path);
  const errors = validateDictionary(doc, path);
  if (errors.length > 0) {
    throw new Error(`dictionary validation failed:\n${errors.join("\n")}`);
  }

  const rows = buildRows(doc);
  const vectors = await embedder.embed(rows.map((row) => row.text));
  for (const [index, vector] of vectors.entries()) {
    rows[index].vector = vector;
  }
  const names = buildNameRows(doc);

  await store.reset(rows);
  await store.resetNames(names);
  return { rows: rows.length, names: names.length };
}

/** Fresh-store rebuild used by the dict→store self-healing sync. */
export async function rebuildStore(dictDir: string, dbPath?: string): Promise<void> {
  const store = await createStore(dbPath);
  await embedDictIntoStore(dictDir, store, new Embedder());
}

async function main(): Promise<number> {
  loadEnv();
  let dictDir = join(AGENT_ROOT, "dicts");
  let dbPath: string | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dict-dir") dictDir = argv[++i] as string;
    else if (argv[i] === "--db") dbPath = argv[++i] as string;
  }

  const embedder = new Embedder();
  console.log(`embedder: ${embedder.remote ? "remote" : "local-fallback (set EMBED_*)"}`);
  const store = await createStore(dbPath);
  const result = await embedDictIntoStore(dictDir, store, embedder);
  await writeFingerprint(dictDir);
  console.log(
    `wrote ${result.rows} refraction entries + ${result.names} series names -> ${store.constructor.name}`,
  );
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
