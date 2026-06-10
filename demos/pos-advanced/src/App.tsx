import { useCallback, useEffect, useState } from 'react';
import { DEV_CATEGORIES, DEV_PRODUCTS, DEV_STAFF, DEV_TAX_RATES } from './devData';
import { CatalogScreen } from './screens/CatalogScreen';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { LoginScreen } from './screens/LoginScreen';
import { OrdersScreen } from './screens/OrdersScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import type { CartItem, Category, Product, Screen, Staff, TaxRate } from './types';
import { bodyOf, initials } from './utils';

// ── Catalog data is loaded once from data.db ──────────────────────────────
async function loadCatalog() {
  if (typeof uix === 'undefined' || !uix?.data) {
    return { categories: DEV_CATEGORIES, products: DEV_PRODUCTS, taxRates: DEV_TAX_RATES };
  }
  const [catRecs, prodRecs, taxRecs] = await Promise.all([
    uix.data.find({ type: 'category' }),
    uix.data.find({ type: 'product' }),
    uix.data.find({ type: 'tax_rate' }),
  ]);
  const categories = catRecs
    .map((r) => ({ id: r.id, ...bodyOf<Omit<Category, 'id'>>(r) }))
    .sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99));
  const products = prodRecs.map((r) => ({ id: r.id, ...bodyOf<Omit<Product, 'id'>>(r) }));
  const taxRates = taxRecs.map((r) => ({ id: r.id, ...bodyOf<Omit<TaxRate, 'id'>>(r) }));
  return { categories, products, taxRates };
}

// ── Staff lives in state.db; seeded on first run ──────────────────────────
async function loadOrSeedStaff(): Promise<Staff[]> {
  if (typeof uix === 'undefined' || !uix?.state) return DEV_STAFF;
  const recs = await uix.state.find({ type: 'staff_member' });
  if (recs.length > 0) return recs.map((r) => ({ id: r.id, ...bodyOf<Omit<Staff, 'id'>>(r) }));
  // First run — seed defaults
  const defaults: Omit<Staff, 'id'>[] = [
    { name: 'Manager', pin: '1234', role: 'manager', color: '#c8a96e' },
    { name: 'Cashier', pin: '5678', role: 'cashier', color: '#5588ff' },
    { name: 'Supervisor', pin: '9999', role: 'supervisor', color: '#55aa77' },
  ];
  for (const s of defaults) await uix.state.insert({ type: 'staff_member', body: s });
  const seeded = await uix.state.find({ type: 'staff_member' });
  return seeded.map((r) => ({ id: r.id, ...bodyOf<Omit<Staff, 'id'>>(r) }));
}

// ── Nav icons (inline SVG paths to avoid external deps) ──────────────────
const NAV_ITEMS: { screen: Screen; label: string; path: string }[] = [
  {
    screen: 'catalog',
    label: 'Catalog',
    path: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  },
  {
    screen: 'orders',
    label: 'Orders',
    path: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H9H8',
  },
  {
    screen: 'reports',
    label: 'Reports',
    path: 'M18 20V10M12 20V4M6 20v-6',
  },
];

export function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Staff | null>(null);
  const [screen, setScreen] = useState<Screen>('catalog');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [receiptCounter, setReceiptCounter] = useState(1);

  // ── Bootstrap ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [catalog, staff] = await Promise.all([loadCatalog(), loadOrSeedStaff()]);
      setCategories(catalog.categories);
      setProducts(catalog.products);
      setTaxRates(catalog.taxRates);
      setAllStaff(staff);

      // Load persisted receipt counter
      if (typeof uix !== 'undefined' && uix?.state) {
        const settings = await uix.state.find({ type: 'setting' });
        const rc = settings.find((s) => bodyOf<{ key: string }>(s).key === 'receipt_counter');
        if (rc) setReceiptCounter(Number(bodyOf<{ value: string }>(rc).value) || 1);
      }
      setLoading(false);
    })();
  }, []);

  // ── Cart helpers ────────────────────────────────────────────────────────
  const addToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      return existing
        ? prev.map((i) => (i.productId === product.id ? { ...i, qty: i.qty + 1 } : i))
        : [
            ...prev,
            {
              productId: product.id,
              name: product.name,
              sku: product.sku,
              price: product.price,
              qty: 1,
            },
          ];
    });
  }, []);

  const updateCartQty = useCallback((productId: string, delta: number) => {
    setCart((prev) => {
      const item = prev.find((i) => i.productId === productId);
      if (!item) return prev;
      if (item.qty + delta <= 0) return prev.filter((i) => i.productId !== productId);
      return prev.map((i) => (i.productId === productId ? { ...i, qty: i.qty + delta } : i));
    });
  }, []);

  const clearCart = useCallback(() => setCart([]), []);

  const completeOrder = useCallback(
    async (orderData: {
      discountAmt: number;
      taxAmt: number;
      taxRateId: string;
      taxRateName: string;
      taxRatePct: number;
      method: 'cash' | 'card' | 'split';
    }) => {
      const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
      const total = subtotal - orderData.discountAmt + orderData.taxAmt;
      const counter = receiptCounter;
      const receiptNo = `R-${String(counter).padStart(4, '0')}`;

      const order = {
        receiptNo,
        items: cart.map((i) => ({ ...i })),
        subtotal,
        discount: orderData.discountAmt,
        tax: orderData.taxAmt,
        total,
        taxRateId: orderData.taxRateId,
        taxRateName: orderData.taxRateName,
        taxRatePct: orderData.taxRatePct,
        staff: session?.name ?? 'Unknown',
        staffId: session?.id ?? '',
        method: orderData.method,
        status: 'complete' as const,
        createdAt: new Date().toISOString(),
      };

      if (typeof uix !== 'undefined' && uix?.state) {
        await uix.state.insert({ type: 'order', body: order });
        // Persist receipt counter
        const settings = await uix.state.find({ type: 'setting' });
        const rcRec = settings.find((s) => bodyOf<{ key: string }>(s).key === 'receipt_counter');
        const nextCounter = counter + 1;
        if (rcRec) {
          await uix.state.update(rcRec.id, {
            key: 'receipt_counter',
            value: String(nextCounter),
          });
        } else {
          await uix.state.insert({
            type: 'setting',
            body: { key: 'receipt_counter', value: String(nextCounter) },
          });
        }
        setReceiptCounter(nextCounter);
      }

      clearCart();
      setScreen('orders');

      if (typeof uix !== 'undefined' && uix?.notify) {
        uix.notify({ title: 'Order complete', body: `${receiptNo} · QAR ${total.toFixed(2)}` });
      }
    },
    [cart, receiptCounter, session, clearCart],
  );

  // ── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        <span>Starting Nexus POS…</span>
      </div>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        staff={allStaff}
        onLogin={(s) => {
          setSession(s);
          setScreen('catalog');
        }}
      />
    );
  }

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <nav className="sidebar">
        <div className="nav-logo">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>

        {NAV_ITEMS.map(({ screen: s, label, path }) => (
          <button
            key={s}
            className={`nav-item${screen === s ? ' active' : ''}`}
            onClick={() => setScreen(s)}
            title={label}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d={path} />
            </svg>
            <span>{label}</span>
            {s === 'catalog' && cartCount > 0 && <span className="nav-badge">{cartCount}</span>}
          </button>
        ))}

        <button
          className={`nav-item${screen === 'reports' ? ' active' : ''}`}
          onClick={() => setScreen('reports')}
          title="Reports"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <span>Reports</span>
        </button>

        <div className="nav-spacer" />

        <button
          className={`nav-item${screen === 'settings' ? ' active' : ''}`}
          onClick={() => setScreen('settings')}
          title="Settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>Settings</span>
        </button>

        <button
          className="staff-avatar-btn"
          style={{ background: session.color }}
          onClick={() => setSession(null)}
          title={`${session.name} — click to switch`}
        >
          {initials(session.name)}
        </button>
      </nav>

      {/* ── Screens ─────────────────────────────────────────────── */}
      <main className="content">
        {screen === 'catalog' && (
          <CatalogScreen
            categories={categories}
            products={products}
            taxRates={taxRates}
            cart={cart}
            onAddToCart={addToCart}
            onUpdateQty={updateCartQty}
            onClearCart={clearCart}
            onCheckout={() => setScreen('checkout')}
          />
        )}
        {screen === 'checkout' && (
          <CheckoutScreen
            cart={cart}
            taxRates={taxRates}
            onBack={() => setScreen('catalog')}
            onComplete={completeOrder}
          />
        )}
        {screen === 'orders' && <OrdersScreen />}
        {screen === 'reports' && <ReportsScreen />}
        {screen === 'settings' && (
          <SettingsScreen staff={allStaff} onSignOut={() => setSession(null)} />
        )}
      </main>
    </div>
  );
}
