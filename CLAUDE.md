# Working rules for this repo

A private finance dashboard for two people: one static page (plain HTML, CSS and JavaScript, no build step, no libraries) that reads and writes a private Google Sheet after Google sign-in. The live site is GitHub Pages, served from the `main` branch.

**Read [SPEC.md](SPEC.md) first.** It holds the full specification, the decisions and every change agreed so far ("Changes agreed after the plan"), plus implementation notes.

## Privacy: this repo is public

- Never put personal data in code, comments, test data, SPEC.md, commit messages or pull requests: the two people's names, account or bank names, emails, amounts, the sheet link or id, or any secret. The people's names come from the sheet's Settings tab when the app runs.
- Use obviously fake examples ("Bank A", "Alex", "Sam"). Screenshots from the person may show real names and amounts: never copy those into the repo.
- Never ask for real accounts or balances; they are entered in the app.
- The only configuration in the code is the OAuth client ID in `js/config.js`, which is public by design.
- Google sign-in only: never a published or link-shared sheet, never an API key.

## The person you work with

- Not a developer. Write short, plain-language answers without jargon. When a decision is theirs, ask it as a normal question with clear options.
- They use the app on an iPhone (Safari and the home-screen app) and report problems with screenshots.

## Every change

1. Make the change on the working branch.
2. Check it:
   - `node --check` on every changed `js/*.js` file.
   - Logic: quick Node checks against `js/calc.js` (it exports itself under Node).
   - Screens: Chromium with Playwright at 390px wide, with the Sheets API mocked and fake data only.
3. Add a numbered entry to "Changes agreed after the plan" in SPEC.md saying what changed and why, in plain terms. Update the implementation notes when they change.
4. Bump `APP_VERSION` in `js/app.js` and every `?v=` in `index.html` to the same new value (`YYYY.MM.DD-N`). The app compares versions and reloads itself, and the version shows at the bottom of More.
5. Commit, push the branch, then fast-forward `main` to it and push `main`. That publishes the live site.
6. Reply with a short summary and a numbered checklist for the phone, starting with "More → bottom should say <version>".

## Code conventions

- `js/calc.js`: pure calculations, no screen code. `js/app.js`: sign-in, routing, screens and forms. `js/sheets.js`: the Google Sheets API layer. `js/charts.js`: hand-made SVG charts.
- Never overwrite or reorder existing sheet rows, except the row being edited. Missing tabs and header cells are added, never replaced.
- Mobile first: no sideways scrolling at 375px, tap targets of at least 44px, iPhone safe areas respected. Keep the "Neon Prism" look from SPEC.md and reuse the existing CSS classes.
- Shares: in a one-person view, own accounts count in full, joint at 50% and the other person's not at all; the both view counts everything in full. Card and salary accounts hold monthly amounts, not balances.
- Match the surrounding code's style and comment density.
