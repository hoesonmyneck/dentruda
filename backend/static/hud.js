/* ═══════════════════════════════════════════════════════════════════════════
   HUD-скин: мини-графики в карточках показателей.

   Файл работает только при <html data-skin="hud">: в классическом оформлении
   холсты удаляются, наблюдатели отключаются, app.js не затрагивается.

   Данные берутся из тех же API и с теми же фильтрами, что и остальной дашборд
   (buildFilterParams() объявлен в app.js), поэтому графики соответствуют
   выбранному региону/району и активным фильтрам.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
                'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  // какой график в какой карточке
  var CARDS = [
    { id: 'kpi-card-recipients', kind: 'line', src: 'dyn',   field: 'people',    color: '#22d3ee' },
    { id: 'kpi-card-sum',        kind: 'line', src: 'dyn',   field: 'total_sum', color: '#4a9bff' },
    { id: 'kpi-card-help-types', kind: 'bar',  src: 'types', field: 'total_sum', color: '#5ef0c8' }
  ];

  var charts = {};      // id карточки → экземпляр Chart
  var observer = null;
  var reloadTimer = null;
  var inFlight = 0;     // счётчик запросов: отбрасываем ответы устаревших

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function isHud() {
    return document.documentElement.getAttribute('data-skin') === 'hud';
  }

  function params() {
    // buildFilterParams объявлена в app.js; до её загрузки — без фильтров
    try {
      if (typeof buildFilterParams === 'function') return buildFilterParams().toString();
    } catch (e) {}
    return '';
  }

  function getJSON(url) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* Полупрозрачная заливка под линией */
  function fill(ctx, area, color) {
    if (!area) return 'transparent';
    var g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, hexA(color, 0.50));
    g.addColorStop(1, hexA(color, 0.02));
    return g;
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* Chart.js в responsive-режиме меряет РОДИТЕЛЯ холста. Если положить холст
     прямо в карточку, он получит её ширину и вылезет за свою ячейку сетки,
     поэтому холст всегда живёт внутри собственной обёртки. */
  function canvasFor(card) {
    var wrap = card.querySelector('.kpi-spark-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'kpi-spark-wrap';
      // список видов помощи раскрывается поверх — обёртка должна идти до него
      var anchor = card.querySelector('.kpi-expand-corners') || null;
      card.insertBefore(wrap, anchor);
    }
    var c = wrap.querySelector('.kpi-spark');
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'kpi-spark';
      wrap.appendChild(c);
    }
    // световой пробег — отдельным слоем, анимируется средствами CSS
    if (!wrap.querySelector('.kpi-spark-sweep')) {
      var sw = document.createElement('i');
      sw.className = 'kpi-spark-sweep';
      wrap.appendChild(sw);
    }
    return c;
  }

  /* ── Тултип отдельным элементом в <body> ──────────────────────────────────
     Холст графика лежит в подложке карточки (z-index:0, под меткой и числом)
     и накрыт маской затухания, поэтому нарисованный на нём тултип оказывался
     перекрыт. Элемент в body с position:fixed не зависит ни от стекинга
     карточки, ни от её overflow:hidden. */
  function tipEl() {
    var t = document.getElementById('hud-tip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'hud-tip';
      t.className = 'hud-tip';
      document.body.appendChild(t);
    }
    return t;
  }

  function hideTip() {
    var t = document.getElementById('hud-tip');
    if (t) t.style.opacity = '0';
  }

  function showTip(context) {
    var t = tipEl();
    var m = context.tooltip;
    if (!m || m.opacity === 0) { t.style.opacity = '0'; return; }

    var title = (m.title && m.title[0]) || '';
    var body = (m.body && m.body[0] && m.body[0].lines && m.body[0].lines[0]) || '';
    t.innerHTML = '<span class="hud-tip-t">' + esc(title) + '</span>'
                + '<span class="hud-tip-v">' + esc(body) + '</span>';

    var r = context.chart.canvas.getBoundingClientRect();
    var x = r.left + m.caretX;
    var y = r.top + m.caretY;

    t.style.opacity = '1';
    t.style.left = x + 'px';

    // карточки стоят у верхнего края — если сверху не помещается, показываем снизу
    var h = t.offsetHeight || 34;
    if (y - h - 14 < 6) {
      t.style.top = (y + 14) + 'px';
      t.style.transform = 'translate(-50%, 0)';
    } else {
      t.style.top = (y - 14) + 'px';
      t.style.transform = 'translate(-50%, -100%)';
    }
  }

  /* Линия раскрывается «шторкой» слева направо (см. revealPlugin и tick):
     точка проявляется ровно тогда, когда край шторки до неё доходит.
     Поточечная анимация Chart.js для этого не годится — она не прячет точки,
     а стягивает их к предыдущей, и в затухающей левой части карточки это
     выглядит как мгновенное появление всего графика.
     Столбцы оставляем на штатной анимации Chart.js — они растут от нуля. */
  function motion(isLine, count) {
    if (prefersStill()) return { duration: 0 };
    if (isLine) return { duration: 0 };
    return {
      duration: 620,
      easing: 'easeOutQuart',
      delay: function (ctx) { return ctx.type === 'data' ? ctx.index * 55 : 0; },
      // у столбцов нет шторки, поэтому волну включаем здесь
      onComplete: function (a) { if (a && a.chart) startBounce(a.chart); }
    };
  }

  function prefersStill() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  /* Подпись набора данных — чтобы отличить реальное изменение от повторного
     вызова с теми же числами. */
  function sigOf(labels, values) {
    return labels.join('') + '' + values.join('');
  }

  function draw(cfg, labels, values) {
    var card = document.getElementById(cfg.id);
    if (!card || !window.Chart) return;
    if (!values.length || values.every(function (v) { return !v; })) {
      destroy(cfg.id);
      return;
    }

    /* app.js анимирует счётчик KPI, меняя текст покадрово; наблюдатель за
       текстом срабатывает на каждый кадр и раньше заставлял перерисовывать
       график заново — линия успевала дочертиться, пропасть и начать сначала.
       Если данные не изменились, оставляем существующий график как есть. */
    var s = sigOf(labels, values);
    if (charts[cfg.id] && charts[cfg.id].$hudSig === s) return;

    var cv = canvasFor(card);
    destroy(cfg.id);

    var isLine = cfg.kind === 'line';
    charts[cfg.id] = new Chart(cv.getContext('2d'), {
      type: isLine ? 'line' : 'bar',
      plugins: isLine ? [revealPlugin] : [],
      data: {
        labels: labels,
        datasets: [{
          data: values,
          borderColor: cfg.color,
          borderWidth: isLine ? 2 : 0,
          tension: 0.38,
          pointRadius: isLine ? 4 : 0,
          pointBackgroundColor: cfg.color,
          pointBorderColor: 'rgba(6,14,38,0.85)',
          pointBorderWidth: 2,
          pointHoverRadius: isLine ? 7 : 0,
          pointHoverBackgroundColor: '#fff',
          pointHoverBorderColor: cfg.color,
          pointHoverBorderWidth: 2,
          fill: isLine,
          backgroundColor: isLine
            ? function (c) { return fill(c.chart.ctx, c.chart.chartArea, cfg.color); }
            : hexA(cfg.color, 0.55),
          borderRadius: isLine ? 0 : 3,
          barPercentage: 0.78,
          categoryPercentage: 0.9
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onResize: function (ch) { ch.$needBase = true; },
        animation: motion(isLine, values.length),
        layout: { padding: { top: 16, bottom: 10, left: 0, right: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,               // рисуем своим DOM-элементом, см. showTip
            external: showTip,
            displayColors: false,
            callbacks: {
              title: function (it) { return it[0].label; },
              label: function (it) {
                var v = it.parsed.y;
                return cfg.field === 'total_sum'
                  ? (typeof formatCompact === 'function' ? formatCompact(v) + ' ₸' : v + ' ₸')
                  : (typeof formatInt === 'function' ? formatInt(v) : String(v));
              }
            }
          }
        },
        scales: {
          x: { display: false, grid: { display: false } },
          y: { display: false, grid: { display: false },
               beginAtZero: cfg.kind === 'bar', grace: '12%' }
        }
      }
    });
    charts[cfg.id].$hudSig = s;
    charts[cfg.id].$isLine = isLine;
    if (isLine) startReveal(charts[cfg.id]);
  }

  /* Шторка: пока $reveal < 1, рисуем только левую часть области графика. */
  var REVEAL_MS = 1500;
  var revealPlugin = {
    id: 'hudReveal',
    /* Обязательно именно здесь: с duration:0 Chart.js рисует график
       синхронно внутри конструктора, и без этого успевал мелькнуть
       целиком до того, как шторка выставится снаружи. */
    beforeInit: function (chart) { chart.$reveal = 0; },
    beforeDatasetsDraw: function (chart) {
      var r = chart.$reveal;
      if (r == null || r >= 1) return;
      var a = chart.chartArea;
      if (!a) return;
      var c = chart.ctx;
      c.save();
      c.beginPath();
      // с запасом по вертикали и краям, чтобы точки не срезало пополам
      c.rect(a.left - 10, a.top - 24, (a.width + 20) * r, a.height + 48);
      c.clip();
      chart.$clipped = true;
    },
    afterDatasetsDraw: function (chart) {
      if (chart.$clipped) { chart.ctx.restore(); chart.$clipped = false; }
    }
  };

  /* ── Волна подскока по точкам в простое ─────────────────────────────────
     Chart.js не умеет бесконечные анимации, поэтому крутим свой кадровый цикл:
     смещаем y точек и перерисовываем холст (chart.draw() сам его очищает).
     Линия следует за точками — волна проходит по всему графику. */
  var BOUNCE_PERIOD = 5600;   // цикл: проход волны + пауза
  var BOUNCE_TRAVEL = 0.68;   // доля цикла, за которую волна проходит график
  var BOUNCE_AMP = 9;         // высота гребня, px
  var BOUNCE_W = 3.2;         // ширина гребня в точках: чем больше, тем плавнее
  var bounceRaf = null;
  var bounceLast = 0;

  function startBounce(ch) {
    if (prefersStill()) return;
    if (ch.$bounce) { kick(); return; }   // уже идёт — базу не пересчитываем
    ch.$bounce = true;
    ch.$needBase = true;
    kick();
  }

  function startReveal(ch) {
    if (prefersStill()) { ch.$reveal = 1; ch.draw(); return; }
    ch.$reveal = 0;
    ch.$revealT0 = performance.now();
    kick();
  }

  function kick() {
    if (!bounceRaf) bounceRaf = requestAnimationFrame(bounceTick);
  }

  function stopBounce() {
    if (bounceRaf) { cancelAnimationFrame(bounceRaf); bounceRaf = null; }
  }

  function bounceTick(now) {
    bounceRaf = requestAnimationFrame(bounceTick);

    var any = false;

    // Шторка идёт на полной частоте кадров — иначе рывками.
    Object.keys(charts).forEach(function (id) {
      var ch = charts[id];
      if (!ch || ch.$reveal == null || ch.$reveal >= 1) return;
      any = true;
      var pr = Math.min(1, (now - ch.$revealT0) / REVEAL_MS);
      ch.$reveal = pr;
      ch.draw();
      if (pr >= 1) {
        ch.$reveal = 1;
        ch.draw();
        if (ch.$isLine) startBounce(ch);
      }
    });

    // Полная частота кадров: на 30 к/с плавный гребень заметно ступенчатит.
    // Пропуск кадра не должен выглядеть как «работы нет» — иначе цикл
    // гасился бы сразу после завершения шторки.
    var doBounce = now - bounceLast >= 15;
    if (doBounce) bounceLast = now;

    Object.keys(charts).forEach(function (id) {
      var ch = charts[id];
      if (!ch || !ch.$bounce || (ch.$reveal != null && ch.$reveal < 1)) return;
      any = true;
      if (!doBounce) return;

      var pts = ch.getDatasetMeta(0).data;
      var n = pts.length;
      if (!n) return;

      // после пересчёта раскладки (resize) опорные позиции берём заново
      if (ch.$needBase) {
        for (var b = 0; b < n; b++) pts[b].$baseY = pts[b].y;
        ch.$needBase = false;
      }

      /* Пока курсор на графике — гасим волну, чтобы значение читалось.
         Гасим не рывком, а плавно подтягивая множитель к нулю. */
      var hovered = ch.getActiveElements && ch.getActiveElements().length > 0;
      var target = hovered ? 0 : 1;
      if (ch.$damp == null) ch.$damp = 1;
      ch.$damp += (target - ch.$damp) * 0.10;
      if (ch.$damp < 0.002) ch.$damp = 0;

      /* Гребень шириной BOUNCE_W точек с колоколообразным профилем
         (приподнятый косинус): соседние точки поднимаются и опускаются
         согласованно, и по линии проходит плавная волна, а не рывок
         одной точки. Голова волны заходит и уходит за края графика,
         поэтому начало и конец прохода тоже сглажены. */
      var phase = (now % BOUNCE_PERIOD) / BOUNCE_PERIOD;
      var span = (n - 1) + 2 * BOUNCE_W;
      var head = -BOUNCE_W + (phase / BOUNCE_TRAVEL) * span;
      var running = phase <= BOUNCE_TRAVEL;

      var moved = false;
      for (var k = 0; k < n; k++) {
        if (pts[k].$baseY == null) pts[k].$baseY = pts[k].y;
        var t = (head - k) / BOUNCE_W;
        var amp = (running && t > -1 && t < 1)
          ? 0.5 * (1 + Math.cos(Math.PI * t)) : 0;
        var dy = amp * (ch.$isLine ? BOUNCE_AMP : BOUNCE_AMP * 0.8) * ch.$damp;
        if (dy > 0.05) moved = true;
        pts[k].y = pts[k].$baseY - dy;
      }

      if (moved || ch.$wasMoved) {
        ch.draw();
        ch.$wasMoved = moved;
      }
    });

    if (!any) stopBounce();
  }

  function destroy(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  function destroyAll() {
    hideTip();
    stopBounce();
    Object.keys(charts).forEach(destroy);
    document.querySelectorAll('.kpi-spark-wrap').forEach(function (w) { w.remove(); });
  }

  function load() {
    if (!isHud()) return;
    var token = ++inFlight;
    var qs = params();

    getJSON('/api/dynamics?' + qs).then(function (rows) {
      if (token !== inFlight || !isHud()) return;   // пришёл устаревший ответ
      var labels = rows.map(function (r) {
        var m = parseInt(String(r.period).slice(5, 7), 10);
        return MONTHS[m - 1] || String(r.period).slice(0, 7);
      });
      CARDS.filter(function (c) { return c.src === 'dyn'; }).forEach(function (cfg) {
        draw(cfg, labels, rows.map(function (r) { return r[cfg.field] || 0; }));
      });
    }).catch(function () {});

    getJSON('/api/pay-type-stats?' + qs).then(function (rows) {
      if (token !== inFlight || !isHud()) return;
      // по возрастанию: маска гасит левый край карточки, поэтому самый
      // крупный столбец должен оказаться справа, в полностью видимой зоне
      var top = rows.slice(0, 8).reverse();
      CARDS.filter(function (c) { return c.src === 'types'; }).forEach(function (cfg) {
        draw(cfg,
          top.map(function (r) { return r.pay_group; }),
          top.map(function (r) { return r[cfg.field] || 0; }));
      });
    }).catch(function () {});
  }

  /* ── Рейтинг видов помощи: в HUD показываем 8 строк вместо 4 ──
     app.js рисует top-4 (renderRating), поэтому после каждой его перерисовки
     переписываем блок сам: данные берём из его же _lastRatingRows. */
  var RATING_ROWS = 8;          // стартовое значение, дальше считается по месту
  var ratingObserver = null;
  var ratingResize = null;
  var ratingFit = 0;            // защита от повторных пересчётов в одном цикле

  /* Сколько строк помещается в карточку рейтинга.
     Высоту строки и шапки меряем по факту — она зависит от шрифта и масштаба. */
  function ratingCapacity(total) {
    var card = document.getElementById('kpi-card-top-mgp');
    var el = document.getElementById('kpi-top-mgp');
    if (!card || !el) return RATING_ROWS;

    var item = el.querySelector('.kpi-top-mgp-item');
    var hdr = el.querySelector('.kpi-top-mgp-hdr');
    var itemH = item ? item.getBoundingClientRect().height : 0;
    if (!itemH) return RATING_ROWS;              // ещё нечего мерить

    var cs = getComputedStyle(card);
    var avail = card.clientHeight
              - parseFloat(cs.paddingTop || 0)
              - parseFloat(cs.paddingBottom || 0);

    var label = card.querySelector(':scope > .label');
    if (label) {
      var ls = getComputedStyle(label);
      avail -= label.getBoundingClientRect().height + parseFloat(ls.marginBottom || 0);
    }
    avail -= parseFloat(getComputedStyle(el).marginTop || 0);
    avail -= hdr ? hdr.getBoundingClientRect().height : 0;
    avail -= 2;                                   // рамка списка

    var n = Math.floor(avail / itemH);
    return Math.max(3, Math.min(total, n));
  }

  function refitRating() {
    ratingFit = 0;
    renderRatingTop();
  }

  function ratingSource() {
    try {
      if (typeof _lastRatingRows !== 'undefined' && Array.isArray(_lastRatingRows)) {
        return _lastRatingRows;
      }
    } catch (e) {}
    return null;
  }

  function money(v) {
    return (typeof formatCompact === 'function' ? formatCompact(v || 0) : String(v || 0)) + ' ₸';
  }

  function renderRatingTop() {
    var el = document.getElementById('kpi-top-mgp');
    var rows = ratingSource();
    if (!el || !rows) return;
    var want = ratingCapacity(rows.length);
    var top = rows.slice(0, want);
    if (!top.length) return;

    var html = '<div class="kpi-top-mgp-hdr"><span>#</span><span>Вид помощи</span><span>Сумма</span></div>';
    top.forEach(function (r, i) {
      var name = esc(r.pay_group);
      html += '<div class="kpi-top-mgp-item">'
            +   '<span class="kpi-top-mgp-num">' + (i + 1) + '</span>'
            +   '<span class="kpi-top-mgp-name" title="' + name + '">' + name + '</span>'
            +   '<span class="kpi-top-mgp-val">' + money(r.total_sum) + '</span>'
            + '</div>';
    });
    if (el.innerHTML === html) return;

    // снимаем наблюдателя на время собственной записи, иначе она вызовет
    // повторный проход (коллбэк — микрозадача, простым флагом не обойтись)
    if (ratingObserver) ratingObserver.disconnect();
    el.innerHTML = html;
    if (ratingObserver) ratingObserver.observe(el, { childList: true, subtree: true });

    /* Первый расчёт делается по старой высоте строки, поэтому после записи
       перепроверяем — но не больше двух раз подряд, чтобы не зациклиться. */
    if (ratingFit < 2 && ratingCapacity(rows.length) !== want) {
      ratingFit++;
      renderRatingTop();
    } else {
      ratingFit = 0;
    }
  }

  function watchRating() {
    if (ratingObserver) return;
    var el = document.getElementById('kpi-top-mgp');
    if (!el) return;
    ratingObserver = new MutationObserver(function () {
      if (!isHud()) return;
      renderRatingTop();
    });
    ratingObserver.observe(el, { childList: true, subtree: true });

    var card = document.getElementById('kpi-card-top-mgp');
    if (card && window.ResizeObserver && !ratingResize) {
      var t = null;
      ratingResize = new ResizeObserver(function () {
        clearTimeout(t);
        t = setTimeout(refitRating, 120);
      });
      ratingResize.observe(card);
    }
    renderRatingTop();
  }

  function unwatchRating() {
    if (ratingObserver) { ratingObserver.disconnect(); ratingObserver = null; }
    if (ratingResize) { ratingResize.disconnect(); ratingResize = null; }
    // возвращаем штатные 4 строки из app.js
    try {
      var rows = ratingSource();
      if (typeof renderRating === 'function' && rows) renderRating(rows);
    } catch (e) {}
  }

  /* ── Плавный ресайз карты при заходе в регион ─────────────────────────────
     Панель карты сужается по transition за ~300мс, а app.js пересчитывает
     размер карты лишь парой setTimeout. Между ними Leaflet держит старый
     размер: подложка стоит на месте, пока контейнер едет, и затем прыгает
     разом (замер — до 111px за кадр). Следим за контейнером и пересчитываем
     размер на каждом кадре, пока он меняется. */
  var mapRO = null;

  function watchMapResize() {
    if (mapRO || !window.ResizeObserver) return;
    var el = document.getElementById('map');
    if (!el) return;
    var queued = false;
    mapRO = new ResizeObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (fsAnimating) return;   // во время анимации пересчёт только по её концу
        try {
          if (typeof map !== 'undefined' && map && map._loaded) {
            // pan оставляем включённым: центр карты держится на месте,
            // иначе картинку уводит вбок вслед за краем контейнера
            map.invalidateSize({ animate: false, debounceMoveend: true });
          }
        } catch (e) {}
      });
    });
    mapRO.observe(el);
  }

  function unwatchMapResize() {
    if (mapRO) { mapRO.disconnect(); mapRO = null; }
  }

  /* ── Полноэкранный режим панели вкладок: раскрытие и сворачивание ─────────
     app.js просто переключает класс .is-fullscreen — панель прыгает во весь
     экран и обратно. Делаем FLIP: запоминаем положение до переключения и
     проигрываем переход от него к новому. app.js при этом не трогаем:
     исходный прямоугольник снимаем на клике в фазе перехвата (инлайновый
     onclick сработает позже), а сам момент смены класса ловим наблюдателем. */
  var FS_MS = 380;
  var fsBound = false;
  var fsObserver = null;
  var fsFirst = null;
  var fsWas = false;
  var fsAnimating = false;

  function watchFullscreen() {
    var panel = document.querySelector('.map-panel');
    if (!panel) return;

    if (!fsBound) {
      fsBound = true;
      document.addEventListener('click', function (e) {
        if (!isHud() || !e.target || !e.target.closest) return;
        var btn = e.target.closest('.map-expand');
        if (!btn) return;
        var pn = btn.closest('.map-panel');
        fsFirst = pn ? pn.getBoundingClientRect() : null;
      }, true);
    }

    if (fsObserver) return;
    fsWas = panel.classList.contains('is-fullscreen');
    fsObserver = new MutationObserver(function () {
      var now = panel.classList.contains('is-fullscreen');
      if (now === fsWas) return;
      fsWas = now;
      flipPanel(panel, now);
    });
    fsObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  function unwatchFullscreen() {
    if (fsObserver) { fsObserver.disconnect(); fsObserver = null; }
  }

  function flipPanel(panel, opening) {
    var first = fsFirst;
    fsFirst = null;
    if (!isHud() || prefersStill() || !first) return;

    var last = panel.getBoundingClientRect();
    if (!last.width || !last.height) return;

    var dx = first.left - last.left;
    var dy = first.top - last.top;
    var sx = first.width / last.width;
    var sy = first.height / last.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) return;

    /* При сворачивании панель уже вернулась в поток и в первом кадре анимации
       ещё накрывает экран — без своего слоя её перекрыли бы шапка и карточки. */
    var restoreZ = panel.style.zIndex;
    if (!opening) panel.style.zIndex = '3000';
    fsAnimating = true;

    var anim = panel.animate([
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')' },
      { transform: 'none' }
    ], {
      duration: FS_MS,
      easing: opening ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'none'
    });

    panel.style.transformOrigin = 'top left';
    panel.style.willChange = 'transform';   // отдельный слой на время перехода
    anim.addEventListener('finish', function () {
      fsAnimating = false;
      panel.style.zIndex = restoreZ;
      panel.style.transformOrigin = '';
      panel.style.willChange = '';
      try {
        if (typeof map !== 'undefined' && map && map._loaded) map.invalidateSize({ animate: false });
      } catch (e) {}
    });
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 260);
  }

  /* Значения KPI перерисовывает app.js при смене региона/фильтров.
     Следим за их текстом — так графики обновляются без правок app.js. */
  function watch() {
    if (observer) return;
    var targets = ['kpi-recipients', 'kpi-sum', 'kpi-help-types']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
    if (!targets.length) return;
    observer = new MutationObserver(scheduleReload);
    targets.forEach(function (t) {
      observer.observe(t, { childList: true, characterData: true, subtree: true });
    });
  }

  function unwatch() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  /* Вызывается из applySkin() в index.html */
  window.hudSparklines = function (skin) {
    if (skin === 'hud') {
      watch();
      watchRating();
      watchMapResize();
      watchFullscreen();
      /* Грузим сразу только если данные уже на экране (скин переключили на
         работающем дашборде). При первом заходе KPI ещё пустой: app.js
         проверяет авторизацию асинхронно, окна входа в DOM пока нет, и
         запрос здесь ушёл бы в 401. Первую отрисовку поймает наблюдатель. */
      var v = document.getElementById('kpi-recipients');
      var t = v ? v.textContent.trim() : '';
      if (t && t !== '—') load();
    } else {
      unwatch();
      unwatchRating();
      unwatchMapResize();
      unwatchFullscreen();
      clearTimeout(reloadTimer);
      inFlight++;            // обесцениваем ответы, которые ещё в пути
      destroyAll();
    }
  };

  /* Подстраховка на случай, если applySkin() из index.html не отработал.
     Если загрузка уже шла (inFlight > 0), второй раз не запускаем. */
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      if (isHud() && !inFlight) window.hudSparklines('hud');
    }, 400);
  });
})();
