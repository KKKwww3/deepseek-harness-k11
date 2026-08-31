/** Validation for the refractor VLM recognition protocol.
 *
 * The VLM response is treated as untrusted external input. This module is the
 * TypeScript port of `scripts/schemas.py` and must stay behavior-identical:
 * same check order, same normalization, same error codes. The Python version
 * and its tests are the behavioral contract during the Node migration.
 */

export const SCHEMA_VERSION = "refractor-recognition.v1";

export const REQUIRED_FIELDS = [
  "pattern",
  "color",
  "brand",
  "series",
  "desc",
] as const;

export type RecognitionField = (typeof REQUIRED_FIELDS)[number];

export type Recognition = { schemaVersion: string } & Record<
  RecognitionField,
  string
>;

export const MAX_PATTERN_CHARS = 40;
export const MAX_COLOR_CHARS = 20;
export const MAX_BRAND_CHARS = 80;
export const MAX_SERIES_CHARS = 80;
export const MAX_DESC_CHARS = 300;

const PLAIN_CARD = "平卡";
const OTHER = "其他";
const NO_COLOR = "无";

export class RecognitionValidationError extends Error {
  code: string;
  retryable = false;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "RecognitionValidationError";
    this.code = code ?? "schema_validation_failed";
  }
}

/** Malformed or incomplete output that may be repaired once. */
export class RecognitionFormatError extends RecognitionValidationError {
  override readonly retryable = true;
}

/** A syntactically valid value that violates domain rules. */
export class RecognitionBusinessError extends RecognitionValidationError {
  override code = "business_validation_failed";
}

function cleanText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new RecognitionValidationError(`${field} must be a string`);
  }
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    throw new RecognitionValidationError(`${field} must not be empty`);
  }
  if (cleaned.length > maxChars) {
    throw new RecognitionValidationError(
      `${field} exceeds ${maxChars} Unicode characters`,
      "field_too_large",
    );
  }
  return cleaned;
}

function identifier(value: unknown, field: string, maxChars: number): string {
  return cleanText(value, field, maxChars).toLowerCase();
}

export interface ControlledValues {
  patterns: Set<string>;
  colors: Set<string>;
  /** Registered (pattern, color) combinations keyed `${pattern}\u0000${color}`. */
  pairs?: Set<string>;
}

export interface ValidateOptions {
  requireSchemaVersion?: boolean;
}

/** Validate and normalize one flat VLM recognition object.
 *
 * Unknown fields, nested objects, arrays, nulls, invalid enum values, and
 * unregistered pattern/color combinations are rejected before matching. The
 * returned mapping contains only protocol fields plus `schemaVersion`.
 */
export function validateRecognition(
  raw: unknown,
  { patterns, colors, pairs }: ControlledValues,
  { requireSchemaVersion = false }: ValidateOptions = {},
): Recognition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RecognitionValidationError("VLM response must be a JSON object");
  }
  const record = raw as Record<string, unknown>;

  if (requireSchemaVersion && record.schemaVersion !== SCHEMA_VERSION) {
    throw new RecognitionValidationError(
      `schemaVersion must be ${JSON.stringify(SCHEMA_VERSION)}`,
    );
  }

  const keys = new Set(Object.keys(record));
  keys.delete("schemaVersion");
  const missing = REQUIRED_FIELDS.filter((field) => !keys.has(field));
  const extra = [...keys].filter(
    (field) => !REQUIRED_FIELDS.includes(field as RecognitionField),
  );
  if (missing.length > 0) {
    throw new RecognitionValidationError(
      `missing required fields: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    throw new RecognitionValidationError(`unknown fields: ${extra.join(", ")}`);
  }

  const pattern = cleanText(record.pattern, "pattern", MAX_PATTERN_CHARS);
  const color = cleanText(record.color, "color", MAX_COLOR_CHARS);
  const brand = identifier(record.brand, "brand", MAX_BRAND_CHARS);
  const series = identifier(record.series, "series", MAX_SERIES_CHARS);
  const desc = cleanText(record.desc, "desc", MAX_DESC_CHARS);

  const allowedPatterns = new Set(patterns).add(PLAIN_CARD).add(OTHER);
  const allowedColors = new Set(colors).add(NO_COLOR).add(OTHER);
  if (!allowedPatterns.has(pattern)) {
    throw new RecognitionValidationError(
      `invalid pattern ${JSON.stringify(pattern)}; expected one of the controlled values`,
      "enum_validation_failed",
    );
  }
  if (!allowedColors.has(color)) {
    throw new RecognitionValidationError(
      `invalid color ${JSON.stringify(color)}; expected one of the controlled values`,
      "enum_validation_failed",
    );
  }
  if (pattern === PLAIN_CARD && color !== NO_COLOR) {
    throw new RecognitionValidationError(
      "plain card must use color=无",
      "business_validation_failed",
    );
  }
  if (
    pairs !== undefined &&
    pattern !== PLAIN_CARD &&
    pattern !== OTHER &&
    color !== NO_COLOR &&
    color !== OTHER &&
    !pairs.has(`${pattern}\u0000${color}`)
  ) {
    throw new RecognitionValidationError(
      `unregistered pattern/color pair: ${pattern}/${color}`,
      "business_validation_failed",
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    pattern,
    color,
    brand,
    series,
    desc,
  };
}
