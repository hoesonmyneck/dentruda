/* Анализ по видам помощи (rfpm) — зелёная тема, урезанная копия.
   3 KPI (виды помощи / получатели / сумма) + рейтинг видов помощи + карта + динамика. */

const KZ_VIEW = { center: [48.5, 67], zoom: 4.5 };

let map, regionsLayer, raionsLayer, labelsLayer, tileLayer, tileLabels;
let regionGeoJSON = null, raionGeoJSON = null;
let regionCentroids = {}, raionCentroids = {};
let regionStats = {}, raionStats = {};
let currentRegion = null, currentRaion = null;
let currentGender = null;
let currentAgeSet = [];
let currentPayGroup = null;          // выбранная группа вида помощи (фильтр)
let _curMaxSum = 1;                  // максимум суммы для раскраски текущего уровня
let _dynChart = null;
let _dynMetric = 'people';           // 'people' | 'sum'
let _mapNeedsFit = false;

const AGE_META = [
  { key: 'до 18', label: 'до 18' },
  { key: '18-39', label: '18-39' },
  { key: '40-59', label: '40-59' },
  { key: '60+',   label: '60+' },
];

// Города без районного деления — рисуем регион целиком как единственный «район».
const REGIONS_NO_RAION = new Set([71, 79]);

// ─────────────────────────── утилиты ───────────────────────────
function _escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildFilterParams() {
  const p = new URLSearchParams();
  if (currentRaion) p.set('raion_id', currentRaion);
  else if (currentRegion) p.set('region_id', currentRegion);
  if (currentPayGroup) p.set('pay_group', currentPayGroup);
  if (currentGender) p.set('gender_filter', String(currentGender));
  if (currentAgeSet.length) p.set('age_group', currentAgeSet.join(','));
  return p;
}

function formatInt(n) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(Math.round(n) || 0);
}
function formatNum(n) {
  if (!n && n !== 0) return '—';
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 2 }).format(n);
}
function formatCompact(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e12) + ' трлн';
  if (abs >= 1e9)  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e9)  + ' млрд';
  if (abs >= 1e6)  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e6)  + ' млн';
  return formatInt(n);
}

function _toTitleCase(s) {
  if (!s) return s;
  const l = s.toLowerCase();
  const m = l.match(/^г\.\s*(.+)$/);
  if (m) return 'г.' + m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return l.charAt(0).toUpperCase() + l.slice(1);
}

function animateCounter(id, end, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  const prev = parseFloat(el.dataset.raw ?? 0);
  el.dataset.raw = end;
  if (Math.abs(prev - end) < 0.01) { el.textContent = formatter(end); return; }
  el.classList.remove('kpi-count-anim');
  void el.offsetWidth;
  el.classList.add('kpi-count-anim');
  const dur = 1200, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(prev + (end - prev) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ─────────────────────────── Auth ───────────────────────────
let CURRENT_USER = null;

async function fetchMe() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.reload();
}

function showLogin() {
  const ov = document.createElement('div');
  ov.className = 'auth-overlay';
  ov.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-logo">🏛️</div>
      <div class="auth-title">Анализ по видам помощи</div>
      <div class="auth-sub">Войдите в систему, чтобы продолжить</div>
      <input type="text" id="auth-login" placeholder="Логин" autocomplete="username" autofocus>
      <input type="password" id="auth-pass" placeholder="Пароль" autocomplete="current-password">
      <div class="auth-error" id="auth-error"></div>
      <button type="submit" id="auth-submit">Войти</button>
    </form>`;
  document.body.appendChild(ov);
  document.getElementById('auth-login').focus();
  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    errEl.textContent = '';
    const login = document.getElementById('auth-login').value.trim();
    const password = document.getElementById('auth-pass').value;
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        errEl.textContent = d.detail || 'Ошибка входа';
        btn.disabled = false;
        return;
      }
      location.reload();
    } catch {
      errEl.textContent = 'Ошибка сети';
      btn.disabled = false;
    }
  });
}

// ─────────────────── KPI-раскрытие (FLIP «в центр») ───────────────────
const _KPI_EASE_OPEN  = 'cubic-bezier(0.22, 1, 0.36, 1)';
const _KPI_EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.2, 1)';
function _prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _flip(card, first, last, dur, ease, onDone) {
  const dx = first.left - last.left, dy = first.top - last.top;
  const sx = first.width / last.width, sy = first.height / last.height;
  card.style.transformOrigin = 'top left';
  card.style.transition = 'none';
  card.style.setProperty('transform', `translate(${dx}px,${dy}px) scale(${sx},${sy})`, 'important');
  card.style.filter = 'blur(4px)';
  void card.offsetWidth;
  requestAnimationFrame(() => {
    card.style.transition = `transform ${dur}ms ${ease}, filter ${dur}ms ${ease}`;
    card.style.setProperty('transform', 'translate(0px,0px) scale(1)', 'important');
    card.style.filter = 'blur(0px)';
    const te = (e) => {
      if (e.propertyName !== 'transform') return;
      card.removeEventListener('transitionend', te);
      card.style.transition = ''; card.style.removeProperty('transform');
      card.style.transformOrigin = ''; card.style.filter = '';
      onDone && onDone();
    };
    card.addEventListener('transitionend', te);
  });
}

function _closeKpiCard(card, col) {
  if (!card || !card.classList.contains('expanded')) return;
  const bd = card._kpiBd;
  if (bd) { bd.classList.remove('show'); setTimeout(() => bd.remove(), 280); card._kpiBd = null; }
  const rmPh = () => { if (card._kpiPh) { card._kpiPh.remove(); card._kpiPh = null; } };
  if (_prefersReducedMotion()) {
    card.classList.remove('expanded'); rmPh(); col?.classList.remove('kpi-expanding'); return;
  }
  const first = card.getBoundingClientRect();
  card.classList.remove('expanded');
  rmPh();
  const last = card.getBoundingClientRect();
  _flip(card, first, last, 300, _KPI_EASE_CLOSE, () => col?.classList.remove('kpi-expanding'));
}

function _kpiCardToggle(cardId, renderFn) {
  const card = document.getElementById(cardId);
  const col = card?.closest('.kpi-col-left, .kpi-col-right');
  if (!card) return;
  if (card.classList.contains('expanded')) { _closeKpiCard(card, col); return; }

  const first = card.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.className = 'kpi-slot-ph';
  const cs = getComputedStyle(card);
  ph.style.flex = cs.flex;
  ph.style.width = first.width + 'px';
  ph.style.height = first.height + 'px';
  card.parentNode.insertBefore(ph, card);
  card._kpiPh = ph;
  col?.classList.add('kpi-expanding');
  card.classList.add('expanded');
  renderFn();

  const bd = document.createElement('div');
  bd.className = 'kpi-modal-backdrop';
  bd.addEventListener('click', () => _closeKpiCard(card, col));
  (card.closest('.v2-mainrow') || card.closest('.main-layout') || document.body).appendChild(bd);
  card._kpiBd = bd;
  requestAnimationFrame(() => bd.classList.add('show'));

  if (_prefersReducedMotion()) return;
  const last = card.getBoundingClientRect();
  _flip(card, first, last, 380, _KPI_EASE_OPEN);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const c = document.querySelector('.kpi-card-expandable.expanded');
  if (c) _closeKpiCard(c, c.closest('.kpi-col-left, .kpi-col-right'));
});

// ─── Раскрытие «Всего видов помощи» — список видов помощи ───
let _lastRatingRows = [];

function toggleHelpTypesList(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-help-types', () => {
    const list = document.getElementById('kpi-help-list');
    const rows = _lastRatingRows;
    if (!rows.length) { list.innerHTML = '<div class="kpi-help-item">Нет данных</div>'; return; }
    list.innerHTML = rows.map((r, i) =>
      `<div class="kpi-help-item"><span class="kpi-help-num">${i + 1}</span>` +
      `<span style="flex:1">${_escHtml(r.pay_group)}</span>` +
      `<span style="opacity:.75;white-space:nowrap;margin-left:8px">${formatInt(r.recipients)} чел · ${formatCompact(r.total_sum)} ₸</span>` +
      `</div>`
    ).join('');
  });
}

// ─── Раскрытие «Сумма» — разбивка по возрасту и полу (по сумме) ───
function toggleSumDemo(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-sum', renderSumDemo);
}

const _sduCharts = {};

async function renderSumDemo() {
  const panel = document.getElementById('kpi-sum-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="kpi-demo-charts">
      <div class="kpi-demo-box kpi-demo-grow">
        <div class="kpi-demo-title">Уровень благосостояния по ЦКС</div>
        <div class="kpi-demo-sdu"><canvas id="sum-sdu-chart"></canvas></div>
      </div>
      <div class="kpi-demo-box">
        <div class="kpi-demo-title">Возрастные группы</div>
        <div id="sum-age" class="ga-chart"><div class="kpi-demo-loading">Загрузка…</div></div>
      </div>
      <div class="kpi-demo-box">
        <div class="kpi-demo-title">Гендер</div>
        <div id="sum-gender" class="ga-chart"></div>
      </div>
    </div>`;
  try {
    const kpi = await fetch(`/api/kpi?${buildFilterParams()}`, { credentials: 'include' }).then(r => r.json());
    _renderSduBarChart(kpi.cks_gender || {}, 'sum-sdu-chart');
    _renderAgeRows(kpi.age || {}, kpi.age_gender || {}, 'sum-age');
    _renderGenderRow(kpi.male_sum || 0, kpi.female_sum || 0, 'sum-gender');
  } catch {
    panel.innerHTML = '<div class="kpi-demo-loading">Ошибка загрузки</div>';
  }
}

// Уровень благосостояния по ЦКС — вертикальный столбчатый график (как в зелёной теме),
// стек по полу (мужчины/женщины), проценты сверху; по сумме (NSUM).
function _renderSduBarChart(sduG, canvasId) {
  const cv = document.getElementById(canvasId);
  if (!cv || !window.Chart) return;
  const keys = ['A', 'B', 'C', 'D', 'E'];
  const males   = keys.map(k => (sduG[k]?.m) || 0);
  const females = keys.map(k => (sduG[k]?.f) || 0);
  const totals  = keys.map((_, i) => males[i] + females[i]);
  const grand = totals.reduce((a, b) => a + b, 0);
  const pcts = totals.map(v => grand ? Math.round(v / grand * 100) : 0);
  const tickColor = '#ffffff', axisColor = '#aaaaaa', gridColor = 'rgba(255,255,255,0.07)';

  const pctLabels = {
    id: 'gpSduPct',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(1);
      if (!meta) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = "700 10px 'Roboto', sans-serif";
      ctx.fillStyle = tickColor; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      meta.data.forEach((bar, i) => { if (totals[i] > 0) ctx.fillText(pcts[i] + '%', bar.x, bar.y - 3); });
      ctx.restore();
    },
  };

  if (_sduCharts[canvasId]) _sduCharts[canvasId].destroy();
  _sduCharts[canvasId] = new Chart(cv.getContext('2d'), {
    type: 'bar',
    data: {
      labels: keys,
      datasets: [
        { label: 'Мужчины', data: males,   backgroundColor: '#5b8af8', stack: 's', borderSkipped: false },
        { label: 'Женщины', data: females, backgroundColor: '#f875c3', stack: 's', borderSkipped: false, borderRadius: 3 },
      ],
    },
    plugins: [pctLabels],
    options: {
      responsive: true, maintainAspectRatio: false, layout: { padding: { top: 16 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0].dataIndex;
              return [`ЦКС ${keys[i]}`, `Всего: ${formatCompact(totals[i])} ₸`];
            },
            label: c => {
              const i = c.dataIndex, tot = totals[i] || 0, val = c.parsed.y;
              const pct = tot ? Math.round(val / tot * 100) : 0;
              const who = c.datasetIndex === 0 ? 'Мужчины' : 'Женщины';
              return ` ${who}: ${formatCompact(val)} ₸ (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: tickColor, font: { weight: '700' } } },
        y: { stacked: true, grid: { color: gridColor }, ticks: { color: axisColor, callback: v => formatCompact(v) || String(v) } },
      },
    },
  });
}

function _renderAgeRows(age, ageG, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const total = AGE_META.reduce((s, m) => s + (age[m.key] || 0), 0);
  el.innerHTML = AGE_META.map(m => {
    const val = age[m.key] || 0;
    const pct = total > 0 ? Math.round(val / total * 100) : 0;
    const gm = ageG[m.key]?.m || 0, gf = ageG[m.key]?.f || 0;
    const gTot = gm + gf;
    const mW = gTot ? (gm / gTot * 100) : 0;
    const fW = gTot ? (gf / gTot * 100) : 0;
    const tip = `${m.label}: ${formatCompact(val)} ₸  •  Мужчины: ${formatCompact(gm)}  •  Женщины: ${formatCompact(gf)}`;
    return `<div class="ga-age-row" title="${tip}">
        <span class="ga-age-lbl">${m.label}</span>
        <div class="ga-age-bar-wrap"><div class="ga-age-split" style="width:${pct}%">
          <div class="ga-seg-m" style="width:${mW}%"></div><div class="ga-seg-f" style="width:${fW}%"></div>
        </div></div>
        <span class="ga-age-pct">${pct}%</span>
      </div>`;
  }).join('');
}

function _renderGenderRow(male, female, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const tot = male + female;
  const mPct = tot ? Math.round(male / tot * 100) : 0;
  const fPct = tot ? 100 - mPct : 0;
  el.innerHTML = `
    <div class="ga-age-row" title="Мужчины: ${formatCompact(male)} ₸ (${mPct}%)">
      <span class="ga-age-lbl">Мужчины</span>
      <div class="ga-age-bar-wrap"><div class="ga-age-split ga-seg-m" style="width:${mPct}%"></div></div>
      <span class="ga-age-pct">${mPct}%</span>
    </div>
    <div class="ga-age-row" title="Женщины: ${formatCompact(female)} ₸ (${fPct}%)">
      <span class="ga-age-lbl">Женщины</span>
      <div class="ga-age-bar-wrap"><div class="ga-age-split ga-seg-f" style="width:${fPct}%"></div></div>
      <span class="ga-age-pct">${fPct}%</span>
    </div>`;
}

// ─────────────── Гео-панель (при выборе области/района на карте) ───────────────
// Выезжает на месте рейтинга, показывает по выбранной области/району:
// ЦКС (график) + Гендер (сплит-бар) + Возрастные группы. Всё по сумме (NSUM).
async function showGeoSidePanel(geoId, name, isRaion, showBack = false) {
  const layout = document.querySelector('.main-layout');
  const panel = document.getElementById('kpi-geo-side');
  if (!layout || !panel) return;
  layout.classList.add('map-drill-active');
  const backBtn = showBack
    ? `<button type="button" class="gs-back-btn" onclick="hideGeoSidePanel()" title="Свернуть">← Назад</button>`
    : '';
  panel.innerHTML = `
    <div class="gp-main">
      <div class="gp-body">
        <div class="gp-title-row">
          <span class="gp-title">${_escHtml(name)}</span>
          ${backBtn}
        </div>
        <div class="gp-charts">
          <div class="gp-chart-box">
            <div class="gp-chart-title">Уровень благосостояния по ЦКС</div>
            <div class="gp-sdu-wrap"><canvas id="gs-sdu-chart"></canvas></div>
          </div>
        </div>
      </div>
      <div class="gp-chart-box">
        <div class="gp-chart-title">Гендер</div>
        <div id="gs-ga-chart" class="ga-chart gp-ga"></div>
      </div>
    </div>`;
  if (map) { setTimeout(() => map.invalidateSize(), 60); setTimeout(() => map.invalidateSize(), 460); }
  try {
    const p = new URLSearchParams();
    if (geoId != null) { if (isRaion) p.set('raion_id', geoId); else p.set('region_id', geoId); }
    if (currentPayGroup) p.set('pay_group', currentPayGroup);
    if (currentGender) p.set('gender_filter', String(currentGender));
    if (currentAgeSet.length) p.set('age_group', currentAgeSet.join(','));
    const kpi = await fetch(`/api/kpi?${p}`, { credentials: 'include' }).then(r => r.json());
    _renderSduBarChart(kpi.cks_gender || {}, 'gs-sdu-chart');
    _renderGeoGenderAge(kpi.male_sum || 0, kpi.female_sum || 0, kpi.age || {}, kpi.age_gender || {}, 'gs-ga-chart');
  } catch (e) {
    console.error('geoSide', e);
    panel.innerHTML = '<div class="gp-title" style="padding:20px">Ошибка загрузки</div>';
  }
}

function hideGeoSidePanel() {
  const layout = document.querySelector('.main-layout');
  if (!layout || !layout.classList.contains('map-drill-active')) return;
  layout.classList.remove('map-drill-active');
  const panel = document.getElementById('kpi-geo-side');
  if (panel) setTimeout(() => { panel.innerHTML = ''; }, 450);
  if (map) { setTimeout(() => map.invalidateSize(), 60); setTimeout(() => map.invalidateSize(), 460); }
}

function _restoreGeoSide() {
  if (currentRaion != null) {
    showGeoSidePanel(currentRaion, raionStats[currentRaion]?.name || `Район ${currentRaion}`, true);
  } else if (currentRegion != null) {
    showGeoSidePanel(currentRegion, _regionName(currentRegion), false);
  }
}

// Гендер (сплит-бар Женщины/Мужчины) + возрастные группы, по сумме. Только просмотр.
function _renderGeoGenderAge(male, female, age, ageG, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const total = male + female;
  const fPct = total > 0 ? Math.round(female / total * 100) : 50;
  const mPct = 100 - fPct;
  const ageTotal = AGE_META.reduce((s, m) => s + (age[m.key] || 0), 0);
  el.innerHTML = `
    <div class="ga-gender-labels">
      <span class="ga-female-txt">Женщины</span>
      <span class="ga-male-txt">Мужчины</span>
    </div>
    <div class="ga-gender-bar-outer">
      <div class="ga-bar-f" style="width:${fPct}%" title="Женщины: ${formatCompact(female)} ₸ (${fPct}%)"></div>
      <div class="ga-bar-m" style="width:${mPct}%" title="Мужчины: ${formatCompact(male)} ₸ (${mPct}%)"></div>
    </div>
    <div class="ga-gender-pcts">
      <span class="ga-female-txt">${fPct}%</span>
      <span class="ga-male-txt">${mPct}%</span>
    </div>
    <div class="ga-age-hdr">Возрастные группы</div>
    ${AGE_META.map(m => {
      const val = age[m.key] || 0;
      const pct = ageTotal > 0 ? Math.round(val / ageTotal * 100) : 0;
      const gm = ageG[m.key]?.m || 0, gf = ageG[m.key]?.f || 0;
      const gTot = gm + gf;
      const mW = gTot ? (gm / gTot * 100) : 0;
      const fW = gTot ? (gf / gTot * 100) : 0;
      const tip = `${m.label}: ${formatCompact(val)} ₸  •  Мужчины: ${formatCompact(gm)}  •  Женщины: ${formatCompact(gf)}`;
      return `<div class="ga-age-row" title="${tip}">
        <span class="ga-age-lbl">${m.label}</span>
        <div class="ga-age-bar-wrap"><div class="ga-age-split" style="width:${pct}%">
          <div class="ga-seg-m" style="width:${mW}%"></div><div class="ga-seg-f" style="width:${fW}%"></div>
        </div></div>
        <span class="ga-age-pct">${pct}%</span>
      </div>`;
    }).join('')}`;
}

// ─────────────────── Рейтинг видов помощи ───────────────────
function renderRating(rows) {
  _lastRatingRows = rows || [];
  const el = document.getElementById('kpi-top-mgp');
  if (!el) return;
  const top4 = (rows || []).slice(0, 4);
  el.innerHTML = `<div class="kpi-top-mgp-hdr"><span>#</span><span>Вид помощи</span><span>Сумма</span></div>` +
    top4.map((r, i) => {
      const name = _escHtml(r.pay_group);
      return `<div class="kpi-top-mgp-item">
        <span class="kpi-top-mgp-num">${i + 1}</span>
        <span class="kpi-top-mgp-name" title="${name}">${name}</span>
        <span class="kpi-top-mgp-val">${formatCompact(r.total_sum || 0)} ₸</span>
      </div>`;
    }).join('');
}

function toggleRatingList(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-top-mgp', () => {
    const list = document.getElementById('kpi-top-mgp-list');
    const rows = (_lastRatingRows || []).filter(r => (r.total_sum || 0) > 0);
    if (!rows.length) { list.innerHTML = '<div class="kpi-help-item">Нет данных</div>'; return; }
    list.innerHTML = `<div class="kpi-top-mgp-hdr"><span>#</span><span>Вид помощи</span><span>Сумма</span></div>` +
      rows.map((r, i) => {
        const name = _escHtml(r.pay_group);
        return `<div class="kpi-top-mgp-item">
          <span class="kpi-top-mgp-num">${i + 1}</span>
          <span class="kpi-top-mgp-name" title="${name}">${name}</span>
          <span class="kpi-top-mgp-val">${formatCompact(r.total_sum || 0)} ₸</span>
        </div>`;
      }).join('');
  });
}

// ─────────────────────────── KPI ───────────────────────────
async function refreshKPI() {
  const params = buildFilterParams();
  try {
    const [kpi, rating] = await Promise.all([
      fetch(`/api/kpi?${params}`, { credentials: 'include' }).then(r => r.json()),
      fetch(`/api/pay-type-stats?${params}`, { credentials: 'include' }).then(r => r.json()),
    ]);
    animateCounter('kpi-help-types', kpi.help_type_count || 0, v => formatInt(v));
    animateCounter('kpi-recipients', kpi.recipients || 0, v => formatInt(v));
    animateCounter('kpi-sum', kpi.total_sum || 0, v => formatCompact(v));
    renderRating(Array.isArray(rating) ? rating : []);
  } catch (e) {
    console.error('refreshKPI', e);
  }
}

// ─────────────────────────── Карта ───────────────────────────
// Зелёная последовательная шкала по сумме (светлый → тёмный).
function getSumColor(v) {
  if (!v) return '#4a5258';                 // нет данных
  const f = _curMaxSum > 0 ? v / _curMaxSum : 0;
  if (f < 0.10) return '#d6f0dd';
  if (f < 0.25) return '#93d5a8';
  if (f < 0.50) return '#4fb573';
  if (f < 0.75) return '#2e9e56';
  return '#1e8449';
}

function _statSum(id, isRaion) {
  const s = isRaion ? raionStats[id] : regionStats[id];
  return s ? (s.total_sum || 0) : 0;
}

function geoFillRegion(id) { return getSumColor(_statSum(id, false)); }
function geoFillRaion(id)  { return getSumColor(_statSum(id, true)); }

function regionStyle(feature) {
  return { fillColor: geoFillRegion(feature.properties.id_reg), weight: 1, color: '#3a5090', fillOpacity: 0.78 };
}
function raionStyle(feature) {
  const id = REGIONS_NO_RAION.has(+currentRegion)
    ? Number(Object.keys(raionStats)[0])
    : feature.properties.id_rai;
  return { fillColor: geoFillRaion(id), weight: 1, color: '#3a5090', fillOpacity: 0.78 };
}

function clearLabels() {
  if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
}
function addLabel(latlng, text) {
  return L.marker(latlng, {
    icon: L.divIcon({ className: 'map-label', html: `<span>${text}</span>`, iconSize: null, iconAnchor: [0, 0] }),
    interactive: false,
  });
}

function _regionName(id) {
  const n = regionStats[id]?.name;
  return n ? _toTitleCase(n) : `Регион ${id}`;
}

function renderRegionLabels() {
  clearLabels();
  labelsLayer = L.layerGroup();
  Object.entries(regionCentroids).forEach(([id, c]) => {
    if (!c) return;
    const s = regionStats[id];
    if (!s || !s.total_sum) return;
    labelsLayer.addLayer(addLabel([c[1], c[0]], formatCompact(s.total_sum)));
  });
  labelsLayer.addTo(map);
}

function renderRaionLabels() {
  clearLabels();
  labelsLayer = L.layerGroup();
  Object.entries(raionStats).forEach(([id, s]) => {
    let c = raionCentroids[Math.round(id)];
    if (!c && REGIONS_NO_RAION.has(+currentRegion)) c = regionCentroids[currentRegion];
    if (!c || !s.total_sum) return;
    labelsLayer.addLayer(addLabel([c[1], c[0]], formatCompact(s.total_sum)));
  });
  labelsLayer.addTo(map);
}

function _recomputeRegionMax() {
  _curMaxSum = Math.max(1, ...Object.values(regionStats).map(s => s.total_sum || 0));
}
function _recomputeRaionMax() {
  _curMaxSum = Math.max(1, ...Object.values(raionStats).map(s => s.total_sum || 0));
}

function renderRegions() {
  if (raionsLayer) { map.removeLayer(raionsLayer); raionsLayer = null; }
  if (regionsLayer) { map.removeLayer(regionsLayer); }
  _recomputeRegionMax();
  regionsLayer = L.geoJSON(regionGeoJSON, {
    style: regionStyle,
    onEachFeature(feature, layer) {
      layer.bindTooltip(() => {
        const rid = feature.properties.id_reg;
        const s = regionStats[rid];
        const nm = s ? _toTitleCase(s.name) : '';
        return s ? `${nm}: ${formatCompact(s.total_sum)} ₸` : nm;
      }, { sticky: true, className: 'map-name-tip' });
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.92 }); },
        mouseout(e)  { regionsLayer.resetStyle(e.target); },
        click()      { drillRegion(feature.properties.id_reg); },
      });
    },
  }).addTo(map);
  renderRegionLabels();
}

function _buildDrillLayer(regionId) {
  const whole = REGIONS_NO_RAION.has(+regionId);
  const src = whole ? regionGeoJSON : raionGeoJSON;
  const filtered = { ...src, features: src.features.filter(f => f.properties.id_reg == regionId) };
  const soleId = whole ? Number(Object.keys(raionStats)[0]) : null;
  const idOf = f => whole ? soleId : f.properties.id_rai;
  return L.geoJSON(filtered, {
    style: raionStyle,
    onEachFeature(feature, lyr) {
      lyr.bindTooltip(() => {
        const s = raionStats[idOf(feature)];
        return s ? `${s.name}: ${formatCompact(s.total_sum)} ₸` : '';
      }, { sticky: true, className: 'map-name-tip' });
      lyr.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.92 }); },
        mouseout(e)  { raionsLayer && raionsLayer.resetStyle(e.target); },
        click()      { const id = idOf(feature); if (id != null) selectRaion(id); },
      });
    },
  });
}

async function drillRegion(regionId) {
  currentRegion = regionId;
  currentRaion = null;
  const data = await fetch(`/api/raions?region_id=${regionId}`, { credentials: 'include' }).then(r => r.json());
  raionStats = {};
  (data || []).forEach(r => { raionStats[r.id_rai] = r; });
  _recomputeRaionMax();

  if (regionsLayer) { map.removeLayer(regionsLayer); regionsLayer = null; }
  if (raionsLayer) { map.removeLayer(raionsLayer); }
  raionsLayer = _buildDrillLayer(regionId).addTo(map);

  const b = raionsLayer.getBounds();
  if (b.isValid()) {
    // фитим 2D только когда карта видима (вкладка «Карта» + режим 2D); иначе позже
    if (_mapView === '2d' && document.getElementById('mtab-map')?.classList.contains('active')) {
      try { map.fitBounds(b, { padding: [20, 20] }); } catch (_) {}
    } else { _mapNeedsFit = true; }
  }
  renderRaionLabels();
  updateBreadcrumb(_regionName(regionId), null);
  showGeoSidePanel(regionId, _regionName(regionId), false);
  await refreshKPI();
  refreshActiveMapTab();
}

async function selectRaion(raionId) {
  currentRaion = raionId;
  const raionName = raionStats[raionId]?.name || `Район ${raionId}`;
  updateBreadcrumb(_regionName(currentRegion), raionName);
  showGeoSidePanel(raionId, raionName, true);
  await refreshKPI();
  refreshActiveMapTab();
}

async function goBack() {
  currentRegion = null;
  currentRaion = null;
  currentPayGroup = null;
  raionStats = {};
  _mapNeedsFit = false;   // сбрасываем отложенный fit к району (иначе карта «застрянет» на нём)
  updateBreadcrumb(null, null);
  hideGeoSidePanel();
  clearLabels();
  renderRegions();
  // Перерисовку карты запускаем СРАЗУ (её запрос /api/regions идёт параллельно с KPI),
  // иначе 3D-вид ждёт завершения refreshKPI и «подтормаживает» при выходе в Казахстан.
  refreshActiveMapTab();
  // Возврат к общему виду: setView с фиксированными центром/зумом (как в зелёной теме),
  // а не flyToBounds — иначе на скрытой карте (активна вкладка аналитики) считается
  // кривой зум и карта показывает последний район. Повторяем после ресайза контейнера.
  if (map && _mapView === '2d') {
    try {
      map.setView(KZ_VIEW.center, _kzZoom());
      setTimeout(() => { try { map.setView(KZ_VIEW.center, _kzZoom()); } catch (_) {} }, 500);
    } catch (_) {}
  }
  await refreshKPI();
}

function updateBreadcrumb(region, raion) {
  let html = '<span onclick="goBack()">Казахстан</span>';
  if (region) html += ` / <span onclick="drillRegion(${currentRegion})">${_escHtml(region)}</span>`;
  if (raion) html += ` / ${_escHtml(raion)}`;
  const el = document.getElementById('breadcrumb');
  if (el) el.innerHTML = html;
  const fs = document.getElementById('map-fs-breadcrumb');
  if (fs) fs.innerHTML = html;
}

// ─────────────────────────── Вкладки блока карты ───────────────────────────
function switchMapTab(name) {
  if (name !== 'map') hideGeoSidePanel();
  document.querySelectorAll('.map-tabs .mtab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mtab === name));
  document.querySelectorAll('.map-tabs .mtab-pane').forEach(p =>
    p.classList.toggle('active', p.id === `mtab-${name}`));
  if (name === 'map' && map) {
    _restoreGeoSide();
    if (_mapView === '3d') renderMap3DTab();
    setTimeout(() => {
      map.invalidateSize();
      if (_mapView === '2d') {
        if (_mapNeedsFit && raionsLayer) {
          const b = raionsLayer.getBounds();
          if (b.isValid()) { try { map.fitBounds(b, { padding: [20, 20] }); } catch (_) {} }
          _mapNeedsFit = false;
        } else if (currentRegion == null) {
          // вернулись на вкладку «Карта» на уровне страны → показываем весь Казахстан
          try { map.setView(KZ_VIEW.center, _kzZoom()); } catch (_) {}
        }
      }
    }, 60);
  } else if (name === 'dynamics') {
    loadDynamics();
  } else if (name === 'summary') {
    loadAnalyticsPaytypes();
  } else if (name === 'regions') {
    loadAnalyticsRegions();
  }
}

function refreshActiveMapTab() {
  const active = document.querySelector('.map-tabs .mtab-btn.active')?.dataset.mtab;
  if (active === 'dynamics') loadDynamics();
  else if (active === 'summary') loadAnalyticsPaytypes();
  else if (active === 'regions') loadAnalyticsRegions();
  else if (active === 'map' && map) {
    if (_mapView === '3d') renderMap3DTab();
    setTimeout(() => map.invalidateSize(), 60);
  }
}

// ─────────────────────────── 2D / 3D вид карты ───────────────────────────
let _mapView = '2d';
let _last3DLevel = null;   // 'region' | 'raion' — для сброса камеры при смене уровня

function switchMapView(view) {
  if (view === _mapView) return;
  _mapView = view;
  document.querySelectorAll('.map-view-seg .mv-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mview === view));
  document.getElementById('map-view-2d')?.classList.toggle('active', view === '2d');
  document.getElementById('map-view-3d')?.classList.toggle('active', view === '3d');
  if (view === '2d') {
    if (map) setTimeout(() => {
      map.invalidateSize();
      if (currentRegion != null && raionsLayer) {
        try { map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] }); } catch (_) {}
      } else {
        map.setView(KZ_VIEW.center, _kzZoom());
      }
    }, 60);
  } else {
    renderMap3DTab();
  }
}

function _demoParams() {
  const p = new URLSearchParams();
  if (currentPayGroup) p.set('pay_group', currentPayGroup);
  if (currentGender) p.set('gender_filter', String(currentGender));
  if (currentAgeSet.length) p.set('age_group', currentAgeSet.join(','));
  return p;
}

// 3D-карта: полигоны текущего уровня + столбцы (высота = сумма выплат)
async function renderMap3DTab() {
  if (!window.renderMap3D) return;
  const isRaion = currentRegion != null;
  const wholeCity = isRaion && REGIONS_NO_RAION.has(+currentRegion);
  let polygons, centroids, url, idKey;
  const demo = _demoParams().toString();
  if (wholeCity) {
    polygons = { ...regionGeoJSON, features: (regionGeoJSON?.features || []).filter(f => f.properties.id_reg == currentRegion) };
    centroids = regionCentroids;
    url = `/api/raions?region_id=${currentRegion}${demo ? '&' + demo : ''}`;
    idKey = 'id_reg';
  } else if (isRaion) {
    polygons = { ...raionGeoJSON, features: (raionGeoJSON?.features || []).filter(f => f.properties.id_reg == currentRegion) };
    centroids = raionCentroids;
    url = `/api/raions?region_id=${currentRegion}${demo ? '&' + demo : ''}`;
    idKey = 'id_rai';
  } else {
    polygons = regionGeoJSON;
    centroids = regionCentroids;
    url = `/api/regions${demo ? '?' + demo : ''}`;
    idKey = 'id_reg';
  }
  if (!polygons || !polygons.features) return;
  let rows = [];
  const noFilters = !currentPayGroup && !currentGender && !currentAgeSet.length;
  if (!isRaion && noFilters) {
    // уровень страны без фильтров — данные уже загружены при инициализации,
    // берём их сразу (без сетевого запроса), чтобы выход в Казахстан был мгновенным
    rows = Object.values(regionStats);
  } else {
    try { rows = await fetch(url, { credentials: 'include' }).then(r => r.json()); }
    catch (e) { console.error('map3d', e); }
  }
  const rankMap = {};
  if (wholeCity) {
    const agg = { name: '', total_sum: 0, recipients: 0 };
    (rows || []).forEach(r => { agg.total_sum += r.total_sum || 0; agg.recipients += r.recipients || 0; agg.name = r.name || agg.name; });
    rankMap[Math.round(currentRegion)] = agg;
  } else {
    (rows || []).forEach(r => { rankMap[Math.round(r.id_reg ?? r.id_rai)] = r; });
  }
  const units = {};
  polygons.features.forEach(f => {
    const id = Math.round(f.properties[idKey]);
    const c = centroids[id];
    if (!c || units[id]) return;
    const r = rankMap[id];
    units[id] = {
      id,
      name: _toTitleCase(r?.name || f.properties.raion || f.properties.region || ''),
      centroid: c,
      value: r?.total_sum || 0,
      count: r?.recipients || 0,
    };
  });
  const backBtn = document.getElementById('map3d-back');
  if (backBtn) backBtn.style.display = isRaion ? '' : 'none';
  const legEl = document.getElementById('map3d-legend-metric');
  if (legEl) legEl.textContent = 'Высота столбца = сумма выплат';
  const level = isRaion ? 'raion' : 'region';
  window.renderMap3D({
    polygons, units, idKey,
    metricLabel: 'Сумма выплат',
    level,
    onDrill: isRaion ? selectRaion : enterRegion3D,
  });
  // при переходе между уровнями (страна↔регион↔район) сбрасываем камеру,
  // иначе сцена перестроится, но вид останется приближённым к прошлому уровню
  if (level !== _last3DLevel) {
    if (window.resetMap3DView) window.resetMap3DView();
    _last3DLevel = level;
  }
}

async function enterRegion3D(regionId) { await drillRegion(regionId); }
function backFromRegion3D() { goBack(); }

// Кнопка «Казахстан» — вернуться на уровень страны и показать сводку по РК справа
function showCountryPanel(ev) {
  if (ev) ev.stopPropagation();
  currentRegion = null;
  currentRaion = null;
  raionStats = {};
  updateBreadcrumb(null, null);
  renderRegions();
  if (map) {
    const b = regionsLayer && regionsLayer.getBounds();
    if (b && b.isValid()) map.flyToBounds(b, { duration: 0.5, padding: [20, 20] });
  }
  refreshKPI();
  showGeoSidePanel(null, 'Казахстан', false, true);
  refreshActiveMapTab();
}

// ─────────────────────────── Динамика ───────────────────────────
const _MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

async function loadDynamics() {
  try {
    const rows = await fetch(`/api/dynamics?${buildFilterParams()}`, { credentials: 'include' }).then(r => r.json());
    renderDynamics(Array.isArray(rows) ? rows : []);
  } catch (e) { console.error('loadDynamics', e); }
}

function renderDynamics(rows) {
  const canvas = document.getElementById('dynamics-chart');
  if (!canvas) return;
  const lineColor = '#5b8af8';
  const fillColor = 'rgba(91,138,248,0.15)';
  const gridColor = 'rgba(255,255,255,0.06)';
  const tickColor = '#9aa0b4';

  const labels = rows.map(r => {
    const [, m] = r.period.split('-');
    return _MONTHS_RU[(parseInt(m, 10) || 1) - 1];
  });
  const values = rows.map(r => _dynMetric === 'people' ? r.people : r.total_sum);

  const dynDatalabels = {
    id: 'dynDatalabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = tickColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      meta.data.forEach((point, i) => {
        const val = values[i];
        if (val == null) return;
        ctx.fillText(_dynMetric === 'people' ? formatInt(val) : formatCompact(val), point.x, point.y - 5);
      });
      ctx.restore();
    },
  };

  if (_dynChart) { _dynChart.destroy(); _dynChart = null; }
  _dynChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [dynDatalabels],
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => _dynMetric === 'people'
              ? formatInt(ctx.parsed.y) + ' чел.'
              : formatNum(ctx.parsed.y) + ' ₸',
          },
        },
      },
      scales: {
        x: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor } },
        y: {
          ticks: { color: tickColor, font: { size: 10 },
            callback: v => _dynMetric === 'people' ? formatInt(v) : formatCompact(v) },
          grid: { color: gridColor },
        },
      },
    },
  });
}

// ─────────────────────── Полноэкранный режим блока карты ───────────────────────
// базовый зум карты — как в /help (KZ_VIEW.zoom); полноэкранный режим зум не меняет
const _kzZoom = () => KZ_VIEW.zoom;

function toggleFullscreen(btn) {
  const section = btn.closest('.map-panel');
  if (!section) return;
  const fs = section.classList.toggle('is-fullscreen');
  document.body.classList.toggle('fs-open', fs);
  btn.textContent = fs ? '✕' : '⛶';
  btn.title = fs ? 'Закрыть' : 'Во весь экран';
  if (map) {
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 360);
  }
  if (_mapView === '3d') setTimeout(renderMap3DTab, 80);
  refreshActiveMapTab();
}

// ─────────────────────── Вкладки аналитики (таблицы) ───────────────────────
const CKS_COLS = ['A', 'B', 'C', 'D', 'E'];
const _anCache = {};   // pfx -> { rows, firstColLabel, onRowClick, sortGroup, sortMetric, sortDir }

function _anRowVal(r, group, metric) {
  if (group === 'total') return (metric === 'count' ? r.total_count : r.total_sum) || 0;
  const c = r.cks?.[group];
  return c ? (c[metric] || 0) : 0;
}
function _anSortedRows(pfx) {
  const st = _anCache[pfx];
  return [...st.rows].sort((a, b) =>
    st.sortDir * (_anRowVal(a, st.sortGroup, st.sortMetric) - _anRowVal(b, st.sortGroup, st.sortMetric)));
}
function _anSortIcon(pfx, group, metric) {
  const st = _anCache[pfx];
  if (st.sortGroup === group && st.sortMetric === metric) return st.sortDir < 0 ? ' ▼' : ' ▲';
  return '';
}

function _anModeSeg(pfx) {
  const mode = _anCache[pfx]?.mode || 'pay';
  return `<div class="an-mode-seg" id="${pfx}-modeseg">
    <button type="button" class="an-mode-btn${mode === 'pay' ? ' active' : ''}" data-mode="pay" onclick="setAnalyticsMode('${pfx}','pay')">Выплата</button>
    <button type="button" class="an-mode-btn${mode === 'cat' ? ' active' : ''}" data-mode="cat" onclick="setAnalyticsMode('${pfx}','cat')">Категории</button>
  </div>`;
}

function _analyticsTableHtml(pfx) {
  const st = _anCache[pfx];
  const mode = st.mode || 'pay';
  const th = (group, metric, label, cls) =>
    `<th class="${cls} an-sortable" onclick="sortAnalytics('${pfx}','${group}','${metric}')">${label}<span class="an-sort-ic">${_anSortIcon(pfx, group, metric)}</span></th>`;
  let head, colCount;
  if (mode === 'pay') {
    head = `<thead>
        <tr><th rowspan="2" class="an-name-col">${st.firstColLabel}</th><th colspan="2">Выплата</th></tr>
        <tr>${th('total', 'count', 'Кол-во', 'col-center')}${th('total', 'sum', 'Сумма', 'col-right')}</tr>
      </thead>`;
    colCount = 3;
  } else {
    head = `<thead>
        <tr>
          <th rowspan="2" class="an-name-col">${st.firstColLabel}</th>
          ${CKS_COLS.map(k => `<th colspan="2">${k}</th>`).join('')}
        </tr>
        <tr>${CKS_COLS.map(k => th(k, 'count', 'Кол-во', 'col-center') + th(k, 'sum', 'Сумма', 'col-right')).join('')}</tr>
      </thead>`;
    colCount = 1 + CKS_COLS.length * 2;
  }
  const rows = _anSortedRows(pfx);
  if (!rows.length) {
    return `<table class="an-table">${head}<tbody><tr><td colspan="${colCount}" class="loading">Нет данных</td></tr></tbody></table>`;
  }
  const body = rows.map(r => {
    const nm = _escHtml(r.name || '—');
    const clk = st.onRowClick ? ` class="an-clickable" onclick="${st.onRowClick}(${JSON.stringify(r.id).replace(/"/g, '&quot;')})"` : '';
    let cols;
    if (mode === 'pay') {
      cols = `<td class="col-center"><b>${formatInt(r.total_count)}</b></td>` +
             `<td class="col-right"><b>${formatCompact(r.total_sum)}</b></td>`;
    } else {
      cols = CKS_COLS.map(k => {
        const c = r.cks?.[k];
        return `<td class="col-center">${c && c.count ? formatInt(c.count) : '—'}</td>` +
               `<td class="col-right">${c && c.sum ? formatCompact(c.sum) : '—'}</td>`;
      }).join('');
    }
    return `<tr${clk}><td class="an-name-col" title="${nm}">${nm}</td>${cols}</tr>`;
  }).join('');
  return `<table class="an-table">${head}<tbody>${body}</tbody></table>`;
}

function sortAnalytics(pfx, group, metric) {
  const st = _anCache[pfx];
  if (!st) return;
  if (st.sortGroup === group && st.sortMetric === metric) st.sortDir = -st.sortDir;
  else { st.sortGroup = group; st.sortMetric = metric; st.sortDir = -1; }
  const wrap = document.getElementById(`${pfx}-tablewrap`);
  if (wrap) wrap.innerHTML = _analyticsTableHtml(pfx);
}

function setAnalyticsMode(pfx, mode) {
  const st = _anCache[pfx];
  if (!st) return;
  st.mode = mode;
  st.sortGroup = 'total'; st.sortMetric = 'sum'; st.sortDir = -1;
  document.querySelectorAll(`#${pfx}-modeseg .an-mode-btn`).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const wrap = document.getElementById(`${pfx}-tablewrap`);
  if (wrap) wrap.innerHTML = _analyticsTableHtml(pfx);
}

// блок графиков под таблицей аналитики: ЦКС (столбчатый) + гендер/возраст
function _analyticsChartsHtml(pfx) {
  return `
    <div class="an-charts">
      <div class="an-chart-box">
        <div class="kpi-demo-title">Уровень благосостояния по ЦКС</div>
        <div class="an-sdu-wrap"><canvas id="${pfx}-sdu"></canvas></div>
      </div>
      <div class="an-chart-box">
        <div class="kpi-demo-title">Гендер</div>
        <div id="${pfx}-ga" class="ga-chart"></div>
      </div>
    </div>`;
}
function _renderAnalyticsCharts(kpi, pfx) {
  _renderSduBarChart(kpi.cks_gender || {}, `${pfx}-sdu`);
  _renderGeoGenderAge(kpi.male_sum || 0, kpi.female_sum || 0, kpi.age || {}, kpi.age_gender || {}, `${pfx}-ga`);
}

async function loadAnalyticsPaytypes() {
  const el = document.getElementById('an-paytypes');
  if (!el) return;
  el.innerHTML = '<div class="loading" style="padding:24px">Загрузка…</div>';
  const p = buildFilterParams();
  p.set('dim', 'paytype');
  try {
    const [rows, kpi] = await Promise.all([
      fetch(`/api/analytics?${p}`, { credentials: 'include' }).then(r => r.json()),
      fetch(`/api/kpi?${buildFilterParams()}`, { credentials: 'include' }).then(r => r.json()),
    ]);
    const scope = currentRaion ? (raionStats[currentRaion]?.name || '')
      : (currentRegion ? _regionName(currentRegion) : 'Казахстан');
    _anCache['anp'] = { rows: Array.isArray(rows) ? rows : [], firstColLabel: 'Вид помощи',
      onRowClick: null, mode: 'pay', sortGroup: 'total', sortMetric: 'sum', sortDir: -1 };
    el.innerHTML = `<div class="an-head-row"><div class="an-left"><span class="an-scope">${_escHtml(scope)}</span>${_anModeSeg('anp')}</div></div>` +
      `<div class="table-wrap an-scroll" id="anp-tablewrap">${_analyticsTableHtml('anp')}</div>` +
      _analyticsChartsHtml('anp');
    _renderAnalyticsCharts(kpi, 'anp');
  } catch (e) {
    console.error('analytics paytypes', e);
    el.innerHTML = '<div class="loading" style="padding:24px">Ошибка загрузки</div>';
  }
}

async function loadAnalyticsRegions() {
  const el = document.getElementById('an-regions');
  if (!el) return;
  el.innerHTML = '<div class="loading" style="padding:24px">Загрузка…</div>';
  const inRegion = currentRegion != null;
  const p = _demoParams();
  if (inRegion) { p.set('dim', 'raion'); p.set('region_id', currentRegion); }
  else { p.set('dim', 'region'); }
  try {
    const [rows, kpi] = await Promise.all([
      fetch(`/api/analytics?${p}`, { credentials: 'include' }).then(r => r.json()),
      fetch(`/api/kpi?${buildFilterParams()}`, { credentials: 'include' }).then(r => r.json()),
    ]);
    const back = inRegion
      ? `<button type="button" class="gs-back-btn" onclick="goBack()">← Все регионы</button>`
      : '';
    const scope = inRegion ? _regionName(currentRegion) : 'Все регионы';
    const onClick = inRegion ? 'selectRaion' : 'drillRegion';
    _anCache['anr'] = { rows: Array.isArray(rows) ? rows : [], firstColLabel: inRegion ? 'Район' : 'Регион',
      onRowClick: onClick, mode: 'pay', sortGroup: 'total', sortMetric: 'sum', sortDir: -1 };
    el.innerHTML = `<div class="an-head-row"><div class="an-left"><span class="an-scope">${_escHtml(scope)}</span>${_anModeSeg('anr')}</div>${back}</div>` +
      `<div class="table-wrap an-scroll" id="anr-tablewrap">${_analyticsTableHtml('anr')}</div>` +
      _analyticsChartsHtml('anr');
    _renderAnalyticsCharts(kpi, 'anr');
  } catch (e) {
    console.error('analytics regions', e);
    el.innerHTML = '<div class="loading" style="padding:24px">Ошибка загрузки</div>';
  }
}

// ─────────────────────────── init ───────────────────────────
async function init() {
  map = L.map('map', { zoomControl: true, attributionControl: false, zoomSnap: 0.5 })
    .setView(KZ_VIEW.center, _kzZoom());

  new (L.Control.extend({
    options: { position: 'topleft' },
    onAdd(m) {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', 'lc-home-btn', div);
      a.href = '#'; a.title = 'Сбросить вид карты'; a.setAttribute('role', 'button'); a.innerHTML = '⌂';
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
        map.flyTo(KZ_VIEW.center, _kzZoom(), { duration: 0.7 });
      });
      return div;
    }
  }))().addTo(map);

  tileLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles © Esri', maxZoom: 18, maxNativeZoom: 16 }
  ).addTo(map);
  tileLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, maxNativeZoom: 16, pane: 'tilePane' }
  ).addTo(map);
  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));

  const [regGeo, raiGeo, stats, regC, raiC] = await Promise.all([
    fetch('/map/regions_polygon.json').then(r => r.json()),
    fetch('/map/raion_polygon.json').then(r => r.json()),
    fetch('/api/regions', { credentials: 'include' }).then(r => r.json()),
    fetch('/map/region_centroids.json').then(r => r.json()),
    fetch('/map/raion_centroids.json').then(r => r.json()),
  ]);

  regionGeoJSON = regGeo;
  raionGeoJSON = raiGeo;
  (stats || []).forEach(s => { regionStats[s.id_reg] = s; });
  (regC || []).forEach(c => { regionCentroids[c.id_reg] = c.centroid; });
  (raiC || []).forEach(c => { raionCentroids[Math.round(c.id_rai)] = c.centroid; });

  (() => {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const el = document.getElementById('header-date');
    if (el) el.textContent = `Данные актуализированы ${dd}.${mm}.${d.getFullYear()}`;
  })();

  const mapLegend = L.control({ position: 'bottomright' });
  mapLegend.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div class="ml-title">Сумма выплат</div>
      <div class="ml-item"><span class="ml-dot" style="background:#1e8449"></span>высокая</div>
      <div class="ml-item"><span class="ml-dot" style="background:#4fb573"></span>средняя</div>
      <div class="ml-item"><span class="ml-dot" style="background:#d6f0dd"></span>низкая</div>
      <div class="ml-item"><span class="ml-dot" style="background:#4a5258"></span>нет данных</div>`;
    return div;
  };
  mapLegend.addTo(map);

  renderRegions();
  await refreshKPI();
}

// ─────────────────────────── boot ───────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  CURRENT_USER = await fetchMe();
  if (!CURRENT_USER) { showLogin(); return; }

  // переключатель метрики динамики
  document.querySelectorAll('#dyn-metric-seg [data-dmetric]').forEach(btn => {
    btn.addEventListener('click', () => {
      _dynMetric = btn.dataset.dmetric;
      document.querySelectorAll('#dyn-metric-seg [data-dmetric]').forEach(b =>
        b.classList.toggle('active', b === btn));
      loadDynamics();
    });
  });

  init();
});

// ═══════════════════ Раздел 2: Совпадение ИИ с заключениями врачей ═══════════════════
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

let _aiMap = null, _aiLayer = null, _aiLabels = null;
let _aiRegions = [], _aiRegById = {};
let _aiForm = 'all';        // 'all' | 'z' | 'o'
let _aiRegion = null;       // выбранный kato
let _aiTab = 'map';
let _aiInited = false;

function switchSection(sec) {
  const isAi = sec === 'ai';
  document.getElementById('section-main').style.display = isAi ? 'none' : '';
  document.getElementById('section-ai').style.display = isAi ? 'flex' : 'none';
  document.getElementById('s1-title').style.display = isAi ? 'none' : '';
  document.getElementById('ai-title').style.display = isAi ? '' : 'none';
  const bc = document.getElementById('breadcrumb'); if (bc) bc.style.display = isAi ? 'none' : '';
  const abc = document.getElementById('ai-breadcrumb'); if (abc) abc.style.display = isAi ? '' : 'none';
  document.body.classList.toggle('sec-ai', isAi);
  document.querySelectorAll('.section-switch .sec-btn').forEach(b => b.classList.toggle('active', b.dataset.sec === sec));
  if (isAi) {
    if (!_aiInited) aiInit();
    else setTimeout(() => _aiMap && _aiMap.invalidateSize(), 60);
  }
}

async function aiInit() {
  _aiInited = true;
  if (!regionGeoJSON) {
    try { regionGeoJSON = await fetch('/map/regions_polygon.json').then(r => r.json()); } catch (_) {}
  }
  if (!Object.keys(regionCentroids).length) {
    try { (await fetch('/map/region_centroids.json').then(r => r.json())).forEach(c => { regionCentroids[c.id_reg] = c.centroid; }); } catch (_) {}
  }
  _aiMap = L.map('ai-map', { zoomControl: true, attributionControl: false, zoomSnap: 0.5 })
    .setView(KZ_VIEW.center, KZ_VIEW.zoom);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, maxNativeZoom: 16 }).addTo(_aiMap);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, maxNativeZoom: 16, pane: 'tilePane' }).addTo(_aiMap);
  const lg = L.control({ position: 'bottomright' });
  lg.onAdd = function () {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = `<div class="ml-title">Совпадение по группе</div>
      <div class="ml-item"><span class="ml-dot" style="background:#2FD9C5"></span>68% и выше</div>
      <div class="ml-item"><span class="ml-dot" style="background:#7FC9A6"></span>64–68%</div>
      <div class="ml-item"><span class="ml-dot" style="background:#FFB347"></span>60–64%</div>
      <div class="ml-item"><span class="ml-dot" style="background:#E8705A"></span>ниже 60%</div>`;
    return d;
  };
  lg.addTo(_aiMap);
  await aiRefresh();
  setTimeout(() => _aiMap.invalidateSize(), 80);
}

async function aiRefresh() {
  const rp = _aiRegion != null ? `?region_id=${_aiRegion}` : '';
  try {
    const [summary, regs] = await Promise.all([
      fetch(`/api/ai/summary${rp}`, { credentials: 'include' }).then(r => r.json()),
      fetch('/api/ai/regions', { credentials: 'include' }).then(r => r.json()),
    ]);
    _aiRegions = regs; _aiRegById = {}; regs.forEach(r => { _aiRegById[r.id_reg] = r; });
    aiRenderKPIs(summary);
    aiRenderRating(regs);
    aiRenderMap();
    aiUpdateCrumb();
    if (_aiTab !== 'map') aiRenderTab(_aiTab, summary);
  } catch (e) { console.error('aiRefresh', e); }
}

const aiPct = p => String(p).replace('.', ',') + '%';
function _aiW(id, pct) { const el = document.getElementById(id); if (el) el.style.width = Math.min(100, pct) + '%'; }

function aiRenderKPIs(s) {
  setText('ai-total', formatInt(s.total));
  setText('ai-total-sub', `дети ${formatInt(s.deti)} · взрослые ${formatInt(s.vzr)}`);
  setText('ai-grp-pct', aiPct(s.grp_pct)); setText('ai-grp-cnt', `${formatInt(s.grp_all)} заключений`);
  _aiW('ai-grp-zbar', s.grp_z_pct); setText('ai-grp-z', aiPct(s.grp_z_pct));
  _aiW('ai-grp-obar', s.grp_o_pct); setText('ai-grp-o', aiPct(s.grp_o_pct));
  setText('ai-full-pct', aiPct(s.full_pct)); setText('ai-full-cnt', `${formatInt(s.full_all)} заключений`);
  _aiW('ai-full-zbar', s.full_z_pct); setText('ai-full-z', aiPct(s.full_z_pct));
  _aiW('ai-full-obar', s.full_o_pct); setText('ai-full-o', aiPct(s.full_o_pct));
  // точные цифры в подсказках прогресс-баров
  const setBarTitle = (id, txt) => { const el = document.getElementById(id); if (el) { el.title = txt; if (el.parentElement) el.parentElement.title = txt; } };
  setBarTitle('ai-grp-zbar', `${formatInt(s.z_grp)} заключений (${aiPct(s.grp_z_pct)})`);
  setBarTitle('ai-grp-obar', `${formatInt(s.o_grp)} заключений (${aiPct(s.grp_o_pct)})`);
  setBarTitle('ai-full-zbar', `${formatInt(s.z_full)} заключений (${aiPct(s.full_z_pct)})`);
  setBarTitle('ai-full-obar', `${formatInt(s.o_full)} заключений (${aiPct(s.full_o_pct)})`);
  _aiW('ai-form-zbar', s.form_z_pct); _aiW('ai-form-obar', s.form_o_pct);
  setText('ai-form-z', formatInt(s.z_tot)); setText('ai-form-z-sub', `заочное · ${aiPct(s.form_z_pct)}`);
  setText('ai-form-o', formatInt(s.o_tot)); setText('ai-form-o-sub', `очное · ${aiPct(s.form_o_pct)}`);
}

function aiColor(pct) {
  if (pct >= 68) return '#2FD9C5';
  if (pct >= 64) return '#7FC9A6';
  if (pct >= 60) return '#FFB347';
  return '#E8705A';
}
function aiRegMetric(r) {
  if (_aiForm === 'z') return r.z_match_pct;
  if (_aiForm === 'o') return r.o_match_pct;
  return r.match_pct;
}
function aiRenderMap() {
  if (!_aiMap || !regionGeoJSON) return;
  if (_aiLayer) { _aiMap.removeLayer(_aiLayer); }
  _aiLayer = L.geoJSON(regionGeoJSON, {
    style: f => {
      const r = _aiRegById[Math.round(f.properties.id_reg)];
      const sel = _aiRegion != null && Math.round(f.properties.id_reg) === _aiRegion;
      return { fillColor: r ? aiColor(aiRegMetric(r)) : '#39406b', weight: sel ? 2.5 : 1,
        color: sel ? '#B9C5FF' : '#2B3572', fillOpacity: 0.82 };
    },
    onEachFeature: (f, layer) => {
      const r = _aiRegById[Math.round(f.properties.id_reg)];
      layer.bindTooltip(() => r ? `${_toTitleCase(r.name)}: ${formatInt(r.total)} · совп ${aiPct(aiRegMetric(r))}` : '',
        { sticky: true, className: 'map-name-tip' });
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2.5, color: '#B9C5FF' }); },
        mouseout(e) { _aiLayer.resetStyle(e.target); },
        click() { aiSelectRegion(Math.round(f.properties.id_reg)); },
      });
    },
  }).addTo(_aiMap);
  aiRenderLabels();
}

// подписи процента совпадения на областях (как суммы в «Мерах господдержки»)
function aiRenderLabels() {
  if (!_aiMap) return;
  if (_aiLabels) { _aiMap.removeLayer(_aiLabels); }
  _aiLabels = L.layerGroup();
  Object.entries(regionCentroids).forEach(([id, c]) => {
    if (!c) return;
    const r = _aiRegById[Math.round(id)];
    if (!r) return;
    const m = L.marker([c[1], c[0]], {
      icon: L.divIcon({ className: 'map-label', html: `<span>${Math.round(aiRegMetric(r))}%</span>`, iconSize: null, iconAnchor: [0, 0] }),
      interactive: false,
    });
    _aiLabels.addLayer(m);
  });
  _aiLabels.addTo(_aiMap);
}
function aiSelectRegion(kato) { _aiRegion = (_aiRegion === kato) ? null : kato; aiRefresh(); }
function aiGoBack() { _aiRegion = null; aiRefresh(); if (_aiMap) _aiMap.setView(KZ_VIEW.center, KZ_VIEW.zoom); }
function aiUpdateCrumb() {
  const el = document.getElementById('ai-breadcrumb'); if (!el) return;
  const r = _aiRegion != null ? _aiRegById[_aiRegion] : null;
  el.innerHTML = r
    ? `<span onclick="aiGoBack()">Казахстан</span> / ${_escHtml(_toTitleCase(r.name))}`
    : `<span onclick="aiGoBack()">Казахстан</span>`;
}
function aiSetForm(f) {
  _aiForm = f;
  document.querySelectorAll('#ai-form-seg .ai-form-btn').forEach(b => b.classList.toggle('active', b.dataset.aiform === f));
  aiRenderMap();
}

function aiRenderRating(rows) {
  const el = document.getElementById('ai-rating-list'); if (!el) return;
  el.innerHTML = rows.map((r, i) => {
    const t = (r.z_tot + r.o_tot) || 1;
    const nm = _escHtml(_toTitleCase(r.name));
    return `<div class="ai-rating-row" onclick="aiSelectRegion(${r.id_reg})">
      <span class="idx">${i + 1}</span>
      <span class="nm" title="${nm}">${nm}</span>
      <span class="ai-rr-bar" title="заочно ${formatInt(r.z_tot)} · очно ${formatInt(r.o_tot)}"><i class="z" style="width:${r.z_tot / t * 100}%"></i><i class="o" style="width:${r.o_tot / t * 100}%"></i></span>
      <span class="tot">${formatInt(r.total)}</span>
      <span class="mt">${Math.round(r.match_pct)}%</span>
    </div>`;
  }).join('');
}

// ── вкладки раздела ──
function aiSwitchTab(name) {
  _aiTab = name;
  document.querySelectorAll('#section-ai .ai-tab').forEach(b => b.classList.toggle('active', b.dataset.aitab === name));
  document.querySelectorAll('#section-ai .ai-pane').forEach(p => p.classList.toggle('active', p.id === `ai-tab-${name}`));
  // переключатель форм (Все/Заочное/Очное) виден только на вкладке «Карта»
  const seg = document.getElementById('ai-form-seg');
  if (seg) seg.style.display = name === 'map' ? '' : 'none';
  if (name === 'map') setTimeout(() => _aiMap && _aiMap.invalidateSize(), 60);
  else aiRenderTab(name);
}
async function aiRenderTab(name, summary) {
  const rp = _aiRegion != null ? `?region_id=${_aiRegion}` : '';
  try {
    if (name === 'levels') {
      const s = summary || await fetch(`/api/ai/summary${rp}`, { credentials: 'include' }).then(r => r.json());
      aiRenderLevels(s);
    } else if (name === 'groups') {
      aiRenderGroups(await fetch(`/api/ai/groups${rp}`, { credentials: 'include' }).then(r => r.json()));
    } else if (name === 'diseases') {
      aiRenderDiseases(await fetch(`/api/ai/diseases${rp}`, { credentials: 'include' }).then(r => r.json()));
    } else if (name === 'method') {
      aiRenderMethod();
    }
  } catch (e) { console.error('aiRenderTab', name, e); }
}
// круговой (donut) чарт «совпала группа» + две полоски (срок / группа и срок) — как в мокапе
function _aiDonutCol(title, color, pct, matched, total, srokPct, srokCnt, fullPct, fullCnt) {
  const C = 351.9, dash = (Math.min(100, pct) / 100 * C).toFixed(1);
  const bar = (lab, p, cnt) => `<div title="${formatInt(cnt)} заключений (${aiPct(p)})">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>${lab}</span><span style="color:#EDF1FF;font-weight:500;">${aiPct(p)}</span></div>
      <div style="height:6px;border-radius:3px;background:#232B63;overflow:hidden;"><div style="width:${Math.min(100, p)}%;height:6px;background:${color};"></div></div>
    </div>`;
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:14px;width:214px;">
    <div style="font-size:15px;font-weight:600;color:${color};">${title}</div>
    <div style="position:relative;width:140px;height:140px;" title="группа совпала: ${formatInt(matched)} из ${formatInt(total)} (${aiPct(pct)})">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r="56" fill="none" stroke="#232B63" stroke-width="14"/>
        <circle cx="70" cy="70" r="56" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash} ${C}" transform="rotate(-90 70 70)"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Unbounded','Golos Text',sans-serif;font-size:22px;font-weight:600;color:#EDF1FF;">${aiPct(pct)}</div>
    </div>
    <div style="font-size:13px;color:#A3AEDD;text-align:center;">группа совпала: ${formatInt(matched)} из ${formatInt(total)}</div>
    <div style="width:100%;display:flex;flex-direction:column;gap:10px;font-size:12px;color:#A3AEDD;">${bar('срок', srokPct, srokCnt)}${bar('группа и срок', fullPct, fullCnt)}</div>
  </div>`;
}
function aiRenderLevels(s) {
  const el = document.getElementById('ai-tab-levels'); if (!el) return;
  el.innerHTML = `<div class="ai-colbox" style="flex:1;align-items:center;justify-content:center;">
    <div style="display:flex;gap:64px;flex-wrap:wrap;justify-content:center;">
      ${_aiDonutCol('Заочное', '#FFB347', s.z_grp_pct, s.z_grp, s.z_tot, s.z_srok_pct, s.z_srok, s.z_full_pct, s.z_full)}
      ${_aiDonutCol('Очное', '#2FD9C5', s.o_grp_pct, s.o_grp, s.o_tot, s.o_srok_pct, s.o_srok, s.o_full_pct, s.o_full)}
    </div>
  </div>`;
}
function aiRenderGroups(rows) {
  const el = document.getElementById('ai-tab-groups'); if (!el) return;
  const max = Math.max(1, ...rows.map(r => Math.max(r.z, r.o)));
  // строки распределяются на всю высоту блока (justify-content:space-between)
  el.innerHTML = `<div class="ai-colbox" style="flex:1">
    <div class="ai-legend"><span><span class="dot" style="background:#FFB347"></span>Заочное</span>
      <span><span class="dot" style="background:#2FD9C5"></span>Очное</span>
      <span style="color:#A3AEDD">Совпало по группе инвалидности, число заключений</span></div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;gap:12px;min-height:0;">
      ${rows.map(r => {
        const tt = (r.z + r.o) || 1;
        const pz = Math.round(r.z / tt * 100), po = 100 - pz;
        return `<div class="ai-grp-row"><div class="lab">${_escHtml(r.label)}</div>
      <div class="ai-grp-bars">
        <div class="ai-grp-bar" title="заочное: ${formatInt(r.z)} (${pz}%)"><div class="tr"><div class="fz" style="width:${r.z / max * 100}%"></div></div><span style="width:64px;text-align:right;color:#EDF1FF">${formatInt(r.z)}</span></div>
        <div class="ai-grp-bar" title="очное: ${formatInt(r.o)} (${po}%)"><div class="tr"><div class="fo" style="width:${r.o / max * 100}%"></div></div><span style="width:64px;text-align:right;color:#EDF1FF">${formatInt(r.o)}</span></div>
      </div></div>`;
      }).join('')}
    </div></div>`;
}
function _aiPctBar(p, color, cnt) {
  const tt = cnt == null ? '' : ` title="${formatInt(cnt)} заключений (${Math.round(p)}%)"`;
  return `<div style="display:flex;align-items:center;gap:10px;height:8px;"${tt}>
    <div style="flex-grow:1;height:6px;border-radius:3px;background:#232B63;overflow:hidden;"><div style="width:${Math.min(100, p)}%;height:6px;background:${color};"></div></div>
    <div style="width:46px;text-align:right;font-size:12px;color:#EDF1FF;font-weight:500;">${Math.round(p)}%</div></div>`;
}
function aiRenderDiseases(rows) {
  const el = document.getElementById('ai-tab-diseases'); if (!el) return;
  const GRID = 'display:grid;grid-template-columns:minmax(220px,300px) 84px 147px minmax(0,1fr) minmax(0,1fr);column-gap:20px;';
  const twoBar = (zp, op, zc, oc) => `<div style="display:flex;flex-direction:column;gap:8px;">${_aiPctBar(zp, '#FFB347', zc)}${_aiPctBar(op, '#2FD9C5', oc)}</div>`;
  const header = `<div style="${GRID}align-items:center;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#A3AEDD;height:28px;position:sticky;top:0;background:#151B45;z-index:1;">
    <div>Класс болезней</div><div style="text-align:right;">Всего</div><div>Соотношение форм</div><div>Совпала группа, % от формы</div><div>Группа и срок, % от формы</div></div>`;
  const body = rows.map(r => {
    const t = (r.z_tot + r.o_tot) || 1;
    return `<div style="${GRID}align-items:center;height:52px;border-top:1px solid #2B3572;">
      <div style="font-size:13px;color:#EDF1FF;line-height:1.3;">${_escHtml(r.disease)}</div>
      <div style="font-family:'Unbounded','Golos Text',sans-serif;font-size:14px;font-weight:500;color:#EDF1FF;text-align:right;">${formatInt(r.total)}</div>
      <div style="display:flex;flex-direction:column;gap:5px;" title="заочно ${formatInt(r.z_tot)} (${Math.round(r.z_tot / t * 100)}%) · очно ${formatInt(r.o_tot)} (${Math.round(r.o_tot / t * 100)}%)">
        <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:#232B63;"><div style="width:${r.z_tot / t * 100}%;background:#FFB347;"></div><div style="width:${r.o_tot / t * 100}%;background:#2FD9C5;"></div></div>
        <div style="font-size:11px;color:#A3AEDD;white-space:nowrap;">заочно ${formatInt(r.z_tot)} · очно ${formatInt(r.o_tot)}</div>
      </div>
      ${twoBar(r.grp_z_pct, r.grp_o_pct, r.z_grp, r.o_grp)}
      ${twoBar(r.full_z_pct, r.full_o_pct, r.z_full, r.o_full)}
    </div>`;
  }).join('');
  el.innerHTML = `<div class="ai-scroll">${header}${body}</div>`;
}
function aiRenderMethod() {
  const el = document.getElementById('ai-tab-method'); if (!el) return;
  // по центру блока по вертикали
  el.innerHTML = `<div style="flex:1;display:flex;align-items:center;"><div class="ai-method">
    <div class="m"><span class="t">Совпадение</span>ИИ формирует предварительное заключение по группе инвалидности и сроку. Совпадением считается случай, когда группа инвалидности, определённая ИИ, совпала с решением врача-эксперта.</div>
    <div class="m"><span class="t">Полное совпадение</span>Совпали и группа инвалидности, и срок инвалидности — заключение ИИ полностью соответствует решению эксперта.</div>
    <div class="m"><span class="t">Форма и цвет</span>Заочное освидетельствование — оранжевый, очное — бирюзовый. Цвет региона на карте отражает долю совпадений по группе: чем зеленее, тем выше.</div>
  </div></div>`;
}
