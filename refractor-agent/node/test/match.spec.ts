import { afterEach, describe, expect, it } from "vitest";

import { bestType, matchRecognition, norm, queryText, seriesName } from "../src/match.ts";
import { localEmbed } from "../src/store.ts";
import { forceLocalEmbedderEnv, makeDictStore } from "./helpers.ts";

afterEach(() => forceLocalEmbedderEnv());

describe("norm", () => {
  it("lowercases, trims, and collapses inner whitespace", () => {
    expect(norm("  PANINI \t Prizm ")).toBe("panini prizm");
    expect(norm("   ")).toBe("");
  });
});

describe("queryText", () => {
  it("joins the truthy parts of pattern/color/desc", () => {
    expect(queryText({ pattern: "碎冰", color: "红", desc: "红色水晶裂纹" })).toBe(
      "碎冰 红 红色水晶裂纹",
    );
    expect(queryText({ pattern: "碎冰", color: "", desc: null })).toBe("碎冰");
  });
});

describe("bestType", () => {
  const hit = [0.87654, { pattern: "碎冰", color: "红" }] as const;

  it("accepts hits at or above the threshold and rounds the score", () => {
    expect(bestType(hit, 0.7)).toEqual({
      matched: true,
      pattern: "碎冰",
      color: "红",
      matchScore: 0.8765,
    });
  });

  it("rejects hits below the threshold and null hits", () => {
    expect(bestType(hit, 0.9)).toBeNull();
    expect(bestType(null, 0.1)).toBeNull();
  });
});

describe("matchRecognition (real dict store, local embedder)", () => {
  it("matches 碎冰红 for panini prizm", async () => {
    const { store, embedder } = await makeDictStore();
    const result = await matchRecognition(
      {
        pattern: "碎冰",
        color: "红",
        brand: "panini",
        series: "prizm",
        desc: "红色水晶裂纹状折射，光线下反光",
      },
      embedder,
      store,
    );
    expect(result).toMatchObject({
      matched: true,
      refraction: "碎冰红",
      name_en: "Red Ice",
      pattern: "碎冰",
      color: "红",
      needsReview: false,
    });
  });

  it("resolves the same refraction type differently per series", async () => {
    const { store, embedder } = await makeDictStore();
    const topps = await matchRecognition(
      { pattern: "银折", color: "银", brand: "topps", series: "chrome", desc: "银白色普通折射" },
      embedder,
      store,
    );
    const panini = await matchRecognition(
      { pattern: "银折", color: "银", brand: "panini", series: "prizm", desc: "银色普通折射" },
      embedder,
      store,
    );
    expect(topps).toMatchObject({ refraction: "普折射", name_en: "Refractor", needsReview: false });
    expect(panini).toMatchObject({ refraction: "银折", name_en: "Silver", needsReview: false });
  });

  it("short-circuits plain cards without matching", async () => {
    const { store, embedder } = await makeDictStore();
    const result = await matchRecognition(
      { pattern: "平卡", color: "无", brand: "panini", series: "prizm", desc: "普通平卡无折射" },
      embedder,
      store,
    );
    expect(result).toEqual({ matched: false, refraction: null, needsReview: false });
  });

  it("routes missing series naming to review", async () => {
    const { store, embedder } = await makeDictStore();
    const result = await matchRecognition(
      { pattern: "碎冰", color: "红", brand: "topps", series: "prizm", desc: "红色水晶裂纹折射" },
      embedder,
      store,
    );
    expect(result).toMatchObject({
      matched: true,
      pattern: "碎冰",
      color: "红",
      refraction: null,
      needsReview: true,
    });
  });

  it("routes unknown brand/series to review", async () => {
    const { store, embedder } = await makeDictStore();
    const result = await matchRecognition(
      { pattern: "碎冰", color: "红", brand: "unknown", series: "unknown", desc: "红色水晶裂纹折射" },
      embedder,
      store,
    );
    expect(result.needsReview).toBe(true);
    expect(result.refraction).toBeNull();
  });

  it("routes below-threshold scores to review", async () => {
    const { store, embedder } = await makeDictStore();
    const result = await matchRecognition(
      {
        pattern: "碎冰",
        color: "红",
        brand: "panini",
        series: "prizm",
        desc: "红色水晶裂纹状折射，光线下反光",
      },
      embedder,
      store,
      { threshold: 0.99 },
    );
    expect(result).toEqual({ matched: false, refraction: null, needsReview: true });
  });

  it("throws on an empty store", async () => {
    const { embedder } = await makeDictStore();
    const dir = await import("node:fs/promises").then((m) => m.mkdtemp("refr-empty-match-"));
    const { LanceStore } = await import("../src/store.ts");
    const empty = await LanceStore.connect(dir);
    await expect(
      matchRecognition(
        { pattern: "碎冰", color: "红", brand: "panini", series: "prizm", desc: "x" },
        embedder,
        empty,
      ),
    ).rejects.toThrow(/empty store/);
  });
});

describe("seriesName", () => {
  it("normalizes brand/series before querying", async () => {
    const { store } = await makeDictStore();
    const naming = await seriesName(
      { brand: "  PANINI ", series: "PRIZM" },
      "碎冰",
      "红",
      store,
    );
    expect(naming).toEqual({ refraction: "碎冰红", name_en: "Red Ice" });
  });

  it("returns null for missing brand or series", async () => {
    const { store } = await makeDictStore();
    expect(await seriesName({ brand: "", series: "prizm" }, "碎冰", "红", store)).toBeNull();
    expect(await seriesName({ brand: "panini", series: "  " }, "碎冰", "红", store)).toBeNull();
  });
});
