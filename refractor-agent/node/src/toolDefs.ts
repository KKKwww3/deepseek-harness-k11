/** Tool-definition builders shared by the DSH plugin and its tests.
 *
 * Definitions are LITERAL ToolDefinition objects (the runtime shape
 * `dsh-tools`' registry accepts — name/description/parameters JSON Schema/
 * output/execute) so the bundle imports nothing from the harness. Domain
 * behavior lives in `tools.ts`; this module only shapes the model-facing
 * declarations and forwards arguments.
 */

import { refractorTools, type ToolSpec } from "./tools.ts";

const JSON_VALUE_SCHEMA = { type: "object" } as const;

function parametersSchema(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(spec.parameters)) {
    properties[name] = { type: param.type, description: param.description };
    if (param.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function renderValue(_args: unknown, value: unknown): Array<{ type: string; text: string }> {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** Per-tool cooperative timeouts (ms): the host enforces the budget. */
export const TOOL_TIMEOUT_MS: Record<string, number> = {
  refractor_recognize: 300_000,
  refractor_match: 60_000,
  refractor_batch_run: 600_000,
  refractor_batch_status: 10_000,
};

/** Tools that only read shared state may join a parallel group. */
export const CONCURRENCY_SAFE = new Set(["refractor_match", "refractor_batch_status"]);

export interface ToolRegistrar {
  register(definition: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] };
    execute: (args: unknown) => Promise<unknown>;
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
  }): unknown;
}

/** Build the ToolDefinition array (exported for tests without a context). */
export function buildToolDefinitions(registrar: ToolRegistrar): void {
  for (const spec of refractorTools) {
    registrar.register({
      name: spec.name,
      description: spec.description,
      parameters: parametersSchema(spec),
      output: { schema: JSON_VALUE_SCHEMA, render: renderValue },
      async execute(args) {
        return spec.run((args ?? {}) as Record<string, unknown>);
      },
      timeoutMs: TOOL_TIMEOUT_MS[spec.name],
      ...(CONCURRENCY_SAFE.has(spec.name) ? { isConcurrencySafe: () => true } : {}),
    });
  }
}
