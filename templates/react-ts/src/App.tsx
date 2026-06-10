import type { UIXRecord } from '@dotuix/types';
import { useCallback, useEffect, useState } from 'react';

export function App() {
  const [items, setItems] = useState<UIXRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const records = await uix.state.find({
      type: 'item',
      orderBy: { field: 'created_at', direction: 'desc' },
    });
    setItems(records);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addItem() {
    await uix.state.insert({
      type: 'item',
      body: JSON.stringify({ label: `Item ${Date.now()}` }),
    });
    await load();
  }

  async function deleteItem(id: string) {
    await uix.state.delete(id);
    await load();
  }

  return (
    <div className="container">
      <h1>__NAME__</h1>

      <button onClick={addItem}>Add item</button>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No items yet. Click the button to add one.</p>
      ) : (
        <ul className="item-list">
          {items.map((item) => {
            const body = JSON.parse(item.body as string) as { label: string };
            return (
              <li key={item.id} className="item-card">
                <span>{body.label}</span>
                <button className="delete-btn" onClick={() => deleteItem(item.id)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
