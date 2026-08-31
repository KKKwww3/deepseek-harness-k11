/** Shared test helper: build a real dict-backed Lance store with the local
 * embedder (no network, no credentials) for parity and behavior tests.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildNameRows, buildRows, loadDictionary } from "../src/dict.ts";
import { AGENT_ROOT } from "../src/env.ts";
import { Embedder, LanceStore } from "../src/store.ts";

/** Remove credential/store env vars so tests use the local embedder + lance. */
export function forceLocalEmbedderEnv(): void {
  for (const key of [
    "EMBED_BASE_URL",
    "EMBED_API_KEY",
    "EMBED_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "SUPABASE_DB_URL",
    "VECTOR_STORE",
  ]) {
    delete process.env[key];
  }
}

export async function makeDictStore(): Promise<{
  store: LanceStore;
  embedder: Embedder;
  dir: string;
}> {
  forceLocalEmbedderEnv();
  const embedder = new Embedder();
  if (embedder.remote) {
    throw new Error("test env must not configure EMBED_* (local embedder required)");
  }
  const doc = await loadDictionary(join(AGENT_ROOT, "dicts", "refractions.yml"));
  const rows = buildRows(doc);
  const vectors = await embedder.embed(rows.map((row) => row.text));
  for (const [index, vector] of vectors.entries()) {
    rows[index].vector = vector;
  }
  const names = buildNameRows(doc);
  const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
  const store = await LanceStore.connect(dir);
  await store.reset(rows);
  await store.resetNames(names);
  return { store, embedder, dir };
}
