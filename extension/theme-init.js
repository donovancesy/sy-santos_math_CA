// Apply the saved theme before the panel paints, so it never flashes.
(function () {
  var t = null;
  try { t = localStorage.getItem("sipra-theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
