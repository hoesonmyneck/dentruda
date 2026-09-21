/* ═══════════════════════════════════════════════════════════════════════════
   Оформление экрана входа (HUD-скин):
   • движущиеся декоративные графики на фоне — чистая графика, не данные;
   • орб вместо эмодзи в кружке логотипа.

   Окно входа создаёт app.js уже после проверки авторизации, поэтому ждём его
   появления наблюдателем — сам app.js не трогаем.
   ═══════════════════════════════════════════════════════════════════════════ */
import { mountOrb } from './orb.js';

(function () {
  'use strict';

  var FPS = 30;                       // фон декоративный, чаще перерисовывать незачем
  var SPEED = 0.18;                   // общий множитель темпа: фон должен
                                      // медленно перетекать, а не бежать
  var SERIES = [
    { base: 0.30, amp: 0.085, f1: 1.5, f2: 3.7, s1: 0.22, s2: -0.15, col: [34, 211, 238], a: 0.34 },
    { base: 0.52, amp: 0.110, f1: 1.1, f2: 2.6, s1: -0.17, s2: 0.26, col: [74, 155, 255], a: 0.30 },
    { base: 0.74, amp: 0.070, f1: 2.1, f2: 4.3, s1: 0.29, s2: -0.21, col: [46, 230, 197], a: 0.24 }
  ];

  var canvas, ctx, dpr, w, h;
  var raf = 0, running = false, last = 0, orb = null;

  function prefersStill() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function isHud() {
    return document.documentElement.getAttribute('data-skin') === 'hud';
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);   // фон — экономим на плотности
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Высота линии в точке x (0..1) — сумма двух синусов, плавная и дешёвая. */
  function yAt(s, x, t) {
    var tt = t * SPEED;
    return h * (s.base + s.amp * (
      Math.sin(x * s.f1 * Math.PI * 2 + tt * s.s1 * Math.PI * 2) +
      0.5 * Math.sin(x * s.f2 * Math.PI * 2 + tt * s.s2 * Math.PI * 2)
    ));
  }

  function grid() {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.055)';
    ctx.lineWidth = 1;
    var step = 68;
    ctx.beginPath();
    for (var y = step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    for (var x = step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();
  }

  function series(s, t) {
    var steps = Math.max(24, Math.round(w / 26));
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var x = i / steps;
      pts.push([x * w, yAt(s, x, t)]);
    }
    var rgb = s.col[0] + ',' + s.col[1] + ',' + s.col[2];

    // заливка под линией
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(' + rgb + ',' + (s.a * 0.30).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // сама линия
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var m = 1; m < pts.length; m++) ctx.lineTo(pts[m][0], pts[m][1]);
    ctx.strokeStyle = 'rgba(' + rgb + ',' + s.a.toFixed(3) + ')';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // редкие узлы на линии
    ctx.fillStyle = 'rgba(' + rgb + ',' + (s.a * 1.5).toFixed(3) + ')';
    for (var q = 0; q < pts.length; q += 3) {
      ctx.beginPath();
      ctx.arc(pts[q][0], pts[q][1], 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paint(t) {
    ctx.clearRect(0, 0, w, h);
    grid();
    for (var i = 0; i < SERIES.length; i++) series(SERIES[i], t);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS) return;
    last = now;
    paint(now / 1000);
  }

  function play() {
    if (running || !ctx || prefersStill()) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function mountBackground(overlay) {
    if (overlay.querySelector('.auth-bg')) return;
    canvas = document.createElement('canvas');
    canvas.className = 'auth-bg';
    canvas.setAttribute('aria-hidden', 'true');
    overlay.insertBefore(canvas, overlay.firstChild);
    ctx = canvas.getContext('2d');
    if (!ctx) return;
    resize();
    paint(performance.now() / 1000);
    if (prefersStill()) return;
    window.addEventListener('resize', function () { resize(); paint(performance.now() / 1000); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stop(); else play();
    });
    play();
  }

  function mountLogo(overlay) {
    var slot = overlay.querySelector('.auth-logo');
    if (!slot || slot.querySelector('canvas')) return;
    slot.textContent = '';                 // убираем эмодзи
    var c = document.createElement('canvas');
    c.className = 'auth-logo-orb';
    c.setAttribute('aria-hidden', 'true');
    slot.appendChild(c);
    orb = mountOrb(c, { state: 'searching', size: 64 });
    if (orb) orb.play();
  }

  function apply(overlay) {
    if (!isHud()) return;
    mountBackground(overlay);
    mountLogo(overlay);
  }

  function watch() {
    var now = document.querySelector('.auth-overlay');
    if (now) { apply(now); return; }
    var mo = new MutationObserver(function () {
      var ov = document.querySelector('.auth-overlay');
      if (ov) { mo.disconnect(); apply(ov); }
    });
    mo.observe(document.body, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }
})();
