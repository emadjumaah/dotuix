import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UIXStateDB, createState, openData, openStateFromFile } from '../src/db.js';
import { pack } from '../src/pack.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'valid-app');

// ---------------------------------------------------------------------------
// createState — fresh database
// ---------------------------------------------------------------------------

describe('createState — fresh', () => {
  it('returns a UIXStateDB instance', async () => {
    const db = await createState({ uixVersion: '1.0' });
    expect(db).toBeInstanceOf(UIXStateDB);
    db.close();
  });

  it('has an empty records table', async () => {
    const db = await createState({ uixVersion: '1.0' });
    expect(db.find({ type: 'test' })).toEqual([]);
    db.close();
  });

  it('exports a valid SQLite file (starts with magic bytes)', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const bytes = db.serialize();
    const header = new TextDecoder().decode(bytes.slice(0, 15));
    expect(header).toBe('SQLite format 3');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// createState — seed mode
// ---------------------------------------------------------------------------

describe('createState — seed', () => {
  it('loads seed records into the state database', async () => {
    // Create a seed database with one record
    const seed = await createState({ uixVersion: '1.0' });
    seed.insert({ type: 'counter', body: { value: 99 } });
    const seedBytes = seed.serialize();
    seed.close();

    // Load seed into a new state DB
    const db = await createState({ uixVersion: '1.0', seed: seedBytes });
    const rows = db.find({ type: 'counter' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).value).toBe(99);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// UIXStateDB — CRUD operations
// ---------------------------------------------------------------------------

describe('UIXStateDB — insert / find / get / update / delete', () => {
  let db: UIXStateDB;

  beforeAll(async () => {
    db = await createState({ uixVersion: '1.0' });
  });

  afterAll(() => {
    db.close();
  });

  it('insert returns the full saved record with a type-prefixed id', () => {
    const rec = db.insert({
      type: 'product',
      body: { name: 'كبسة', price: 45 },
    });
    expect(rec.id).toMatch(/^product:/);
    expect(rec.type).toBe('product');
    expect(JSON.parse(rec.body).price).toBe(45);
    expect(typeof rec.created_at).toBe('number');
  });

  it('find returns records by type', () => {
    const { id } = db.insert({ type: 'cart', body: { items: [] } });
    const rows = db.find({ type: 'cart' });
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it('get returns a specific record by id', () => {
    const { id } = db.insert({ type: 'order', body: { total: 100 } });
    const row = db.get(id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.type).toBe('order');
  });

  it('body is stored and retrieved as a JSON string', () => {
    const { id } = db.insert({ type: 'item', body: { qty: 3, name: 'لحم' } });
    const row = db.get(id);
    expect(row).not.toBeNull();
    const body = JSON.parse(row?.body);
    expect(body.qty).toBe(3);
    expect(body.name).toBe('لحم');
  });

  it('created_at and updated_at are numeric timestamps', () => {
    const { id } = db.insert({ type: 'ts_test', body: {} });
    const row = db.get(id)!;
    expect(typeof row.created_at).toBe('number');
    expect(typeof row.updated_at).toBe('number');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('get returns null for unknown id', () => {
    expect(db.get('nonexistent:id')).toBeNull();
  });

  it('update changes the body and returns the updated record', () => {
    const { id } = db.insert({ type: 'session', body: { active: true } });
    const updated = db.update(id, { active: false });
    expect(JSON.parse(updated.body).active).toBe(false);
    const row = db.get(id)!;
    expect(JSON.parse(row.body).active).toBe(false);
  });

  it('update throws for an unknown id', () => {
    expect(() => db.update('missing:id', {})).toThrow(/not found/i);
  });

  it('delete removes the record', () => {
    const { id } = db.insert({ type: 'temp', body: {} });
    db.delete(id);
    expect(db.get(id)).toBeNull();
  });

  it('find with where filters on body fields', () => {
    db.insert({ type: 'food', body: { category: 'مشروبات', name: 'قهوة' } });
    db.insert({ type: 'food', body: { category: 'مقبلات', name: 'حمص' } });
    const rows = db.find({ type: 'food', where: { category: 'مشروبات' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => JSON.parse(r.body).category === 'مشروبات')).toBe(true);
  });

  it('find with limit caps the result count', () => {
    for (let i = 0; i < 5; i++) db.insert({ type: 'limited', body: { i } });
    const rows = db.find({ type: 'limited', limit: 2 });
    expect(rows.length).toBe(2);
  });

  it('find with orderBy created_at orders results', () => {
    db.insert({ type: 'ordered', body: {} });
    db.insert({ type: 'ordered', body: {} });
    const rows = db.find({ type: 'ordered', orderBy: 'created_at' });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('find with invalid where key throws', () => {
    expect(() => db.find({ type: 'x', where: { 'bad key!': 'v' } })).toThrow(/Invalid field name/);
  });
});

// ---------------------------------------------------------------------------
// UIXStateDB — raw()
// ---------------------------------------------------------------------------

describe('UIXStateDB — raw()', () => {
  it('throws without raw-sql permission', async () => {
    const db = await createState({ uixVersion: '1.0' });
    expect(() => db.raw('SELECT 1')).toThrow(/Permission denied/);
    db.close();
  });

  it('executes SELECT with raw-sql permission', async () => {
    const db = await createState({
      uixVersion: '1.0',
      permissions: ['raw-sql'],
    });
    db.insert({ type: 'r', body: { v: 1 } });
    const rows = db.raw("SELECT id FROM records WHERE type = 'r'");
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });

  it('executes write SQL with raw-sql permission on state', async () => {
    const db = await createState({
      uixVersion: '1.0',
      permissions: ['raw-sql'],
    });
    // raw() on state allows writes
    db.raw("INSERT INTO records (id, type, body) VALUES ('raw:1', 'raw_type', '{}')");
    const row = db.get('raw:1');
    expect(row).not.toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// UIXStateDB — purge()
// ---------------------------------------------------------------------------

describe('UIXStateDB — purge()', () => {
  it('deletes nothing for fresh records (not yet old enough)', async () => {
    const db = await createState({ uixVersion: '1.0' });
    db.insert({ type: 'log', body: {} });
    const count = db.purge({ type: 'log', olderThan: '30d' });
    expect(count).toBe(0);
    db.close();
  });

  it('deletes records older than the cutoff', async () => {
    const db = await createState({
      uixVersion: '1.0',
      permissions: ['raw-sql'],
    });
    db.insert({ type: 'old', body: {} });
    // Manually backdate created_at to 2 hours ago (epoch-ms)
    const past = Date.now() - 7200 * 1000;
    db.raw(`UPDATE records SET created_at = ${past} WHERE type = 'old'`);
    const count = db.purge({ type: 'old', olderThan: '1h' });
    expect(count).toBe(1);
    db.close();
  });

  it("treats 'm' as minutes and 's' as seconds (spec §4.18)", async () => {
    const db = await createState({
      uixVersion: '1.0',
      permissions: ['raw-sql'],
    });
    db.insert({ type: 'rec', body: {} });
    // Backdate 10 minutes into the past (epoch-ms).
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    db.raw(`UPDATE records SET created_at = ${tenMinAgo} WHERE type = 'rec'`);
    // "30m" (30 minutes) must NOT delete a 10-minute-old record...
    expect(db.purge({ type: 'rec', olderThan: '30m' })).toBe(0);
    // ...but "5m" (5 minutes) must delete it. (Pre-fix, 'm' meant 30 days.)
    expect(db.purge({ type: 'rec', olderThan: '5m' })).toBe(1);

    db.insert({ type: 'sec', body: {} });
    const oneMinAgo = Date.now() - 60 * 1000;
    db.raw(`UPDATE records SET created_at = ${oneMinAgo} WHERE type = 'sec'`);
    expect(db.purge({ type: 'sec', olderThan: '30s' })).toBe(1);
    db.close();
  });

  it('stores created_at as epoch milliseconds, not seconds', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const { id } = db.insert({ type: 'ms_test', body: {} });
    const row = db.get(id)!;
    // Epoch-ms is ~1.7e12; epoch-seconds would be ~1.7e9. Guard the boundary.
    expect(row.created_at).toBeGreaterThan(1_000_000_000_000);
    db.close();
  });

  it('throws on invalid duration format', async () => {
    const db = await createState({ uixVersion: '1.0' });
    expect(() => db.purge({ type: 'x', olderThan: 'invalid' })).toThrow(/Invalid duration/);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// export() / round-trip
// ---------------------------------------------------------------------------

describe('UIXStateDB — serialize and reload', () => {
  it('serialized bytes can be reloaded as a seed', async () => {
    const db1 = await createState({ uixVersion: '1.0' });
    db1.insert({ type: 'widget', body: { color: 'gold' } });
    const bytes = db1.serialize();
    db1.close();

    const db2 = await createState({ uixVersion: '1.0', seed: bytes });
    const rows = db2.find({ type: 'widget' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).color).toBe('gold');
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// UIXStateDB — full bridge surface (spec §4.4–§4.5, §11)
// ---------------------------------------------------------------------------

describe('UIXStateDB — where operators', () => {
  let db: UIXStateDB;
  beforeAll(async () => {
    db = await createState({ uixVersion: '1.0' });
    db.insertMany([
      { type: 'p', body: { name: 'a', price: 5, tag: 'x' } },
      { type: 'p', body: { name: 'b', price: 10, tag: 'y' } },
      { type: 'p', body: { name: 'c', price: 20, tag: 'z' } },
      { type: 'p', body: { name: 'd', price: 20, tag: null } },
    ]);
  });
  afterAll(() => db.close());

  it('gte / lte filter numerically', () => {
    expect(db.count({ type: 'p', where: { price: { gte: 10 } } })).toBe(3);
    expect(db.count({ type: 'p', where: { price: { lte: 10 } } })).toBe(2);
  });
  it('gt / lt are strict', () => {
    expect(db.count({ type: 'p', where: { price: { gt: 10 } } })).toBe(2);
    expect(db.count({ type: 'p', where: { price: { lt: 20 } } })).toBe(2);
  });
  it('neq excludes matches', () => {
    expect(db.count({ type: 'p', where: { price: { neq: 20 } } })).toBe(2);
  });
  it('in matches a set', () => {
    expect(db.count({ type: 'p', where: { tag: { in: ['x', 'z'] } } })).toBe(2);
  });
  it('like matches a pattern', () => {
    expect(db.count({ type: 'p', where: { name: { like: 'a' } } })).toBe(1);
  });
  it('is_null distinguishes null fields', () => {
    expect(db.count({ type: 'p', where: { tag: { is_null: true } } })).toBe(1);
    expect(db.count({ type: 'p', where: { tag: { is_null: false } } })).toBe(3);
  });
  it('scalar shorthand is equality', () => {
    expect(db.count({ type: 'p', where: { price: 20 } })).toBe(2);
  });
  it('rejects unknown operators', () => {
    expect(() => db.find({ type: 'p', where: { price: { bogus: 1 } } })).toThrow(
      /Unknown where operator/,
    );
  });
});

describe('UIXStateDB — orderBy / limit / offset', () => {
  let db: UIXStateDB;
  beforeAll(async () => {
    db = await createState({ uixVersion: '1.0' });
    db.insertMany([
      { type: 'n', body: { v: 3 } },
      { type: 'n', body: { v: 1 } },
      { type: 'n', body: { v: 2 } },
    ]);
  });
  afterAll(() => db.close());

  it('orders descending by a body field', () => {
    const rows = db.find({ type: 'n', orderBy: { field: 'v', direction: 'desc' } });
    expect(rows.map((r) => JSON.parse(r.body).v)).toEqual([3, 2, 1]);
  });
  it('orders ascending via string shorthand', () => {
    const rows = db.find({ type: 'n', orderBy: 'v' });
    expect(rows.map((r) => JSON.parse(r.body).v)).toEqual([1, 2, 3]);
  });
  it('supports multi-field array ordering', () => {
    const rows = db.find({
      type: 'n',
      orderBy: [{ field: 'v', direction: 'asc' }],
    });
    expect(rows.map((r) => JSON.parse(r.body).v)).toEqual([1, 2, 3]);
  });
  it('applies offset with limit (pagination)', () => {
    const rows = db.find({ type: 'n', orderBy: 'v', limit: 1, offset: 1 });
    expect(rows.map((r) => JSON.parse(r.body).v)).toEqual([2]);
  });
  it('applies offset without limit', () => {
    const rows = db.find({ type: 'n', orderBy: 'v', offset: 2 });
    expect(rows.map((r) => JSON.parse(r.body).v)).toEqual([3]);
  });
});

describe('UIXStateDB — upsert / insertMany / transaction', () => {
  it('upsert inserts then replaces', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const a = db.upsert({ id: 'k:1', type: 'k', body: { n: 1 } });
    expect(JSON.parse(a.body).n).toBe(1);
    const b = db.upsert({ id: 'k:1', type: 'k', body: { n: 2 } });
    expect(JSON.parse(b.body).n).toBe(2);
    expect(db.count({ type: 'k' })).toBe(1);
    db.close();
  });

  it('insertMany returns all saved records atomically', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const recs = db.insertMany([
      { type: 't', body: { i: 1 } },
      { type: 't', body: { i: 2 } },
    ]);
    expect(recs).toHaveLength(2);
    expect(db.count({ type: 't' })).toBe(2);
    db.close();
  });

  it('transaction runs mixed ops in order and rolls back on error', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const seed = db.insert({ type: 'o', body: { v: 0 } });
    const results = db.transaction([
      { op: 'insert', type: 'o', body: { v: 1 } },
      { op: 'update', id: seed.id, body: { v: 9 } },
      { op: 'delete', id: seed.id },
    ]);
    expect(results[0]).not.toBeNull();
    expect(results[2]).toBeNull();
    expect(db.get(seed.id)).toBeNull();

    // A failing op rolls the whole batch back.
    const before = db.count({ type: 'o' });
    expect(() =>
      db.transaction([
        { op: 'insert', type: 'o', body: { v: 5 } },
        { op: 'update', id: 'missing:x', body: {} },
      ]),
    ).toThrow();
    expect(db.count({ type: 'o' })).toBe(before);
    db.close();
  });
});

describe('UIXStateDB — clear / reset / size / vacuum', () => {
  it('clear removes by type or all; size reports counts', async () => {
    const db = await createState({ uixVersion: '1.0' });
    db.insertMany([
      { type: 'a', body: {} },
      { type: 'a', body: {} },
      { type: 'b', body: {} },
    ]);
    const size = db.size();
    expect(size.records).toBe(3);
    expect(size.types).toEqual({ a: 2, b: 1 });
    expect(typeof size.bytes).toBe('number');

    expect(db.clear({ type: 'a' })).toBe(2);
    expect(db.count({ type: 'a' })).toBe(0);
    expect(db.count({ type: 'b' })).toBe(1);

    db.insert({ type: 'c', body: {} });
    db.reset();
    expect(db.size().records).toBe(0);
    db.close();
  });

  it('vacuum returns before/after byte sizes', async () => {
    const db = await createState({ uixVersion: '1.0' });
    const { before, after } = db.vacuum();
    expect(typeof before).toBe('number');
    expect(typeof after).toBe('number');
    db.close();
  });
});

describe('UIXStateDB — export / bundle round-trip (spec §11)', () => {
  it('export() returns JSON records filtered by type', async () => {
    const db = await createState({ uixVersion: '1.0' });
    db.insert({ type: 'e', body: { v: 1 } });
    db.insert({ type: 'other', body: {} });
    const json = db.export({ type: 'e' });
    const records = JSON.parse(json);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('e');
    db.close();
  });

  it('exportBundle → importBundle replace round-trips with checksum', async () => {
    const src = await createState({
      uixVersion: '1.0',
      appId: 'com.example.app',
      schemaVersion: 2,
    });
    src.insertMany([
      { type: 'note', body: { t: 'one' } },
      { type: 'note', body: { t: 'two' } },
    ]);
    const bundle = src.exportBundle();
    const parsed = JSON.parse(bundle);
    expect(parsed.format).toBe('uixdata/1.0');
    expect(parsed.appId).toBe('com.example.app');
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    src.close();

    const dst = await createState({ uixVersion: '1.0' });
    const res = dst.importBundle(bundle);
    expect(res.imported).toBe(2);
    expect(dst.count({ type: 'note' })).toBe(2);
    dst.close();
  });

  it('importBundle rejects a tampered checksum', async () => {
    const src = await createState({ uixVersion: '1.0' });
    src.insert({ type: 'x', body: { v: 1 } });
    const bundle = JSON.parse(src.exportBundle());
    src.close();
    bundle.records[0].body = JSON.stringify({ v: 999 }); // tamper, keep old checksum
    const dst = await createState({ uixVersion: '1.0' });
    expect(() => dst.importBundle(JSON.stringify(bundle))).toThrow(/checksum mismatch/i);
    dst.close();
  });

  it('importBundle merge mode skips existing ids', async () => {
    const dst = await createState({ uixVersion: '1.0' });
    const existing = dst.insert({ type: 'm', body: { v: 1 } });

    const src = await createState({ uixVersion: '1.0' });
    src.upsert({ id: existing.id, type: 'm', body: { v: 2 } });
    src.insert({ type: 'm', body: { v: 3 } });
    const bundle = src.exportBundle();
    src.close();

    const res = dst.importBundle(bundle, { merge: true });
    expect(res.skipped).toBe(1);
    expect(res.imported).toBe(1);
    expect(JSON.parse(dst.get(existing.id)?.body).v).toBe(1); // unchanged
    dst.close();
  });
});

describe('UIXDataDB — count', () => {
  it('counts seeded data records', async () => {
    const { createDataDb, openDataBuffer } = await import('../src/db.js');
    const { packBuffer } = await import('../src/pack.js');
    const dataDb = await createDataDb([
      { type: 'product', body: { price: 5 } },
      { type: 'product', body: { price: 15 } },
      { type: 'cat', body: {} },
    ]);
    const uix = packBuffer({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({
          uix: '1.0',
          id: 'com.example.data',
          name: 'D',
          version: '1.0.0',
          entry: 'index.html',
          mode: 'window',
        }),
      ),
      'index.html': new TextEncoder().encode('<html></html>'),
      'data.db': dataDb,
    });
    const data = (await openDataBuffer(uix))!;
    expect(data.count({ type: 'product' })).toBe(2);
    expect(data.count({ type: 'product', where: { price: { gt: 10 } } })).toBe(1);
    data.close();
  });
});

// ---------------------------------------------------------------------------
// openData — archive with no data.db
// ---------------------------------------------------------------------------

describe('openData', () => {
  let tmpDir: string;
  let uixPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dotuix-db-'));
    uixPath = join(tmpDir, 'test.uix');
    await pack(FIXTURE, uixPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when archive has no data.db', async () => {
    const db = await openData(uixPath);
    expect(db).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openStateFromFile
// ---------------------------------------------------------------------------

describe('openStateFromFile', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dotuix-state-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens an existing state.db file', async () => {
    // Create a state DB and save it to disk
    const db1 = await createState({ uixVersion: '1.0' });
    db1.insert({ type: 'ping', body: { ok: true } });
    const dbPath = join(tmpDir, 'state.db');
    writeFileSync(dbPath, db1.serialize());
    db1.close();

    // Re-open from file
    const db2 = await openStateFromFile(dbPath, { permissions: ['raw-sql'] });
    const rows = db2.find({ type: 'ping' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).ok).toBe(true);
    db2.close();
  });
});
