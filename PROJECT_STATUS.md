# dotuix — Project Status

**Last updated:** 2026-06-11
**Purpose:** Living status doc for future work. Pairs with [ASSESSMENT.md](ASSESSMENT.md)
(the original review). When you pick this up again, start here.

---

## 1. What dotuix is

A platform around the **`.uix` executable-document format**: a ZIP containing a
self-contained offline HTML/JS/CSS app + optional SQLite databases, opened by a
viewer (distribution story of PDF, interactivity of a native app). Spec:
[spec/spec.md](spec/spec.md) (v1.0).

### Repositories
- **Public (open source):** `github.com/dotuix/dotuix` → `/Volumes/data/new-projects/dotuix`
  - Packages (npm): `@dotuix/core`, `@dotuix/cli`, `@dotuix/types`, `@dotuix/ai`, `@dotuix/mcp`, `@dotuix/vite-plugin`
  - Desktop viewer: `apps/viewer` (Tauri, Rust + React) — ships via GitHub release installers
  - `templates/`, `demos/`, `spec/`
- **Internal (private):** `github.com/emadjumaah/dotuix-internal` → `/Volumes/data/new-projects/dotuix-internal`
  - `apps/view` (web viewer → view.dotuix.uts.qa, Vercel), `apps/studio`, `apps/mobile` (Expo),
    `apps/website`, `apps/mcp-server` (CapRover), `apps/sync-desktop` (Tauri)
  - `packages/sync-server`, `packages/vscode-extension`
  - `projects/` (demo starter projects), `plans/` (internal roadmap)

### Deploy / release mechanics (important)
- **npm packages:** `pnpm changeset version` → commit → `pnpm changeset publish` → push tags. Auth: `npm whoami` = `emadjumaah`.
- **Desktop viewer:** bump version in `apps/viewer/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}` + `apps/viewer/package.json`, commit, tag `vX.Y.Z`, push tag → `release-viewer.yml` builds mac/Linux/Windows installers.
- **Web viewer / studio / website:** **Vercel deploys only via GitHub** — push to internal `main` auto-deploys. Do NOT run the Vercel CLI.
- **MCP server:** `pnpm deploy:mcp` (CapRover). **Mobile:** Expo. **VS Code extension:** `extension-v*` tag.

---

## 2. Current published / released state (2026-06-11)

| Artifact | Version | Notes |
|---|---|---|
| `@dotuix/core` | **0.3.0** | Full bridge SDK. **Breaking** vs 0.2.x (insert/update return records; `export()`→`serialize()`). |
| `@dotuix/cli` | 0.2.0 | `info`/`validate --json`; encrypt `kdf`; e2e tests |
| `@dotuix/types` | 0.2.0 | spec-aligned |
| `@dotuix/mcp` | 0.2.6 | offline bundled spec; structured validate/info |
| `@dotuix/ai` | 0.1.5 | — |
| `@dotuix/vite-plugin` | 0.1.5 | mock bridge matches contract |
| Desktop viewer | **v0.3.21** | Windows fallback CSP (C6). Tag pushed; CI builds installers. |
| Web viewer (`apps/view`) | deployed on push | Trust gate + per-app CSP (C5) |

Both repos: **lint clean** (biome), **green builds**, all working trees in sync with origin.

### Test coverage
- `@dotuix/core`: **100** vitest · desktop viewer Rust: **35** `#[test]` · `@dotuix/cli`: **5** e2e · `sync-server`: **4** · `apps/mobile`: 4
- Public CI: `ci.yml` (lint + build + core/cli tests) + `desktop-contract-regression.yml` (Rust/build)

---

## 3. Done (assessment items closed)

**Critical:** C1 (core full bridge ✅) · C2 (epoch-ms timestamps ✅) · C3 (parseDuration units ✅) ·
C4 (signature interop — desktop now byte-matches core, +test ✅) · C5 (web-viewer trust gate + CSP ✅, *separate-origin sandbox pending*) · C6 (Windows CSP ✅, *$TEMP exposure documented*)

**High:** H2 (types↔spec ✅) · H3 (version drift ✅) · H4 (mcp version/info/validate ✅, internal path leak ✅, offline spec ✅, license documented in spec §12 ✅) · H5 (kdf floor 100000 ✅)

**Medium:** M1 (workspace deps — fixed cli/vite-plugin to `workspace:*` ✅) · M2 (encrypt kdf+atomic ✅) ·
M3 (init -t templates — **verified already working**, false positive ✅) · M4 (expiry date-time ✅) ·
M5 (print permission ✅) · M6 (screenshot content-protection ✅) · M8 (sync-server body cap + rate limit + tests ✅)

**Infra:** repo-wide biome lint clean + config (respects .gitignore, ignores dist/target/gen/generated; a11y/style opinions relaxed for kiosk context) · cross-package conformance via core(100)+rust(35) signature-format lock.

---

## 4. Remaining / next steps (prioritized)

### Security (the two deferred halves)
1. **C5b — separate-origin sandbox** for the web viewer. Today the iframe uses
   `allow-same-origin` because a SW-controlled iframe with an opaque origin
   isn't reliably SW-controlled. Real fix = serve apps from a **separate
   sandbox origin** (distinct/wildcard domain, DNS, TLS) so the app can't reach
   the viewer origin. Infra + staging test required — not an app-code edit.
2. **C6b — Windows `$TEMP` decrypted-content**. The fallback extracts decrypted
   files + `data.db` to `$TEMP`. Documented in `prepare_iframe_fallback_entry`.
   Fix = keep `encryptedPaths`/`data.db` out of temp and serve them via the
   in-memory `uix://` path even on Windows (needs Windows verification).

### Correctness (small, contained)
- **M7** — schema `onUpgrade` holds an EXCLUSIVE SQLite tx across async IPC (wedge risk). Not yet addressed; needs a careful redesign (buffer ops, or shorter lock).
- **M9** — signature is tamper-detection, not publisher auth (no key pinning). Documented; inherent to the opt-in model. Consider a trust-anchor/pinning scheme if publisher identity is needed.

### Testing / governance (highest leverage)
- **Cross-surface conformance harness** — the big recommendation. Run identical
  `.uix` fixtures through core/desktop/mobile/web and assert identical results.
  Partially covered (signature format locked across core↔rust; query/bundle in
  core's 100). A full fixture-driven harness across all four surfaces is still
  worth building (overlaps internal roadmap A-37).
- **More package tests** — `@dotuix/ai`, `@dotuix/mcp`, `@dotuix/vite-plugin` still have ~0 unit tests.
- **Internal CI** — wire `ci.yml`-style lint/test gate into the internal repo too (it only has component gates today).
- **Docs reconciliation (A-36)** — `docs/ROADMAP.md` is stale (e.g. test counts). `llms.txt` doesn't yet include spec §12 (license) — regenerate when convenient.

### Internal roadmap (ops)
- **A-32** pilot closeout · **A-35** CI gate unification (mostly exists via `release-readiness-gate.yml`) · **A-37** cross-surface regression matrix (see conformance harness above).

---

## 5. Key conventions & gotchas (so future-you doesn't relearn)
- **Inter-package deps use `workspace:*`** (pnpm rewrites to real versions on publish). cli/vite-plugin were on `^0.2.6` and silently used the *published* core — fixed.
- **`packages/cli/dist` is git-tracked** (ships templates). Biome ignores `**/dist/**`; the CLI build copies `templates/` → `dist/templates`. Rebuild cli after template edits.
- **The manifest contract is generated** from `dotuix-internal/packages/vscode-extension/contracts/manifest.contract.source.json` via `generate-contract-slice.mjs` → writes both repos' `generated/` files. Biome ignores `**/generated/**`.
- **Signature format is `DOTUIX-SIGN-V1`** (lines joined by `\n`, **no trailing newline**, excludes `manifest.json`+`state.db`). Identical across core/desktop/mobile/web — keep it that way (Rust test `signature_payload_matches_core_no_trailing_newline` guards it).
- **Timestamps are epoch-ms** everywhere. **Durations**: s/m/h/d/y (`m`=minutes).
- **`changeset version` writes un-formatted package.json** — run `biome check --write packages/*/package.json` after versioning or CI lint goes red.
- **Local cargo `target/release`** from a `tauri build` is large; safe to delete (CI builds releases).
