# dotuix — Project Assessment

**Date:** 2026-06-11
**Reviewer:** Claude (code + architecture review)
**Scope:** Both repositories
- `dotuix` (public, open-source): `/Volumes/data/new-projects/dotuix`
- `dotuix-internal` (private): `/Volumes/data/new-projects/dotuix-internal`

This is a fresh, code-verified review. Findings were checked against the actual source, not against the existing `plans/DOTUIX_ARCHITECTURE_ASSESSMENT.md` (dated 2026-05-22), which is now partly stale.

---

## 1. Executive Verdict

**Overall: GO for continued development / private pilots — NO-GO for a clean public "spec-compliant" open-source release in current state.**

dotuix is a genuinely ambitious and largely *real* platform — not vaporware. The `.uix` format (a ZIP carrying a self-contained offline HTML/JS app + SQLite, opened by a viewer, with the distribution story of PDF) is a coherent, well-specified idea. The desktop viewer's security core (Ed25519 signatures, AES-GCM/PBKDF2 decryption, per-manifest CSP, SQL-injection-hardened query builder), the hosted MCP server, and the LAN sync v2 protocol are all properly engineered with real tests.

The blocker is **not** the architecture. It is **conformance and consistency**: the published spec, the TypeScript types, the open-source `@dotuix/core` runtime, and the actual viewer implementations have drifted apart. The project ships a CC-BY spec that claims "a compliant packer/viewer MUST…", but the reference open-source packages do not themselves implement large parts of that spec. For a project whose entire value proposition is *a portable, interoperable format*, that gap is the central risk.

### Maturity scorecard (verified)

| Area | Maturity | Notes |
|---|---|---|
| `.uix` format spec | **Strong** | Well-written, RFC-2119, versioned. But contradicts itself on timestamp units and signature digest. |
| Desktop viewer (Tauri) — security core | **Strong** | Signatures, encryption, CSP, permission gating, SQLi hardening all real + tested. |
| Desktop viewer — Windows render path | **Weak / fragile** | Bypasses `uix://` + per-manifest CSP; extracts full archive to `$TEMP`. |
| `@dotuix/core` (npm runtime) | **Medium-Low** | Missing most of the spec'd `uix.state.*`/`uix.data.*` surface; timestamp/duration bugs. |
| CLI / AI / MCP / vite-plugin packages | **Medium** | Functional, but version drift, broken `info` MCP tool, zero tests. |
| Hosted MCP server (internal) | **Strong** | Body limits, rate limiting, quota/TTL, path-traversal guard. No tests. |
| LAN sync server + protocol | **Medium-High** | Sound HMAC v2 + replay protection. No unit tests, no body-size cap. |
| Mobile viewer (Expo) | **Medium-High** | Best trust parity of the viewers (sig/minViewer/license/PIN + CSP). |
| Web viewer (`apps/view`) | **Weak (security)** | No trust gating, escapable iframe sandbox, no CSP/network enforcement. |
| Studio (browser authoring) | **Medium** | Large, real; lower risk (doesn't run untrusted code in iframe). |
| CI / quality gates | **Mixed** | Internal has a real unified gate; public has no lint/typecheck/secret gate. |
| Test coverage | **Thin** | Concentrated in core (74) + viewer Rust (31). ~11 packages have zero tests. |
| Docs governance | **Drifting** | Roadmaps stale; spec/types/runtime disagree. |

---

## 2. What the project is (for context)

A monorepo platform around the `.uix` executable-document format:

- **Open-source layer** (`dotuix`): the format spec, the `@dotuix/*` npm toolchain (`core`, `cli`, `types`, `ai`, `mcp`, `vite-plugin`), templates, demos, and the Tauri desktop viewer.
- **Private layer** (`dotuix-internal`): hosted services (MCP endpoint, LAN sync server), the web viewer, browser studio, Expo mobile viewer, marketing website, VS Code extension, a sync desktop app, and internal demo projects.
- **Live endpoints:** `dotuix.uts.qa` (site), `view.dotuix.uts.qa` (web viewer), `mcp.dotuix.uts.qa` (hosted MCP).

---

## 3. Critical Issues (must fix before public release)

### C1 — Spec ⇄ open-source runtime conformance is broken
The spec (`spec/spec.md` §4.4–§4.18) defines a rich bridge API. The desktop viewer (Rust) implements it well, but the **open-source `@dotuix/core` SDK does not**:
- `packages/core/src/db.ts` `buildFindQuery` ignores `offset`, supports only string `orderBy` (no direction/array form), and supports only scalar equality in `where` — none of the spec's `gte`/`in`/`like`/`is_null` operators (§4.4).
- `UIXStateDB` is missing `count`, `upsert`, `insertMany`, `transaction`, `clear`, `reset`, `size`, `vacuum`, `exportBundle`/`importBundle`, `sync` (§4.5). `insert` returns just an id string, not the full record the spec mandates.

**Impact:** anyone building "to the open-source reference" gets a runtime that silently doesn't match the published, normative spec. This undermines the format's interoperability claim.

### C2 — Timestamp unit contradiction (spec + code)
- Spec §3.1/Appendix B mandate `created_at`/`updated_at` in **epoch milliseconds**, but spec §3.2 prose calls them "Unix timestamp (milliseconds)" while the DDL in some places and `core/src/db.ts:60-61` uses `unixepoch()` (**seconds**). The 2026-05-22 internal assessment (H3) flagged the spec self-contradiction; it is still present, and core's DDL makes it a real data bug.
- **Impact:** creator-packed `data.db` timestamps are in seconds; viewer/state timestamps in ms. Ordering, `purge`, and `before` filters silently misbehave across the boundary.

### C3 — `parseDuration` bug in core (`db.ts:163`)
The regex maps `m` → **30 days** ("months"), and has no `s` (seconds) unit. Spec §4.18 defines `m` = **minutes** and `s` = seconds. The vite-plugin dev mock interprets `m` as minutes — so dev and production disagree.
- **Impact:** `uix.state.purge({ olderThan: "5m" })` deletes records older than 5 *months* in core, 5 *minutes* in dev mock. Actively wrong and data-destructive.

### C4 — Signature digest does not match spec §7
Spec §7 defines the signed payload as a JSON object `{ "<path>": "<hex-sha256>" }` over all files except `manifest.json`. The implementations (`core/src/sign.ts`, mobile `securityGateCore.ts`, desktop) use a different `DOTUIX-SIGN-V1` line format and also exclude `state.db`.
- **Impact:** the implementation is internally consistent (and arguably better — excluding mutable `state.db` is sensible), but a third-party verifier built to the *published spec* will reject these signatures and vice-versa. Either fix the spec to match the implementation, or fix the implementation. (Recommend updating the spec — the implementation choice is the better one.)

### C5 — Web viewer (`apps/view`) has no trust enforcement and an escapable sandbox
- No Ed25519 signature / `minViewer` / `expires` / `maxOpens` / PIN / license checks anywhere (`apps/view/src/`).
- The `.uix` app is served from the **viewer's own origin** via service worker and rendered with `sandbox="allow-scripts allow-same-origin"` — a documented non-sandbox; the untrusted app runs same-origin and can reach parent storage/cookies/SW.
- No CSP header on SW responses → `manifest.network: "blocked"` is unenforceable in the browser.
- **Impact:** the publicly-advertised web viewer is the weakest link. A tampered/expired `.uix` opens silently, and a hostile app can escape. This is partly inherent to browsers, but the viewer makes *no* attempt where mobile does.

### C6 — Windows desktop render path bypasses the per-manifest CSP
On Windows the viewer forces a temp-file fallback as the **primary** path (`App.tsx:264`), extracting the **entire archive (including decrypted PIN-protected files and `data.db`) to `$TEMP`** and loading via `asset.localhost`. This path does **not** apply the per-manifest CSP header (`lib.rs:4157` fires only for `uix://`).
- **Impact:** on Windows (the default for many users), `network: "blocked"` is enforced only by the global shell CSP, not per-app; and decrypted sensitive content lands on disk with best-effort cleanup. ~10 recent `fix(viewer)` commits show this path is fragile. Highest-severity desktop item.

---

## 4. High-Priority Issues

### H1 — Mobile/desktop trust parity is good; web viewer is the outlier
Desktop and mobile both enforce signature/minViewer/expiry/maxOpens/PIN (mobile via `useSecurityGate.ts`, desktop via `lib.rs`). The 2026-05-22 assessment's claim that "mobile trust parity is incomplete" is now **outdated** — mobile is at parity. The real gap is the **web viewer** (see C5).

### H2 — TypeScript types drift from spec (and sometimes from core)
`packages/types/index.d.ts`: `update()` typed `void` (spec returns record), `file.save()` typed `void` (spec returns boolean), `export.before` typed `number` (spec: ISO string), `notify()` missing 3rd options arg, `manifest()` typed sync (spec: Promise), `orderBy` missing array form, `sync()` has undocumented `serverTime`. Also `state.mode` and `schemaVersion` exist in types but are dropped by core's Zod schema.
- **Impact:** generated apps compile against contracts that don't reflect runtime truth.

### H3 — Version / provenance drift
- `VIEWER_VERSION` hardcoded `"1.0.0"` in `lib.rs:13` while the real build is `0.3.20` (`tauri.conf.json`). `uix.viewer.version()` and `minViewer` gating both use the wrong number.
- MCP server name/version hardcoded `0.1.0` (`mcp/src/index.ts:53`) vs package `0.2.5`.
- Internal repo has **two workspace packages both named `dotuix`** (root and `vscode-extension`).

### H4 — Broken / undocumented surfaces in published packages
- `@dotuix/mcp` `info` tool calls `dotuix info --json`, but the CLI has no `--json` flag → returns colorized human text, useless programmatically.
- `@dotuix/mcp` `validate` infers validity by string-matching `"error"`/`"invalid"` in stdout — brittle.
- `@dotuix/mcp` `get_spec` **fetches a remote URL** at call time — contradicts the "fully offline" premise.
- A **license/DRM system** (`issue-license`, `device-id`, `.uixlicense`, `license` manifest block) ships in the open-source CLI/types but is **absent from the public spec**. Undocumented surface in supposedly open-source packages.
- `core/src/generated/manifest-contract.generated.ts` hardcodes an **internal repo path** (`../dotuix-internal/...`) shipped in `dist` — leaks the private monorepo layout.

### H5 — `kdfIterations` floor is 10000 in core, spec requires 100000
`manifest.ts` / generated contract enforce a 10000 minimum; spec §6.1 says MUST NOT be < 100000. A weak-KDF manifest validates clean — a security regression vs the spec.

---

## 5. Medium-Priority Issues

- **M1 — `workspace:*` deps in `@dotuix/ai` and `@dotuix/mcp`** `package.json` will break `npm install` of published tarballs unless the release pipeline rewrites them. Publish blocker if unhandled.
- **M2 — CLI `encrypt`** writes `kdfAlgorithm` (spec field is `kdf`) and is non-atomic (`writeFileSync` over the original — crash corrupts the file).
- **M3 — `dotuix init -t restaurant|catalog|portfolio`** appears to reference unbuilt template dirs; likely a broken path.
- **M4 — Expiry is date-only** on desktop (`today_iso` returns `YYYY-MM-DD`), so same-day timed expiry isn't enforced until the next day. Spec §2.3 specifies a date-*time*.
- **M5 — `uix.print()` ignores the `"print"` permission** on desktop (spec §4.7 MUST).
- **M6 — `screenshot: false` (spec §6.1) is unimplemented** on desktop.
- **M7 — Schema `onUpgrade` holds an `EXCLUSIVE` SQLite transaction open across multiple async IPC round-trips** — wedge risk if the app hangs/closes mid-upgrade.
- **M8 — sync-server has no body-size cap and no rate limiting** (`c.req.json()` buffers unbounded). HMAC auth is sound, but oversized POSTs are a DoS vector.
- **M9 — Signature is tamper-detection only, not publisher authentication** — the manifest embeds its own `publicKey` with no trust anchor/pinning. Correct per spec, but "signature valid" must never be shown to users as "trusted publisher."

---

## 6. Test, CI & Tooling Health

- **Real unit coverage exists only in `@dotuix/core` (74 tests, passing) and the viewer Rust (31 tests).** Zero-test packages: cli, ai, mcp, types, vite-plugin (public); sync-server (smoke-only), mcp-server, vscode-extension, studio, view, website, sync-desktop (internal). Mobile has 4.
- **`pnpm -w lint` is RED in the public repo** — `biome check` reports ~1500 formatting errors. Lint is **not gated in CI**, which is why it drifted. Mostly auto-fixable (`biome check --fix`).
- **Public CI has no lint, typecheck, or secret-scanning gate.** Only `desktop-contract-regression.yml` (PR gate) and `release-viewer.yml`. The internal repo has the real unified `release-readiness-gate.yml` (which even validates the public repo) plus gitleaks in two places.
- **Changesets configured in public but never wired to a publish workflow** — npm publishing is manual/local only.
- **Roadmaps are stale:** both `ROADMAP.md` files claim "24 Rust tests" (actual: 31) and list already-implemented CI unification (A-35) as pending.
- **Secrets: clean.** `dotuix-key.priv` exists on disk in both repos but is correctly gitignored (`*.priv`, `dotuix-key.*`) and absent from git history. (Note: an earlier worry that it was committed in the public repo is **false** — verified via `git ls-files` and history scan.) The one real gap is that the **public repo lacks a secret-scan CI workflow** as defense-in-depth against a future accidental commit.

---

## 7. Strengths (keep / don't regress)

- **Path-traversal hardening** (`core/src/paths.ts` `resolveSafeChild`, plus `validate_identifier` in the viewer) is genuinely solid, consistently applied across core/ai/mcp, and tested (covers `..`, absolute, UNC, drive-letter, backslash, NUL).
- **Desktop crypto** — Ed25519 verification, AES-256-GCM + PBKDF2, per-manifest CSP injection — is correctly implemented and (partly) tested.
- **SQL-injection hardening** in the viewer query builder is parameterized and unit-tested (16 `build_where_clause` cases incl. injection rejection).
- **LAN sync v2** — HMAC-signed request/response, `timingSafeEqual`, clock-skew window, nonce replay protection, v2-only default with explicit legacy opt-in — is a sound design.
- **Hosted MCP server** — body-size limits, per-IP rate limiting, store quota + TTL eviction, traversal guard; does not shell out or write user files.
- **Atomic writes** in pack/sign/import and the desktop repack-on-close (`.tmp`→rename).
- **Mobile is the most complete viewer** for trust enforcement.

---

## 8. Gaps Summary (what's missing)

1. **A conformance test suite** that runs the *same* `.uix` fixtures through core, desktop, mobile, and web and asserts identical behavior. This is the single highest-leverage missing piece — it would have caught C1–C4, H1, H2 automatically.
2. **Web viewer trust + sandbox story** — currently absent.
3. **Windows render path** that preserves the CSP/encryption guarantees (or a documented, accepted security downgrade).
4. **Tests** for: CLI, the npm bridge SDK, sync-server crypto, MCP servers, and any frontend.
5. **Public-repo CI gates**: lint, typecheck, secret-scan, and a wired npm-publish pipeline.
6. **Spec ⇄ types ⇄ core single source of truth** — generate types and the manifest contract from one canonical schema.
7. **Documentation for the license/DRM surface**, or its removal from open-source packages.
8. **Roadmap/governance reconciliation** — docs currently lag and contradict code.

---

## 9. Recommended Priority Sequence

**Phase 1 — Conformance & correctness (release-blocking)**
1. Fix `parseDuration` (`m`=minutes, add `s`) — C3. *(small, data-safety critical)*
2. Resolve the timestamp-unit contradiction end-to-end (pick ms, fix core DDL + spec prose) — C2.
3. Reconcile the signature digest: update spec §7 to match the implementation — C4.
4. Decide the conformance posture for `@dotuix/core`: either implement the full bridge surface or clearly document core as a "packer/validator, not a full runtime SDK" — C1.
5. Align `packages/types` to the spec and generate it from one schema — H2.

**Phase 2 — Security hardening**
6. Web viewer: add signature/expiry/maxOpens gating; harden the iframe (cross-origin sandbox or a dedicated origin); inject CSP — C5.
7. Windows desktop: apply per-manifest CSP on the fallback path; avoid extracting decrypted content to `$TEMP` or document the trade-off — C6.
8. Enforce `"print"` permission; implement or formally drop `screenshot:false`; raise `kdfIterations` floor to 100000 — M5, M6, H5.
9. sync-server: add body-size cap + rate limiting; add unit tests for the HMAC/nonce/skew logic — M8.

**Phase 3 — Governance & DX**
10. Fix version drift: `VIEWER_VERSION`, MCP server version, duplicate `dotuix` package name — H3.
11. Remove the internal-path leak in the generated contract; document or remove the license/DRM surface — H4.
12. Public-repo CI: add lint + typecheck + gitleaks gates; run `biome check --fix`; wire the changesets publish workflow.
13. Add the cross-surface conformance fixture suite — Gap #1.
14. Reconcile roadmaps with code reality.

---

## 10. Bottom Line

**Go/No-Go:**
- **Continued development & private/LAN pilots: GO.** The foundation is strong and the hard security primitives are real.
- **Public open-source release positioned as "the reference, spec-compliant implementation": NO-GO** until Phase 1 (conformance) and the public-repo CI/lint gaps are closed.
- **Public web viewer as a trusted way to open arbitrary `.uix` files: NO-GO** until C5 is addressed; today it should be treated as a preview for trusted content only.

The work remaining is mostly **convergence and hardening, not invention** — which is the good kind of remaining work. The biggest structural fix is establishing a single source of truth (spec ⇄ types ⇄ core ⇄ viewers) backed by a shared conformance test suite, so these four surfaces can never silently drift again.
