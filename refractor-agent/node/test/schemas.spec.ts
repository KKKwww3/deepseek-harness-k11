import { describe, expect, it } from "vitest";

import {
  MAX_DESC_CHARS,
  RecognitionValidationError,
  SCHEMA_VERSION,
  validateRecognition,
  type ControlledValues,
} from "../src/schemas.ts";

const CONTROLLED: ControlledValues = {
  patterns: new Set(["碎冰", "银折", "金折"]),
  colors: new Set(["红", "银", "蓝", "金"]),
  pairs: new Set(["碎冰\u0000红", "银折\u0000银"]),
};

function rec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pattern: "碎冰",
    color: "红",
    brand: " PANINI ",
    series: " PRIZM ",
    desc: "红色水晶裂纹折射",
    ...overrides,
  };
}

describe("validateRecognition", () => {
  it("normalizes identifiers and includes schemaVersion", () => {
    const result = validateRecognition(rec(), CONTROLLED);
    expect(result.brand).toBe("panini");
    expect(result.series).toBe("prizm");
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.desc).toBe("红色水晶裂纹折射");
  });

  it("rejects non-objects, missing fields, and extra fields", () => {
    expect(() => validateRecognition("nope", CONTROLLED)).toThrow(RecognitionValidationError);
    expect(() => validateRecognition(["array"], CONTROLLED)).toThrow(RecognitionValidationError);
    const { color, ...missingColor } = rec();
    void color;
    expect(() => validateRecognition(missingColor, CONTROLLED)).toThrow(/missing required fields: color/);
    expect(() => validateRecognition(rec({ extra: "no" }), CONTROLLED)).toThrow(/unknown fields: extra/);
    // missing is reported before extra
    expect(() => validateRecognition({ extra: "no" }, CONTROLLED)).toThrow(/missing required fields/);
  });

  it("rejects wrong field types and empty values", () => {
    expect(() => validateRecognition(rec({ pattern: 123 }), CONTROLLED)).toThrow(/pattern must be a string/);
    expect(() => validateRecognition(rec({ desc: "   " }), CONTROLLED)).toThrow(/desc must not be empty/);
    expect(() => validateRecognition(rec({ brand: null }), CONTROLLED)).toThrow(/brand must be a string/);
  });

  it("rejects oversized fields with field_too_large code", () => {
    try {
      validateRecognition(rec({ desc: "x".repeat(MAX_DESC_CHARS + 1) }), CONTROLLED);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RecognitionValidationError);
      expect((error as RecognitionValidationError).code).toBe("field_too_large");
    }
  });

  it("rejects invalid enum values with enum_validation_failed code", () => {
    try {
      validateRecognition(rec({ pattern: "不存在" }), CONTROLLED);
      expect.unreachable();
    } catch (error) {
      expect((error as RecognitionValidationError).code).toBe("enum_validation_failed");
    }
    expect(() => validateRecognition(rec({ color: "彩色" }), CONTROLLED)).toThrow(
      RecognitionValidationError,
    );
  });

  it("enforces plain-card color consistency", () => {
    try {
      validateRecognition(rec({ pattern: "平卡", color: "红" }), CONTROLLED);
      expect.unreachable();
    } catch (error) {
      // Parity: Python raises the base class carrying the code, not a subclass.
      expect(error).toBeInstanceOf(RecognitionValidationError);
      expect((error as RecognitionValidationError).code).toBe("business_validation_failed");
    }
    const result = validateRecognition(rec({ pattern: "平卡", color: "无" }), CONTROLLED);
    expect(result.pattern).toBe("平卡");
  });

  it("rejects unregistered pattern/color pairs when pairs are provided", () => {
    const options = { ...CONTROLLED };
    expect(() => validateRecognition(rec({ pattern: "银折", color: "红" }), options)).toThrow(
      /unregistered pattern\/color pair/,
    );
    const registered = validateRecognition(rec({ pattern: "银折", color: "银" }), options);
    expect(registered.pattern).toBe("银折");
  });

  it("collapses whitespace runs inside values", () => {
    const result = validateRecognition(rec({ desc: "  红色\t水晶\n裂纹  折射  " }), CONTROLLED);
    expect(result.desc).toBe("红色 水晶 裂纹 折射");
  });

  it("enforces schemaVersion when required", () => {
    expect(() =>
      validateRecognition(rec(), CONTROLLED, { requireSchemaVersion: true }),
    ).toThrow(/schemaVersion/);
    const accepted = validateRecognition(
      rec({ schemaVersion: SCHEMA_VERSION }),
      CONTROLLED,
      { requireSchemaVersion: true },
    );
    expect(accepted.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
