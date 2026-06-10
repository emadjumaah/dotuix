import type { UIXRecord } from '@dotuix/types';
/**
 * Report.tsx
 *
 * This template is for read-only, shareable reports.
 * Data is stored inside the .uix archive (state.mode: "file").
 *
 * Typical workflow:
 *   1. A generator script inserts records via uix.state.insert()
 *   2. `dotuix build` packs the data into the archive
 *   3. Recipients open the .uix — the report renders the embedded data
 *
 * Replace the sample data model and rendering below with your own.
 */
import { useEffect, useState } from 'react';

interface RowData {
  label: string;
  value: string | number;
}

export function Report() {
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);
  const manifest = uix.manifest();

  useEffect(() => {
    uix.state
      .find({ type: 'row', orderBy: 'created_at' })
      .then((records: UIXRecord[]) => {
        setRows(records.map((r) => JSON.parse(r.body as string) as RowData));
        setLoading(false);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="report">
      <header className="report-header">
        <h1>{manifest.name}</h1>
        <p className="meta">v{manifest.version}</p>
        <button onClick={() => uix.print()}>Print</button>
      </header>

      <main>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">
            No data. Insert records with type <code>row</code> and fields{' '}
            <code>{'{ label, value }'}</code>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td>{row.label}</td>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
