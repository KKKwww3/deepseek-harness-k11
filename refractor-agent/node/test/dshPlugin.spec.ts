import { describe, expect, it } from "vitest";

import { apply, name } from "../src/dshPlugin.ts";
import { buildToolDefinitions } from "../src/toolDefs.ts";
import { setToolRuntime } from "../src/tools.ts";
import { forceLocalEmbedderEnv, makeDictStore } from "./helpers.ts";

interface CapturedDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] };
  execute: (args: unknown) => Promise<unknown>;
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
}

function capture(): { registrar: { register: (def: CapturedDefinition) => void }; defs: CapturedDefinition[] } {
  const defs: CapturedDefinition[] = [];
  return {
    registrar: {
      register(def) {
        defs.push(def);
      },
    },
    defs,
  };
}

describe("refractor DSH plugin", () => {
  it("exposes a function plugin shape (named exports, no default)", async () => {
    expect(name).toBe("refractor-agent-tools");
    expect(typeof apply).toBe("function");
  });

  it("registers exactly the four domain tools with JSON Schema parameters", () => {
    const { registrar, defs } = capture();
    apply({ tools: registrar });
    expect(defs.map((def) => def.name)).toEqual([
      "refractor_recognize",
      "refractor_match",
      "refractor_batch_run",
      "refractor_batch_status",
    ]);
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.parameters.type).toBe("object");
      expect(def.parameters.additionalProperties).toBe(false);
      expect(def.output.schema).toEqual({ type: "object" });
      expect(typeof def.execute).toBe("function");
      expect(typeof def.timeoutMs).toBe("number");
    }
    const match = defs.find((def) => def.name === "refractor_match") as CapturedDefinition;
    expect(match.parameters.required).toEqual(["pattern", "color", "brand", "series", "desc"]);
    expect(match.isConcurrencySafe?.({})).toBe(true);
    const recognize = defs.find((def) => def.name === "refractor_recognize") as CapturedDefinition;
    expect(recognize.isConcurrencySafe).toBeUndefined();
  });

  it("renders results as text content", () => {
    const { registrar, defs } = capture();
    buildToolDefinitions(registrar);
    const match = defs.find((def) => def.name === "refractor_match") as CapturedDefinition;
    const blocks = match.output.render({}, { matched: true }) as Array<{ type: string; text: string }>;
    expect(blocks[0]?.type).toBe("text");
    expect(JSON.parse(blocks[0]?.text as string)).toEqual({ matched: true });
  });

  it("execute forwards to the domain layer (local embedder parity)", async () => {
    forceLocalEmbedderEnv();
    const { store, embedder } = await makeDictStore();
    setToolRuntime({ store, embedder });
    const { registrar, defs } = capture();
    apply({ tools: registrar });
    const match = defs.find((def) => def.name === "refractor_match") as CapturedDefinition;
    const result = (await match.execute({
      pattern: "碎冰",
      color: "红",
      brand: "panini",
      series: "prizm",
      desc: "红色水晶裂纹状折射，光线下反光",
    })) as { refraction: string };
    expect(result.refraction).toBe("碎冰红");
  });
});
