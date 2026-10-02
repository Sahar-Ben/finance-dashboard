# Finance Dashboard — Specification

Status: **All four stages built.**

## Purpose

A private finance dashboard for two people, as a static web app in this repo, hosted on GitHub Pages. Once a month we record the balance of every account we have (several banks, several countries, three currencies) and the monthly total of each credit card. The app shows our position and how it changes. There is no bank API. Data arrives by pasting prepared rows into an import box, or by typing into a form.

## Hard constraints

- Static site only: plain HTML, CSS and JavaScript, one page, no build step, no backend.
- All data lives in one private Google Sheet that both of us can edit. The browser reads and writes it with the Google Sheets API after Google sign-in (Google Identity Services, token flow, spreadsheets scope).
- This repo is public. Never put account names, bank names, emails, amounts, the sheet link or id, or any secret in the code, comments, test data, SPEC.md or commit messages. The only configuration in the code is the OAuth client ID, which is public by design. Use obviously fake examples such as "Bank A". Never ask for real accounts or balances; those are entered in the app.
- The sheet link is pasted by each user on first run and stored only in that device's localStorage.
- Mobile first: iPhone Safari and a home-screen web app. English only.

## Look: "Neon Prism"

Dark, neon, futuristic. Page background near black with a violet tint. Panels `#12101C` with 1px borders `#262238` and about 24px radius. Text `#F2F0FA`, muted text `#A6A1BD`. One violet neon accent. Positive changes in green `#5BE3A7`, negative in a warm red. Space Grotesk for text, JetBrains Mono for small uppercase labels and for numbers. Very large headline numbers. Cards instead of tables. A fixed bottom tab bar with large tap targets. Respect the iPhone safe areas.

## Data model

Create these tabs with these exact headers if they are missing; never overwrite existing rows.

| Tab | Headers |
|---|---|
| Accounts | id, nickname, institution, country, currency, owner, type, updater, update_day, update_month, linked_account, monthly_payment, active, notes |
| Snapshots | id, month, account_id, amount, currency, as_of_date, entered_by, entered_at, source |
| Holdings | month, account_id, holding, amount, currency |
| Goals | id, name, target_amount, currency, account_ids, active |
| Rates | month, usd_ils, eur_ils |
| Settings | key, value |

Rules:

- `Accounts.id` is a short unique slug. `owner` is one of the two person names from Settings, or `Joint`.
- `type` is one of: current, savings, investment, crypto, long_term, loan, home, card.
- `currency` is ILS, USD or EUR.
- `updater` is the person responsible for updating that account. `update_day` is the day of month it is due. `update_month` is only for type home, which is due once a year.
- `linked_account` is only for cards (the account id that pays the card), for display only. `monthly_payment` is only for loans.
- `month` is always YYYY-MM. For balances it is the month the balance was captured; for cards it is the charge month.
- `amount` is always positive. There is at most one snapshot per account per month. `source` is import or manual.

## How totals work

- Reachable money = the sum of all current accounts. This is the headline number.
- Long-term total = current + savings + investment + crypto + long_term + home − loan.
- Cards are spending only. They never affect either total.
- The display currency can be ILS (default), USD or EUR, chosen with a toggle remembered on the device. Each amount converts from its own currency using that month's row in Rates; the current month uses the row whose month is latest. Convert between USD and EUR through ILS.
- Rates come from GOOGLEFINANCE formulas written into the sheet, so no outside service is needed. The latest row stays a live formula. A past month uses the last available rate on or before month end (robust to weekends and holidays), and once it has a valid number it is stored as a plain value so history never shifts. If a rate cannot be obtained, show a notice and let the user type it.
- Changes ("vs previous month", "since the first month of the year", per-type and goal changes) convert both months at the rate of the later month, so a pure exchange-rate move shows as no change. Totals themselves, and the Trends charts, still convert each month at its own rate.
- Gaps: if an active account has no snapshot for a month, do not carry the old value forward. Mark that month's totals as incomplete and list the missing accounts. The only exception is type home, which carries its last value forward.

## Decision notes (final choices, and what was rejected)

Do not reintroduce the rejected options. If anything else in this spec seems to conflict with these notes, the notes win.

1. Storage: rejected browser-only storage and an encrypted file in a repo. Final: one private Google Sheet with Google sign-in. Never a published or link-shared sheet, never an API key.
2. Transactions: rejected importing transactions and categories. Final: one balance per account per month, and one total per card per month.
3. Data entry: banks offer no file export. Rejected reading screenshots inside the app (no OCR, no AI calls from the app). Final: rows prepared outside the app, pasted into an import box with preview and approval, plus a manual form.
4. Cards: rejected a second "unpaid balance" figure and rejected reducing net worth by card charges. Final: one monthly total per card, spending only. Card figures come only from the card company; card lines shown inside bank apps are ignored to avoid double counting.
5. Dating: rejected "every balance counts as month-end". Final: each account has its own update_day; a snapshot is filed under the month it was captured in, with the exact as_of_date stored. Cards are filed under the charge month.
6. Reminders: rejected phone notifications. Final: only a personal "due now" list inside the app.
7. Missed months: rejected carrying the last value forward. Final: a gap, with the month marked incomplete. The home is the only exception.
8. Reachable money: rejected including savings or investments. Final: current accounts only. Instant-access savings products are type savings.
9. Headline: rejected full net worth as the headline. Final: reachable money on top, long-term total beneath.
10. Investments and crypto: split by holding is postponed. Final: one total per account for now; keep the Holdings tab and keep the code ready for the split. Crypto is its own type and is never split by coin.
11. Pension, provident and study funds are one type: long_term.
12. Home: an asset in the long-term total, as a manual estimate updated once a year. Never part of reachable money.
13. Loans: remaining balance plus monthly payment only. No end dates or schedules.
14. Exchange-rate effect: *(revised after Stage 4, see "Changes agreed after the plan" 2)* changes exclude currency movement. Comparisons convert both months at the same rate, so only real changes in value show; the exchange-rate effect is not shown separately.
15. Per-person view: rejected splitting joint accounts 50/50. Final: three groups, the two people and Joint. Everything is visible to both users; no private accounts.
16. Joint accounts are always updated by one person, set in the updater field.
17. Corrections: edited directly in the app. No change history.
18. Goals: several goals with target amounts, progress taken from linked accounts. No target dates, no manual progress.
19. Backup: Google's version history. No export, no automatic copies.
20. Small balances: track everything, no minimum threshold.
21. History: card totals go back to January of this year; balances start from the first month entered. Screens must cope with months that have card data but no balances.
22. Security: Face ID is a screen lock on top of Google sign-in, not a replacement. A hide-amounts button exists; amounts are visible by default.
23. Language and currency: English only. Opens in ILS, toggle to USD and EUR.
24. Charts open on this year.

## Stage 1: Foundation — built

1. Save this specification as SPEC.md and keep it up to date in every stage.
2. Walk through the Google Cloud setup one step at a time: create a project, enable the Sheets API, configure the consent screen in testing mode with two test users, and create a web client ID with the GitHub Pages origin as the allowed JavaScript origin. Then ask for the client ID.
3. Sign-in screen. After sign-in, on first run ask for the sheet link, check that the signed-in account can edit it, and create any missing tabs.
4. Settings screen: the two people's display names and Google emails, and the default display currency. The signed-in email decides which person "I" am. If the email matches neither person, show a clear message and no data.
5. Accounts screen: list accounts grouped by institution; add, edit and deactivate an account with a form that shows only the fields that apply to the chosen type.
6. Bulk add on the Accounts screen: a text box that accepts one account per line in the form
   `id | nickname | institution | country | currency | owner | type | updater | update_day | linked_account`
   Show a preview with problems highlighted (duplicate id, unknown type, unknown owner) and write only after approval.
7. Bottom tab bar with Overview, Accounts, Cards, Trends and More. Overview, Cards and Trends are placeholders for now. Settings lives under More.
8. Handle ordinary failures gracefully: expired sign-in (ask again without losing what was typed), no connection, no permission on the sheet.
9. Explain how to turn on GitHub Pages for this repo, and merge to main so the live site updates.

## Stage 2: Getting data in, and the Overview — built

1. Import box under a clear "Update" entry point. Rows are pasted one per line in the form
   `month | account_id | amount | currency | as_of_date`
   Show a preview before anything is saved: account nickname, new amount, previous month's amount, and the change. Flag unknown account ids, a currency different from the account's, malformed lines, and bad months. Highlight unusually large changes (more than 25 percent and more than a trivial amount). If a snapshot already exists for that account and month, say the row will replace it. Allow editing or removing rows in the preview. Write only after approval, with entered_by, entered_at and source = import.
2. Manual form in the same place: account (mine and joint first, with a way to see all), month (default the current month), amount, as-of date. Saved with source = manual.
3. A "Copy account list" button that copies every active account as lines of: `id | nickname | currency | owner`.
4. Exchange rates as described above.
5. Overview screen: reachable money in very large type; the long-term total beneath it; the currency toggle; "what changed" for both numbers against the previous month and against the first month of this year that has data, as an amount and a percentage; a breakdown by type as cards with totals and shares; a month selector defaulting to the latest month with snapshots; and the incomplete-month marking.

## Stage 3: Accounts, cards, loans and trends — built

1. Accounts screen upgraded: each account shows its latest balance, the change from the previous month, and when it was last updated. Group by institution, by country, or by owner. Grouping by owner shows exactly three groups, the two people and Joint, each with a subtotal. Show the original currency small beside converted amounts.
2. Account detail: month-by-month history with a small chart; edit or delete any snapshot.
3. Cards screen: for each card, the monthly total for the selected month, a bar chart of this year's monthly totals, and the average; a combined total for all cards per month; a split by owner; and which bank account pays each card.
4. Loans: show remaining balance and monthly payment, plus a "fixed monthly commitments" figure summing monthly_payment across active loans.
5. Long-term view: savings, investments, crypto, long-term savings and the home, each with its total, share and change.
6. Trends screen: line charts for reachable money and the long-term total, and a stacked view by type. Default period is this year, with options for the last 12 months and all history. Draw incomplete months differently so a gap is never mistaken for a drop. Charts follow the currency toggle, converting each month with its own rate. One small charting library from a public CDN, or SVG.

## Stage 4: Goals, due list, Face ID and privacy — built

1. Goals: several goals, each with a name, target amount, currency and one or more linked accounts. Progress is calculated from the latest balances of the linked accounts. Show a progress bar, the amount remaining and the change since last month. Warn if an account is linked to two goals, but allow it.
2. "Due now" list: for the signed-in person, the accounts they are the updater for whose update_day has passed this month with no snapshot yet. Mark unfilled earlier months as overdue. Type home is due once a year in its update_month. Show the list at the top of the Overview when not empty, with a count badge on Update. Tapping an item opens the manual form.
3. Face ID lock: use the WebAuthn platform authenticator so each phone can require Face ID when the app opens or returns from the background after a few minutes. Enabled once per device in Settings. Say honestly in Settings that this is a screen lock, and that the real protection is the private sheet and Google sign-in. Hide the option on unsupported devices. Always leave a way back in through Google sign-in.
4. Hide amounts: an eye button in the header that replaces every amount with dots, including chart labels and tooltips, remembered on the device.
5. Home-screen app: a web app manifest, a generic Neon Prism icon and the right meta tags, so it opens full screen from the iPhone home screen. The icon and name reveal nothing personal.
6. Final pass: check every screen at iPhone width, add helpful empty states for an empty sheet, and search the repo for any personal data and remove it.

## Changes agreed after the plan

1. **Banks tab** (requested after Stage 4): the tab bar is now Overview, Accounts, **Banks**, Cards, Trends, More. Banks shows, per institution, the net total of the latest balances (loans subtracted, cards excluded), the change (each account's latest month against its own previous month, added up), every account with its **update status for the current month**, and a line chart of the bank's monthly net for this year. Status colours: green = updated this month (with the as-of date), orange = due (update_day has passed, no snapshot yet), grey = not due yet. A home is yearly (due from update_month/update_day). The top card shows the overall net, "N of M updated" for the month (homes not yet due are left out of the count), and an Update button when something is due. Tapping an account opens its detail.

2. **Changes exclude currency moves** (requested after Stage 4, replacing decision note 14). The Overview's "vs" and "since" lines and the Long-term view changes compute the earlier month's totals at the selected month's rate. A goal's change converts each account's previous balance at the rate of its latest month. Account, bank and import-preview changes were already in each account's own currency. Example: a home entered as €120,000 in January shows no change in October, even though the euro rose.

## How to work

Build one stage at a time. After each stage: update SPEC.md, commit, merge to main, and give a plain-language test checklist. Wait for the go-ahead before the next stage.

---

## Implementation notes (kept up to date)

### Files

| File | Role |
|---|---|
| `index.html` | The single page. Loads fonts, Google Identity Services and the scripts below. |
| `css/app.css` | Neon Prism styles. Colour tokens live on `:root`. |
| `js/config.js` | The only configuration: `GOOGLE_CLIENT_ID` (public by design). |
| `js/calc.js` | Pure calculations with no screen code: months and dates, amounts, exchange-rate lookup and conversion, monthly totals, gaps, import checks. |
| `js/charts.js` | Small SVG charts (line with gaps and incomplete months, bars with an average line, stacked bars) and their tap/hover readout. No library. |
| `js/sheets.js` | Thin Google Sheets API layer: read a tab as objects, append, update rows by id, create missing tabs and headers, check edit access. |
| `js/app.js` | Sign-in, routing between tabs, screens and forms. |
| `manifest.webmanifest`, `icons/` | Home-screen web app metadata and a generic icon (finished in Stage 4). |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are. |

### Hosting

Every script and stylesheet is loaded with `?v=<APP_VERSION>`, and `APP_VERSION` (in `js/app.js`, shown at the bottom of More) is bumped with each change. That way phones, including home-screen apps, fetch the new files instead of a saved copy.

GitHub Pages serves the `main` branch root. The allowed JavaScript origin for the OAuth client is the Pages origin (`https://<github-user>.github.io`, lowercase, no path).

### Device storage (localStorage, never in the repo)

- `fd.sheetId` — the spreadsheet id parsed from the pasted link.
- `fd.token` — the current Google access token, its expiry (about one hour) and the signed-in email.
- `fd.lastEmail` — used as a sign-in hint next time.
- `fd.hideAmounts` — "1" when amounts are hidden on this device.
- `fd.lockCred` — the id of this phone's Face ID (WebAuthn) credential when the lock is on.
- `fd.acctGroup` — the Accounts grouping (institution, country or owner).
- `fd.displayCurrency` — the display currency chosen with the toggle (starts from Settings `default_currency`).

### Settings tab keys

| key | meaning |
|---|---|
| `person1_name`, `person1_email` | First person's display name and Google email |
| `person2_name`, `person2_email` | Second person's display name and Google email |
| `default_currency` | ILS, USD or EUR |

When no person is configured yet, the first signed-in user is asked to set up both people (their own email must be one of the two). After that, an email that matches neither person sees a "not recognised" message and no data. Owner and updater store the person's display name; renaming a person in Settings updates those fields in Accounts.

### Sheet handling

- Each tab is read by header name, so column order in the sheet does not matter and extra columns are preserved.
- If a tab is missing it is created with its header row. If a tab exists but lacks some expected headers, they are added at the end of row 1. Existing rows are never overwritten.
- Edit permission is checked once, when the sheet is first connected, by rewriting the spreadsheet's own title with the same value (a no-op that fails for view-only users).
- Account ids cannot be changed after creation, because snapshots refer to them. Accounts are deactivated (`active` = FALSE), never deleted.

### Failure handling

- Expired sign-in during an action: a "Sign in again" panel appears over the current screen; after signing in, the action is retried. Open forms keep their contents. Signing in as a different account reloads the app.
- No connection: an offline banner appears; actions fail with a plain message and forms keep their contents.
- No permission: the connect screen explains whether the sheet was not found, not shared, or view-only.

### Update screen (Stage 2)

- Reached from the **Update** button at the top of the Overview (Stage 4 adds the "due" count badge to it). It has two modes: **Paste rows** and **One balance**.
- Import preview checks: unknown account id; currency different from the account's; malformed line (not 3–5 columns); bad month (not YYYY-MM, or in the future; cards may use next month as their charge month); amount not a number or negative; bad or future as-of date; the same account and month twice in one paste. These rows are skipped. Shown but not blocking: "Replaces" an existing snapshot, "Large change", an as-of date outside the month, an inactive account, and a missing as-of date (then the month's last day is used, or today for the current month).
- Large change = more than 25% **and** more than 1,000 ILS (converted) away from the previous calendar month.
- Rows can be edited (opens a small form) or removed in the preview. Approving re-reads the sheet first, so a balance a partner saved meanwhile is replaced rather than duplicated.
- Saving: a snapshot for the same account and month is updated in place (keeping its id); otherwise a row is appended with a new random id. `entered_by` is the signed-in person's name, `entered_at` an ISO timestamp, `source` is import or manual.
- One balance: accounts owned by me, updated by me, or Joint come first; "Show all accounts" adds the rest. It shows the previous month's value, whether a value is being replaced, and the change; a large change asks for a second tap.
- **Copy account list** copies every active account as `id | nickname | currency | owner`, for preparing import rows outside the app.

### Exchange rates (Stage 2)

- The Rates tab gets a row for every month that has snapshots, plus the current month. It is checked each time the app opens and after each save.
- Current month: `=GOOGLEFINANCE("CURRENCY:USDILS")` (and EURILS), kept live.
- Past months: a formula that takes the last daily rate on or before the month's last day (looks back 10 days, so weekends and holidays are covered). Once it shows a valid number, the app replaces the formula with that plain number. A month whose live formula is left over from when it was current is switched to the month-end formula.
- A typed number is never overwritten. If a rate shows an error, the Overview shows a "rate missing" notice where it can be typed in.
- If the sheet's locale needs `;` between formula arguments, the app switches automatically after the first parse error.
- Converting: each amount goes through ILS using its month's rate. Months from the latest Rates row onward use the latest row. A past month without a valid rate uses the nearest earlier valid month, or failing that the nearest later one. Accounts that still can't be converted are left out, and the month is marked incomplete.

### Totals and gaps (Stage 2)

- Totals use every account with a snapshot that month, including inactive ones (they existed then). Cards never count; their monthly total is shown separately as spending.
- An active non-card account is **expected** from the month of its first snapshot onward. An account with no snapshots yet is expected from the latest month with balances. A missing expected balance marks the month incomplete and lists the account. An active home carries its last earlier value forward instead.
- Overview: the month selector lists every month with any snapshot (card-only months are labelled). It defaults to the latest month with balances. Comparisons are against the previous calendar month and against the first month of the same year with balances, as amount and percentage, flagged when the other month is incomplete. Type cards show each type's total and share of assets (current, savings, investment, crypto, long_term, home); loans are shown as owed and subtracted.

### Accounts, detail, cards, loans and trends (Stage 3)

- **Accounts:** each account shows its latest balance converted with its own month's rate, the original amount in small type when the currency differs, the change from the previous calendar month (in the account's currency), and "upd <as-of date>". Loans show as negative. Cards show their latest monthly total.
- **Grouping:** Bank, Country or Owner. Owner always shows exactly three groups (person 1, person 2, Joint); an unrecognised owner falls into Joint. Each group has a **net** subtotal (latest balances, loans subtracted, cards left out).
- **Account detail** (tap an account): latest value, change, loan payment or the card's paying account, a chart of the history (line for balances, bars for cards, in the account's own currency), the full month list with **Edit** (amount and as-of date) and **Delete** for each snapshot, plus "Add balance" and "Edit account". Before an edit or delete, the snapshot is found again after a fresh read (by id, or by account and month) so a moved row is never touched.
- **Cards:** month selector over months with card totals. Shows the combined total for the month (display currency) with a bar chart of this year and the average over months with data; the cards missing that month; a split by owner (three groups); and for each card its month total, its yearly bars and average in its own currency, and the account that pays it.
- **Overview additions:** "Long-term view" cards for savings, investment, crypto, long_term and home with total, share of assets and change vs the previous month; a "Loans" card listing each active loan's remaining balance (for the selected month, else its latest) and monthly payment, and **fixed monthly commitments** = the sum of monthly_payment over active loans, converted at the latest rate.
- **Trends:** period This year (default) / 12 months / All. Line charts for reachable money and the long-term total; stacked bars by type with loans drawn below zero. Months with missing balances get hollow dots and dashed segments; months with no balances leave a gap. Each month is converted at its own rate, and tapping a month shows its values.
- **Chart colours:** the type colours are fixed per type (never reassigned) and were validated as a set against the panel colour for colour-blind separation and contrast. Text never uses the series colour; a legend always accompanies the stacked chart.

### Goals, due list, Face ID and privacy (Stage 4)

- **Goals** live under More → Goals, and active goals also appear at the bottom of the Overview. A goal stores `account_ids` as a comma-separated list. Progress = the sum of each linked account's latest balance, converted to the goal's currency at that balance's month rate; a linked loan counts as negative. The screen shows a progress bar, the amount remaining (or "reached") and the change since last month. That change adds up each linked account's move from its previous month to its latest month, counting only accounts that have both. Cards can't be linked. Linking an account that is already in another active goal shows "Also in: …" but is allowed. Goals are deactivated, never deleted.
- **Due now** (top of the Overview, with a count badge on Update) is personal: it only lists accounts whose `updater` is the signed-in person.
  - Monthly accounts are due this month once `update_day` has passed (clamped to the month's length) with no snapshot. Every earlier month since the account's first snapshot that is still empty is **overdue**.
  - A home is due once a year, from `update_month`/`update_day`. A snapshot in that month or later in the year clears it.
  - The first three items are shown, and the rest sit behind "Show all". Tapping an item opens the One balance form with the account and month filled in, and the as-of date set to today (or the month's last day for a past month).
- **Face ID lock:** turned on per phone in More, and only offered when the phone has a platform authenticator. It creates a WebAuthn credential (`userVerification: required`, attestation none) and stores only its id. The lock covers the whole screen when the app opens with a valid session, and when it returns after more than 3 minutes in the background. Unlocking asks Face ID via `navigator.credentials.get`. "Sign in with Google instead" always works, and any successful Google sign-in removes the lock. Settings states plainly that this is a screen lock and that the real protection is the private sheet and Google sign-in.
- **Hide amounts:** an eye button in every page header (and a toggle in More), remembered on the device. Every formatted amount, chart tick and chart readout becomes dots. Percentages stay visible.
- **Home-screen app:** `manifest.webmanifest` (name "Finance", standalone, dark colours), a generic SVG icon plus 180px and 512px PNGs, and iOS meta tags for full-screen launch. Nothing personal is in the name or icon.
- **Final pass:** every screen was checked at 375px wide with no sideways scrolling (the currency switch sits under the header on Accounts, Cards and Trends). Empty states were checked on an empty sheet (Overview, Accounts, Cards, Trends, Goals, the Update form). The repository and its full history were searched for personal data and none was found.
