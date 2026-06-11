# @dotuix/mcp

## 0.2.6

### Patch Changes

- 69e9812: Full `uix` bridge SDK and a spec ⇄ types ⇄ runtime conformance/correctness pass.

  **@dotuix/core (note: breaking changes for direct API consumers)**

  - Implements the full bridge surface (spec §4.4–§4.5, §11): `where` operators
    (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`like`/`in`/`is_null`), `offset`, `orderBy`
    direction + array, `count`, `upsert`, `insertMany`, `transaction`, `clear`,
    `reset`, `size`, `vacuum`, `export` (JSON), `exportBundle`/`importBundle`.
  - `UIXStateDB.insert`/`update` now return the full record (were id/void).
  - Byte serialisation moved from `export()` to `serialize()` (so `export()` can
    return the spec's JSON record string).
  - Timestamps are stored as epoch **milliseconds** (were seconds).
  - `parseDuration`: `m` = minutes, added `s` = seconds (was `m` = 30 days).
  - `kdfIterations` minimum raised 10000 → 100000 (spec §6.1).

  **@dotuix/types** — aligned to the spec: `update`/`file.save`/`notify`/`export`/
  `sync`/`orderBy` signatures; `manifest()` documented synchronous.

  **@dotuix/cli** — `info`/`validate --json` structured output; `encrypt` writes
  `kdf` (not `kdfAlgorithm`) and writes atomically.

  **@dotuix/mcp** — server version read from package.json; `validate`/`info` use the
  CLI's structured `--json` output.

  **@dotuix/vite-plugin** — dev mock bridge matches the contract (`where` operators,
  `insertMany`/`size`/`file.save`/`file.open` shapes).

- Updated dependencies [69e9812]
  - @dotuix/core@0.3.0
  - @dotuix/cli@0.2.0

## 0.2.5

### Patch Changes

- Harden archive extraction and generated file writes against traversal, absolute paths, Windows drive paths, and normalized path escapes.
- Updated dependencies
  - @dotuix/core@0.2.4
  - @dotuix/cli@0.1.7
