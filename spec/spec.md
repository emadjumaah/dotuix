# The .uix Executable Document Format

**Specification Version:** 1.0
**Status:** Stable
**Published:** 2026-05-20
**License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
**Repository:** https://github.com/dotuix/dotuix
**Canonical URL:** https://dotuix.uts.qa/llms.txt

---

## Abstract

`.uix` is a portable executable document format. A `.uix` file is a standard ZIP
archive containing a self-contained HTML/JS/CSS application, optional static assets,
and optional SQLite databases. A compliant viewer opens the file fully offline with
no network connection, no installation step beyond the viewer itself, and no server.

The format combines the distribution story of PDF (single file, viewer pre-installed)
with the interactivity of a native application and the authoring simplicity of HTML.

---

## Status of This Document

This document defines the `.uix` format version 1.0. It is the normative specification
for all conforming implementations.

This specification is published under Creative Commons Attribution 4.0 International.
Anyone may implement a compliant viewer, packer, or editor without permission, provided
attribution is given to the dotuix project.

---

## Conformance

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this
document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A **compliant packer** is software that produces `.uix` files conforming to this spec.
A **compliant viewer** is software that opens `.uix` files conforming to this spec.
A **conformant file** is a `.uix` file that satisfies all MUST requirements in this spec.

---

## 1. Container Format

### 1.1 Archive

A `.uix` file MUST be a valid [ZIP](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)
archive (PKWARE ZIP, version 2.0 or later). The archive MUST NOT be encrypted at the
ZIP level — encryption is handled at the application layer (see §7).

A `.uix` file MUST contain at minimum:

- `manifest.json` — the application manifest (see §2)
- The entry HTML file declared in `manifest.entry`

### 1.2 Compression Rules

| File type                                                                                   | Compression method |
| ------------------------------------------------------------------------------------------- | ------------------ |
| `.html`, `.css`, `.js`, `.json`, `.txt`, `.svg`, `.xml`                                     | DEFLATE            |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.mp4`, `.mp3`, `.woff`, `.woff2`, `.otf`, `.ttf` | STORE              |
| `data.db`, `state.db`                                                                       | STORE              |
| All other files                                                                             | DEFLATE            |

Binary files and SQLite databases SHOULD be stored uncompressed (STORE). Applying
DEFLATE to already-compressed binary data wastes CPU and increases file size.

### 1.3 Conventional Directory Layout

The following layout is RECOMMENDED but NOT REQUIRED. Files MAY be placed anywhere
in the archive and are referenced by path relative to the entry HTML file.

```
myapp.uix  (ZIP archive)
├── manifest.json       ← REQUIRED
├── index.html          ← entry point (declared in manifest.entry)
├── app.js
├── style.css
├── assets/             ← RECOMMENDED: images, video, audio, fonts
├── files/              ← RECOMMENDED: PDFs, CSVs, JSON, other embedded files
├── data.db             ← OPTIONAL: read-only SQLite (creator content)
└── state.db            ← OPTIONAL: SQLite seed (copied as user state on first open)
```

A validator MAY emit a warning (not an error) when media files are found outside `assets/`.

---

## 2. Manifest

### 2.1 Location and Encoding

The file `manifest.json` MUST be present at the root of the archive.
It MUST be valid JSON encoded as UTF-8.

### 2.2 Required Fields

| Field     | Type   | Description                                                                                                                                                                                    |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uix`     | string | Format version. MUST be `"1.0"` for files conforming to this specification.                                                                                                                    |
| `id`      | string | Reverse-domain application identifier, e.g. `"com.example.myapp"`. MUST be stable across versions of the same application. Used for state isolation. No DNS ownership is asserted or required. |
| `name`    | string | Human-readable application name. MUST NOT be empty.                                                                                                                                            |
| `version` | string | Application version. SHOULD follow [Semantic Versioning 2.0](https://semver.org/).                                                                                                             |
| `entry`   | string | Path to the entry HTML file inside the archive, relative to the archive root, e.g. `"index.html"`. The named file MUST exist in the archive.                                                   |
| `mode`    | string | `"kiosk"` — locked display, no address bar, no context menu, no developer tools. `"window"` — windowed display with viewer toolbar and developer tools. MUST be one of these two values.       |

### 2.3 Optional Fields

| Field           | Type         | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minViewer`     | string       | none        | Minimum viewer version (SemVer) required to open this file. A compliant viewer MUST refuse to open the file and display a clear message if its version is below `minViewer`.                                                                                                                                                                                                                                                                                                             |
| `permissions`   | string[]     | `[]`        | Capabilities this application requires. See §2.4.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `network`       | string       | `"blocked"` | `"blocked"` — the viewer MUST enforce a Content Security Policy that blocks all external network requests. `"allowed"` — external requests are permitted.                                                                                                                                                                                                                                                                                                                                |
| `theme`         | object       | none        | Viewer chrome colours: `color` (hex string) and `background` (hex string).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `author`        | string       | none        | Creator identity — email address or display name.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `expires`       | string\|null | null        | ISO 8601 date-time string. If present and non-null, a compliant viewer MUST check the expiry **before extracting any content**. If the current time is past `expires`, the viewer MUST refuse to open the file and MUST NOT display any of its content.                                                                                                                                                                                                                                  |
| `state.mode`    | string       | `"file"`    | `"file"` — the viewer MUST write the updated `state.db` back into the archive on close (see §3.4). The archive carries user state and MAY be forwarded as a self-contained document. `"device"` — state is stored exclusively in the viewer's application-data directory, keyed by `manifest.id`. The viewer MUST NOT write `state.db` back into the archive. The archive remains byte-for-byte identical after any number of opens and is safe to distribute without leaking user data. |
| `state.seed`    | boolean      | false       | If `true`, the `state.db` file in the archive is a creator-provided seed. On the first open of a new installation, the viewer MUST copy the archive's `state.db` to the user's state store as the initial state. On subsequent opens the user's persisted state is used, not the archive copy.                                                                                                                                                                                           |
| `schemaVersion` | integer      | `1`         | Data schema version. Increment this integer whenever the structure of records stored in `state.db` changes. On every open the viewer compares this value to the version stored in the user's `state.db`. If they differ the upgrade context is made available via `uix.schema.onUpgrade()`. See §4.18.                                                                                                                                                                                   |
| `sync`          | object       | none        | Sync configuration. `sync.secret` (string, base64 shared secret) is REQUIRED when `"local-sync"` is declared. `sync.endpoint` (string, HTTP(S) URL) is OPTIONAL; when omitted, the viewer MAY auto-discover a LAN Sync Hub host (typically port `3131`).                                                                                                                                                                                                                                 |
| `security`      | object       | none        | Optional PIN authentication and encryption. See §6.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `signature`     | object       | none        | Optional Ed25519 integrity signature. See §7.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ai`            | object       | none        | Optional AI provenance metadata. See §8.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 2.4 Permissions

An application MUST declare a permission in `manifest.permissions` before the viewer
exposes the corresponding capability. Undeclared capabilities MUST be silently blocked.

| Permission value    | Capability granted                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"local-storage"`   | Browser `localStorage` read/write access                                                                                                                       |
| `"print"`           | System print dialog via `uix.print()`                                                                                                                          |
| `"clipboard-write"` | Clipboard write access via `uix.clipboard.write()`                                                                                                             |
| `"fullscreen"`      | Fullscreen API via `uix.fullscreen.enter/exit/toggle()`                                                                                                        |
| `"raw-sql"`         | `uix.data.raw()` and `uix.state.raw()` — arbitrary SQL                                                                                                         |
| `"file-save"`       | Save files to the user's disk via `uix.file.save()`                                                                                                            |
| `"file-open"`       | Open files from the user's disk via `uix.file.open()`                                                                                                          |
| `"open-url"`        | Open a URL in the system browser via `uix.browser.open()`                                                                                                      |
| `"notifications"`   | OS-level notifications via `uix.notify()`                                                                                                                      |
| `"local-sync"`      | Sync `state.db` records with an external server via `uix.state.sync()`. Requires `sync.secret` and either `sync.endpoint` or a discoverable LAN Sync Hub host. |

---

## 3. Databases

### 3.1 Schema

Both `data.db` and `state.db` use an identical SQLite schema. A compliant packer
MUST create both databases with exactly this schema:

```sql
CREATE TABLE records (
  id         TEXT    PRIMARY KEY,
  type       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX idx_type       ON records (type);
CREATE INDEX idx_created_at ON records (created_at);
```

`state.db` additionally contains a `meta` table created by the viewer on first open:

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

The viewer SHOULD use the `meta` table to store internal metadata (e.g. open count,
first-open timestamp). Applications MUST NOT read or write to `meta` directly unless
`"raw-sql"` permission is declared.

### 3.2 Field Semantics

- **`id`** — Application-defined primary key. RECOMMENDED convention: `"type:identifier"`, e.g. `"product:001"`, `"cart_item:a1b2c3d4"`. MUST be unique within a database.
- **`type`** — Application-defined record category. Used as the primary query dimension.
- **`body`** — Application-defined data payload. MUST be a valid JSON string. The viewer stores and returns it without inspecting its contents.
- **`created_at`** — Unix timestamp (milliseconds, epoch ms). Set by the viewer on insert. MUST NOT be changed by subsequent updates.
- **`updated_at`** — Unix timestamp (milliseconds, epoch ms). Set by the viewer on insert and updated on every `update` call.

### 3.3 Database Roles

**`data.db`** is creator-owned and read-only at runtime. It is packed into the `.uix`
by the creator and MUST NOT be modified after distribution. The viewer MUST open it
read-only and expose it through the `uix.data` bridge.

**`state.db`** is user-owned and writable at runtime. The viewer maintains one
`state.db` per application ID, persisted on the user's device. Applications read and
write it through the `uix.state` bridge. If `manifest.state.seed` is `true`, the
viewer MUST bootstrap the user's state from the archive copy on first open.

The viewer SHOULD open `state.db` with WAL journal mode (`PRAGMA journal_mode=WAL`)
and INCREMENTAL auto-vacuum (`PRAGMA auto_vacuum=INCREMENTAL`) to improve write
concurrency and allow space reclamation via `uix.state.vacuum()`.

The two state storage modes are mutually exclusive:

| `state.mode`         | State storage                               | Archive modified on close | Typical use                                                        |
| -------------------- | ------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `"file"` _(default)_ | Viewer app-data dir + repacked into archive | Yes                       | Forms, reports, documents that travel with their data              |
| `"device"`           | Viewer app-data dir only                    | **No**                    | Apps distributed to many users; archive is always a clean template |

### 3.4 Atomic Write on Close

When `manifest.state.mode` is `"file"` (or absent), the viewer MUST write the updated
`state.db` back into the archive atomically on close. A partial write MUST NOT leave
the archive in a corrupted state. The RECOMMENDED implementation is to write to a
`.uix.tmp` file and rename it over the original on success.

When `manifest.state.mode` is `"device"`, the viewer MUST NOT write `state.db` back
into the archive. The archive on disk is never modified after the initial open.

---

## 4. Runtime Bridge API

### 4.1 Injection

A compliant viewer MUST inject a bridge object as `window.__uix` into the application's
webview or iframe before the entry document's scripts execute. The viewer MUST also
expose it as `window.uix` (an alias). Applications SHOULD use `uix` (without the double
underscore) as the preferred form.

The bridge MUST NOT be accessible outside the running `.uix` application.

### 4.2 Bridge Method Return Values

Every bridge method that performs I/O is asynchronous and returns a `Promise`.
Applications MUST `await` such calls or handle them with `.then()`.

The following accessors are **synchronous** (they read values already known at
load time and return them directly, not a `Promise`): `uix.manifest()`,
`uix.viewer.version()`, `uix.schema.version()`, `uix.schema.storedVersion()`,
and `uix.schema.needsUpgrade()`.

### 4.3 `uix.manifest()`

Returns the parsed `manifest.json` as a plain JavaScript object. **Synchronous** —
the value is available at load time, so no `await` is required.

```
uix.manifest() → object
```

### 4.4 `uix.data` — Read-Only Data Bridge

Provides access to `data.db`. All methods are read-only. Write operations MUST be
silently rejected or throw an error.

#### `uix.data.find(query)`

Returns all records matching `query` as an array. MUST return an empty array (not null
or undefined) when no records match.

```
uix.data.find({
  type: string,                              // REQUIRED — filters WHERE type = ?
  where?: Record<string, unknown>,           // OPTIONAL — additional json_extract filters
  orderBy?: string
          | { field: string, direction: "asc" | "desc" }
          | Array<{ field: string, direction: "asc" | "desc" }>,
  limit?: number,
  offset?: number,                           // skip N rows (for pagination)
}) → Promise<Record[]>
```

**`where` operators:** Each value in `where` is either a plain scalar (shorthand for
equality) or an operator object where **the key is the operator name** and the value
is the operand. Example: `{ price: { gte: 10 }, tags: { in: ["a", "b"] } }`.

| Operator key | SQL equivalent            | Notes                                   |
| ------------ | ------------------------- | --------------------------------------- |
| _(scalar)_   | `= ?`                     | Shorthand: `{ field: value }`           |
| `eq`         | `= ?`                     | Explicit equality                       |
| `neq`        | `!= ?`                    |                                         |
| `gt`         | `> ?`                     |                                         |
| `gte`        | `>= ?`                    |                                         |
| `lt`         | `< ?`                     |                                         |
| `lte`        | `<= ?`                    |                                         |
| `like`       | `LIKE ?`                  | `%` wildcards must be in value          |
| `in`         | `IN (?, ?, …)`            | Operand MUST be an array                |
| `is_null`    | `IS NULL` / `IS NOT NULL` | `true` = IS NULL, `false` = IS NOT NULL |

**`orderBy` forms:** A string (shorthand for `{ field, direction: "asc" }`), a single
`{ field, direction }` object, or an array of such objects for multi-field ordering.

`orderBy` as a string is shorthand for `{ field: string, direction: "asc" }`.

#### `uix.data.get(id)`

Returns the single record with the given `id`, or `null` if not found.

```
uix.data.get(id: string) → Promise<Record | null>
```

#### `uix.data.count(query)`

Returns the total number of records matching `query` without fetching them.
Accepts the same `type` and `where` parameters as `find()`.

```
uix.data.count({
  type: string,
  where?: Record<string, unknown>,
}) → Promise<number>
```

#### `uix.data.raw(sql, params?)`

Executes arbitrary read-only SQL against `data.db`. REQUIRES `"raw-sql"` in
`manifest.permissions`. MUST throw or reject if the permission is absent.
MUST NOT permit write statements (INSERT, UPDATE, DELETE, DROP, etc.).

```
uix.data.raw(sql: string, params?: unknown[]) → Promise<Record[]>
```

### 4.5 `uix.state` — Read-Write State Bridge

Provides full read-write access to `state.db`.

#### `uix.state.find(query)`

Same signature and semantics as `uix.data.find` (with `offset`, extended `where`, array `orderBy`).

#### `uix.state.get(id)`

Same signature and semantics as `uix.data.get`.

#### `uix.state.count(query)`

Same signature and semantics as `uix.data.count`.

#### `uix.state.insert(record)`

Inserts a new record and returns the full saved record (including generated `id`,
`created_at`, and `updated_at`). The `id` is auto-generated as `"<type>:<uuid>"` if
not provided.

```
uix.state.insert({
  type: string,
  id?: string,
  body: Record<string, unknown>,  // plain object — viewer JSON-stringifies it
}) → Promise<Record>
```

#### `uix.state.update(id, body)`

Replaces the `body` of the record with the given `id`. Updates `updated_at`.
The `body` argument is a plain object — the viewer JSON-stringifies it.
Returns the updated record.

```
uix.state.update(id: string, body: Record<string, unknown>) → Promise<Record>
```

#### `uix.state.upsert(record)`

Inserts the record if no record with the given `id` exists, or replaces its `body`
if it does exist. The `id` field is required.

```
uix.state.upsert({
  id: string,
  type: string,
  body: Record<string, unknown>,
}) → Promise<Record>
```

#### `uix.state.insertMany(records)`

Inserts multiple records in a single atomic transaction. Each record has the same
shape as `uix.state.insert`. Returns the saved records in the same order.

```
uix.state.insertMany(records: Array<{ type, id?, body }>) → Promise<Record[]>
```

#### `uix.state.transaction(ops)`

Executes an ordered list of operations in a single atomic SQLite transaction.
Each operation is one of `"insert"`, `"upsert"`, `"update"`, or `"delete"`.
Returns one result per operation in the same order (a `Record` for write operations,
`null` for deletes or operations that produce no row).

```
uix.state.transaction(ops: Array<TransactionOp>) → Promise<(Record | null)[]>

type TransactionOp =
  | { op: "insert";  type: string; id?: string; body: object }
  | { op: "upsert";  id: string;   type: string; body: object }
  | { op: "update";  id: string;   body: object }
  | { op: "delete";  id: string }
```

#### `uix.state.delete(id)`

Deletes the record with the given `id`.

```
uix.state.delete(id: string) → Promise<void>
```

#### `uix.state.purge(options)`

Deletes all records of a given `type` older than the specified duration.
Duration string format: `"<n><unit>"` where unit is `s` (seconds), `m` (minutes),
`h` (hours), `d` (days), `y` (years). Returns the number of deleted records.

```
uix.state.purge({
  type: string,
  olderThan: string,  // e.g. "24h", "7d", "1y"
}) → Promise<number>
```

#### `uix.state.clear(options?)`

Deletes all records of a given `type`. If `type` is omitted, deletes ALL records
in `state.db`. Returns the number of deleted records.

```
uix.state.clear({ type?: string }) → Promise<number>
```

#### `uix.state.reset()`

Wipes `state.db` entirely and restores the original seed (if `manifest.state.seed`
is `true`) or leaves it empty, exactly as if the file were being opened for the
first time on a new device.

```
uix.state.reset() → Promise<void>
```

#### `uix.state.size()`

Returns metadata about the current `state.db` without fetching records.

```
uix.state.size() → Promise<{
  bytes: number,                   // file size in bytes
  records: number,                 // total row count
  types: Record<string, number>,   // count per type
}>
```

#### `uix.state.vacuum()`

Runs `PRAGMA incremental_vacuum` to reclaim disk space freed by previous deletions.
Returns the before and after file sizes in bytes.

```
uix.state.vacuum() → Promise<{ before: number, after: number }>
```

#### `uix.state.export(options?)`

Serialises matching records to a JSON string suitable for uploading to a server or
saving to disk. Accepts the same `type` and optional `before` (ISO 8601 string)
filters. If no options are given, exports all records.

```
uix.state.export({
  type?: string,
  before?: string,  // ISO 8601 — only records created before this timestamp
}) → Promise<string>  // JSON-encoded Record[]
```

#### `uix.state.raw(sql, params?)`

Executes arbitrary SQL against `state.db`. REQUIRES `"raw-sql"` permission.

```
uix.state.raw(sql: string, params?: unknown[]) → Promise<unknown[]>
```

#### `uix.state.exportBundle(options?)`

Exports state records as a `.uixdata` JSON bundle string (see §11). If `types` is
provided, only records of those types are included; otherwise all records are exported.
The returned string may be saved with `uix.file.save()` or uploaded to a server.

```
uix.state.exportBundle({
  types?: string[],  // optional type filter; omit for all records
}) → Promise<string>  // pretty-printed .uixdata JSON
```

#### `uix.state.importBundle(json, options?)`

Imports a `.uixdata` bundle string (obtained from `exportBundle` or the CLI) into
`state.db`. Verifies the checksum before writing; rejects on mismatch.

| Option  | Default | Description                                                                                                               |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `merge` | `false` | If `true`, records whose ID already exists are skipped. If `false`, existing records of matching types are deleted first. |

```
uix.state.importBundle(json: string, { merge?: boolean })
  → Promise<{ imported: number, skipped: number }>
```

### 4.6 Record Shape

All methods that return records return objects of this shape:

```typescript
interface UIXRecord {
  id: string; // e.g. "product:001", "cart_item:a1b2c3d4"
  type: string; // e.g. "product", "cart_item"
  body: string; // JSON string — call JSON.parse(record.body) to read fields
  created_at: number; // Unix timestamp (milliseconds, epoch ms)
  updated_at: number; // Unix timestamp (milliseconds, epoch ms)
}
```

The `body` field is always a JSON string when returned from the bridge. Applications
MUST call `JSON.parse(record.body)` before accessing fields within it.

### 4.7 `uix.print()`

Triggers the system print dialog. REQUIRES `"print"` in `manifest.permissions`.

```
uix.print() → void
```

### 4.8 `uix.exit()`

Closes the current application and returns the viewer to its home screen.

```
uix.exit() → Promise<void>
```

### 4.9 `uix.viewer.version()`

Returns the current viewer version string synchronously (no Promise).

```
uix.viewer.version() → string  // e.g. "1.0.0"
```

### 4.10 `uix.window.setTitle(title)`

Sets the window title dynamically. The title is visible in the viewer chrome and
the OS taskbar.

```
uix.window.setTitle(title: string) → Promise<void>
```

### 4.11 `uix.clipboard.write(text)`

Writes `text` to the system clipboard. REQUIRES `"clipboard-write"` in
`manifest.permissions`.

```
uix.clipboard.write(text: string) → Promise<void>
```

### 4.12 `uix.fullscreen`

Enter, exit, or toggle fullscreen mode. REQUIRES `"fullscreen"` in
`manifest.permissions`. All three methods are provided.

```
uix.fullscreen.enter()  → Promise<void>
uix.fullscreen.exit()   → Promise<void>
uix.fullscreen.toggle() → Promise<void>
```

### 4.13 `uix.file.save(filename, content, mime?)`

Opens a system Save dialog and writes `content` to the chosen path. REQUIRES
`"file-save"` in `manifest.permissions`. Returns `true` if the file was saved,
`false` if the user cancelled.

```
uix.file.save(
  filename: string,               // suggested filename, e.g. "orders.csv"
  content:  string | ArrayBuffer, // text or binary content
  mime?:    string,               // MIME type hint, e.g. "text/csv"
) → Promise<boolean>
```

### 4.14 `uix.file.open(options?)`

Opens a system Open dialog and returns the chosen file's name and raw bytes.
REQUIRES `"file-open"` in `manifest.permissions`. Returns `null` if the user
cancelled.

```
uix.file.open({
  accept?: string,  // file-type filter, e.g. ".csv,.json"
}) → Promise<{ name: string, content: ArrayBuffer } | null>
```

### 4.15 `uix.browser.open(url)`

Opens `url` in the user's default system browser. REQUIRES `"open-url"` in
`manifest.permissions`. The URL MUST be an `http://` or `https://` URL.

```
uix.browser.open(url: string) → Promise<void>
```

### 4.16 `uix.notify(title, body, options?)`

Displays an OS-level notification. REQUIRES `"notifications"` in
`manifest.permissions`. The viewer MUST silently ignore the call (not throw) if the
user has denied notification permission at the OS level.

```
uix.notify(
  title:    string,
  body:     string,
  options?: { icon?: string },
) → Promise<void>
```

### 4.17 `uix.state.sync()`

Pushes locally-changed `state.db` records to a remote sync server and merges returned
records back into local state. REQUIRES `"local-sync"` in `manifest.permissions`.
The viewer MUST read `manifest.sync.secret`; if absent the call MUST reject with a
clear error message. If `manifest.sync.endpoint` is absent, the viewer MAY attempt
LAN auto-discovery of a Sync Hub host before rejecting.

Conflict resolution: last-write-wins on `updated_at`. If the server holds a record
with a higher `updated_at` than the local copy, the server’s version wins and the
local record MUST be overwritten.

```
uix.state.sync() → Promise<{ pushed: number, pulled: number }>
```

The viewer MAY call `uix.state.sync()` automatically on app open, periodically
while the app remains open, and on close when the permission is granted.
Applications MAY also call it manually at any time.

---

### 4.18 `uix.schema` — Schema Versioning Bridge

When `manifest.schemaVersion` is greater than the version stored in the user's `state.db`,
the viewer makes an upgrade context available. Applications that mutate their data schema MUST
call `uix.schema.onUpgrade()` before rendering — typically at the very top of their init
function — so that state is brought up to date before any reads or writes.

**Usage pattern:**

```js
await uix.schema.onUpgrade(async ({ from, to, state }) => {
  if (from < 2) {
    // migrate records from schema 1 → 2 using uix.state.* methods
  }
  if (from < 3) {
    // migrate records from schema 2 → 3
  }
});
// State is now current — safe to render
```

The entire upgrade runs inside an exclusive SQLite transaction. If `fn` throws, the viewer
rolls back every state change made during the upgrade and leaves `schemaVersion` in `state.db`
unchanged. The next open will attempt the upgrade again. If no upgrade is needed
(`manifest.schemaVersion` equals the stored version), `onUpgrade()` resolves immediately
without calling `fn`.

**Safety guarantee:** a partial migration can never leave `state.db` in a corrupt state.
Every `uix.state.*` call made inside `fn` is part of the same transaction. All changes are
committed atomically on success, or discarded entirely on failure.

> **Note:** `uix.state.transaction()` MUST NOT be called inside `fn` — SQLite does not
> support nested transactions. Use individual `uix.state.*` calls instead; they are all
> part of the outer upgrade transaction automatically.

| Method                       | Signature                                                                                    | Description                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uix.schema.onUpgrade(fn)`   | `(fn: (ctx: { from: number, to: number, state: object }) => Promise<void>) => Promise<void>` | Calls `fn` inside an exclusive transaction when an upgrade is needed. Commits and updates stored version on success; rolls back all changes on failure. Resolves immediately if no upgrade is needed. |
| `uix.schema.version()`       | `() => number`                                                                               | Returns `manifest.schemaVersion` (or `1` if absent).                                                                                                                                                  |
| `uix.schema.storedVersion()` | `() => number`                                                                               | Returns the schema version currently stored in `state.db`.                                                                                                                                            |
| `uix.schema.needsUpgrade()`  | `() => boolean`                                                                              | `true` when the stored version is below the manifest version.                                                                                                                                         |

---

### 4.19 Methods That Do NOT Exist

The following method names MUST NOT be exposed by a compliant viewer. Applications
that call them will receive `undefined` or a rejection — never a result:

- `uix.data.getAll()` — use `uix.data.find({ type: "..." })`
- `uix.data.findAll()` — use `uix.data.find({ type: "..." })`
- `uix.data.fetchAll()` — use `uix.data.find({ type: "..." })`
- `uix.data.query()`, `uix.data.list()`, `uix.data.all()` — use `find()`
- `uix.storage.*` — use `uix.state.*`
- `uix.fetch()` — network is blocked by default; network access requires `"network": "allowed"` in manifest
- `uix.version()` — use `uix.viewer.version()` (synchronous, no await)
- `uix.fs.*` — no direct host filesystem access is provided; use `uix.file.open/save()`
- `window.__uix.db` — use `uix.data.find()` or `uix.state.*`

---

## 5. Network Policy

If `manifest.network` is `"blocked"` (the default), the viewer MUST enforce a
Content Security Policy that blocks all external network requests made by the
application. The viewer MAY allow internal references (e.g. `localhost` for
development mode) but MUST block all external hostnames.

If `manifest.network` is `"allowed"`, the application MAY make external requests
subject to normal browser security policies. The viewer SHOULD display a visual
indicator that the application has network access.

---

## 6. Security Extensions (Optional)

The `security` block in `manifest.json` is entirely optional. Regular applications
MUST omit it. The security block enables PIN authentication and file-level encryption.

### 6.1 Security Object

```json
{
  "security": {
    "auth": "pin",
    "encryptedPaths": ["data.db", "files/annex.pdf"],
    "kdf": "PBKDF2-SHA256",
    "kdfIterations": 200000,
    "keySalt": "<base64url-random-salt>",
    "maxOpens": 3,
    "screenshot": false
  }
}
```

| Field            | Default           | Description                                                                                                                                                                             |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`           | `"none"`          | `"pin"` — viewer MUST prompt for a PIN before opening. `"none"` — no authentication.                                                                                                    |
| `encryptedPaths` | `[]`              | Paths within the archive encrypted with AES-256-GCM. The viewer MUST decrypt these files in memory after successful authentication. Applications access them via normal relative paths. |
| `kdf`            | `"PBKDF2-SHA256"` | Key derivation function. MUST be `"PBKDF2-SHA256"` in version 1.0.                                                                                                                      |
| `kdfIterations`  | 200000            | PBKDF2 iteration count. Higher values increase resistance to brute-force attacks. MUST NOT be less than 100000.                                                                         |
| `keySalt`        | —                 | Base64url-encoded random salt. Used as the PBKDF2 salt. This value is not secret — storing it in the manifest is correct.                                                               |
| `maxOpens`       | unlimited         | Maximum number of times this file may be opened. The viewer MUST track opens locally per file ID. If `maxOpens` is reached, the viewer MUST refuse to open the file.                    |
| `screenshot`     | false             | If `true`, the viewer MUST prevent OS-level screenshots and screen recording while the file is open. Applicable to desktop viewers only.                                                |

### 6.2 Encryption

Encrypted files (listed in `encryptedPaths`) MUST be encrypted with AES-256-GCM.
The encryption key is derived as:

```
key = PBKDF2-SHA256(password=PIN, salt=base64url_decode(keySalt), iterations=kdfIterations, keylen=32)
```

Encrypted files MUST NOT be readable without a correct PIN. A viewer MUST check
the expiry field (`manifest.expires`) before attempting decryption.

---

## 7. Signature (Optional)

The `signature` block enables tamper detection via Ed25519 public-key signatures.

```json
{
  "signature": {
    "algorithm": "Ed25519",
    "publicKey": "<base64url-public-key>",
    "value": "<base64url-signature>",
    "signedAt": "2026-05-19T10:00:00Z"
  }
}
```

The signature covers a deterministic, line-oriented payload that binds both the
manifest and every other file in the archive. The exact payload (the
`DOTUIX-SIGN-V1` format) is constructed as follows:

1. Remove the `signature` field from the manifest object, then serialise the
   manifest to compact JSON with **all object keys sorted recursively** (no
   insignificant whitespace). Call this `<manifest-canon>`.
2. Take every file in the archive **except** `manifest.json` and `state.db`,
   sort the paths case-sensitively (ascending), and for each compute the
   lowercase hex SHA-256 of its contents.
3. Build the payload as these UTF-8 lines joined by a single `\n` (LF), with
   **no trailing newline**:

   ```
   DOTUIX-SIGN-V1
   manifest:<manifest-canon>
   file:<path-1>:<hex-sha256>
   file:<path-2>:<hex-sha256>
   ...
   ```

4. Sign the UTF-8 bytes of this payload with the Ed25519 private key; encode the
   64-byte signature as base64url (no padding) in `signature.value`.

`manifest.json` is excluded because it carries the signature itself (its content
is bound via `<manifest-canon>`), and `state.db` is excluded because it is
user-mutable at runtime — a signature must survive normal state writes.

A compliant viewer with signature verification MUST:

1. If `manifest.signature` is present, verify the signature before exposing any content.
2. If verification fails, refuse to open the file and display a clear tamper warning.
3. If `manifest.signature` is absent, open the file without verification (signatures are opt-in).

---

## 8. AI Provenance (Optional)

The `ai` block is an informational provenance record for AI-generated files.
It has no effect on viewer behaviour.

```json
{
  "ai": {
    "generatedBy": "claude-opus-4",
    "generatedAt": "2026-05-19T12:00:00Z",
    "capabilities": ["search", "chat"],
    "promptHash": "<sha256-hex>"
  }
}
```

| Field          | Type     | Description                                                        |
| -------------- | -------- | ------------------------------------------------------------------ |
| `generatedBy`  | string   | Model or tool identifier, e.g. `"claude-opus-4"`, `"@dotuix/mcp"`. |
| `generatedAt`  | string   | ISO 8601 timestamp of generation.                                  |
| `capabilities` | string[] | Semantic capabilities of the application.                          |
| `promptHash`   | string   | SHA-256 hex digest of the generation prompt (for reproducibility). |

---

## 9. Validation

A compliant validator MUST report an error for:

- Missing or invalid `manifest.json`
- Missing any required manifest field (`uix`, `id`, `name`, `version`, `entry`, `mode`)
- `manifest.entry` pointing to a file not present in the archive
- `manifest.uix` not equal to `"1.0"`
- `manifest.mode` not equal to `"kiosk"` or `"window"`
- `manifest.network` present and not equal to `"blocked"` or `"allowed"`
- Archive is not a valid ZIP file

A compliant validator SHOULD report a warning for:

- Media files (image, video, audio, font) found outside `assets/`
- `manifest.minViewer` not following SemVer
- `manifest.security.kdfIterations` below 100000
- Files listed in `manifest.security.encryptedPaths` not found in archive

---

## 10. Versioning

The format version is declared in `manifest.uix`. This specification defines version `"1.0"`.

Future versions of this specification WILL increment the version string. Viewers encountering
an unknown version SHOULD display a message advising the user to update their viewer, and
SHOULD NOT attempt to open the file.

Backwards-compatible additions (new optional manifest fields, new optional bridge methods)
MAY be made without incrementing the version. Breaking changes (removing required fields,
changing existing behaviour) MUST increment the version.

---

## 11. `.uixdata` Bundle Format

The `.uixdata` format is used to export and import state records outside of a `.uix` file.
It is a plain JSON file with the following top-level fields:

| Field           | Type     | Required | Description                                             |
| --------------- | -------- | -------- | ------------------------------------------------------- |
| `format`        | string   | yes      | Must be `"uixdata/1.0"`                                 |
| `appId`         | string   | yes      | `manifest.id` of the source app                         |
| `schemaVersion` | integer  | yes      | Schema version at time of export                        |
| `exportedAt`    | string   | yes      | ISO-8601 timestamp                                      |
| `exportedBy`    | string   | yes      | Tool identifier, e.g. `dotuix-cli/0.1.4`                |
| `checksum`      | string   | yes      | `"sha256:<hex>"` of `JSON.stringify(records)` (compact) |
| `types`         | string[] | yes      | Unique record types present in this bundle              |
| `records`       | object[] | yes      | Array of record objects (see below)                     |

### 11.1 Record Object

Each entry in `records` has the same shape as a state record:

| Field        | Type    | Description                              |
| ------------ | ------- | ---------------------------------------- |
| `id`         | string  | Full record ID (e.g. `"product:abc123"`) |
| `type`       | string  | Record type                              |
| `body`       | string  | Stringified JSON body                    |
| `created_at` | integer | Unix ms timestamp                        |
| `updated_at` | integer | Unix ms timestamp                        |

### 11.2 Checksum

The `checksum` value is computed as:

```
"sha256:" + hex( SHA-256( JSON.stringify(records) ) )
```

`JSON.stringify(records)` must be the compact form (no extra whitespace) of the `records`
array as exported. The checksum is verified before import; a mismatch MUST be rejected.

### 11.3 Import Modes

**Replace mode** (default): all existing records whose `type` is present in the bundle are
deleted before inserting the bundle records. Records of other types are untouched.

**Merge mode** (`--merge`): records whose `id` already exists in the target are skipped;
only new IDs are inserted. No records are deleted.

---

## 12. License (Optional)

The `license` block is an OPTIONAL extension for publishers who wish to gate a
file behind an offline, cryptographically-verified entitlement token. Regular
applications MUST omit it. It has no effect on files that do not carry it.

### 12.1 Manifest `license` Object

```json
{
  "license": {
    "required": true,
    "publisherKey": "ed25519:<base64url-public-key>",
    "appId": "com.example.app"
  }
}
```

| Field          | Type    | Description                                                                                                             |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `required`     | boolean | When `true`, a compliant viewer MUST refuse to open the file unless a valid license token for `appId` is installed.      |
| `publisherKey` | string  | Ed25519 public key (`"ed25519:<base64url>"`) the viewer uses to verify the license token's signature. No DNS ownership is asserted. |
| `appId`        | string  | Application id the license must match (defaults to `manifest.id`).                                                       |

### 12.2 License Token (`.uixlicense`)

A license token is a detached, signed JSON document installed into the viewer's
application-data directory (out of band — it is NOT packed into the `.uix`). Its
payload identifies the licensee and entitlements; it is signed with the
publisher's Ed25519 private key and verified against `manifest.license.publisherKey`.

| Payload field | Type     | Description                                              |
| ------------- | -------- | -------------------------------------------------------- |
| `appId`       | string   | Must match `manifest.license.appId`.                     |
| `issuedTo`    | string   | Licensee identity (display only).                        |
| `issuedAt`    | string   | ISO-8601 issue timestamp.                                |
| `expiresAt`   | string?  | ISO-8601 expiry, or omitted for a perpetual license.     |
| `features`    | string[] | Capability flags the application may query.              |
| `deviceId`    | string?  | When present, binds the license to a single device id.   |

Verification is fully offline. A compliant viewer MUST reject a token whose
signature is invalid, whose `appId` does not match, that has expired, or that is
device-bound to a different device.

### 12.3 `uix.license` Bridge

When a license is present, the viewer exposes a read-only `uix.license` bridge:

| Method                       | Returns                          | Description                                              |
| ---------------------------- | -------------------------------- | -------------------------------------------------------- |
| `uix.license.get()`          | `Promise<LicenseInfo \| null>`   | The verified license, or `null` if none is installed.    |
| `uix.license.hasFeature(f)`  | `Promise<boolean>`               | `true` when the verified license lists feature `f`.      |

`LicenseInfo` is `{ issuedTo, issuedAt, expiresAt?, features, valid }`. These
methods never perform network requests.

> **Note:** the `license` extension is implemented by the desktop and mobile
> viewers and tooled by the `dotuix issue-license` / `dotuix device-id` CLI
> commands. The web viewer does not currently verify licenses.

---

## Appendix A — Example manifest.json

### Minimal (no security)

```json
{
  "uix": "1.0",
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "entry": "index.html",
  "mode": "kiosk",
  "network": "blocked"
}
```

### Full (with security and signature)

```json
{
  "uix": "1.0",
  "id": "gov.qa.briefing.q2-2026",
  "name": "Ministry Briefing Q2 2026",
  "version": "1.0.0",
  "minViewer": "1.0.0",
  "entry": "index.html",
  "mode": "kiosk",
  "permissions": [],
  "network": "blocked",
  "expires": "2026-06-30T23:59:59Z",
  "state": { "seed": false },
  "security": {
    "auth": "pin",
    "encryptedPaths": ["data.db", "files/annex-a.pdf"],
    "kdf": "PBKDF2-SHA256",
    "kdfIterations": 200000,
    "keySalt": "base64url-random-salt-here",
    "maxOpens": 3,
    "screenshot": false
  },
  "signature": {
    "algorithm": "Ed25519",
    "publicKey": "base64url-public-key",
    "value": "base64url-signature",
    "signedAt": "2026-05-19T10:00:00Z"
  }
}
```

---

## Appendix B — SQLite Schema (complete)

```sql
-- records table — identical in data.db and state.db
CREATE TABLE records (
  id         TEXT    PRIMARY KEY,
  type       TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX idx_type       ON records (type);
CREATE INDEX idx_created_at ON records (created_at);

-- meta table — state.db only, created by viewer on first open
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

---

## License

Copyright © 2026 dotuix contributors.

This specification is licensed under the
[Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/).

You are free to:

- **Share** — copy and redistribute this document in any medium or format
- **Adapt** — build upon this document for any purpose, including commercial use

Under the following terms:

- **Attribution** — You must give appropriate credit to the dotuix project, provide a link
  to this license, and indicate if changes were made.

The authors of this specification provide it "as-is" without warranty of any kind.
