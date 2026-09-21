thinking-orbs 0.3.1 — https://www.npmjs.com/package/thinking-orbs
Лицензия MIT (см. LICENSE), автор Jakub Antalik.

Здесь лежит только подмодуль `thinking-orbs/engine` (файл dist/engine.es.js
из пакета, скопирован без изменений). Пакет поставляет React-компонент
<ThinkingOrb>, но проект — статические HTML/CSS/JS без сборщика и без React,
поэтому используется его движок: чистая геометрия + отрисовка в 2D-канву,
без зависимостей.

Обновление: npm pack thinking-orbs@<версия>, распаковать и заменить engine.js.
Использование — /orb.js
