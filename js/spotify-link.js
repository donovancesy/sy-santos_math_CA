/* Sipra: optional Spotify account link (for song info from ANY Spotify app,
   including the desktop app). Uses Spotify's Authorization Code + PKCE flow:
   no client secret, tokens stay in this browser. Read-only scopes.

   Requires your own free Spotify developer app (Client ID) with this page's
   address added as a Redirect URI. Spotify only allows this for Premium accounts
   in Development Mode, for up to 5 people you add in the dashboard. */
(() => {
  "use strict";
  const AUTH = "https://accounts.spotify.com/authorize";
  const TOKEN = "https://accounts.spotify.com/api/token";
  const PLAYER = "https://api.spotify.com/v1/me/player?additional_types=track,episode";
  const SCOPES = "user-read-playback-state user-read-currently-playing";
  const K = { id: "sipra-spotify-client", tok: "sipra-spotify-token", ver: "sipra-spotify-verifier", st: "sipra-spotify-state" };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const redirectUri = () => location.origin + location.pathname;
  const listeners = new Set();
  const state = { linked: false, track: null, error: "", polling: null, backoffUntil: 0 };

  function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) {} }); }
  function b64url(bytes) {
    let s = "";
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  async function startLogin(clientId) {
    clientId = String(clientId || "").trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) throw new Error("That doesn't look like a Spotify Client ID (32 letters and numbers).");
    if (!crypto.subtle) throw new Error("Open this page over https:// (or http://127.0.0.1) to link Spotify.");
    store.set(K.id, clientId);
    const verifier = randomString(64);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const st = randomString(16);
    store.set(K.ver, verifier);
    store.set(K.st, st);
    const url = new URL(AUTH);
    url.search = new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: redirectUri(),
      code_challenge_method: "S256", code_challenge: challenge, scope: SCOPES, state: st
    }).toString();
    location.assign(url.toString());
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `Spotify said ${res.status}`);
    const tok = { access: data.access_token, refresh: data.refresh_token || (getToken() || {}).refresh, expires: Date.now() + (data.expires_in || 3600) * 1000 - 30000 };
    store.set(K.tok, JSON.stringify(tok));
    return tok;
  }
  function getToken() { try { return JSON.parse(store.get(K.tok) || "null"); } catch (e) { return null; } }

  async function finishLoginIfReturning() {
    const params = new URLSearchParams(location.search);
    if (!params.has("code") && !params.has("error")) return;
    const clean = () => history.replaceState(null, "", location.pathname + location.hash);
    if (params.get("error")) { state.error = `Spotify login was cancelled (${params.get("error")}).`; clean(); return; }
    if (params.get("state") !== store.get(K.st)) { state.error = "Login check failed. Please try linking again."; clean(); return; }
    try {
      await tokenRequest({ grant_type: "authorization_code", code: params.get("code"), redirect_uri: redirectUri(), client_id: store.get(K.id), code_verifier: store.get(K.ver) });
      state.error = "";
    } catch (e) {
      state.error = `Couldn't finish linking: ${e.message}`;
    }
    store.del(K.ver); store.del(K.st);
    clean();
  }

  async function accessToken() {
    let tok = getToken();
    if (!tok) return null;
    if (Date.now() > tok.expires) {
      if (!tok.refresh) return null;
      tok = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh, client_id: store.get(K.id) });
    }
    return tok.access;
  }

  async function poll() {
    if (Date.now() < state.backoffUntil) return;
    let token;
    try { token = await accessToken(); } catch (e) { state.error = `Spotify sign-in expired: ${e.message}`; unlink(true); return; }
    if (!token) { state.linked = false; emit(); return; }
    state.linked = true;
    try {
      const res = await fetch(PLAYER, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 204) { state.track = null; state.error = ""; emit(); return; }
      if (res.status === 401) { const t = getToken(); if (t) { t.expires = 0; store.set(K.tok, JSON.stringify(t)); } return; }
      if (res.status === 429) { state.backoffUntil = Date.now() + (Number(res.headers.get("Retry-After")) || 10) * 1000; return; }
      if (res.status === 403) { state.error = "Spotify refused access. Add your Spotify account under User Management in your developer app, and make sure it has Premium."; emit(); return; }
      if (!res.ok) { state.error = `Spotify said ${res.status}.`; emit(); return; }
      const p = await res.json();
      const item = p.item;
      if (!item) { state.track = null; emit(); return; }
      const images = (item.album && item.album.images) || (item.images) || [];
      state.track = {
        id: item.id || item.uri || item.name,
        title: item.name,
        artist: item.artists ? item.artists.map((a) => a.name).join(", ") : (item.show && item.show.name) || "",
        album: item.album ? item.album.name : "",
        art: images.length ? images[0].url : "",
        duration: (item.duration_ms || 0) / 1000,
        position: (p.progress_ms || 0) / 1000,
        playing: Boolean(p.is_playing),
        device: p.device ? `${p.device.name}${p.device.type ? ` (${p.device.type.toLowerCase()})` : ""}` : "",
        at: Date.now()
      };
      state.error = "";
      emit();
    } catch (e) {
      state.error = "Can't reach Spotify from here.";
      emit();
    }
  }

  function startPolling() {
    if (state.polling) return;
    poll();
    state.polling = setInterval(poll, 3000);
  }
  function unlink(keepError) {
    store.del(K.tok);
    clearInterval(state.polling);
    state.polling = null;
    state.linked = false;
    state.track = null;
    if (!keepError) state.error = "";
    emit();
  }

  window.SipraSpotify = {
    state,
    redirectUri,
    clientId: () => store.get(K.id) || "",
    onChange(fn) { listeners.add(fn); fn(state); },
    link: startLogin,
    unlink: () => unlink(false),
    async init() {
      await finishLoginIfReturning();
      if (getToken()) { state.linked = true; startPolling(); }
      emit();
    }
  };
})();
