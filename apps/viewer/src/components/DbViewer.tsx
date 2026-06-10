import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

export interface DbRecord {
  id: string;
  type: string;
  body: string;
  created_at: number;
  updated_at: number;
}

interface DbLoadResult {
  exists: boolean;
  records: DbRecord[];
}

interface Props {
  statePath: string | null;
  dataPath: string | null;
}

type DbTarget = 'data' | 'state';

function bodyPreview(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    return Object.entries(obj)
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('  ·  ');
  } catch {
    return body.slice(0, 80);
  }
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DbViewer({ statePath, dataPath }: Props) {
  const [activeDb, setActiveDb] = useState<DbTarget>('data');
  const [records, setRecords] = useState<DbRecord[]>([]);
  const [dbExists, setDbExists] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [addingRecord, setAddingRecord] = useState(false);
  const [addType, setAddType] = useState('');
  const [addBody, setAddBody] = useState('{}');
  const [addError, setAddError] = useState('');

  const dbPath = (target: DbTarget): string | null => (target === 'state' ? statePath : dataPath);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load() reads paths via the dbPath() helper; deps are intentionally the path/target inputs.
  const load = useCallback(
    async (target: DbTarget = activeDb) => {
      const path = dbPath(target);
      if (!path) return;
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<DbLoadResult>('db_load_all', {
          dbPath: path,
        });
        setDbExists(result.exists);
        setRecords(result.records);
        setTypeFilter('all');
        setExpandedId(null);
        setAddingRecord(false);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeDb, statePath, dataPath],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-load only when the DB paths/target change; load is stable for those inputs.
  useEffect(() => {
    if (statePath || dataPath) load(activeDb);
  }, [statePath, dataPath, activeDb]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchDb = (target: DbTarget) => {
    setActiveDb(target);
    setExpandedId(null);
    setEditError('');
    setAddingRecord(false);
  };

  const types = ['all', ...Array.from(new Set(records.map((r) => r.type))).sort()];
  const filtered = typeFilter === 'all' ? records : records.filter((r) => r.type === typeFilter);

  const toggleExpand = (r: DbRecord) => {
    if (expandedId === r.id) {
      setExpandedId(null);
      setEditError('');
    } else {
      setExpandedId(r.id);
      setEditBody(prettyBody(r.body));
      setEditError('');
    }
  };

  const handleSave = async (id: string) => {
    const path = dbPath(activeDb);
    if (!path) return;
    try {
      JSON.parse(editBody);
    } catch {
      setEditError('Invalid JSON');
      return;
    }
    setSaving(true);
    try {
      await invoke('db_update_record', { dbPath: path, id, body: editBody });
      await load();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const path = dbPath(activeDb);
    if (!path) return;
    setSaving(true);
    try {
      await invoke('db_delete_record', { dbPath: path, id });
      await load();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    const path = dbPath('state');
    if (!path) return;
    if (!addType.trim()) {
      setAddError('Type is required');
      return;
    }
    try {
      JSON.parse(addBody);
    } catch {
      setAddError('Invalid JSON body');
      return;
    }
    setSaving(true);
    try {
      await invoke('db_insert_record', {
        dbPath: path,
        type: addType.trim(),
        body: addBody,
      });
      setAddingRecord(false);
      setAddType('');
      setAddBody('{}');
      setAddError('');
      await load('state');
    } catch (e) {
      setAddError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!statePath && !dataPath) {
    return (
      <div className="dev-empty">
        <span style={{ fontSize: '1.8rem', opacity: 0.3 }}>🗄</span>
        <p>No app loaded</p>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontSize: '0.75rem',
        color: '#d4d4d4',
      }}
    >
      {/* DB selector tabs */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid #2d2d2d',
          flexShrink: 0,
        }}
      >
        {(['data', 'state'] as const).map((db) => (
          <button
            key={db}
            onClick={() => switchDb(db)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.4rem 0.75rem',
              fontWeight: 500,
              fontSize: '0.72rem',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${activeDb === db ? '#569cd6' : 'transparent'}`,
              color: activeDb === db ? '#fff' : '#666',
              cursor: 'pointer',
            }}
          >
            <span>{db === 'data' ? '🔒' : '✏️'}</span>
            <span>{db}.db</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => load()}
          title="Refresh"
          style={{
            padding: '0.4rem 0.75rem',
            color: '#666',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          ↻
        </button>
      </div>

      {/* Type filter chips */}
      {records.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '0.3rem',
            padding: '0.4rem 0.5rem',
            borderBottom: '1px solid #2d2d2d',
            flexShrink: 0,
            overflowX: 'auto',
          }}
        >
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              style={{
                padding: '0.1rem 0.5rem',
                borderRadius: '3px',
                fontSize: '0.68rem',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                border: 'none',
                cursor: 'pointer',
                background: typeFilter === t ? '#264f78' : '#2d2d2d',
                color: typeFilter === t ? '#fff' : '#888',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {/* Records list */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '5rem',
              color: '#555',
            }}
          >
            Loading…
          </div>
        )}
        {!loading && error && (
          <div
            style={{
              padding: '0.75rem',
              color: '#f48771',
              wordBreak: 'break-all',
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && !dbExists && (
          <div className="dev-empty">
            <span style={{ fontSize: '1.5rem', opacity: 0.3 }}>🗄</span>
            <p>{activeDb}.db not found</p>
            <p style={{ fontSize: '0.68rem', color: '#444' }}>Created when the app first runs</p>
          </div>
        )}
        {!loading && !error && dbExists && filtered.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '5rem',
              color: '#555',
            }}
          >
            {records.length === 0 ? 'No records' : 'No records of this type'}
          </div>
        )}
        {!loading &&
          !error &&
          filtered.map((record) => (
            <div key={record.id}>
              <button
                onClick={() => toggleExpand(record)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  padding: '0.4rem 0.75rem',
                  borderBottom: '1px solid #1e1e1e',
                  background: expandedId === record.id ? '#2a2d2e' : 'none',
                  border: 'none',
                  borderBottomColor: '#1e1e1e',
                  borderBottomWidth: 1,
                  borderBottomStyle: 'solid',
                  cursor: 'pointer',
                  color: '#d4d4d4',
                }}
                className="db-row"
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '0.5rem',
                    }}
                  >
                    <span
                      style={{
                        color: '#9cdcfe',
                        fontFamily: 'monospace',
                        fontSize: '0.68rem',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {record.id}
                    </span>
                    <span
                      style={{
                        color: '#555',
                        fontSize: '0.68rem',
                        flexShrink: 0,
                      }}
                    >
                      {formatTs(record.created_at)}
                    </span>
                  </div>
                  <div style={{ color: '#4ec9b0', marginTop: '0.15rem' }}>{record.type}</div>
                  <div
                    style={{
                      color: '#666',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginTop: '0.1rem',
                    }}
                  >
                    {bodyPreview(record.body)}
                  </div>
                </div>
                <span
                  style={{
                    color: '#555',
                    marginTop: '0.2rem',
                    flexShrink: 0,
                    fontSize: '0.65rem',
                  }}
                >
                  {expandedId === record.id ? '▲' : '▼'}
                </span>
              </button>

              {expandedId === record.id && (
                <div
                  style={{
                    padding: '0.6rem 0.75rem',
                    background: '#1a1a1a',
                    borderBottom: '1px solid #2d2d2d',
                  }}
                >
                  <textarea
                    style={{
                      width: '100%',
                      height: '9rem',
                      fontFamily: 'monospace',
                      fontSize: '0.7rem',
                      background: '#141414',
                      border: `1px solid ${editError ? '#f48771' : '#3e3e3e'}`,
                      borderRadius: '4px',
                      padding: '0.4rem 0.5rem',
                      resize: 'vertical',
                      color: '#d4d4d4',
                      outline: 'none',
                      lineHeight: 1.5,
                    }}
                    value={editBody}
                    onChange={(e) => {
                      setEditBody(e.target.value);
                      setEditError('');
                    }}
                    readOnly={activeDb === 'data'}
                    spellCheck={false}
                  />
                  {editError && (
                    <p style={{ color: '#f48771', marginTop: '0.25rem' }}>{editError}</p>
                  )}
                  {activeDb === 'state' ? (
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        marginTop: '0.5rem',
                        alignItems: 'center',
                      }}
                    >
                      <button
                        onClick={() => handleSave(record.id)}
                        disabled={saving}
                        style={{
                          padding: '0.25rem 0.65rem',
                          background: '#0e639c',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          opacity: saving ? 0.5 : 1,
                        }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setExpandedId(null);
                          setEditError('');
                        }}
                        style={{
                          padding: '0.25rem 0.65rem',
                          background: '#2d2d2d',
                          color: '#ccc',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                      <div style={{ flex: 1 }} />
                      <button
                        onClick={() => handleDelete(record.id)}
                        disabled={saving}
                        style={{
                          padding: '0.25rem 0.65rem',
                          background: '#2d1b1b',
                          color: '#f48771',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          opacity: saving ? 0.5 : 1,
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <p
                      style={{
                        color: '#444',
                        marginTop: '0.4rem',
                        fontSize: '0.68rem',
                      }}
                    >
                      data.db is read-only at runtime
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
      </div>

      {/* Footer */}
      <div
        style={{
          flexShrink: 0,
          borderTop: '1px solid #2d2d2d',
          padding: '0.4rem 0.75rem',
        }}
      >
        {addingRecord ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input
                placeholder="type (e.g. product)"
                value={addType}
                onChange={(e) => {
                  setAddType(e.target.value);
                  setAddError('');
                }}
                style={{
                  width: '8rem',
                  padding: '0.25rem 0.5rem',
                  background: '#141414',
                  border: '1px solid #3e3e3e',
                  borderRadius: '4px',
                  color: '#d4d4d4',
                  fontSize: '0.72rem',
                  outline: 'none',
                }}
              />
              <textarea
                placeholder="{}"
                value={addBody}
                onChange={(e) => {
                  setAddBody(e.target.value);
                  setAddError('');
                }}
                style={{
                  flex: 1,
                  height: '3.5rem',
                  padding: '0.25rem 0.5rem',
                  background: '#141414',
                  border: '1px solid #3e3e3e',
                  borderRadius: '4px',
                  color: '#d4d4d4',
                  fontFamily: 'monospace',
                  resize: 'none',
                  fontSize: '0.72rem',
                  outline: 'none',
                }}
                spellCheck={false}
              />
            </div>
            {addError && <p style={{ color: '#f48771' }}>{addError}</p>}
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button
                onClick={handleAdd}
                disabled={saving}
                style={{
                  padding: '0.25rem 0.65rem',
                  background: '#0e639c',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                Add
              </button>
              <button
                onClick={() => {
                  setAddingRecord(false);
                  setAddType('');
                  setAddBody('{}');
                  setAddError('');
                }}
                style={{
                  padding: '0.25rem 0.65rem',
                  background: '#2d2d2d',
                  color: '#ccc',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {activeDb === 'state' && (
              <button
                onClick={() => setAddingRecord(true)}
                style={{
                  padding: '0.2rem 0.5rem',
                  background: '#2d2d2d',
                  color: '#ccc',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.68rem',
                }}
              >
                + Add record
              </button>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ color: '#555' }}>
              {filtered.length} record{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
