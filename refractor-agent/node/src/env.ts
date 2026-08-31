/** .env loading and shared path resolution.
 *
 * TypeScript port of `refract_store.load_env`: candidates are the agent-root
 * `.env` first, then every `.env` walking up from the current directory.
 * Real environment variables always win; files never override them.
 */

import { readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The refractor-agent root directory (two levels above this module). */
export const AGENT_ROOT = resolve(moduleDir, "..", "..");

/** Candidate .env paths: agent root first, then cwd walk-up. */
export function dotenvCandidates(cwd: string = process.cwd()): string[] {
  const candidates = [join(AGENT_ROOT, ".env")];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  while (dir !== root) {
    candidates.push(join(dir, ".env"));
    dir = dirname(dir);
  }
  return candidates;
}

/** Load `KEY=VALUE` lines from .env files without overriding real env vars.
 *
 * Minimal parser: `#` comments, no shell expansion, paired outer quotes are
 * stripped. Matches the Python parser's behavior; no inline-comment stripping.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  const seen = new Set<string>();
  for (const candidate of dotenvCandidates(cwd)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue; // a missing candidate file is the common case
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  }
}

/** First non-empty value among the named environment variables. */
export function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}
