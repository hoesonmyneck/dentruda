/* ═══════════════════════════════════════════════════════════════════════════
   Орбы (HUD-скин): логотип в шапке и орб на экране загрузки.

   Пакет thinking-orbs поставляет React-компонент <ThinkingOrb>, но проект —
   статические HTML/CSS/JS без сборщика и без React. Поэтому подключён его
   подмодуль `engine` (вендорен в /vendor/thinking-orbs/engine.js): он даёт
   пресеты и отрисовку в обычную 2D-канву, без React и вообще без зависимостей.
   Цикл анимации, работа с DPR и приостановка повторяют поведение обёртки.
   ═══════════════════════════════════════════════════════════════════════════ */
import { MODE_DRAWS, resolvePreset } from './vendor/thinking-orbs/engine.js';

function prefersStill() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (e) { return false; }
}

/**
 * Запускает орб на готовой канве.
 * @param {HTMLCanvasElement} canvas
 * @param {{state?: string, size?: 20|64, dark?: boolean}} o
 *        size — пакет настроен ровно на два размера, 64 и 20; промежуточных нет,
 *        экранный размер задаётся в CSS и просто ужимает битмап.
 * @returns {{play: function, stop: function}|null}
 */
export function mountOrb(canvas, o) {
  if (!canvas) return null;
  var opt = o || {};
  var SIZE = opt.size || 64;
  var STATE = opt.state || 'searching';
  var DARK = opt.dark !== false;

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(SIZE * dpr);
  var ctx = canvas.getContext('2d');
  if (!ctx) return null;

  var preset = resolvePreset(STATE, SIZE);
  var draw = MODE_DRAWS[preset.mode];
  var opts = preset.opts;
  var clock = preset.speed;

  var raf = 0, running = false, onScreen = true;

  function paint(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    draw(ctx, SIZE, t, DARK, opts);
  }

  function frame() {
    paint(performance.now() / 1000 * clock);
    if (running) raf = requestAnimationFrame(frame);
  }

  function play() {
    if (running || prefersStill()) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  if (prefersStill()) { paint(0.6); return { play: play, stop: stop }; }
  paint(performance.now() / 1000 * clock);

  // не крутим орб, когда он ушёл с экрана или вкладка неактивна
  if (window.IntersectionObserver) {
    var io = new IntersectionObserver(function (e) {
      onScreen = e[0].isIntersecting;
      if (onScreen && document.visibilityState !== 'hidden') play(); else stop();
    });
    io.observe(canvas);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') stop();
    else if (onScreen) play();
  });

  return { play: play, stop: stop };
}

/* ── Орб-логотип в шапке ── */
var header = null;

function setupHeader() {
  if (header) return true;
  header = mountOrb(document.getElementById('header-orb'), { state: 'searching', size: 64 });
  return !!header;
}

/* Вызывается из applySkin() в index.html */
window.hudOrb = function (skin) {
  if (skin === 'hud') { if (setupHeader()) header.play(); }
  else if (header) header.stop();
};

if (document.documentElement.getAttribute('data-skin') === 'hud') {
  window.hudOrb('hud');
}
