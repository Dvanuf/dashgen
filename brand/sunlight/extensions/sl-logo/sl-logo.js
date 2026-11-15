define([], function () {
  return {
    initialProperties: {},
    definition: { type: "items", component: "accordion", items: { appearance: { uses: "settings" } } },
    support: { snapshot: false, export: false, exportData: false },
    paint: function ($element) {
      $element.html(
        '<div style="display:flex;align-items:center;justify-content:center;height:100%">' +
        '<img src="/extensions/sl-logo/sunlight-logo.svg" style="max-height:88%;max-width:88%;object-fit:contain">' +
        '</div>');
    }
  };
});
