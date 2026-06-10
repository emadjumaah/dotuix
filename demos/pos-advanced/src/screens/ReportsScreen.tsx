import { useEffect, useState } from 'react';
import type { Order } from '../types';
import { bodyOf, qar } from '../utils';

export function ReportsScreen() {
  const [hasLicense, setHasLicense] = useState<boolean | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    (async () => {
      // ── License gate: uix.license.hasFeature("reports") ──────
      let licensed = false;
      if (typeof uix !== 'undefined' && uix?.license?.hasFeature) {
        try {
          licensed = await uix.license.hasFeature('reports');
        } catch {
          licensed = false;
        }
      }
      setHasLicense(licensed);
      if (!licensed) return;

      // ── Load orders for analytics ─────────────────────────────
      if (typeof uix !== 'undefined' && uix?.state) {
        const recs = await uix.state.find({ type: 'order' });
        setOrders(recs.map((r) => ({ id: r.id, ...bodyOf<Omit<Order, 'id'>>(r) })));
      }
    })();
  }, []);

  if (hasLicense === null) {
    return (
      <div className="orders-screen">
        <div className="orders-header">
          <h2 className="screen-title">Reports</h2>
        </div>
        <div className="orders-empty">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (!hasLicense) {
    return (
      <div className="orders-screen">
        <div className="orders-header">
          <h2 className="screen-title">Reports</h2>
        </div>
        <div className="locked-screen">
          <svg
            className="lock-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <h2>Reports require a license</h2>
          <p>
            Upgrade your Nexus POS license to unlock daily &amp; weekly sales analytics, top
            products, and staff performance.
          </p>
          <code className="license-hint">uix.license.hasFeature("reports")</code>
        </div>
      </div>
    );
  }

  // ── Compute analytics ────────────────────────────────────────
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);

  const todayOrders = orders.filter((o) => new Date(o.createdAt) >= today);
  const weekOrders = orders.filter((o) => new Date(o.createdAt) >= week);
  const sum = (arr: Order[]) => arr.reduce((s, o) => s + (o.total ?? 0), 0);
  const avg = orders.length ? sum(orders) / orders.length : 0;

  const productQty: Record<string, number> = {};
  const productRev: Record<string, number> = {};
  for (const o of weekOrders) {
    for (const item of o.items ?? []) {
      productQty[item.name] = (productQty[item.name] ?? 0) + item.qty;
      productRev[item.name] = (productRev[item.name] ?? 0) + item.price * item.qty;
    }
  }
  const topProducts = Object.entries(productQty)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="reports-screen">
      <div className="orders-header">
        <h2 className="screen-title">Reports</h2>
      </div>
      <div className="reports-content">
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-label">Today</span>
            <span className="stat-value">{qar(sum(todayOrders))}</span>
            <span className="stat-sub">{todayOrders.length} orders</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">This Week</span>
            <span className="stat-value">{qar(sum(weekOrders))}</span>
            <span className="stat-sub">{weekOrders.length} orders</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">All Time</span>
            <span className="stat-value">{qar(sum(orders))}</span>
            <span className="stat-sub">{orders.length} total</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Avg Order</span>
            <span className="stat-value">{qar(avg)}</span>
            <span className="stat-sub">all time</span>
          </div>
        </div>

        <h3 className="section-heading">Top Products — Last 7 Days</h3>
        {topProducts.length === 0 ? (
          <p className="empty-state">No orders in the last 7 days yet.</p>
        ) : (
          topProducts.map(([name, qty], i) => (
            <div key={name} className="top-product-row">
              <span className="top-rank">#{i + 1}</span>
              <span className="top-name">{name}</span>
              <span className="top-qty">{qty} sold</span>
              <span className="top-rev">{qar(productRev[name] ?? 0)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
