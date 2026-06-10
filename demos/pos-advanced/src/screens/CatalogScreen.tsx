import { useMemo, useState } from 'react';
import type { CartItem, Category, Product, TaxRate } from '../types';
import { qar } from '../utils';

interface Props {
  categories: Category[];
  products: Product[];
  taxRates: TaxRate[];
  cart: CartItem[];
  onAddToCart: (product: Product) => void;
  onUpdateQty: (productId: string, delta: number) => void;
  onClearCart: () => void;
  onCheckout: () => void;
}

export function CatalogScreen({
  categories,
  products,
  taxRates,
  cart,
  onAddToCart,
  onUpdateQty,
  onClearCart,
  onCheckout,
}: Props) {
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter((p) => {
      if (activeCat && p.categoryId !== activeCat) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, activeCat, search]);

  const defaultTax = taxRates.find((t) => t.isDefault) ?? taxRates[0];
  const taxRate = defaultTax ? Number(defaultTax.rate) / 100 : 0.1;
  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * taxRate;
  const total = subtotal + tax;
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  return (
    <div className="catalog-screen">
      {/* ── Products Panel ───────────────────────────────── */}
      <div className="catalog-main">
        <div className="catalog-header">
          <h2 className="screen-title">Products</h2>
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search products…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="cat-tabs">
          <button
            className={`cat-tab${activeCat === null ? ' active' : ''}`}
            onClick={() => setActiveCat(null)}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`cat-tab${activeCat === cat.id ? ' active' : ''}`}
              onClick={() => setActiveCat(cat.id)}
            >
              {cat.icon} {cat.name}
            </button>
          ))}
        </div>

        <div className="product-grid">
          {filtered.length === 0 ? (
            <p className="empty-state">No products found</p>
          ) : (
            filtered.map((p) => {
              const cat = categories.find((c) => c.id === p.categoryId);
              return (
                <button
                  key={p.id}
                  className={`product-card${!p.inStock ? ' out-of-stock' : ''}`}
                  onClick={() => p.inStock && onAddToCart(p)}
                  disabled={!p.inStock}
                >
                  <div className="product-icon" style={{ background: `${cat?.color ?? '#333'}22` }}>
                    {cat?.icon ?? '📦'}
                  </div>
                  <span className="product-name">{p.name}</span>
                  <span className="product-sku">{p.sku}</span>
                  <span className="product-price">{qar(p.price)}</span>
                  {!p.inStock && <span className="oos-label">Out of stock</span>}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Cart Sidebar ────────────────────────────────── */}
      <aside className="cart-sidebar">
        <div className="cart-header">
          <h3 className="cart-title">Cart</h3>
          {cart.length > 0 && (
            <button className="cart-clear-btn" onClick={onClearCart}>
              Clear
            </button>
          )}
        </div>

        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="cart-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
              <span>Cart is empty</span>
            </div>
          ) : (
            cart.map((item) => (
              <div key={item.productId} className="cart-item">
                <span className="cart-item-name">{item.name}</span>
                <div className="qty-ctrl">
                  <button className="qty-btn" onClick={() => onUpdateQty(item.productId, -1)}>
                    −
                  </button>
                  <span className="qty-val">{item.qty}</span>
                  <button className="qty-btn" onClick={() => onUpdateQty(item.productId, +1)}>
                    +
                  </button>
                </div>
                <span className="cart-item-price">{qar(item.price * item.qty)}</span>
              </div>
            ))
          )}
        </div>

        <div className="cart-footer">
          <div className="cart-line">
            <span>Subtotal</span>
            <span>{qar(subtotal)}</span>
          </div>
          <div className="cart-line">
            <span>Tax ({defaultTax ? defaultTax.rate : 10}%)</span>
            <span>{qar(tax)}</span>
          </div>
          <div className="cart-line total">
            <span>Total</span>
            <span>{qar(total)}</span>
          </div>
          <button className="checkout-btn" disabled={cartCount === 0} onClick={onCheckout}>
            Checkout →
          </button>
        </div>
      </aside>
    </div>
  );
}
