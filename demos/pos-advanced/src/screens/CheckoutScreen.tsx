import { useMemo, useState } from 'react';
import type { CartItem, TaxRate } from '../types';
import { qar } from '../utils';

type Method = 'cash' | 'card' | 'split';
type DiscountType = 'pct' | 'fixed';

interface Props {
  cart: CartItem[];
  taxRates: TaxRate[];
  onBack: () => void;
  onComplete: (data: {
    discountAmt: number;
    taxAmt: number;
    taxRateId: string;
    taxRateName: string;
    taxRatePct: number;
    method: Method;
  }) => Promise<void>;
}

export function CheckoutScreen({ cart, taxRates, onBack, onComplete }: Props) {
  const [method, setMethod] = useState<Method>('cash');
  const [discountType, setDiscountType] = useState<DiscountType>('pct');
  const [discountVal, setDiscountVal] = useState('');
  const [taxRateId, setTaxRateId] = useState(
    () => taxRates.find((t) => t.isDefault)?.id ?? taxRates[0]?.id ?? '',
  );
  const [completing, setCompleting] = useState(false);

  const rawSubtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);

  const { discountAmt, subtotal, taxAmt, total, selectedTax } = useMemo(() => {
    const dv = Number.parseFloat(discountVal) || 0;
    const dAmt = discountType === 'pct' ? rawSubtotal * (dv / 100) : Math.min(dv, rawSubtotal);
    const sub = rawSubtotal - dAmt;
    const tax = taxRates.find((t) => t.id === taxRateId) ?? taxRates[0];
    const tAmt = sub * ((tax?.rate ?? 0) / 100);
    return {
      discountAmt: dAmt,
      subtotal: rawSubtotal,
      taxAmt: tAmt,
      total: sub + tAmt,
      selectedTax: tax,
    };
  }, [rawSubtotal, discountVal, discountType, taxRateId, taxRates]);

  async function handleComplete() {
    if (completing || cart.length === 0) return;
    setCompleting(true);
    await onComplete({
      discountAmt,
      taxAmt,
      taxRateId,
      taxRateName: selectedTax?.name ?? '',
      taxRatePct: selectedTax?.rate ?? 0,
      method,
    });
    setCompleting(false);
  }

  const METHODS: { id: Method; label: string }[] = [
    { id: 'cash', label: 'Cash' },
    { id: 'card', label: 'Card' },
    { id: 'split', label: 'Split' },
  ];

  return (
    <div className="checkout-screen">
      <div className="checkout-header">
        <button className="back-btn" onClick={onBack}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            width={18}
            height={18}
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h2 className="screen-title">Checkout</h2>
      </div>

      <div className="checkout-body">
        {/* ── Left: Items + Discount + Tax ─────────────── */}
        <div className="checkout-left">
          <div className="card-box">
            <h3 className="card-box-title">Order Items</h3>
            {cart.map((item) => (
              <div key={item.productId} className="order-item-row">
                <span className="order-item-name">{item.name}</span>
                <span className="order-item-qty">×{item.qty}</span>
                <span className="order-item-price">{qar(item.price * item.qty)}</span>
              </div>
            ))}
          </div>

          <div className="card-box">
            <h3 className="card-box-title">Discount</h3>
            <div className="discount-row">
              <input
                className="discount-input"
                type="number"
                min={0}
                placeholder="0"
                value={discountVal}
                onChange={(e) => setDiscountVal(e.target.value)}
              />
              <button
                className={`disc-type-btn${discountType === 'pct' ? ' active' : ''}`}
                onClick={() => setDiscountType('pct')}
              >
                %
              </button>
              <button
                className={`disc-type-btn${discountType === 'fixed' ? ' active' : ''}`}
                onClick={() => setDiscountType('fixed')}
              >
                QAR
              </button>
            </div>
          </div>

          <div className="card-box">
            <h3 className="card-box-title">Tax Rate</h3>
            <select
              className="tax-select"
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
            >
              {taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.rate}%)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Right: Payment + Summary ─────────────────── */}
        <div className="checkout-right">
          <div className="card-box">
            <h3 className="card-box-title">Payment Method</h3>
            <div className="payment-methods">
              {METHODS.map(({ id, label }) => (
                <button
                  key={id}
                  className={`pay-btn${method === id ? ' active' : ''}`}
                  onClick={() => setMethod(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="card-box">
            <h3 className="card-box-title">Summary</h3>
            <div className="summary-line">
              <span>Subtotal</span>
              <span>{qar(subtotal)}</span>
            </div>
            <div className="summary-line">
              <span>
                Discount
                {discountType === 'pct' && Number.parseFloat(discountVal) > 0
                  ? ` (${discountVal}%)`
                  : ''}
              </span>
              <span>- {qar(discountAmt)}</span>
            </div>
            <div className="summary-line">
              <span>
                {selectedTax?.name ?? 'Tax'} ({selectedTax?.rate ?? 0}%)
              </span>
              <span>{qar(taxAmt)}</span>
            </div>
            <div className="summary-line total">
              <span>Total</span>
              <span>{qar(total)}</span>
            </div>
          </div>

          <button
            className="complete-btn"
            disabled={cart.length === 0 || completing}
            onClick={handleComplete}
          >
            {completing ? 'Processing…' : 'Complete Order'}
          </button>
        </div>
      </div>
    </div>
  );
}
