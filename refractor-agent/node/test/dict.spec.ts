import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildNameRows,
  buildRows,
  controlledValues,
  validateDictionary,
  type RefractionDoc,
} from "../src/dict.ts";

const DOC: RefractionDoc = {
  refractions: [
    {
      pattern: "碎冰",
      color: "红",
      keywords: ["碎冰红", "red ice"],
      names: { "panini-prizm": { name: "碎冰红", name_en: "Red Ice" } },
    },
    {
      pattern: "银折",
      color: "银",
      keywords: ["银折", "silver"],
      names: {
        "panini-prizm": { name: "银折", name_en: "Silver" },
        "topps-chrome": { name: "普折射", name_en: "Refractor" },
      },
    },
  ],
};

describe("validateDictionary", () => {
  it("accepts a well-formed dictionary", () => {
    expect(validateDictionary(DOC, "dicts/refractions.yml")).toEqual([]);
  });

  it("reports duplicate (pattern,color), missing keywords, and bad names", () => {
    const bad: RefractionDoc = {
      refractions: [
        { pattern: "碎冰", color: "红", keywords: ["a"], names: {} },
        { pattern: "碎冰", color: "红", keywords: ["b"], names: {} },
        { pattern: "金折", color: "金", keywords: [], names: {} },
        {
          pattern: "脉冲",
          color: "紫",
          keywords: ["violet"],
          names: { "topps-chrome": { name: "紫脉冲", name_en: "" } },
        },
      ],
    };
    const errors = validateDictionary(bad, "dict.yml");
    expect(errors.some((e) => e.includes("duplicate (pattern,color)=(碎冰,红) at #1"))).toBe(true);
    expect(errors.some((e) => e.includes("#2 (金折,金) needs non-empty keywords"))).toBe(true);
    expect(errors.some((e) => e.includes("series 'topps-chrome' needs name+name_en"))).toBe(true);
  });

  it("reports an empty dictionary", () => {
    const errors = validateDictionary({ refractions: [] }, "dict.yml");
    expect(errors).toEqual(["[dict.yml] no refractions defined"]);
  });
});

describe("buildRows", () => {
  it("joins pattern + color + keywords into text and derives the id", () => {
    const rows = buildRows(DOC);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("碎冰-红");
    expect(rows[0].text).toBe("碎冰 红 碎冰红 red ice");
    expect(rows[0].vector).toEqual([]);
  });
});

describe("buildNameRows", () => {
  it("splits series keys on the first dash", () => {
    const names = buildNameRows(DOC);
    expect(names).toHaveLength(3);
    expect(names[0]).toMatchObject({
      brand: "panini",
      series: "prizm",
      pattern: "碎冰",
      color: "红",
      name: "碎冰红",
      name_en: "Red Ice",
    });
    expect(names[2]).toMatchObject({ brand: "topps", series: "chrome", name: "普折射" });
  });
});

describe("controlledValues", () => {
  it("derives patterns, colors, and registered pairs", () => {
    const { patterns, colors, pairs } = controlledValues(DOC);
    expect([...patterns].sort()).toEqual(["碎冰", "银折"].sort());
    expect([...colors].sort()).toEqual(["红", "银"].sort());
    expect(pairs.has("碎冰\u0000红")).toBe(true);
    expect(pairs.has("银折\u0000银")).toBe(true);
    expect(pairs.has("碎冰\u0000蓝")).toBe(false);
  });
});
