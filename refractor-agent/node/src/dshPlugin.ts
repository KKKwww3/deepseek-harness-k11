/** DSH function plugin: registers the refractor domain tools with the host.
 *
 * Function-plugin export shape per repo convention: named `name` / `apply`
 * exports and NO default export — mixing forms makes the Loader discard the
 * plugin namespace. The bundle entry exports only `name` and `apply`;
 * definition building lives in `toolDefs.ts` (also imported by tests).
 *
 * The recognition preset mounts this plugin; registrations therefore scope to
 * the agents that join the preset, not the process. Dictionary administration
 * (embed rebuild) is deliberately absent — the recognition agent must not
 * mutate its own knowledge base.
 */

import { buildToolDefinitions, type ToolRegistrar } from "./toolDefs.ts";

export const name = "refractor-agent-tools";

export function apply(ctx: { tools: ToolRegistrar }): void {
  buildToolDefinitions(ctx.tools);
}
