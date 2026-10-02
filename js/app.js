// Finance dashboard — Stage 1: sign-in, sheet connection, Settings, Accounts.
(function () {
  "use strict";

  // Shown in More, and used in index.html (?v=…) so phones load new files after an update.
  const APP_VERSION = "2026.10.02-13";
  const SCOPE_SHEETS = "https://www.googleapis.com/auth/spreadsheets";
  const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
  const TYPES = ["current", "savings", "investment", "crypto", "long_term", "loan", "home", "card"];
  const TYPE_LABEL = {
    current: "Bank", savings: "Savings", investment: "Investment", crypto: "Crypto",
    long_term: "Long-term", loan: "Loan", home: "Home", card: "Card",
  };
  const CURRENCIES = ["ILS", "USD", "EUR"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const JOINT = "Joint";
  // Fields that only apply to some account types.
  const ONLY_FOR = { update_month: ["home"], linked_account: ["card"], monthly_payment: ["loan"], loan_start: ["loan"], original_amount: ["loan"] };
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
    goals: [],
    hideAmounts: LS.get("fd.hideAmounts") === "1",
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
  const $lock = document.getElementById("lock");

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
      $lock.hidden = true; // a Google sign-in always opens the app, even when Face ID is on
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
    const [settings, accounts, snaps, rates, goals, fixed] = await Promise.all([
      Sheets.readSettings(), Sheets.readTab("Accounts"), Sheets.readTab("Snapshots"), Sheets.readTab("Rates"), Sheets.readTab("Goals"),
      Sheets.readTab("Fixed"),
    ]);
    state.goals = goals.rows;
    state.fixed = fixed.rows;
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
    banks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 4l9 5.5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>',
    cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="16" height="12" rx="2.5"/><path d="M6 6V5a1 1 0 0 1 1-1h13a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1h-3"/><path d="M5 14h3"/></svg>',
    trends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  const TABS = [
    { id: "overview", label: "Overview", render: renderOverview },
    { id: "accounts", label: "Accounts", render: renderAccounts },
    { id: "banks", label: "Banks", render: renderBanks },
    { id: "cards", label: "Spending", render: renderCards },
    { id: "trends", label: "Trends", render: renderTrends },
    { id: "more", label: "More", render: renderMore },
  ];

  // Screens reached from a button rather than the tab bar; `tab` is the tab shown as current.
  const SUBSCREENS = {
    update: { tab: "overview", render: () => renderUpdate() },
    goals: { tab: "more", render: () => renderGoals() },
    fixed: { tab: "cards", render: () => renderFixed() },
  };

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
    if ($sheet.hidden) document.body.style.overflow = ""; // never leave scrolling locked by a closed panel
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

  // ---------- Banks: each institution's total and this month's update status ----------

  // Update status of one account for the current month (home: for this year).
  function updateStatus(a, idx, now) {
    const nowM = Calc.currentMonth(now);
    const day = now.getDate();
    const id = norm(a.id);
    const clamp = (d, m) => Math.min(Math.max(1, Number(d) || 1), Number(Calc.lastDayOfMonth(m).slice(8)));
    if (lower(a.type) === "home") {
      const um = Number(a.update_month);
      if (!(um >= 1 && um <= 12)) return { kind: "info", text: "Yearly" };
      const dueM = `${nowM.slice(0, 4)}-${String(um).padStart(2, "0")}`;
      const done = (idx.byAccount.get(id) || []).find((x) => x.month >= dueM);
      if (done) return { kind: "ok", text: `Updated ${shortDate(Calc.normDate(done.snap.as_of_date)) || Calc.monthLabel(done.month)}` };
      if (nowM < dueM || (nowM === dueM && day < clamp(a.update_day, dueM))) return { kind: "info", text: `Yearly · ${MONTHS[um - 1]}` };
      return { kind: "due", text: `Due since ${clamp(a.update_day, dueM)} ${MONTHS[um - 1]}` };
    }
    const s = idx.get(id, nowM);
    if (s) return { kind: "ok", text: `Updated ${shortDate(Calc.normDate(s.as_of_date)) || ""}`.trim() };
    const d = clamp(a.update_day, nowM);
    const m = MONTHS[Number(nowM.slice(5)) - 1];
    return day >= d ? { kind: "due", text: `Due since ${d} ${m}` } : { kind: "info", text: `Due ${d} ${m}` };
  }

  // The signed-in person's share of an account: own in full, Joint half, the partner's not at all.
  function myShare(a) {
    const o = matchName(a.owner, [...personNames(), JOINT]) || JOINT;
    return o === state.me.name ? 1 : o === JOINT ? 0.5 : 0;
  }

  function renderBanks() {
    const cur = state.displayCur;
    const now = new Date();
    const nowM = Calc.currentMonth(now);
    const idx = Calc.indexSnapshots(state.snapshots);
    const months = Calc.snapshotMonths(state.snapshots, state.accounts);
    const latestBal = months.balances[0] || null;
    const accts = state.accounts.filter((a) => isActive(a) && lower(a.type) === "current"); // bank accounts only
    const head = `
      <div class="page-head">
        <div><div class="label">Status · ${Calc.monthLabel(nowM, true)}</div><h1>Banks</h1></div>
      </div>
      <div class="cur-row">${curSegHtml()}</div>`;
    if (!accts.length) {
      $screen.innerHTML = `${head}
        <div class="card empty stack"><p class="muted">No bank accounts yet. Add them on the Accounts tab with type Bank.</p>
          <a class="btn block" href="#accounts">Go to Accounts</a></div>`;
      bindCurSeg();
      return;
    }
    const map = {};
    accts.forEach((a) => { const k = norm(a.institution) || "No institution"; (map[k] = map[k] || []).push(a); });
    const names = Object.keys(map).sort((x, y) => x.localeCompare(y));
    const yearMonths = Calc.monthRange(`${nowM.slice(0, 4)}-01`, nowM);
    const labels = yearMonths.map((m) => MONTHS[Number(m.slice(5)) - 1]);
    const fmtTick = fmtTickFor(cur);

    const statuses = new Map(accts.map((a) => [a.id, updateStatus(a, idx, now)]));
    const monthly = accts.filter((a) => statuses.get(a.id).kind !== "info" || lower(a.type) !== "home");
    const updated = monthly.filter((a) => statuses.get(a.id).kind === "ok").length;
    const dueCount = accts.filter((a) => statuses.get(a.id).kind === "due").length;
    const allNet = groupNet(accts, idx);
    let myNet = null;
    accts.forEach((a) => {
      const info = latestInfo(a, idx);
      const f = myShare(a);
      if (!f || !info || info.converted == null) return;
      myNet = (myNet || 0) + info.converted * f;
    });

    const bankCards = names.map((name) => {
      const list = map[name].sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
      const net = groupNet(list, idx);
      const T = yearMonths.map((m) => Calc.monthTotals(list, idx, m, cur, state.rates, latestBal));
      const vals = T.map((t) => (t.hasBalances ? t.longTerm : null));
      const inc = T.map((t) => t.hasBalances && t.incomplete);
      // Change = each account's latest balance against its own previous month, added up (loans negative).
      let chgSum = 0, chgAny = false;
      list.forEach((a) => {
        const info = latestInfo(a, idx);
        if (!info || !info.delta) return;
        const v = Calc.convert(info.delta.amount, info.own, cur, state.rates, info.month);
        if (v == null) return;
        chgSum += lower(a.type) === "loan" ? -v : v;
        chgAny = true;
      });
      const chg = chgAny ? Calc.change(net, net - chgSum) : null;
      const due = list.filter((a) => statuses.get(a.id).kind === "due").length;
      const ok = list.filter((a) => statuses.get(a.id).kind === "ok").length;
      const chip = due ? `<span class="chip warn">${due} to update</span>`
        : ok === list.length ? `<span class="chip pos">All updated</span>` : `<span class="chip">Not due yet</span>`;
      return `
        <div class="card stack">
          <div class="spread"><h3>${esc(name)}</h3>${chip}</div>
          <div class="spread">
            <div class="mid-number nowrap">${net != null ? esc(fmtMoney(net, cur)) : "—"}</div>
            ${chg ? `<span class="mono small bank-chg ${toneOf(chg.amount)}">${fmtSigned(chg.amount, cur)} ${fmtPct(chg.pct)}<br><span class="muted">vs previous month</span></span>` : ""}
          </div>
          <div class="stack" style="gap:8px">
            ${list.map((a) => {
              const st = statuses.get(a.id);
              const info = latestInfo(a, idx);
              const type = lower(a.type);
              return `
                <button class="bank-acct" data-acct="${esc(a.id)}">
                  <span class="status-dot ${st.kind}" aria-hidden="true"></span>
                  <span class="body"><span class="name">${accountName(a)}</span>
                    <span class="muted small">${esc(TYPE_LABEL[type] || type)} · ${esc(st.text)}${st.kind === "ok" ? "" : ` · by ${esc(a.updater)}`}</span></span>
                  <span class="mono small ${type === "loan" ? "neg" : ""}">${info && isFinite(info.amount) ? `${type === "loan" ? "−" : ""}${esc(fmtMoney(info.amount, info.own))}` : "—"}</span>
                </button>`;
            }).join("")}
          </div>
          ${vals.some((v) => v != null) ? Charts.line({ labels, values: vals, incomplete: inc, fmtTick,
            tips: T.map((t, i) => `${Calc.monthLabel(yearMonths[i], true)} · ${t.hasBalances ? fmtMoney(t.longTerm, cur) + (inc[i] ? " · incomplete" : "") : "no balances"}`),
            ariaLabel: `${name} by month` }) : ""}
        </div>`;
    }).join("");

    $screen.innerHTML = `${head}
      <div class="stack-lg">
        <div class="card hero stack">
          <div class="label">My bank accounts · latest balances</div>
          <div class="big-number">${myNet != null ? esc(fmtMoney(myNet, cur)) : "—"}</div>
          <div class="muted small">Your accounts in full + 50% of joint accounts${allNet != null && allNet !== myNet ? ` · all accounts, full amounts: <span class="mono">${esc(fmtMoney(allNet, cur))}</span>` : ""}</div>
          <div class="spread small"><span>${updated} of ${monthly.length} updated for ${Calc.monthLabel(nowM, true)}</span>
            ${dueCount ? `<span class="chip warn">${dueCount} to update</span>` : updated === monthly.length ? `<span class="chip pos">Up to date</span>` : `<span class="chip">Nothing due yet</span>`}</div>
          <div class="bar"><span style="width:${monthly.length ? Math.max(updated ? 2 : 0, (updated / monthly.length) * 100).toFixed(1) : 0}%"></span></div>
          ${dueCount ? `<a class="btn block" href="#update">Update now</a>` : ""}
        </div>
        ${bankCards}
        <p class="muted small">Bank accounts only (savings, investments, pension, home and loans are on the Overview; cards on the Cards tab). Totals use each account's latest balance, converted with that month's rate. Green = updated this month, orange = due, grey = not due yet.</p>
      </div>`;
    Charts.bind($screen);
    bindCurSeg();
    $screen.querySelectorAll("[data-acct]").forEach((b) => b.addEventListener("click", () => {
      const a = state.accounts.find((x) => String(x.id) === b.dataset.acct);
      if (a) openAccountDetail(a);
    }));
  }

  // ---------- Spending: cards, fixed payments and loan payments ----------

  // Fixed rows that are ordinary payments (not a loan's payment history).
  const plainFixed = () => (state.fixed || []).filter((r) => !norm(r.loan_id));
  // A loan's payment history: Fixed rows with loan_id = the account id (one series), or null.
  const loanSeries = (id) => Calc.fixedSeries((state.fixed || []).filter((r) => norm(r.loan_id) === norm(id)))[0] || null;
  const loanStart = (a, idx) => Calc.normMonth(a.loan_start) || idx.firstMonth.get(norm(a.id)) || Calc.currentMonth();

  // The loan's monthly payment in a month, or null: from its first payment month; for a closed
  // (inactive) loan only up to its last balance. The amount comes from the payment history when
  // there is one (the first recorded amount also covers earlier months), else from monthly_payment.
  function loanPayment(a, month, idx) {
    if (month < loanStart(a, idx)) return null;
    if (!isActive(a)) { const last = Calc.latestSnapshot(idx, a.id); if (!last || month > last.month) return null; }
    const s = loanSeries(a.id);
    const v = s ? Calc.parseAmount((s.versions.filter((x) => x.from <= month).pop() || s.versions[0]).row.amount)
      : Calc.parseAmount(a.monthly_payment);
    return isFinite(v) && v > 0 ? v : null;
  }

  function loanPaymentsFor(month, idx) {
    return state.accounts.filter((a) => lower(a.type) === "loan")
      .map((a) => ({ id: a.id, name: norm(a.nickname) || a.id, amount: loanPayment(a, month, idx),
        currency: norm(a.currency).toUpperCase() || "ILS", owner: norm(a.owner), account: a }))
      .filter((p) => p.amount != null);
  }

  function renderCards() {
    const cur = state.displayCur;
    const idx = Calc.indexSnapshots(state.snapshots);
    const nowM = Calc.currentMonth();
    const cards = state.accounts.filter((a) => lower(a.type) === "card");
    const cardIds = new Set(cards.map((a) => norm(a.id)));
    const head = `
      <div class="page-head">
        <div><div class="label">Cards & fixed payments</div><h1>Spending</h1></div>
      </div>
      <div class="cur-row">${curSegHtml()}</div>`;
    const cardMonths = [...new Set(state.snapshots.filter((s) => cardIds.has(norm(s.account_id)))
      .map((s) => Calc.normMonth(s.month)).filter(Boolean))];
    // Months with fixed or loan payments: from the earliest start up to this month.
    const starts = [
      ...Calc.fixedSeries(plainFixed()).map((s) => s.versions[0].from),
      ...loanPaymentsFor(nowM, idx).map((p) => loanStart(p.account, idx)),
    ].filter((m) => m && m <= nowM).sort();
    const fixedMonths = starts.length ? Calc.monthRange(starts[0], nowM) : [];
    const allMonths = [...new Set([...cardMonths, ...fixedMonths])].sort().reverse();
    if (!allMonths.length) {
      $screen.innerHTML = `${head}
        <div class="card empty stack">
          <p class="muted">Nothing to show yet. Add each card's monthly total with Update, and your rent or parking under Fixed payments.</p>
          <a class="btn block" href="#update">Update</a>
          <a class="btn block" href="#fixed">Fixed payments</a>
        </div>`;
      bindCurSeg();
      return;
    }
    if (!state.cardMonth || !allMonths.includes(state.cardMonth)) {
      state.cardMonth = [...cardMonths].sort().pop() || allMonths.find((m) => m <= nowM) || allMonths[0];
    }
    const month = state.cardMonth;
    const year = month.slice(0, 4);
    const lastInYear = [nowM, ...allMonths].filter((m) => m.slice(0, 4) === year).sort().pop() || `${year}-12`;
    const yearMonths = Calc.monthRange(`${year}-01`, lastInYear);
    const labels = yearMonths.map((m) => MONTHS[Number(m.slice(5)) - 1]);
    const conv = (amt, c, m) => Calc.convert(amt, c, cur, state.rates, m);
    const cardValue = (a, m, display) => {
      const s = idx.get(norm(a.id), m);
      if (!s) return null;
      const v = Calc.parseAmount(s.amount);
      if (!isFinite(v)) return null;
      const own = norm(s.currency).toUpperCase() || norm(a.currency).toUpperCase();
      return display ? conv(v, own, m) : v;
    };
    // Personal share: own in full, joint half, the partner's own not at all (household = everything in full).
    const shareOf = myShare;
    const cardsTotal = (m, household) => {
      let sum = 0, any = false;
      cards.forEach((a) => {
        const f = household ? 1 : shareOf(a);
        if (!f) return;
        const v = cardValue(a, m, true);
        if (v != null) { sum += v * f; any = true; }
      });
      return any ? sum : null;
    };
    const fixedItems = (m) => [
      ...Calc.fixedForMonth(plainFixed(), m).map((p) => ({ ...p, kind: "fixed" })),
      ...loanPaymentsFor(m, idx).map((p) => ({ ...p, kind: "loan" })),
    ];
    const fixedTotal = (m, household) => {
      let sum = 0, any = false;
      fixedItems(m).forEach((p) => {
        const f = household ? 1 : shareOf(p);
        if (!f) return;
        const v = conv(p.amount, p.currency, m);
        if (v != null) { sum += v * f; any = true; }
      });
      return any ? sum : null;
    };
    const avgOf = (vals) => { const v = vals.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    const sumOrNull = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

    const cardSeries = yearMonths.map((m) => cardsTotal(m, false));
    const fixedSeriesV = yearMonths.map((m) => fixedTotal(m, false));
    const totals = yearMonths.map((m, i) => sumOrNull(cardSeries[i], fixedSeriesV[i]));
    const myCardsM = cardsTotal(month, false);
    const myFixedM = fixedTotal(month, false);
    const total = sumOrNull(myCardsM, myFixedM);
    const household = sumOrNull(cardsTotal(month, true), fixedTotal(month, true));
    const avg = avgOf(totals);
    const myCards = cards.filter((a) => shareOf(a) > 0);
    const missing = myCards.filter((a) => isActive(a) && cardValue(a, month, false) == null
      && (idx.firstMonth.get(norm(a.id)) || "9999") <= month);

    const owners = [...personNames(), JOINT];
    const byOwner = owners.map((n) => {
      let sum = 0;
      cards.forEach((a) => { if ((matchName(a.owner, owners) || JOINT) === n) { const v = cardValue(a, month, true); if (v != null) sum += v; } });
      return { name: n, sum };
    });
    const cardsHousehold = byOwner.reduce((s, o) => s + o.sum, 0);

    const sel = `
      <div class="month-bar">
        <button class="icon-btn" id="cd-prev" aria-label="Earlier month" ${allMonths.indexOf(month) >= allMonths.length - 1 ? "disabled" : ""}>‹</button>
        <select id="cd-month" aria-label="Month">${allMonths.map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${Calc.monthLabel(m, true)}</option>`).join("")}</select>
        <button class="icon-btn" id="cd-next" aria-label="Later month" ${allMonths.indexOf(month) <= 0 ? "disabled" : ""}>›</button>
      </div>`;

    const fixedList = fixedItems(month);
    const paidFromName = (id) => { const a = id ? state.accounts.find((x) => x.id === id) : null; return a ? accountName(a) : ""; };
    const fixedCard = `
      <div class="card stack">
        <div class="spread"><div class="label">Fixed payments · ${Calc.monthLabel(month, true)}</div><a class="label link" href="#fixed">Manage ›</a></div>
        ${fixedList.length ? `<ul class="plain-list loan-list">${fixedList.map((p) => {
          const f = shareOf(p);
          const by = p.kind === "loan" ? paidFromName(norm(p.account.linked_account)) : paidFromName(p.paid_from);
          return `<li>
            <div><div>${esc(p.name)}</div><div class="muted small">${p.kind === "loan" ? "loan payment" : esc(p.owner || JOINT)}${p.day ? ` · day ${esc(p.day)}` : ""}${by ? ` · from ${by}` : ""}${f === 0.5 ? " · your 50%" : f === 0 ? " · not yours" : ""}</div></div>
            <div class="acct-right"><div class="mono">${esc(fmtMoney(p.amount, p.currency))}</div>
              ${f === 0.5 ? `<div class="acct-orig mono">${esc(fmtMoney(p.amount / 2, p.currency))}</div>` : ""}</div>
          </li>`;
        }).join("")}</ul>
        <div class="spread commit"><span>My fixed payments</span><span class="mono">${esc(fmtMoney(myFixedM || 0, cur))}</span></div>`
        : `<p class="muted">No fixed payments for this month. Add rent, parking and similar under Manage.</p>`}
      </div>`;

    const cardItems = cards.filter((a) => isActive(a) || yearMonths.some((m) => cardValue(a, m, false) != null))
      .sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname))).map((a) => {
        const own = norm(a.currency).toUpperCase() || "ILS";
        const vals = yearMonths.map((m) => cardValue(a, m, false));
        const v = cardValue(a, month, false);
        const cAvg = avgOf(vals);
        const linked = norm(a.linked_account) ? state.accounts.find((x) => x.id === norm(a.linked_account)) : null;
        return `
          <div class="card stack">
            <div class="spread">
              <div><h3>${accountName(a)}</h3><div class="muted small">${esc(a.owner)} · paid from ${linked ? accountName(linked) : "—"}</div></div>
              <div class="acct-right">
                <div class="acct-amount mono">${v != null ? esc(fmtMoney(v, own)) : "—"}</div>
                ${v != null && own !== cur ? `<div class="acct-orig mono">≈ ${esc(fmtMoney(conv(v, own, month), cur))}</div>` : ""}
              </div>
            </div>
            <div class="muted small mono">${Calc.monthLabel(month, true)}${cAvg != null ? ` · average ${esc(fmtMoney(cAvg, own))} / month in ${year}` : ""}</div>
            ${shareOf(a) === 0.5 && v != null ? `<div class="muted small">Joint · your 50%: <span class="mono">${esc(fmtMoney(v / 2, own))}</span></div>` : ""}
            ${Charts.bars({ labels, values: vals, avg: cAvg, highlight: yearMonths.indexOf(month), fmtTick: fmtTickFor(own),
              tips: yearMonths.map((m, i) => `${Calc.monthLabel(m, true)} · ${vals[i] != null ? fmtMoney(vals[i], own) : "no total"}`), ariaLabel: `${norm(a.nickname)} by month` })}
          </div>`;
      }).join("");

    const SPEND_COLORS = { cards: Charts.TYPE_COLORS.current, fixed: Charts.TYPE_COLORS.savings };
    // Detail view: one series per card and per fixed/loan payment, at your share. Stable order
    // (cards, then fixed payments, then loans, each by name) so an item keeps its colour.
    const detail = LS.get("fd.spendDetail") === "1";
    let chartSeries, legendHtml, chartTips;
    if (detail) {
      const items = [];
      cards.filter((a) => shareOf(a) > 0).sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname))).forEach((a) => items.push({
        name: norm(a.nickname) || a.id, values: yearMonths.map((m) => { const v = cardValue(a, m, true); return v == null ? null : v * shareOf(a); }),
      }));
      Calc.fixedSeries(plainFixed()).filter((sr) => shareOf(sr.head) > 0).forEach((sr) => items.push({
        name: norm(sr.head.name) || sr.id,
        values: yearMonths.map((m) => { const p = Calc.fixedForMonth(plainFixed(), m).find((x) => x.id === sr.id); const v = p ? conv(p.amount, p.currency, m) : null; return v == null ? null : v * shareOf(sr.head); }),
      }));
      const loanIds = [...new Set(yearMonths.flatMap((m) => loanPaymentsFor(m, idx).map((p) => p.id)))];
      loanIds.map((id) => state.accounts.find((a) => a.id === id)).filter((a) => a && shareOf(a) > 0)
        .sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname))).forEach((a) => items.push({
          name: norm(a.nickname) || a.id,
          values: yearMonths.map((m) => { const p = loanPaymentsFor(m, idx).find((x) => x.id === a.id); const v = p ? conv(p.amount, p.currency, m) : null; return v == null ? null : v * shareOf(a); }),
        }));
      // At most 8 colours: the smallest items (by year total) fold into "Other".
      const yearSum = (it) => it.values.reduce((sm, v) => sm + (v || 0), 0);
      let shown = items.filter((it) => yearSum(it) > 0);
      if (shown.length > Charts.SERIES_COLORS.length) {
        const keep = new Set([...shown].sort((x, y) => yearSum(y) - yearSum(x)).slice(0, Charts.SERIES_COLORS.length - 1));
        const rest = shown.filter((it) => !keep.has(it));
        shown = shown.filter((it) => keep.has(it));
        shown.push({ name: "Other", values: yearMonths.map((_, i) => { const v = rest.reduce((sm, it) => sm + (it.values[i] || 0), 0); return v || null; }) });
      }
      chartSeries = shown.map((it, k) => ({ key: it.name, color: Charts.SERIES_COLORS[k], values: it.values }));
      legendHtml = shown.map((it, k) => `<span class="key"><i style="background:${Charts.SERIES_COLORS[k]}"></i>${esc(it.name)}</span>`).join("");
      chartTips = yearMonths.map((m, i) => {
        const parts = shown.filter((it) => it.values[i]).map((it) => `${it.name} ${fmtMoney(it.values[i], cur)}`);
        return `${Calc.monthLabel(m, true)} · ${totals[i] != null ? fmtMoney(totals[i], cur) : "nothing recorded"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
      });
    } else {
      chartSeries = [{ key: "cards", color: SPEND_COLORS.cards, values: cardSeries }, { key: "fixed", color: SPEND_COLORS.fixed, values: fixedSeriesV }];
      legendHtml = `<span class="key"><i style="background:${SPEND_COLORS.cards}"></i>Cards</span><span class="key"><i style="background:${SPEND_COLORS.fixed}"></i>Fixed payments</span>`;
      chartTips = yearMonths.map((m, i) => `${Calc.monthLabel(m, true)} · ${totals[i] != null ? `${fmtMoney(totals[i], cur)} (cards ${fmtMoney(cardSeries[i] || 0, cur)}, fixed ${fmtMoney(fixedSeriesV[i] || 0, cur)})` : "nothing recorded"}`);
    }
    $screen.innerHTML = `${head}
      <div class="stack-lg">
        ${sel}
        <div class="card hero stack">
          <div class="label">My spending · ${Calc.monthLabel(month, true)}</div>
          <div class="big-number">${esc(fmtMoney(total, cur))}</div>
          <div class="muted small mono">Cards ${esc(fmtMoney(myCardsM || 0, cur))} · Fixed ${esc(fmtMoney(myFixedM || 0, cur))}</div>
          <div class="muted small">Your own in full + 50% of joint${avg != null ? ` · average ${esc(fmtMoney(avg, cur))} / month in ${year}` : ""}</div>
          ${household != null && household !== total ? `<div class="muted small">Household, full amounts: <span class="mono">${esc(fmtMoney(household, cur))}</span></div>` : ""}
          ${missing.length ? `<div class="muted small">Card totals missing this month: ${missing.map(accountName).join(", ")}</div>` : ""}
          <div class="seg seg-sm" id="sp-view" style="align-self:flex-start">
            <button type="button" data-view="0" aria-pressed="${!detail}">SUMMARY</button>
            <button type="button" data-view="1" aria-pressed="${detail}">DETAIL</button>
          </div>
          ${Charts.stacked({
            labels, fmtTick: fmtTickFor(cur), series: chartSeries, tips: chartTips, highlight: yearMonths.indexOf(month),
            ariaLabel: detail ? "My spending by card and payment" : "My spending by month",
          })}
          <div class="legend">${legendHtml}</div>
        </div>
        ${fixedCard}
        ${cards.length ? `
        <div class="card stack">
          <div class="label">Cards by owner · ${Calc.monthLabel(month, true)}</div>
          ${byOwner.map((o) => `
            <div class="stack" style="gap:6px">
              <div class="spread"><span>${esc(o.name)}</span><span class="mono">${esc(fmtMoney(o.sum, cur))}</span></div>
              <div class="bar"><span style="width:${cardsHousehold ? Math.max(o.sum > 0 ? 2 : 0, (o.sum / cardsHousehold) * 100).toFixed(1) : 0}%"></span></div>
            </div>`).join("")}
        </div>
        <div>
          <div class="group-title"><span class="label">Each card</span></div>
          <div class="stack">${cardItems}</div>
        </div>` : ""}
        <p class="muted small">Spending never changes reachable money or the long-term total; that money already shows up when it leaves your bank accounts.</p>
      </div>`;
    Charts.bind($screen);
    bindCurSeg();
    const go = (m) => { state.cardMonth = m; const y = window.scrollY; renderCards(); window.scrollTo(0, y); };
    document.getElementById("sp-view").addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]");
      if (!b) return;
      LS.set("fd.spendDetail", b.dataset.view);
      const y = window.scrollY; renderCards(); window.scrollTo(0, y);
    });
    document.getElementById("cd-month").addEventListener("change", (e) => go(e.target.value));
    document.getElementById("cd-prev").addEventListener("click", () => go(allMonths[allMonths.indexOf(month) + 1]));
    document.getElementById("cd-next").addEventListener("click", () => go(allMonths[allMonths.indexOf(month) - 1]));
  }

  // ---------- Fixed payments: list and editor ----------

  async function loadFixed() {
    state.fixed = (await Sheets.readTab("Fixed")).rows;
  }

  function renderFixed() {
    const nowM = Calc.currentMonth();
    const series = Calc.fixedSeries(plainFixed());
    const current = series.filter((s) => !s.stop || s.stop >= nowM);
    const ended = series.filter((s) => s.stop && s.stop < nowM);
    const item = (s) => {
      const inForce = s.versions.filter((v) => v.from <= nowM).pop() || s.versions[0];
      const next = s.versions.find((v) => v.from > nowM);
      const h = s.head;
      const amt = Calc.parseAmount(inForce.row.amount);
      const c = (norm(inForce.row.currency) || norm(h.currency)).toUpperCase() || "ILS";
      const from = h.paid_from ? state.accounts.find((a) => a.id === norm(h.paid_from)) : null;
      return `
        <button class="goal" data-fixed="${esc(s.id)}">
          <div class="spread"><strong>${esc(h.name || s.id)}</strong><span class="mono">${esc(fmtMoney(amt, c, true))}</span></div>
          <div class="muted small">${esc(h.owner || JOINT)}${norm(h.day) ? ` · day ${esc(h.day)}` : ""}${from ? ` · from ${accountName(from)}` : ""}</div>
          <div class="muted small mono">since ${Calc.monthLabel(inForce.from, true)}${next ? ` · ${esc(fmtMoney(Calc.parseAmount(next.row.amount), c, true))} from ${Calc.monthLabel(next.from, true)}` : ""}${s.stop ? ` · ends after ${Calc.monthLabel(s.stop, true)}` : ""}</div>
        </button>`;
    };
    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">Spending</div><h1>Fixed payments</h1></div>
        <a class="btn small" href="#cards">Back</a>
      </div>
      <div class="stack-lg">
        <p class="muted">Payments that leave a bank account every month outside the cards, like rent or parking. Loan payments come from each loan's own "Monthly payment".</p>
        <button class="btn primary block" id="fx-add">+ New fixed payment</button>
        ${current.length ? `<div class="stack">${current.map(item).join("")}</div>` : `<div class="card empty"><p class="muted">No fixed payments yet.</p></div>`}
        ${ended.length ? `<details><summary class="group-title"><span class="label">Ended (${ended.length}) ▾</span></summary><div class="stack">${ended.map(item).join("")}</div></details>` : ""}
      </div>`;
    document.getElementById("fx-add").addEventListener("click", () => openFixedForm(null));
    $screen.querySelectorAll("[data-fixed]").forEach((b) => b.addEventListener("click", () => {
      const s = Calc.fixedSeries(plainFixed()).find((x) => x.id === b.dataset.fixed);
      if (s) openFixedForm(s);
    }));
  }

  function openFixedForm(series) {
    const isNew = !series;
    const h = series ? series.head : { owner: JOINT, currency: "ILS" };
    const names = [...personNames(), JOINT];
    const banks = state.accounts.filter((a) => isActive(a) && ["current", "savings"].includes(lower(a.type)));
    const nowM = Calc.currentMonth();
    const cur = norm(h.currency).toUpperCase() || "ILS";
    openSheet(`
      <form id="fx-form" class="stack-lg" novalidate>
        <div class="spread"><div><div class="label">${isNew ? "New fixed payment" : "Fixed payment"}</div><h2>${isNew ? "Add a payment" : esc(h.name)}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
        <div class="field"><label class="label" for="fx-name">Name</label><input id="fx-name" value="${esc(h.name)}" autocomplete="off" placeholder="Rent"></div>
        ${isNew ? `
        <div class="field-row">
          <div class="field"><label class="label" for="fx-amount">Amount per month</label><input id="fx-amount" type="text" inputmode="decimal" placeholder="1,000"></div>
          <div class="field"><label class="label" for="fx-cur">Currency</label><select id="fx-cur">${options(CURRENCIES, cur)}</select></div>
        </div>
        <div class="field"><label class="label" for="fx-from">Starting month</label><input id="fx-from" type="month" value="${nowM}"></div>` : ""}
        <div class="field-row">
          <div class="field"><label class="label" for="fx-owner">Owner</label><select id="fx-owner">${options(names, matchName(h.owner, names) || JOINT)}</select></div>
          <div class="field"><label class="label" for="fx-day">Day of month</label><input id="fx-day" type="number" inputmode="numeric" min="1" max="31" value="${esc(h.day)}" placeholder="1–31"></div>
        </div>
        <div class="field"><label class="label" for="fx-paid">Paid from</label>
          <select id="fx-paid">${options(banks.map((a) => [a.id, `${norm(a.nickname) || a.id}`]), norm(h.paid_from), "Not set")}</select></div>
        <p class="err-text" id="fx-err"></p>
        <button class="btn primary block" type="submit">${isNew ? "Add payment" : "Save details"}</button>
        ${isNew ? "" : `
        <div class="card stack">
          <div class="label">Change the amount</div>
          <p class="muted small">Enter the new amount and the first month it applies. Earlier months keep the old amount.</p>
          <div class="field-row">
            <div class="field"><label class="label" for="fx-new-amount">New amount (${esc(cur)})</label><input id="fx-new-amount" type="text" inputmode="decimal" placeholder="1,020"></div>
            <div class="field"><label class="label" for="fx-new-from">From month</label><input id="fx-new-from" type="month" value="${Calc.shiftMonth(nowM, 1)}"></div>
          </div>
          <button class="btn block" type="button" id="fx-change">Save new amount</button>
          <div class="label" style="margin-top:6px">History</div>
          <ul class="plain-list">${series.versions.slice().reverse().map((v) => `
            <li><span class="mono">From ${Calc.monthLabel(v.from, true)}</span>
              <span class="row"><span class="mono">${esc(fmtMoney(Calc.parseAmount(v.row.amount), cur, true))}</span>
              ${series.versions.length > 1 ? `<button type="button" class="btn small danger" data-fx-del="${esc(v.from)}">Delete</button>` : ""}</span></li>`).join("")}</ul>
        </div>
        <div class="card stack">
          <div class="label">${series.stop ? `Ends after ${Calc.monthLabel(series.stop, true)}` : "End this payment"}</div>
          ${series.stop ? `<button class="btn block" type="button" id="fx-resume">Keep paying (remove the end)</button>` : `
          <div class="field"><label class="label" for="fx-stop">Last month it is paid</label><input id="fx-stop" type="month" value="${nowM}"></div>
          <button class="btn danger block" type="button" id="fx-end">End payment</button>`}
        </div>`}
      </form>`);

    const $err = () => document.getElementById("fx-err");
    const v = (id) => norm(document.getElementById(id).value);
    const run = async (btn, label, fn, done) => {
      setBusy(btn, true, label);
      try {
        await guarded(async () => { await fn(); await loadFixed(); });
        closeSheet();
        toast(done);
        route();
      } catch (ex) {
        $err().textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    };
    // Fresh copy of this payment's rows, so writes hit the right rows.
    const freshSeries = async () => {
      await loadFixed();
      const s = Calc.fixedSeries(state.fixed).find((x) => x.id === series.id);
      if (!s) throw new Error("This payment changed in the sheet meanwhile. Please look again.");
      return s;
    };

    document.getElementById("fx-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = v("fx-name");
      const day = v("fx-day");
      if (!name) { $err().textContent = "Give it a name."; return; }
      if (day && !(Number.isInteger(Number(day)) && Number(day) >= 1 && Number(day) <= 31)) { $err().textContent = "Day must be 1–31."; return; }
      const details = { name, owner: v("fx-owner"), paid_from: v("fx-paid"), day: day ? Number(day) : "" };
      const btn = e.target.querySelector('[type="submit"]');
      if (isNew) {
        const amount = Calc.parseAmount(v("fx-amount"));
        const from = Calc.normMonth(v("fx-from"));
        if (!isFinite(amount) || amount <= 0) { $err().textContent = "Enter the monthly amount."; return; }
        if (!from) { $err().textContent = "Choose the starting month."; return; }
        run(btn, "Saving…", () => Sheets.appendRows("Fixed", [{
          id: `f-${Date.now().toString(36)}`, ...details, amount, currency: v("fx-cur"), from_month: from, to_month: "", notes: "",
        }]), "Fixed payment added");
      } else {
        run(btn, "Saving…", async () => {
          const s = await freshSeries();
          const cells = [];
          s.versions.forEach((ver) => Object.entries(details).forEach(([field, value]) => cells.push({ row: ver.row._row, field, value })));
          await Sheets.setCells("Fixed", (await Sheets.readTab("Fixed")).header, cells, "RAW");
        }, "Saved");
      }
    });
    if (isNew) return;

    document.getElementById("fx-change").addEventListener("click", (e) => {
      const amount = Calc.parseAmount(v("fx-new-amount"));
      const from = Calc.normMonth(v("fx-new-from"));
      if (!isFinite(amount) || amount <= 0) { $err().textContent = "Enter the new amount."; return; }
      if (!from) { $err().textContent = "Choose the month the new amount starts."; return; }
      run(e.target, "Saving…", async () => {
        const s = await freshSeries();
        const same = s.versions.find((ver) => ver.from === from);
        const header = (await Sheets.readTab("Fixed")).header;
        if (same) {
          await Sheets.setCells("Fixed", header, [{ row: same.row._row, field: "amount", value: amount }], "RAW");
        } else {
          const hd = s.head;
          await Sheets.appendRows("Fixed", [{
            id: s.id, name: hd.name, amount, currency: norm(hd.currency).toUpperCase() || "ILS", owner: hd.owner,
            paid_from: hd.paid_from, day: hd.day, from_month: from, to_month: "", notes: "",
          }]);
        }
      }, `New amount from ${Calc.monthLabel(from, true)}`);
    });
    $sheetBody.querySelectorAll("[data-fx-del]").forEach((b) => b.addEventListener("click", () => {
      const from = b.dataset.fxDel;
      if (!confirm(`Delete the amount that starts in ${Calc.monthLabel(from, true)}?`)) return;
      run(b, "…", async () => {
        const s = await freshSeries();
        const ver = s.versions.find((x) => x.from === from);
        if (!ver || s.versions.length < 2) throw new Error("That amount changed in the sheet meanwhile. Please look again.");
        await Sheets.deleteRows("Fixed", [ver.row._row]);
      }, "Amount removed");
    }));
    const end = document.getElementById("fx-end");
    if (end) end.addEventListener("click", () => {
      const stop = Calc.normMonth(v("fx-stop"));
      if (!stop) { $err().textContent = "Choose the last month it is paid."; return; }
      run(end, "Saving…", async () => {
        const s = await freshSeries();
        await Sheets.setCells("Fixed", (await Sheets.readTab("Fixed")).header, [{ row: s.versions[s.versions.length - 1].row._row, field: "to_month", value: stop }], "RAW");
      }, `Ends after ${Calc.monthLabel(stop, true)}`);
    });
    const resume = document.getElementById("fx-resume");
    if (resume) resume.addEventListener("click", () => run(resume, "Saving…", async () => {
      const s = await freshSeries();
      const header = (await Sheets.readTab("Fixed")).header;
      await Sheets.setCells("Fixed", header, s.versions.map((ver) => ({ row: ver.row._row, field: "to_month", value: "" })), "RAW");
    }, "Payment continues"));
  }

  // ---------- Trends ----------

  const PERIODS = { year: "This year", "12m": "12 months", all: "All" };
  const STACK_TYPES = ["current", "savings", "investment", "crypto", "long_term", "home"];

  function renderTrends() {
    const cur = state.displayCur;
    const period = PERIODS[state.trendPeriod] ? state.trendPeriod : "year";
    const idx = Calc.indexSnapshots(state.snapshots);
    const months = Calc.snapshotMonths(state.snapshots, state.accounts);
    const nowM = Calc.currentMonth();
    const latestBal = months.balances[0] || null;
    const firstBal = months.balances[months.balances.length - 1] || null;
    const end = latestBal && latestBal > nowM ? latestBal : nowM;
    const start = period === "year" ? `${nowM.slice(0, 4)}-01` : period === "12m" ? Calc.shiftMonth(end, -11) : (firstBal || nowM);
    const range = Calc.monthRange(start, end);
    const T = range.map((m) => Calc.monthTotals(state.accounts, idx, m, cur, state.rates, latestBal));
    const labels = range.map((m) => (period === "year" ? MONTHS[Number(m.slice(5)) - 1] : Calc.monthLabel(m)));
    const inc = T.map((t) => t.hasBalances && t.incomplete);
    const series = (field) => T.map((t) => (t.hasBalances ? t[field] : null));
    const tips = (field) => T.map((t, i) => `${Calc.monthLabel(range[i], true)} · ${t.hasBalances ? fmtMoney(t[field], cur) + (inc[i] ? " · incomplete" : "") : "no balances"}`);
    const fmtTick = fmtTickFor(cur);
    const any = T.some((t) => t.hasBalances);

    const legend = STACK_TYPES.map((ty) => `<span class="key"><i style="background:${Charts.TYPE_COLORS[ty]}"></i>${TYPE_LABEL[ty]}</span>`).join("")
      + `<span class="key"><i style="background:${Charts.TYPE_COLORS.loan}"></i>Loans (below 0)</span>`;

    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">History</div><h1>Trends</h1></div>
      </div>
      <div class="cur-row">${curSegHtml()}</div>
      <div class="stack-lg">
        <div class="seg" id="tr-period">${Object.entries(PERIODS).map(([k, l]) =>
          `<button type="button" data-period="${k}" aria-pressed="${k === period}">${l.toUpperCase()}</button>`).join("")}</div>
        ${!any ? `<div class="card empty stack"><p class="muted">No balances in this period yet.</p><a class="btn block" href="#update">Update</a></div>` : `
        <div class="card stack">
          <div class="label">Reachable money</div>
          ${Charts.line({ labels, values: series("reachable"), incomplete: inc, tips: tips("reachable"), fmtTick, ariaLabel: "Reachable money by month" })}
        </div>
        <div class="card stack">
          <div class="label">Long-term total</div>
          ${Charts.line({ labels, values: series("longTerm"), incomplete: inc, tips: tips("longTerm"), fmtTick, ariaLabel: "Long-term total by month" })}
        </div>
        <div class="card stack">
          <div class="label">By type</div>
          ${Charts.stacked({
            labels, fmtTick, incomplete: inc,
            series: STACK_TYPES.map((ty) => ({ key: ty, color: Charts.TYPE_COLORS[ty], values: T.map((t) => (t.hasBalances ? t.byType[ty] : null)) })),
            negative: { color: Charts.TYPE_COLORS.loan, values: T.map((t) => (t.hasBalances ? t.byType.loan : null)) },
            tips: T.map((t, i) => !t.hasBalances ? `${Calc.monthLabel(range[i], true)} · no balances`
              : `${Calc.monthLabel(range[i], true)} · ${STACK_TYPES.filter((ty) => t.byType[ty]).map((ty) => `${TYPE_LABEL[ty]} ${fmtTick(t.byType[ty])}`).join(" · ")}${t.byType.loan ? ` · Loans −${fmtTick(t.byType.loan)}` : ""}${inc[i] ? " · incomplete" : ""}`),
            ariaLabel: "Totals by account type",
          })}
          <div class="legend">${legend}</div>
        </div>
        <p class="muted small">Tap a month to see its values. Hollow dots and dashed lines mark incomplete months (some balances missing); a break in a line is a month with no balances. Each month is converted with its own exchange rate.</p>`}
      </div>`;
    Charts.bind($screen);
    bindCurSeg();
    document.getElementById("tr-period").addEventListener("click", (e) => {
      const b = e.target.closest("[data-period]");
      if (!b) return;
      state.trendPeriod = b.dataset.period;
      renderTrends();
    });
  }

  // ---------- money formatting ----------

  const MASK = "•••••";
  function fmtMoney(v, cur, decimals) {
    if (v == null || !isFinite(v)) return "—";
    if (state.hideAmounts) return MASK;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency", currency: cur, minimumFractionDigits: 0, maximumFractionDigits: decimals ? 2 : 0,
      }).format(v).replace(/^-/, "−");
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
    // Personal view: own accounts in full, joint at 50%, the partner's own accounts left out.
    const totalsFor = (m, rateMonth) => Calc.monthTotals(state.accounts, idx, m, cur, state.rates, latestBal, rateMonth, myShare);

    const due = dueItems();
    const head = `
      <div class="page-head">
        <div><div class="label">Hi, ${esc(state.me.name)}</div><h1>Overview</h1></div>
        <a class="btn primary small badge-host" href="#update">Update${due.length ? `<span class="badge" aria-label="${due.length} due">${due.length}</span>` : ""}</a>
      </div>`;
    const goals = (state.goals || []).filter(goalsActive);
    const goalsSection = goals.length ? `
      <div><div class="group-title"><span class="label">Goals</span><a class="label link" href="#goals">Manage ›</a></div>
        <div class="stack">${goals.map((g) => goalCardHtml(g, true)).join("")}</div></div>` : "";
    const curSeg = `<div class="seg seg-sm" id="ov-cur">${CURRENCIES.map((c) =>
      `<button type="button" data-cur="${c}" aria-pressed="${c === cur}">${c}</button>`).join("")}</div>`;

    if (!month) {
      $screen.innerHTML = `${head}
        <div class="stack-lg">
          ${dueCardHtml(due)}
          <div class="card hero stack">
            <div class="label">Reachable money</div>
            <div class="big-number muted">—</div>
            <p class="muted">No balances yet. Tap <strong>Update</strong> to paste or type this month's balances.</p>
            <a class="btn primary block" href="#update">Add balances</a>
          </div>
        </div>`;
      bindDue(due);
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
    const prevT = totalsFor(prevM, month); // converted at this month's rate: changes exclude currency moves
    const yearFirst = months.balances.filter((m) => m.slice(0, 4) === month.slice(0, 4) && m < month).sort()[0] || null;
    const firstT = yearFirst ? totalsFor(yearFirst, month) : null;

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
        <div class="spread"><div class="label">My reachable money · ${Calc.monthLabel(month, true)}</div>${incompleteChip}</div>
        <div class="big-number">${fmtMoney(t.reachable, cur)}</div>
        <div class="muted small">Your accounts in full + 50% of joint accounts</div>
        ${changes("reachable")}
      </div>
      <div class="card stack">
        <div class="label">My long-term total</div>
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

    // Long-term view: each long-term type with total, share of assets and change vs the previous month.
    const LT_TYPES = ["savings", "investment", "crypto", "long_term", "home"];
    const typeCards = t.hasBalances ? LT_TYPES.filter((ty) => t.counts[ty]).map((ty) => {
      const v = t.byType[ty];
      const share = t.assets > 0 ? (v / t.assets) * 100 : 0;
      const c = prevT.hasBalances && prevT.counts[ty] ? Calc.change(v, prevT.byType[ty]) : null;
      return `
        <div class="type-card">
          <div class="spread"><span class="label">${TYPE_LABEL[ty]}</span><span class="label">${t.counts[ty]}</span></div>
          <div class="type-value mono">${fmtMoney(v, cur)}</div>
          <div class="bar"><span style="width:${Math.max(2, Math.min(100, share)).toFixed(1)}%"></span></div>
          <div class="muted small mono">${share.toFixed(1)}% of assets</div>
          <div class="small mono ${c ? toneOf(c.amount) : "muted"}">${c ? `${fmtSigned(c.amount, cur)} ${fmtPct(c.pct)}` : `no ${Calc.monthLabel(prevM)} data`}</div>
        </div>`;
    }).join("") : "";
    const cardsCard = t.cardCount ? `
      <a class="type-card" href="#cards">
        <div class="spread"><span class="label">Cards</span><span class="label">${t.cardCount}</span></div>
        <div class="type-value mono">${fmtMoney(t.cards, cur)}</div>
        <div class="muted small">spending · not in totals ›</div>
      </a>` : "";

    // Loans: remaining balance and monthly payment, plus the sum of payments across active loans.
    const loans = state.accounts.filter((a) => lower(a.type) === "loan" && isActive(a) && myShare(a) > 0);
    let commitments = 0, commitmentsKnown = true;
    const loanRows = loans.map((a) => {
      const own = norm(a.currency).toUpperCase() || "ILS";
      const b = Calc.balanceFor(a, month, idx);
      const last = b ? { month, snap: b.snap } : Calc.latestSnapshot(idx, a.id);
      const f = myShare(a);
      const remaining = last ? Calc.parseAmount(last.snap.amount) * f : null;
      const p0 = loanPayment(a, Calc.currentMonth(), idx);
      const pay = p0 != null ? p0 * f : null;
      const orig = Calc.parseAmount(a.original_amount);
      const paidOff = last && isFinite(orig) && orig > 0 ? Math.max(0, Math.min(100, (1 - Calc.parseAmount(last.snap.amount) / orig) * 100)) : null;
      if (pay != null && isFinite(pay)) {
        const pc = Calc.convert(pay, own, cur, state.rates, Calc.currentMonth());
        if (pc == null) commitmentsKnown = false; else commitments += pc;
      }
      return `
        <li>
          <div><div>${accountName(a)}</div><div class="muted small">${remaining != null ? `owed ${last.month !== month ? `(${Calc.monthLabel(last.month)})` : ""}` : "no balance yet"}${f === 0.5 ? " · your 50%" : ""}${paidOff != null ? ` · ${paidOff.toFixed(0)}% paid off` : ""}</div></div>
          <div class="acct-right">
            <div class="mono neg">${remaining != null && isFinite(remaining) ? "−" + esc(fmtMoney(remaining, own)) : "—"}</div>
            <div class="acct-orig mono">${pay != null && isFinite(pay) ? `${esc(fmtMoney(pay, own))} / month` : "no payment set"}</div>
          </div>
        </li>`;
    }).join("");
    // Other fixed payments (rent, parking…) in force this month, at your share.
    const nowM = Calc.currentMonth();
    let fixedSum = 0;
    const fixedNow = Calc.fixedForMonth(plainFixed(), nowM).filter((p) => myShare(p) > 0);
    fixedNow.forEach((p) => {
      const v = Calc.convert(p.amount * myShare(p), p.currency, cur, state.rates, nowM);
      if (v == null) commitmentsKnown = false; else fixedSum += v;
    });
    const loansCard = loans.length || fixedNow.length ? `
      <div class="card stack">
        <div class="spread"><div class="label">${loans.length ? "Loans & fixed payments" : "Fixed payments"}</div><a class="label link" href="#fixed">Manage ›</a></div>
        ${loans.length ? `<ul class="plain-list loan-list">${loanRows}</ul>` : ""}
        ${fixedNow.length ? `<div class="spread small"><span class="muted">${fixedNow.map((p) => esc(p.name)).join(", ")}</span><span class="mono">${esc(fmtMoney(fixedSum, cur))}</span></div>` : ""}
        <div class="spread commit"><span>Fixed monthly commitments</span><span class="mono">${commitmentsKnown ? esc(fmtMoney(commitments + fixedSum, cur)) : "—"}</span></div>
      </div>` : "";

    $screen.innerHTML = `${head}
      <div class="stack-lg">
        ${dueCardHtml(due)}
        <div class="row ov-controls">${sel}${curSeg}</div>
        ${state.ratesPending ? `<p class="muted small">Fetching exchange rates…</p>` : ""}
        ${rateNoticesHtml(months.all)}
        ${hero}
        ${missing}
        ${typeCards || cardsCard ? `<div><div class="group-title"><span class="label">Long-term view</span><span class="label">vs ${Calc.monthLabel(prevM)}</span></div><div class="type-grid">${typeCards}${cardsCard}</div></div>` : ""}
        ${loansCard}
        ${goalsSection}
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
    bindDue(due);
    $screen.querySelectorAll("[data-goal]").forEach((b) => b.addEventListener("click", () => { location.hash = "goals"; }));
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
        <a class="card stack link-card" href="#goals">
          <div class="spread"><div class="label">Goals</div><span class="chev">›</span></div>
          <p class="muted small">${(state.goals || []).filter(goalsActive).length} active goal${(state.goals || []).filter(goalsActive).length === 1 ? "" : "s"}. Add, edit or deactivate goals.</p>
        </a>
        <div class="card stack">
          <div class="label">Privacy</div>
          <div class="spread"><span>Hide amounts</span>
            <button type="button" class="btn small" id="set-hide">${state.hideAmounts ? "Show amounts" : "Hide amounts"}</button></div>
          <p class="muted small">Replaces every amount with dots on this device, including charts. The eye button at the top of each screen does the same.</p>
        </div>
        <div id="lock-settings"></div>
        ${peopleFormHtml()}
        <div class="card stack">
          <div class="label">Sheet</div>
          <h3>${esc(state.sheetTitle || "Connected sheet")}</h3>
          <a class="btn block" href="${esc(sheetUrl)}" target="_blank" rel="noopener">Open in Google Sheets</a>
          <button class="btn ghost block" id="set-forget">Use a different sheet</button>
        </div>
        <button class="btn danger block" id="set-signout">Sign out</button>
        <p class="muted small mono" style="text-align:center">App version ${APP_VERSION}</p>
      </div>`;
    bindPeopleForm(false);
    document.getElementById("set-hide").addEventListener("click", () => setHideAmounts(!state.hideAmounts));
    lockSettingsHtml().then((html) => {
      const host = document.getElementById("lock-settings");
      if (!host) return;
      host.innerHTML = html;
      bindLockSettings();
    });
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

  // Latest balance of an account with its change from the previous calendar month.
  function latestInfo(a, idx) {
    const last = Calc.latestSnapshot(idx, a.id);
    if (!last) return null;
    const own = norm(last.snap.currency).toUpperCase() || norm(a.currency).toUpperCase();
    const amount = Calc.parseAmount(last.snap.amount);
    const prevSnap = idx.get(norm(a.id), Calc.shiftMonth(last.month, -1));
    const prev = prevSnap ? Calc.parseAmount(prevSnap.amount) : null;
    return {
      month: last.month, snap: last.snap, own, amount,
      converted: isFinite(amount) ? Calc.convert(amount, own, state.displayCur, state.rates, last.month) : null,
      delta: prev != null && isFinite(prev) && isFinite(amount) ? Calc.change(amount, prev) : null,
      asOf: Calc.normDate(last.snap.as_of_date),
    };
  }

  function shortDate(d) {
    if (!d) return "";
    const [, m, day] = d.split("-").map(Number);
    return `${day} ${MONTHS[m - 1]}`;
  }

  function acctCard(a, idx) {
    const type = lower(a.type);
    const info = idx ? latestInfo(a, idx) : null;
    const cur = state.displayCur;
    const bits = [TYPE_LABEL[type] || type, norm(a.owner)];
    if (info) bits.push(type === "card" ? `${Calc.monthLabel(info.month)} total` : `upd ${shortDate(info.asOf) || Calc.monthLabel(info.month)}`);
    else bits.push("no balance yet");
    let right = "";
    if (info && isFinite(info.amount)) {
      const main = info.converted != null ? fmtMoney(info.converted, cur) : fmtMoney(info.amount, info.own);
      right = `
        <div class="acct-right">
          <div class="acct-amount mono ${type === "loan" ? "neg" : ""}">${type === "loan" ? "−" : ""}${esc(main)}</div>
          ${info.own !== cur ? `<div class="acct-orig mono">${esc(fmtMoney(info.amount, info.own))}</div>` : ""}
          ${info.delta ? `<div class="acct-chg mono ${toneOf(type === "loan" ? -info.delta.amount : info.delta.amount)}">${fmtSigned(info.delta.amount, info.own)}</div>` : ""}
        </div>`;
    }
    return `
      <button class="acct ${isActive(a) ? "" : "inactive"}" data-acct="${esc(a.id)}">
        <div class="dot">${esc(norm(a.currency).toUpperCase() || "—")}</div>
        <div class="body">
          <div class="name">${esc(a.nickname || a.id)}</div>
          <div class="meta">${bits.filter(Boolean).map(esc).join(" · ")}</div>
        </div>
        ${right || `<span class="chev">›</span>`}
      </button>`;
  }

  // Net of the latest balances (assets minus loans), cards left out.
  function groupNet(list, idx) {
    let net = 0, any = false;
    list.forEach((a) => {
      const type = lower(a.type);
      if (type === "card") return;
      const info = latestInfo(a, idx);
      if (!info || info.converted == null) return;
      any = true;
      net += type === "loan" ? -info.converted : info.converted;
    });
    return any ? net : null;
  }

  function curSegHtml() {
    return `<div class="seg seg-sm" data-cur-seg>${CURRENCIES.map((c) =>
      `<button type="button" data-cur="${c}" aria-pressed="${c === state.displayCur}">${c}</button>`).join("")}</div>`;
  }
  function bindCurSeg() {
    const seg = $screen.querySelector("[data-cur-seg]");
    if (!seg) return;
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cur]");
      if (!b || b.dataset.cur === state.displayCur) return;
      state.displayCur = b.dataset.cur;
      LS.set("fd.displayCurrency", state.displayCur);
      const y = window.scrollY;
      route();
      window.scrollTo(0, y);
    });
  }

  function fmtTickFor(cur) {
    return (v) => {
      if (state.hideAmounts) return "•••";
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }).format(v);
      } catch (_) { return String(Math.round(v)); }
    };
  }

  const GROUPINGS = { institution: "Bank", country: "Country", owner: "Owner" };

  function renderAccounts() {
    const idx = Calc.indexSnapshots(state.snapshots);
    const cur = state.displayCur;
    const grouping = GROUPINGS[LS.get("fd.acctGroup")] ? LS.get("fd.acctGroup") : "institution";
    const active = state.accounts.filter(isActive);
    const inactive = state.accounts.filter((a) => !isActive(a));
    let groups;
    if (grouping === "owner") {
      // Exactly three groups: the two people and Joint.
      const names = [...personNames(), JOINT];
      groups = names.map((n) => ({ name: n, list: [] }));
      active.forEach((a) => {
        const n = matchName(a.owner, names) || JOINT;
        groups.find((g) => g.name === n).list.push(a);
      });
    } else {
      const map = {};
      active.forEach((a) => {
        const k = norm(a[grouping]) || (grouping === "country" ? "No country" : "No institution");
        (map[k] = map[k] || []).push(a);
      });
      groups = Object.keys(map).sort((x, y) => x.localeCompare(y)).map((n) => ({ name: n, list: map[n] }));
    }
    const sortList = (list) => list.sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">${active.length} active</div><h1>Accounts</h1></div>
      </div>
      <div class="cur-row">${curSegHtml()}</div>
      <div class="stack">
        <div class="row">
          <button class="btn primary" id="acct-add" style="flex:1">+ Add</button>
          <button class="btn" id="acct-bulk" style="flex:1">Bulk add</button>
        </div>
        <div class="seg" id="acct-group">${Object.entries(GROUPINGS).map(([k, l]) =>
          `<button type="button" data-group="${k}" aria-pressed="${k === grouping}">${l.toUpperCase()}</button>`).join("")}</div>
      </div>
      ${!active.length ? `<div class="card empty stack" style="margin-top:16px"><p class="muted">No accounts yet. Add one, or paste many at once with Bulk add.</p></div>` : ""}
      ${active.length ? groups.map((g) => {
        const net = groupNet(g.list, idx);
        return `
        <div class="group-title">
          <span class="label">${esc(g.name)} · ${g.list.length}</span>
          <span class="label">${net != null ? `net ${esc(fmtMoney(net, cur))}` : ""}</span>
        </div>
        <div class="stack">${g.list.length ? sortList(g.list).map((a) => acctCard(a, idx)).join("")
          : `<p class="muted small" style="padding:0 4px">No accounts.</p>`}</div>`;
      }).join("") : ""}
      ${inactive.length ? `
        <details style="margin-top:28px">
          <summary class="group-title"><span class="label">Inactive (${inactive.length}) ▾</span></summary>
          <div class="stack">${inactive.map((a) => acctCard(a, idx)).join("")}</div>
        </details>` : ""}
      ${active.length ? `<p class="muted small" style="margin-top:16px">Latest balance of each account in ${cur}, converted with that month's rate. Group totals are net (loans subtracted) and leave out cards.</p>` : ""}`;
    document.getElementById("acct-add").addEventListener("click", () => openAccountForm(null));
    document.getElementById("acct-bulk").addEventListener("click", openBulk);
    document.getElementById("acct-group").addEventListener("click", (e) => {
      const b = e.target.closest("[data-group]");
      if (!b) return;
      LS.set("fd.acctGroup", b.dataset.group);
      renderAccounts();
    });
    bindCurSeg();
    $screen.querySelectorAll("[data-acct]").forEach((b) => b.addEventListener("click", () => {
      const a = state.accounts.find((x) => String(x.id) === b.dataset.acct);
      if (a) openAccountDetail(a);
    }));
  }

  // ---------- Account detail: history, chart, edit/delete snapshots ----------

  function openAccountDetail(a) {
    const idx = Calc.indexSnapshots(state.snapshots);
    const type = lower(a.type);
    const own = norm(a.currency).toUpperCase() || "ILS";
    const list = (idx.byAccount.get(norm(a.id)) || []).slice();
    const info = latestInfo(a, idx);
    let chart = "";
    if (list.length) {
      const months = Calc.monthRange(list[0].month, list[list.length - 1].month);
      const values = months.map((m) => { const s = idx.get(norm(a.id), m); const v = s ? Calc.parseAmount(s.amount) : null; return v != null && isFinite(v) ? v : null; });
      const tips = months.map((m, i) => `${Calc.monthLabel(m, true)} · ${values[i] != null ? fmtMoney(values[i], own, true) : "no balance"}`);
      const labels = months.map((m) => Calc.monthLabel(m));
      chart = type === "card"
        ? Charts.bars({ labels, values, tips, fmtTick: fmtTickFor(own), ariaLabel: "Monthly totals" })
        : Charts.line({ labels, values, tips, fmtTick: fmtTickFor(own), ariaLabel: "Balance history" });
    }
    const linked = type === "card" && norm(a.linked_account) ? state.accounts.find((x) => x.id === norm(a.linked_account)) : null;
    openSheet(`
      <div class="stack-lg">
        <div class="spread">
          <div><div class="label">${esc(TYPE_LABEL[type] || type)} · ${esc(a.institution)}</div><h2>${accountName(a)}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </div>
        <div class="card stack">
          <div class="label">${info ? (type === "card" ? `${Calc.monthLabel(info.month, true)} total` : `Latest · ${Calc.monthLabel(info.month, true)}`) : "No balance yet"}</div>
          <div class="mid-number ${type === "loan" ? "neg" : ""}">${info ? `${type === "loan" ? "−" : ""}${esc(fmtMoney(info.amount, own, true))}` : "—"}</div>
          ${info && own !== state.displayCur && info.converted != null ? `<div class="muted mono small">≈ ${esc(fmtMoney(info.converted, state.displayCur))}</div>` : ""}
          ${info && info.delta ? `<div class="mono small ${toneOf(type === "loan" ? -info.delta.amount : info.delta.amount)}">${fmtSigned(info.delta.amount, own)} ${fmtPct(info.delta.pct)} vs ${Calc.monthLabel(Calc.shiftMonth(info.month, -1))}</div>` : ""}
          ${type === "loan" ? loanSummaryHtml(a, idx, info, own) : ""}
          ${type === "card" ? `<div class="muted small">Paid from: ${linked ? accountName(linked) : "not set"}</div>` : ""}
          <div class="muted small">${esc(a.owner)} · updated by ${esc(a.updater)}${norm(a.update_day) !== "" ? ` · due day ${esc(a.update_day)}` : ""}${type === "home" && a.update_month ? ` of ${MONTHS[Number(a.update_month) - 1] || ""}` : ""}${isActive(a) ? "" : " · inactive"}</div>
        </div>
        ${chart ? `<div class="card tight">${chart}</div>` : ""}
        ${type === "loan" ? loanHistoryHtml(a, idx, own) : ""}
        <div class="row">
          <button class="btn primary" id="ad-add" style="flex:1">Add balance</button>
          <button class="btn" id="ad-edit" style="flex:1">Edit account</button>
        </div>
        <div>
          <div class="group-title"><span class="label">History</span><span class="label">${list.length}</span></div>
          ${list.length ? `<div class="stack">${list.slice().reverse().map(({ month, snap }) => `
            <div class="hist-row">
              <div class="spread">
                <span class="mono">${Calc.monthLabel(month, true)}</span>
                <span class="mono hist-amount">${esc(fmtMoney(Calc.parseAmount(snap.amount), norm(snap.currency).toUpperCase() || own, true))}</span>
              </div>
              <div class="spread">
                <span class="muted small">${esc(snap.as_of_date ? `as of ${Calc.normDate(snap.as_of_date) || snap.as_of_date}` : "")}${snap.source ? ` · ${esc(snap.source)}` : ""}${snap.entered_by ? ` · ${esc(snap.entered_by)}` : ""}</span>
                <span class="row">
                  <button class="btn small" data-snap-edit="${esc(month)}">Edit</button>
                  <button class="btn small danger" data-snap-del="${esc(month)}">Delete</button>
                </span>
              </div>
            </div>`).join("")}</div>` : `<p class="muted">No balances yet.</p>`}
        </div>
        <p class="err-text" id="ad-err"></p>
      </div>`);
    Charts.bind($sheetBody);
    if (type === "loan") bindLoanHistory(a, idx);
    document.getElementById("ad-edit").addEventListener("click", () => openAccountForm(a));
    document.getElementById("ad-add").addEventListener("click", () => {
      state.updateMode = "manual";
      state.manualDraft = { account_id: a.id, month: Calc.currentMonth(), as_of_date: Calc.today() };
      state.manualShowAll = true;
      closeSheet();
      if (currentRoute() === "update") route(); else location.hash = "update";
    });
    $sheetBody.querySelectorAll("[data-snap-edit]").forEach((b) => b.addEventListener("click", () => {
      openSnapshotEditor(a, idx.get(norm(a.id), b.dataset.snapEdit));
    }));
    $sheetBody.querySelectorAll("[data-snap-del]").forEach((b) => b.addEventListener("click", async () => {
      const month = b.dataset.snapDel;
      if (!confirm(`Delete the ${Calc.monthLabel(month, true)} balance of "${norm(a.nickname) || a.id}"? This removes the row from the sheet.`)) return;
      setBusy(b, true, "…");
      try {
        await guarded(() => deleteSnapshot(a, month, idx.get(norm(a.id), month)));
        toast("Balance deleted");
        openAccountDetail(a);
        refreshBehindSheet();
      } catch (e) {
        document.getElementById("ad-err").textContent = friendlyError(e);
        setBusy(b, false);
      }
    }));
  }

  // ---------- Loan: first payment month, paid off, payment history ----------

  function loanSummaryHtml(a, idx, info, own) {
    const nowPay = loanPayment(a, Calc.currentMonth(), idx);
    const orig = Calc.parseAmount(a.original_amount);
    const paid = info && isFinite(orig) && orig > 0 ? orig - info.amount : null;
    return `
      <div class="muted small">Monthly payment: <span class="mono">${nowPay != null ? esc(fmtMoney(nowPay, own)) : "not set"}</span>
        · payments from <span class="mono">${esc(Calc.monthLabel(loanStart(a, idx), true))}</span>${Calc.normMonth(a.loan_start) ? "" : " (set the first payment month in Edit account)"}</div>
      ${paid != null ? `<div class="stack" style="gap:6px">
        <div class="spread small"><span class="muted">Paid off ${esc(fmtMoney(Math.max(0, paid), own))} of ${esc(fmtMoney(orig, own))}</span>
          <span class="mono">${Math.max(0, Math.min(100, (paid / orig) * 100)).toFixed(0)}%</span></div>
        <div class="bar"><span style="width:${Math.max(0, Math.min(100, (paid / orig) * 100)).toFixed(1)}%"></span></div></div>` : ""}`;
  }

  function loanHistoryHtml(a, idx, own) {
    const sr = loanSeries(a.id);
    const versions = sr ? sr.versions.slice().reverse() : [];
    return `
      <div class="card stack">
        <div class="label">Payment history</div>
        ${versions.length ? `<ul class="plain-list">${versions.map((v, i) => `
          <li><span class="mono">${i === versions.length - 1 ? `From ${Calc.monthLabel(loanStart(a, idx), true)}` : `From ${Calc.monthLabel(v.from, true)}`}</span>
            <span class="row"><span class="mono">${esc(fmtMoney(Calc.parseAmount(v.row.amount), own, true))}</span>
            ${versions.length > 1 ? `<button type="button" class="btn small danger" data-lp-del="${esc(v.from)}">Delete</button>` : ""}</span></li>`).join("")}</ul>`
          : `<p class="muted small">${norm(a.monthly_payment) !== "" ? `${esc(fmtMoney(Calc.parseAmount(a.monthly_payment), own, true))} every month from ${esc(Calc.monthLabel(loanStart(a, idx), true))}.` : "No monthly payment set yet."}</p>`}
        <p class="muted small">When the payment changes, enter the new amount and the first month it applies. Earlier months keep the old amount.</p>
        <div class="field-row">
          <div class="field"><label class="label" for="lp-amount">New payment (${esc(own)})</label><input id="lp-amount" type="text" inputmode="decimal" placeholder="4,500"></div>
          <div class="field"><label class="label" for="lp-from">From month</label><input id="lp-from" type="month" value="${Calc.currentMonth()}"></div>
        </div>
        <p class="err-text" id="lp-err"></p>
        <button type="button" class="btn block" id="lp-save">Change the payment</button>
      </div>`;
  }

  // Keeps the account's monthly_payment equal to the payment in force this month.
  async function syncLoanPayment(a) {
    await loadFixed();
    const sr = loanSeries(a.id);
    if (!sr) return;
    const nowM = Calc.currentMonth();
    const cur = Calc.parseAmount((sr.versions.filter((x) => x.from <= nowM).pop() || sr.versions[0]).row.amount);
    if (isFinite(cur) && Calc.parseAmount(a.monthly_payment) !== cur) {
      await Sheets.updateRow("Accounts", "id", a.id, { monthly_payment: cur });
      await reloadAccounts();
    }
  }

  function bindLoanHistory(a, idx) {
    const $err = () => document.getElementById("lp-err");
    const refresh = (msg) => {
      toast(msg);
      const fresh = state.accounts.find((x) => x.id === a.id) || a;
      openAccountDetail(fresh);
      refreshBehindSheet();
    };
    document.getElementById("lp-save").addEventListener("click", async (e) => {
      const amount = Calc.parseAmount(document.getElementById("lp-amount").value);
      const from = Calc.normMonth(document.getElementById("lp-from").value);
      if (!isFinite(amount) || amount <= 0) { $err().textContent = "Enter the new monthly payment."; return; }
      if (!from) { $err().textContent = "Choose the month it starts."; return; }
      const btn = e.target;
      setBusy(btn, true, "Saving…");
      try {
        await guarded(async () => {
          await loadFixed();
          const own = norm(a.currency).toUpperCase() || "ILS";
          const base = { id: `loan-${a.id}`, name: norm(a.nickname) || a.id, currency: own, owner: norm(a.owner), paid_from: "", day: "", to_month: "", notes: "", loan_id: a.id };
          const sr = loanSeries(a.id);
          const rows = [];
          if (!sr) {
            // First change: keep the old payment for the months before it, from the first payment month.
            const start = loanStart(a, Calc.indexSnapshots(state.snapshots));
            const old = Calc.parseAmount(a.monthly_payment);
            if (isFinite(old) && old > 0 && start < from) rows.push({ ...base, amount: old, from_month: start });
            rows.push({ ...base, amount, from_month: from });
          } else {
            const same = sr.versions.find((v) => v.from === from);
            if (same) await Sheets.setCells("Fixed", (await Sheets.readTab("Fixed")).header, [{ row: same.row._row, field: "amount", value: amount }], "RAW");
            else rows.push({ ...base, amount, from_month: from });
          }
          if (rows.length) await Sheets.appendRows("Fixed", rows);
          await syncLoanPayment(a);
        });
        refresh(`Payment ${fmtMoney(amount, norm(a.currency).toUpperCase() || "ILS")} from ${Calc.monthLabel(from, true)}`);
      } catch (ex) {
        $err().textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });
    $sheetBody.querySelectorAll("[data-lp-del]").forEach((b) => b.addEventListener("click", async () => {
      const from = b.dataset.lpDel;
      if (!confirm(`Delete the payment that starts in ${Calc.monthLabel(from, true)}?`)) return;
      setBusy(b, true, "…");
      try {
        await guarded(async () => {
          await loadFixed();
          const sr = loanSeries(a.id);
          const v = sr && sr.versions.find((x) => x.from === from);
          if (!v || sr.versions.length < 2) throw new Error("That payment changed in the sheet meanwhile. Please look again.");
          await Sheets.deleteRows("Fixed", [v.row._row]);
          await syncLoanPayment(a);
        });
        refresh("Payment removed");
      } catch (ex) {
        $err().textContent = friendlyError(ex);
        setBusy(b, false);
      }
    }));
  }

  // Finds a snapshot again after a fresh read: by id, or by account and month when it has no id.
  async function findSnapshotFresh(a, month, snap) {
    await reloadSnapshots();
    const id = snap && norm(snap.id);
    const found = state.snapshots.find((s) => (id ? norm(s.id) === id
      : norm(s.account_id) === norm(a.id) && Calc.normMonth(s.month) === month));
    if (!found || norm(found.account_id) !== norm(a.id) || Calc.normMonth(found.month) !== month) {
      throw new Error("That balance changed in the sheet meanwhile. Please look again.");
    }
    return found;
  }

  async function deleteSnapshot(a, month, snap) {
    const found = await findSnapshotFresh(a, month, snap);
    await Sheets.deleteRows("Snapshots", [found._row]);
    await reloadSnapshots();
  }

  function openSnapshotEditor(a, snap) {
    const month = Calc.normMonth(snap.month);
    const own = norm(snap.currency).toUpperCase() || norm(a.currency).toUpperCase();
    openSheet(`
      <form id="se-form" class="stack-lg" novalidate>
        <div class="spread">
          <div><div class="label">${accountName(a)}</div><h2>${Calc.monthLabel(month, true)}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button>
        </div>
        <div class="field"><label class="label" for="se-amount">Amount (${esc(own)})</label>
          <input id="se-amount" type="text" inputmode="decimal" value="${esc(snap.amount)}"></div>
        <div class="field"><label class="label" for="se-date">As-of date</label>
          <input id="se-date" type="date" value="${esc(Calc.normDate(snap.as_of_date) || "")}"></div>
        <p class="err-text" id="se-err"></p>
        <button class="btn primary block" type="submit">Save</button>
        <button class="btn ghost block" type="button" id="se-back">Back</button>
      </form>`);
    document.getElementById("se-back").addEventListener("click", () => openAccountDetail(a));
    document.getElementById("se-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const $err = document.getElementById("se-err");
      const amount = Calc.parseAmount(document.getElementById("se-amount").value);
      const date = Calc.normDate(document.getElementById("se-date").value);
      if (!isFinite(amount) || amount < 0) { $err.textContent = "Enter a positive number."; return; }
      if (!date) { $err.textContent = "Choose the as-of date."; return; }
      if (date > Calc.today()) { $err.textContent = "The as-of date is in the future."; return; }
      const btn = e.target.querySelector('[type="submit"]');
      setBusy(btn, true, "Saving…");
      try {
        await guarded(async () => {
          const found = await findSnapshotFresh(a, month, snap);
          const values = { amount, as_of_date: date, entered_by: state.me.name, entered_at: new Date().toISOString() };
          await Sheets.setCells("Snapshots", state.snapHeader,
            Object.entries(values).map(([field, value]) => ({ row: found._row, field, value })), "RAW");
          await reloadSnapshots();
        });
        toast("Balance updated");
        openAccountDetail(a);
        refreshBehindSheet();
      } catch (ex) {
        $err.textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });
  }

  // Redraws the screen under an open panel so it reflects a change made in the panel.
  function refreshBehindSheet() {
    const y = window.scrollY;
    const r = currentRoute();
    if (SUBSCREENS[r]) SUBSCREENS[r].render(); else TABS.find((t) => t.id === r).render();
    window.scrollTo(0, y);
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
          <input id="af-payment" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.monthly_payment)}" placeholder="0" ${!isNew && loanSeries(a.id) ? "readonly" : ""}>
          ${!isNew && loanSeries(a.id) ? `<span class="hint">This loan has a payment history. Change the payment from the loan's page (tap the loan → Change the payment).</span>` : ""}</div>
        <div class="field-row" ${showIf("loan_start")}>
          <div class="field"><label class="label" for="af-loanstart">First payment month</label>
            <input id="af-loanstart" type="month" value="${esc(Calc.normMonth(a.loan_start) || "")}"></div>
          <div class="field"><label class="label" for="af-orig">Original loan amount</label>
            <input id="af-orig" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.original_amount)}" placeholder="Optional"></div>
        </div>
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
        loan_start: ONLY_FOR.loan_start.includes(t) ? (Calc.normMonth(v("af-loanstart")) || "") : "",
        original_amount: ONLY_FOR.original_amount.includes(t) && v("af-orig") !== "" ? Number(v("af-orig")) : "",
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
      else if (t === "loan" && obj.original_amount !== "" && !(obj.original_amount > 0)) err = "Original loan amount must be a positive number.";
      else if (t === "loan" && obj.loan_start && obj.loan_start > Calc.currentMonth()) err = "The first payment month can't be in the future.";
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
    "bank-a-cur | Bank A Main | Bank A | Country A | ILS | Joint | bank | Alex | 5 |",
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

      let type = lower(c.type).replace(/[\s-]+/g, "_");
      if (type === "bank") type = "current"; // "Bank" is the display name of type current
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
        <p class="muted" style="font-size:14px">Owner is ${esc([...personNames(), JOINT].join(", "))}. Type is one of ${TYPES.map((t) => (t === "current" ? "bank (or current)" : t)).join(", ")}. The last column is only for cards and may be left empty.</p>
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

  // ---------- Hide amounts (eye button in every page header) ----------

  const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_SHUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  // Adds the eye button to the page header after any render.
  function decorateHead() {
    const ph = $screen.querySelector(".page-head");
    if (!ph || ph.querySelector("[data-eye]") || $tabbar.hidden) return;
    const actions = document.createElement("div");
    actions.className = "head-actions";
    [...ph.children].slice(1).forEach((el) => actions.appendChild(el));
    actions.insertAdjacentHTML("afterbegin", `<button type="button" class="icon-btn eye" data-eye
      aria-label="${state.hideAmounts ? "Show amounts" : "Hide amounts"}" aria-pressed="${state.hideAmounts}">${state.hideAmounts ? EYE_SHUT : EYE_OPEN}</button>`);
    ph.appendChild(actions);
  }
  new MutationObserver(decorateHead).observe($screen, { childList: true });

  function setHideAmounts(on) {
    state.hideAmounts = on;
    LS.set("fd.hideAmounts", on ? "1" : "0");
    refreshBehindSheet();
  }
  $screen.addEventListener("click", (e) => {
    if (e.target.closest("[data-eye]")) setHideAmounts(!state.hideAmounts);
  });

  // ---------- Due now ----------

  function dueItems() {
    if (!state.me) return [];
    return Calc.dueList(state.accounts, Calc.indexSnapshots(state.snapshots), state.me.name, new Date());
  }

  function openManualFor(accountId, month) {
    state.updateMode = "manual";
    state.manualShowAll = true;
    state.manualDraft = {
      account_id: accountId, month,
      as_of_date: month === Calc.currentMonth() ? Calc.today() : Calc.lastDayOfMonth(month),
    };
    closeSheet();
    if (currentRoute() === "update") route(); else location.hash = "update";
  }

  const DUE_SHOWN = 3;
  function dueCardHtml(due) {
    if (!due.length) return "";
    const item = (d, i) => `
      <button class="due-item" data-due="${i}">
        <span><span class="due-name">${accountName(d.account)}</span>
          <span class="muted small mono">${Calc.monthLabel(d.month, true)} · ${esc(TYPE_LABEL[lower(d.account.type)] || d.account.type)}</span></span>
        <span class="row">${d.overdue ? `<span class="chip neg">Overdue</span>` : `<span class="chip warn">Due</span>`}<span class="chev">›</span></span>
      </button>`;
    const over = due.filter((d) => d.overdue).length;
    return `
      <div class="card notice stack">
        <div class="spread"><div class="label">Due now · ${due.length}</div>${over ? `<span class="chip neg">${over} overdue</span>` : ""}</div>
        <div class="stack" style="gap:8px">${due.slice(0, DUE_SHOWN).map(item).join("")}</div>
        ${due.length > DUE_SHOWN ? `<details class="due-more"><summary class="link-btn">Show all ${due.length}</summary>
          <div class="stack" style="gap:8px; margin-top:8px">${due.slice(DUE_SHOWN).map((d, i) => item(d, i + DUE_SHOWN)).join("")}</div></details>` : ""}
      </div>`;
  }

  function bindDue(due) {
    $screen.querySelectorAll("[data-due]").forEach((b) => b.addEventListener("click", () => {
      const d = due[Number(b.dataset.due)];
      openManualFor(d.account.id, d.month);
    }));
  }

  // ---------- Goals ----------

  function goalsActive(g) { return Calc.isActive(g); }

  function goalProgressOf(g) {
    return Calc.goalProgress(g, state.accounts, Calc.indexSnapshots(state.snapshots), state.rates);
  }

  function goalCardHtml(g, compact) {
    const p = goalProgressOf(g);
    const pct = p.pct == null ? 0 : p.pct;
    return `
      <button class="goal ${compact ? "compact" : ""} ${goalsActive(g) ? "" : "inactive"}" data-goal="${esc(g.id)}">
        <div class="spread"><strong>${esc(g.name || g.id)}</strong><span class="mono small">${p.pct == null ? "—" : `${pct.toFixed(0)}%`}</span></div>
        <div class="bar goal-bar"><span style="width:${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct)).toFixed(1)}%"></span></div>
        <div class="spread small">
          <span class="mono">${esc(fmtMoney(p.value, p.cur))} <span class="muted">of ${esc(fmtMoney(p.target, p.cur))}</span></span>
          <span class="mono ${p.remaining === 0 ? "pos" : "muted"}">${p.remaining === 0 ? "reached" : `${esc(fmtMoney(p.remaining, p.cur))} to go`}</span>
        </div>
        ${compact ? "" : `<div class="spread small">
          <span class="muted">${p.linked.length} account${p.linked.length === 1 ? "" : "s"}${p.missing.length ? ` · ${p.missing.length} unknown id` : ""}</span>
          <span class="mono ${toneOf(p.change)}">${p.change == null ? "no change data" : `${fmtSigned(p.change, p.cur)} since last month`}</span>
        </div>`}
      </button>`;
  }

  async function loadGoals() {
    state.goals = (await Sheets.readTab("Goals")).rows;
  }

  function renderGoals() {
    const goals = state.goals || [];
    const active = goals.filter(goalsActive);
    const inactive = goals.filter((g) => !goalsActive(g));
    $screen.innerHTML = `
      <div class="page-head">
        <div><div class="label">More</div><h1>Goals</h1></div>
        <a class="btn small" href="#more">Back</a>
      </div>
      <div class="stack-lg">
        <button class="btn primary block" id="goal-add">+ New goal</button>
        ${active.length ? `<div class="stack">${active.map((g) => goalCardHtml(g, false)).join("")}</div>`
          : `<div class="card empty stack"><p class="muted">No goals yet. A goal has a target amount and one or more linked accounts; its progress comes from their latest balances.</p></div>`}
        ${inactive.length ? `<details><summary class="group-title"><span class="label">Inactive (${inactive.length}) ▾</span></summary>
          <div class="stack">${inactive.map((g) => goalCardHtml(g, false)).join("")}</div></details>` : ""}
      </div>`;
    document.getElementById("goal-add").addEventListener("click", () => openGoalForm(null));
    $screen.querySelectorAll("[data-goal]").forEach((b) => b.addEventListener("click", () => {
      const g = goals.find((x) => String(x.id) === b.dataset.goal);
      if (g) openGoalForm(g);
    }));
  }

  function openGoalForm(goal) {
    const isNew = !goal;
    const g = goal || { currency: state.displayCur, account_ids: "", active: true };
    const chosen = new Set(Calc.splitIds(g.account_ids).map(lower));
    const accts = state.accounts.filter((a) => (isActive(a) || chosen.has(lower(a.id))) && lower(a.type) !== "card")
      .sort((x, y) => norm(x.nickname).localeCompare(norm(y.nickname)));
    // Accounts already linked to another active goal (allowed, but worth a warning).
    const otherUse = new Map();
    (state.goals || []).filter((o) => goalsActive(o) && o.id !== g.id).forEach((o) => {
      Calc.splitIds(o.account_ids).forEach((id) => {
        const k = lower(id);
        if (!otherUse.has(k)) otherUse.set(k, []);
        otherUse.get(k).push(o.name || o.id);
      });
    });
    const cur = norm(g.currency).toUpperCase() || "ILS";
    openSheet(`
      <form id="goal-form" class="stack-lg" novalidate>
        <div class="spread"><div><div class="label">${isNew ? "New goal" : "Edit goal"}</div><h2>${isNew ? "Add a goal" : esc(g.name)}</h2></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
        <div class="field"><label class="label" for="gf-name">Name</label><input id="gf-name" value="${esc(g.name)}" autocomplete="off" placeholder="Emergency fund"></div>
        <div class="field-row">
          <div class="field"><label class="label" for="gf-target">Target amount</label><input id="gf-target" type="text" inputmode="decimal" value="${esc(g.target_amount)}" placeholder="100,000"></div>
          <div class="field"><label class="label" for="gf-cur">Currency</label><select id="gf-cur">${options(CURRENCIES, cur)}</select></div>
        </div>
        <div class="field"><span class="label">Linked accounts</span>
          <div class="check-list">${accts.map((a) => {
            const used = otherUse.get(lower(a.id));
            return `<label class="check"><input type="checkbox" value="${esc(a.id)}" ${chosen.has(lower(a.id)) ? "checked" : ""}>
              <span><span>${accountName(a)}</span><span class="muted small mono">${esc(TYPE_LABEL[lower(a.type)] || a.type)} · ${esc(norm(a.currency).toUpperCase())}</span>
              ${used ? `<span class="warn-text small">Also in: ${used.map(esc).join(", ")}</span>` : ""}</span></label>`;
          }).join("") || `<p class="muted">No accounts yet.</p>`}</div>
          <span class="hint">Progress is the sum of these accounts' latest balances (a loan counts as negative).</span></div>
        <p class="err-text" id="gf-err"></p>
        <button class="btn primary block" type="submit">${isNew ? "Add goal" : "Save changes"}</button>
        ${isNew ? "" : `<button class="btn ${goalsActive(g) ? "danger" : ""} block" type="button" id="gf-toggle">${goalsActive(g) ? "Deactivate goal" : "Reactivate goal"}</button>`}
      </form>`);
    const form = document.getElementById("goal-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const $err = document.getElementById("gf-err");
      const name = norm(document.getElementById("gf-name").value);
      const target = Calc.parseAmount(document.getElementById("gf-target").value);
      const ids = [...form.querySelectorAll(".check input:checked")].map((x) => x.value);
      if (!name) { $err.textContent = "Give the goal a name."; return; }
      if (!isFinite(target) || target <= 0) { $err.textContent = "Enter a target amount above zero."; return; }
      if (!ids.length) { $err.textContent = "Link at least one account."; return; }
      const obj = { name, target_amount: target, currency: document.getElementById("gf-cur").value, account_ids: ids.join(",") };
      const btn = form.querySelector('[type="submit"]');
      setBusy(btn, true, "Saving…");
      try {
        await guarded(async () => {
          if (isNew) await Sheets.appendRows("Goals", [{ id: `g-${Date.now().toString(36)}`, ...obj, active: true }]);
          else await Sheets.updateRow("Goals", "id", g.id, obj);
          await loadGoals();
        });
        closeSheet();
        toast(isNew ? "Goal added" : "Goal saved");
        route();
      } catch (ex) {
        $err.textContent = friendlyError(ex);
        setBusy(btn, false);
      }
    });
    const toggle = document.getElementById("gf-toggle");
    if (toggle) toggle.addEventListener("click", async () => {
      setBusy(toggle, true, "Saving…");
      try {
        await guarded(async () => {
          await Sheets.updateRow("Goals", "id", g.id, { active: !goalsActive(g) });
          await loadGoals();
        });
        closeSheet();
        toast(goalsActive(g) ? "Goal deactivated" : "Goal reactivated");
        route();
      } catch (ex) {
        document.getElementById("gf-err").textContent = friendlyError(ex);
        setBusy(toggle, false);
      }
    });
  }

  // ---------- Face ID lock (WebAuthn platform authenticator, a screen lock only) ----------

  const LOCK_AFTER_MS = 3 * 60 * 1000;
  const b64 = {
    enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
    dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  };
  const lockCredential = () => LS.get("fd.lockCred");
  let hiddenAt = null;

  async function lockSupported() {
    try {
      return !!(window.PublicKeyCredential && navigator.credentials &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch (_) { return false; }
  }

  async function enableLock() {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Finance" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Finance lock", displayName: "Finance lock" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        timeout: 60000,
        attestation: "none",
      },
    });
    LS.set("fd.lockCred", b64.enc(cred.rawId));
  }

  async function unlockWithFaceId() {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: b64.dec(lockCredential()) }],
        userVerification: "required",
        timeout: 60000,
      },
    });
  }

  function showLock(message) {
    if (!lockCredential()) return;
    $lock.innerHTML = `
      <div class="lock-inner">
        ${brand()}
        <div class="stack">
          <h1>Locked</h1>
          <p class="muted">Use Face ID to open the app on this phone.</p>
        </div>
        ${message ? `<p class="err-text">${esc(message)}</p>` : ""}
        <button class="btn primary block" id="lock-go">Unlock with Face ID</button>
        <button class="btn ghost block" id="lock-google">Sign in with Google instead</button>
      </div>`;
    $lock.hidden = false;
    document.getElementById("lock-go").addEventListener("click", async () => {
      try {
        await unlockWithFaceId();
        $lock.hidden = true;
        $lock.innerHTML = "";
      } catch (_) {
        showLock("Face ID did not unlock. Try again, or sign in with Google.");
      }
    });
    // The way back in that never depends on Face ID: a fresh Google sign-in.
    document.getElementById("lock-google").addEventListener("click", () => {
      clearToken();
      $lock.hidden = true;
      $lock.innerHTML = "";
      closeSheet();
      state.signInMessage = "Sign in with Google to open the app.";
      renderSignIn();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) showLock();
  });

  async function lockSettingsHtml() {
    if (!(await lockSupported())) return "";
    const on = !!lockCredential();
    return `
      <div class="card stack">
        <div class="label">Face ID lock · this phone</div>
        <p class="muted small">When on, this phone asks for Face ID when the app opens or comes back after ${LOCK_AFTER_MS / 60000} minutes away. This is a screen lock only: the real protection is your private Google Sheet and Google sign-in. You can always get back in by signing in with Google.</p>
        <button class="btn ${on ? "danger" : "primary"} block" id="lock-toggle">${on ? "Turn off Face ID lock" : "Turn on Face ID lock"}</button>
      </div>`;
  }

  function bindLockSettings() {
    const btn = document.getElementById("lock-toggle");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (lockCredential()) {
        LS.del("fd.lockCred");
        toast("Face ID lock turned off");
        return route();
      }
      try {
        await enableLock();
        toast("Face ID lock is on for this phone");
      } catch (_) {
        toast("Face ID was not set up", true);
      }
      route();
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
      showLock(); // only when Face ID lock is on for this phone; otherwise a no-op
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
