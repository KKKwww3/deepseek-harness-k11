import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  refractorTools,
  setToolRuntime,
  validateArgs,
  type ToolSpec,
} from "../src/tools.ts";
import { forceLocalEmbedderEnv, makeDictStore } from "./helpers.ts";

afterEach(() => {
  setToolRuntime(null);
  forceLocalEmbedderEnv();
  delete process.env.VLM_BASE_URL;
  delete process.env.VLM_API_KEY;
});

function tool(name: string): ToolSpec {
  const spec = refractorTools.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`missing tool: ${name}`);
  return spec;
}

describe("validateArgs", () => {
  const parameters = {
    a: { type: "string" as const, required: true, description: "a" },
    n: { type: "integer" as const, description: "n" },
    b: { type: "boolean" as const, description: "b" },
  };

  it("accepts valid args and drops absent optionals", () => {
    expect(validateArgs(parameters, { a: "x", n: 2, b: true })).toEqual({ a: "x", n: 2, b: true });
    expect(validateArgs(parameters, { a: "x" })).toEqual({ a: "x" });
  });

  it("rejects missing required, unknown, and wrongly typed arguments", () => {
    expect(() => validateArgs(parameters, {})).toThrow(/missing required argument: a/);
    expect(() => validateArgs(parameters, { a: "x", z: 1 })).toThrow(/unknown argument: z/);
    expect(() => validateArgs(parameters, { a: 1 })).toThrow(/a must be a string/);
    expect(() => validateArgs(parameters, { a: "x", n: 1.5 })).toThrow(/n must be an integer/);
    expect(() => validateArgs(parameters, { a: "x", b: "yes" })).toThrow(/b must be a boolean/);
  });
});

describe("refractor_match tool", () => {
  it("matches 碎冰红 through the shared runtime", async () => {
    const { store, embedder } = await makeDictStore();
    setToolRuntime({ store, embedder });
    const match = tool("refractor_match");
    const result = (await match.run({
      pattern: "碎冰",
      color: "红",
      brand: "panini",
      series: "prizm",
      desc: "红色水晶裂纹状折射，光线下反光",
    })) as { matched: boolean; refraction: string; needsReview: boolean };
    expect(result).toMatchObject({ matched: true, refraction: "碎冰红", needsReview: false });
  });

  it("routes below-threshold matches to review", async () => {
    const { store, embedder } = await makeDictStore();
    setToolRuntime({ store, embedder });
    const result = (await tool("refractor_match").run({
      pattern: "碎冰",
      color: "红",
      brand: "panini",
      series: "prizm",
      desc: "红色水晶裂纹状折射，光线下反光",
      threshold: 0.99,
    })) as { needsReview: boolean };
    expect(result.needsReview).toBe(true);
  });
});

describe("refractor_batch_status tool", () => {
  it("reports counts from the work directory job store", async () => {
    const work = await mkdtemp(join(tmpdir(), "refr-status-"));
    const { JobStore } = await import("../src/jobStore.ts");
    const store = new JobStore(join(work, "refractor.sqlite3"));
    store.register([
      { id: "a", path: "/tmp/a", inputHash: "ha" },
      { id: "b", path: "/tmp/b", inputHash: "hb" },
    ]);
    const first = store.claim("w", 1000);
    store.complete(first as NonNullable<typeof first>, { ok: 1 }, false);
    store.close();

    const status = (await tool("refractor_batch_status").run({ work })) as {
      stats: Record<string, number>;
      results: number;
    };
    expect(status.stats).toMatchObject({ done: 1, pending: 1 });
    expect(status.results).toBe(1);
  });
});

describe("refractor_batch_run tool", () => {
  it("dry-runs without network and reports zero registrations for an empty input", async () => {
    const input = await mkdtemp(join(tmpdir(), "refr-empty-in-"));
    const work = await mkdtemp(join(tmpdir(), "refr-empty-work-"));
    const summary = (await tool("refractor_batch_run").run({
      input,
      work,
      dryRun: true,
    })) as { registered: number; ok: number };
    expect(summary).toMatchObject({ registered: 0, ok: 0 });
  });
});

describe("refractor_recognize tool", () => {
  it("fails loud without VLM credentials instead of guessing", async () => {
    // Empty strings keep loadEnv() from re-filling the real credentials from
    // .env while reqEnv() still treats them as missing — hermetic test.
    process.env.VLM_BASE_URL = "";
    process.env.VLM_API_KEY = "";
    await expect(tool("refractor_recognize").run({ front: "data:image/png;base64,AA==" })).rejects.toThrow(
      /missing env VLM_BASE_URL/,
    );
  });
});

describe("tool specs", () => {
  it("exposes exactly the runtime tool set", () => {
    expect(refractorTools.map((spec) => spec.name)).toEqual([
      "refractor_recognize",
      "refractor_match",
      "refractor_batch_run",
      "refractor_batch_status",
    ]);
  });
});
