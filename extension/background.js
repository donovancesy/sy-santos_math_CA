// Clicking the toolbar icon opens the Sipra panel next to Spotify.
// - Chrome, Edge, Brave: opens in the browser's side panel.
// - Opera / Opera GX and others without a side panel: opens as a small
//   window docked to the right of the browser.
// The click also gives the extension permission to capture that tab's audio.

const SPOTIFY = "https://open.spotify.com/";
const hasSidePanel = Boolean(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);

function setup() {
  if (hasSidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

async function rememberSpotifyTab(tab) {
  if (tab && tab.url && tab.url.startsWith(SPOTIFY)) {
    await chrome.storage.session.set({ lastSpotifyTab: tab.id }).catch(() => {});
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await rememberSpotifyTab(await chrome.tabs.get(tabId)); } catch (e) {}
});

// Only fires when there is no side panel (Opera): open the panel window instead.
chrome.action.onClicked.addListener(async (tab) => {
  await rememberSpotifyTab(tab);
  // Ask for the tab's audio right now, while the click still counts.
  if (tab && tab.url && tab.url.startsWith(SPOTIFY)) {
    try {
      const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await chrome.storage.session.set({ pendingStream: { id, tabId: tab.id, at: Date.now() } });
    } catch (e) {
      await chrome.storage.session.set({ pendingStream: { id: null, error: (e && e.message) || String(e), tabId: tab.id, at: Date.now() } }).catch(() => {});
    }
  }
  const url = chrome.runtime.getURL(`sidepanel.html?tab=${tab && tab.id ? tab.id : ""}&mode=window`);
  const { panelWindowId } = await chrome.storage.session.get("panelWindowId").catch(() => ({}));
  if (panelWindowId) {
    try {
      const win = await chrome.windows.get(panelWindowId, { populate: true });
      if (win.tabs && win.tabs[0]) await chrome.tabs.update(win.tabs[0].id, { url });
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (e) {}
  }
  let left, top, height = 860;
  try {
    const current = await chrome.windows.getCurrent();
    left = Math.max(0, (current.left || 0) + (current.width || 1200) - 430);
    top = current.top || 0;
    height = Math.min(current.height || 860, 1000);
  } catch (e) {}
  const win = await chrome.windows.create({ url, type: "popup", width: 420, height, left, top, focused: true });
  await chrome.storage.session.set({ panelWindowId: win.id }).catch(() => {});
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { panelWindowId } = await chrome.storage.session.get("panelWindowId").catch(() => ({}));
  if (panelWindowId === windowId) chrome.storage.session.remove("panelWindowId").catch(() => {});
});
