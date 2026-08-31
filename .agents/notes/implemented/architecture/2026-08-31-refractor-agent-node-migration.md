# Agent Note: refractor-agent runtime migrated to Node/TS

Status: implemented

## Problem

The refractor agent's runtime was a set of Python scripts the preset drove through a generic `bash` tool. Untrusted VLM output reached the matching layer after only a `json.loads` type check; the JSONL manifest state machine was not transactional (no lease, idempotency, or concurrency safety); `run_batch.py` re-invoked `match.py` through a subprocess boundary; and the preset was installed under `apps/cli/config/agent-presets/`, a directory no discovery root scans — the preset never actually appeared in the agent picker.

## Decision

The runtime is now TypeScript under `refractor-agent/node`: a VLM adapter with bounded retries and response-size caps, a validation firewall for model output (schema, controlled enums, registered pattern/color pairs, plain-card rules), pgvector/LanceDB stores with fingerprint self-healing, a SQLite job state machine (worker lease, idempotency keys, retry cooldown, append-only event trail), and four typed tools (`refractor_recognize`, `refractor_match`, `refractor_batch_run`, `refractor_batch_status`) bundled into a preset-carried function plugin (`node/dist/refractor-plugin.mjs`). Match runs in-process; the preset no longer mounts `tool-bash`. The preset installs at the real discovery root (`<DSH_HOME>/.agent-presets/refractor/`) and its plugin row is absolute, so installed copies resolve the built artifact regardless of location. The Python `scripts/` implementation is retired as a frozen reference, not deleted: it remains the arbitration baseline for disputed behavior.

## Alternatives considered

**Keep Python and harden it.** The DSH typed-tool surface (`ctx.tools.register`, `defineTool`, the guarded pipeline) is TypeScript, so a Python main path stays pinned to the bash/subprocess tier permanently. Lost for that reason, not because Python hardening is impossible.

**A formal `packages/` plugin package.** Resolves bare row names through the harness and carries the repo's package gates (per-file 100% coverage, REAL-composition tests, invariants). Lost for a deployment-local domain agent: the preset-carried plugin reaches the same model-visible surface through the documented preset-relative/absolute row mechanism without those gates.

**`packages/` bundle patch to inject the tools.** Same gate profile as a formal package plus a patch layer to maintain. Lost to the preset-carried plugin for this deployment.

## Consequences

The migration contract is the Python implementation's own behavior: 97 vitest tests including bit-identical local-embedder fixtures and a dictionary-fingerprint fixture, and a golden double-run where Python and TS produce semantically equal metrics, detail rows, and confusion matrices across thresholds. Exact byte-for-byte JSON parity was given up (float formatting differs); semantic equality is the contract.

Not ported yet: `evaluate --sweep` threshold calibration and top-k/margin candidate ranking (the Python reference still owns `--sweep`); tracked in `refractor-agent/README.md`. A live session mount is the remaining user-side check — discovery is fail-closed, so a broken mount shows with its reason in the agent picker rather than silently disappearing.
