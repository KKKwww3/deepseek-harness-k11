/** VLM refraction recognition via the Volcano Ark Responses API.
 *
 * TypeScript port of `scripts/vlm.py`. Sends the card front+back images plus a
 * strict-JSON prompt to `VLM_BASE_URL`/`VLM_API_KEY`/`VLM_MODEL` (default
 * model `doubao-seed-2-0-lite-260428`) and returns the validated recognition
 * `{schemaVersion, pattern, color, brand, series, desc}`.
 *
 * Reliability contract (must stay identical to the Python version):
 * - request caps: max_output_tokens, provider-response byte cap, model-text
 *   byte cap — oversized output is REJECTED, never truncated;
 * - error taxonomy: format/schema errors retry once (same request by default,
 *   `VLM_RETRY_MODE=repair` resends the original instruction with the
 *   validation-error note appended); business/enum errors never retry;
 *   network/timeouts and transient HTTP (408/409/425/429/5xx) retry with
 *   bounded exponential backoff; permanent HTTP errors never retry;
 * - retry counts and backoff are deployment env vars with hard caps.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_ROOT, env, loadEnv } from "./env.ts";
import { controlledEnumLists, loadDictionary } from "./dict.ts";
import {
  MAX_BRAND_CHARS,
  MAX_COLOR_CHARS,
  MAX_DESC_CHARS,
  MAX_PATTERN_CHARS,
  MAX_SERIES_CHARS,
  RecognitionValidationError,
  validateRecognition,
  type Recognition,
} from "./schemas.ts";

export const DEFAULT_MODEL = "doubao-seed-2-0-lite-260428";
export const DEFAULT_TIMEOUT_SECONDS = 180;
export const DEFAULT_MAX_OUTPUT_TOKENS = 500;
export const DEFAULT_MAX_PROVIDER_BYTES = 256 * 1024;
export const DEFAULT_MAX_TEXT_BYTES = 16 * 1024;
export const DEFAULT_SCHEMA_RETRIES = 1;
export const DEFAULT_NETWORK_RETRIES = 2;
export const DEFAULT_RETRY_BACKOFF_SECONDS = 1;
export const DEFAULT_RETRY_MODE = "same";
export const RETRY_MODES = ["repair", "same"] as const;
export const RETRY_NOTE_DETAIL_CHARS = 200;
export const MAX_RETRY_COUNT = 10;
export const MAX_RETRY_BACKOFF_SECONDS = 60;

export const MAX_IDENTIFIER_CHARS = 80;

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const DICT_PATH = join(AGENT_ROOT, "dicts", "refractions.yml");

// ── env helpers (fail loud on misconfiguration) ─────────────────────────────

function reqEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`missing env ${name} (configure VLM OpenAI-compatible endpoint)`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function boundedIntEnv(name: string, fallback: number, maximum: number): number {
  const value = intEnv(name, fallback);
  if (value > maximum) throw new Error(`${name} must be <= ${maximum}`);
  return value;
}

function floatEnv(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  if (Number.isNaN(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

// ── error taxonomy ────────────────────────────────────────────────────────────

export class VLMResponseError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = "VLMResponseError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class VLMResponseTooLargeError extends VLMResponseError {
  constructor(message: string) {
    super("model_text_too_large", message, true);
  }
}

export class VLMTransportTooLargeError extends VLMResponseError {
  constructor(message: string) {
    super("provider_response_too_large", message);
  }
}

export class VLMResponseValidationError extends VLMResponseError {
  constructor(message: string) {
    super("schema_validation_failed", message, true);
  }
}

export class VLMBusinessValidationError extends VLMResponseError {
  constructor(message: string) {
    super("business_validation_failed", message);
  }
}

export class VLMNetworkError extends VLMResponseError {
  constructor(message: string) {
    super("provider_network_error", message, true);
  }
}

export class VLMTransientHTTPError extends VLMResponseError {
  constructor(message: string) {
    super("provider_transient_error", message, true);
  }
}

export class VLMPermanentHTTPError extends VLMResponseError {
  constructor(message: string) {
    super("provider_permanent_error", message);
  }
}

// ── prompt and enum ──────────────────────────────────────────────────────────

async function loadDict(): Promise<Awaited<ReturnType<typeof loadDictionary>>> {
  return loadDictionary(DICT_PATH);
}

export async function buildPrompt(): Promise<string> {
  const { patterns, colors } = controlledEnumLists(await loadDict());
  return (
    "你是球星卡折射识别助手。请根据下面的卡片正面+反面图片，输出一段严格的 JSON" +
    "（不要夹带任何其他文字，不要用 Markdown 围栏）：\n" +
    '{"pattern":"...","color":"...","brand":"...","series":"...","desc":"..."}\n' +
    "规则：\n" +
    `1. pattern 图案类型与 color 颜色取自受控枚举：图案[${patterns.join("/")}]，` +
    `颜色[${colors.join("/")}]。\n` +
    "2. 同图案不同颜色是不同折射，pattern 相同只改 color，绝不合并。\n" +
    "3. brand/series 以反面版权文字为准，读不到写 unknown。\n" +
    "4. 没有折射写 pattern=平卡、color=无。\n" +
    "5. desc 只描述折射外观本身（图案、颜色、光泽、质地），一句话 10~30 字，" +
    "用于向量匹配；严禁描述卡面人物、球员、球队、文字、logo、背景图案。\n" +
    "6. brand 用小写（如 panini、topps）；series 用简短小写（如 prizm、chrome）。"
  );
}

// ── image input normalization ────────────────────────────────────────────────

function sniffMime(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const head = String.fromCharCode(...data.slice(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (data.length >= 12) {
    const head = String.fromCharCode(...data.slice(0, 4));
    const riffType = String.fromCharCode(...data.slice(8, 12));
    if (head === "RIFF" && riffType === "WEBP") return "image/webp";
  }
  return null;
}

async function dataUri(path: string): Promise<string> {
  const data = await readFile(path);
  const sniffed = sniffMime(data);
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const mime = sniffed ?? MIME[extension] ?? "application/octet-stream";
  return `data:${mime};base64,${data.toString("base64")}`;
}

/** Normalize any image input to an `image_url` the VLM API accepts.
 *
 * Auto-detected: local file path → base64 data URI (MIME sniffed from
 * content); http(s):// URL and data: URI pass through as-is; raw base64 is
 * wrapped as `data:<sniffed-mime>;base64,...`. A missing local path raises
 * instead of being misread as base64.
 */
export async function toImageUrl(source: string): Promise<string> {
  const value = source.trim();
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("data:")) return value;
  const isFile = await stat(value).then(
    (stats) => stats.isFile(),
    () => false,
  );
  if (isFile) return dataUri(value);
  // last resort: raw base64 — but fail loudly if it is not valid base64
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(
      `image input is neither an existing file, http(s) URL, data: URI, nor valid base64: ${value.slice(0, 60)}`,
    );
  }
  const data = Buffer.from(value, "base64");
  const mime = sniffMime(data) ?? "application/octet-stream";
  return `data:${mime};base64,${value}`;
}

// ── parsing and validation ───────────────────────────────────────────────────

const encoder = new TextEncoder();

export async function parseAndValidate(text: string): Promise<Recognition> {
  const maxTextBytes = intEnv("VLM_MAX_TEXT_BYTES", DEFAULT_MAX_TEXT_BYTES);
  if (encoder.encode(text).length > maxTextBytes) {
    throw new VLMResponseTooLargeError(`model text exceeds ${maxTextBytes} bytes`);
  }

  let normalized = text.trim();
  if (normalized.startsWith("```")) {
    const lines = normalized.split("\n");
    if (lines.length < 3 || !lines[lines.length - 1]?.trim().startsWith("```")) {
      throw new VLMResponseValidationError("unterminated markdown fence");
    }
    normalized = lines.slice(1, -1).join("\n").trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new VLMResponseValidationError("VLM output is not valid JSON");
  }

  const doc = await loadDict();
  const { patterns, colors, pairs } = (() => {
    const controlled = controlledEnumLists(doc);
    const pairSet = new Set<string>();
    for (const entry of doc.refractions ?? []) {
      if (typeof entry.pattern === "string" && typeof entry.color === "string") {
        pairSet.add(`${entry.pattern}\u0000${entry.color}`);
      }
    }
    return { patterns: new Set(controlled.patterns), colors: new Set(controlled.colors), pairs: pairSet };
  })();

  try {
    return validateRecognition(parsed, { patterns, colors, pairs });
  } catch (error) {
    if (error instanceof RecognitionValidationError) {
      if (error.code === "business_validation_failed" || error.code === "enum_validation_failed") {
        throw new VLMBusinessValidationError(error.message);
      }
      throw new VLMResponseValidationError(error.message);
    }
    throw error;
  }
}

// ── transport ────────────────────────────────────────────────────────────────

export function isTransientHttp(code: number): boolean {
  return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

function retryDelay(attempt: number): number {
  const base = Math.min(
    floatEnv("VLM_RETRY_BACKOFF_SECONDS", DEFAULT_RETRY_BACKOFF_SECONDS),
    MAX_RETRY_BACKOFF_SECONDS,
  );
  return Math.min(base * 2 ** attempt, MAX_RETRY_BACKOFF_SECONDS);
}

function retryNote(error: VLMResponseError): string {
  const detail = error.message.replace(/\s+/g, " ").slice(0, RETRY_NOTE_DETAIL_CHARS);
  return (
    `补充要求：上一次响应不符合协议（${detail}）。` +
    "请在完整遵守上述全部规则的前提下，只返回一个严格 JSON 对象：" +
    "包含且只能包含 pattern、color、brand、series、desc 五个字符串字段，" +
    "不要 Markdown、解释或额外字段。"
  );
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new VLMTransportTooLargeError(`provider response exceeds ${maxBytes} bytes`);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function requestBody(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new VLMNetworkError("VLM API network or timeout error");
  }
  if (!response.ok) {
    if (isTransientHttp(response.status)) {
      throw new VLMTransientHTTPError(`VLM API transient HTTP error ${response.status}`);
    }
    throw new VLMPermanentHTTPError(`VLM API HTTP error ${response.status}`);
  }
  const raw = await readLimited(response, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new VLMResponseValidationError("provider response is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VLMResponseValidationError("provider response must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function extractText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { type?: unknown; content?: unknown };
    if (record.type !== "message") continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "output_text"
      ) {
        parts.push(String((part as { text?: unknown }).text ?? ""));
      }
    }
  }
  const text = parts.join("").trim();
  if (!text) throw new VLMResponseValidationError("VLM returned no message text");
  return text;
}

// ── recognition with bounded protocol and network retries ────────────────────

export interface VlmDeps {
  /** Injectable transport for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (defaults to setTimeout). Milliseconds. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface RecognizeOptions {
  timeoutSeconds?: number;
  maxProviderBytes?: number;
  schemaRetries?: number;
  networkRetries?: number;
  maxOutputTokens?: number;
  retryMode?: (typeof RETRY_MODES)[number];
}

function responseFrom(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function recognize(
  images: readonly string[],
  deps: VlmDeps = {},
  options: RecognizeOptions = {},
): Promise<Recognition> {
  loadEnv();
  const base = reqEnv("VLM_BASE_URL").replace(/\/+$/, "");
  const key = reqEnv("VLM_API_KEY");
  const model = env("VLM_MODEL") ?? DEFAULT_MODEL;
  const timeoutSeconds = options.timeoutSeconds ?? intEnv("VLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS);
  const maxProviderBytes =
    options.maxProviderBytes ?? intEnv("VLM_MAX_PROVIDER_BYTES", DEFAULT_MAX_PROVIDER_BYTES);
  const schemaRetries =
    options.schemaRetries ?? boundedIntEnv("VLM_SCHEMA_RETRIES", DEFAULT_SCHEMA_RETRIES, MAX_RETRY_COUNT);
  const networkRetries =
    options.networkRetries ?? boundedIntEnv("VLM_NETWORK_RETRIES", DEFAULT_NETWORK_RETRIES, MAX_RETRY_COUNT);
  const maxOutputTokens =
    options.maxOutputTokens ?? intEnv("VLM_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  const retryMode = options.retryMode ?? (env("VLM_RETRY_MODE") ?? DEFAULT_RETRY_MODE).trim();
  if (!(RETRY_MODES as readonly string[]).includes(retryMode)) {
    throw new Error("VLM_RETRY_MODE must be 'repair' or 'same'");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const imageContent: Array<Record<string, string>> = [];
  for (const image of images) {
    imageContent.push({ type: "input_image", image_url: await toImageUrl(image) });
  }
  const baseInstruction = await buildPrompt();
  let instruction = baseInstruction;
  let protocolAttempt = 0;
  let networkAttempt = 0;

  for (;;) {
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: instruction },
      ...imageContent,
    ];
    const payload = JSON.stringify({
      model,
      input: [{ role: "user", content }],
      temperature: 0,
      max_output_tokens: maxOutputTokens,
    });
    try {
      const body = await requestBody(fetchImpl, `${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      }, maxProviderBytes);
      const text = extractText(body);
      return await parseAndValidate(text);
    } catch (error) {
      if (error instanceof VLMResponseValidationError || error instanceof VLMResponseTooLargeError) {
        if (protocolAttempt >= schemaRetries) throw error;
        protocolAttempt += 1;
        if (retryMode === "repair") {
          instruction = `${baseInstruction}\n${retryNote(error)}`;
        }
      } else if (error instanceof VLMNetworkError || error instanceof VLMTransientHTTPError) {
        if (networkAttempt >= networkRetries) throw error;
        // retryDelay returns seconds (parity with the Python contract); sleep is ms.
        await sleep(retryDelay(networkAttempt) * 1000);
        networkAttempt += 1;
      } else {
        throw error;
      }
    }
  }
}

export { responseFrom };

async function main(): Promise<number> {
  const images = process.argv.slice(2);
  if (images.length === 0) {
    console.log("usage: node src/vlm.ts <front> [back ...]");
    console.log("  each item: local path | http(s):// URL | data: URI | base64");
    return 2;
  }
  console.log(JSON.stringify(await recognize(images), null, 0));
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

// Re-exported for downstream consumers (batch runner) and test convenience.
export {
  MAX_PATTERN_CHARS,
  MAX_COLOR_CHARS,
  MAX_BRAND_CHARS,
  MAX_SERIES_CHARS,
  MAX_DESC_CHARS,
};
