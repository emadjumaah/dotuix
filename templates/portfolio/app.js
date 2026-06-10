/**
 * Portfolio — app.js
 *
 * Uses window.__uix bridge when running inside a dotuix viewer.
 * Falls back to DEMO_DATA when opened in a plain browser.
 */

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
const DEMO_DATA = [
  {
    id: 'project:1',
    type: 'project',
    body: JSON.stringify({
      title: 'Brand Identity — Saffron & Co.',
      description:
        'Full brand identity for a premium spice retailer: logo, typography system, packaging, and brand guidelines. Designed for both print and digital applications.',
      category: 'Branding',
      year: 2025,
    }),
  },
  {
    id: 'project:2',
    type: 'project',
    body: JSON.stringify({
      title: 'Kiosk UI System — Gulf Mall',
      description:
        'End-to-end design of a self-service kiosk UI for a 12-store retail complex. Covers wayfinding, product discovery, and checkout flows.',
      category: 'UI/UX',
      year: 2025,
    }),
  },
  {
    id: 'project:3',
    type: 'project',
    body: JSON.stringify({
      title: 'Mobile App — Noon Fresh',
      description:
        'Redesign of the grocery delivery app: simplified checkout, smart lists, and a new recipe integration. Reduced checkout steps from 7 to 3.',
      category: 'UI/UX',
      year: 2024,
    }),
  },
  {
    id: 'project:4',
    type: 'project',
    body: JSON.stringify({
      title: 'Annual Report — Qatar Foundation',
      description:
        '200-page bilingual (Arabic/English) annual report. Custom infographics, editorial layout, and data visualisations for 18 programme areas.',
      category: 'Print',
      year: 2024,
    }),
  },
  {
    id: 'project:5',
    type: 'project',
    body: JSON.stringify({
      title: 'Website — Aldiar Real Estate',
      description:
        'Marketing site for a residential real estate developer. Arabic-first layout with 3D floor plan integration and a property configurator.',
      category: 'Web',
      year: 2025,
    }),
  },
  {
    id: 'project:6',
    type: 'project',
    body: JSON.stringify({
      title: 'Exhibition Design — Cityscape 2024',
      description:
        '600 m² exhibition stand for a property developer at Cityscape Qatar. Concept, spatial layout, wayfinding, and AV integration.',
      category: 'Exhibition',
      year: 2024,
    }),
  },
  {
    id: 'project:7',
    type: 'project',
    body: JSON.stringify({
      title: 'Icon Library — Healthcare Platform',
      description:
        '450-icon library for a regional healthcare SaaS platform. Consistent 24px/48px grid, light and filled weights, SVG + React components.',
      category: 'Illustration',
      year: 2023,
    }),
  },
  {
    id: 'project:8',
    type: 'project',
    body: JSON.stringify({
      title: 'Brand Refresh — Al Raha Group',
      description:
        'Modernisation of a 30-year-old conglomerate brand: updated logo, new colour system, and cross-division usage guidelines.',
      category: 'Branding',
      year: 2023,
    }),
  },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allProjects = [];
let activeFilter = 'All';

// ---------------------------------------------------------------------------
// Load from bridge or demo data
// ---------------------------------------------------------------------------
async function loadProjects() {
  if (window.__uix) {
    try {
      const records = await window.__uix.data.find({ type: 'project' });
      allProjects = records.map((r) => ({
        ...r,
        body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
      }));
    } catch (e) {
      console.warn('Bridge error, using demo data', e);
      allProjects = DEMO_DATA.map((r) => ({ ...r, body: JSON.parse(r.body) }));
    }
  } else {
    allProjects = DEMO_DATA.map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function categoryCounts() {
  const counts = {};
  allProjects.forEach((p) => {
    const c = p.body.category || 'Other';
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// Render sidebar filter
// ---------------------------------------------------------------------------
function renderFilter() {
  const nav = document.getElementById('filter-nav');
  const counts = categoryCounts();
  const cats = Object.keys(counts).sort();
  const total = allProjects.length;

  nav.innerHTML = [
    `<button class="filter-btn${activeFilter === 'All' ? ' active' : ''}" data-cat="All">
       All <span class="filter-btn-count">${total}</span>
     </button>`,
    ...cats.map(
      (c) =>
        `<button class="filter-btn${activeFilter === c ? ' active' : ''}" data-cat="${c}">
           ${c} <span class="filter-btn-count">${counts[c]}</span>
         </button>`,
    ),
  ].join('');

  nav.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.cat;
      renderFilter();
      renderGrid();
    });
  });
}

// ---------------------------------------------------------------------------
// Render project grid
// ---------------------------------------------------------------------------
function renderGrid() {
  const grid = document.getElementById('grid');
  const visible =
    activeFilter === 'All'
      ? allProjects
      : allProjects.filter((p) => p.body.category === activeFilter);

  // Update count in sidebar
  document.getElementById('project-count').textContent = `${
    visible.length
  } project${visible.length !== 1 ? 's' : ''}`;

  if (visible.length === 0) {
    grid.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✦</div>
        <div class="empty-msg">No projects in this category</div>
      </div>`;
    return;
  }

  grid.innerHTML = visible
    .map((p) => {
      const b = p.body;
      return `
      <article class="card">
        <div class="card-header">
          ${b.category ? `<div class="card-category">${b.category}</div>` : '<div></div>'}
          ${b.year ? `<span class="card-year">${b.year}</span>` : ''}
        </div>
        <div class="card-title">${b.title ?? 'Untitled project'}</div>
        ${b.description ? `<div class="card-description">${b.description}</div>` : ''}
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(async function init() {
  await loadProjects();

  if (window.__uix) {
    try {
      const m = window.__uix.manifest();
      if (m?.name) {
        document.getElementById('owner-name').textContent = m.name;
        document.title = m.name;
      }
    } catch (_) {}
  }

  renderFilter();
  renderGrid();
})();
