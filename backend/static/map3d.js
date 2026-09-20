import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let S = null;
let _lastPayload = null;

function fmtMoney(v) {
  if (!v) return '0 ₸';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace('.', ',') + ' млрд ₸';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' млн ₸';
  if (a >= 1e3) return Math.round(v / 1e3) + ' тыс ₸';
  return Math.round(v) + ' ₸';
}
function fmtInt(v) {
  return (v || 0).toLocaleString('ru-RU');
}
function stripRegionWord(s) {
  // имя уже переведено в app.js → убираем родовое слово на обоих языках
  return (s || '').replace(/\s*(область|обл\.?|облысы|ауданы|қаласы)\s*$/i, '').trim();
}

function isLight() { return document.documentElement.dataset.theme === 'light'; }

const PLANE_SPAN = 34;   // размер плоскости карты в мировых единицах (по большей стороне)

function ensureScene() {
  if (S) return S;
  const wrap = document.getElementById('map3d-wrap');
  const tip = document.getElementById('map3d-tip');
  if (!wrap) return null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
  const CAM_START = new THREE.Vector3(0, 26, 30);
  camera.position.copy(CAM_START);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  wrap.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x8fa3d6, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(14, 34, 18); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 120;
  key.shadow.camera.left = -30; key.shadow.camera.right = 30;
  key.shadow.camera.top = 30; key.shadow.camera.bottom = -30;
  scene.add(key);
  scene.add(new THREE.PointLight(0x4ecdc4, 0.35, 140).translateX(-24).translateY(14).translateZ(-18));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 12; controls.maxDistance = 90;
  controls.maxPolarAngle = Math.PI / 2.06;

  // Сброс вида: плавно вернуть камеру в стартовую позицию/ориентацию и убрать зум
  const homeTarget = new THREE.Vector3(0, 0, 0);
  const _view = {
    anim: false, t0: 0, dur: 0.7,
    fromPos: new THREE.Vector3(), fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3(),
  };
  function resetView() {
    // погасить инерцию вращения: с выключенным damping update() обнуляет накопленную скорость
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
    _view.fromPos.copy(camera.position);
    _view.fromTgt.copy(controls.target);
    _view.toTgt.copy(homeTarget);
    _view.t0 = clock.getElapsedTime();
    _view.anim = true;
    controls.enabled = false;   // блокируем ввод/инерцию на время анимации
  }

  const mapGroup = new THREE.Group();   // плитки регионов/районов
  const barGroup = new THREE.Group();   // столбцы
  scene.add(mapGroup); scene.add(barGroup);

  // hover по столбцам/плиткам
  const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2();
  let hoveredBar = null, hoveredPlateId = null;

  const setPlateEmis = (featId, val) => {
    if (featId == null) return;
    mapGroup.children.forEach(o => {
      if (o.userData?.isPlate && o.userData.featId === featId) o.material.emissiveIntensity = val;
    });
  };
  const setPtr = (e, r) => {
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
  };
  // регион под курсором: приоритет столбцу/крестику, иначе плитка
  const pickFeat = () => {
    const barHit = ray.intersectObjects(barGroup.children.filter(o => o.isMesh), false)[0];
    if (barHit) return { bar: barHit.object, featId: barHit.object.userData.featId };
    const plateHit = ray.intersectObjects(mapGroup.children.filter(o => o.userData?.isPlate), false)[0];
    return { bar: null, featId: plateHit ? plateHit.object.userData.featId : null };
  };

  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    setPtr(e, r);
    const { bar, featId } = pickFeat();
    const drillable = typeof _lastPayload?.onDrill === 'function';

    // подсветка столбца
    if (bar !== hoveredBar) {
      if (hoveredBar) hoveredBar.material.emissiveIntensity = hoveredBar.userData.baseEmis;
      hoveredBar = bar;
      if (hoveredBar) hoveredBar.material.emissiveIntensity = 0.75;
    }
    // подсветка плитки региона (только когда можно провалиться внутрь)
    const plateId = drillable ? featId : null;
    if (plateId !== hoveredPlateId) {
      setPlateEmis(hoveredPlateId, 0);
      hoveredPlateId = plateId;
      setPlateEmis(hoveredPlateId, 0.28);
    }
    renderer.domElement.style.cursor = (bar || (drillable && featId != null)) ? 'pointer' : 'grab';

    const u = bar ? bar.userData.d : (featId != null ? _lastPayload?.units?.[featId] : null);
    if (u && tip) {
      tip.style.display = 'block';
      tip.style.left = (e.clientX - r.left + 14) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
      const _t = window.t || (s => s);
      const metricLabel = _lastPayload?.metricLabel || _t('Принятые заявления');
      tip.innerHTML = `<b>${stripRegionWord(u.name)}</b><br>${metricLabel}: ${fmtMoney(u.value)}<br>` +
        `<span class="cube3d-tip-dim">${_t('Получателей')}: ${fmtInt(u.count)}` +
        `${drillable ? ' · ' + _t(_lastPayload?.level === 'region' ? 'нажмите, чтобы войти' : 'нажмите, чтобы выбрать') : ''}</span>`;
    } else if (tip) { tip.style.display = 'none'; }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    if (hoveredBar) { hoveredBar.material.emissiveIntensity = hoveredBar.userData.baseEmis; hoveredBar = null; }
    setPlateEmis(hoveredPlateId, 0); hoveredPlateId = null;
    if (tip) tip.style.display = 'none';
  });

  // клик по региону → вход внутрь (отличаем от вращения по смещению указателя)
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downXY = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
    downXY = null;
    if (moved > 6) return;                       // это было вращение
    if (typeof _lastPayload?.onDrill !== 'function') return;
    const r = renderer.domElement.getBoundingClientRect();
    setPtr(e, r);
    const { featId } = pickFeat();
    if (featId != null) _lastPayload.onDrill(featId);
  });

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    barGroup.children.forEach(m => {
      if (!m.isMesh || m.userData.t0 == null) return;
      const k = Math.max(0, Math.min(1, (t - m.userData.t0 - m.userData.delay) / 0.6));
      const e = 1 - Math.pow(1 - k, 3);
      // геометрия сдвинута так, что основание в локальном 0 → масштабируем только по Y,
      // position.y остаётся PLATE_H, столбец растёт от плитки карты вверх
      m.scale.y = Math.max(0.001, e);
      // подпись с суммой едет вместе с вершиной столбца
      if (m.userData.label) {
        m.userData.label.position.y = m.position.y + m.userData.h * m.scale.y + 0.7;
      }
    });
    if (_view.anim) {
      // плавный возврат камеры к стартовому виду (easeInOutCubic)
      const k = Math.min(1, (t - _view.t0) / _view.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(_view.fromPos, CAM_START, e);
      controls.target.lerpVectors(_view.fromTgt, _view.toTgt, e);
      camera.lookAt(controls.target);
      if (k >= 1) { _view.anim = false; controls.enabled = true; }
    } else {
      controls.update();
    }
    renderer.render(scene, camera);
  })();

  S = { scene, camera, controls, renderer, mapGroup, barGroup, clock, homeTarget, resetView };
  return S;
}

function clearGroup(g) {
  while (g.children.length) {
    const o = g.children[g.children.length - 1];
    g.remove(o);
    o.geometry?.dispose?.();
    if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.dispose(); }); }
  }
}

// Текстовая подпись (сумма) как спрайт — всегда повёрнута к камере, рисуется поверх столбца.
function makeTextSprite(text, light) {
  const fs = 44, padX = 10, padY = 6;
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = `700 ${fs}px 'Roboto', Arial, sans-serif`;
  ctx.font = font;
  const w = ctx.measureText(text).width;
  cv.width = Math.ceil(w + padX * 2);
  cv.height = fs + padY * 2;
  ctx.font = font;                                  // сброс после смены размера canvas
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = light ? 'rgba(255,255,255,0.95)' : 'rgba(8,11,22,0.9)';
  ctx.strokeText(text, cv.width / 2, cv.height / 2);   // контур для читаемости на любом фоне
  ctx.fillStyle = light ? '#12233f' : '#ffffff';
  ctx.fillText(text, cv.width / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const SC = 0.02;                                  // мировых единиц на пиксель
  sprite.scale.set(cv.width * SC, cv.height * SC, 1);
  sprite.renderOrder = 10;
  return sprite;
}

// Собираем проекцию lng/lat → плоскость XZ по границам всех полигонов текущего уровня.
function buildProjection(features) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const eachCoord = (coords) => {
    for (const c of coords) {
      if (typeof c[0] === 'number') {
        if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
        if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
      } else eachCoord(c);
    }
  };
  features.forEach(f => eachCoord(f.geometry.coordinates));
  const lng0 = (minLng + maxLng) / 2, lat0 = (minLat + maxLat) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180);
  const extLng = (maxLng - minLng) * kx, extLat = (maxLat - minLat);
  const scale = PLANE_SPAN / Math.max(extLng, extLat || 1);
  return {
    scale,
    px: (lng) => (lng - lng0) * kx * scale,       // shape-space x → world x
    py: (lat) => (lat - lat0) * scale,            // shape-space y (после rotateX(-90°) → world -z)
  };
}

// Внешние кольца полигона/мультиполигона (без дырок — для регионов/районов достаточно).
function outerRings(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(poly => poly[0]);
  return [];
}

function buildMap(s, payload) {
  const empty = document.getElementById('map3d-empty');
  clearGroup(s.mapGroup);
  clearGroup(s.barGroup);

  const features = (payload.polygons?.features) || [];
  if (!features.length) { if (empty) empty.style.display = 'flex'; return; }
  if (empty) empty.style.display = 'none';

  const proj = buildProjection(features);
  const light = isLight();
  const plateTop = light ? 0x99b8e6 : 0x2d3a63;
  const plateSide = light ? 0x7fa0d4 : 0x232d4e;
  const edgeColor = light ? 0x5a76ad : 0x4a5788;

  // Плитки регионов/районов (тонкий экструд)
  const PLATE_H = 0.35;
  const idKey = payload.idKey;
  features.forEach(f => {
    const featId = idKey != null ? Math.round(f.properties[idKey]) : null;
    const featName = f.properties.raion || f.properties.region || '';
    outerRings(f.geometry).forEach(ring => {
      if (!ring || ring.length < 3) return;
      const shape = new THREE.Shape();
      ring.forEach((c, i) => {
        const x = proj.px(c[0]), y = proj.py(c[1]);
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
      });
      const geo = new THREE.ExtrudeGeometry(shape, { depth: PLATE_H, bevelEnabled: false, steps: 1 });
      geo.rotateX(-Math.PI / 2);   // shape (x,y) → world (x, depth, -y)
      const mat = new THREE.MeshStandardMaterial({
        color: plateTop, emissive: plateTop, emissiveIntensity: 0,
        roughness: 0.92, metalness: 0.05, flatShading: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true; mesh.castShadow = false;
      mesh.userData = { isPlate: true, featId, name: featName };
      s.mapGroup.add(mesh);

      // контур плитки
      const pts = ring.map(c => new THREE.Vector3(proj.px(c[0]), PLATE_H + 0.01, -proj.py(c[1])));
      const lgeo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(lgeo, new THREE.LineBasicMaterial({ color: edgeColor }));
      s.mapGroup.add(line);
    });
  });

  // Столбцы из центров: высота ∝ сумме заявок
  const units = payload.units || {};
  const vals = Object.values(units).map(u => u.value || 0);
  const maxVal = Math.max(1, ...vals);
  const colLow = new THREE.Color(0x5b8af8);
  const colHigh = new THREE.Color(0xf875c3);
  const t0 = s.clock.getElapsedTime();
  // Ширина столбца/крестика не должна зависеть от гео-масштаба уровня: иначе в
  // маленьких по площади уровнях (города республиканского значения) она раздувается.
  // Ограничиваем её долей от среднего расстояния между центрами на плоскости.
  const unitCount = Object.values(units).length || 1;
  const wCap = Math.max(0.7, PLANE_SPAN / Math.sqrt(unitCount) * 0.085);
  const BAR_W = Math.min(Math.max(0.5, proj.scale * 0.14), wCap);
  let idx = 0;

  Object.values(units).forEach(u => {
    if (!u.centroid) return;
    const v = u.value || 0;
    const x = proj.px(u.centroid[0]);
    const z = -proj.py(u.centroid[1]);

    // регионы без заявок / с нулевой суммой — красный крестик вместо столбца
    if (v <= 0) { addCross(s, x, z, PLATE_H, BAR_W, u); return; }

    const norm = v / maxVal;
    const h = 0.4 + Math.sqrt(norm) * 20;   // sqrt — чтобы мелкие регионы не терялись

    const geo = new THREE.BoxGeometry(BAR_W, h, BAR_W);
    geo.translate(0, h / 2, 0);   // основание в 0
    const col = colLow.clone().lerp(colHigh, norm);
    const hex = col.getHex();
    const mat = new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: 0.16, metalness: 0.35, roughness: 0.35,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(x, PLATE_H, z);
    mesh.scale.y = 0.001;
    mesh.userData = { d: u, featId: u.id, baseEmis: 0.16, t0, delay: (idx % 40) * 0.02, h };
    s.barGroup.add(mesh);

    // подпись с суммой на вершине столбца (без значка ₸; едет вверх вместе с ростом)
    const label = makeTextSprite(fmtMoney(v).replace(/\s*₸/, ''), light);
    label.position.set(x, PLATE_H + h + 0.7, z);
    mesh.userData.label = label;
    s.barGroup.add(label);
    idx++;
  });

  // подгоняем target камеры к центру карты (уже 0,0 по построению)
  const ty = Math.min(8, maxVal ? 4 : 0);
  s.controls.target.set(0, ty, 0);
  s.homeTarget?.set(0, ty, 0);   // «домик» будет возвращать к этой цели
}

// Красный крестик (+) на плитке региона — маркер нулевой суммы заявок.
function addCross(s, x, z, baseY, w, u) {
  const RED = 0xff4d4d;
  const len = w * 3.4, th = w * 0.7, hgt = Math.max(0.18, w * 0.4);
  const y = baseY + hgt / 2 + 0.03;
  const mk = (gx, gz) => {
    const mat = new THREE.MeshStandardMaterial({
      color: RED, emissive: RED, emissiveIntensity: 0.4, roughness: 0.5, metalness: 0.15,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(gx, hgt, gz), mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.PI / 4;   // поворот на 45° → «+» становится «×» (крестик)
    mesh.userData = { d: u, featId: u.id, baseEmis: 0.4 };   // без t0 → цикл анимации его не масштабирует
    s.barGroup.add(mesh);
  };
  mk(len, th);   // горизонтальная перекладина
  mk(th, len);   // вертикальная перекладина
}

window.renderMap3D = function (payload) {
  const s = ensureScene();
  if (!s) return;
  _lastPayload = payload;
  buildMap(s, payload);
  requestAnimationFrame(() => { const w = document.getElementById('map3d-wrap'); if (w && s) s.renderer.setSize(w.clientWidth, w.clientHeight, false); });
};

// перерисовка при смене темы
window.refreshMap3DTheme = function () {
  if (S && _lastPayload) buildMap(S, _lastPayload);
};

// сброс вида (кнопка-домик): убрать зум и вернуть правильную ориентацию
window.resetMap3DView = function () { S?.resetView?.(); };
