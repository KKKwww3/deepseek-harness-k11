import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  loadCases,
  prepareMatch,
  roundHalfEven,
  runMatchPrepared,
} from "../src/evaluate.ts";
import { forceLocalEmbedderEnv, makeDictStore } from "./helpers.ts";

describe("roundHalfEven", () => {
  it("matches Python round() semantics including the half-even tie", () => {
    expect(roundHalfEven(0.03125, 4)).toBe(0.0312); // Python round(0.03125, 4) — ties to even
    expect(roundHalfEven(0.9166666666666666, 4)).toBe(0.9167);
    expect(roundHalfEven(1, 4)).toBe(1);
    expect(roundHalfEven(0.5, 0)).toBe(0); // ties to even
    expect(roundHalfEven(1.5, 0)).toBe(2);
  });
});

describe("match-mode evaluation pipeline", () => {
  it("aggregates metrics, details, and confusion like the Python version", async () => {
    forceLocalEmbedderEnv();
    const { store, embedder } = await makeDictStore();

    const dir = await mkdtemp(join(tmpdir(), "refr-eval-"));
    const goldenPath = join(dir, "golden.yaml");
    await writeFile(
      goldenPath,
      [
        "cases:",
        "  - id: hit",
        "    expected: {refraction: 碎冰红, pattern: 碎冰, color: 红, brand: panini, series: prizm}",
        "    rec: {pattern: 碎冰, color: 红, brand: panini, series: prizm, desc: 红色水晶裂纹状折射，光线下反光}",
        "  - id: plain",
        "    expected: {refraction: null, pattern: 平卡, color: 无, brand: panini, series: prizm}",
        "    rec: {pattern: 平卡, color: 无, brand: panini, series: prizm, desc: 普通平卡无折射}",
        "  - id: no-rec",
        "    front: images/missing-front.jpg",
        "    expected: {refraction: 碎冰红}",
        "  - id: mismatch",
        "    expected: {refraction: 碎冰红, pattern: 碎冰, color: 红, brand: panini, series: prizm}",
        "    rec: {pattern: 金折, color: 金, brand: panini, series: prizm, desc: 金色折射，整体金光}",
      ].join("\n"),
      "utf8",
    );

    const cases = await loadCases(goldenPath);
    expect(cases).toHaveLength(4);

    const prepared = await prepareMatch(cases, embedder);
    for (const item of prepared) {
      if (item.qv !== undefined) item.hit = await store.top1(item.qv);
    }

    const { metrics, details, confusion } = await aggregate(prepared, store, 0.5);

    // total=4; error case counts in total only
    expect(metrics.total).toBe(4);
    // det: hit/plain/mismatch all correct → 3/4 (no-rec has no det)
    expect(metrics.det_acc).toBe(0.75);
    // term: non_plain = {hit, mismatch} → 1/2
    expect(metrics.term_acc).toBe(0.5);
    expect(metrics.non_plain).toBe(2);
    expect(metrics.predicted_terms).toBe(2);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.review_rate).toBe(0);
    expect(metrics.pattern_acc).toBe(0.5); // hit correct, mismatch wrong
    expect(metrics.color_acc).toBe(0.5);
    expect(metrics.series_acc).toBe(1);

    // detail rows: one error row first? No — order follows case order.
    expect(details).toHaveLength(4);
    expect(details[2]).toEqual({
      id: "no-rec",
      error: "case has no rec (match mode)",
      stage: "recognize",
    });
    expect(details[0]?.correct).toEqual({
      term: true,
      pattern: true,
      color: true,
      series: true,
      review: false,
    });
    expect(details[3]?.correct).toEqual({
      term: false,
      pattern: false,
      color: false,
      series: true,
      review: false,
    });
    expect(details[1]?.predicted).toEqual({
      matched: false,
      refraction: null,
      needsReview: false,
    });

    // mismatch's rec (金折/金) exists in the dict, so the matcher correctly
    // predicts 金折 against the wrong expectation 碎冰红 — det still counts
    // it as detected (both sides non-null).
    expect(confusion).toEqual({
      碎冰红: { 碎冰红: 1, 金折: 1 },
      "(plain)": { "(none)": 1 },
    });
  });

  it("runMatchPrepared reports no-rec errors verbatim", async () => {
    forceLocalEmbedderEnv();
    const { store } = await makeDictStore();
    const output = await runMatchPrepared({ case: { id: "x" }, error: "custom" }, store, 0.5);
    expect(output).toEqual({ error: "custom" });
    const fallback = await runMatchPrepared({ case: { id: "x" } }, store, 0.5);
    expect(fallback).toEqual({ error: "no rec" });
  });

  it("loadCases ignores non-case document keys and tolerates an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-eval-load-"));
    await mkdir(dir, { recursive: true });
    const goldenPath = join(dir, "golden.yaml");
    await writeFile(goldenPath, "images_root: eval/images\ncases: []\n", "utf8");
    expect(await loadCases(goldenPath)).toEqual([]);
  });
});
