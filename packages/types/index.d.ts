/**
 * @dotuix/types — TypeScript declarations for the `window.uix` bridge.
 *
 * Add to any Vite-based .uix project:
 *
 *   /// <reference types="@dotuix/types" />
 *
 * Or in tsconfig.json:
 *
 *   { "compilerOptions": { "types": ["@dotuix/types"] } }
 *
 * After that `uix` is globally available and fully typed.
 */

import type {
  ManifestAiContract,
  ManifestMode,
  ManifestNetworkPolicy,
  ManifestPermission,
  ManifestSecurityContract,
  ManifestSignatureContract,
  ManifestUixVersion,
} from './generated/manifest-contract.generated';

// ---------------------------------------------------------------------------
// Shared record types
// ---------------------------------------------------------------------------

/** A record stored in `state.db` or `data.db`. */
export interface UIXRecord {
  id: string;
  type: string;
  /** Stringified JSON body. Use `JSON.parse(record.body)` to access fields. */
  body: string;
  created_at: number;
  updated_at: number;
}

/** Input shape for `state.upsert()` and `state.insert()`. */
export interface UpsertInput {
  id?: string;
  type: string;
  /** Body may be a plain object — the bridge serialises it automatically. */
  body: string | Record<string, unknown>;
}

/** Query parameters accepted by `state.find()` and `data.find()`. */
export interface FindQuery {
  type: string;
  /**
   * Field equality filters applied via `json_extract(body, '$.key') = value`.
   * Keys must be alphanumeric (underscores allowed).
   */
  where?: Record<string, unknown>;
  /**
   * Sort by a top-level column (`"id"`, `"type"`, `"created_at"`, `"updated_at"`)
   * or a body field name. Accepts a string (shorthand for ascending), a single
   * `{ field, direction }` object, or an array of them for multi-field ordering.
   */
  orderBy?:
    | string
    | { field: string; direction: 'asc' | 'desc' }
    | Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  /** Rows to skip before returning results (requires `limit`). */
  offset?: number;
}

/** A single operation in a `state.transaction()` batch. */
export type TransactionOp =
  | {
      op: 'upsert';
      id?: string;
      type: string;
      body: string | Record<string, unknown>;
    }
  | { op: 'insert'; type: string; body: string | Record<string, unknown> }
  | { op: 'update'; id: string; body: string | Record<string, unknown> }
  | { op: 'delete'; id: string };

/** Result returned by `state.importBundle()`. */
export interface ImportResult {
  imported: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// License types
// ---------------------------------------------------------------------------

/** License information returned by `uix.license.get()`. */
export interface LicenseInfo {
  issuedTo: string;
  issuedAt: string;
  /** ISO-8601 date string, or `undefined` for perpetual licenses. */
  expiresAt?: string;
  features: string[];
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Schema upgrade
// ---------------------------------------------------------------------------

/** Context passed to the `uix.schema.onUpgrade()` handler. */
export interface UpgradeContext {
  /** Schema version stored in the user's `state.db` (what their data was written with). */
  from: number;
  /** Schema version declared in `manifest.json` (what this code expects). */
  to: number;
  /** Fully operational `uix.state` bridge — use it to migrate records. */
  state: UIXStateBridge;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Result of `uix.file.open()`. */
export interface OpenedFile {
  name: string;
  content: ArrayBuffer;
}

/** Options for `uix.file.open()`. */
export interface OpenFileOptions {
  /** File-type filter, e.g. `".csv,.json"` (spec §4.14). */
  accept?: string;
  /**
   * @deprecated Use `accept` (a comma-separated string) per spec §4.14.
   * Retained for backwards compatibility with older mock bridges.
   */
  filter?: string[];
}

// ---------------------------------------------------------------------------
// Manifest shape (subset — for `uix.manifest()` return type)
// ---------------------------------------------------------------------------

export type UIXPermission = ManifestPermission;

/** The `manifest.json` structure as returned by `uix.manifest()`. */
export interface UIXManifest {
  uix: ManifestUixVersion;
  id: string;
  name: string;
  version: string;
  minViewer?: string;
  entry: string;
  mode: ManifestMode;
  permissions?: UIXPermission[];
  network?: ManifestNetworkPolicy;
  theme?: { color?: string; background?: string };
  author?: string;
  expires?: string | null;
  schemaVersion?: number;
  security?: ManifestSecurityContract;
  signature?: ManifestSignatureContract;
  ai?: ManifestAiContract;
  state?: {
    mode?: 'file' | 'device';
    seed?: boolean;
  };
  license?: {
    required?: boolean;
    publisherKey?: string;
    appId?: string;
  };
}

// ---------------------------------------------------------------------------
// Bridge namespace interfaces
// ---------------------------------------------------------------------------

/** `uix.state.*` — read/write access to the app's mutable SQLite state. */
export interface UIXStateBridge {
  /** Fetch a single record by `id`, or `null` if not found. */
  get(id: string): Promise<UIXRecord | null>;
  /** Query records. Pass a type string or a full `FindQuery` object. */
  find(query: string | FindQuery): Promise<UIXRecord[]>;
  /** Count records matching a query. */
  count(query: string | FindQuery): Promise<number>;
  /**
   * Insert a new record. The bridge assigns a UUID if `id` is omitted.
   * Returns the created record.
   */
  insert(input: UpsertInput): Promise<UIXRecord>;
  /** Update the body of an existing record. Returns the updated record (spec §4.5). */
  update(id: string, body: string | Record<string, unknown>): Promise<UIXRecord>;
  /**
   * Insert or replace a record. If a record with the given `id` exists it is
   * replaced; otherwise a new record is created.
   */
  upsert(input: UpsertInput & { id: string }): Promise<UIXRecord>;
  /** Insert multiple records in a single transaction. */
  insertMany(records: UpsertInput[]): Promise<UIXRecord[]>;
  /** Delete a record by `id`. */
  delete(id: string): Promise<void>;
  /**
   * Delete records of a given type older than a time window.
   * `olderThan` accepts duration strings such as `"30d"`, `"7d"`, `"1h"`.
   * Defaults to `"30d"` when omitted.
   */
  purge(opts: { type: string; olderThan?: string } | string): Promise<number>;
  /** Delete all records, optionally filtered to a single type. */
  clear(opts?: { type?: string }): Promise<number>;
  /** Delete ALL records across all types. */
  reset(): Promise<void>;
  /** Execute multiple insert/update/delete ops atomically. */
  transaction(ops: TransactionOp[]): Promise<Array<UIXRecord | null>>;
  /** Total bytes, record count, and per-type counts in `state.db`. */
  size(): Promise<{ bytes: number; records: number; types: Record<string, number> }>;
  /** Run SQLite `VACUUM` to reclaim freed space. Returns file size before/after. */
  vacuum(): Promise<{ before: number; after: number }>;
  /**
   * Export records as a JSON string.
   * Requires the `raw-sql` permission when no `type` filter is provided.
   */
  export(opts?: { type?: string; before?: string }): Promise<string>;
  /**
   * Execute a raw SQL query. Requires the `raw-sql` permission.
   * Returns an array of row objects.
   */
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
  /** Export state as a `.uixdata` bundle (JSON string). */
  exportBundle(opts?: { types?: string[] }): Promise<string>;
  /** Import a `.uixdata` bundle. Pass `{ merge: true }` to skip conflicting ids. */
  importBundle(json: string, opts?: { merge?: boolean }): Promise<ImportResult>;
  /**
   * Sync state to/from the local dotuix sync server.
   * Requires the `local-sync` permission.
   */
  sync(): Promise<{ pushed: number; pulled: number }>;
}

/** `uix.data.*` — read-only access to the app's seed / static data DB. */
export interface UIXDataBridge {
  get(id: string): Promise<UIXRecord | null>;
  find(query: string | FindQuery): Promise<UIXRecord[]>;
  count(query: string | FindQuery): Promise<number>;
  /** Execute a raw SQL query against `data.db`. Requires the `raw-sql` permission. */
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** `uix.schema.*` — schema versioning and upgrade lifecycle. */
export interface UIXSchemaBridge {
  /**
   * Register an upgrade handler. Called automatically before first render
   * when `manifest.schemaVersion` is higher than the version stored in
   * `state.db`. Runs inside a transaction — throw to rollback.
   */
  onUpgrade(handler: (ctx: UpgradeContext) => void | Promise<void>): Promise<void>;
  /** Schema version declared in `manifest.json`. */
  version(): number;
  /** Schema version stored in the user's `state.db`. */
  storedVersion(): number;
  /** `true` when `storedVersion() < version()`. */
  needsUpgrade(): boolean;
}

/** `uix.license.*` — offline license token access. */
export interface UIXLicenseBridge {
  /**
   * Return the loaded license, or `null` if no valid license is installed.
   * The token is verified against `manifest.license.publisherKey` on load;
   * this method never performs network requests.
   */
  get(): Promise<LicenseInfo | null>;
  /**
   * Return `true` when the loaded license lists `feature` in its `features`
   * array. Always returns `false` when no valid license is loaded.
   */
  hasFeature(feature: string): Promise<boolean>;
}

/** `uix.clipboard.*` — OS clipboard access. Requires the `clipboard-write` permission. */
export interface UIXClipboardBridge {
  /** Write `text` to the OS clipboard. */
  write(text: string): Promise<void>;
}

/** `uix.fullscreen.*` — fullscreen control. Requires the `fullscreen` permission. */
export interface UIXFullscreenBridge {
  enter(): Promise<void>;
  exit(): Promise<void>;
  toggle(): Promise<void>;
}

/** `uix.file.*` — save / open files via native OS dialogs. */
export interface UIXFileBridge {
  /**
   * Open a native save dialog and write `content` to the chosen path.
   * `content` may be an `ArrayBuffer` or a plain string.
   * Returns `true` if the file was saved, `false` if the user cancelled (spec §4.13).
   * Requires the `file-save` permission.
   */
  save(filename: string, content: ArrayBuffer | string, mimeType?: string): Promise<boolean>;
  /**
   * Open a native file-picker dialog and return the selected file's bytes.
   * Returns `null` when the user cancels.
   * Requires the `file-open` permission.
   */
  open(opts?: OpenFileOptions): Promise<OpenedFile | null>;
}

/** `uix.browser.*` — open URLs in the system browser. Requires the `open-url` permission. */
export interface UIXBrowserBridge {
  /** Open `url` in the system default browser. Only `http://` and `https://` are permitted. */
  open(url: string): Promise<void>;
}

/** `uix.viewer.*` — information about the running viewer. */
export interface UIXViewerBridge {
  /** Semver version string of the currently running viewer, e.g. `"0.4.2"`. */
  version(): string;
}

/** `uix.window.*` — control the viewer window. */
export interface UIXWindowBridge {
  /** Set the window title bar text. */
  setTitle(title: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Top-level bridge
// ---------------------------------------------------------------------------

/**
 * The `window.uix` bridge injected by the dotuix viewer at app startup.
 * Every method returns a `Promise` unless explicitly noted as synchronous.
 *
 * @example
 * ```ts
 * /// <reference types="@dotuix/types" />
 *
 * const rec = await uix.state.get("settings:app");
 * const settings = rec ? JSON.parse(rec.body) : {};
 * ```
 */
export interface UIXBridge {
  /** Return the parsed `manifest.json` of the running app. */
  manifest(): UIXManifest;

  state: UIXStateBridge;
  data: UIXDataBridge;
  schema: UIXSchemaBridge;
  license: UIXLicenseBridge;
  clipboard: UIXClipboardBridge;
  fullscreen: UIXFullscreenBridge;
  file: UIXFileBridge;
  browser: UIXBrowserBridge;
  viewer: UIXViewerBridge;
  window: UIXWindowBridge;

  /**
   * Send an OS notification. Requires the `notifications` permission.
   * @param title   - Notification title.
   * @param body    - Notification body text.
   * @param options - Optional `{ icon }` hint (spec §4.16).
   */
  notify(title: string, body: string, options?: { icon?: string }): Promise<void>;

  /** Trigger the browser print dialog. Requires the `print` permission. */
  print(): void;

  /** Close the viewer window and exit the app. */
  exit(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Global ambient declarations
// ---------------------------------------------------------------------------

declare global {
  /**
   * The dotuix viewer bridge — available everywhere inside a running `.uix` app.
   * Identical to `window.uix`.
   */
  const uix: UIXBridge;

  interface Window {
    uix: UIXBridge;
    /** Internal alias — prefer `window.uix`. */
    __uix: UIXBridge;
  }
}

// ---------------------------------------------------------------------------
// `uix.config.ts` helper — used by dotuix build (Phase 9)
// ---------------------------------------------------------------------------

/** Full configuration accepted by `uix.config.ts`. */
export interface UIXConfig {
  /** Reverse-domain app identifier, e.g. `"com.example.pos"`. */
  id: string;
  name: string;
  version: string;
  /** Entry HTML file relative to project root. Defaults to `"index.html"`. */
  entry?: string;
  mode?: ManifestMode;
  /** Monotonically increasing integer. Increment whenever stored record schemas change. */
  schemaVersion?: number;
  state?: {
    mode?: 'file' | 'device';
    seed?: boolean;
  };
  permissions?: UIXPermission[];
  network?: ManifestNetworkPolicy;
  theme?: { color?: string; background?: string };
  author?: string;
  /** ISO-8601 date after which the viewer refuses to open this file. */
  expires?: string;
  security?: ManifestSecurityContract;
  signature?: ManifestSignatureContract;
  ai?: ManifestAiContract;
  license?: {
    required?: boolean;
    /** Ed25519 public key in `"ed25519:<base64url>"` format. */
    publisherKey?: string;
    appId?: string;
  };
}

/**
 * Type-safe helper for `uix.config.ts`.
 * Returns the config object unchanged — exists purely for IntelliSense.
 *
 * @example
 * ```ts
 * // uix.config.ts
 * import { defineConfig } from "@dotuix/types";
 *
 * export default defineConfig({
 *   id: "com.example.pos",
 *   name: "My POS",
 *   version: "1.0.0",
 *   schemaVersion: 1,
 *   mode: "kiosk",
 *   state: { mode: "device" },
 *   permissions: ["notifications", "print", "fullscreen"],
 * });
 * ```
 */
export declare function defineConfig(config: UIXConfig): UIXConfig;
