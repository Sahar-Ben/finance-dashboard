// Pure calculations: months, amounts, exchange rates, monthly totals and import checks.
// No DOM and no network here, so this file can be tested on its own.
(function (root) {
  "use strict";

  // long_term is shown as "Pension"; study_fund is Keren Hishtalmut.
  // card and salary are flows, not balances: they never count in reachable money or the long-term total.
  const TYPES = ["current", "savings", "investment", "crypto", "long_term", "study_fund", "loan", "home", "card", "salary"];
  const FLOW_TYPES = ["card", "salary"];
  const ASSET_TYPES = ["current", "savings", "investment", "crypto", "long_term", "study_fund", "home"];
  const CURRENCIES = ["ILS", "USD", "EUR"];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // A change is "large" when it is over 25% AND over this many ILS (converted), so small accounts don't trip it.
  const LARGE_CHANGE_RATIO = 0.25;
  const TRIVIAL_ILS = 1000;

  const norm = (v) => String(v == null ? "" : v).trim();
  const lower = (v) => norm(v).toLowerCase();
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- months and dates ----------

  function currentMonth(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function today(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

  // Accepts YYYY-MM, YYYY-M, YYYY-MM-DD, MM/YYYY. Returns YYYY-MM or null.
  function normMonth(v) {
    const s = norm(v);
    let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
    if (m) { const r = `${m[1]}-${pad(+m[2])}`; return isMonth(r) ? r : null; }
    m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
    if (m) { const r = `${m[2]}-${pad(+m[1])}`; return isMonth(r) ? r : null; }
    return null;
  }

  function shiftMonth(month, n) {
    const [y, m] = month.split("-").map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
  }

  function monthLabel(month, long) {
    if (!isMonth(month)) return norm(month);
    const [y, m] = month.split("-").map(Number);
    return long ? `${MONTH_NAMES[m - 1]} ${y}` : `${MONTH_NAMES[m - 1]} ${String(y).slice(2)}`;
  }

  function lastDayOfMonth(month) {
    const [y, m] = month.split("-").map(Number);
    return `${month}-${pad(new Date(y, m, 0).getDate())}`;
  }

  // Accepts YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY. Returns YYYY-MM-DD or null.
  function normDate(v) {
    const s = norm(v);
    let y, mo, d;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { [, y, mo, d] = m; } else {
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
      if (!m) return null;
      [, d, mo, y] = m;
    }
    y = +y; mo = +mo; d = +d;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // "12,345.60", "₪ 1 200", "$800" -> number. Returns NaN when it isn't a plain number.
  function parseAmount(v) {
    if (typeof v === "number") return v;
    const s = norm(v).replace(/[\s,₪$€]|ILS|USD|EUR/gi, "");
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  // ---------- rates ----------

  const validRate = (v) => typeof v === "number" && isFinite(v) && v > 0;

  // Rates rows -> sorted list of { month, usd, eur } (invalid cells become null). First row per month wins.
  function rateTable(rows) {
    const seen = new Set();
    const out = [];
    rows.forEach((r) => {
      const month = normMonth(r.month);
      if (!month || seen.has(month)) return;
      seen.add(month);
      out.push({ month, usd: validRate(r.usd_ils) ? r.usd_ils : null, eur: validRate(r.eur_ils) ? r.eur_ils : null });
    });
    return out.sort((a, b) => a.month.localeCompare(b.month));
  }

  // The ILS rate of `cur` for `month`. The latest row covers every month from it onward; a past month
  // uses its own row, falling back to the nearest earlier then later month with a valid number.
  function rateFor(table, month, cur) {
    if (cur === "ILS") return { rate: 1, month, exact: true };
    const key = cur === "USD" ? "usd" : "eur";
    const valid = table.filter((r) => r[key] != null);
    if (!valid.length) return null;
    const latestRow = table[table.length - 1];
    if (month >= latestRow.month) {
      if (latestRow[key] != null) return { rate: latestRow[key], month: latestRow.month, exact: true };
      const last = valid[valid.length - 1];
      return { rate: last[key], month: last.month, exact: false };
    }
    const exact = table.find((r) => r.month === month);
    if (exact && exact[key] != null) return { rate: exact[key], month, exact: true };
    const earlier = valid.filter((r) => r.month < month);
    const pick = earlier.length ? earlier[earlier.length - 1] : valid[0];
    return { rate: pick[key], month: pick.month, exact: false };
  }

  // Converts through ILS. Returns null if a needed rate is missing.
  function convert(amount, from, to, table, month) {
    if (from === to) return amount;
    const a = rateFor(table, month, from);
    const b = rateFor(table, month, to);
    if (!a || !b) return null;
    return (amount * a.rate) / b.rate;
  }

  // ---------- snapshots and totals ----------

  function isActive(a) {
    if (a.active === false) return false;
    return !/^(false|no|0|n)$/i.test(norm(a.active));
  }

  // Index snapshots by account and month. Later rows win if the sheet somehow holds duplicates.
  function indexSnapshots(snaps) {
    const byKey = new Map();
    const firstMonth = new Map();
    const byAccount = new Map();
    snaps.forEach((s) => {
      const month = normMonth(s.month);
      const id = norm(s.account_id);
      if (!month || !id) return;
      byKey.set(`${id}|${month}`, s);
      if (!firstMonth.has(id) || month < firstMonth.get(id)) firstMonth.set(id, month);
      if (!byAccount.has(id)) byAccount.set(id, []);
      byAccount.get(id).push({ month, snap: s });
    });
    byAccount.forEach((list) => list.sort((a, b) => a.month.localeCompare(b.month)));
    return { byKey, firstMonth, byAccount, get: (id, month) => byKey.get(`${id}|${month}`) || null };
  }

  // Months that hold any snapshot, newest first; and those that hold balances (non-card) only.
  function snapshotMonths(snaps, accounts) {
    const typeOf = new Map(accounts.map((a) => [norm(a.id), lower(a.type)]));
    const all = new Set();
    const balances = new Set();
    snaps.forEach((s) => {
      const m = normMonth(s.month);
      if (!m) return;
      all.add(m);
      if (!FLOW_TYPES.includes(typeOf.get(norm(s.account_id)))) balances.add(m);
    });
    const desc = (set) => [...set].sort().reverse();
    return { all: desc(all), balances: desc(balances) };
  }

  // The balance an account contributes to `month`: its own snapshot, or for an active home the
  // latest earlier one carried forward. Returns null when there is none.
  function balanceFor(account, month, idx) {
    const id = norm(account.id);
    const own = idx.get(id, month);
    if (own) return { snap: own, month, carried: false };
    if (lower(account.type) === "home" && isActive(account)) {
      const list = (idx.byAccount.get(id) || []).filter((x) => x.month < month);
      if (list.length) { const last = list[list.length - 1]; return { snap: last.snap, month: last.month, carried: true }; }
    }
    return null;
  }

  // Totals for one month in the display currency, converted with that month's rate, or with the
  // rate of `rateMonth` when given (used for comparisons, so currency moves don't count as change).
  // An active non-card account is expected from its first snapshot onward (or, if it has none yet,
  // from the latest month with balances); a missing expected balance marks the month incomplete.
  // `shareOf(account)` (optional) weights each account, e.g. 0.5 for joint; accounts weighted 0 are ignored.
  // In the current month, an account whose update day hasn't come yet is not missing: its latest
  // earlier balance is carried forward and it is listed in `notDue` instead.
  function monthTotals(accounts, idx, month, display, rates, latestBalanceMonth, rateMonth, shareOf, now) {
    now = now || new Date();
    const nowM = currentMonth(now);
    const notDue = [];
    const byType = {};
    TYPES.forEach((t) => { byType[t] = 0; });
    const counts = {};
    const missing = [];
    const unconverted = [];
    let balances = 0;
    let cards = 0;
    let salary = 0;
    let cardCount = 0;

    accounts.forEach((a) => {
      const type = lower(a.type);
      if (!TYPES.includes(type)) return;
      const share = shareOf ? shareOf(a) : 1;
      if (!share) return;
      let b = balanceFor(a, month, idx);
      if (!b && month === nowM && !FLOW_TYPES.includes(type) && isActive(a) && notDueYet(a, now)) {
        const prev = (idx.byAccount.get(norm(a.id)) || []).filter((x) => x.month < month);
        const last = prev[prev.length - 1];
        notDue.push({ account: a, from: last ? last.month : null });
        if (!last) return;
        b = { snap: last.snap, month: last.month, carried: true };
      }
      if (!b) {
        if (FLOW_TYPES.includes(type) || !isActive(a)) return;
        const first = idx.firstMonth.get(norm(a.id));
        const expected = first ? first <= month : (latestBalanceMonth && month >= latestBalanceMonth);
        if (expected) missing.push(a);
        return;
      }
      const amt = parseAmount(b.snap.amount);
      if (!isFinite(amt)) return;
      const cur = norm(b.snap.currency).toUpperCase() || norm(a.currency).toUpperCase();
      const v0 = convert(Math.abs(amt), cur, display, rates, rateMonth || month);
      const v = v0 == null ? null : v0 * share;
      if (v == null) { unconverted.push(a); return; }
      if (type === "card") { cards += v; cardCount++; return; }
      if (type === "salary") { salary += v; return; }
      if (!b.carried) balances++;
      byType[type] += v;
      counts[type] = (counts[type] || 0) + 1;
    });

    const reachable = byType.current;
    const assets = ASSET_TYPES.reduce((s, t) => s + byType[t], 0);
    const longTerm = assets - byType.loan;
    return {
      month, reachable, longTerm, assets, byType, counts, cards, cardCount, salary, missing, unconverted, notDue,
      hasBalances: balances > 0,
      incomplete: missing.length > 0 || unconverted.length > 0,
    };
  }

  function change(now, before) {
    if (now == null || before == null) return null;
    const amount = now - before;
    const pct = before !== 0 ? (amount / Math.abs(before)) * 100 : null;
    return { amount, pct };
  }

  // Latest { month, snap } for an account, or null.
  function latestSnapshot(idx, id) {
    const list = idx.byAccount.get(norm(id)) || [];
    return list.length ? list[list.length - 1] : null;
  }

  // Every month from `from` to `to`, inclusive, ascending.
  function monthRange(from, to) {
    const out = [];
    for (let m = from; m <= to && out.length < 600; m = shiftMonth(m, 1)) out.push(m);
    return out;
  }

  const clampDay = (d, month) => Math.min(Math.max(1, Number(d) || 1), Number(lastDayOfMonth(month).slice(8)));

  // True when a monthly account's update day for the current month is still ahead.
  function notDueYet(a, now) {
    if (lower(a.type) === "home") return false;
    return now.getDate() < clampDay(a.update_day, currentMonth(now));
  }

  // ---------- due list ----------

  // Accounts the person updates whose due date has passed with no snapshot yet.
  // Monthly accounts: due this month once update_day has passed; earlier months of this year (or since
  // the first snapshot, if older) that are still empty are overdue. Home: due once a year from update_month/update_day.
  // No update day means due from the 1st; a home with no update month is due when this year has no value.
  // Accounts with no updater go to whoever `noUpdater(account)` accepts (optional).
  function dueList(accounts, idx, personName, now, noUpdater) {
    now = now || new Date();
    const nowM = currentMonth(now);
    const day = now.getDate();
    const me = lower(personName);
    const out = [];
    accounts.forEach((a) => {
      if (!isActive(a)) return;
      if (norm(a.updater) ? lower(a.updater) !== me : !(noUpdater && noUpdater(a))) return;
      const id = norm(a.id);
      const type = lower(a.type);
      if (type === "home") {
        let um = Number(a.update_month);
        if (!(um >= 1 && um <= 12)) um = 1;
        const dueMonth = `${nowM.slice(0, 4)}-${pad(um)}`;
        if (nowM < dueMonth || (nowM === dueMonth && day < clampDay(a.update_day, dueMonth))) return;
        const done = (idx.byAccount.get(id) || []).some((x) => x.month >= dueMonth);
        if (!done) out.push({ account: a, month: dueMonth, overdue: nowM > dueMonth });
        return;
      }
      // Earlier months are checked from January of this year (or the first snapshot, if older);
      // a loan only from its start month.
      const first = idx.firstMonth.get(id);
      let from = `${nowM.slice(0, 4)}-01`;
      if (first && first < from) from = first;
      const loanStart = type === "loan" ? normMonth(a.loan_start) : null;
      if (loanStart && loanStart > from) from = loanStart;
      {
        for (let m = from; m < nowM; m = shiftMonth(m, 1)) {
          if (!idx.get(id, m)) out.push({ account: a, month: m, overdue: true });
        }
      }
      if (day >= clampDay(a.update_day, nowM) && !idx.get(id, nowM)) out.push({ account: a, month: nowM, overdue: false });
    });
    return out.sort((x, y) => (x.overdue === y.overdue ? x.month.localeCompare(y.month) : x.overdue ? -1 : 1));
  }

  // ---------- goals ----------

  const splitIds = (v) => norm(v).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

  // Progress of a goal from the latest balances of its linked accounts, in the goal's currency.
  // The change adds up each account's move from its previous month to its latest month.
  function goalProgress(goal, accounts, idx, rates) {
    const cur = norm(goal.currency).toUpperCase() || "ILS";
    const target = parseAmount(goal.target_amount);
    const ids = splitIds(goal.account_ids);
    const byId = new Map(accounts.map((a) => [lower(a.id), a]));
    let value = 0, changeSum = 0, hasPrev = false, counted = 0;
    const missing = [];
    const linked = [];
    ids.forEach((raw) => {
      const a = byId.get(lower(raw));
      if (!a) { missing.push(raw); return; }
      linked.push(a);
      const last = latestSnapshot(idx, a.id);
      if (!last) return;
      const amt = parseAmount(last.snap.amount);
      const own = norm(last.snap.currency).toUpperCase() || norm(a.currency).toUpperCase();
      const v = isFinite(amt) ? convert(amt, own, cur, rates, last.month) : null;
      if (v == null) return;
      const sign = lower(a.type) === "loan" ? -1 : 1;
      value += sign * v;
      counted++;
      // Each account's latest balance against its own previous month.
      const pm = shiftMonth(last.month, -1);
      const ps = idx.get(norm(a.id), pm);
      const pa = ps ? parseAmount(ps.amount) : NaN;
      const pv = isFinite(pa) ? convert(pa, own, cur, rates, last.month) : null; // same rate: no currency effect
      if (pv != null) { changeSum += sign * (v - pv); hasPrev = true; }
    });
    const pct = isFinite(target) && target > 0 ? Math.max(0, (value / target) * 100) : null;
    return {
      cur, target, value, counted, linked, missing,
      pct, remaining: isFinite(target) ? Math.max(0, target - value) : null,
      change: hasPrev ? changeSum : null, // only accounts with both months count
    };
  }

  // ---------- fixed payments ----------

  // Groups Fixed rows by id: [{ id, versions: [{ row, from }] ascending, stop, head }].
  // Rows marked one_month are exceptions for a single month: { month: { row, from } } in `overrides`.
  const isOneMonth = (r) => /^(yes|true|1|y)$/i.test(norm(r.one_month));
  function fixedSeries(rows) {
    const map = new Map();
    rows.forEach((r) => {
      const id = norm(r.id);
      const from = normMonth(r.from_month);
      if (!id || !from) return;
      if (!map.has(id)) map.set(id, { versions: [], overrides: new Map() });
      if (isOneMonth(r)) map.get(id).overrides.set(from, { row: r, from });
      else map.get(id).versions.push({ row: r, from });
    });
    const out = [];
    map.forEach(({ versions, overrides }, id) => {
      if (!versions.length) return;
      versions.sort((a, b) => a.from.localeCompare(b.from));
      const stop = versions.map((v) => normMonth(v.row.to_month)).filter(Boolean).sort().pop() || null;
      out.push({ id, versions, overrides, stop, head: versions[versions.length - 1].row });
    });
    return out.sort((a, b) => norm(a.head.name).localeCompare(norm(b.head.name)));
  }

  // Payments that apply in `month`, each with the amount of the version in force that month.
  function fixedForMonth(rows, month) {
    const out = [];
    fixedSeries(rows).forEach((s) => {
      if (s.stop && month > s.stop) return;
      const base = s.versions.filter((x) => x.from <= month).pop();
      if (!base) return;
      const v = s.overrides.get(month) || base; // a one-month exception wins for its month
      const amount = parseAmount(v.row.amount);
      if (!isFinite(amount)) return;
      out.push({
        id: s.id, name: norm(s.head.name) || s.id, amount,
        currency: (norm(v.row.currency) || norm(s.head.currency)).toUpperCase() || "ILS",
        owner: norm(s.head.owner), paid_from: norm(s.head.paid_from), day: norm(s.head.day),
        income: lower(s.head.direction) === "in",
        since: base.from, series: s, oneMonth: s.overrides.has(month),
      });
    });
    return out;
  }

  // ---------- import ----------

  // Splits pasted text into raw rows: month | account_id | amount | currency | as_of_date
  function splitImport(text) {
    const rows = [];
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const cells = line.split("|").map((c) => c.trim());
      if (lower(cells[0]) === "month" && lower(cells[1]) === "account_id") return; // header line
      while (cells.length > 5 && cells[cells.length - 1] === "") cells.pop();
      rows.push({
        line: line.trim(), columns: cells.length,
        month: cells[0] || "", account_id: cells[1] || "", amount: cells[2] || "",
        currency: cells[3] || "", as_of_date: cells[4] || "",
      });
    });
    return rows;
  }

  // Checks every import row. ctx: { accounts, idx, rates, now (Date) }.
  // Adds to each row: problems[] (block saving), warnings[] (shown only) and the resolved values.
  function checkImport(rows, ctx) {
    const byId = new Map(ctx.accounts.map((a) => [lower(a.id), a]));
    const nowMonth = currentMonth(ctx.now);
    const todayStr = today(ctx.now);
    const seen = new Map();
    rows.forEach((r) => {
      const problems = [];
      const warnings = [];
      r.resolved = null;
      if (r.columns != null && (r.columns < 3 || r.columns > 5)) {
        r.problems = [{ col: null, msg: `Malformed line: expected 5 columns separated by |, found ${r.columns}.` }];
        r.warnings = warnings;
        return;
      }
      const account = byId.get(lower(r.account_id)) || null;
      if (!norm(r.account_id)) problems.push({ col: "account_id", msg: "Missing account id." });
      else if (!account) problems.push({ col: "account_id", msg: `Unknown account id "${norm(r.account_id)}".` });
      const type = account ? lower(account.type) : "";

      const month = normMonth(r.month);
      if (!month) problems.push({ col: "month", msg: `Bad month "${norm(r.month)}". Use YYYY-MM.` });
      else if (month > shiftMonth(nowMonth, type === "card" ? 1 : 0)) problems.push({ col: "month", msg: `${monthLabel(month, true)} is in the future.` });
      else if (month < "2000-01") problems.push({ col: "month", msg: "Month is too far in the past." });

      const amount = parseAmount(r.amount);
      if (norm(r.amount) === "" || isNaN(amount)) problems.push({ col: "amount", msg: `Amount "${norm(r.amount)}" is not a number.` });
      else if (amount < 0) problems.push({ col: "amount", msg: "Amounts are always positive (enter a loan as the amount still owed)." });

      const acctCur = account ? norm(account.currency).toUpperCase() : "";
      let currency = norm(r.currency).toUpperCase() || acctCur;
      if (!CURRENCIES.includes(currency)) problems.push({ col: "currency", msg: `Unknown currency "${norm(r.currency)}".` });
      else if (account && currency !== acctCur) problems.push({ col: "currency", msg: `${currency} differs from the account's currency (${acctCur}).` });

      let asOf = null;
      if (norm(r.as_of_date)) {
        asOf = normDate(r.as_of_date);
        if (!asOf) problems.push({ col: "as_of_date", msg: `Bad date "${norm(r.as_of_date)}". Use YYYY-MM-DD.` });
        else if (asOf > todayStr) problems.push({ col: "as_of_date", msg: "The as-of date is in the future." });
        else if (month && !FLOW_TYPES.includes(type) && asOf.slice(0, 7) !== month) warnings.push(`As-of date ${asOf} is outside ${monthLabel(month, true)}.`);
      } else if (month) {
        asOf = month === nowMonth ? todayStr : (month < nowMonth ? lastDayOfMonth(month) : todayStr);
        warnings.push(`No as-of date; ${asOf} will be used.`);
      }

      if (account && !isActive(account)) warnings.push("This account is inactive.");

      if (account && month) {
        const key = `${lower(account.id)}|${month}`;
        if (seen.has(key)) problems.push({ col: "account_id", msg: `Same account and month as row ${seen.get(key) + 1}.` });
        else seen.set(key, rows.indexOf(r));
      }

      let existing = null, prev = null, delta = null, large = false;
      if (account && month && !isNaN(amount)) {
        existing = ctx.idx.get(norm(account.id), month);
        const p = ctx.idx.get(norm(account.id), shiftMonth(month, -1));
        if (p) {
          prev = { amount: parseAmount(p.amount), month: shiftMonth(month, -1) };
          if (isFinite(prev.amount)) {
            delta = change(amount, prev.amount);
            const deltaIls = convert(Math.abs(delta.amount), acctCur || "ILS", "ILS", ctx.rates, month);
            const bigEnough = deltaIls == null ? Math.abs(delta.amount) > TRIVIAL_ILS : deltaIls > TRIVIAL_ILS;
            const ratio = prev.amount === 0 ? (amount > 0 ? Infinity : 0) : Math.abs(delta.amount) / prev.amount;
            large = ratio > LARGE_CHANGE_RATIO && bigEnough;
          }
        }
      }
      r.problems = problems;
      r.warnings = warnings;
      if (account) {
        r.resolved = {
          account, month, amount, currency, as_of_date: asOf, existing, prev, delta, large,
        };
      }
    });
    return rows;
  }

  const api = {
    TYPES, ASSET_TYPES, FLOW_TYPES, CURRENCIES, MONTH_NAMES, LARGE_CHANGE_RATIO, TRIVIAL_ILS,
    currentMonth, today, isMonth, normMonth, shiftMonth, monthLabel, lastDayOfMonth, normDate, parseAmount,
    validRate, rateTable, rateFor, convert,
    isActive, indexSnapshots, snapshotMonths, balanceFor, monthTotals, change, latestSnapshot, monthRange, dueList, goalProgress, splitIds, fixedSeries, fixedForMonth,
    splitImport, checkImport,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(this);
