/**
 * مطعم المدينة — app.js
 *
 * Uses the window.__uix bridge injected by the dotuix viewer.
 * Falls back to DEMO_DATA when running outside a viewer (plain browser preview).
 */

// ---------------------------------------------------------------------------
// Demo data — full Gulf restaurant menu
// ---------------------------------------------------------------------------
const DEMO_DATA = [
  // ── رئيسية ────────────────────────────────────────────────────────────────
  {
    id: 'p:01',
    type: 'product',
    body: JSON.stringify({
      name: 'كبسة لحم',
      description: 'لحم ضأن طازج مع أرز بسمتي مُتبَّل بالزعفران والهيل',
      price: 65,
      category: 'رئيسية',
      badge: 'الأكثر طلباً',
    }),
  },
  {
    id: 'p:02',
    type: 'product',
    body: JSON.stringify({
      name: 'مندي الدجاج',
      description: 'دجاج مطهو ببطء على الجمر مع الأرز البسمتي والتوابل اليمنية',
      price: 48,
      category: 'رئيسية',
    }),
  },
  {
    id: 'p:03',
    type: 'product',
    body: JSON.stringify({
      name: 'مظبي الضأن',
      description: 'ضأن مشوي على الفحم مع الأرز والصلصة الحارة',
      price: 72,
      category: 'رئيسية',
    }),
  },
  {
    id: 'p:04',
    type: 'product',
    body: JSON.stringify({
      name: 'برياني الدجاج',
      description: 'أرز بسمتي طويل الحبة مع الدجاج والبهارات الهندية',
      price: 42,
      category: 'رئيسية',
    }),
  },
  {
    id: 'p:05',
    type: 'product',
    body: JSON.stringify({
      name: 'جريش بالدجاج',
      description: 'جريش قمح مطهو ببطء مع الدجاج المشوي والتمر',
      price: 38,
      category: 'رئيسية',
      badge: 'طبق الموسم',
    }),
  },
  // ── مشويات ────────────────────────────────────────────────────────────────
  {
    id: 'p:06',
    type: 'product',
    body: JSON.stringify({
      name: 'شاورما لحم',
      description: 'لحم عجل مشوي على الأسياخ مع الثوم والتوم والخيار المخلل',
      price: 28,
      category: 'مشويات',
    }),
  },
  {
    id: 'p:07',
    type: 'product',
    body: JSON.stringify({
      name: 'كفتة مشكلة',
      description: 'كفتة لحم وكفتة دجاج مع الأرز والسلطة',
      price: 35,
      category: 'مشويات',
    }),
  },
  {
    id: 'p:08',
    type: 'product',
    body: JSON.stringify({
      name: 'مشاوي مشكلة — للشخصين',
      description: 'تشكيلة من الكفتة والشيش والأجنحة مع الأرز والمقبلات',
      price: 95,
      category: 'مشويات',
      badge: 'للشخصين',
    }),
  },
  {
    id: 'p:09',
    type: 'product',
    body: JSON.stringify({
      name: 'شيش طاووق',
      description: 'دجاج متبل بالليمون والثوم مشوي على الأسياخ',
      price: 30,
      category: 'مشويات',
    }),
  },
  // ── مقبلات ────────────────────────────────────────────────────────────────
  {
    id: 'p:10',
    type: 'product',
    body: JSON.stringify({
      name: 'حمص بالطحينة',
      description: 'حمص كريمي مع زيت الزيتون البكر والبابريكا المدخنة',
      price: 15,
      category: 'مقبلات',
    }),
  },
  {
    id: 'p:11',
    type: 'product',
    body: JSON.stringify({
      name: 'فتوش',
      description: 'خضروات طازجة مع خبز محمص ودبس الرمان',
      price: 18,
      category: 'مقبلات',
    }),
  },
  {
    id: 'p:12',
    type: 'product',
    body: JSON.stringify({
      name: 'شوربة عدس',
      description: 'عدس أحمر مع الكمون والليمون، تُقدَّم مع الخبز',
      price: 14,
      category: 'مقبلات',
    }),
  },
  {
    id: 'p:13',
    type: 'product',
    body: JSON.stringify({
      name: 'متبل',
      description: 'باذنجان مشوي مهروس مع الطحينة والثوم والليمون',
      price: 14,
      category: 'مقبلات',
    }),
  },
  // ── مشروبات ──────────────────────────────────────────────────────────────
  {
    id: 'p:14',
    type: 'product',
    body: JSON.stringify({
      name: 'قهوة عربية',
      description: 'قهوة خفيفة بالهيل والزعفران — تُقدَّم مع التمر',
      price: 10,
      category: 'مشروبات',
    }),
  },
  {
    id: 'p:15',
    type: 'product',
    body: JSON.stringify({
      name: 'شاي كرك',
      description: 'شاي هندي بالهيل والزنجبيل والحليب المكثف',
      price: 8,
      category: 'مشروبات',
    }),
  },
  {
    id: 'p:16',
    type: 'product',
    body: JSON.stringify({
      name: 'عصير مانجو',
      description: 'مانجو ألفونسو طازجة — بدون إضافات',
      price: 14,
      category: 'مشروبات',
    }),
  },
  {
    id: 'p:17',
    type: 'product',
    body: JSON.stringify({
      name: 'لبن عيران',
      description: 'لبن مثلج بالنعناع — منعش ومفيد',
      price: 8,
      category: 'مشروبات',
    }),
  },
  {
    id: 'p:18',
    type: 'product',
    body: JSON.stringify({
      name: 'ماء معدني',
      description: '500 مل',
      price: 3,
      category: 'مشروبات',
    }),
  },
];

// ---------------------------------------------------------------------------
// Bridge — use __uix if available, otherwise fall back to demo data
// ---------------------------------------------------------------------------
const bridge = window.__uix ?? null;

async function fetchProducts() {
  if (bridge?.data) {
    const records = await bridge.data.find({ type: 'product' });
    if (records.length > 0) {
      return records.map((r) => ({ ...r, body: JSON.parse(r.body) }));
    }
  }
  return DEMO_DATA.map((r) => ({ ...r, body: JSON.parse(r.body) }));
}

// ---------------------------------------------------------------------------
// Cart state — persisted to state.db via the __uix bridge
// ---------------------------------------------------------------------------

const cart = []; // [{ product, qty, stateId: string|null }]

const cartTotal = () => cart.reduce((sum, item) => sum + item.product.body.price * item.qty, 0);

async function addToCart(product) {
  const existing = cart.find((i) => i.product.id === product.id);
  if (existing) {
    existing.qty += 1;
    if (bridge?.state && existing.stateId) {
      await bridge.state.update(
        existing.stateId,
        JSON.stringify({ product_id: product.id, qty: existing.qty }),
      );
    }
  } else {
    let stateId = null;
    if (bridge?.state) {
      const rec = await bridge.state.insert({
        type: 'cart_item',
        body: JSON.stringify({ product_id: product.id, qty: 1 }),
      });
      stateId = rec?.id ?? null;
    }
    cart.push({ product, qty: 1, stateId });
  }
  renderCart();
}

async function removeFromCart(productId) {
  const idx = cart.findIndex((i) => i.product.id === productId);
  if (idx === -1) return;
  const item = cart[idx];
  if (bridge?.state && item.stateId) {
    await bridge.state.delete(item.stateId);
  }
  cart.splice(idx, 1);
  renderCart();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let allProducts = [];
let activeCategory = null;

function renderCategories(products) {
  const cats = ['الكل', ...new Set(products.map((p) => p.body.category))];
  const nav = document.getElementById('categories');
  nav.innerHTML = '';

  for (const cat of cats) {
    const btn = document.createElement('button');
    btn.textContent = cat;
    const isActive = (cat === 'الكل' && activeCategory === null) || activeCategory === cat;
    if (isActive) btn.classList.add('active');
    btn.addEventListener('click', () => {
      activeCategory = cat === 'الكل' ? null : cat;
      renderCategories(allProducts);
      renderMenu(allProducts);
    });
    nav.appendChild(btn);
  }
}

function renderMenu(products) {
  const visible = activeCategory
    ? products.filter((p) => p.body.category === activeCategory)
    : products;

  const menu = document.getElementById('menu');
  menu.innerHTML = '';

  if (visible.length === 0) {
    menu.innerHTML = '<p class="empty">لا توجد عناصر في هذا القسم</p>';
    return;
  }

  for (const product of visible) {
    const { name, description, price, badge } = product.body;
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <div class="info">
        <div class="name-row">
          <span class="name">${name}</span>
          ${badge ? `<span class="badge">${badge}</span>` : ''}
        </div>
        <span class="desc">${description ?? ''}</span>
        <div class="footer">
          <span class="price">${price} ر.ق</span>
          <button class="btn-add" data-id="${product.id}">+ أضف</button>
        </div>
      </div>
    `;
    card.querySelector('.btn-add').addEventListener('click', () => addToCart(product));
    menu.appendChild(card);
  }
}

function renderCart() {
  const list = document.getElementById('cart-items');
  const totalEl = document.getElementById('cart-total-price');

  list.innerHTML = '';

  if (cart.length === 0) {
    list.innerHTML = '<li class="empty">السلة فارغة</li>';
  } else {
    for (const { product, qty } of cart) {
      const li = document.createElement('li');
      li.className = 'cart-item';
      li.innerHTML = `
        <span class="ci-name">${product.body.name} × ${qty}</span>
        <span class="ci-price">${product.body.price * qty} ر.ق</span>
        <button class="ci-remove" title="إزالة">✕</button>
      `;
      li.querySelector('.ci-remove').addEventListener('click', () => removeFromCart(product.id));
      list.appendChild(li);
    }
  }

  totalEl.textContent = `${cartTotal()} ر.ق`;
}

// ---------------------------------------------------------------------------
// Order submission
// ---------------------------------------------------------------------------
async function handleOrder() {
  if (cart.length === 0) return;

  if (bridge?.state) {
    await bridge.state.insert({
      type: 'order',
      body: JSON.stringify({
        items: cart.map((i) => ({ productId: i.product.id, qty: i.qty })),
        total: cartTotal(),
        placedAt: new Date().toISOString(),
      }),
    });
    // Remove all cart_item records from state.db
    for (const item of cart) {
      if (item.stateId) await bridge.state.delete(item.stateId);
    }
  }

  cart.length = 0;
  renderCart();
  showToast('تم إرسال طلبك بنجاح! شكراً لاختيارك مطعم المدينة ✓');
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
(async () => {
  allProducts = await fetchProducts();

  // Restore cart from state.db (persisted across viewer sessions)
  if (bridge?.state) {
    const savedItems = await bridge.state.find({ type: 'cart_item' });
    for (const rec of savedItems) {
      try {
        const data = JSON.parse(rec.body);
        const product = allProducts.find((p) => p.id === data.product_id);
        if (product) cart.push({ product, qty: data.qty, stateId: rec.id });
      } catch {
        // malformed record — skip
      }
    }
  }

  renderCategories(allProducts);
  renderMenu(allProducts);
  renderCart();
  document.getElementById('btn-order').addEventListener('click', handleOrder);
})();
