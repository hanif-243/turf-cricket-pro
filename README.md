# Turf Cricket Pro

A mobile-first live cricket scoring app for friendly turf matches. It's a static web app with no build step, no sign-in, and no server. It works offline, installs to the phone's home screen, and stores everything on the phone.

## Features

- **Teams**: saved rosters with captain, wicketkeeper and a default playing XI. Player career stats are available from 📊 on each player.
- **Match setup**: overs (5–20 or custom), players per side (5–11 or custom), max overs per bowler, and ball type. Custom rules cover wide/no-ball run values, free hit and last man stands. You can also turn on a Super Over for ties. Setup includes the toss, and you can pick players from saved teams or type names.
- **Live scoring**: one-tap 0/1/2/3/4/6, WD, NB, BYE, LB, OUT and Undo.
  - **Dialogs**: detailed ones for no-balls (bat/byes/leg byes), runs off wides, and every dismissal (fielder, who's out, runs completed, wicket on a wide or no-ball).
  - **Scoreboard**: score, overs (`7.4` = 7 overs and 4 balls), run rate, target, runs needed, balls left, required rate, a free-hit badge, the last 6 balls, and the current partnership.
  - **Prompts**: the next batter after a wicket and the next bowler at each over end. Consecutive overs and the max-overs limit are enforced.
  - **Match options**: change bowler mid-over, retire hurt or out, score correction (with confirmation), pause/resume, end innings, reset innings (type RESET), abandon.
- **Results**: automatic innings change, target = first-innings total + 1, won by runs / won by wickets (with balls left), ties, optional Super Over, and abandoned matches with no result.
- **Scorecard**: batting, bowling, extras, fall of wickets, partnerships, best batter and best bowler, and a Player of the Match picker.
  - **Sharing**: share text, copy the full scorecard, a 1080×1350 scorecard image, CSV export, a match file (JSON), and Rematch.
- **History and statistics**: every match is saved after each ball. Stats cover team W/L/win %, highest total, highest score, best bowling, most runs, wickets, fours and sixes, top-5 lists, and head-to-head.
- **Backup**: export or import all data as JSON (Home → ⚙). Use this to move matches to another phone.

## File structure

```
turf-cricket-pro/
├── index.html             App shell + bottom navigation
├── css/styles.css         Mobile-first light theme (royal-blue header band, white cards)
├── js/engine.js           Scoring engine: pure, no DOM, runs in browser and Node
├── js/storage.js          localStorage persistence (one key per match + index)
├── js/app.js              UI: router, screens, dialogs, exports
├── sw.js                  Service worker (offline cache)
├── manifest.webmanifest   Home-screen install metadata
├── icons/                 App icons (SVG + 192/512 PNG)
├── tests/engine.test.js   43 tests for the scoring engine and storage
└── package.json           `npm test`, `npm start`
```

## Architecture

- **Event-sourced scoring.** A match is `config` plus an ordered list of events (`start_innings`, `ball`, `set_bowler`, `new_batter`, `swap_strike`, `retire`, `adjust`, `end_innings`, `start_super_over`, `abandon`). Every score, statistic, partnership and result is rebuilt by replaying those events through `engine.js`. As a result:
  - **Undo** removes the last action and replays it. Score, wickets, balls, overs, extras, batter and bowler figures, strike, partnerships and recent balls all revert exactly. A bowler or batter selection made after a ball is removed together with that ball.
  - **Reload / restore** is the same replay, so a reloaded match is identical to the live one.
  - **Invalid input is rejected before saving.** Examples include a bowled dismissal on a no-ball, a non-striker being caught, a bowler bowling consecutive overs, and a wicket on a free hit. The scorer sees a clear message instead.
- **The engine is separate from the UI** (`js/engine.js` has no DOM access), so it can be tested on its own.
- **Storage**: each match is saved under its own key after every event, so a ball never rewrites all your data. If storage is blocked (some private browsing modes), the app warns you.

### Scoring rules implemented

| Situation | Team | Batter | Bowler | Legal ball? |
|---|---|---|---|---|
| Runs off the bat | +runs | +runs, +1 ball | +runs | yes |
| Wide (+ runs taken) | +1 + runs (all wides) | no ball faced | +1 + runs | no |
| No-ball off the bat | +1 + runs | +runs, +1 ball | +1 + runs | no |
| No-ball + byes/leg byes | +1 + runs | +1 ball | +1 only | no |
| Byes / leg byes | +runs | +1 ball | 0 (dot) | yes |
| Bowled / caught / lbw / stumped / hit wicket | – | out | wicket credited | – |
| Run out / obstructing / retired out | – | out | **not** credited | – |

Odd runs completed change the strike. Strike also changes at the end of each over, and the batter who took a single off the last ball keeps the strike. A maiden is an over in which the bowler concedes 0 runs; byes and leg byes don't count against the bowler. Wide and no-ball run values are configurable.

## Run the tests

```bash
npm test
```

## Run locally

```bash
python -m http.server 8090
```

Then open http://localhost:8090. Opening `index.html` directly also works, except for offline caching.

## Deploy to GitHub Pages (free)

1. Create a new public repository on GitHub, for example `turf-cricket-pro`.
2. Upload the **contents** of this folder to the repository root (`index.html` must be at the top level). Either drag the files into "Add file → Upload files" on github.com, or run:
   ```bash
   git init && git add . && git commit -m "Turf Cricket Pro" && git branch -M main
   git remote add origin https://github.com/<you>/turf-cricket-pro.git && git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. After about a minute, the app is live at `https://<you>.github.io/turf-cricket-pro/`.

When you ship changes, bump `CACHE` in `sw.js` (for example `tcp-v2`) so installed phones pick up the new files.

## Put it on your phone

**Android (Chrome)**
1. Open your GitHub Pages URL in Chrome.
2. Tap **⋮ → Add to Home screen** (or **Install app**), then **Install**.
3. Launch it from the home-screen icon. It opens full-screen and works without internet at the ground.

**iPhone (Safari)**
1. Open the URL in Safari.
2. Tap **Share → Add to Home Screen → Add**.

Tip: open the app once while online after installing, so the offline cache is filled.

## Data and multiple phones

This version is **single-device**: data lives in the browser storage of the phone that scores the match. There is no account and nothing is uploaded. To move data between phones, use **Export backup** and **Import backup** (Home → ⚙), or **Save match file** on a scorecard. Clearing browser data for the site deletes your matches, so export backups regularly.

**Real-time scoring from several phones** is not included. The event-sourced design is ready for it: each event has a unique ID, and replay is deterministic. To add it, you'd store events in Firebase Firestore or Supabase, with security rules that only accept appends in order (a per-match sequence number checked in a transaction). Phones would subscribe to the event list and replay it. Don't put service secrets in this frontend; use the provider's public client keys plus server-side rules.
