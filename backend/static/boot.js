/* ═══════════════════════════════════════════════════════════════════════════
   Экран загрузки (HUD-скин): орб, пока грузятся данные, затем плавное
   проявление интерфейса.

   Экран и скрытие интерфейса включаются CSS-классом `app-booting` на <html>,
   который ставится ещё в <head> — до первой отрисовки, иначе успевала бы
   мелькнуть пустая страница. Здесь только момент снятия.

   app.js не затрагивается: готовность данных определяем по тому, что в KPI
   появилось число вместо прочерка, а неавторизованного пользователя — по
   появлению окна входа.
   ═══════════════════════════════════════════════════════════════════════════ */
import { mountOrb } from './orb.js';

(function () {
  'use strict';

  var MIN_MS = 800;    // минимальная выдержка — чтобы экран не мигал
  var MAX_MS = 9000;   // страховка: снимаем экран, даже если данные не пришли
  var FADE_MS = 700;   // должно совпадать с transition в hud.css
  var QUICK_MS = 300;  // переход к окну входа — короче, .boot.is-quick

  var t0 = performance.now();
  var done = false;
  var orb = null;
  var watchers = [];

  function el(id) { return document.getElementById(id); }

  function isHud() {
    return document.documentElement.getAttribute('data-skin') === 'hud';
  }

  function cleanup() {
    watchers.forEach(function (w) { try { w.disconnect(); } catch (e) {} });
    watchers = [];
  }

  /**
   * @param {boolean} toLogin — путь «показываем окно входа»: без минимальной
   * выдержки и с укороченным затуханием. Раньше экран снимался тут мгновенно,
   * и форма входа возникала рывком — теперь идёт перекрёстное затухание:
   * экран загрузки гаснет, окно входа под ним проявляется своей анимацией.
   */
  function finish(toLogin) {
    if (done) return;
    done = true;
    cleanup();

    var wait = toLogin ? 0 : Math.max(0, MIN_MS - (performance.now() - t0));
    var fade = toLogin ? QUICK_MS : FADE_MS;

    setTimeout(function () {
      var boot = el('boot');
      /* Класс снимаем только когда показываем дашборд: он начинает проявляться
         одновременно с затуханием экрана загрузки. На пути к окну входа его
         оставляем — иначе сквозь полупрозрачный оверлей в момент перехода
         просвечивает пустой дашборд с прочерками вместо чисел. */
      if (!toLogin) document.documentElement.classList.remove('app-booting');
      if (!boot) return;
      if (toLogin) boot.classList.add('is-quick');
      boot.classList.add('is-done');
      setTimeout(function () {
        if (orb) orb.stop();
        boot.remove();
      }, fade);
    }, wait);
  }

  function watchText(id, ready) {
    var node = el(id);
    if (!node) return;
    if (ready(node.textContent)) { finish(false); return; }
    var mo = new MutationObserver(function () {
      if (ready(node.textContent)) finish(false);
    });
    mo.observe(node, { childList: true, characterData: true, subtree: true });
    watchers.push(mo);
  }

  function start() {
    // не HUD — экран загрузки не нужен вовсе
    if (!isHud()) {
      document.documentElement.classList.remove('app-booting');
      var b = el('boot');
      if (b) b.remove();
      return;
    }

    orb = mountOrb(el('boot-orb'), { state: 'searching', size: 64 });
    if (orb) orb.play();

    // окно входа — значит грузить нечего, убираем экран сразу
    var authMo = new MutationObserver(function () {
      if (document.querySelector('.auth-overlay')) finish(true);
    });
    authMo.observe(document.body, { childList: true });
    watchers.push(authMo);
    if (document.querySelector('.auth-overlay')) { finish(true); return; }

    // данные приехали, когда в KPI вместо прочерка появилось число
    watchText('kpi-recipients', function (s) { return s && s.trim() !== '—' && s.trim() !== ''; });

    setTimeout(function () { finish(false); }, MAX_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
