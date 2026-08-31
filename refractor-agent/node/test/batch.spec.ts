import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  attemptLimit,
  classifyFailure,
  failureRecord,
  hashImages,
  runBatch,
  type BatchProcess,
} from "../src/batch.ts";
import { JobStore } from "../src/jobStore.ts";
import { VLMBusinessValidationError, VLMNetworkError } from "../src/vlm.ts";
import { forceLocalEmbedderEnv } from "./helpers.ts";

afterEach(() => forceLocalEmbedderEnv());

async function makeInput(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "refr-batch-in-"));
  for (const name of names) {
    const sub = join(dir, name);
    await mkdir(sub);
    await writeFile(join(sub, "front.jpg"), Buffer.from(`fake-image-${name}`));
    await writeFile(join(sub, "notes.txt"), "ignored");
  }
  return dir;
}

function okProcess(): BatchProcess {
  return async (task) => ({
    result: { itemId: task.id, refraction: "碎冰红", pattern: "碎冰", color: "红" },
    needsReview: false,
  });
}

describe("attemptLimit", () => {
  it("defaults to 3 and bounds 1..10 with fail-loud misconfiguration", () => {
    expect(attemptLimit()).toBe(3);
    process.env.BATCH_MAX_ATTEMPTS = "7";
    expect(attemptLimit()).toBe(7);
    process.env.BATCH_MAX_ATTEMPTS = "11";
    expect(() => attemptLimit()).toThrow(/between 1 and 10/);
    process.env.BATCH_MAX_ATTEMPTS = "abc";
    expect(() => attemptLimit()).toThrow(/must be an integer/);
    delete process.env.BATCH_MAX_ATTEMPTS;
  });
});

describe("classifyFailure", () => {
  it("routes business validation errors to review, never retried", () => {
    expect(classifyFailure(new VLMBusinessValidationError("bad"), 1, 3)).toEqual({
      status: "review_required",
      retryable: false,
    });
  });

  it("retries retryable VLM errors below the limit and terminates at it", () => {
    expect(classifyFailure(new VLMNetworkError("timeout"), 1, 3)).toEqual({
      status: "retryable_failed",
      retryable: true,
    });
    expect(classifyFailure(new VLMNetworkError("timeout"), 3, 3)).toEqual({
      status: "terminal_failed",
      retryable: false,
    });
  });

  it("treats unknown errors as terminal", () => {
    expect(classifyFailure(new Error("boom"), 1, 3)).toEqual({
      status: "terminal_failed",
      retryable: false,
    });
  });

  it("builds bounded structured failure records", () => {
    const record = failureRecord("A-1", 2, "retryable_failed", true, new VLMNetworkError("timeout"));
    expect(record).toMatchObject({
      itemId: "A-1",
      attempt: 2,
      status: "retryable_failed",
      errorCode: "provider_network_error",
      retryable: true,
    });
    expect((record.lastError as string).length).toBeLessThanOrEqual(500);
  });
});

describe("JobStore", () => {
  it("registers idempotently and claims in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"));
    const items = [
      { id: "a", path: "/tmp/a", inputHash: "ha" },
      { id: "b", path: "/tmp/b", inputHash: "hb" },
    ];
    expect(store.register(items)).toBe(2);
    expect(store.register(items)).toBe(0); // same content → no duplicates

    expect(store.claim("w1", 60000)).toMatchObject({ id: "a", attempt: 1 });
    expect(store.claim("w1", 60000)).toMatchObject({ id: "b" });
    expect(store.claim("w1", 60000)).toBeNull();
    store.close();
  });

  it("re-registers changed content as a new claimable row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"));
    store.register([{ id: "a", path: "/tmp/a", inputHash: "old" }]);
    const claimed = store.claim("w1", 60000);
    expect(claimed).not.toBeNull();
    store.complete(claimed as NonNullable<typeof claimed>, { ok: 1 }, false);
    store.register([{ id: "a", path: "/tmp/a", inputHash: "new" }]);
    expect(store.claim("w1", 60000)).toMatchObject({ id: "a", inputHash: "new" });
    store.close();
  });

  it("never double-claims across workers and reclaims expired leases", async () => {
    let now = 1000;
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"), { now: () => now });
    store.register([{ id: "a", path: "/tmp/a", inputHash: "ha" }]);

    expect(store.claim("w1", 50)).toMatchObject({ id: "a", attempt: 1 });
    now += 10; // lease still valid
    expect(store.claim("w2", 50)).toBeNull();
    now += 100; // lease expired → crashed worker reclaimed
    expect(store.claim("w2", 50)).toMatchObject({ id: "a", attempt: 2 });
    store.close();
  });

  it("skips done, review_required, and terminal_failed items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"));
    // ids chosen so alphabetical claim order matches the scenario order
    store.register([
      { id: "a-done", path: "/x", inputHash: "h1" },
      { id: "b-review", path: "/y", inputHash: "h2" },
      { id: "c-terminal", path: "/z", inputHash: "h3" },
      { id: "d-retryable", path: "/w", inputHash: "h4" },
    ]);
    const claimed1 = store.claim("w", 1000);
    store.complete(claimed1 as NonNullable<typeof claimed1>, {}, false);
    const claimed2 = store.claim("w", 1000);
    store.complete(claimed2 as NonNullable<typeof claimed2>, {}, true);
    const claimed3 = store.claim("w", 1000);
    store.fail(claimed3 as NonNullable<typeof claimed3>, "terminal_failed", "batch_error", "boom");
    // only the pending item is left; retryable_failed after cooldown is also claimable
    expect(store.claim("w", 1000)).toMatchObject({ id: "d-retryable" });
    expect(store.claim("w", 1000)).toBeNull();
    // needsReview items complete as done (review is an event + export, not a state)
    expect(store.stats()).toEqual({ done: 2, claimed: 1, terminal_failed: 1 });
    store.close();
  });

  it("makes duplicate completion a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"));
    store.register([{ id: "a", path: "/tmp/a", inputHash: "ha" }]);
    const claimed = store.claim("w1", 1000) as NonNullable<ReturnType<JobStore["claim"]>>;
    expect(store.complete(claimed, { v: 1 }, false).inserted).toBe(true);
    expect(store.complete(claimed, { v: 1 }, false).inserted).toBe(false);
    expect(store.results()).toHaveLength(1);
    store.close();
  });

  it("keeps an append-only event trail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refr-store-"));
    const store = new JobStore(join(dir, "job.sqlite3"));
    store.register([{ id: "a", path: "/tmp/a", inputHash: "ha" }]);
    const claimed = store.claim("w1", 1000);
    store.complete(claimed as NonNullable<typeof claimed>, {}, false);
    expect(store.events().map((event) => event.kind)).toEqual(["item-claimed", "item-completed"]);
    store.close();
  });
});

describe("runBatch orchestration", () => {
  it("processes ok, review, retryable, and terminal items with exports", async () => {
    const input = await makeInput(["ok-item", "review-item", "flaky-item", "bad-item"]);
    const work = await mkdtemp(join(tmpdir(), "refr-batch-out-"));
    let flakyCalls = 0;
    const process: BatchProcess = async (task) => {
      if (task.id === "review-item") {
        return { result: { itemId: task.id, refraction: "银折" }, needsReview: true };
      }
      if (task.id === "flaky-item") {
        flakyCalls += 1;
        if (flakyCalls === 1) throw new VLMNetworkError("timeout");
        return { result: { itemId: task.id, refraction: "金折" }, needsReview: false };
      }
      if (task.id === "bad-item") {
        throw new VLMBusinessValidationError("invalid enum");
      }
      return { result: { itemId: task.id, refraction: "碎冰红" }, needsReview: false };
    };

    let now = 1000;
    const first = await runBatch({
      input,
      work,
      process,
      attempts: 3,
      retryCooldownMs: 60000,
      now: () => now,
    });
    expect(first.ok).toBe(2); // ok-item + review-item (ok counts all successes, like Python)
    expect(first.review).toBe(2); // review-item + bad-item
    expect(first.fail).toBe(1); // flaky-item → retryable_failed with a 60s cooldown

    // after the cooldown passes, the next run retries flaky-item successfully
    now += 60000;
    const second = await runBatch({
      input,
      work,
      process,
      attempts: 3,
      retryCooldownMs: 60000,
      now: () => now,
    });
    expect(second.ok).toBe(1); // flaky-item succeeds on the retry
    expect(second.stats.done).toBe(3);
    expect(second.stats.review_required).toBe(1);

    const resultLines = (await readFile(join(work, "result.jsonl"), "utf8")).trim().split("\n");
    expect(resultLines).toHaveLength(3);
    const reviewLines = (await readFile(join(work, "review.jsonl"), "utf8")).trim().split("\n");
    expect(reviewLines).toHaveLength(3); // review result + bad record + flaky first failure
    const badRecord = JSON.parse(reviewLines.find((line) => line.includes("bad-item")) as string);
    expect(badRecord).toMatchObject({
      itemId: "bad-item",
      status: "review_required",
      errorCode: "business_validation_failed",
      retryable: false,
    });

    const db = new JobStore(join(work, "refractor.sqlite3"));
    const events = db.events().map((event) => event.kind);
    expect(events[0]).toBe("batch-start");
    expect(events[events.length - 1]).toBe("batch-done");
    expect(events).toContain("review-required");
    expect(events).toContain("item-failed");
    db.close();
  });

  it("recovers a crashed worker's lease without duplicating results", async () => {
    const input = await makeInput(["solo"]);
    const work = await mkdtemp(join(tmpdir(), "refr-batch-crash-"));
    const images = [join(input, "solo", "front.jpg")];
    const inputHash = await hashImages(images);

    // Simulate a worker that claimed the item and then died mid-flight.
    const crashed = new JobStore(join(work, "refractor.sqlite3"));
    crashed.register([{ id: "solo", path: join(input, "solo"), inputHash }]);
    crashed.claim("crashed-worker", 1);
    crashed.close();

    const summary = await runBatch({
      input,
      work,
      process: okProcess(),
      leaseMs: 60000,
    });
    expect(summary.ok).toBe(1);
    expect(summary.stats).toMatchObject({ done: 1 });

    // re-running the whole batch must not duplicate anything
    const again = await runBatch({ input, work, process: okProcess() });
    expect(again.ok).toBe(0);
    expect(again.registered).toBe(0);
    const db = new JobStore(join(work, "refractor.sqlite3"));
    expect(db.results()).toHaveLength(1);
    db.close();
    const resultLines = (await readFile(join(work, "result.jsonl"), "utf8")).trim().split("\n");
    expect(resultLines).toHaveLength(1);
  });

  it("never double-claims between two concurrent workers", async () => {
    const input = await makeInput(["a", "b", "c"]);
    const work = await mkdtemp(join(tmpdir(), "refr-batch-conc-"));
    const storeA = new JobStore(join(work, "refractor.sqlite3"));
    const storeB = new JobStore(join(work, "refractor.sqlite3"));
    const items = ["a", "b", "c"].map((name, index) => ({
      id: name,
      path: join(input, name),
      inputHash: `h${index}`,
    }));
    storeA.register(items);

    const claims = [storeA.claim("A", 60000), storeB.claim("B", 60000), storeA.claim("A", 60000), storeB.claim("B", 60000)];
    const ids = claims.map((claim) => claim?.id).filter(Boolean);
    expect(new Set(ids).size).toBe(3); // three distinct items
    expect(ids).toHaveLength(3);
    expect(claims.some((claim) => claim === null)).toBe(true); // nothing left
    storeA.close();
    storeB.close();
  });
});
