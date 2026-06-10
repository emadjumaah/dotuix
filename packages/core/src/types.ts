import type {
  ManifestMode,
  ManifestNetworkPolicy,
  ManifestPermission,
  ManifestSecurityAuth,
  ManifestSecurityKdf,
  ManifestSignatureAlgorithm,
  ManifestUixVersion,
} from './generated/manifest-contract.generated.js';

export type Permission = ManifestPermission;

// ---------------------------------------------------------------------------
// Security — fully optional. Omit the block entirely for regular use cases.
// ---------------------------------------------------------------------------

/**
 * Signature written by `dotuix sign`. The viewer verifies this before
 * rendering anything. If the manifest or any file has been tampered with
 * after signing, the signature breaks and the viewer refuses to open the file.
 *
 * Omit (or set null) for unsigned files — the viewer opens them normally.
 */
export interface UIXSignature {
  /** Always "Ed25519" in v1. */
  algorithm: ManifestSignatureAlgorithm;
  /** Base64url-encoded Ed25519 public key used to sign this file. */
  publicKey: string;
  /** Base64url-encoded signature of the canonical content hash. */
  value: string;
  /** ISO-8601 timestamp of when the file was signed. */
  signedAt: string;
}

/**
 * Optional security settings. Every field is optional.
 * Omitting this block entirely has no effect on regular .uix files —
 * a restaurant menu or shop app works exactly as before.
 */
export interface UIXSecurity {
  /**
   * Require the viewer to prompt for a PIN before opening the file.
   * The PIN derives the decryption key for any encrypted files listed
   * in `encryptedPaths`. Omit (or set "none") for no authentication.
   * Default: "none"
   */
  auth?: ManifestSecurityAuth;

  /**
   * Paths inside the archive that are AES-256-GCM encrypted.
   * The viewer decrypts them in memory after successful auth — the app
   * references them via normal relative paths and never sees raw bytes.
   * Omit or leave empty for unencrypted files (default for all regular apps).
   */
  encryptedPaths?: string[];

  /**
   * Key derivation algorithm used to derive the AES key from the PIN.
   * Only relevant when `encryptedPaths` is non-empty.
   * Default: "PBKDF2-SHA256"
   */
  kdf?: ManifestSecurityKdf;

  /** PBKDF2 iteration count. Higher = slower brute-force. Default: 200000. */
  kdfIterations?: number;

  /**
   * Base64url-encoded random salt stored in the manifest (safe to store
   * publicly). The AES key = PBKDF2(PIN, salt, iterations).
   */
  keySalt?: string;

  /**
   * Maximum number of times this file may be opened across all devices.
   * Tracked locally by the viewer in ~/.dotuix/sessions.db (outside the file).
   * The file owner cannot bypass this by editing state.db inside the archive.
   * Omit for unlimited opens (default for all regular apps).
   */
  maxOpens?: number;

  /**
   * Prevent the OS screenshot / screen-recording API while this file is open.
   * Enforced by the desktop viewer on supported platforms (macOS, Windows).
   * Has no effect in the web viewer. Default: false.
   */
  screenshot?: false | true;
}

// ---------------------------------------------------------------------------
// AI provenance — optional block for AI-generated .uix files
// ---------------------------------------------------------------------------

/**
 * Optional provenance metadata for AI-generated .uix files.
 * Omit entirely for non-AI-generated files — it has no effect on viewers.
 */
export interface UIXAiMeta {
  /** Model or tool that created this file, e.g. "claude-opus-4", "@dotuix/ai" */
  generatedBy?: string;
  /** ISO-8601 timestamp of generation */
  generatedAt?: string;
  /** Semantic capabilities this app exposes, e.g. ["search", "chat"] */
  capabilities?: string[];
  /** SHA-256 hex digest of the generation prompt, for reproducibility */
  promptHash?: string;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface Manifest {
  /** Format version, e.g. "1.0" */
  uix: ManifestUixVersion;
  /** Reverse-domain identifier, e.g. "com.almadina.menu" */
  id: string;
  name: string;
  version: string;
  /** Minimum viewer version required to open this file */
  minViewer?: string;
  /** Path to the entry HTML file, relative to archive root */
  entry: string;
  mode: ManifestMode;
  permissions?: Permission[];
  network?: ManifestNetworkPolicy;
  theme?: { color?: string; background?: string };
  author?: string;
  /** ISO-8601 date string after which the file should be considered expired */
  expires?: string | null;
  state?: { seed?: boolean };
  /**
   * Optional security configuration. Omit entirely for regular apps —
   * a restaurant menu or shop does not need this and is unaffected.
   */
  security?: UIXSecurity;
  /**
   * Ed25519 package signature. Written by `dotuix sign`, verified by the
   * viewer on load. Omit or null for unsigned files.
   */
  signature?: UIXSignature | null;
  /** Optional AI provenance. Omit for non-AI-generated files. */
  ai?: UIXAiMeta;
}

export interface UIXRecord {
  id: string;
  type: string;
  /** Stringified JSON — use JSON.parse(record.body) to access fields */
  body: string;
  created_at: number;
  updated_at: number;
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Sort direction for {@link OrderByClause}. */
export type OrderDirection = 'asc' | 'desc';

/** A single `{ field, direction }` ordering term. */
export interface OrderByClause {
  field: string;
  direction: OrderDirection;
}

/**
 * A `where` filter value. Either a plain scalar (shorthand for equality) or an
 * operator object such as `{ gte: 10 }`, `{ in: ["a", "b"] }`, `{ is_null: true }`.
 */
export type WhereValue =
  | string
  | number
  | boolean
  | null
  | {
      eq?: unknown;
      neq?: unknown;
      gt?: unknown;
      gte?: unknown;
      lt?: unknown;
      lte?: unknown;
      like?: string;
      in?: unknown[];
      is_null?: boolean;
    };

/** Query parameters for the bridge find() method (spec §4.4). */
export interface FindQuery {
  type: string;
  /**
   * Field-level filters. Each value is a scalar (equality shorthand) or an
   * operator object (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`,
   * `is_null`). Keys are top-level columns or body field names. Field names
   * must be alphanumeric (underscores allowed).
   */
  where?: Record<string, WhereValue>;
  /**
   * Sort by a top-level column ('id' | 'type' | 'created_at' | 'updated_at')
   * or a body field name. A string is shorthand for ascending; pass a
   * `{ field, direction }` object or an array of them for multi-field ordering.
   */
  orderBy?: string | OrderByClause | OrderByClause[];
  limit?: number;
  /** Rows to skip before returning results (pagination). */
  offset?: number;
}

/** Filter accepted by count() — the same `type`/`where` shape as find(). */
export interface CountQuery {
  type: string;
  where?: Record<string, WhereValue>;
}

/** A single operation in a {@link UIXStateDB.transaction} batch (spec §4.5). */
export type TransactionOp =
  | { op: 'insert'; type: string; id?: string; body: unknown }
  | { op: 'upsert'; id: string; type: string; body: unknown }
  | { op: 'update'; id: string; body: unknown }
  | { op: 'delete'; id: string };
