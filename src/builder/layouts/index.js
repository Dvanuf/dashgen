// Каталог базовых макетов: зоны (фильтры → KPI → графики → детализация) и слоты.
// Макет — декларативное описание сетки 24×12: типы объектов, позиции, роли слотов.
// Наполнение слотов приходит от ИИ или пользователя (spec.design.fill).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// Загрузка всех макетов каталога + статические проверки целостности
function loadAll() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const layouts = files.map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  for (const l of layouts) validateLayoutShape(l);
  return layouts;
}

// Статическая проверка самого макета: базовые условия зон и непересечение слотов
function validateLayoutShape(layout) {
  const zoneRow = {};
  for (const z of layout.zones || []) zoneRow[z.id] = z.row;
  // Порядок зон: фильтры → KPI → графики → детализация (сверху вниз)
  const order = ['filters', 'kpi', 'charts', 'detail'];
  const rows = order.filter(id => zoneRow[id] !== undefined).map(id => zoneRow[id]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] <= rows[i - 1]) throw new Error(`макет «${layout.id}»: зоны нарушают порядок фильтры→KPI→графики→детализация`);
  }
  const overlaps = findOverlaps(layout.slots || []);
  if (overlaps.length) throw new Error(`макет «${layout.id}»: слоты пересекаются — ` + overlaps.join(', '));
}

// Пересечения прямоугольников объектов: возвращает список описаний пар
function findOverlaps(objects) {
  const bad = [];
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i], b = objects[j];
      const ax2 = a.col + (a.colspan || 1), ay2 = a.row + (a.rowspan || 1);
      const bx2 = b.col + (b.colspan || 1), by2 = b.row + (b.rowspan || 1);
      if (a.col < bx2 && b.col < ax2 && a.row < by2 && b.row < ay2) {
        bad.push(`${a.type}@${a.col},${a.row} ↔ ${b.type}@${b.col},${b.row}`);
      }
    }
  }
  return bad;
}

// Макет по id или null
function getLayout(id) {
  return loadAll().find(l => l.id === id) || null;
}

// Краткий список для UI и промпта ИИ: [{id, title, description, zones, slots}]
function listLayouts() {
  return loadAll().map(l => ({
    id: l.id, title: l.title, description: l.description,
    zones: l.zones, slots: l.slots
  }));
}

module.exports = { loadAll, getLayout, listLayouts, validateLayoutShape, findOverlaps };
