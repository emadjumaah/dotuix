import { useEffect, useState } from 'react';
import type { Order } from '../types';
import { bodyOf, fmtTime, qar } from '../utils';

export function OrdersScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);

  useEffect(() => {
    (async () => {
      if (typeof uix === 'undefined' || !uix?.state) return;
      const recs = await uix.state.find({ type: 'order' });
      const parsed = recs
        .map((r) => ({ id: r.id, ...bodyOf<Omit<Order, 'id'>>(r) }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setOrders(parsed);
    })();
  }, []);

  function printReceipt() {
    if (typeof uix !== 'undefined' && uix?.print) {
      uix.print();
    } else {
      window.print();
    }
  }

  return (
    <div className="orders-screen">
      <div className="orders-header">
        <h2 className="screen-title">Orders</h2>
        <span className="orders-count">{orders.length} orders</span>
      </div>

      <div className="orders-list">
        {orders.length === 0 ? (
          <div className="orders-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>No orders yet</span>
          </div>
        ) : (
          orders.map((o) => (
            <div key={o.id} className="order-row" onClick={() => setSelected(o)}>
              <span className="order-receipt-no">{o.receiptNo ?? '—'}</span>
              <span className="order-time">{fmtTime(o.createdAt)}</span>
              <span className="order-staff">{o.staff}</span>
              <span className="order-method">{o.method}</span>
              <span className="order-total">{qar(o.total)}</span>
            </div>
          ))
        )}
      </div>

      {/* ── Receipt Modal ──────────────────────────────── */}
      {selected && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && setSelected(null)}
        >
          <div className="receipt-modal">
            <div className="receipt-header">
              <span className="receipt-title">{selected.receiptNo}</span>
              <button className="close-btn" onClick={() => setSelected(null)}>
                ×
              </button>
            </div>

            <div className="receipt-meta">
              <div className="receipt-row">
                <span>Date</span>
                <span>{fmtTime(selected.createdAt)}</span>
              </div>
              <div className="receipt-row">
                <span>Staff</span>
                <span>{selected.staff}</span>
              </div>
              <div className="receipt-row">
                <span>Method</span>
                <span style={{ textTransform: 'capitalize' }}>{selected.method}</span>
              </div>
            </div>

            <hr className="receipt-divider" />

            {selected.items.map((item, i) => (
              <div key={i} className="receipt-row">
                <span>
                  {item.qty}× {item.name}
                </span>
                <span>{qar(item.price * item.qty)}</span>
              </div>
            ))}

            <hr className="receipt-divider" />

            <div className="receipt-row">
              <span>Subtotal</span>
              <span>{qar(selected.subtotal)}</span>
            </div>
            <div className="receipt-row">
              <span>Discount</span>
              <span>- {qar(selected.discount ?? 0)}</span>
            </div>
            <div className="receipt-row">
              <span>Tax ({selected.taxRatePct ?? 0}%)</span>
              <span>{qar(selected.tax ?? 0)}</span>
            </div>
            <div className="receipt-row bold">
              <span>Total</span>
              <span>{qar(selected.total)}</span>
            </div>

            <div className="receipt-actions">
              <button className="print-btn" onClick={printReceipt}>
                🖨 Print Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
