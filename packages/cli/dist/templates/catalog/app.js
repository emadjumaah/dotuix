/**
 * Product Catalog — app.js
 *
 * Uses window.__uix bridge when running inside a dotuix viewer.
 * Falls back to DEMO_DATA when opened in a plain browser.
 */

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
const DEMO_DATA = [
  {
    id: 'product:1',
    type: 'product',
    body: JSON.stringify({
      name: 'Wireless Noise-Cancelling Headphones',
      description:
        'Premium over-ear headphones with 30h battery, adaptive ANC, and Hi-Res audio certification.',
      price: 349,
      category: 'Audio',
      sku: 'AUD-WNC-001',
      badge: 'Best Seller',
    }),
  },
  {
    id: 'product:2',
    type: 'product',
    body: JSON.stringify({
      name: 'True Wireless Earbuds',
      description: '6mm dynamic drivers, IPX5 water-resistant, 8h playback + 24h charging case.',
      price: 129,
      category: 'Audio',
      sku: 'AUD-TWS-002',
    }),
  },
  {
    id: 'product:3',
    type: 'product',
    body: JSON.stringify({
      name: 'Portable Bluetooth Speaker',
      description:
        '360° surround sound, 12h playback, dustproof & waterproof (IP67), USB-C charging.',
      price: 89,
      category: 'Audio',
      sku: 'AUD-SPK-003',
    }),
  },
  {
    id: 'product:4',
    type: 'product',
    body: JSON.stringify({
      name: '4K Webcam',
      description: '3840×2160 at 30fps, autofocus, built-in stereo mic, plug-and-play USB-C.',
      price: 199,
      category: 'Cameras',
      sku: 'CAM-WBC-001',
      badge: 'New',
    }),
  },
  {
    id: 'product:5',
    type: 'product',
    body: JSON.stringify({
      name: 'Action Camera',
      description:
        '5K video, 20MP photo, 2-inch touch screen, HyperSmooth stabilisation, 60m waterproof.',
      price: 449,
      category: 'Cameras',
      sku: 'CAM-ACT-002',
    }),
  },
  {
    id: 'product:6',
    type: 'product',
    body: JSON.stringify({
      name: 'Mechanical Keyboard',
      description:
        'Compact TKL layout, hot-swap switches, per-key RGB, aluminium top plate, USB-C detachable.',
      price: 159,
      category: 'Accessories',
      sku: 'ACC-KBD-001',
    }),
  },
  {
    id: 'product:7',
    type: 'product',
    body: JSON.stringify({
      name: 'Ergonomic Mouse',
      description:
        'Vertical design, 4000 DPI optical sensor, 6 programmable buttons, silent clicks.',
      price: 69,
      category: 'Accessories',
      sku: 'ACC-MSE-002',
      badge: 'Staff Pick',
    }),
  },
  {
    id: 'product:8',
    type: 'product',
    body: JSON.stringify({
      name: 'USB-C Hub 10-in-1',
      description: '4K HDMI, 100W PD, 3×USB-A 3.0, SD/microSD, Gigabit Ethernet, 3.5mm audio.',
      price: 79,
      category: 'Accessories',
      sku: 'ACC-HUB-003',
    }),
  },
  {
    id: 'product:9',
    type: 'product',
    body: JSON.stringify({
      name: '27" 4K Monitor',
      description:
        '3840×2160 IPS, 144Hz, 1ms GtG, HDR600, USB-C 96W, height & tilt adjustable stand.',
      price: 699,
      category: 'Displays',
      sku: 'DSP-MON-001',
      badge: 'Top Rated',
    }),
  },
  {
    id: 'product:10',
    type: 'product',
    body: JSON.stringify({
      name: 'Ultrawide 34" Monitor',
      description: '3440×1440 VA, 165Hz, 1ms, HDR400, KVM switch, 3-year zero-dead-pixel warranty.',
      price: 849,
      category: 'Displays',
      sku: 'DSP-MON-002',
    }),
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allProducts = [];
let activeCategory = 'All';

// ---------------------------------------------------------------------------
// Load from bridge or demo data
// ---------------------------------------------------------------------------
async function loadProducts() {
  if (window.__uix) {
    try {
      const records = await window.__uix.data.find({ type: 'product' });
      allProducts = records.map((r) => ({
        ...r,
        body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
      }));
    } catch (e) {
      console.warn('Bridge error, using demo data', e);
      allProducts = DEMO_DATA.map((r) => ({
        ...r,
        body: JSON.parse(r.body),
      }));
    }
  } else {
    allProducts = DEMO_DATA.map((r) => ({
      ...r,
      body: JSON.parse(r.body),
    }));
  }
}

// ---------------------------------------------------------------------------
// Render categories nav
// ---------------------------------------------------------------------------
function renderCategories() {
  const nav = document.getElementById('categories');
  const cats = ['All', ...new Set(allProducts.map((p) => p.body.category).filter(Boolean))];
  nav.innerHTML = cats
    .map(
      (c) =>
        `<button class="cat-btn${
          c === activeCategory ? ' active' : ''
        }" data-cat="${c}">${c}</button>`,
    )
    .join('');
  nav.querySelectorAll('.cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      renderCategories();
      renderGrid();
    });
  });
}

// ---------------------------------------------------------------------------
// Render product grid
// ---------------------------------------------------------------------------
function renderGrid() {
  const grid = document.getElementById('grid');
  const visible =
    activeCategory === 'All'
      ? allProducts
      : allProducts.filter((p) => p.body.category === activeCategory);

  if (visible.length === 0) {
    grid.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📦</div>
        <div class="empty-msg">No products in this category</div>
      </div>`;
    return;
  }

  grid.innerHTML = visible
    .map((p) => {
      const b = p.body;
      const priceStr = b.price != null ? `$${Number(b.price).toLocaleString()}` : '';
      return `
      <article class="card">
        <div class="card-image-placeholder">📦</div>
        <div class="card-body">
          ${b.category ? `<div class="card-category">${b.category}</div>` : ''}
          <div class="card-name">${b.name ?? 'Unnamed product'}</div>
          ${b.sku ? `<div class="card-sku">${b.sku}</div>` : ''}
          ${b.description ? `<div class="card-description">${b.description}</div>` : ''}
          <div class="card-footer">
            <div class="card-price">${priceStr}</div>
            ${b.badge ? `<span class="card-badge">${b.badge}</span>` : ''}
          </div>
        </div>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  await loadProducts();

  // Update brand name from manifest if available
  if (window.__uix) {
    try {
      const m = window.__uix.manifest();
      if (m?.name) {
        document.getElementById('brand-name').textContent = m.name;
        document.title = m.name;
      }
    } catch (_) {}
  }

  renderCategories();
  renderGrid();
})();
