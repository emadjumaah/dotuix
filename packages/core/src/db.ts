import { readFileSync } from 'node:fs';
/**
 * @dotuix/core — Database layer (Week 2)
 *
 * Opens data.db (read-only) and state.db (read-write) from .uix archives
 * using sql.js (SQLite compiled to WebAssembly, works in Node.js and browser).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import initSqlJs from 'sql.js';
import type { Database as SqlDatabase, SqlJsStatic } from 'sql.js';
import { parseManifest } from './manifest.js';
import type { CountQuery, FindQuery, Manifest, TransactionOp, UIXRecord } from './types.js';
import { unpackBuffer } from './unpack.js';

const _utf8 = new TextEncoder();

/** Lowercase hex of a byte array. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** `"sha256:<hex>"` of the compact JSON of `records` (spec §11.2). */
function bundleChecksum(records: UIXRecord[]): string {
  return `sha256:${bytesToHex(sha256(_utf8.encode(JSON.stringify(records))))}`;
}

// Universal UUID — Web Crypto API works in Node.js 19+ and all modern browsers
const randomUUID = (): string => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// sql.js initialisation — lazy, cached, shared across all DB operations
// ---------------------------------------------------------------------------

let _sql: SqlJsStatic | null = null;
let _sqlConfig: Parameters<typeof initSqlJs>[0] | undefined;

/**
 * Configure sql.js initialisation options.
 * Must be called **before** any DB operation.
 *
 * In Node.js this is optional — sql.js locates its WASM automatically.
 * In the browser you must point it at the WASM file:
 *
 * ```ts
 * import { configureSqlJs } from '@dotuix/core';
 * configureSqlJs({ locateFile: () => '/sql-wasm.wasm' });
 * ```
 */
export function configureSqlJs(config: Parameters<typeof initSqlJs>[0]): void {
  if (_sql) {
    throw new Error(
      '@dotuix/core: sql.js is already initialised — call configureSqlJs() before any DB operation',
    );
  }
  _sqlConfig = config;
}

async function getSql(): Promise<SqlJsStatic> {
  if (_sql) return _sql;
  _sql = await initSqlJs(_sqlConfig);
  return _sql;
}

// ---------------------------------------------------------------------------
// DDL — format-defined schema, never changes without a format version bump
// ---------------------------------------------------------------------------

// Timestamps are epoch **milliseconds** per the .uix spec (§3.1, Appendix B).
// `strftime('%s','now') * 1000` matches the spec DDL exactly (second precision,
// expressed in ms) and works on every SQLite build sql.js ships.
const NOW_MS_SQL = "CAST(strftime('%s','now') AS INTEGER) * 1000";

const DDL_RECORDS = `
  CREATE TABLE IF NOT EXISTS records (
    id         TEXT    PRIMARY KEY,
    type       TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (${NOW_MS_SQL}),
    updated_at INTEGER NOT NULL DEFAULT (${NOW_MS_SQL})
  );
  CREATE INDEX IF NOT EXISTS idx_type       ON records (type);
  CREATE INDEX IF NOT EXISTS idx_created_at ON records (created_at);
`;

const DDL_META = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const TOP_LEVEL_COLS = new Set(['id', 'type', 'created_at', 'updated_at']);
const SAFE_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(
      `Invalid field name "${key}" — use alphanumeric characters and underscores only`,
    );
  }
}

type SqlParam = string | number | null;

const SELECT_COLS = 'SELECT id, type, body, created_at, updated_at FROM records';

/** A SQL fragment for a queryable field — a top-level column or a json_extract. */
function fieldExpr(field: string): string {
  if (TOP_LEVEL_COLS.has(field)) return field;
  assertSafeKey(field);
  return `json_extract(body, '$.${field}')`;
}

/** Coerce a JS value to a bindable SQL scalar. */
function scalarParam(value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return String(value);
}

const WHERE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'is_null']);

/** Build the `AND ...` tail of a WHERE clause from a `where` filter (spec §4.4). */
function buildWhere(where: Record<string, unknown> | undefined, params: SqlParam[]): string {
  let sql = '';
  for (const [key, raw] of Object.entries(where ?? {})) {
    const col = fieldExpr(key);
    const isOperatorObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    if (!isOperatorObject) {
      sql += ` AND ${col} = ?`;
      params.push(scalarParam(raw));
      continue;
    }
    for (const [op, operand] of Object.entries(raw as Record<string, unknown>)) {
      if (!WHERE_OPS.has(op)) {
        throw new Error(`Unknown where operator "${op}" on field "${key}"`);
      }
      switch (op) {
        case 'eq':
          sql += ` AND ${col} = ?`;
          params.push(scalarParam(operand));
          break;
        case 'neq':
          sql += ` AND ${col} != ?`;
          params.push(scalarParam(operand));
          break;
        case 'gt':
          sql += ` AND ${col} > ?`;
          params.push(scalarParam(operand));
          break;
        case 'gte':
          sql += ` AND ${col} >= ?`;
          params.push(scalarParam(operand));
          break;
        case 'lt':
          sql += ` AND ${col} < ?`;
          params.push(scalarParam(operand));
          break;
        case 'lte':
          sql += ` AND ${col} <= ?`;
          params.push(scalarParam(operand));
          break;
        case 'like':
          sql += ` AND ${col} LIKE ?`;
          params.push(String(operand));
          break;
        case 'in': {
          if (!Array.isArray(operand)) {
            throw new Error(`"in" operator on "${key}" requires an array`);
          }
          if (operand.length === 0) {
            sql += ' AND 0'; // matches nothing
            break;
          }
          sql += ` AND ${col} IN (${operand.map(() => '?').join(', ')})`;
          for (const v of operand) params.push(scalarParam(v));
          break;
        }
        case 'is_null':
          sql += operand ? ` AND ${col} IS NULL` : ` AND ${col} IS NOT NULL`;
          break;
      }
    }
  }
  return sql;
}

/** Build the `ORDER BY ...` clause from a string / object / array (spec §4.4). */
function buildOrderBy(orderBy: FindQuery['orderBy']): string {
  if (!orderBy) return '';
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const clauses = items.map((item) => {
    if (typeof item === 'string') return `${fieldExpr(item)} ASC`;
    const dir = item.direction === 'desc' ? 'DESC' : 'ASC';
    return `${fieldExpr(item.field)} ${dir}`;
  });
  return clauses.length ? ` ORDER BY ${clauses.join(', ')}` : '';
}

function buildFindQuery(query: FindQuery): { sql: string; params: SqlParam[] } {
  const params: SqlParam[] = [query.type];
  let sql = `${SELECT_COLS} WHERE type = ?`;
  sql += buildWhere(query.where, params);
  sql += buildOrderBy(query.orderBy);
  if (query.limit != null) {
    sql += ' LIMIT ?';
    params.push(query.limit);
    if (query.offset != null) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }
  } else if (query.offset != null) {
    // SQLite requires a LIMIT before OFFSET; -1 means "no limit".
    sql += ' LIMIT -1 OFFSET ?';
    params.push(query.offset);
  }
  return { sql, params };
}

function buildCountQuery(query: { type: string; where?: Record<string, unknown> }): {
  sql: string;
  params: SqlParam[];
} {
  const params: SqlParam[] = [query.type];
  let sql = 'SELECT COUNT(*) AS n FROM records WHERE type = ?';
  sql += buildWhere(query.where, params);
  return { sql, params };
}

function toRecord(row: Record<string, unknown>): UIXRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    body: row.body as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function runSelect(db: SqlDatabase, sql: string, params: SqlParam[] = []): UIXRecord[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as (string | number | null | Uint8Array)[]);
    const rows: UIXRecord[] = [];
    while (stmt.step()) {
      rows.push(toRecord(stmt.getAsObject() as Record<string, unknown>));
    }
    return rows;
  } catch (err) {
    throw new Error(`SQL error: ${(err as Error).message}`);
  } finally {
    stmt.free();
  }
}

/** Run a SELECT returning raw row objects (for raw() and aggregate queries). */
function runRawRows(
  db: SqlDatabase,
  sql: string,
  params: SqlParam[] = [],
): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as (string | number | null | Uint8Array)[]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    return rows;
  } catch (err) {
    throw new Error(`SQL error: ${(err as Error).message}`);
  } finally {
    stmt.free();
  }
}

/** Run a query expected to return a single numeric scalar in its first column. */
function runScalarNumber(db: SqlDatabase, sql: string, params: SqlParam[] = []): number {
  const first = runRawRows(db, sql, params)[0] ?? {};
  const val = Object.values(first)[0];
  return typeof val === 'number' ? val : Number(val ?? 0);
}

/**
 * Parse a spec §4.18 duration string into **seconds**.
 * Units: s (seconds), m (minutes), h (hours), d (days), y (years).
 */
function parseDuration(duration: string): number {
  const match = /^(\d+)(s|m|h|d|y)$/.exec(duration);
  if (!match) {
    throw new Error(
      `Invalid duration "${duration}" — expected format like "30s", "5m", "12h", "7d", "1y"`,
    );
  }
  const n = Number.parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60; // minutes
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 'y':
      return n * 31536000; // 365 days
    default:
      throw new Error(`Unknown unit: ${match[2]}`);
  }
}

// ---------------------------------------------------------------------------
// UIXDataDB — read-only bridge surface for data.db
// ---------------------------------------------------------------------------

export class UIXDataDB {
  readonly #db: SqlDatabase;
  readonly #permissions: ReadonlySet<string>;

  /** @internal — use openData() / openDataBuffer() */
  constructor(db: SqlDatabase, permissions: string[]) {
    this.#db = db;
    this.#permissions = new Set(permissions);
  }

  /** Find records by type, with optional field filters and ordering. */
  find(query: FindQuery): UIXRecord[] {
    const { sql, params } = buildFindQuery(query);
    return runSelect(this.#db, sql, params);
  }

  /** Get a single record by id, or null if not found. */
  get(id: string): UIXRecord | null {
    const rows = runSelect(
      this.#db,
      'SELECT id, type, body, created_at, updated_at FROM records WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Count records matching a query, without fetching them. */
  count(query: CountQuery): number {
    const { sql, params } = buildCountQuery(query);
    return runScalarNumber(this.#db, sql, params);
  }

  /**
   * Execute raw SQL against data.db.
   * Restricted to SELECT/WITH statements. Requires "raw-sql" in manifest permissions.
   */
  raw(sql: string, params: SqlParam[] = []): UIXRecord[] {
    if (!this.#permissions.has('raw-sql')) {
      throw new Error('Permission denied — declare "raw-sql" in manifest permissions to use raw()');
    }
    const keyword =
      sql
        .trimStart()
        .match(/^(\w+)/)?.[1]
        ?.toUpperCase() ?? '';
    if (keyword !== 'SELECT' && keyword !== 'WITH') {
      throw new Error(
        'raw() on data.db is read-only — only SELECT and WITH statements are allowed',
      );
    }
    return runSelect(this.#db, sql, params);
  }

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// UIXStateDB — read-write bridge surface for state.db
// ---------------------------------------------------------------------------

export class UIXStateDB {
  readonly #db: SqlDatabase;
  readonly #permissions: ReadonlySet<string>;

  /** @internal — use createState() */
  constructor(db: SqlDatabase, permissions: string[]) {
    this.#db = db;
    this.#permissions = new Set(permissions);
  }

  /** Find records by type, with optional field filters and ordering. */
  find(query: FindQuery): UIXRecord[] {
    const { sql, params } = buildFindQuery(query);
    return runSelect(this.#db, sql, params);
  }

  /** Get a single record by id, or null if not found. */
  get(id: string): UIXRecord | null {
    const rows = runSelect(
      this.#db,
      'SELECT id, type, body, created_at, updated_at FROM records WHERE id = ?',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Count records matching a query, without fetching them. */
  count(query: CountQuery): number {
    const { sql, params } = buildCountQuery(query);
    return runScalarNumber(this.#db, sql, params);
  }

  /**
   * Insert a new record. `id` is auto-generated as `{type}:{uuid}` if omitted.
   * `created_at`/`updated_at` are set automatically.
   * @returns The full saved record (spec §4.5).
   */
  insert(record: { type: string; id?: string; body: unknown }): UIXRecord {
    const id = record.id ?? `${record.type}:${randomUUID()}`;
    this.#db.run('INSERT INTO records (id, type, body) VALUES (?, ?, ?)', [
      id,
      record.type,
      JSON.stringify(record.body),
    ]);
    return this.#require(id);
  }

  /**
   * Replace a record's body. `updated_at` is bumped to the current epoch-ms.
   * @returns The updated record (spec §4.5). Throws if the id does not exist.
   */
  update(id: string, body: unknown): UIXRecord {
    this.#db.run(`UPDATE records SET body = ?, updated_at = ${NOW_MS_SQL} WHERE id = ?`, [
      JSON.stringify(body),
      id,
    ]);
    if (this.#db.getRowsModified() === 0) {
      throw new Error(`Record not found: ${id}`);
    }
    return this.#require(id);
  }

  /**
   * Insert the record if its `id` is new, otherwise replace its body.
   * @returns The saved record (spec §4.5).
   */
  upsert(record: { id: string; type: string; body: unknown }): UIXRecord {
    this.#db.run(
      `INSERT INTO records (id, type, body) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = ${NOW_MS_SQL}`,
      [record.id, record.type, JSON.stringify(record.body)],
    );
    return this.#require(record.id);
  }

  /** Insert multiple records in a single atomic transaction (spec §4.5). */
  insertMany(records: Array<{ type: string; id?: string; body: unknown }>): UIXRecord[] {
    return this.#tx(() => records.map((r) => this.insert(r)));
  }

  /**
   * Execute an ordered list of insert/upsert/update/delete operations in one
   * atomic transaction. Returns one result per op (a record, or null for
   * deletes) in the same order (spec §4.5).
   */
  transaction(ops: TransactionOp[]): Array<UIXRecord | null> {
    return this.#tx(() =>
      ops.map((op): UIXRecord | null => {
        switch (op.op) {
          case 'insert':
            return this.insert(op);
          case 'upsert':
            return this.upsert(op);
          case 'update':
            return this.update(op.id, op.body);
          case 'delete':
            this.delete(op.id);
            return null;
          default:
            throw new Error(`Unknown transaction op: ${(op as { op: string }).op}`);
        }
      }),
    );
  }

  /** Delete a record by id. */
  delete(id: string): void {
    this.#db.run('DELETE FROM records WHERE id = ?', [id]);
  }

  /**
   * Delete records of a given type older than a duration (spec §4.18 units:
   * s, m, h, d, y). @returns Number of records deleted.
   */
  purge(query: { type: string; olderThan: string }): number {
    // created_at is epoch-ms; parseDuration yields seconds → convert to ms.
    const cutoff = Date.now() - parseDuration(query.olderThan) * 1000;
    this.#db.run('DELETE FROM records WHERE type = ? AND created_at < ?', [query.type, cutoff]);
    return this.#db.getRowsModified();
  }

  /**
   * Delete all records of a given type, or ALL records when `type` is omitted.
   * @returns Number of records deleted (spec §4.5).
   */
  clear(options: { type?: string } = {}): number {
    if (options.type) {
      this.#db.run('DELETE FROM records WHERE type = ?', [options.type]);
    } else {
      this.#db.run('DELETE FROM records');
    }
    return this.#db.getRowsModified();
  }

  /**
   * Wipe all records. (Seed restoration is a viewer concern — this core method
   * empties the records table; meta is preserved.)
   */
  reset(): void {
    this.#db.run('DELETE FROM records');
  }

  /** File size, total record count, and per-type counts (spec §4.5). */
  size(): { bytes: number; records: number; types: Record<string, number> } {
    const bytes = this.#db.export().length;
    const records = runScalarNumber(this.#db, 'SELECT COUNT(*) AS n FROM records');
    const types: Record<string, number> = {};
    for (const row of runRawRows(
      this.#db,
      'SELECT type, COUNT(*) AS n FROM records GROUP BY type',
    )) {
      types[String(row.type)] = Number(row.n);
    }
    return { bytes, records, types };
  }

  /** Reclaim freed space via incremental vacuum. Returns byte sizes before/after. */
  vacuum(): { before: number; after: number } {
    const before = this.#db.export().length;
    this.#db.run('PRAGMA incremental_vacuum');
    const after = this.#db.export().length;
    return { before, after };
  }

  /**
   * Serialise matching records to a JSON string (spec §4.5).
   * Filters: `type`, and `before` (ISO-8601 — records created before it).
   */
  export(options: { type?: string; before?: string } = {}): string {
    return JSON.stringify(this.#collect(options));
  }

  /**
   * Export records as a `.uixdata` bundle JSON string (spec §11). If `types`
   * is given only those record types are included; otherwise all records.
   */
  exportBundle(options: { types?: string[] } = {}): string {
    const records =
      options.types && options.types.length > 0
        ? options.types.flatMap((t) => this.find({ type: t }))
        : runSelect(this.#db, `${SELECT_COLS} ORDER BY created_at`);
    const bundle = {
      format: 'uixdata/1.0',
      appId: this.#meta('app_id') ?? '',
      schemaVersion: Number(this.#meta('schema_version') ?? '1'),
      exportedAt: new Date().toISOString(),
      exportedBy: '@dotuix/core',
      checksum: bundleChecksum(records),
      types: [...new Set(records.map((r) => r.type))],
      records,
    };
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * Import a `.uixdata` bundle (spec §11). Verifies the checksum first.
   * In replace mode (default) records of the bundle's types are deleted first;
   * with `{ merge: true }` only new ids are inserted.
   */
  importBundle(
    json: string,
    options: { merge?: boolean } = {},
  ): { imported: number; skipped: number } {
    const bundle = JSON.parse(json) as {
      records?: UIXRecord[];
      checksum?: string;
      types?: string[];
    };
    const records = bundle.records ?? [];
    if (bundle.checksum && bundleChecksum(records) !== bundle.checksum) {
      throw new Error('Bundle checksum mismatch — refusing to import');
    }
    let imported = 0;
    let skipped = 0;
    this.#tx(() => {
      if (!options.merge) {
        const types = bundle.types ?? [...new Set(records.map((r) => r.type))];
        for (const t of types) {
          this.#db.run('DELETE FROM records WHERE type = ?', [t]);
        }
      }
      for (const r of records) {
        if (options.merge && this.get(r.id) !== null) {
          skipped++;
          continue;
        }
        const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        this.#db.run(
          'INSERT OR REPLACE INTO records (id, type, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [r.id, r.type, body, r.created_at, r.updated_at],
        );
        imported++;
      }
    });
    return { imported, skipped };
  }

  /**
   * Execute raw SQL against state.db. Reads and writes are both allowed.
   * Returns raw row objects. Requires "raw-sql" in manifest permissions.
   */
  raw(sql: string, params: SqlParam[] = []): Record<string, unknown>[] {
    if (!this.#permissions.has('raw-sql')) {
      throw new Error('Permission denied — declare "raw-sql" in manifest permissions to use raw()');
    }
    return runRawRows(this.#db, sql, params);
  }

  /**
   * Serialize the database to bytes for repacking into the .uix archive.
   * Call this just before closing to get the latest state. (Distinct from the
   * spec bridge `export()`, which returns a JSON string of records.)
   */
  serialize(): Uint8Array {
    return this.#db.export();
  }

  close(): void {
    this.#db.close();
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  /** Fetch a record by id, throwing if it is unexpectedly absent. */
  #require(id: string): UIXRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`Record not found after write: ${id}`);
    return rec;
  }

  /** Run `fn` inside a SQLite transaction; commit on success, rollback on throw. */
  #tx<T>(fn: () => T): T {
    this.#db.run('BEGIN');
    try {
      const result = fn();
      this.#db.run('COMMIT');
      return result;
    } catch (err) {
      this.#db.run('ROLLBACK');
      throw err;
    }
  }

  /** Records filtered by optional `type` and `before` (ISO-8601), ordered by creation. */
  #collect(options: { type?: string; before?: string }): UIXRecord[] {
    const params: SqlParam[] = [];
    const conds: string[] = [];
    if (options.type) {
      conds.push('type = ?');
      params.push(options.type);
    }
    if (options.before) {
      conds.push('created_at < ?');
      params.push(new Date(options.before).getTime());
    }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return runSelect(this.#db, `${SELECT_COLS}${where} ORDER BY created_at`, params);
  }

  /** Read a value from the meta table, or null when absent. */
  #meta(key: string): string | null {
    const rows = runRawRows(this.#db, 'SELECT value FROM meta WHERE key = ?', [key]);
    return rows[0] ? String(rows[0].value) : null;
  }
}

// ---------------------------------------------------------------------------
// State DB schema bootstrap
// ---------------------------------------------------------------------------

function ensureStateSchema(
  db: SqlDatabase,
  uixVersion: string,
  meta: { appId?: string; schemaVersion?: number } = {},
): void {
  db.run(DDL_RECORDS);
  db.run(DDL_META);
  db.run("INSERT OR IGNORE INTO meta VALUES ('schema_version', ?)", [
    String(meta.schemaVersion ?? 1),
  ]);
  db.run("INSERT OR IGNORE INTO meta VALUES ('created_at', ?)", [new Date().toISOString()]);
  db.run("INSERT OR IGNORE INTO meta VALUES ('uix_version', ?)", [uixVersion]);
  if (meta.appId) {
    db.run("INSERT OR IGNORE INTO meta VALUES ('app_id', ?)", [meta.appId]);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open data.db from a .uix archive on disk (Node.js).
 * Returns null if the archive contains no data.db.
 */
export async function openData(
  uixPath: string,
  opts: { permissions?: string[] } = {},
): Promise<UIXDataDB | null> {
  const data = new Uint8Array(readFileSync(uixPath));
  return openDataBuffer(data, opts);
}

/**
 * Open data.db from a .uix buffer (universal — works in browser too).
 * Returns null if the archive contains no data.db.
 */
export async function openDataBuffer(
  uixData: Uint8Array,
  opts: { permissions?: string[] } = {},
): Promise<UIXDataDB | null> {
  const SQL = await getSql();
  const files = unpackBuffer(uixData);
  if (!files['data.db']) return null;
  const db = new SQL.Database(files['data.db']);
  return new UIXDataDB(db, opts.permissions ?? []);
}

// ---------------------------------------------------------------------------
// createDataDb — create a fresh data.db and seed it with records
// ---------------------------------------------------------------------------

export interface DataRecord {
  /** Optional explicit id. Auto-generated as "type:uuid" if omitted. */
  id?: string;
  type: string;
  body: Record<string, unknown>;
}

/**
 * Create a fresh `data.db` seeded with the given records.
 * Returns the raw SQLite bytes ready to be written as `data.db` inside a
 * `.uix` project directory before packing.
 *
 * @example
 * ```ts
 * const bytes = await createDataDb([
 *   { type: "product", body: { name: "Hummus", price: 18 } },
 *   { type: "category", body: { name: "Appetizers", sort: 1 } },
 * ]);
 * await writeFile(join(projectDir, "data.db"), bytes);
 * ```
 */
export async function createDataDb(records: DataRecord[]): Promise<Uint8Array> {
  const SQL = await getSql();
  const db = new SQL.Database();
  db.run(DDL_RECORDS);
  for (const rec of records) {
    const id = rec.id ?? `${rec.type}:${crypto.randomUUID()}`;
    db.run('INSERT INTO records (id, type, body) VALUES (?, ?, ?)', [
      id,
      rec.type,
      JSON.stringify(rec.body),
    ]);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

export interface CreateStateOptions {
  /** Format version from manifest.uix, e.g. "1.0" */
  uixVersion: string;
  /**
   * Seed bytes from the archive — used when manifest.state.seed = true.
   * If provided, this becomes the starting state. Otherwise a fresh DB is created.
   */
  seed?: Uint8Array;
  /** Permissions from manifest.permissions */
  permissions?: string[];
  /** Application id (manifest.id) — recorded in meta and used by exportBundle(). */
  appId?: string;
  /** Data schema version (manifest.schemaVersion) — recorded in meta. */
  schemaVersion?: number;
}

/**
 * Create or load a state.db in memory.
 *
 * - If `opts.seed` is provided, it is loaded as the starting state (seed mode).
 * - Otherwise, a fresh empty database is created.
 * - The records/meta schema is ensured on both paths.
 *
 * Call `stateDb.serialize()` to get the bytes for repacking into the .uix archive.
 */
export async function createState(opts: CreateStateOptions): Promise<UIXStateDB> {
  const SQL = await getSql();
  const db = opts.seed ? new SQL.Database(opts.seed) : new SQL.Database();
  ensureStateSchema(db, opts.uixVersion, {
    appId: opts.appId,
    schemaVersion: opts.schemaVersion,
  });
  return new UIXStateDB(db, opts.permissions ?? []);
}

/**
 * Open an existing state.db file from disk (Node.js).
 * Intended for CLI operations like `dotuix export`.
 */
export async function openStateFromFile(
  statePath: string,
  opts: { permissions?: string[] } = {},
): Promise<UIXStateDB> {
  const SQL = await getSql();
  const data = new Uint8Array(readFileSync(statePath));
  const db = new SQL.Database(data);
  return new UIXStateDB(db, opts.permissions ?? []);
}

// ---------------------------------------------------------------------------
// Manifest helpers (kept here for index.ts export compatibility)
// ---------------------------------------------------------------------------

const _decoder = new TextDecoder();

export async function readManifest(uixPath: string): Promise<Manifest> {
  const data = new Uint8Array(readFileSync(uixPath));
  return readManifestFromBuffer(data);
}

export function readManifestFromBuffer(data: Uint8Array): Manifest {
  const files = unpackBuffer(data);
  if (!files['manifest.json']) {
    throw new Error('manifest.json not found in archive');
  }
  const raw = JSON.parse(_decoder.decode(files['manifest.json']));
  return parseManifest(raw);
}
