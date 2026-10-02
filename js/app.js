// Finance dashboard — Stage 1: sign-in, sheet connection, Settings, Accounts.
(function () {
  "use strict";

  const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
  const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
  const TYPES = ["current", "savings", "investment", "crypto", "long_term", "loan", "home", "card"];
  const TYPE_LABEL = {
    current: "Current", savings: "Savings", investment: "Investment", crypto: "Crypto",
    long_term: "Long-term", loan: "Loan", home: "Home", card: "Card",
  };
  const CURRENCIES = ["ILS", "USD", "EUR"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const JOINT = "Joint";
  // Fields that only apply to some account types.
  const ONLY_FOR = { update_month: ["home"], linked_account: ["card"], monthly_payment: ["loan"] };
  const BULK_COLUMNS = ["id", "nickname", "institution", "country", "currency", "owner", "type", "updater", "update_day", "linked_account"];

  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } },
  };

  const state = {
    gisReady: false,
    token: null,
    tokenExp: 0,
    email: null,
    sheetId: LS.get("fd.sheetId"),
    sheetTitle: "",
    settings: {},
    me: null,          // { key, name, email } or null
    accounts: [],
    signInMessage: "",
  };

  let tokenClient = null;
  const $screen = document.getElementById("screen");
  const $tabbar = document.getElementById("tabbar");
  const $sheet = document.getElementById("sheet");
  const $sheetBody = document.getElementById("sheet-body");
  const $toast = document.getElementById("toast");
  const $reauth = document.getElementById("reauth");
  const $offline = document.getElementById("offline");

  // ---------- helpers ----------

  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const norm = (v) => String(v == null ? "" : v).trim();
  const lower = (v) => norm(v).toLowerCase();

  function isActive(a) {
    const v = a.active;
    if (v === false) return false;
    return !/^(false|no|0|n)$/i.test(norm(v));
  }

  function slugify(text) {
    return norm(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  }
  const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  function people() {
    const s = state.settings;
    return [
      { key: "p1", name: norm(s.person1_name), email: lower(s.person1_email) },
      { key: "p2", name: norm(s.person2_name), email: lower(s.person2_email) },
    ];
  }
  const peopleConfigured = () => people().some((p) => p.email);
  const personNames = () => people().map((p) => p.name).filter(Boolean);

  function matchName(value, names) {
    const v = lower(value);
    return names.find((n) => n.toLowerCase() === v) || null;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    $toast.textContent = msg;
    $toast.classList.toggle("error", !!isError);
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, isError ? 6000 : 3000);
  }

  function openSheet(html) {
    $sheetBody.innerHTML = html;
    $sheet.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    $sheet.hidden = true;
    $sheetBody.innerHTML = "";
    document.body.style.overflow = "";
  }
  $sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label || "Working…";
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  function friendlyError(e) {
    if (!e) return "Something went wrong.";
    if (e.cancelled) return e.message;
    if (e.status === 401) return "Your Google sign-in expired. Please sign in again.";
    if (e.status === 403) return "Google refused access to the sheet.";
    if (e.status === 404) return "The sheet could not be found.";
    if (e instanceof TypeError || !navigator.onLine) return "No connection. Check your internet and try again — nothing was saved.";
    return e.message || "Something went wrong.";
  }

  // Runs an API action. If the Google sign-in has expired, asks to sign in again
  // over the current screen (so open forms keep what was typed) and retries once.
  async function guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!e || e.status !== 401) throw e;
      clearToken();
      await requestReauth();
      return fn();
    }
  }

  let reauthWaiters = [];
  function requestReauth() {
    return new Promise((resolve, reject) => {
      reauthWaiters.push({ resolve, reject });
      showReauth("");
    });
  }
  function finishReauth(error) {
    const waiters = reauthWaiters;
    reauthWaiters = [];
    hideReauth();
    waiters.forEach((w) => (error ? w.reject(error) : w.resolve()));
  }
  function showReauth(message) {
    $reauth.innerHTML = `
      <div class="card stack" role="dialog" aria-modal="true">
        <div class="label">Sign-in expired</div>
        <h2>Please sign in again</h2>
        <p class="muted">Google sign-in lasts about an hour. Nothing you typed has been lost — after signing in, your last action continues.</p>
        ${message ? `<p class="err-text">${esc(message)}</p>` : ""}
        <button class="btn primary block" id="reauth-go">Sign in again</button>
        <button class="btn ghost block" id="reauth-cancel">Not now</button>
      </div>`;
    $reauth.hidden = false;
    document.getElementById("reauth-go").addEventListener("click", signIn);
    document.getElementById("reauth-cancel").addEventListener("click", () => {
      const err = new Error("Not saved: you need to sign in again first.");
      err.status = 401;
      err.cancelled = true;
      finishReauth(err);
    });
  }
  function hideReauth() {
    $reauth.hidden = true;
    $reauth.innerHTML = "";
  }

  // ---------- auth ----------

  function loadToken() {
    try {
      const t = JSON.parse(LS.get("fd.token") || "null");
      if (t && t.exp > Date.now() + 60000) {
        state.token = t.token;
        state.tokenExp = t.exp;
        state.email = t.email || null;
      }
    } catch (_) { /* ignore */ }
  }
  function saveToken() {
    LS.set("fd.token", JSON.stringify({ token: state.token, exp: state.tokenExp, email: state.email }));
  }
  function clearToken() {
    state.token = null;
    state.tokenExp = 0;
    LS.del("fd.token");
  }

  Sheets.configure({ getToken: () => (state.token && state.tokenExp > Date.now() ? state.token : null) });

  function onGisLoaded() {
    const clientId = window.FD_CONFIG && window.FD_CONFIG.GOOGLE_CLIENT_ID;
    if (!clientId) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: `${SCOPE_SHEETS} ${SCOPE_EMAIL}`,
      callback: onToken,
      error_callback: (err) => {
        const msg = err && err.type === "popup_closed"
          ? "The sign-in window was closed. Tap the button to try again."
          : "Sign-in could not start. If you use a pop-up blocker, allow pop-ups for this site.";
        if (reauthWaiters.length) return showReauth(msg);
        state.signInMessage = msg;
        renderSignIn();
      },
    });
    state.gisReady = true;
    const btn = document.getElementById("signin-btn");
    if (btn) { btn.disabled = false; btn.textContent = "Sign in with Google"; }
  }

  function signIn() {
    if (!tokenClient) return;
    const hint = LS.get("fd.lastEmail");
    tokenClient.requestAccessToken(hint ? { login_hint: hint } : {});
  }

  async function onToken(resp) {
    const reauth = reauthWaiters.length > 0;
    const fail = (msg) => {
      if (reauth) return showReauth(msg);
      state.signInMessage = msg;
      renderSignIn();
    };
    if (resp.error) return fail("Google sign-in did not finish. Please try again.");
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE_SHEETS)) {
      return fail("The app needs permission to see and edit your Google Sheets. Sign in again and tick that box.");
    }
    const previousEmail = state.email;
    state.token = resp.access_token;
    state.tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
    if (!reauth) renderLoading("Signing in…");
    try {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!r.ok) throw new Error("Could not read your Google email.");
      const info = await r.json();
      state.email = lower(info.email);
      LS.set("fd.lastEmail", state.email);
      saveToken();
      state.signInMessage = "";
    } catch (e) {
      clearToken();
      return fail(friendlyError(e));
    }
    if (reauth && state.email === previousEmail) return finishReauth(null);
    if (reauth) {
      // A different Google account: start over so the right person's view loads.
      const err = new Error("Signed in as a different account.");
      err.cancelled = true;
      finishReauth(err);
      closeSheet();
    }
    await afterSignIn();
  }

  function signOut() {
    clearToken();
    state.email = null;
    state.me = null;
    state.settings = {};
    state.accounts = [];
    state.signInMessage = "You are signed out.";
    closeSheet();
    renderSignIn();
  }

  // ---------- sheet connection ----------

  async function afterSignIn() {
    if (!state.sheetId) return renderConnect();
    renderLoading("Opening your sheet…");
    try {
      Sheets.configure({ sheetId: state.sheetId });
      const res = await guarded(() => Sheets.ensureSchema());
      if (!res) return;
      state.sheetTitle = res.title;
      await loadData();
      route();
    } catch (e) {
      renderConnect(connectError(e));
    }
  }

  function connectError(e) {
    if (e && (e.status === 404 || e.status === 400)) {
      return `That sheet was not found. Check the link, and that it is shared with ${state.email}.`;
    }
    if (e && e.status === 403) {
      return `${state.email} has no access to that sheet. Ask the owner to share it with this email as Editor.`;
    }
    return friendlyError(e);
  }

  async function connect(link, btn) {
    const id = Sheets.parseSheetId(link);
    const $err = document.getElementById("connect-err");
    if (!id) {
      $err.textContent = "That does not look like a Google Sheets link. It should contain /spreadsheets/d/…";
      return;
    }
    $err.textContent = "";
    setBusy(btn, true, "Opening sheet…");
    try {
      Sheets.configure({ sheetId: id });
      const meta = await guarded(() => Sheets.getMeta());
      if (!meta) return;
      btn.textContent = "Checking edit access…";
      const canEdit = await Sheets.checkCanEdit(meta.properties.title);
      if (!canEdit) {
        $err.textContent = `You can view this sheet but not edit it. Ask the owner to give ${state.email} Editor access.`;
        setBusy(btn, false);
        return;
      }
      btn.textContent = "Creating missing tabs…";
      const res = await Sheets.ensureSchema();
      state.sheetId = id;
      state.sheetTitle = res.title;
      LS.set("fd.sheetId", id);
      await loadData();
      if (res.createdTabs.length) toast(`Created tabs: ${res.createdTabs.join(", ")}`);
      else toast("Sheet connected");
      route();
    } catch (e) {
      $err.textContent = connectError(e);
      setBusy(btn, false);
    }
  }

  async function loadData() {
    const [settings, accounts] = await Promise.all([Sheets.readSettings(), Sheets.readTab("Accounts")]);
    state.settings = settings;
    state.accounts = accounts.rows;
    state.me = people().find((p) => p.email && p.email === state.email) || null;
  }

  async function reloadAccounts() {
    const res = await Sheets.readTab("Accounts");
    state.accounts = res.rows;
  }

  // ---------- screens: pre-app ----------

  function hideTabs() {
    $tabbar.hidden = true;
    $screen.classList.add("no-tabs");
  }

  function brand() {
    return `<div class="brand"><div class="logo"></div><div><div class="label">Private · Two people</div><h2>Finance</h2></div></div>`;
  }

  function renderLoading(text) {
    hideTabs();
    $screen.innerHTML = `<div class="center-screen"><div class="row"><div class="spinner"></div><span class="muted">${esc(text)}</span></div></div>`;
  }

  function renderNotConfigured() {
    hideTabs();
    $screen.innerHTML = `
      <div class="center-screen">
        ${brand()}
        <div class="card notice stack">
          <div class="label">Setup not finished</div>
          <p>This app does not have its Google client ID yet. Once it is added to <span class="mono">js/config.js</span>, this screen becomes the sign-in screen.</p>
        </div>
      </div>`;
  }

  function renderSignIn() {
    hideTabs();
    const ready = state.gisReady;
    $screen.innerHTML = `
      <div class="center-screen">
        ${brand()}
        <div>
          <h1>Our money,<br><span class="accent">one glance.</span></h1>
          <p class="muted" style="margin-top:12px">Sign in with the Google account that has access to your shared sheet.</p>
        </div>
        <div class="stack">
          <button class="btn primary block" id="signin-btn" ${ready ? "" : "disabled"}>${ready ? "Sign in with Google" : "Loading…"}</button>
          ${state.signInMessage ? `<p class="muted" style="text-align:center">${esc(state.signInMessage)}</p>` : ""}
        </div>
      </div>`;
    document.getElementById("signin-btn").addEventListener("click", signIn);
  }

  function renderConnect(error) {
    hideTabs();
    $screen.innerHTML = `
      <div class="center-screen">
        ${brand()}
        <div class="stack">
          <h1>Connect your sheet</h1>
          <p class="muted">Paste the link to your shared Google Sheet. It is saved only on this device.</p>
        </div>
        <div class="card stack">
          <div class="field">
            <label class="label" for="sheet-link">Google Sheet link</label>
            <input id="sheet-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://docs.google.com/spreadsheets/d/…">
          </div>
          <p class="err-text" id="connect-err">${esc(error || "")}</p>
          <button class="btn primary block" id="connect-btn">Connect</button>
          <p class="muted" style="font-size:13px">Signed in as ${esc(state.email)}. Missing tabs will be created; existing rows are never changed.</p>
        </div>
        <button class="btn ghost block" id="connect-signout">Sign out</button>
      </div>`;
    const btn = document.getElementById("connect-btn");
    btn.addEventListener("click", () => connect(document.getElementById("sheet-link").value, btn));
    document.getElementById("connect-signout").addEventListener("click", signOut);
  }

  function renderNotRecognised() {
    hideTabs();
    $screen.innerHTML = `
      <div class="center-screen">
        ${brand()}
        <div class="card danger stack">
          <div class="label">Not recognised</div>
          <h2>This Google account is not one of the two people.</h2>
          <p class="muted">You are signed in as <span class="mono">${esc(state.email)}</span>. Only the two emails saved in Settings can see the data. Sign in with the right account, or ask the other person to add this email in Settings.</p>
        </div>
        <div class="stack">
          <button class="btn primary block" id="nr-signout">Sign in with another account</button>
          <button class="btn ghost block" id="nr-sheet">Use a different sheet</button>
        </div>
      </div>`;
    document.getElementById("nr-signout").addEventListener("click", signOut);
    document.getElementById("nr-sheet").addEventListener("click", forgetSheet);
  }

  function forgetSheet() {
    LS.del("fd.sheetId");
    state.sheetId = null;
    state.sheetTitle = "";
    state.settings = {};
    state.accounts = [];
    state.me = null;
    closeSheet();
    renderConnect();
  }

  // ---------- routing & tab bar ----------

  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
    accounts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M7 15h4"/></svg>',
    cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="16" height="12" rx="2.5"/><path d="M6 6V5a1 1 0 0 1 1-1h13a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1h-3"/><path d="M5 14h3"/></svg>',
    trends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  const TABS = [
    { id: "overview", label: "Overview", render: renderOverview },
    { id: "accounts", label: "Accounts", render: renderAccounts },
    { id: "cards", label: "Cards", render: renderCards },
    { id: "trends", label: "Trends", render: renderTrends },
    { id: "more", label: "More", render: renderMore },
  ];

  function currentTab() {
    const h = location.hash.replace("#", "");
    return TABS.some((t) => t.id === h) ? h : "overview";
  }

  function route() {
    if (!state.token) return renderSignIn();
    if (!state.sheetId) return renderConnect();
    // First run: nobody is set up yet, so the signed-in user configures the two people.
    if (!peopleConfigured()) return renderSetupPeople();
    if (!state.me) return renderNotRecognised();
    const tab = currentTab();
    $tabbar.hidden = false;
    $screen.classList.remove("no-tabs");
    $tabbar.innerHTML = `<div class="tabs">${TABS.map((t) => `
      <button data-tab="${t.id}" ${t.id === tab ? 'aria-current="page"' : ""}>${ICONS[t.id]}<span>${t.label}</span></button>`).join("")}</div>`;
    TABS.find((t) => t.id === tab).render();
    window.scrollTo(0, 0);
  }

  $tabbar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    if (currentTab() === b.dataset.tab) return;
    location.hash = b.dataset.tab;
  });
  window.addEventListener("hashchange", () => { if (state.me) route(); });

  // ---------- Placeholders (filled in later stages) ----------

  function renderPlaceholder(label, title, text) {
    $screen.innerHTML = `
      <div class="page-head"><div><div class="label">${esc(label)}</div><h1>${esc(title)}</h1></div></div>
      <div class="card empty stack"><div class="label">Coming soon</div><p class="muted">${esc(text)}</p></div>`;
  }
  function renderCards() {
    renderPlaceholder("Spending", "Cards", "Monthly card totals, this year's chart and the split by owner arrive in a later stage.");
  }
  function renderTrends() {
    renderPlaceholder("History", "Trends", "Charts of reachable money and the long-term total arrive in a later stage.");
  }

  function renderOverview() {
    const active = state.accounts.filter(isActive);
    const counts = {};
    active.forEach((a) => { const t = lower(a.type); counts[t] = (counts[t] || 0) + 1; });
    $screen.innerHTML = `
      <div class="page-head"><div><div class="label">Overview</div><h1>Hi, ${esc(state.me.name)}</h1></div></div>
      <div class="stack-lg">
        <div class="card hero stack">
          <div class="label">Reachable money</div>
          <div class="big-number">—</div>
          <p class="muted">Balances are added in the next stage. For now, set up your accounts.</p>
        </div>
        <div class="card stack">
          <div class="spread"><div class="label">Accounts</div><span class="mono">${active.length} active</span></div>
          ${active.length ? `<div class="row wrap">${TYPES.filter((t) => counts[t]).map((t) =>
            `<span class="chip">${TYPE_LABEL[t]} · ${counts[t]}</span>`).join("")}</div>`
            : `<p class="muted">No accounts yet.</p>`}
          <a class="btn block" href="#accounts">Go to Accounts</a>
        </div>
      </div>`;
  }

  // ---------- Settings ----------

  function renderSetupPeople() {
    hideTabs();
    $screen.innerHTML = `
      <div class="page-head"><div><div class="label">First run</div><h1>Who uses this?</h1></div></div>
      <div class="stack-lg">
        <p class="muted">Enter the two people's display names and the Google emails they sign in with. Only these two emails can see the data.</p>
        ${peopleFormHtml()}
      </div>`;
    bindPeopleForm(true);
  }

  function renderMore() {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(state.sheetId)}/edit`;
    $screen.innerHTML = `
      <div class="page-head"><div><div class="label">More</div><h1>Settings</h1></div></div>
      <div class="stack-lg">
        <div class="card stack">
          <div class="label">You</div>
          <div class="spread"><h3>${esc(state.me.name)}</h3><span class="chip accent">${state.me.key === "p1" ? "Person 1" : "Person 2"}</span></div>
          <p class="muted mono" style="font-size:13px; word-break:break-all">${esc(state.email)}</p>
        </div>
        ${peopleFormHtml()}
        <div class="card stack">
          <div class="label">Sheet</div>
          <h3>${esc(state.sheetTitle || "Connected sheet")}</h3>
          <a class="btn block" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Open in Google Sheets</a>
          <button class="btn ghost block" id="set-forget">Use a different sheet</button>
        </div>
        <button class="btn danger block" id="set-signout">Sign out</button>
      </div>`;
    bindPeopleForm(false);
    document.getElementById("set-signout").addEventListener("click", signOut);
    document.getElementById("set-forget").addEventListener("click", () => {
      if (confirm("Forget this sheet on this device? Nothing in the sheet is deleted.")) forgetSheet();
    });
  }

  function peopleFormHtml() {
    const p = people();
    if (!p[0].email && !p[1].email) p[0].email = state.email;
    const cur = CURRENCIES.includes(norm(state.settings.default_currency).toUpperCase())
      ? norm(state.settings.default_currency).toUpperCase() : "ILS";
    const person = (x, i) => `
      <div class="stack">
        <div class="label">Person ${i + 1}</div>
        <div class="field"><label class="label" for="pf-${x.key}-name">Display name</label>
          <input id="pf-${x.key}-name" value="${esc(x.name)}" autocomplete="off" placeholder="${i ? "Sam" : "Alex"}"></div>
        <div class="field"><label class="label" for="pf-${x.key}-email">Google email</label>
          <input id="pf-${x.key}-email" type="email" inputmode="email" autocapitalize="off" spellcheck="false" value="${esc(x.email)}" placeholder="name@example.com"></div>
      </div>`;
    return `
      <form class="card stack-lg" id="people-form" novalidate>
        ${p.map(person).join("")}
        <div class="stack">
          <div class="label">Default display currency</div>
          <div class="seg" id="pf-currency">${CURRENCIES.map((c) =>
            `<button type="button" data-cur="${c}" aria-pressed="${c === cur}">${c}</button>`).join("")}</div>
        </div>
        <p class="err-text" id="pf-err"></p>
        <button class="btn primary block" type="submit">Save</button>
      </form>`;
  }

  function bindPeopleForm(firstRun) {
    const form = document.getElementById("people-form");
    const seg = document.getElementById("pf-currency");
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cur]");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const $err = document.getElementById("pf-err");
      const val = (id) => norm(document.getElementById(id).value);
      const n1 = val("pf-p1-name"), n2 = val("pf-p2-name");
      const e1 = val("pf-p1-email").toLowerCase(), e2 = val("pf-p2-email").toLowerCase();
      const cur = seg.querySelector('[aria-pressed="true"]').dataset.cur;
      const emailOk = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
      let err = "";
      if (!n1 || !n2) err = "Both people need a display name.";
      else if (n1.toLowerCase() === n2.toLowerCase()) err = "The two names must be different.";
      else if ([n1, n2].some((n) => n.toLowerCase() === JOINT.toLowerCase())) err = `"${JOINT}" is reserved for shared accounts.`;
      else if (!emailOk(e1) || !emailOk(e2)) err = "Both people need a valid Google email.";
      else if (e1 === e2) err = "The two emails must be different.";
      else if (state.email !== e1 && state.email !== e2) err = `Your own email (${state.email}) must be one of the two, or you would lock yourself out.`;
      $err.textContent = err;
      if (err) return;

      const btn = form.querySelector('[type="submit"]');
      setBusy(btn, true, "Saving…");
      try {
        const old = people();
        const renames = {};
        if (old[0].name && old[0].name !== n1) renames[old[0].name] = n1;
        if (old[1].name && old[1].name !== n2) renames[old[1].name] = n2;
        const done = await guarded(async () => {
          await Sheets.writeSettings({
            person1_name: n1, person1_email: e1, person2_name: n2, person2_email: e2, default_currency: cur,
          });
          const renamed = await applyRenames(renames);
          return { renamed };
        });
        if (!done) return;
        await loadData();
        toast(done.renamed ? `Saved. Updated ${done.renamed} account${done.renamed > 1 ? "s" : ""} to the new name.` : "Saved");
        if (firstRun) location.hash = "accounts";
        route();
      } catch (ex) {
        $err.textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });
  }

  // Owner and updater store names, so a rename is carried into Accounts.
  async function applyRenames(renames) {
    if (!Object.keys(renames).length) return 0;
    const { rows } = await Sheets.readTab("Accounts");
    const updates = [];
    rows.forEach((a) => {
      const changes = {};
      if (renames[norm(a.owner)]) changes.owner = renames[norm(a.owner)];
      if (renames[norm(a.updater)]) changes.updater = renames[norm(a.updater)];
      if (Object.keys(changes).length) updates.push({ key: a.id, changes });
    });
    await Sheets.updateRows("Accounts", "id", updates);
    return updates.length;
  }

  // ---------- Accounts ----------

  function acctCard(a) {
    const type = lower(a.type);
    const bits = [TYPE_LABEL[type] || type, norm(a.currency), norm(a.owner), norm(a.country)].filter(Boolean);
    return `
      <button class="acct ${isActive(a) ? "" : "inactive"}" data-acct="${esc(a.id)}">
        <div class="dot">${esc(norm(a.currency).toUpperCase() || "—")}</div>
        <div class="body">
          <div class="name">${esc(a.nickname || a.id)}</div>
          <div class="meta">${bits.map(esc).join(" · ")}</div>
        </div>
        <span class="chev">›</span>
      </button>`;
  }

  function renderAccounts() {
    const active = state.accounts.filter(isActive);
    const inactive = state.accounts.filter((a) => !isActive(a));
    const groups = {};
    active.forEach((a) => {
      const k = norm(a.institution) || "No institution";
      (groups[k] = groups[k] || []).push(a);
    });
    const names = Object.keys(groups).sort((x, y) => x.localeCompare(y));
    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">${active.length} active</div><h1>Accounts</h1></div>
      </div>
      <div class="row" style="margin-bottom:8px">
        <button class="btn primary" id="acct-add" style="flex:1">+ Add</button>
        <button class="btn" id="acct-bulk" style="flex:1">Bulk add</button>
      </div>
      ${!active.length ? `<div class="card empty stack"><p class="muted">No accounts yet. Add one, or paste many at once with Bulk add.</p></div>` : ""}
      ${names.map((n) => `
        <div class="group-title"><span class="label">${esc(n)}</span><span class="label">${groups[n].length}</span></div>
        <div class="stack">${groups[n].sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname))).map(acctCard).join("")}</div>`).join("")}
      ${inactive.length ? `
        <details style="margin-top:28px">
          <summary class="group-title"><span class="label">Inactive (${inactive.length}) ▾</span></summary>
          <div class="stack">${inactive.map(acctCard).join("")}</div>
        </details>` : ""}`;
    document.getElementById("acct-add").addEventListener("click", () => openAccountForm(null));
    document.getElementById("acct-bulk").addEventListener("click", openBulk);
    $screen.querySelectorAll("[data-acct]").forEach((b) => b.addEventListener("click", () => {
      const a = state.accounts.find((x) => String(x.id) === b.dataset.acct);
      if (a) openAccountForm(a);
    }));
  }

  function options(list, selected, placeholder) {
    return (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
      list.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(l)}</option>`;
      }).join("");
  }

  function uniqueValues(field) {
    return [...new Set(state.accounts.map((a) => norm(a[field])).filter(Boolean))].sort();
  }

  function openAccountForm(acct) {
    const isNew = !acct;
    const a = acct || { type: "current", currency: "ILS", owner: state.me.name, updater: state.me.name, active: true };
    const type = lower(a.type) || "current";
    const names = personNames();
    const linkable = state.accounts.filter((x) => isActive(x) && lower(x.type) !== "card" && x.id !== a.id);
    const cur = norm(a.currency).toUpperCase() || "ILS";
    const showIf = (field) => `data-only="${ONLY_FOR[field].join(" ")}" ${ONLY_FOR[field].includes(type) ? "" : "hidden"}`;

    openSheet(`
      <form id="acct-form" class="stack-lg" novalidate>
        <div class="spread">
          <div><div class="label">${isNew ? "New account" : "Edit account"}</div><h2>${isNew ? "Add account" : esc(a.nickname || a.id)}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </div>
        <div class="field"><label class="label" for="af-type">Type</label>
          <select id="af-type">${options(TYPES.map((t) => [t, TYPE_LABEL[t]]), type)}</select></div>
        <div class="field"><label class="label" for="af-nickname">Nickname</label>
          <input id="af-nickname" value="${esc(a.nickname)}" autocomplete="off" placeholder="Bank A Current"></div>
        <div class="field"><label class="label" for="af-id">ID</label>
          <input id="af-id" value="${esc(a.id)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bank-a-current" ${isNew ? "" : "readonly"}>
          <span class="hint">${isNew ? "Short unique code: lowercase letters, numbers and dashes. Cannot be changed later." : "IDs cannot be changed."}</span></div>
        <div class="field"><label class="label" for="af-institution">Institution</label>
          <input id="af-institution" list="dl-inst" value="${esc(a.institution)}" autocomplete="off" placeholder="Bank A">
          <datalist id="dl-inst">${uniqueValues("institution").map((v) => `<option value="${esc(v)}">`).join("")}</datalist></div>
        <div class="field"><label class="label" for="af-country">Country</label>
          <input id="af-country" list="dl-country" value="${esc(a.country)}" autocomplete="off" placeholder="Country A">
          <datalist id="dl-country">${uniqueValues("country").map((v) => `<option value="${esc(v)}">`).join("")}</datalist></div>
        <div class="field"><span class="label">Currency</span>
          <div class="seg" id="af-currency">${CURRENCIES.map((c) =>
            `<button type="button" data-cur="${c}" aria-pressed="${c === cur}">${c}</button>`).join("")}</div></div>
        <div class="field-row">
          <div class="field"><label class="label" for="af-owner">Owner</label>
            <select id="af-owner">${options([...names, JOINT], matchName(a.owner, [...names, JOINT]) || "", "Choose…")}</select></div>
          <div class="field"><label class="label" for="af-updater">Updated by</label>
            <select id="af-updater">${options(names, matchName(a.updater, names) || "", "Choose…")}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="label" for="af-day">Due day</label>
            <input id="af-day" type="number" inputmode="numeric" min="1" max="31" value="${esc(a.update_day)}" placeholder="1–31"></div>
          <div class="field" ${showIf("update_month")}><label class="label" for="af-month">Due month</label>
            <select id="af-month">${options(MONTHS.map((m, i) => [i + 1, m]), a.update_month, "Choose…")}</select></div>
        </div>
        <div class="field" ${showIf("linked_account")}><label class="label" for="af-linked">Paid from</label>
          <select id="af-linked">${options(linkable.map((x) => [x.id, `${x.nickname || x.id} (${x.id})`]), a.linked_account, "Not set")}</select>
          <span class="hint">The account that pays this card. For display only.</span></div>
        <div class="field" ${showIf("monthly_payment")}><label class="label" for="af-payment">Monthly payment</label>
          <input id="af-payment" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.monthly_payment)}" placeholder="0"></div>
        <div class="field"><label class="label" for="af-notes">Notes</label>
          <input id="af-notes" value="${esc(a.notes)}" autocomplete="off" placeholder="Optional"></div>
        <p class="err-text" id="af-err"></p>
        <button class="btn primary block" type="submit">${isNew ? "Add account" : "Save changes"}</button>
        ${isNew ? "" : `<button class="btn ${isActive(a) ? "danger" : ""} block" type="button" id="af-toggle">${isActive(a) ? "Deactivate account" : "Reactivate account"}</button>
          <p class="muted" style="font-size:13px; text-align:center">${isActive(a) ? "Deactivated accounts keep their history but are no longer expected each month." : "This account is inactive."}</p>`}
      </form>`);

    const form = document.getElementById("acct-form");
    const $type = document.getElementById("af-type");
    const $nick = document.getElementById("af-nickname");
    const $id = document.getElementById("af-id");
    const seg = document.getElementById("af-currency");
    let idTouched = !isNew;

    $type.addEventListener("change", () => {
      form.querySelectorAll("[data-only]").forEach((el) => {
        el.hidden = !el.dataset.only.split(" ").includes($type.value);
      });
    });
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cur]");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    if (isNew) {
      $id.addEventListener("input", () => { idTouched = true; });
      $nick.addEventListener("input", () => { if (!idTouched) $id.value = suggestId($nick.value); });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const $err = document.getElementById("af-err");
      const v = (id) => norm(document.getElementById(id).value);
      const t = $type.value;
      const obj = {
        id: isNew ? v("af-id").toLowerCase() : a.id,
        nickname: v("af-nickname"),
        institution: v("af-institution"),
        country: v("af-country"),
        currency: seg.querySelector('[aria-pressed="true"]').dataset.cur,
        owner: v("af-owner"),
        type: t,
        updater: v("af-updater"),
        update_day: v("af-day") === "" ? "" : Number(v("af-day")),
        update_month: ONLY_FOR.update_month.includes(t) && v("af-month") ? Number(v("af-month")) : "",
        linked_account: ONLY_FOR.linked_account.includes(t) ? v("af-linked") : "",
        monthly_payment: ONLY_FOR.monthly_payment.includes(t) && v("af-payment") !== "" ? Number(v("af-payment")) : "",
        notes: v("af-notes"),
      };
      if (isNew) obj.active = true;

      let err = "";
      if (!obj.nickname) err = "Give the account a nickname.";
      else if (!ID_RE.test(obj.id)) err = "ID must be lowercase letters, numbers, dashes or underscores (max 32).";
      else if (isNew && state.accounts.some((x) => lower(x.id) === obj.id)) err = `The ID "${obj.id}" is already used.`;
      else if (!obj.institution) err = "Enter the institution.";
      else if (!obj.owner) err = "Choose the owner.";
      else if (!obj.updater) err = "Choose who updates this account.";
      else if (!Number.isInteger(obj.update_day) || obj.update_day < 1 || obj.update_day > 31) err = "Due day must be a whole number from 1 to 31.";
      else if (t === "home" && !obj.update_month) err = "Choose the month a home value is due.";
      else if (t === "loan" && obj.monthly_payment !== "" && !(obj.monthly_payment >= 0)) err = "Monthly payment must be a positive number.";
      $err.textContent = err;
      if (err) return;

      const btn = form.querySelector('[type="submit"]');
      setBusy(btn, true, "Saving…");
      try {
        const ok = await guarded(async () => {
          if (isNew) {
            await reloadAccounts();
            if (state.accounts.some((x) => lower(x.id) === obj.id)) {
              throw new Error(`The ID "${obj.id}" was just taken. Choose another.`);
            }
            await Sheets.appendRows("Accounts", [obj]);
          } else {
            await Sheets.updateRow("Accounts", "id", a.id, obj);
          }
          await reloadAccounts();
          return true;
        });
        if (!ok) return;
        closeSheet();
        toast(isNew ? "Account added" : "Changes saved");
        route();
      } catch (ex) {
        $err.textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });

    const toggle = document.getElementById("af-toggle");
    if (toggle) {
      toggle.addEventListener("click", async () => {
        const nowActive = isActive(a);
        if (nowActive && !confirm(`Deactivate "${a.nickname || a.id}"? Its history stays in the sheet.`)) return;
        setBusy(toggle, true, "Saving…");
        try {
          const ok = await guarded(async () => {
            await Sheets.updateRow("Accounts", "id", a.id, { active: !nowActive });
            await reloadAccounts();
            return true;
          });
          if (!ok) return;
          closeSheet();
          toast(nowActive ? "Account deactivated" : "Account reactivated");
          route();
        } catch (ex) {
          document.getElementById("af-err").textContent = friendlyError(ex);
          setBusy(toggle, false);
        }
      });
    }
  }

  function suggestId(nickname) {
    const base = slugify(nickname) || "acct";
    const taken = new Set(state.accounts.map((a) => lower(a.id)));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // ---------- Bulk add ----------

  const BULK_EXAMPLE = [
    "bank-a-cur | Bank A Current | Bank A | Country A | ILS | Joint | current | Alex | 5 |",
    "bank-b-sav | Bank B Savings | Bank B | Country B | USD | Sam | savings | Sam | 10 |",
    "card-x | Card X | Bank A | Country A | ILS | Alex | card | Alex | 12 | bank-a-cur",
  ].join("\n");

  function parseBulk(text) {
    const names = personNames();
    const owners = [...names, JOINT];
    const existing = new Set(state.accounts.map((a) => lower(a.id)));
    const seen = new Set();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pasteIds = new Set(lines.map((l) => lower(l.split("|")[0])));
    const linkTargets = new Set([...state.accounts.filter((a) => lower(a.type) !== "card").map((a) => lower(a.id)), ...pasteIds]);
    const rows = [];

    lines.forEach((line, i) => {
      const cells = line.split("|").map((c) => c.trim());
      if (i === 0 && lower(cells[0]) === "id" && lower(cells[1]) === "nickname") return; // header line
      while (cells.length > BULK_COLUMNS.length && cells[cells.length - 1] === "") cells.pop();
      const problems = []; // { col, msg }
      const warnings = [];
      if (cells.length < BULK_COLUMNS.length - 1 || cells.length > BULK_COLUMNS.length) {
        problems.push({ col: null, msg: `Expected ${BULK_COLUMNS.length} columns separated by |, found ${cells.length}.` });
      }
      const c = {};
      BULK_COLUMNS.forEach((k, j) => { c[k] = cells[j] || ""; });

      const id = c.id.toLowerCase();
      if (!id) problems.push({ col: "id", msg: "Missing id." });
      else if (!ID_RE.test(id)) problems.push({ col: "id", msg: "Id may use only lowercase letters, numbers, - and _." });
      else if (existing.has(id)) problems.push({ col: "id", msg: `Duplicate id: "${id}" already exists.` });
      else if (seen.has(id)) problems.push({ col: "id", msg: `Duplicate id: "${id}" appears twice in this paste.` });
      if (id) seen.add(id);

      if (!c.nickname) problems.push({ col: "nickname", msg: "Missing nickname." });
      if (!c.institution) problems.push({ col: "institution", msg: "Missing institution." });

      const currency = c.currency.toUpperCase();
      if (!CURRENCIES.includes(currency)) problems.push({ col: "currency", msg: `Unknown currency "${c.currency}". Use ILS, USD or EUR.` });

      const owner = matchName(c.owner, owners);
      if (!owner) problems.push({ col: "owner", msg: `Unknown owner "${c.owner}". Use ${owners.join(", ")}.` });

      const type = lower(c.type).replace(/[\s-]+/g, "_");
      if (!TYPES.includes(type)) problems.push({ col: "type", msg: `Unknown type "${c.type}".` });

      const updater = matchName(c.updater, names);
      if (!updater) problems.push({ col: "updater", msg: `Unknown updater "${c.updater}". Use ${names.join(" or ")}.` });

      const day = Number(c.update_day);
      if (!/^\d+$/.test(c.update_day) || day < 1 || day > 31) problems.push({ col: "update_day", msg: "Due day must be 1–31." });

      const linked = lower(c.linked_account);
      if (linked) {
        if (type !== "card") problems.push({ col: "linked_account", msg: "Only cards have a linked account." });
        else if (!linkTargets.has(linked)) problems.push({ col: "linked_account", msg: `Unknown account "${c.linked_account}".` });
      }
      if (type === "home") warnings.push("Home accounts also need a due month — set it in the form after adding.");
      if (type === "loan") warnings.push("You can add the monthly payment in the form after adding.");

      rows.push({
        line, cells: c, problems, warnings,
        obj: {
          id, nickname: c.nickname, institution: c.institution, country: c.country, currency,
          owner: owner || "", type, updater: updater || "", update_day: day,
          update_month: "", linked_account: linked, monthly_payment: "", active: true, notes: "",
        },
      });
    });
    return rows;
  }

  function openBulk(prefill) {
    openSheet(`
      <div class="stack-lg">
        <div class="spread">
          <div><div class="label">Accounts</div><h2>Bulk add</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </div>
        <p class="muted">One account per line, columns separated by <span class="mono">|</span>:</p>
        <div class="code">${BULK_COLUMNS.join(" | ")}</div>
        <p class="muted" style="font-size:14px">Owner is ${esc([...personNames(), JOINT].join(", "))}. Type is one of ${TYPES.join(", ")}. The last column is only for cards and may be left empty.</p>
        <textarea id="bulk-text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(BULK_EXAMPLE)}">${esc(typeof prefill === "string" ? prefill : "")}</textarea>
        <button class="btn primary block" id="bulk-check">Check</button>
      </div>`);
    document.getElementById("bulk-check").addEventListener("click", () => {
      const text = document.getElementById("bulk-text").value;
      if (!text.trim()) { toast("Paste some lines first", true); return; }
      showBulkPreview(text);
    });
  }

  function showBulkPreview(text) {
    const rows = parseBulk(text);
    const good = rows.filter((r) => !r.problems.length);
    const bad = rows.length - good.length;
    const cell = (r, k) => {
      const v = r.cells[k];
      const isBad = r.problems.some((p) => p.col === k);
      return `<span class="${isBad ? "bad-cell" : ""}">${esc(v || (isBad ? "(empty)" : "—"))}</span>`;
    };
    openSheet(`
      <div class="stack-lg">
        <div class="spread">
          <div><div class="label">Preview</div><h2>${good.length} ready${bad ? `, <span class="neg">${bad} with problems</span>` : ""}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </div>
        ${bad ? `<p class="muted">Rows with problems are shown in red and will be skipped. Go back to fix them, or add only the ready rows.</p>` : `<p class="muted">Nothing has been written yet. Review and approve.</p>`}
        <div class="stack">
          ${rows.map((r) => `
            <div class="preview-row ${r.problems.length ? "bad" : ""}">
              <div class="spread"><strong>${cell(r, "nickname")}</strong><span class="mono" style="font-size:12px">${cell(r, "id")}</span></div>
              <div class="mono" style="font-size:12px; margin-top:4px; color:var(--muted)">
                ${cell(r, "institution")} · ${cell(r, "country")} · ${cell(r, "currency")} · ${cell(r, "type")}<br>
                owner ${cell(r, "owner")} · by ${cell(r, "updater")} · day ${cell(r, "update_day")}${r.cells.linked_account || r.problems.some((p) => p.col === "linked_account") ? ` · paid from ${cell(r, "linked_account")}` : ""}
              </div>
              ${r.problems.length || r.warnings.length ? `<div class="problems">
                ${r.problems.map((p) => `<span class="err-text">✕ ${esc(p.msg)}</span>`).join("")}
                ${r.warnings.map((w) => `<span class="muted" style="font-size:13px">• ${esc(w)}</span>`).join("")}
              </div>` : ""}
            </div>`).join("")}
        </div>
        <p class="err-text" id="bulk-err"></p>
        <button class="btn primary block" id="bulk-approve" ${good.length ? "" : "disabled"}>${good.length ? `Approve and add ${good.length} account${good.length > 1 ? "s" : ""}` : "Nothing to add"}</button>
        <button class="btn block" id="bulk-back">Back to edit</button>
      </div>`);
    document.getElementById("bulk-back").addEventListener("click", () => openBulk(text));
    const approve = document.getElementById("bulk-approve");
    approve.addEventListener("click", async () => {
      setBusy(approve, true, "Adding…");
      try {
        const ok = await guarded(async () => {
          await reloadAccounts();
          const taken = new Set(state.accounts.map((a) => lower(a.id)));
          const clash = good.find((r) => taken.has(r.obj.id));
          if (clash) throw new Error(`"${clash.obj.id}" was just added by someone else. Check again.`);
          await Sheets.appendRows("Accounts", good.map((r) => r.obj));
          await reloadAccounts();
          return true;
        });
        if (!ok) return;
        closeSheet();
        toast(`Added ${good.length} account${good.length > 1 ? "s" : ""}`);
        route();
      } catch (ex) {
        document.getElementById("bulk-err").textContent = friendlyError(ex);
        setBusy(approve, false);
      }
    });
  }

  function updateOnline() { $offline.hidden = navigator.onLine; }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);

  // ---------- boot ----------

  function boot() {
    updateOnline();
    if (!(window.FD_CONFIG && window.FD_CONFIG.GOOGLE_CLIENT_ID)) return renderNotConfigured();
    loadToken();
    if (state.token && state.email) {
      afterSignIn();
    } else {
      clearToken();
      renderSignIn();
    }
  }

  window.App = { onGisLoaded };
  boot();
  // GIS may have loaded before this script ran.
  if (window.google && google.accounts && google.accounts.oauth2 && !state.gisReady) onGisLoaded();
})();
