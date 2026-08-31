import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import parity from "./fixtures/parity.json";
import {
  cosine,
  createStore,
  dictFingerprint,
  Embedder,
  ensureSynced,
  LanceStore,
  localEmbed,
  LOCAL_DIM,
  PgStore,
  writeFingerprint,
} from "../src/store.ts";
import { AGENT_ROOT, env } from "../src/env.ts";
import { forceLocalEmbedderEnv } from "./helpers.ts";

afterEach(() => forceLocalEmbedderEnv());

describe("localEmbed parity with Python", () => {
  it("is bit-identical to Embedder._local for the fixture strings", () => {
    const vector = localEmbed("碎冰 红 红色水晶裂纹状折射，光线下反光");
    expect(vector).toHaveLength(LOCAL_DIM);
    expect(vector).toEqual(parity.localVectorBingHong);
  });

  it("is bit-identical for the second fixture string", () => {
    const vector = localEmbed("银折 银 银折 银白折 普折射 silver");
    expect(vector).toEqual(parity.localVectorYinZhe);
  });

  it("produces unit-length vectors", () => {
    const vector = localEmbed("碎冰红");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 12);
  });
});

describe("cosine", () => {
  it("returns 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when either vector is all-zero", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 1], [0, 0])).toBe(0);
  });
});

describe("Embedder env detection", () => {
  it("is remote only when base, key, and model are all configured", () => {
    expect(new Embedder().remote).toBe(false);
    process.env.EMBED_BASE_URL = "https://embed.example.test";
    expect(new Embedder().remote).toBe(false);
    process.env.EMBED_API_KEY = "k";
    process.env.EMBED_MODEL = "m";
    const remote = new Embedder();
    expect(remote.remote).toBe(true);
    expect(remote.dimensions).toBe(1024);
  });

  it("falls back to OPENAI_* / DEEPSEEK_API_KEY names", () => {
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_API_KEY;
    delete process.env.EMBED_MODEL;
    process.env.OPENAI_BASE_URL = "https://openai.example.test";
    process.env.OPENAI_API_KEY = "k";
    process.env.EMBED_MODEL = "m";
    expect(new Embedder().remote).toBe(true);
  });
});

describe("createStore selection", () => {
  it("selects lance when VECTOR_STORE=lance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-sel-"));
    process.env.VECTOR_STORE = "lance";
    const store = await createStore(join(dir, "db.lance"));
    expect(store).toBeInstanceOf(LanceStore);
  });

  it("selects pgvector for the explicit value and DSN values", () => {
    process.env.VECTOR_STORE = "pgvector";
    process.env.SUPABASE_DB_URL = "postgres://example";
    expect(createStore()).resolves.toBeInstanceOf(PgStore);

    process.env.VECTOR_STORE = "postgres://explicit-dsn";
    expect(createStore()).resolves.toBeInstanceOf(PgStore);
  });

  it("defaults to pgvector with SUPABASE_DB_URL and lance without", async () => {
    process.env.SUPABASE_DB_URL = "postgres://example";
    expect(createStore()).resolves.toBeInstanceOf(PgStore);

    delete process.env.SUPABASE_DB_URL;
    const dir = await mkdtemp(join(tmpdir(), "refr-sel-"));
    expect(await createStore(join(dir, "db.lance"))).toBeInstanceOf(LanceStore);
  });

  it("throws when pgvector is selected without a DSN", () => {
    process.env.VECTOR_STORE = "pgvector";
    delete process.env.SUPABASE_DB_URL;
    expect(createStore()).rejects.toThrow(/SUPABASE_DB_URL/);
  });
});

describe("LanceStore roundtrip", () => {
  it("writes and reads the dict-built tables", async () => {
    const { store } = await import("./helpers.ts").then((m) => m.makeDictStore());
    const rows = await store.rows();
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.vector.length === LOCAL_DIM)).toBe(true);

    const names = await store.namesFor("panini", "prizm", "碎冰", "红");
    expect(names).toEqual({ name: "碎冰红", name_en: "Red Ice" });
    expect(await store.namesFor("topps", "chrome", "碎冰", "红")).toBeNull();

    const qv = localEmbed("碎冰 红 红色水晶裂纹状折射，光线下反光");
    const hit = await store.top1(qv);
    expect(hit).not.toBeNull();
    expect(hit?.[1]).toEqual({ pattern: "碎冰", color: "红" });
    expect(hit?.[0]).toBeGreaterThanOrEqual(0.5);

    const top2 = await store.topK(qv, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0]?.[0]).toBeGreaterThanOrEqual(top2[1]?.[0] ?? 0);
  });

  it("returns an empty store before any reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-empty-"));
    const store = await LanceStore.connect(dir);
    expect(await store.rows()).toEqual([]);
    expect(await store.top1([1, 2, 3])).toBeNull();
  });

  it("rebuild drops and replaces existing tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-rebuild-"));
    const store = await LanceStore.connect(dir);
    await store.reset([{ id: "a-b", pattern: "a", color: "b", keywords: ["k"], text: "a b", vector: [1, 0] }]);
    await store.reset([{ id: "c-d", pattern: "c", color: "d", keywords: ["k"], text: "c d", vector: [0, 1] }]);
    const rows = await store.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("c-d");
  });
});

describe("dict fingerprint parity and sync", () => {
  it("matches the Python dict_fingerprint of the real dictionary", async () => {
    const fingerprint = await dictFingerprint(join(AGENT_ROOT, "dicts"));
    expect(fingerprint).toBe(parity.dictFingerprint);
  });

  it("ensureSynced rebuilds on change and reports synced when stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-sync-"));
    const dictDir = join(dir, "dicts");
    await mkdir(dictDir, { recursive: true });
    await writeFile(join(dictDir, "refractions.yml"), "refractions: []\n", "utf8");
    const fingerprintFile = join(dir, "fp.json");

    let rebuilds = 0;
    const rebuild = async (): Promise<void> => {
      rebuilds += 1;
    };

    expect(await ensureSynced(dictDir, rebuild, fingerprintFile)).toBe("rebuilt");
    expect(rebuilds).toBe(1);
    expect(await ensureSynced(dictDir, rebuild, fingerprintFile)).toBe("synced");
    expect(rebuilds).toBe(1);

    await writeFile(join(dictDir, "refractions.yml"), "refractions: []\n# changed\n", "utf8");
    expect(await ensureSynced(dictDir, rebuild, fingerprintFile)).toBe("rebuilt");
    expect(rebuilds).toBe(2);
  });

  it("reports rebuild-failed without corrupting the fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-sync-"));
    const dictDir = join(dir, "dicts");
    await mkdir(dictDir, { recursive: true });
    await writeFile(join(dictDir, "refractions.yml"), "refractions: []\n", "utf8");
    const fingerprintFile = join(dir, "fp.json");
    const failing = async (): Promise<void> => {
      throw new Error("offline");
    };
    expect(await ensureSynced(dictDir, failing, fingerprintFile)).toBe("rebuild-failed");
    expect(await ensureSynced(dictDir, failing, fingerprintFile)).toBe("rebuild-failed");
  });

  it("writeFingerprint persists a readable fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-fp-"));
    const dictDir = join(dir, "dicts");
    await mkdir(dictDir, { recursive: true });
    await writeFile(join(dictDir, "refractions.yml"), "refractions: []\n", "utf8");
    await writeFingerprint(dictDir, join(dir, "fp.json"));
    expect(await dictFingerprint(dictDir)).toBeTruthy();
    expect(env("VECTOR_STORE")).toBeUndefined();
  });
});
