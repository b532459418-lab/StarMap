# World store lab (archived)

Status: archived on 2026-10-12. Nothing on `main` uses this code.

## What it was

The experimental RD-08 G3 implementation: Node-only SQLite persistence for the
World Graph store (`scripts/world-store-*`), built in #49–#69. It covered
writable branches, a replayable merge DAG, Saved backup packages and restore,
expiring host sessions that authorize Merge Store writes, a read-only App
projection, and the `dev:repository-preview` development mode with its browser
suite. It ran only on synthetic data in temporary directories; the App and the
local editor never read or wrote through it.

## Where to find it

The complete code, its tests and its CI job are preserved, unchanged, at
commit `2fd9866` of `main`:

- tag [`world-store-lab-2026-10-12`](https://github.com/b532459418-lab/StarMap/tree/world-store-lab-2026-10-12)
- branch [`lab/world-store`](https://github.com/b532459418-lab/StarMap/tree/lab/world-store)

`main` keeps RD-08 G1 (`01_Web/src/worldgraph/store/`, the logical store
contract and reference implementation) and G2 (`01_Web/src/data/canonical/storeBridge*.ts`,
the read-only V2 bridge), with their tests.

## Why it was archived

- **Full-history replay on the everyday path.** The latest Merge Store replays
  the complete history on every read and write, so each operation costs more
  than the one before.
- **Hard row caps.** Several tables are limited to 128 rows, with no compaction
  or checkpoint path; once a store reaches a cap, further writes are refused.
- **Bounded restore ancestry.** Restore embeds each earlier archive by value, so
  the ancestor chain has a depth limit beyond which a writable store cannot be
  restored.
- **Different job.** The product needs a lean persistence layer for real App
  reads, writes, restarts and backup/restore, with explicit scale and
  reliability targets. Branching, merging and recursive history are not
  prerequisites for that, and multi-device sync will be planned on its own.

## Worth reusing

- The v2 host's split storage: a baseline, the current state and a compact
  operation history in separate tables that commit atomically
  (`world-store-repository-v2.mjs`).
- The fault-injection tests: bounded child workers pause at named write phases
  and are terminated there, and the tests then verify recovery or a clean
  refusal.
- Exclusive creation of new files and directories (never overwriting an
  existing destination) and backups that are validated and sealed before they
  count as complete.

## Next

Lean persistence for the World Graph store: design in progress.
