import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dotenvCandidates, loadEnv } from "../src/env.ts";

const snapshot = new Map<string, string | undefined>();

beforeEach(() => {
  snapshot.clear();
  for (const [key, value] of Object.entries(process.env)) {
    snapshot.set(key, value);
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!snapshot.has(key)) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot.get(key);
    }
  }
});

describe("dotenvCandidates", () => {
  it("lists the agent root .env first, then cwd walk-up without the filesystem root", () => {
    const candidates = dotenvCandidates("/tmp/refr-walk/sub");
    expect(candidates[0]).toMatch(/refractor-agent\/\.env$/);
    expect(candidates).toContain("/tmp/refr-walk/sub/.env");
    expect(candidates).toContain("/tmp/refr-walk/.env");
    expect(candidates).toContain("/tmp/.env");
    expect(candidates).not.toContain("/.env");
  });
});

describe("loadEnv", () => {
  it("loads KEY=VALUE pairs, skipping comments and non-pairs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-env-"));
    await writeFile(
      join(dir, ".env"),
      [
        "# comment line",
        "",
        "REFR_TEST_A=hello",
        "REFR_TEST_B=\"quoted value\"",
        "REFR_TEST_C='single'",
        "not a pair line",
        "REFR_TEST_D=trailing spaces   ",
      ].join("\n"),
      "utf8",
    );
    loadEnv(dir);
    expect(process.env.REFR_TEST_A).toBe("hello");
    expect(process.env.REFR_TEST_B).toBe("quoted value");
    expect(process.env.REFR_TEST_C).toBe("single");
    expect(process.env.REFR_TEST_D).toBe("trailing spaces");
  });

  it("never overrides pre-existing environment variables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-env-"));
    await writeFile(join(dir, ".env"), "REFR_TEST_E=from-file\n", "utf8");
    process.env.REFR_TEST_E = "from-env";
    loadEnv(dir);
    expect(process.env.REFR_TEST_E).toBe("from-env");
  });

  it("prefers the closer .env when walking up (cwd before parents)", async () => {
    const root = await mkdtemp(join(tmpdir(), "refr-env-"));
    const sub = join(root, "sub");
    await mkdir(sub);
    await writeFile(join(root, ".env"), "REFR_TEST_F=parent\n", "utf8");
    await writeFile(join(sub, ".env"), "REFR_TEST_F=sub\n", "utf8");
    loadEnv(sub);
    expect(process.env.REFR_TEST_F).toBe("sub");
  });
});
