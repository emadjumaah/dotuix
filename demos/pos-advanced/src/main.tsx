// Register schema migration BEFORE mounting React.
// Runs once when the viewer opens the app on a device that has schema v1 data.
if (typeof uix !== 'undefined' && uix?.schema?.onUpgrade) {
  uix.schema.onUpgrade(async ({ from, state }) => {
    if (from < 2) {
      // v1 → v2: orders gain tax, subtotal, discount fields
      const records = await state.find({ type: 'order' });
      for (const rec of records) {
        const body = typeof rec.body === 'string' ? JSON.parse(rec.body) : rec.body;
        if (body.tax === undefined) {
          await state.update(rec.id, {
            ...body,
            tax: 0,
            subtotal: body.total,
            discount: 0,
          });
        }
      }
      console.info(`[Nexus POS] Migrated ${records.length} orders v1 → v2`);
    }
  });
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
