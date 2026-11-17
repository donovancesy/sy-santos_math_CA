// Sipra lessons page for the extension. Live values come from the side panel
// (saved to this extension's localStorage as "sipra-now"), so examples follow the song.
(() => {
  const readLive = () => {
    try { return JSON.parse(localStorage.getItem("sipra-now") || "null"); } catch (e) { return null; }
  };
  const topic = location.hash.replace("#", "") || "";
  const view = window.SipraLearn.mount(document.getElementById("learnRoot"), { getLive: readLive, topic });
  window.addEventListener("storage", (e) => { if (e.key === "sipra-now") view.refresh(); });
  window.addEventListener("hashchange", () => view.goTo(location.hash.replace("#", "")));
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("sipra-theme", next); } catch (e) {}
  });
})();
