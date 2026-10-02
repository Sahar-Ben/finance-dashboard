// Thin wrapper around the Google Sheets API v4.
// Every tab is treated as a table whose first row holds the headers.
(function () {
  "use strict";

  const API = "https://sheets.googleapis.com/v4/spreadsheets";

  const SCHEMA = {
    Accounts: ["id", "nickname", "institution", "country", "currency", "owner", "type", "updater",
      "update_day", "update_month", "linked_account", "monthly_payment", "active", "notes"],
    Snapshots: ["id", "month", "account_id", "amount", "currency", "as_of_date", "entered_by", "entered_at", "source"],
    Holdings: ["month", "account_id", "holding", "amount", "currency"],
    Goals: ["id", "name", "target_amount", "currency", "account_ids", "active"],
    Rates: ["month", "usd_ils", "eur_ils"],
    Settings: ["key", "value"],
  };

  class SheetsError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  let getToken = () => null;
  let sheetId = null;

  function configure(opts) {
    if (opts.getToken) getToken = opts.getToken;
    if ("sheetId" in opts) sheetId = opts.sheetId;
  }

  async function call(path, { method = "GET", body, query } = {}) {
    const token = getToken();
    if (!token) throw new SheetsError("Not signed in", 401);
    let url = `${API}/${encodeURIComponent(sheetId)}${path}`;
    if (query) url += "?" + new URLSearchParams(query).toString();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const data = await res.json();
        if (data.error && data.error.message) msg = data.error.message;
      } catch (_) { /* keep statusText */ }
      throw new SheetsError(msg, res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  const q = (tab) => `'${tab.replace(/'/g, "''")}'`;

  function colLetter(n) { // 1-based
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function parseSheetId(text) {
    const s = String(text || "").trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return s;
    return null;
  }

  async function getMeta() {
    return call("", { query: { fields: "properties.title,sheets.properties(title,sheetId)" } });
  }

  // Rewrites the spreadsheet title with its current value. View-only users get a 403.
  async function checkCanEdit(title) {
    try {
      await call(":batchUpdate", {
        method: "POST",
        body: { requests: [{ updateSpreadsheetProperties: { properties: { title }, fields: "title" } }] },
      });
      return true;
    } catch (e) {
      if (e.status === 403) return false;
      throw e;
    }
  }

  // Creates missing tabs and missing header cells. Never touches data rows.
  async function ensureSchema() {
    const meta = await getMeta();
    const existing = new Set(meta.sheets.map((s) => s.properties.title));
    const missing = Object.keys(SCHEMA).filter((t) => !existing.has(t));
    if (missing.length) {
      await call(":batchUpdate", {
        method: "POST",
        body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      });
    }
    const tabs = Object.keys(SCHEMA);
    const res = await call("/values:batchGet", {
      query: new URLSearchParams(tabs.map((t) => ["ranges", `${q(t)}!1:1`])),
    });
    const data = [];
    res.valueRanges.forEach((vr, i) => {
      const tab = tabs[i];
      const header = ((vr.values && vr.values[0]) || []).map((h) => String(h).trim());
      const toAdd = SCHEMA[tab].filter((h) => !header.includes(h));
      if (!toAdd.length) return;
      const start = header.length + 1;
      data.push({
        range: `${q(tab)}!${colLetter(start)}1:${colLetter(start + toAdd.length - 1)}1`,
        values: [toAdd],
      });
    });
    if (data.length) {
      await call("/values:batchUpdate", {
        method: "POST",
        body: { valueInputOption: "RAW", data },
      });
    }
    return { title: meta.properties.title, createdTabs: missing, fixedHeaders: data.length };
  }

  // Reads a whole tab. Returns { header, rows } where each row is an object
  // keyed by header name plus a hidden _row (1-based sheet row number).
  // Pass { formulas: true } to get formulas instead of their results.
  async function readTab(tab, opts) {
    const res = await call(`/values/${encodeURIComponent(q(tab))}`, {
      query: {
        valueRenderOption: opts && opts.formulas ? "FORMULA" : "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      },
    });
    const values = res.values || [];
    const header = (values[0] || []).map((h) => String(h).trim());
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const raw = values[i];
      if (!raw || raw.every((v) => v === "" || v == null)) continue;
      const obj = {};
      header.forEach((h, j) => { if (h) obj[h] = raw[j] === undefined ? "" : raw[j]; });
      Object.defineProperty(obj, "_row", { value: i + 1, enumerable: false });
      Object.defineProperty(obj, "_raw", { value: raw, enumerable: false });
      rows.push(obj);
    }
    return { header, rows };
  }

  function toRow(header, obj, base) {
    return header.map((h, j) => {
      if (h && Object.prototype.hasOwnProperty.call(obj, h)) return obj[h] == null ? "" : obj[h];
      return base && base[j] !== undefined ? base[j] : "";
    });
  }

  // inputOption "USER_ENTERED" makes the sheet evaluate formulas; the default "RAW" stores values as given.
  async function appendRows(tab, objects, inputOption) {
    if (!objects.length) return;
    const { header } = await readTab(tab);
    await call(`/values/${encodeURIComponent(`${q(tab)}!A1`)}:append`, {
      method: "POST",
      query: { valueInputOption: inputOption || "RAW", insertDataOption: "INSERT_ROWS" },
      body: { values: objects.map((o) => toRow(header, o)) },
    });
  }

  // Updates several rows in one call. `updates` is a list of { key, changes };
  // each row is found by `keyField` and columns not in `changes` keep their values.
  async function updateRows(tab, keyField, updates) {
    if (!updates.length) return;
    const { header, rows } = await readTab(tab);
    const data = updates.map(({ key, changes }) => {
      const row = rows.find((r) => String(r[keyField]) === String(key));
      if (!row) throw new SheetsError(`No row with ${keyField} = ${key} in ${tab}`, 404);
      return {
        range: `${q(tab)}!A${row._row}:${colLetter(header.length)}${row._row}`,
        values: [toRow(header, changes, row._raw)],
      };
    });
    await call("/values:batchUpdate", { method: "POST", body: { valueInputOption: "RAW", data } });
  }

  // Writes single cells. cells: [{ row (1-based), field (header name), value }].
  async function setCells(tab, header, cells, inputOption) {
    if (!cells.length) return;
    const data = cells.map(({ row, field, value }) => {
      const col = header.indexOf(field) + 1;
      if (!col) throw new SheetsError(`No column ${field} in ${tab}`, 400);
      return { range: `${q(tab)}!${colLetter(col)}${row}`, values: [[value]] };
    });
    await call("/values:batchUpdate", { method: "POST", body: { valueInputOption: inputOption || "RAW", data } });
  }

  const updateRow = (tab, keyField, key, changes) => updateRows(tab, keyField, [{ key, changes }]);

  // Settings is a key/value tab. Updates existing keys in place and appends new ones.
  async function readSettings() {
    const { rows } = await readTab("Settings");
    const out = {};
    rows.forEach((r) => { if (r.key !== "") out[String(r.key).trim()] = r.value; });
    return out;
  }

  async function writeSettings(map) {
    const { header, rows } = await readTab("Settings");
    const data = [];
    const toAppend = [];
    Object.entries(map).forEach(([key, value]) => {
      const row = rows.find((r) => String(r.key).trim() === key);
      if (row) {
        const values = toRow(header, { key, value }, row._raw);
        data.push({ range: `${q("Settings")}!A${row._row}:${colLetter(header.length)}${row._row}`, values: [values] });
      } else {
        toAppend.push({ key, value });
      }
    });
    if (data.length) {
      await call("/values:batchUpdate", { method: "POST", body: { valueInputOption: "RAW", data } });
    }
    if (toAppend.length) await appendRows("Settings", toAppend);
  }

  window.Sheets = {
    SCHEMA, SheetsError, configure, parseSheetId, getMeta, checkCanEdit, ensureSchema,
    readTab, appendRows, updateRow, updateRows, setCells, readSettings, writeSettings,
  };
})();
