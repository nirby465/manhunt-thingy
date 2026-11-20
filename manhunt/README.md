# Manhunt

Real-life GPS hide-and-seek as an installable web app (PWA). The host makes a game and shares a code or link, players join, and everyone gets the live map and the full rules on one screen.

- **Frontend:** plain HTML/CSS/JS in `public/` (no build step). Map by Leaflet + OpenStreetMap/CARTO tiles.
- **Backend:** one Vercel serverless function, `api/game.js`. All game rules live in `lib/engine.js`.
- **Storage:** Upstash Redis (free tier works). Games expire 2 days after the last activity.

## Put it online (about 5 minutes)

1. Create a free GitHub repo and upload this folder (or run `vercel` from it).
2. On [vercel.com](https://vercel.com): **Add New > Project**, import the repo, and deploy. No settings to change.
3. In the Vercel project: **Storage > Create Database > Upstash Redis** (free plan), connect it to the project, then **Redeploy**. This adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables the app reads.
4. Open `https://YOUR-PROJECT.vercel.app/api/game`. It should say `"storage":"upstash"`. If it says `"memory"`, the database is not connected yet and games will not work reliably.
5. Share `https://YOUR-PROJECT.vercel.app`. Hosts get a 5-character code and an invite link (`/?code=ABCDE`).

Without step 3 the app still loads, but each serverless request can land on a different instance, so players will see "game not found".

## Run it locally

```
node dev-server.js     # http://localhost:3000 (in-memory storage)
npm test               # 15 rule and API tests
```

Phones need HTTPS for GPS, so for real play use the Vercel link. `localhost` also counts as secure on the same computer.

## How the rules map to the app

| Ruleset item | Where |
|---|---|
| Head start (5 min), pings (5 min), seekers (1), when caught (out) | Lobby > Game / Pings |
| Ping slider, Live up to 15 min | Lobby > Pings |
| Out when tagged / Zombie | Lobby > Game > Mode |
| Zones, Shrinking, Moving | Lobby > Play area (draw a circle or trace streets) |
| Safe zones + Personal safe zones | Lobby > Safe zones |
| Ability drops | Lobby > Ability drops & points |
| Reveal, Bounty (threshold 2, 15 min, reward 1, safe-zone / ability toggles) | Lobby > Reveal mode / Bounty mode |
| The 10 spendable abilities | Lobby > Player abilities (toggle, cost, duration each) |

Every number is a host slider and every mode or ability has an on/off switch. The **Rules** tab in the game is generated from the host's settings, so it always matches the game being played, and on a tablet or desktop it sits next to the map.

## Things to know

- **"Allow all the time" location:** a website cannot request background location. Browsers pause GPS when the page is hidden or the screen locks. Manhunt asks for location on the first tap, keeps the screen awake while you play, and works best installed to the home screen. For play with phones in pockets, keep the app open and the screen on.
- **Boundary:** each player has a configurable grace time outside the line (default 60 s). Seekers who exceed it are eliminated. Hiders are out in "out when tagged" mode and become seekers in Zombie mode.
- **Tagging:** a seeker taps TAG within the tag distance (default 25 m). Safe zones, Immunity Shield and post-revive protection block it. Hiders can also tap "I was tagged".
- **Upstash free tier:** each phone syncs every 3.5 s, about 4 Redis commands each time. A 10-player game uses roughly 40k commands per hour, so the free monthly allowance covers about 12 hours of play. Raise `setInterval(syncOnce, 3500)` in `public/app.js` to save commands.
- **Fair play:** locations are checked on the server and only the allowed information is sent to each player, so hiders' positions are not exposed in network traffic.

## Files

```
public/        index.html, styles.css, app.js, geo.js, sw.js, manifest, icons
api/game.js    the only endpoint (POST actions: create, join, sync, settings, start, tag, ...)
lib/engine.js  game rules, abilities, visibility
lib/store.js   Upstash Redis (REST) with in-memory fallback
test/          rule and API tests
vercel.json    headers and function settings
```
