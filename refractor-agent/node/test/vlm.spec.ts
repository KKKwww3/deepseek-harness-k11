import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PROVIDER_BYTES,
  VLMBusinessValidationError,
  VLMPermanentHTTPError,
  VLMResponseError,
  VLMResponseTooLargeError,
  VLMResponseValidationError,
  VLMTransportTooLargeError,
  parseAndValidate,
  recognize,
  responseFrom,
  toImageUrl,
} from "../src/vlm.ts";

const snapshot = new Map<string, string | undefined>();

beforeEach(() => {
  snapshot.clear();
  for (const [key, value] of Object.entries(process.env)) {
    snapshot.set(key, value);
  }
  process.env.VLM_BASE_URL = "https://vlm.example.test";
  process.env.VLM_API_KEY = "test-key";
  process.env.VLM_SCHEMA_RETRIES = "1";
  process.env.VLM_NETWORK_RETRIES = "2";
  delete process.env.VLM_RETRY_MODE;
  delete process.env.VLM_RETRY_BACKOFF_SECONDS;
  delete process.env.VLM_MAX_TEXT_BYTES;
  delete process.env.VLM_MAX_PROVIDER_BYTES;
  delete process.env.VLM_MAX_OUTPUT_TOKENS;
  delete process.env.VLM_TIMEOUT_SECONDS;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!snapshot.has(key)) delete process.env[key];
    else process.env[key] = snapshot.get(key);
  }
});

const VALID_RECOGNITION = {
  pattern: "碎冰",
  color: "红",
  brand: "Panini",
  series: "Prizm",
  desc: "红色水晶裂纹折射",
};

function envelope(modelText: string): unknown {
  return {
    output: [{ type: "message", content: [{ type: "output_text", text: modelText }] }],
  };
}

interface Stub {
  fetchImpl: typeof fetch;
  calls: () => number;
  bodies: () => string[];
}

/** Sequential scripted transport: each entry is a Response factory or an Error to throw. */
function stubFetch(script: Array<() => Response | Error>): Stub {
  let index = 0;
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    bodies.push(String(init?.body ?? ""));
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    const result = step();
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls, bodies: () => bodies };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("parseAndValidate", () => {
  it("normalizes brand/series and collapses whitespace", async () => {
    const result = await parseAndValidate(
      '{"pattern":"碎冰","color":"红","brand":" PANINI ","series":"PRIZM","desc":" 红色 水晶裂纹折射 "}',
    );
    expect(result.brand).toBe("panini");
    expect(result.series).toBe("prizm");
    expect(result.desc).toBe("红色 水晶裂纹折射");
  });

  it("rejects extra fields as retryable validation errors", async () => {
    const text = '{"pattern":"碎冰","color":"红","brand":"panini","series":"prizm","desc":"x","extra":"no"}';
    await expect(parseAndValidate(text)).rejects.toBeInstanceOf(VLMResponseValidationError);
  });

  it("rejects invalid enum values as non-retryable business errors", async () => {
    const text = '{"pattern":"不存在","color":"红","brand":"panini","series":"prizm","desc":"x"}';
    await expect(parseAndValidate(text)).rejects.toBeInstanceOf(VLMBusinessValidationError);
  });

  it("rejects oversized model text without truncation", async () => {
    process.env.VLM_MAX_TEXT_BYTES = "10";
    await expect(parseAndValidate('{"pattern":"碎冰"}')).rejects.toBeInstanceOf(
      VLMResponseTooLargeError,
    );
  });

  it("tolerates fenced JSON but rejects unterminated fences", async () => {
    const fenced = "```\n" + JSON.stringify(VALID_RECOGNITION) + "\n```";
    const result = await parseAndValidate(fenced);
    expect(result.pattern).toBe("碎冰");
    await expect(parseAndValidate("```\n" + JSON.stringify(VALID_RECOGNITION))).rejects.toThrow(
      /unterminated markdown fence/,
    );
  });
});

describe("recognize retry behavior", () => {
  it("retries schema errors with an identical request (default same mode)", async () => {
    const stub = stubFetch([
      () => responseFrom(envelope("not-json")),
      () => responseFrom(envelope(JSON.stringify(VALID_RECOGNITION))),
    ]);
    const sleeps: number[] = [];
    const result = await recognize(["data:image/jpeg;base64,AA=="], {
      fetchImpl: stub.fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.pattern).toBe("碎冰");
    expect(stub.calls()).toBe(2);
    expect(stub.bodies()[0]).toBe(stub.bodies()[1]);
    expect(sleeps).toEqual([]);
  });

  it("repair mode keeps the base instruction and appends the error note", async () => {
    process.env.VLM_RETRY_MODE = "repair";
    const stub = stubFetch([
      () => responseFrom(envelope("not-json")),
      () => responseFrom(envelope(JSON.stringify(VALID_RECOGNITION))),
    ]);
    const result = await recognize(["data:image/jpeg;base64,AA=="], {
      fetchImpl: stub.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result.pattern).toBe("碎冰");
    const first = JSON.parse(stub.bodies()[0]).input[0].content[0].text as string;
    const second = JSON.parse(stub.bodies()[1]).input[0].content[0].text as string;
    expect(first.startsWith("你是球星卡折射识别助手")).toBe(true);
    expect(second.startsWith("你是球星卡折射识别助手")).toBe(true);
    expect(second).toContain("补充要求");
    expect(second.length).toBeGreaterThan(first.length);
  });

  it("fails loud on an invalid retry mode", async () => {
    process.env.VLM_RETRY_MODE = "bogus";
    await expect(
      recognize(["data:image/jpeg;base64,AA=="], { fetchImpl: stubFetch([]).fetchImpl }),
    ).rejects.toThrow(/VLM_RETRY_MODE/);
  });

  it("retries network and transient errors with bounded exponential backoff", async () => {
    process.env.VLM_RETRY_BACKOFF_SECONDS = "1";
    const stub = stubFetch([
      () => new TypeError("fetch failed"),
      () => new Response("overloaded", { status: 500 }),
      () => responseFrom(envelope(JSON.stringify(VALID_RECOGNITION))),
    ]);
    const sleeps: number[] = [];
    const result = await recognize(["data:image/jpeg;base64,AA=="], {
      fetchImpl: stub.fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.color).toBe("红");
    expect(stub.calls()).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("does not retry business validation errors", async () => {
    const invalidEnum = { ...VALID_RECOGNITION, pattern: "不存在" };
    const stub = stubFetch([() => responseFrom(envelope(JSON.stringify(invalidEnum)))]);
    await expect(
      recognize(["data:image/jpeg;base64,AA=="], { fetchImpl: stub.fetchImpl, sleepImpl: noSleep }),
    ).rejects.toBeInstanceOf(VLMBusinessValidationError);
    expect(stub.calls()).toBe(1);
  });

  it("does not retry permanent HTTP errors", async () => {
    const stub = stubFetch([() => new Response("unauthorized", { status: 401 })]);
    await expect(
      recognize(["data:image/jpeg;base64,AA=="], { fetchImpl: stub.fetchImpl, sleepImpl: noSleep }),
    ).rejects.toBeInstanceOf(VLMPermanentHTTPError);
    expect(stub.calls()).toBe(1);
  });

  it("does not retry oversized provider responses", async () => {
    process.env.VLM_MAX_PROVIDER_BYTES = "16";
    const stub = stubFetch([() => new Response(JSON.stringify(envelope("x".repeat(64))))]);
    await expect(
      recognize(["data:image/jpeg;base64,AA=="], { fetchImpl: stub.fetchImpl, sleepImpl: noSleep }),
    ).rejects.toBeInstanceOf(VLMTransportTooLargeError);
    expect(stub.calls()).toBe(1);
  });

  it("rejects non-object and non-JSON provider payloads as validation errors", async () => {
    process.env.VLM_SCHEMA_RETRIES = "2"; // two bad payloads then a good one
    const stub = stubFetch([
      () => new Response("[1,2,3]", { status: 200 }),
      () => new Response("<html>oops</html>", { status: 200 }),
      () => responseFrom(envelope(JSON.stringify(VALID_RECOGNITION))),
    ]);
    const result = await recognize(["data:image/jpeg;base64,AA=="], {
      fetchImpl: stub.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(result.brand).toBe("panini");
    expect(stub.calls()).toBe(3);
  });
});

describe("toImageUrl", () => {
  it("passes through http(s) and data URIs", async () => {
    expect(await toImageUrl("https://example.test/a.jpg")).toBe("https://example.test/a.jpg");
    expect(await toImageUrl("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  });

  it("sniffs MIME from content for local files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-img-"));
    const pngPath = join(dir, "card.bin"); // wrong extension on purpose
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]));
    const url = await toImageUrl(pngPath);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("fails loud for missing files that are not valid base64", async () => {
    await expect(toImageUrl("definitely/missing/card.jpg")).rejects.toThrow(
      /neither an existing file/,
    );
  });
});

describe("error taxonomy", () => {
  it("exposes stable codes and retryability", () => {
    expect(new VLMResponseTooLargeError("x").code).toBe("model_text_too_large");
    expect(new VLMResponseTooLargeError("x").retryable).toBe(true);
    expect(new VLMResponseValidationError("x").code).toBe("schema_validation_failed");
    expect(new VLMResponseValidationError("x").retryable).toBe(true);
    expect(new VLMTransportTooLargeError("x").code).toBe("provider_response_too_large");
    expect(new VLMTransportTooLargeError("x").retryable).toBe(false);
    expect(new VLMResponseError("code", "msg").message).toBe("code: msg");
    expect(DEFAULT_MAX_PROVIDER_BYTES).toBe(256 * 1024);
  });
});
