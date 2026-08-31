/** Framework-neutral domain tool layer for the refractor agent.
 *
 * Each spec is a model-facing tool declaration: name, description, parameter
 * schema (the same shape DSH `defineTool` accepts), and a `run` body. The DSH
 * adapter wires these with `defineTool`, so argument validation at the model
 * boundary, the guarded execution pipeline, approvals, and presentation come
 * from the host; this module owns the domain behavior only.
 *
 * Dictionary administration (add_type / embed rebuild) is deliberately NOT a
 * runtime tool: the recognition agent must not be able to mutate its own
 * knowledge base. Embedding happens through the deploy pipeline or an admin
 * surface, never through these tools.
 */

import { join } from "node:path";

import { loadEnv } from "./env.ts";
import { matchRecognition } from "./match.ts";
import { Embedder, createStore, type BaseStore } from "./store.ts";
import { JobStore } from "./jobStore.ts";
import { runBatch } from "./batch.ts";
import { recognize } from "./vlm.ts";

export interface ParamSpec {
  type: "string" | "number" | "integer" | "boolean";
  required?: boolean;
  description: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ParamSpec>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export class ToolArgumentError extends Error {}

/** Validate model-supplied arguments against a spec (host pipeline re-checks). */
export function validateArgs(
  parameters: Record<string, ParamSpec>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(parameters)) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (spec.required) throw new ToolArgumentError(`missing required argument: ${name}`);
      continue;
    }
    if (spec.type === "string" && typeof value !== "string") {
      throw new ToolArgumentError(`argument ${name} must be a string`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") {
      throw new ToolArgumentError(`argument ${name} must be a boolean`);
    }
    if ((spec.type === "number" || spec.type === "integer") && typeof value !== "number") {
      throw new ToolArgumentError(`argument ${name} must be a number`);
    }
    if (spec.type === "integer" && !Number.isInteger(value)) {
      throw new ToolArgumentError(`argument ${name} must be an integer`);
    }
    out[name] = value;
  }
  for (const name of Object.keys(args)) {
    if (!(name in parameters)) throw new ToolArgumentError(`unknown argument: ${name}`);
  }
  return out;
}

// ── shared pipeline runtime (lazy; injectable for tests) ────────────────────

export interface ToolRuntime {
  embedder: Embedder;
  store: BaseStore;
}

let runtime: ToolRuntime | null = null;

/** Replace the shared runtime (tests inject a local-embedder + tmp store). */
export function setToolRuntime(next: ToolRuntime | null): void {
  runtime = next;
}

async function getRuntime(): Promise<ToolRuntime> {
  if (runtime === null) {
    loadEnv();
    runtime = { embedder: new Embedder(), store: await createStore() };
  }
  return runtime;
}

// ── tool specs ───────────────────────────────────────────────────────────────

const refractorRecognize: ToolSpec = {
  name: "refractor_recognize",
  description:
    "Recognize a trading card's refractor (parallel) finish from its front and back images. " +
    "Returns the validated structured recognition: pattern, color, brand, series, desc. " +
    "Never recognize the refractor yourself from images — call this tool.",
  parameters: {
    front: { type: "string", required: true, description: "Front image: local path, http(s) URL, or data URI" },
    back: { type: "string", description: "Back image: local path, http(s) URL, or data URI" },
  },
  async run(args) {
    const images = [args.front as string, args.back as string].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return recognize(images);
  },
};

const refractorMatch: ToolSpec = {
  name: "refractor_match",
  description:
    "Match a structured refractor recognition to the industry-standard term for the card's " +
    "brand x series. Returns {matched, refraction, name_en, matchScore, needsReview}. " +
    "Low scores and missing series naming come back as needsReview — never invent a name.",
  parameters: {
    pattern: { type: "string", required: true, description: "Recognition pattern (e.g. 碎冰)" },
    color: { type: "string", required: true, description: "Recognition color (e.g. 红)" },
    brand: { type: "string", required: true, description: "Lowercase brand (e.g. panini)" },
    series: { type: "string", required: true, description: "Lowercase series (e.g. prizm)" },
    desc: { type: "string", required: true, description: "Free-text refractor appearance from the recognition" },
    threshold: { type: "number", description: "Optional match score threshold override" },
  },
  async run(args) {
    const { embedder, store } = await getRuntime();
    return matchRecognition(
      {
        pattern: args.pattern as string,
        color: args.color as string,
        brand: args.brand as string,
        series: args.series as string,
        desc: args.desc as string,
      },
      embedder,
      store,
      { threshold: args.threshold as number | undefined },
    );
  },
};

const refractorBatchRun: ToolSpec = {
  name: "refractor_batch_run",
  description:
    "Run the refractor normalization batch over a customer directory (one subdirectory per " +
    "card with front/back images). Durable and resumable: progress lives in the work directory's " +
    "SQLite job store; interrupted runs continue where they stopped. Returns the run summary.",
  parameters: {
    input: { type: "string", required: true, description: "Customer directory of card subdirectories" },
    work: { type: "string", required: true, description: "Work directory for the job store and exports" },
    dryRun: { type: "boolean", description: "Register items and report counts without processing" },
  },
  async run(args) {
    return runBatch({
      input: args.input as string,
      work: args.work as string,
      dryRun: args.dryRun as boolean | undefined,
    });
  },
};

const refractorBatchStatus: ToolSpec = {
  name: "refractor_batch_status",
  description:
    "Report batch progress for a work directory: item counts by status (pending, done, " +
    "review_required, retryable_failed, terminal_failed) and recent audit events. Read-only.",
  parameters: {
    work: { type: "string", required: true, description: "The batch work directory" },
  },
  async run(args) {
    const work = args.work as string;
    const store = new JobStore(join(work, "refractor.sqlite3"));
    try {
      return { stats: store.stats(), results: store.results().length };
    } finally {
      store.close();
    }
  },
};

/** The runtime tool set for the refractor agent preset. */
export const refractorTools: readonly ToolSpec[] = [
  refractorRecognize,
  refractorMatch,
  refractorBatchRun,
  refractorBatchStatus,
];
