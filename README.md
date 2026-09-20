# ORBYT — Telegram Mini App

A monochrome (black & white) Telegram Mini App set in deep space. ORBYT is a
mobile-first, horizontally paged experience: a **Home** dashboard, a **Quests**
page and a **Wallet** page, linked by a bubble navigation dock and an animated
back arrow. Tapping and swiping ripple across the UI, and a rocket mini-game
lets you launch off Earth and explore the solar system while dodging space
debris.

## Highlights

- **Horizontal paged deck** — Home / Quests / Wallet slide sideways; a bubble
  nav dock plus an animated back arrow move you between them.
- **Username chip** top-right, synced from Telegram.
- **Tap & swipe ripples** — every interaction blooms a bubble ripple; haptics
  fire through the Telegram SDK.
- **Daily check-in streak** — one tap a day, +10 points per day, with a 7-day
  heatmap.
- **Streak milestones** — reach 10, 20, 30 … 100-day streaks and claim a bonus
  equal to the milestone (a 10-day streak pays +10, etc.).
- **Rocket exploration game** — a realistic, sparse solar system: a tiny rocket,
  a small Earth, and distant planets. No cluttered X/Y HUD — just a compact
  speed read-out, a heart life bar, and a compass to the next planet. Reach a
  planet to "discover" it and share a generated snapshot.
- **Hazards** — satellites, the Moon, asteroids and shooting stars drift through
  space. Colliding with a satellite or asteroid costs **one life**, and the
  rocket explodes when lives run out (with a launch shake + vibration on
  lift-off).
- **Lives & repair** — 3 lives per run, auto-repairing **1 life per hour** up to
  the max.
- **Boosts** — speed bursts, capped at **3 free per day**; buy more in the store.
- **Store (Telegram Stars)** — 1 boost = 5 ⭐, 3 boosts = 12 ⭐, plus life packs
  (1 life = 5 ⭐, full hull = 12 ⭐).
- **Settings** — swipe sensitivity and cruise-speed sliders.
- **TON Wallet** connect card (demo) and Telegram theme sync, fullscreen expand,
  signed initData.

```
orbyt/
  backend/
    main.py          FastAPI app: initData validation + streak / game / store API + serves the UI
    tasks.json       editable quest catalogue
    game.json        editable game rewards
    requirements.txt
  frontend/
    index.html       horizontal deck + game overlay
    styles.css       monochrome theme, ripples, panels, milestones, store, game HUD
    app.js           Telegram SDK + navigation + API calls + tap FX
    game.js          rocket physics, hazards, snapshot & share
```

## Run locally (dev mode)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000 in a browser. With no `BOT_TOKEN` set the server
runs in **DEV mode** — it trusts a demo user so you can click around without
Telegram. The UI shows a "dev mode" note so you never ship it by accident.

## Go live with a real bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Set the token and start the server (behind HTTPS — Telegram requires it):
   ```bash
   export BOT_TOKEN="123456:ABC..."
   uvicorn main:app --host 127.0.0.1 --port 8000
   ```
   Put a reverse proxy (nginx / Caddy) with a valid TLS cert in front, or
   deploy to any host that gives you HTTPS.
3. In BotFather run `/newapp` (or `/setmenubutton`) and point the Mini App /
   menu button URL at your public HTTPS address.
4. Open the bot in Telegram → launch the Mini App. It will now validate the
   signed `initData`, so every streak is tied to the real Telegram user id.

## Security notes

- **initData is verified** with HMAC-SHA256 against your bot token, plus a 24h
  freshness check. Requests with a bad or missing signature get `401`.
- Never expose the server publicly **without** `BOT_TOKEN` set — dev mode is
  for local testing only.
- The server binds to `127.0.0.1`; terminate TLS in your own proxy.
- Data is stored in a local SQLite DB by default; point `DATABASE_URL` at a
  Postgres instance for production scale (the included `render.yaml` wires this
  up automatically).

## Telegram Stars (production)

The store tracks a **demo** Star balance server-side (every account starts with
~50) so the full buy flow works offline. To charge real Telegram Stars, replace
the balance check in `/api/store/buy` with a Telegram invoice: call
`tg.openInvoice(...)` on the client, verify the payment in a bot webhook, and
grant the item on success. The rest of the resource logic (boosts, lives,
repair timers) stays the same.

## Real TON wallet (production)

The wallet button ships as a **demo** that generates a TON-style address so you
can see the full flow offline. To connect real wallets, drop in TON Connect:

1. Host a `tonconnect-manifest.json` (name, url, icon) at your public URL.
2. Add the TON Connect UI SDK in `index.html`.
3. Replace the demo branch in the wallet handler (`app.js`) with a real
   `TonConnectUI` connect call, then POST `wallet.account.address` to
   `/api/wallet` as today. The backend already stores whatever address you POST,
   so no server change is needed.

## Customize

- Colors / theme: CSS variables at the top of `styles.css`.
- Quests: `backend/tasks.json` (title, hint, reward, kind).
- Game rewards: `backend/game.json`.
- Lives / boosts / store prices: the constants near the top of the resource
  section in `backend/main.py` (`LIVES_MAX`, `REPAIR_SECONDS`,
  `FREE_BOOSTS_PER_DAY`, `STORE`).
