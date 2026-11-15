define([], function () {
  var ROWS = [
    ["Шаблон",   "SUNLIGHT Sales Template v1.0.0 · сборка app-as-code"],
    ["Данные",   "Демо-модель: 01.01.2024–30.09.2025 · ~471 тыс. строк продаж"],
    ["Тема",     "SUNLIGHT Light/Dark · импорт через QMC → Themes"],
    ["Листы",    "Обзор · Детализация продаж · О шаблоне"],
    ["Расширение", "sl-logo — логотип; Uni-пакет — опционально"],
    ["Поддержка", "app-template/README-APP.md и build/README-BUILD.md"]
  ];
  return {
    initialProperties: {},
    definition: { type: "items", component: "accordion", items: { appearance: { uses: "settings" } } },
    support: { snapshot: false, export: false, exportData: false },
    paint: function ($element) {
      var rows = ROWS.map(function (r) {
        return '<tr>' +
          '<td style="padding:14px 18px 14px 0;white-space:nowrap;vertical-align:top;' +
          'color:#C8102E;font-weight:600;font-size:15px;width:120px">' + r[0] + '</td>' +
          '<td style="padding:14px 0;color:#343434;font-size:15px;line-height:1.5;vertical-align:top">' + r[1] + '</td>' +
          '</tr>';
      }).join('');
      $element.html(
        '<div style="height:100%;display:flex;align-items:flex-start;padding:6px 4px 0 4px">' +
        '<table style="border-collapse:collapse;width:100%;max-width:1200px">' +
        rows +
        '</table></div>');
    }
  };
});
