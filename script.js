/* ============================================================
   script.js — Nexus Analytics Dashboard
   Fixed auth flow: onAuthStateChanged drives everything.
   No setInterval polling. No race conditions.
   ============================================================ */

'use strict';

import { auth, db } from './firebase.js';
import { onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, getDocs, deleteDoc,
  doc, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log('[script.js] Module loaded');

/* ============================================================
   STATE
   ============================================================ */
let currentUser = null;
let orders      = [];
let sortCol     = 'date';
let sortDir     = 'desc';
let filterText  = '';
let filterStat  = '';
let tablePage = 1;
const PAGE_SIZE = 8;
let charts      = {};

const $ = id => document.getElementById(id);

/* ============================================================
   AUTH GATE — This is the SINGLE place that controls the
   loader, the app visibility, and redirection.

   Flow:
   1. Page loads → loader is visible, #app is display:none
   2. onAuthStateChanged fires (always fires once on load)
   3a. If user is null  → redirect to login.html
   3b. If user exists   → hide loader, show app, boot dashboard
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
  console.log('[script.js] onAuthStateChanged fired. User:', user ? user.email : 'null');

  if (!user) {
    // Not authenticated — send to login page
    console.log('[script.js] No user → redirecting to login.html');
    window.location.replace('login.html');
    return;
  }

  // ── User is authenticated ──────────────────────────────────
  currentUser = user;
  console.log('[script.js] Authenticated as:', user.email, '| uid:', user.uid);

  // Populate name/avatar in navbar and sidebar
  const displayName = user.displayName || user.email.split('@')[0];
  const initials    = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const nameEls   = ['navName', 'sidebarName'];
  const avatarEls = ['navAvatar', 'sidebarAvatar'];
  nameEls.forEach(id   => { const el = $(id);   if (el) el.textContent = displayName; });
  avatarEls.forEach(id => { const el = $(id);   if (el) el.textContent = initials; });

  const welcomeEl = $('welcomeMsg');
  if (welcomeEl) welcomeEl.textContent = 'Welcome back, ' + displayName.split(' ')[0] + '. Here\'s what\'s happening today.';

  // ── Show app IMMEDIATELY — never block loader on Firestore ──
  // Auth is confirmed. Reveal the dashboard shell right now.
  // Data loads in the background and updates the UI when ready.
  const loader = $('loader');
  const app    = $('app');
  if (loader) loader.classList.add('hidden');
  if (app)    app.style.display = '';
  console.log('[script.js] Loader hidden, app visible');

  // Boot dashboard UI instantly with empty state
  initDashboard();

  // Seed + fetch in background — UI updates when data arrives
  try {
    await seedDefaultOrdersIfNeeded();
    orders = await fetchOrders();
    console.log('[script.js] Orders loaded:', orders.length);
    // Refresh UI with real data
    updateKPIs();
    renderTable();
    renderDashboardOrders();
  } catch (err) {
    console.error('[script.js] Firestore error:', err.message);
    orders = [];
    updateKPIs();
    renderTable();
    renderDashboardOrders();
  }
});

/* ── Logout ── */
const logoutBtn = $('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    console.log('[script.js] Signing out...');
    await signOut(auth);
    window.location.replace('login.html');
  });
}

/* ============================================================
   FIRESTORE — Orders
   ============================================================ */
function ordersCol() {
  return collection(db, 'users', currentUser.uid, 'orders');
}

async function seedDefaultOrdersIfNeeded() {
  const snap = await getDocs(ordersCol());
  if (!snap.empty) return;
  console.log('[script.js] Seeding default orders...');
  const defaults = [
    { id:'#10001', customer:'Aarav Mehta',    product:'Analytics Pro',    amount:12499, status:'paid',      date:'2024-11-03' },
    { id:'#10002', customer:'Priya Sharma',   product:'Starter Pack',     amount:3999,  status:'pending',   date:'2024-11-05' },
    { id:'#10003', customer:'Rohan Verma',    product:'Enterprise Suite', amount:49999, status:'paid',      date:'2024-11-07' },
    { id:'#10004', customer:'Sneha Kapoor',   product:'Analytics Pro',    amount:12499, status:'cancelled', date:'2024-11-08' },
    { id:'#10005', customer:'Vikram Singh',   product:'Growth Bundle',    amount:8999,  status:'paid',      date:'2024-11-10' },
    { id:'#10006', customer:'Nisha Patel',    product:'Starter Pack',     amount:3999,  status:'pending',   date:'2024-11-12' },
    { id:'#10007', customer:'Arjun Rao',      product:'Enterprise Suite', amount:49999, status:'paid',      date:'2024-11-14' },
    { id:'#10008', customer:'Kavya Nair',     product:'Analytics Pro',    amount:12499, status:'paid',      date:'2024-11-15' },
    { id:'#10009', customer:'Deepak Joshi',   product:'Growth Bundle',    amount:8999,  status:'cancelled', date:'2024-11-17' },
    { id:'#10010', customer:'Meera Gupta',    product:'Starter Pack',     amount:3999,  status:'paid',      date:'2024-11-19' },
    { id:'#10011', customer:'Karan Bhatia',   product:'Enterprise Suite', amount:49999, status:'pending',   date:'2024-11-20' },
    { id:'#10012', customer:'Ananya Reddy',   product:'Analytics Pro',    amount:12499, status:'paid',      date:'2024-11-22' },
    { id:'#10013', customer:'Suresh Iyer',    product:'Growth Bundle',    amount:8999,  status:'paid',      date:'2024-11-24' },
    { id:'#10014', customer:'Pooja Malhotra', product:'Starter Pack',     amount:3999,  status:'cancelled', date:'2024-11-25' },
    { id:'#10015', customer:'Rahul Chopra',   product:'Enterprise Suite', amount:49999, status:'paid',      date:'2024-11-28' },
  ];
  // Write all 15 docs in PARALLEL — not sequentially.
  // Sequential writes (the old code) took 5-10 seconds on first login.
  // Promise.all fires all writes at once — completes in ~1 round-trip.
  await Promise.all(
    defaults.map(o => addDoc(ordersCol(), { ...o, createdAt: serverTimestamp() }))
  );
  console.log('[script.js] Default orders seeded (parallel)');
}

async function fetchOrders() {
  const snap = await getDocs(query(ordersCol(), orderBy('createdAt', 'desc')));
  return snap.docs.map(d => ({ _firestoreId: d.id, ...d.data() }));
}

async function addOrderToFirestore(order) {
  const ref = await addDoc(ordersCol(), { ...order, createdAt: serverTimestamp() });
  return ref.id;
}

async function deleteOrderFromFirestore(firestoreId) {
  await deleteDoc(doc(db, 'users', currentUser.uid, 'orders', firestoreId));
}

/* ============================================================
   DASHBOARD INIT — called only after auth is confirmed
   ============================================================ */
function initDashboard() {
  console.log('[script.js] initDashboard()');
  setupTheme();
  setupSidebar();
  setupNavbar();
  setupModal();
  setupTableControls();
  setupExport();
  updateKPIs();
  renderTable();
  initCharts();
  setDefaultDate();
  console.log('[script.js] Dashboard ready');
}

/* ============================================================
   THEME
   ============================================================ */
function setupTheme() {
  const saved = localStorage.getItem('nexus_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);

  const btn = $('themeToggle');
  if (btn) btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('nexus_theme', next);
    updateThemeIcon(next);
    refreshChartColors();
  });
}
function updateThemeIcon(theme) {
  const icon = $('themeIcon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

/* ============================================================
   NAVIGATION — SPA router
   ============================================================ */
let currentPage = 'dashboard';
let analyticsChartsInit = false;

function navigateTo(page) {
  if (currentPage === page) return;
  currentPage = page;

  // Update page sections
  document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
  const target = document.querySelector('.page-section[data-page="' + page + '"]');
  if (target) target.classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.page === page);
  });

  // Page-specific actions
  if (page === 'orders') {
    tablePage = 1;
    renderTable();
  }
  if (page === 'analytics' && !analyticsChartsInit) {
    analyticsChartsInit = true;
    initAnalyticsCharts();
  }
  if (page === 'customers') {
    renderCustomers();
  }
  if (page === 'settings') {
    // Sync dark mode toggle in settings with current theme
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const chk = $('settingsDarkCheck');
    if (chk) {
      chk.checked = isDark;
      chk.addEventListener('change', () => {
        const next = chk.checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('nexus_theme', next);
        updateThemeIcon(next);
        refreshChartColors();
      });
    }
    // Populate account info
    if (currentUser) {
      const el = $('settingsName'); if (el) el.textContent = currentUser.displayName || '—';
      const el2 = $('settingsEmail'); if (el2) el2.textContent = currentUser.email || '—';
    }
  }
  if (page === 'help') {
    // Wire up FAQ accordion
    document.querySelectorAll('.faq-item').forEach(item => {
      const q = item.querySelector('.faq-q');
      if (q && !q._wired) {
        q._wired = true;
        q.addEventListener('click', () => item.classList.toggle('open'));
      }
    });
  }

  // Scroll content area back to top
  const ca = $('contentArea'); if (ca) ca.scrollTop = 0;
  window.scrollTo(0, 0);
}

/* ============================================================
   SIDEBAR — collapse + mobile + navigation
   ============================================================ */
function setupSidebar() {
  let collapsed = false;
  const sidebar  = $('sidebar');
  const mainEl   = $('main');

  // Mobile overlay
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('show');
  });

  const toggleBtn = $('sidebarToggle');
  const mobileBtn = $('mobileToggle');
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    sidebar.classList.toggle('collapsed', collapsed);
    mainEl.classList.toggle('expanded', collapsed);
  });
  if (mobileBtn) mobileBtn.addEventListener('click', () => {
    sidebar.classList.add('mobile-open');
    overlay.classList.add('show');
  });

  // ── Nav item clicks — this is the router entry point ──────
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const page = item.dataset.page;
      if (page) navigateTo(page);
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('show');
    });
  });

  // "View all orders" link on dashboard recent orders table
  const viewAll = $('viewAllOrders');
  if (viewAll) viewAll.addEventListener('click', e => { e.preventDefault(); navigateTo('orders'); });

  // Orders page "Add Order" button (mirrors the dashboard one)
  const btn2 = $('openModalBtn2');
  if (btn2) btn2.addEventListener('click', openModal);
  const expBtn2 = $('exportBtn2');
  if (expBtn2) expBtn2.addEventListener('click', () => {
    const rows = [['Order ID','Customer','Product','Amount','Status','Date'],
      ...orders.map(o => [o.id, o.customer, o.product, o.amount, o.status, o.date])];
    const csv  = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type:'text/csv' })),
      download: 'nexus_orders.csv'
    });
    a.click(); URL.revokeObjectURL(a.href);
    showToast('CSV exported!');
  });
}

/* ============================================================
   NAVBAR (profile dropdown + notifications)
   ============================================================ */
function setupNavbar() {
  const profileMenu = $('profileMenu');
  const notifPanel  = $('notifPanel');

  $('profileTrigger')?.addEventListener('click', e => {
    e.stopPropagation();
    profileMenu.classList.toggle('open');
    notifPanel.classList.remove('open');
  });
  $('notifBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    notifPanel.classList.toggle('open');
    profileMenu.classList.remove('open');
  });
  document.addEventListener('click', () => {
    profileMenu?.classList.remove('open');
    notifPanel?.classList.remove('open');
  });
  notifPanel?.addEventListener('click', e => e.stopPropagation());
  document.querySelector('.notif-clear')?.addEventListener('click', () => {
    document.querySelectorAll('.notif-item.unread').forEach(i => i.classList.remove('unread'));
    document.querySelector('.notif-dot').style.display = 'none';
  });
}

/* ============================================================
   MODAL
   ============================================================ */
function setupModal() {
  $('openModalBtn')?.addEventListener('click', openModal);
  $('modalClose')?.addEventListener('click', closeModal);
  $('cancelModal')?.addEventListener('click', closeModal);
  $('modalOverlay')?.addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });

  $('submitOrder')?.addEventListener('click', async () => {
    const customer = $('formCustomer').value.trim();
    const product  = $('formProduct').value.trim();
    const amount   = parseFloat($('formAmount').value);
    const status   = $('formStatus').value;
    const date     = $('formDate').value;
    const btn      = $('submitOrder');

    if (!customer || !product || !amount || amount <= 0) {
      $('formError').classList.remove('hidden'); return;
    }
    $('formError').classList.add('hidden');

    const nextId   = '#' + (10000 + orders.length + 1);
    const newOrder = { id: nextId, customer, product, amount, status, date };

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner" style="animation:spin .8s linear infinite;display:inline-block"></i> Saving...';

    try {
      const fsId = await addOrderToFirestore(newOrder);
      newOrder._firestoreId = fsId;
      orders.unshift(newOrder);
      tablePage = 1;
      updateKPIs();
      renderTable();
      closeModal();
      showToast('Order ' + nextId + ' saved!');
    } catch (err) {
      console.error('[script.js] Save order error:', err);
      showToast('Error saving order.', true);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Save Order';
    }
  });
}

function openModal()  { $('modalOverlay').classList.add('open'); }
function closeModal() { $('modalOverlay').classList.remove('open'); clearForm(); }
function clearForm()  {
  ['formCustomer','formProduct','formAmount'].forEach(id => $(id).value = '');
  $('formStatus').value = 'paid';
  setDefaultDate();
  $('formError').classList.add('hidden');
}
function setDefaultDate() {
  const el = $('formDate');
  if (el) el.value = new Date().toISOString().slice(0, 10);
}

/* ============================================================
   DELETE / VIEW ORDER
   ============================================================ */
window.deleteOrder = async function(id) {
  if (!confirm('Delete order ' + id + '?')) return;
  const order = orders.find(o => o.id === id);
  if (!order) return;
  try {
    await deleteOrderFromFirestore(order._firestoreId);
    orders = orders.filter(o => o.id !== id);
    updateKPIs(); renderTable();
    showToast('Order ' + id + ' deleted.');
  } catch (err) {
    console.error('[script.js] Delete error:', err);
    showToast('Error deleting order.', true);
  }
};

window.viewOrder = function(id) {
  const o = orders.find(x => x.id === id);
  if (o) showToast(o.id + ' · ' + o.customer + ' · ₹' + o.amount.toLocaleString('en-IN') + ' · ' + o.status);
};

/* ============================================================
   TABLE CONTROLS
   ============================================================ */
function setupTableControls() {
  $('tableSearch')?.addEventListener('input', e => {
    filterText = e.target.value; tablePage = 1; renderTable();
  });
  $('statusFilter')?.addEventListener('change', e => {
    filterStat = e.target.value; tablePage = 1; renderTable();
  });
  $('globalSearch')?.addEventListener('input', e => {
    filterText = e.target.value;
    const ts = $('tableSearch'); if (ts) ts.value = filterText;
    tablePage = 1; renderTable();
  });
  $('sortBtn')?.addEventListener('click', () => {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc'; renderTable();
  });
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortDir = (sortCol === col && sortDir === 'asc') ? 'desc' : 'asc';
      sortCol = col; tablePage = 1; renderTable();
    });
  });
}

/* ============================================================
   EXPORT
   ============================================================ */
function setupExport() {
  $('exportBtn')?.addEventListener('click', () => {
    const rows = [['Order ID','Customer','Product','Amount','Status','Date'],
      ...orders.map(o => [o.id, o.customer, o.product, o.amount, o.status, o.date])];
    const csv  = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type:'text/csv' })),
      download: 'nexus_orders.csv'
    });
    a.click(); URL.revokeObjectURL(a.href);
    showToast('CSV exported!');
  });
}

/* ============================================================
   KPI CARDS
   ============================================================ */
function updateKPIs() {
  const paid    = orders.filter(o => o.status === 'paid');
  const revenue = paid.reduce((s, o) => s + o.amount, 0);
  animateCounter('kpiRevenue',   revenue,                                    true);
  animateCounter('kpiProfit',    Math.round(revenue * 0.34),                 true);
  animateCounter('kpiOrders',    orders.length,                              false);
  animateCounter('kpiCustomers', new Set(orders.map(o => o.customer)).size,  false);
}

function animateCounter(id, target, isCurrency) {
  const el = $(id); if (!el) return;
  const duration = 1200, t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / duration, 1);
    const v = Math.round((1 - Math.pow(1 - p, 3)) * target);
    el.textContent = isCurrency ? '₹' + v.toLocaleString('en-IN') : v.toLocaleString('en-IN');
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ============================================================
   TABLE RENDER
   ============================================================ */
function getFiltered() {
  return orders
    .filter(o => {
      const q = filterText.toLowerCase();
      return (!q || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(q)))
          && (!filterStat || o.status === filterStat);
    })
    .sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === 'amount') { va = +va; vb = +vb; }
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sortDir === 'asc' ? 1 : -1);
    });
}

function renderTable() {
  const filtered   = getFiltered();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (tablePage > totalPages) tablePage = totalPages;
  const slice = filtered.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE);
  const body  = $('ordersBody');
  if (!body) return;

  body.innerHTML = slice.length
    ? slice.map(o => `
        <tr>
          <td><span class="order-id">${o.id}</span></td>
          <td><span class="order-customer">${esc(o.customer)}</span></td>
          <td><span class="order-product">${esc(o.product)}</span></td>
          <td><span class="order-amount">₹${o.amount.toLocaleString('en-IN')}</span></td>
          <td><span class="badge badge-${o.status}">${o.status}</span></td>
          <td>${fmtDate(o.date)}</td>
          <td>
            <div class="action-row">
              <button class="icon-btn" onclick="viewOrder('${o.id}')"><i class="fa-solid fa-eye"></i></button>
              <button class="icon-btn del" onclick="deleteOrder('${o.id}')"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </td>
        </tr>`).join('')
    : `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-3)">No orders found</td></tr>`;

  const count = filtered.length;
  const lbl = $('orderCountLabel'); if (lbl) lbl.textContent = count + ' order' + (count !== 1 ? 's' : '') + ' found';
  const inf = $('tableInfo');       if (inf) inf.textContent  = count + ' order' + (count !== 1 ? 's' : '');
  renderPagination(totalPages);
}

function renderPagination(total) {
  const pag = $('pagination'); if (!pag) return;
  let h = `<button class="page-btn" onclick="goPage(${tablePage-1})" ${tablePage<=1?'disabled':''}><i class="fa-solid fa-chevron-left"></i></button>`;
  for (let i = 1; i <= total; i++)
    h += `<button class="page-btn ${i===tablePage?'active':''}" onclick="goPage(${i})">${i}</button>`;
  h += `<button class="page-btn" onclick="goPage(${tablePage+1})" ${tablePage>=total?'disabled':''}"><i class="fa-solid fa-chevron-right"></i></button>`;
  pag.innerHTML = h;
}

window.goPage = function(p) {
  const t = Math.ceil(getFiltered().length / PAGE_SIZE);
  if (p >= 1 && p <= t) { tablePage = p; renderTable(); }
};

/* ============================================================
   CHARTS
   ============================================================ */
function initCharts() {
  if (typeof Chart === 'undefined') {
    console.warn('[script.js] Chart.js not loaded yet — skipping charts');
    return;
  }
  Chart.defaults.font.family = "'DM Sans', sans-serif";

  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateRevenueChart(parseInt(btn.dataset.range));
    });
  });

  initRevenueChart();
  initCategoryChart();
  initProfitChart();
  initTrafficChart();
  initSparkline('sparkRevenue',   [38,42,39,51,47,59,63,60,71,68,75,82], '#6C63FF');
  initSparkline('sparkProfit',    [28,31,29,36,35,42,48,45,53,51,57,62], '#00D4AA');
  initSparkline('sparkOrders',    [12,14,11,16,15,18,20,17,22,21,24,26], '#FFA94D');
  initSparkline('sparkCustomers', [8,9,10,11,10,13,14,13,16,15,18,20],   '#FF6B6B');
}

function cssVar(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function chartDef() { return { t2: cssVar('--text-2') || '#8B90B8', bd: cssVar('--border') || 'rgba(255,255,255,.08)' }; }

const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const REVENUES = [382000,445000,398000,512000,467000,589000,634000,598000,712000,681000,758000,824000];

function revSlice(n) { return { labels: MONTHS.slice(-n), data: REVENUES.slice(-n) }; }

function ttOpts(labelFn) {
  return { backgroundColor:'#1C1F35',titleColor:'#E8EAFF',bodyColor:'#8B90B8',
           borderColor:'rgba(255,255,255,.08)',borderWidth:1,padding:12,cornerRadius:10,
           callbacks:{ label: labelFn } };
}

function initRevenueChart() {
  const el = document.getElementById('revenueChart'); if (!el) return;
  const ctx = el.getContext('2d');
  const { labels, data } = revSlice(12);
  const { t2, bd } = chartDef();
  const grad = ctx.createLinearGradient(0,0,0,240);
  grad.addColorStop(0,'rgba(108,99,255,.3)'); grad.addColorStop(1,'rgba(108,99,255,0)');
  charts.revenue = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ label:'Revenue', data, borderColor:'#6C63FF', backgroundColor:grad,
           borderWidth:2.5, pointBackgroundColor:'#6C63FF', pointBorderColor:'#fff',
           pointBorderWidth:2, pointRadius:4, pointHoverRadius:6, tension:.45, fill:true }] },
    options:{ responsive:true, maintainAspectRatio:true, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{display:false}, tooltip:ttOpts(c=>' ₹'+c.raw.toLocaleString('en-IN')) },
      scales:{ x:{grid:{color:bd},ticks:{color:t2,font:{size:11}}},
               y:{grid:{color:bd},ticks:{color:t2,font:{size:11},callback:v=>'₹'+(v/1000)+'k'}} } }
  });
}

function updateRevenueChart(n=12) {
  if (!charts.revenue) return;
  const { labels, data } = revSlice(n);
  charts.revenue.data.labels = labels;
  charts.revenue.data.datasets[0].data = data;
  charts.revenue.update();
}

function initCategoryChart() {
  const el = document.getElementById('categoryChart'); if (!el) return;
  charts.category = new Chart(el.getContext('2d'), {
    type:'pie',
    data:{ labels:['Analytics Pro','Enterprise Suite','Growth Bundle','Starter Pack','Add-ons'],
           datasets:[{ data:[34,28,18,13,7],
             backgroundColor:['#6C63FF','#00D4AA','#FFA94D','#FF6B6B','#B46CFF'],
             borderColor:'transparent', hoverOffset:8 }] },
    options:{ responsive:true, maintainAspectRatio:true,
      plugins:{ legend:{position:'bottom',labels:{color:cssVar('--text-2'),padding:14,font:{size:11},usePointStyle:true}},
                tooltip:ttOpts(c=>' '+c.label+': '+c.raw+'%') } }
  });
}

function initProfitChart() {
  const el = document.getElementById('profitChart'); if (!el) return;
  const { t2, bd } = chartDef();
  charts.profit = new Chart(el.getContext('2d'), {
    type:'bar',
    data:{ labels:['Q1','Q2','Q3','Q4'],
           datasets:[
             { label:'Profit',  data:[389000,502000,614000,741000], backgroundColor:'rgba(0,212,170,.75)', borderRadius:7, borderSkipped:false },
             { label:'Expense', data:[218000,267000,298000,341000], backgroundColor:'rgba(255,107,107,.7)', borderRadius:7, borderSkipped:false }
           ] },
    options:{ responsive:true, maintainAspectRatio:true, interaction:{mode:'index'},
      plugins:{ legend:{position:'top',labels:{color:cssVar('--text-2'),font:{size:11},usePointStyle:true,padding:16}},
                tooltip:ttOpts(c=>' ₹'+c.raw.toLocaleString('en-IN')) },
      scales:{ x:{grid:{color:bd},ticks:{color:t2,font:{size:11}}},
               y:{grid:{color:bd},ticks:{color:t2,font:{size:11},callback:v=>'₹'+(v/1000)+'k'}} } }
  });
}

function initTrafficChart() {
  const el = document.getElementById('trafficChart'); if (!el) return;
  charts.traffic = new Chart(el.getContext('2d'), {
    type:'doughnut',
    data:{ labels:['Organic','Direct','Referral','Social','Email'],
           datasets:[{ data:[38,24,17,13,8],
             backgroundColor:['#6C63FF','#00D4AA','#FFA94D','#FF6B6B','#B46CFF'],
             borderColor:'transparent', hoverOffset:10, spacing:3 }] },
    options:{ responsive:true, maintainAspectRatio:true, cutout:'66%',
      plugins:{ legend:{position:'bottom',labels:{color:cssVar('--text-2'),padding:12,font:{size:11},usePointStyle:true}},
                tooltip:ttOpts(c=>' '+c.label+': '+c.raw+'%') } }
  });
}

function initSparkline(id, data, color) {
  const el = document.getElementById(id); if (!el) return;
  new Chart(el.getContext('2d'), {
    type:'line',
    data:{ labels:data.map((_,i)=>i), datasets:[{data,borderColor:color,backgroundColor:'transparent',borderWidth:1.8,pointRadius:0,tension:.45}] },
    options:{ responsive:false, animation:false,
              plugins:{legend:{display:false},tooltip:{enabled:false}},
              scales:{x:{display:false},y:{display:false}} }
  });
}

function refreshChartColors() {
  setTimeout(() => {
    const { t2, bd } = chartDef();
    const lc = cssVar('--text-2');
    Object.values(charts).forEach(c => {
      if (!c?.options?.scales) return;
      ['x','y'].forEach(ax => {
        if (c.options.scales[ax]?.grid)  c.options.scales[ax].grid.color  = bd;
        if (c.options.scales[ax]?.ticks) c.options.scales[ax].ticks.color = t2;
      });
      if (c.options.plugins?.legend?.labels) c.options.plugins.legend.labels.color = lc;
      c.update();
    });
  }, 50);
}

/* ============================================================
   DASHBOARD — mini orders preview (top 5)
   ============================================================ */
function renderDashboardOrders() {
  const body = $('dashboardOrdersBody'); if (!body) return;
  const slice = orders.slice(0, 5);
  body.innerHTML = slice.length
    ? slice.map(o => `
        <tr>
          <td><span class="order-id">${o.id}</span></td>
          <td><span class="order-customer">${esc(o.customer)}</span></td>
          <td>${esc(o.product)}</td>
          <td><span class="order-amount">₹${o.amount.toLocaleString('en-IN')}</span></td>
          <td><span class="badge badge-${o.status}">${o.status}</span></td>
          <td>${fmtDate(o.date)}</td>
        </tr>`).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-3)">No orders yet</td></tr>';
}

/* ============================================================
   CUSTOMERS — derive unique customers from orders data
   ============================================================ */
function renderCustomers() {
  const grid = $('customersGrid'); if (!grid) return;
  const colors = ['#6C63FF','#00D4AA','#FFA94D','#FF6B6B','#B46CFF','#4ECDC4','#45B7D1','#96CEB4'];

  // Build customer map from orders
  const map = {};
  orders.forEach(o => {
    if (!map[o.customer]) map[o.customer] = { name: o.customer, count: 0, total: 0, status: o.status };
    map[o.customer].count++;
    map[o.customer].total += o.amount;
    if (o.status === 'paid') map[o.customer].latestStatus = 'paid';
  });

  const customers = Object.values(map).sort((a,b) => b.total - a.total);

  if (!customers.length) {
    grid.innerHTML = '<p style="color:var(--text-3);padding:32px">No customer data yet.</p>';
    return;
  }

  grid.innerHTML = customers.map((c, i) => {
    const initials = c.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const color    = colors[i % colors.length];
    const email    = c.name.toLowerCase().replace(/\s+/g,'.') + '@example.com';
    return `
      <div class="customer-card">
        <div class="customer-avatar-lg" style="background:${color}">${initials}</div>
        <div class="customer-info">
          <div class="customer-name">${esc(c.name)}</div>
          <div class="customer-email">${email}</div>
          <div class="customer-orders">${c.count} order${c.count!==1?'s':''} · ₹${c.total.toLocaleString('en-IN')} total</div>
        </div>
        <span class="badge badge-paid customer-badge">Active</span>
      </div>`;
  }).join('');
}

/* ============================================================
   ANALYTICS — extra charts (only init when page is visited)
   ============================================================ */
function initAnalyticsCharts() {
  if (typeof Chart === 'undefined') return;
  const { t2, bd } = chartDef();
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Monthly Revenue bar
  const r = document.getElementById('analyticsRevenueChart');
  if (r) new Chart(r.getContext('2d'), {
    type:'bar',
    data:{ labels:MONTHS, datasets:[{label:'Revenue',data:[382000,445000,398000,512000,467000,589000,634000,598000,712000,681000,758000,824000],backgroundColor:'rgba(108,99,255,.7)',borderRadius:6,borderSkipped:false}] },
    options:{ responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false},tooltip:ttOpts(c=>' ₹'+c.raw.toLocaleString('en-IN'))},scales:{x:{grid:{color:bd},ticks:{color:t2,font:{size:10}}},y:{grid:{color:bd},ticks:{color:t2,font:{size:10},callback:v=>'₹'+(v/1000)+'k'}}} }
  });

  // Order Volume line
  const o = document.getElementById('analyticsOrdersChart');
  if (o) new Chart(o.getContext('2d'), {
    type:'line',
    data:{ labels:MONTHS, datasets:[{label:'Orders',data:[42,55,48,63,58,72,80,74,88,84,95,103],borderColor:'#00D4AA',backgroundColor:'rgba(0,212,170,.1)',borderWidth:2,pointRadius:3,tension:.4,fill:true}] },
    options:{ responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false},tooltip:ttOpts(c=>' '+c.raw+' orders')},scales:{x:{grid:{color:bd},ticks:{color:t2,font:{size:10}}},y:{grid:{color:bd},ticks:{color:t2,font:{size:10}}}} }
  });

  // Category doughnut
  const cat = document.getElementById('analyticsCategoryChart');
  if (cat) new Chart(cat.getContext('2d'), {
    type:'doughnut',
    data:{ labels:['Analytics Pro','Enterprise Suite','Growth Bundle','Starter Pack','Add-ons'],datasets:[{data:[34,28,18,13,7],backgroundColor:['#6C63FF','#00D4AA','#FFA94D','#FF6B6B','#B46CFF'],borderColor:'transparent',spacing:2}] },
    options:{ responsive:true,maintainAspectRatio:true,cutout:'60%',plugins:{legend:{position:'bottom',labels:{color:t2,font:{size:10},usePointStyle:true,padding:10}},tooltip:ttOpts(c=>' '+c.label+': '+c.raw+'%')} }
  });

  // Customer growth line
  const cg = document.getElementById('analyticsCustomersChart');
  if (cg) new Chart(cg.getContext('2d'), {
    type:'line',
    data:{ labels:MONTHS, datasets:[{label:'New Customers',data:[18,24,20,31,27,38,42,36,48,44,55,62],borderColor:'#FFA94D',backgroundColor:'rgba(255,169,77,.1)',borderWidth:2,pointRadius:3,tension:.4,fill:true}] },
    options:{ responsive:true,maintainAspectRatio:true,plugins:{legend:{display:false},tooltip:ttOpts(c=>' '+c.raw+' customers')},scales:{x:{grid:{color:bd},ticks:{color:t2,font:{size:10}}},y:{grid:{color:bd},ticks:{color:t2,font:{size:10}}}} }
  });
}

/* ============================================================
   TOAST
   ============================================================ */
function showToast(msg, isError = false) {
  const t = $('toast'); if (!t) return;
  $('toastMsg').textContent = msg;
  t.querySelector('.toast-icon').style.color = isError ? 'var(--accent-3)' : 'var(--accent-2)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

/* ============================================================
   HELPERS
   ============================================================ */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  const [y,m,day] = d.split('-');
  return +day + ' ' + MONTHS[+m - 1] + ' ' + y;
}

// Spinner keyframe used by save-order button
document.head.insertAdjacentHTML('beforeend','<style>@keyframes spin{to{transform:rotate(360deg)}}</style>');