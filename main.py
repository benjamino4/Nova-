"""
PULSE - Telegram Mini App backend (FastAPI + SQLite).

Endpoints:
  GET  /                 -> serves the mini app frontend
  POST /api/checkin      -> record today's pulse for the user, return streak/total
  GET  /api/stats        -> current streak, total pulses, last 7 days heatmap

Security:
  Telegram sends signed `initData`. We validate it with HMAC-SHA256 using the
  bot token (see validate_init_data). If BOT_TOKEN is unset we fall back to a
  DEV mode that trusts a plain user id -- convenient for local testing only.
  NEVER run without BOT_TOKEN in production.
"""
import hashlib
import hmac
import json
import os
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DB_PATH = Path(os.environ.get("PULSE_DB", BASE_DIR / "pulse.db"))
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
DEV_MODE = not BOT_TOKEN

# When DATABASE_URL is set (e.g. a free cloud Postgres on Render / Neon /
# Supabase) we store progress there so it SURVIVES restarts and redeploys.
# Without it we fall back to a local SQLite file -- fine for local dev, but on
# a free host with no persistent disk that file is wiped on every restart.
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
USE_PG = DATABASE_URL.startswith("postgres")

if USE_PG:
    import psycopg
    from psycopg.rows import dict_row

app = FastAPI(title="ORBYT Mini App")


# --------------------------------------------------------------------------- #
# Database                                                                     #
# --------------------------------------------------------------------------- #
def _translate(sql: str) -> str:
    """Adapt the SQLite-flavoured SQL used below to Postgres when needed."""
    if not USE_PG:
        return sql
    s = sql
    if "INSERT OR IGNORE" in s:
        s = s.replace("INSERT OR IGNORE INTO", "INSERT INTO").rstrip()
        if "ON CONFLICT" not in s:
            s = s + " ON CONFLICT DO NOTHING"
    return s.replace("?", "%s")


class _Conn:
    """Thin wrapper so the same code works on SQLite and Postgres.

    Both back-ends expose .execute(sql, params) -> cursor with
    .fetchone()/.fetchall(), and rows support r["column"] access.
    """

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        return self._raw.execute(_translate(sql), params)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            if not USE_PG:
                self._raw.commit()  # PG connection runs in autocommit mode
        finally:
            self._raw.close()
        return False


def db() -> _Conn:
    if USE_PG:
        url = DATABASE_URL.replace("postgres://", "postgresql://", 1)
        return _Conn(psycopg.connect(url, autocommit=True, row_factory=dict_row))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return _Conn(conn)


def init_db() -> None:
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pulses (
                user_id  TEXT NOT NULL,
                day      TEXT NOT NULL,   -- ISO date YYYY-MM-DD
                ts       INTEGER NOT NULL,
                PRIMARY KEY (user_id, day)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS wallets (
                user_id  TEXT PRIMARY KEY,
                address  TEXT NOT NULL,
                ts       INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS completions (
                user_id  TEXT NOT NULL,
                task_id  TEXT NOT NULL,
                day      TEXT NOT NULL,
                ts       INTEGER NOT NULL,
                PRIMARY KEY (user_id, task_id, day)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS discoveries (
                user_id   TEXT NOT NULL,
                planet_id TEXT NOT NULL,
                ts        INTEGER NOT NULL,
                shared    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, planet_id)
            )
            """
        )
        # Space-explorer resources: daily boosts, repairable lives, star balance.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS game_state (
                user_id      TEXT PRIMARY KEY,
                boost_day    TEXT NOT NULL,
                boost_used   INTEGER NOT NULL DEFAULT 0,
                extra_boosts INTEGER NOT NULL DEFAULT 0,
                lives        INTEGER NOT NULL DEFAULT 3,
                lives_ts     INTEGER NOT NULL,
                stars        INTEGER NOT NULL DEFAULT 50
            )
            """
        )
        # Streak-milestone bonuses the user has already claimed.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS streak_claims (
                user_id   TEXT NOT NULL,
                milestone INTEGER NOT NULL,
                ts        INTEGER NOT NULL,
                PRIMARY KEY (user_id, milestone)
            )
            """
        )


# Daily quest catalogue. Loaded from tasks.json so developers can add / edit
# quests WITHOUT touching Python. See tasks.json for the schema and examples.
TASKS_FILE = BASE_DIR / "backend" / "tasks.json"

DEFAULT_TASKS = [
    {"id": "daily_pulse", "title": "Send your daily pulse", "hint": "Tap the core once a day", "reward": 10, "kind": "pulse"},
    {"id": "streak_3", "title": "Hold a 3-day streak", "hint": "Consistency fuels the void", "reward": 30, "kind": "streak", "target": 3},
    {"id": "connect_wallet", "title": "Connect your TON wallet", "hint": "Link a wallet to collect rewards", "reward": 50, "kind": "wallet"},
    {"id": "share", "title": "Share ORBYT with a friend", "hint": "Spread the signal", "reward": 20, "kind": "link", "repeat": "daily"},
]


def load_tasks() -> list:
    """Read the quest list from tasks.json on every call so edits show up on
    refresh (no server restart needed). Falls back to DEFAULT_TASKS."""
    try:
        with open(TASKS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        tasks = data.get("tasks", data) if isinstance(data, dict) else data
        return tasks if isinstance(tasks, list) and tasks else DEFAULT_TASKS
    except Exception:
        return DEFAULT_TASKS


# Space-explorer reward amounts live in game.json so a developer can tune the
# payouts WITHOUT touching Python. Discovery rewards are deliberately NOT shown
# in the UI -- reaching a planet grants energy as a hidden surprise.
GAME_FILE = BASE_DIR / "backend" / "game.json"
DEFAULT_GAME = {"discover": 75, "share": 40}


def load_game_config() -> dict:
    try:
        with open(GAME_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        r = data.get("rewards", data) if isinstance(data, dict) else {}
        return {
            "discover": int(r.get("discover", DEFAULT_GAME["discover"])),
            "share": int(r.get("share", DEFAULT_GAME["share"])),
        }
    except Exception:
        return dict(DEFAULT_GAME)


init_db()


# --------------------------------------------------------------------------- #
# Telegram initData validation                                                 #
# --------------------------------------------------------------------------- #
def validate_init_data(init_data: str) -> dict:
    """Validate Telegram WebApp initData and return the parsed user dict.

    Raises HTTPException(401) when the signature is invalid.
    """
    if DEV_MODE:
        # Local testing: accept `user_id=<id>` or fall back to a demo user.
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        uid = pairs.get("user_id") or "dev-user"
        return {"id": uid, "first_name": pairs.get("first_name", "Explorer")}

    if not init_data:
        raise HTTPException(status_code=401, detail="missing initData")

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise HTTPException(status_code=401, detail="missing hash")

    data_check_string = "\n".join(
        f"{k}={pairs[k]}" for k in sorted(pairs.keys())
    )
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(calc_hash, received_hash):
        raise HTTPException(status_code=401, detail="invalid signature")

    # Optional freshness check (24h)
    auth_date = int(pairs.get("auth_date", "0"))
    if auth_date and time.time() - auth_date > 86400:
        raise HTTPException(status_code=401, detail="initData expired")

    user_raw = pairs.get("user", "{}")
    try:
        user = json.loads(user_raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=401, detail="bad user payload")
    if "id" not in user:
        raise HTTPException(status_code=401, detail="no user id")
    user["id"] = str(user["id"])
    return user


async def get_user(request: Request) -> dict:
    """Read initData from the X-Init-Data header or JSON body."""
    init_data = request.headers.get("X-Init-Data", "")
    if not init_data and request.method == "POST":
        try:
            body = await request.json()
            init_data = body.get("initData", "") if isinstance(body, dict) else ""
        except Exception:
            init_data = ""
    return validate_init_data(init_data)


# --------------------------------------------------------------------------- #
# Streak logic                                                                 #
# --------------------------------------------------------------------------- #
def today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# --------------------------------------------------------------------------- #
# Space-explorer resources: lives, boosts, stars, streak milestones           #
# --------------------------------------------------------------------------- #
LIVES_MAX = 3
REPAIR_SECONDS = 3600          # +1 life every hour, up to LIVES_MAX
FREE_BOOSTS_PER_DAY = 3
MILESTONES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

# Store catalogue (prices in Telegram Stars). NOTE: this reference build tracks
# a *demo* star balance server-side so the full buy flow works offline. To
# charge real Stars, replace the balance check with a Telegram invoice
# (tg.openInvoice + a bot payment webhook) and grant the item on success.
STORE = {
    "boost1": {"cost": 5, "boosts": 1},
    "boost3": {"cost": 12, "boosts": 3},
    "life1": {"cost": 5, "lives": 1},
    "life3": {"cost": 12, "lives": 3},
}


def _regen_lives(lives: int, lives_ts: int, now: int):
    """Return (lives, lives_ts) after applying hourly repair up to LIVES_MAX."""
    if lives >= LIVES_MAX:
        return LIVES_MAX, now
    gained = (now - lives_ts) // REPAIR_SECONDS
    if gained <= 0:
        return lives, lives_ts
    new_lives = min(LIVES_MAX, lives + gained)
    if new_lives >= LIVES_MAX:
        return LIVES_MAX, now
    return new_lives, lives_ts + gained * REPAIR_SECONDS


def load_game_state(conn, uid: str) -> dict:
    """Fetch (creating if needed) the user's game_state row, applying the daily
    boost reset and hourly life repair, and persisting any change."""
    now = int(time.time())
    today = today_iso()
    row = conn.execute(
        "SELECT boost_day, boost_used, extra_boosts, lives, lives_ts, stars "
        "FROM game_state WHERE user_id = ?",
        (uid,),
    ).fetchone()
    if not row:
        conn.execute(
            "INSERT OR IGNORE INTO game_state "
            "(user_id, boost_day, boost_used, extra_boosts, lives, lives_ts, stars) "
            "VALUES (?, ?, 0, 0, ?, ?, 50)",
            (uid, today, LIVES_MAX, now),
        )
        return {"boost_day": today, "boost_used": 0, "extra_boosts": 0,
                "lives": LIVES_MAX, "lives_ts": now, "stars": 50}

    g = {
        "boost_day": row["boost_day"], "boost_used": int(row["boost_used"]),
        "extra_boosts": int(row["extra_boosts"]), "lives": int(row["lives"]),
        "lives_ts": int(row["lives_ts"]), "stars": int(row["stars"]),
    }
    dirty = False
    if g["boost_day"] != today:
        g["boost_day"] = today
        g["boost_used"] = 0
        dirty = True
    new_lives, new_ts = _regen_lives(g["lives"], g["lives_ts"], now)
    if new_lives != g["lives"] or new_ts != g["lives_ts"]:
        g["lives"], g["lives_ts"] = new_lives, new_ts
        dirty = True
    if dirty:
        conn.execute(
            "UPDATE game_state SET boost_day=?, boost_used=?, lives=?, lives_ts=? "
            "WHERE user_id=?",
            (g["boost_day"], g["boost_used"], g["lives"], g["lives_ts"], uid),
        )
    return g


def _boosts_left(g: dict) -> int:
    return max(0, FREE_BOOSTS_PER_DAY - g["boost_used"]) + g["extra_boosts"]


def _repair_secs(g: dict) -> int:
    if g["lives"] >= LIVES_MAX:
        return 0
    now = int(time.time())
    return max(0, REPAIR_SECONDS - ((now - g["lives_ts"]) % REPAIR_SECONDS))


def compute_state(user_id: str) -> dict:
    with db() as conn:
        rows = conn.execute(
            "SELECT day FROM pulses WHERE user_id = ? ORDER BY day DESC",
            (user_id,),
        ).fetchall()
        wallet_row = conn.execute(
            "SELECT address FROM wallets WHERE user_id = ?", (user_id,)
        ).fetchone()
        comp_rows = conn.execute(
            "SELECT task_id, day FROM completions WHERE user_id = ?", (user_id,)
        ).fetchall()
        disc_rows = conn.execute(
            "SELECT planet_id, shared FROM discoveries WHERE user_id = ?", (user_id,)
        ).fetchall()
        claim_rows = conn.execute(
            "SELECT milestone FROM streak_claims WHERE user_id = ?", (user_id,)
        ).fetchall()
        game = load_game_state(conn, user_id)

    days = {r["day"] for r in rows}
    total = len(days)
    today = today_iso()
    manual_today = {r["task_id"] for r in comp_rows if r["day"] == today}
    manual_ever = {r["task_id"] for r in comp_rows}

    # current streak: count back from today (or yesterday) while consecutive
    streak = 0
    cursor = date.fromisoformat(today)
    if cursor.isoformat() not in days:
        cursor = cursor - timedelta(days=1)
    while cursor.isoformat() in days:
        streak += 1
        cursor = cursor - timedelta(days=1)

    # last 7 days heatmap (oldest -> newest)
    heat = []
    for i in range(6, -1, -1):
        d = (date.fromisoformat(today) - timedelta(days=i)).isoformat()
        heat.append({"day": d, "active": d in days})

    wallet = wallet_row["address"] if wallet_row else None

    # resolve task completion state from the (dev-editable) catalogue
    tasks = []
    for t in load_tasks():
        kind = t.get("kind", "manual")
        if kind == "pulse":
            done = today in days
        elif kind == "streak":
            done = streak >= int(t.get("target", 3))
        elif kind == "wallet":
            done = wallet is not None
        elif t.get("repeat") == "once":
            done = t["id"] in manual_ever
        else:  # manual / link, tracked per day
            done = t["id"] in manual_today
        tasks.append({**t, "done": done})

    points = total * 10 + sum(int(t.get("reward", 0)) for t in tasks if t["done"])

    # space-explorer rewards (discovery is a hidden surprise; share is opt-in)
    discovered = [r["planet_id"] for r in disc_rows]
    shared = [r["planet_id"] for r in disc_rows if r["shared"]]
    grewards = load_game_config()
    points += len(discovered) * grewards["discover"] + len(shared) * grewards["share"]

    # streak milestones: claim +N points when the streak reaches N days
    claimed_ms = {int(r["milestone"]) for r in claim_rows}
    points += sum(claimed_ms)
    streak_milestones = [
        {
            "milestone": m,
            "reward": m,
            "claimed": m in claimed_ms,
            "claimable": (streak >= m) and (m not in claimed_ms),
        }
        for m in MILESTONES
    ]

    return {
        "streak": streak,
        "total": total,
        "points": points,
        "today": today in days,
        "heatmap": heat,
        "tasks": tasks,
        "wallet": wallet,
        "discovered": discovered,
        "shared": shared,
        "streak_milestones": streak_milestones,
        "lives": game["lives"],
        "lives_max": LIVES_MAX,
        "lives_repair_secs": _repair_secs(game),
        "boosts_left": _boosts_left(game),
        "boosts_max": FREE_BOOSTS_PER_DAY,
        "stars": game["stars"],
    }


# --------------------------------------------------------------------------- #
# API routes                                                                   #
# --------------------------------------------------------------------------- #
def _decorate(state: dict, user: dict) -> dict:
    state["name"] = user.get("first_name", "")
    state["dev_mode"] = DEV_MODE
    return state


@app.get("/api/state")
async def state(request: Request):
    user = await get_user(request)
    return JSONResponse(_decorate(compute_state(user["id"]), user))


@app.post("/api/checkin")
async def checkin(request: Request):
    user = await get_user(request)
    uid = user["id"]
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO pulses (user_id, day, ts) VALUES (?, ?, ?)",
            (uid, today_iso(), int(time.time())),
        )
    return JSONResponse(_decorate(compute_state(uid), user))


@app.post("/api/tasks/complete")
async def complete_task(request: Request):
    user = await get_user(request)
    uid = user["id"]
    body = await request.json() if request.method == "POST" else {}
    task_id = (body or {}).get("task_id", "")
    task = next((t for t in load_tasks() if t["id"] == task_id), None)
    if not task:
        raise HTTPException(status_code=404, detail="unknown task")
    # only client-completable kinds record a completion row
    if task.get("kind", "manual") in ("manual", "link"):
        with db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO completions (user_id, task_id, day, ts) VALUES (?, ?, ?, ?)",
                (uid, task_id, today_iso(), int(time.time())),
            )
    return JSONResponse(_decorate(compute_state(uid), user))


@app.post("/api/wallet")
async def save_wallet(request: Request):
    user = await get_user(request)
    uid = user["id"]
    body = await request.json()
    address = (body or {}).get("address", "").strip()
    if not address:
        # allow disconnect
        with db() as conn:
            conn.execute("DELETE FROM wallets WHERE user_id = ?", (uid,))
    else:
        with db() as conn:
            conn.execute(
                "INSERT INTO wallets (user_id, address, ts) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET address=excluded.address, ts=excluded.ts",
                (uid, address, int(time.time())),
            )
    return JSONResponse(_decorate(compute_state(uid), user))


@app.post("/api/game/discover")
async def game_discover(request: Request):
    """Record that a user reached a planet. First discovery silently grants the
    hidden 'discover' reward (the UI never advertises this)."""
    user = await get_user(request)
    uid = user["id"]
    body = await request.json()
    pid = (body or {}).get("planet_id", "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing planet_id")
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO discoveries (user_id, planet_id, ts, shared) VALUES (?, ?, ?, 0)",
            (uid, pid, int(time.time())),
        )
    return JSONResponse(_decorate(compute_state(uid), user))


@app.post("/api/game/share")
async def game_share(request: Request):
    """Record that a user shared a snapshot from a planet and grant the share
    reward once."""
    user = await get_user(request)
    uid = user["id"]
    body = await request.json()
    pid = (body or {}).get("planet_id", "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing planet_id")
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO discoveries (user_id, planet_id, ts, shared) VALUES (?, ?, ?, 1)",
            (uid, pid, int(time.time())),
        )
        conn.execute(
            "UPDATE discoveries SET shared = 1 WHERE user_id = ? AND planet_id = ?",
            (uid, pid),
        )
    return JSONResponse(_decorate(compute_state(uid), user))


@app.post("/api/streak/claim")
async def streak_claim(request: Request):
    """Claim a streak milestone bonus (+milestone points) once the current
    streak has reached that milestone."""
    user = await get_user(request)
    uid = user["id"]
    body = await request.json()
    try:
        milestone = int((body or {}).get("milestone", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="bad milestone")
    if milestone not in MILESTONES:
        raise HTTPException(status_code=400, detail="unknown milestone")
    st = compute_state(uid)
    if st["streak"] < milestone:
        return JSONResponse({**_decorate(st, user), "ok": False, "error": "locked"})
    with db() as conn:
        already = conn.execute(
            "SELECT 1 FROM streak_claims WHERE user_id = ? AND milestone = ?",
            (uid, milestone),
        ).fetchone()
        if already:
            return JSONResponse({**_decorate(st, user), "ok": False, "error": "claimed"})
        conn.execute(
            "INSERT OR IGNORE INTO streak_claims (user_id, milestone, ts) VALUES (?, ?, ?)",
            (uid, milestone, int(time.time())),
        )
    return JSONResponse({**_decorate(compute_state(uid), user), "ok": True})


@app.post("/api/boost/use")
async def boost_use(request: Request):
    """Spend one boost charge (free daily allowance first, then purchased
    extras). Returns ok:False when none remain."""
    user = await get_user(request)
    uid = user["id"]
    with db() as conn:
        g = load_game_state(conn, uid)
        if _boosts_left(g) < 1:
            return JSONResponse({**_decorate(compute_state(uid), user), "ok": False, "error": "no_boosts"})
        if g["boost_used"] < FREE_BOOSTS_PER_DAY:
            conn.execute(
                "UPDATE game_state SET boost_used = boost_used + 1 WHERE user_id = ?",
                (uid,),
            )
        else:
            conn.execute(
                "UPDATE game_state SET extra_boosts = extra_boosts - 1 WHERE user_id = ?",
                (uid,),
            )
    return JSONResponse({**_decorate(compute_state(uid), user), "ok": True})


@app.post("/api/store/buy")
async def store_buy(request: Request):
    """Spend (demo) Telegram Stars on a boost pack or life pack."""
    user = await get_user(request)
    uid = user["id"]
    body = await request.json()
    item = (body or {}).get("item", "")
    spec = STORE.get(item)
    if not spec:
        raise HTTPException(status_code=400, detail="unknown item")
    now = int(time.time())
    with db() as conn:
        g = load_game_state(conn, uid)
        if g["stars"] < spec["cost"]:
            return JSONResponse({**_decorate(compute_state(uid), user), "ok": False, "error": "insufficient_stars"})
        new_stars = g["stars"] - spec["cost"]
        if "boosts" in spec:
            conn.execute(
                "UPDATE game_state SET stars = ?, extra_boosts = extra_boosts + ? WHERE user_id = ?",
                (new_stars, spec["boosts"], uid),
            )
        else:  # life pack
            new_lives = min(LIVES_MAX, g["lives"] + spec["lives"])
            new_ts = now if new_lives >= LIVES_MAX else g["lives_ts"]
            conn.execute(
                "UPDATE game_state SET stars = ?, lives = ?, lives_ts = ? WHERE user_id = ?",
                (new_stars, new_lives, new_ts, uid),
            )
    return JSONResponse({**_decorate(compute_state(uid), user), "ok": True})


@app.post("/api/game/hit")
async def game_hit(request: Request):
    """Register that the rocket was hit by a hazard (satellite / asteroid):
    lose one life. Returns the remaining life count."""
    user = await get_user(request)
    uid = user["id"]
    now = int(time.time())
    with db() as conn:
        g = load_game_state(conn, uid)
        if g["lives"] > 0:
            was_full = g["lives"] >= LIVES_MAX
            new_lives = g["lives"] - 1
            new_ts = now if was_full else g["lives_ts"]
            conn.execute(
                "UPDATE game_state SET lives = ?, lives_ts = ? WHERE user_id = ?",
                (new_lives, new_ts, uid),
            )
    return JSONResponse({**_decorate(compute_state(uid), user), "ok": True})


@app.get("/healthz")
async def healthz():
    """Lightweight health probe so uptime checks pass without a 404."""
    return JSONResponse({"ok": True, "db": "postgres" if USE_PG else "sqlite"})


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


# static assets (styles.css, app.js, etc.)
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")


if __name__ == "__main__":
    # Allows `python main.py` to boot the server, honouring the host's $PORT.
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
