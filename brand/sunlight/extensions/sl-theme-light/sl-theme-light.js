define([], function () {
  return {
    initialProperties: {},
    definition: { type: "items", component: "accordion", items: { appearance: { uses: "settings" } } },
    support: { snapshot: false, export: false, exportData: false },
    paint: function ($element) {
      if (document.getElementById("sl-theme-light-css")) return;
      var link = document.createElement("link");
      link.id = "sl-theme-light-css";
      link.rel = "stylesheet";
      link.href = "/extensions/sl-theme-light/theme.css";
      document.head.appendChild(link);
      $element.html('<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#77716B;font-size:10px">SUNLIGHT theme ✓</div>');
    }
  };
});
