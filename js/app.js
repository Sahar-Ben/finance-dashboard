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
    snapshots: [],
    snapHeader: [],
    rateRows: [],
    rateHeader: [],
    rates: [],          // Calc.rateTable(rateRows)
    rateIssues: [],     // [{ month, field, row }] rates that could not be fetched
    ratesPending: false,
    displayCur: LS.get("fd.displayCurrency"),
    ovMonth: null,      // month shown on the Overview
    imp: { text: "", rows: null },  // import box contents, kept while moving around the app
    manualShowAll: false,
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
    state.snapshots = [];
    state.imp = { text: "", rows: null };
    state.manualDraft = null;
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
    const [settings, accounts, snaps, rates] = await Promise.all([
      Sheets.readSettings(), Sheets.readTab("Accounts"), Sheets.readTab("Snapshots"), Sheets.readTab("Rates"),
    ]);
    state.settings = settings;
    state.accounts = accounts.rows;
    setSnapshots(snaps);
    setRates(rates);
    state.me = people().find((p) => p.email && p.email === state.email) || null;
    if (!CURRENCIES.includes(state.displayCur)) {
      const d = norm(settings.default_currency).toUpperCase();
      state.displayCur = CURRENCIES.includes(d) ? d : "ILS";
    }
    if (state.me) syncRatesInBackground();
  }

  function setSnapshots(res) {
    state.snapshots = res.rows;
    state.snapHeader = res.header;
  }
  function setRates(res) {
    state.rateRows = res.rows;
    state.rateHeader = res.header;
    state.rates = Calc.rateTable(res.rows);
  }
  async function reloadSnapshots() {
    setSnapshots(await Sheets.readTab("Snapshots"));
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
    state.snapshots = [];
    state.rateRows = [];
    state.rates = [];
    state.imp = { text: "", rows: null };
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

  // Screens reached from a button rather than the tab bar; `tab` is the tab shown as current.
  const SUBSCREENS = { update: { tab: "overview", render: () => renderUpdate() } };

  function currentRoute() {
    const h = location.hash.replace("#", "");
    if (SUBSCREENS[h]) return h;
    return TABS.some((t) => t.id === h) ? h : "overview";
  }
  const currentTab = () => { const r = currentRoute(); return SUBSCREENS[r] ? SUBSCREENS[r].tab : r; };

  function route() {
    if (!state.token) return renderSignIn();
    if (!state.sheetId) return renderConnect();
    // First run: nobody is set up yet, so the signed-in user configures the two people.
    if (!peopleConfigured()) return renderSetupPeople();
    if (!state.me) return renderNotRecognised();
    const tab = currentTab();
    const r = currentRoute();
    $tabbar.hidden = false;
    $screen.classList.remove("no-tabs");
    $tabbar.innerHTML = `<div class="tabs">${TABS.map((t) => `
      <button data-tab="${t.id}" ${t.id === tab ? 'aria-current="page"' : ""}>${ICONS[t.id]}<span>${t.label}</span></button>`).join("")}</div>`;
    if (SUBSCREENS[r]) SUBSCREENS[r].render();
    else TABS.find((t) => t.id === tab).render();
    window.scrollTo(0, 0);
  }

  $tabbar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    if (currentRoute() === b.dataset.tab) return;
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

  // ---------- money formatting ----------

  function fmtMoney(v, cur, decimals) {
    if (v == null || !isFinite(v)) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency", currency: cur, minimumFractionDigits: 0, maximumFractionDigits: decimals ? 2 : 0,
      }).format(v);
    } catch (_) {
      return `${cur} ${Math.round(v).toLocaleString("en-US")}`;
    }
  }
  function fmtSigned(v, cur) {
    if (v == null) return "—";
    const sign = v > 0.5 ? "+" : v < -0.5 ? "−" : "±";
    return sign + fmtMoney(Math.abs(v), cur);
  }
  function fmtPct(p) {
    if (p == null || !isFinite(p)) return "";
    return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`;
  }
  const toneOf = (v) => (v == null || Math.abs(v) < 0.5 ? "muted" : v > 0 ? "pos" : "neg");
  const accountName = (a) => esc(norm(a.nickname) || a.id);

  // ---------- exchange rates (GOOGLEFINANCE in the Rates tab) ----------

  const RATE_PAIRS = { usd_ils: "USDILS", eur_ils: "EURILS" };
  let formulaSep = ",";

  const liveFormula = (pair) => `=GOOGLEFINANCE("CURRENCY:${pair}")`;
  // Last available daily rate on or before the month's last day (skips weekends and holidays).
  function monthEndFormula(pair, month) {
    const [y, m] = month.split("-").map(Number);
    const f = `=LET(monthend,EOMONTH(DATE(${y},${m},1),0),` +
      `tbl,GOOGLEFINANCE("CURRENCY:${pair}","price",monthend-10,monthend+1),` +
      `dts,INDEX(tbl,0,1),vals,FILTER(INDEX(tbl,0,2),ISNUMBER(dts),dts<monthend+1),` +
      `INDEX(vals,ROWS(vals),1))`;
    return formulaSep === "," ? f : f.replace(/,/g, ";");
  }
  const isFormula = (v) => typeof v === "string" && v.startsWith("=");
  const isPending = (v) => typeof v === "string" && /^loading/i.test(v);

  let ratesSyncing = null;
  function syncRatesInBackground() {
    if (ratesSyncing) return ratesSyncing;
    ratesSyncing = syncRates()
      .catch((e) => { console.warn("Rates sync failed:", e); })
      .finally(() => { ratesSyncing = null; refreshOverview(); });
    return ratesSyncing;
  }

  // Re-draws the Overview after rates arrive, unless a panel is open over it.
  function refreshOverview() {
    if (!state.me || !$sheet.hidden || !$reauth.hidden || $tabbar.hidden) return;
    if (currentRoute() === "overview") renderOverview();
  }

  // Makes sure every month with snapshots (and the current month) has a Rates row:
  // the current month keeps a live formula; past months get a month-end formula, and once that
  // shows a valid number it is replaced by the plain value so history never shifts.
  async function syncRates() {
    const nowM = Calc.currentMonth();
    const needed = new Set([nowM]);
    state.snapshots.forEach((s) => { const m = Calc.normMonth(s.month); if (m && m <= nowM) needed.add(m); });

    const plan = async () => {
      const [vals, forms] = await Promise.all([Sheets.readTab("Rates"), Sheets.readTab("Rates", { formulas: true })]);
      setRates(vals);
      const formulaOf = new Map(forms.rows.map((r) => [r._row, r]));
      const seen = new Map();
      vals.rows.forEach((r) => { const m = Calc.normMonth(r.month); if (m && !seen.has(m)) seen.set(m, r); });
      const toFormula = [], toValue = [], issues = [];
      let pending = false, parseErrors = false;
      seen.forEach((r, m) => {
        const f = formulaOf.get(r._row) || {};
        Object.keys(RATE_PAIRS).forEach((field) => {
          const value = r[field];
          const formula = isFormula(f[field]) ? f[field] : null;
          const empty = value === "" || value == null;
          if (m >= nowM) {
            if (empty) toFormula.push({ row: r._row, field, value: liveFormula(RATE_PAIRS[field]) });
            else if (isPending(value)) pending = true;
            else if (!Calc.validRate(value)) issues.push({ month: m, field, row: r._row });
            return;
          }
          if (!formula) {
            if (empty) toFormula.push({ row: r._row, field, value: monthEndFormula(RATE_PAIRS[field], m) });
            else if (!Calc.validRate(value)) issues.push({ month: m, field, row: r._row });
            return; // a typed number is kept as it is
          }
          if (!/EOMONTH/i.test(formula)) { // the live formula of a month that has since ended
            toFormula.push({ row: r._row, field, value: monthEndFormula(RATE_PAIRS[field], m) });
          } else if (Calc.validRate(value)) {
            toValue.push({ row: r._row, field, value });
          } else if (isPending(value)) {
            pending = true;
          } else {
            if (/^#ERROR/i.test(String(value))) parseErrors = true;
            issues.push({ month: m, field, row: r._row });
          }
        });
      });
      const missing = [...needed].filter((m) => !seen.has(m)).sort();
      return { header: vals.header, toFormula, toValue, issues, pending, parseErrors, missing };
    };

    let p = await plan();
    // Some spreadsheet locales separate formula arguments with ";" — switch once if formulas fail to parse.
    if (p.parseErrors && formulaSep === ",") {
      formulaSep = ";";
      p.issues.forEach((i) => p.toFormula.push({ row: i.row, field: i.field, value: monthEndFormula(RATE_PAIRS[i.field], i.month) }));
      p.issues = [];
    }
    let wroteFormulas = false;
    if (p.toValue.length) await Sheets.setCells("Rates", p.header, p.toValue, "RAW");
    if (p.toFormula.length) { await Sheets.setCells("Rates", p.header, p.toFormula, "USER_ENTERED"); wroteFormulas = true; }
    if (p.missing.length) {
      await Sheets.appendRows("Rates", p.missing.map((m) => {
        const row = { month: `'${m}` };
        Object.keys(RATE_PAIRS).forEach((field) => {
          row[field] = m >= Calc.currentMonth() ? liveFormula(RATE_PAIRS[field]) : monthEndFormula(RATE_PAIRS[field], m);
        });
        return row;
      }), "USER_ENTERED");
      wroteFormulas = true;
    }
    if (wroteFormulas) {
      await new Promise((r) => setTimeout(r, 3000)); // give GOOGLEFINANCE a moment
      p = await plan();
      if (p.toValue.length) await Sheets.setCells("Rates", p.header, p.toValue, "RAW");
    }
    state.rateIssues = p.issues;
    state.ratesPending = p.pending;
  }

  async function saveTypedRate(issue, value) {
    await guarded(async () => {
      await Sheets.setCells("Rates", state.rateHeader, [{ row: issue.row, field: issue.field, value }], "RAW");
      setRates(await Sheets.readTab("Rates"));
    });
    state.rateIssues = state.rateIssues.filter((i) => !(i.row === issue.row && i.field === issue.field));
  }

  function rateNoticesHtml(months) {
    const relevant = state.rateIssues.filter((i) => !months || months.includes(i.month));
    if (!relevant.length) return "";
    return `
      <div class="card notice stack">
        <div class="label">Exchange rate missing</div>
        <p class="muted">Google Finance could not supply ${relevant.length === 1 ? "this rate" : "these rates"}. Type the rate (how many ₪ for 1 unit) and tap Save.</p>
        ${relevant.map((i, n) => `
          <div class="rate-row">
            <span class="mono">${esc(Calc.monthLabel(i.month, true))} · ${i.field === "usd_ils" ? "USD → ILS" : "EUR → ILS"}</span>
            <input type="text" inputmode="decimal" data-rate-input="${n}" placeholder="${i.field === "usd_ils" ? "3.70" : "4.00"}">
            <button class="btn small" data-rate-save="${n}">Save</button>
          </div>`).join("")}
        <p class="err-text" id="rate-err"></p>
      </div>`;
  }

  function bindRateNotices(months) {
    const relevant = state.rateIssues.filter((i) => !months || months.includes(i.month));
    $screen.querySelectorAll("[data-rate-save]").forEach((btn) => btn.addEventListener("click", async () => {
      const n = Number(btn.dataset.rateSave);
      const input = $screen.querySelector(`[data-rate-input="${n}"]`);
      const v = Calc.parseAmount(input.value);
      const $err = document.getElementById("rate-err");
      if (!Calc.validRate(v) || v > 100) { $err.textContent = "Enter a positive number, for example 3.70."; return; }
      setBusy(btn, true, "…");
      try {
        await saveTypedRate(relevant[n], v);
        toast("Rate saved");
        route();
      } catch (e) {
        $err.textContent = friendlyError(e);
        setBusy(btn, false);
      }
    }));
  }

  // ---------- Overview ----------

  function renderOverview() {
    const cur = state.displayCur;
    const months = Calc.snapshotMonths(state.snapshots, state.accounts);
    const latestBal = months.balances[0] || null;
    if (!state.ovMonth || !months.all.includes(state.ovMonth)) state.ovMonth = latestBal || months.all[0] || null;
    const month = state.ovMonth;
    const idx = Calc.indexSnapshots(state.snapshots);
    const totalsFor = (m) => Calc.monthTotals(state.accounts, idx, m, cur, state.rates, latestBal);

    const head = `
      <div class="page-head">
        <div><div class="label">Hi, ${esc(state.me.name)}</div><h1>Overview</h1></div>
        <a class="btn primary small" href="#update">Update</a>
      </div>`;
    const curSeg = `<div class="seg seg-sm" id="ov-cur">${CURRENCIES.map((c) =>
      `<button type="button" data-cur="${c}" aria-pressed="${c === cur}">${c}</button>`).join("")}</div>`;

    if (!month) {
      $screen.innerHTML = `${head}
        <div class="stack-lg">
          <div class="card hero stack">
            <div class="label">Reachable money</div>
            <div class="big-number muted">—</div>
            <p class="muted">No balances yet. Tap <strong>Update</strong> to paste or type this month's balances.</p>
            <a class="btn primary block" href="#update">Add balances</a>
          </div>
        </div>`;
      return;
    }

    const t = totalsFor(month);
    const sel = `
      <div class="month-bar">
        <button class="icon-btn" id="ov-prev" aria-label="Earlier month" ${months.all.indexOf(month) >= months.all.length - 1 ? "disabled" : ""}>‹</button>
        <select id="ov-month" aria-label="Month">${months.all.map((m) =>
          `<option value="${m}" ${m === month ? "selected" : ""}>${Calc.monthLabel(m, true)}${months.balances.includes(m) ? "" : " · cards only"}</option>`).join("")}</select>
        <button class="icon-btn" id="ov-next" aria-label="Later month" ${months.all.indexOf(month) <= 0 ? "disabled" : ""}>›</button>
      </div>`;

    // Comparisons: the calendar month before, and the first month of the same year with balances.
    const prevM = Calc.shiftMonth(month, -1);
    const prevT = totalsFor(prevM);
    const yearFirst = months.balances.filter((m) => m.slice(0, 4) === month.slice(0, 4) && m < month).sort()[0] || null;
    const firstT = yearFirst ? totalsFor(yearFirst) : null;

    const changeLine = (label, field, other, otherMonth) => {
      if (!other || !other.hasBalances) {
        return `<div class="chg"><span class="label">${esc(label)}</span><span class="muted">No balances in ${Calc.monthLabel(otherMonth, true)}</span></div>`;
      }
      const c = Calc.change(t[field], other[field]);
      return `<div class="chg"><span class="label">${esc(label)}${other.incomplete ? " · incomplete" : ""}</span>
        <span class="mono ${toneOf(c.amount)}">${fmtSigned(c.amount, cur)} <small>${fmtPct(c.pct)}</small></span></div>`;
    };
    const changes = (field) => !t.hasBalances ? "" : `
      <div class="chg-list">
        ${changeLine(`vs ${Calc.monthLabel(prevM)}`, field, prevT, prevM)}
        ${yearFirst && yearFirst !== prevM ? changeLine(`since ${Calc.monthLabel(yearFirst)}`, field, firstT, yearFirst) : ""}
      </div>`;

    const incompleteChip = t.incomplete && t.hasBalances ? `<span class="chip neg">Incomplete</span>` : "";
    const hero = t.hasBalances ? `
      <div class="card hero stack">
        <div class="spread"><div class="label">Reachable money · ${Calc.monthLabel(month, true)}</div>${incompleteChip}</div>
        <div class="big-number">${fmtMoney(t.reachable, cur)}</div>
        ${changes("reachable")}
      </div>
      <div class="card stack">
        <div class="label">Long-term total</div>
        <div class="mid-number">${fmtMoney(t.longTerm, cur)}</div>
        ${changes("longTerm")}
      </div>` : `
      <div class="card hero stack">
        <div class="label">Reachable money · ${Calc.monthLabel(month, true)}</div>
        <div class="big-number muted">—</div>
        <p class="muted">No balances for ${Calc.monthLabel(month, true)} — only card totals.</p>
      </div>`;

    const missing = t.hasBalances && (t.missing.length || t.unconverted.length) ? `
      <div class="card danger stack">
        <div class="label">Incomplete month</div>
        <p class="muted">${t.missing.length ? `${t.missing.length} account${t.missing.length > 1 ? "s have" : " has"} no balance for ${Calc.monthLabel(month, true)}, so the totals above leave ${t.missing.length > 1 ? "them" : "it"} out:` : ""}</p>
        ${t.missing.length ? `<ul class="plain-list">${t.missing.map((a) => `<li><span>${accountName(a)}</span><span class="mono muted">${esc(TYPE_LABEL[lower(a.type)] || a.type)} · ${esc(a.updater || a.owner)}</span></li>`).join("")}</ul>` : ""}
        ${t.unconverted.length ? `<p class="muted">Left out because an exchange rate is missing: ${t.unconverted.map(accountName).join(", ")}.</p>` : ""}
        <a class="btn block" href="#update">Add the missing balances</a>
      </div>` : "";

    const typeCards = t.hasBalances ? TYPES.filter((ty) => ty !== "card" && t.counts[ty]).map((ty) => {
      const v = t.byType[ty];
      const share = ty === "loan" ? null : (t.assets > 0 ? (v / t.assets) * 100 : 0);
      return `
        <div class="type-card">
          <div class="spread"><span class="label">${TYPE_LABEL[ty]}</span><span class="label">${t.counts[ty]}</span></div>
          <div class="type-value mono ${ty === "loan" ? "neg" : ""}">${ty === "loan" ? "−" : ""}${fmtMoney(v, cur)}</div>
          ${share == null ? `<div class="muted small">owed · subtracted</div>`
            : `<div class="bar"><span style="width:${Math.max(2, Math.min(100, share)).toFixed(1)}%"></span></div><div class="muted small mono">${share.toFixed(1)}% of assets</div>`}
        </div>`;
    }).join("") : "";
    const cardsCard = t.cardCount ? `
      <div class="type-card">
        <div class="spread"><span class="label">Cards</span><span class="label">${t.cardCount}</span></div>
        <div class="type-value mono">${fmtMoney(t.cards, cur)}</div>
        <div class="muted small">spending · not in totals</div>
      </div>` : "";

    $screen.innerHTML = `${head}
      <div class="stack-lg">
        <div class="row ov-controls">${sel}${curSeg}</div>
        ${state.ratesPending ? `<p class="muted small">Fetching exchange rates…</p>` : ""}
        ${rateNoticesHtml(months.all)}
        ${hero}
        ${missing}
        ${typeCards || cardsCard ? `<div><div class="group-title"><span class="label">By type</span></div><div class="type-grid">${typeCards}${cardsCard}</div></div>` : ""}
      </div>`;

    const go = (m) => { state.ovMonth = m; route(); };
    document.getElementById("ov-month").addEventListener("change", (e) => go(e.target.value));
    document.getElementById("ov-prev").addEventListener("click", () => go(months.all[months.all.indexOf(month) + 1]));
    document.getElementById("ov-next").addEventListener("click", () => go(months.all[months.all.indexOf(month) - 1]));
    document.getElementById("ov-cur").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cur]");
      if (!b || b.dataset.cur === state.displayCur) return;
      state.displayCur = b.dataset.cur;
      LS.set("fd.displayCurrency", state.displayCur);
      route();
    });
    bindRateNotices(months.all);
  }

  // ---------- Update: import box, manual form, account list ----------

  const IMPORT_COLUMNS = "month | account_id | amount | currency | as_of_date";

  function renderUpdate() {
    const mode = state.updateMode || "import";
    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">Monthly update</div><h1>Update</h1></div>
        <a class="btn small" href="#overview">Done</a>
      </div>
      <div class="stack-lg">
        <div class="seg" id="up-mode">
          <button type="button" data-mode="import" aria-pressed="${mode === "import"}">PASTE ROWS</button>
          <button type="button" data-mode="manual" aria-pressed="${mode === "manual"}">ONE BALANCE</button>
        </div>
        <div id="up-body"></div>
      </div>`;
    document.getElementById("up-mode").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (!b || b.dataset.mode === mode) return;
      if (mode === "import") state.imp.text = document.getElementById("imp-text").value;
      state.updateMode = b.dataset.mode;
      renderUpdate();
    });
    if (mode === "import") renderImport(); else renderManual();
  }

  function copyAccountList() {
    const lines = state.accounts.filter(isActive)
      .map((a) => [a.id, norm(a.nickname), norm(a.currency).toUpperCase(), norm(a.owner)].join(" | "))
      .join("\n");
    if (!lines) { toast("No active accounts yet", true); return; }
    const fallback = () => {
      openSheet(`
        <div class="stack-lg">
          <div class="spread"><div><div class="label">Account list</div><h2>Copy this</h2></div>
            <button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
          <textarea id="acct-list" readonly>${esc(lines)}</textarea>
          <p class="muted">Tap the text, Select All, then Copy.</p>
        </div>`);
      const ta = document.getElementById("acct-list");
      ta.focus(); ta.select();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines).then(
        () => toast(`Copied ${lines.split("\n").length} accounts`),
        fallback,
      );
    } else fallback();
  }

  function renderImport() {
    const body = document.getElementById("up-body");
    body.innerHTML = `
      <div class="stack-lg">
        <div class="card stack">
          <div class="label">Paste balances</div>
          <p class="muted">One balance per line:</p>
          <div class="code">${IMPORT_COLUMNS}</div>
          <p class="muted small">Example: <span class="mono">${esc(Calc.currentMonth())} | bank-a-cur | 12,345.67 | ILS | ${esc(Calc.today())}</span><br>
            For cards, use the charge month and the card's monthly total. Nothing is saved until you approve the preview.</p>
          <button class="btn block" id="imp-copy">Copy account list</button>
        </div>
        <textarea id="imp-text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(IMPORT_COLUMNS)}">${esc(state.imp.text)}</textarea>
        <button class="btn primary block" id="imp-check">Check</button>
        <div id="imp-preview"></div>
      </div>`;
    document.getElementById("imp-copy").addEventListener("click", copyAccountList);
    const $text = document.getElementById("imp-text");
    $text.addEventListener("input", () => { state.imp.text = $text.value; });
    document.getElementById("imp-check").addEventListener("click", () => {
      state.imp.text = $text.value;
      if (!$text.value.trim()) { toast("Paste some rows first", true); return; }
      state.imp.rows = Calc.splitImport($text.value);
      recheckImport();
      renderImportPreview(true);
    });
    if (state.imp.rows) { recheckImport(); renderImportPreview(false); }
  }

  function recheckImport() {
    Calc.checkImport(state.imp.rows, {
      accounts: state.accounts, idx: Calc.indexSnapshots(state.snapshots), rates: state.rates, now: new Date(),
    });
  }

  function renderImportPreview(scroll) {
    const host = document.getElementById("imp-preview");
    const rows = state.imp.rows || [];
    if (!rows.length) { host.innerHTML = `<p class="muted">No rows to check.</p>`; return; }
    const good = rows.filter((r) => !r.problems.length);
    const bad = rows.length - good.length;
    const cellBad = (r, col) => r.problems.some((p) => p.col === col);
    const show = (r, col, text) => `<span class="${cellBad(r, col) ? "bad-cell" : ""}">${esc(text || (cellBad(r, col) ? "(empty)" : "—"))}</span>`;

    host.innerHTML = `
      <div class="stack">
        <div class="spread"><h2>${good.length} ready${bad ? `, <span class="neg">${bad} with problems</span>` : ""}</h2></div>
        <p class="muted">${bad ? "Rows in red will be skipped. Edit them to fix, or remove them." : "Nothing is saved yet. Review, then approve."}</p>
        ${rows.map((r, i) => {
          const z = r.resolved;
          const a = z && z.account;
          const cur = z ? z.currency : norm(r.currency).toUpperCase();
          const amountOk = z && !cellBad(r, "amount") && isFinite(z.amount);
          let prevLine = "";
          if (z && z.prev && isFinite(z.prev.amount)) {
            prevLine = `<div class="mono small">${Calc.monthLabel(z.prev.month)}: ${fmtMoney(z.prev.amount, cur, true)}
              ${z.delta ? ` → <span class="${toneOf(z.delta.amount)}">${fmtSigned(z.delta.amount, cur)} ${fmtPct(z.delta.pct)}</span>` : ""}</div>`;
          } else if (z && z.month) {
            prevLine = `<div class="muted small">No balance for ${Calc.monthLabel(Calc.shiftMonth(z.month, -1))}</div>`;
          }
          const chips = [];
          if (z && z.existing) chips.push(`<span class="chip warn">Replaces ${esc(fmtMoney(Calc.parseAmount(z.existing.amount), cur, true))}</span>`);
          if (z && z.large && !r.problems.length) chips.push(`<span class="chip warn">Large change</span>`);
          return `
            <div class="preview-row ${r.problems.length ? "bad" : z && z.large ? "warn" : ""}">
              <div class="spread">
                <strong>${a ? accountName(a) : show(r, "account_id", r.account_id)}</strong>
                <span class="mono small">${show(r, "month", z && z.month ? Calc.monthLabel(z.month, true) : r.month)}</span>
              </div>
              <div class="spread" style="margin-top:4px">
                <span class="mono imp-amount">${amountOk ? esc(fmtMoney(z.amount, cur, true)) : show(r, "amount", r.amount)}</span>
                <span class="mono small">${show(r, "currency", cur)}${z && z.as_of_date ? ` · ${show(r, "as_of_date", z.as_of_date)}` : cellBad(r, "as_of_date") ? ` · ${show(r, "as_of_date", r.as_of_date)}` : ""}</span>
              </div>
              ${prevLine}
              ${chips.length ? `<div class="row wrap" style="margin-top:8px">${chips.join("")}</div>` : ""}
              ${r.problems.length || r.warnings.length ? `<div class="problems">
                ${r.problems.map((p) => `<span class="err-text">✕ ${esc(p.msg)}</span>`).join("")}
                ${r.warnings.map((w) => `<span class="muted small">• ${esc(w)}</span>`).join("")}
              </div>` : ""}
              <div class="row" style="margin-top:10px">
                <button class="btn small" data-imp-edit="${i}">Edit</button>
                <button class="btn small ghost" data-imp-remove="${i}">Remove</button>
              </div>
            </div>`;
        }).join("")}
        <p class="err-text" id="imp-err"></p>
        <button class="btn primary block" id="imp-approve" ${good.length ? "" : "disabled"}>${good.length ? `Approve and save ${good.length} balance${good.length > 1 ? "s" : ""}` : "Nothing to save"}</button>
        <button class="btn ghost block" id="imp-clear">Clear</button>
      </div>`;

    host.querySelectorAll("[data-imp-remove]").forEach((b) => b.addEventListener("click", () => {
      state.imp.rows.splice(Number(b.dataset.impRemove), 1);
      recheckImport();
      renderImportPreview(false);
    }));
    host.querySelectorAll("[data-imp-edit]").forEach((b) => b.addEventListener("click", () => openImportRowEditor(Number(b.dataset.impEdit))));
    document.getElementById("imp-clear").addEventListener("click", () => {
      state.imp = { text: "", rows: null };
      renderUpdate();
    });
    const approve = document.getElementById("imp-approve");
    approve.addEventListener("click", () => approveImport(approve));
    if (scroll) host.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openImportRowEditor(i) {
    const r = state.imp.rows[i];
    const z = r.resolved;
    const month = (z && z.month) || Calc.normMonth(r.month) || "";
    const acctId = z && z.account ? z.account.id : r.account_id;
    const cur = (z && z.currency) || norm(r.currency).toUpperCase() || "ILS";
    const date = (z && z.as_of_date) || Calc.normDate(r.as_of_date) || "";
    const accts = [...state.accounts].sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
    openSheet(`
      <form id="ire-form" class="stack-lg" novalidate>
        <div class="spread"><div><div class="label">Edit row ${i + 1}</div><h2>Fix this row</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
        <div class="code">${esc(r.line || "")}</div>
        <div class="field"><label class="label" for="ire-acct">Account</label>
          <select id="ire-acct">${options(accts.map((a) => [a.id, `${norm(a.nickname) || a.id} (${a.id})`]), acctId, "Choose…")}</select></div>
        <div class="field-row">
          <div class="field"><label class="label" for="ire-month">Month</label><input id="ire-month" type="month" value="${esc(month)}"></div>
          <div class="field"><label class="label" for="ire-date">As-of date</label><input id="ire-date" type="date" value="${esc(date)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="label" for="ire-amount">Amount</label><input id="ire-amount" type="text" inputmode="decimal" value="${esc(z && isFinite(z.amount) ? z.amount : r.amount)}"></div>
          <div class="field"><label class="label" for="ire-cur">Currency</label><select id="ire-cur">${options(CURRENCIES, cur)}</select></div>
        </div>
        <button class="btn primary block" type="submit">Update row</button>
      </form>`);
    const $acct = document.getElementById("ire-acct");
    $acct.addEventListener("change", () => {
      const a = state.accounts.find((x) => x.id === $acct.value);
      if (a) document.getElementById("ire-cur").value = norm(a.currency).toUpperCase();
    });
    document.getElementById("ire-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = (id) => document.getElementById(id).value.trim();
      Object.assign(r, {
        account_id: v("ire-acct"), month: v("ire-month"), as_of_date: v("ire-date"),
        amount: v("ire-amount"), currency: v("ire-cur"), columns: null,
      });
      r.line = [r.month, r.account_id, r.amount, r.currency, r.as_of_date].join(" | ");
      closeSheet();
      recheckImport();
      renderImportPreview(false);
    });
  }

  const newSnapshotId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Saves checked rows: replaces an existing snapshot for the same account and month, else appends.
  async function saveSnapshots(items, source) {
    await reloadSnapshots();
    const idx = Calc.indexSnapshots(state.snapshots);
    const enteredAt = new Date().toISOString();
    const cells = [];
    const appends = [];
    items.forEach((z) => {
      const values = {
        month: z.month, account_id: z.account.id, amount: z.amount, currency: z.currency,
        as_of_date: z.as_of_date, entered_by: state.me.name, entered_at: enteredAt, source,
      };
      const existing = idx.get(norm(z.account.id), z.month);
      if (existing) {
        if (!norm(existing.id)) values.id = newSnapshotId();
        Object.entries(values).forEach(([field, value]) => cells.push({ row: existing._row, field, value }));
      } else {
        appends.push({ id: newSnapshotId(), ...values });
      }
    });
    if (cells.length) await Sheets.setCells("Snapshots", state.snapHeader, cells, "RAW");
    if (appends.length) await Sheets.appendRows("Snapshots", appends);
    await reloadSnapshots();
    return { replaced: items.length - appends.length, added: appends.length };
  }

  async function approveImport(btn) {
    const $err = document.getElementById("imp-err");
    setBusy(btn, true, "Saving…");
    try {
      const res = await guarded(async () => {
        await reloadSnapshots();
        recheckImport(); // a partner may have saved in the meantime
        const good = state.imp.rows.filter((r) => !r.problems.length).map((r) => r.resolved);
        if (!good.length) throw new Error("Nothing left to save.");
        const out = await saveSnapshots(good, "import");
        out.latest = good.filter((z) => lower(z.account.type) !== "card").map((z) => z.month).sort().pop() || null;
        return out;
      });
      state.imp = { text: "", rows: null };
      syncRatesInBackground();
      toast(`Saved ${res.added + res.replaced} balance${res.added + res.replaced > 1 ? "s" : ""}${res.replaced ? ` (${res.replaced} replaced)` : ""}`);
      if (res.latest) state.ovMonth = res.latest;
      location.hash = "overview";
    } catch (e) {
      $err.textContent = friendlyError(e);
      setBusy(btn, false);
    }
  }

  function renderManual() {
    const body = document.getElementById("up-body");
    const meName = lower(state.me.name);
    const active = state.accounts.filter(isActive);
    const isMine = (a) => [lower(a.owner), lower(a.updater)].includes(meName) || lower(a.owner) === lower(JOINT);
    const mine = active.filter(isMine).sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
    const others = active.filter((a) => !isMine(a)).sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
    const showAll = state.manualShowAll || !mine.length;
    const keep = state.manualDraft || {};
    const label = (a) => `${norm(a.nickname) || a.id} · ${norm(a.currency).toUpperCase()}`;
    if (!active.length) {
      body.innerHTML = `<div class="card empty stack"><p class="muted">Add accounts first, on the Accounts tab.</p><a class="btn block" href="#accounts">Go to Accounts</a></div>`;
      return;
    }
    body.innerHTML = `
      <form id="man-form" class="card stack-lg" novalidate>
        <div class="field"><label class="label" for="man-acct">Account</label>
          <select id="man-acct">
            <optgroup label="Mine & joint">${options(mine.map((a) => [a.id, label(a)]), keep.account_id)}</optgroup>
            ${showAll && others.length ? `<optgroup label="Other accounts">${options(others.map((a) => [a.id, label(a)]), keep.account_id)}</optgroup>` : ""}
          </select>
          ${others.length ? `<button type="button" class="link-btn" id="man-all">${showAll ? "Show only mine & joint" : `Show all accounts (${others.length} more)`}</button>` : ""}
        </div>
        <div class="field-row">
          <div class="field"><label class="label" for="man-month">Month</label><input id="man-month" type="month" value="${esc(keep.month || Calc.currentMonth())}"></div>
          <div class="field"><label class="label" for="man-date">As-of date</label><input id="man-date" type="date" value="${esc(keep.as_of_date || Calc.today())}"></div>
        </div>
        <div class="field"><label class="label" for="man-amount">Amount <span id="man-cur" class="chip accent" style="margin-left:6px"></span></label>
          <input id="man-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(keep.amount || "")}"></div>
        <div id="man-context" class="stack"></div>
        <p class="err-text" id="man-err"></p>
        <button class="btn primary block" type="submit" id="man-save">Save balance</button>
      </form>`;
    const $acct = document.getElementById("man-acct");
    const $month = document.getElementById("man-month");
    const $amount = document.getElementById("man-amount");
    const $date = document.getElementById("man-date");
    let confirmedLarge = false;
    const draft = () => ({ account_id: $acct.value, month: $month.value, amount: $amount.value, as_of_date: $date.value });

    const check = () => {
      const a = state.accounts.find((x) => x.id === $acct.value);
      const row = { ...draft(), currency: a ? norm(a.currency).toUpperCase() : "", columns: null };
      Calc.checkImport([row], { accounts: state.accounts, idx: Calc.indexSnapshots(state.snapshots), rates: state.rates, now: new Date() });
      return row;
    };
    const updateContext = () => {
      state.manualDraft = draft();
      confirmedLarge = false;
      document.getElementById("man-save").textContent = "Save balance";
      const a = state.accounts.find((x) => x.id === $acct.value);
      const cur = a ? norm(a.currency).toUpperCase() : "";
      document.getElementById("man-cur").textContent = cur;
      const row = check();
      const z = row.resolved;
      const bits = [];
      const m = Calc.normMonth($month.value);
      if (a && m) {
        const idx = Calc.indexSnapshots(state.snapshots);
        const prev = idx.get(a.id, Calc.shiftMonth(m, -1));
        bits.push(prev ? `<span class="muted small mono">${Calc.monthLabel(Calc.shiftMonth(m, -1))}: ${fmtMoney(Calc.parseAmount(prev.amount), cur, true)}</span>`
          : `<span class="muted small">No balance for ${Calc.monthLabel(Calc.shiftMonth(m, -1))}.</span>`);
        const ex = idx.get(a.id, m);
        if (ex) bits.push(`<span class="chip warn">A balance for ${Calc.monthLabel(m)} exists (${esc(fmtMoney(Calc.parseAmount(ex.amount), cur, true))}) — saving replaces it</span>`);
      }
      if (z && z.delta && $amount.value.trim()) {
        bits.push(`<span class="mono small ${toneOf(z.delta.amount)}">Change: ${fmtSigned(z.delta.amount, cur)} ${fmtPct(z.delta.pct)}${z.large ? " · large change" : ""}</span>`);
      }
      document.getElementById("man-context").innerHTML = bits.join("");
    };
    [$acct, $month, $amount, $date].forEach((el) => el.addEventListener("input", updateContext));
    $acct.addEventListener("change", updateContext);
    updateContext();
    const allBtn = document.getElementById("man-all");
    if (allBtn) allBtn.addEventListener("click", () => { state.manualShowAll = !showAll; state.manualDraft = draft(); renderManual(); });

    document.getElementById("man-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const $err = document.getElementById("man-err");
      const row = check();
      if (!norm($amount.value)) { $err.textContent = "Enter the amount."; return; }
      if (row.problems.length) { $err.textContent = row.problems[0].msg; return; }
      if (row.resolved.large && !confirmedLarge) {
        confirmedLarge = true;
        $err.textContent = "That is a large change from last month. Check the amount, then tap again to save.";
        document.getElementById("man-save").textContent = "Save anyway";
        return;
      }
      $err.textContent = "";
      const btn = document.getElementById("man-save");
      setBusy(btn, true, "Saving…");
      try {
        const res = await guarded(() => saveSnapshots([row.resolved], "manual"));
        syncRatesInBackground();
        toast(res.replaced ? "Balance replaced" : "Balance saved");
        state.manualDraft = { month: $month.value, as_of_date: $date.value };
        if (lower(row.resolved.account.type) !== "card") state.ovMonth = row.resolved.month;
        renderManual();
      } catch (ex) {
        $err.textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });
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
