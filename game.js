/* ========================================================================
   ORBYT — Space Explorer (v3)
   Tiny rocket, real-scaled deep space: far planets, moon, satellites,
   asteroids and shooting stars. Server-tracked lives (3/day, +1/hr repair,
   buy more) and limited daily boosts. Monochrome, touch-first.
   ===================================================================== */
(() => {
  'use strict';
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const $ = id => document.getElementById(id);
  const BRIDGE = () => (window.ORBYT || window.PULSE || {});
  const TAU = Math.PI * 2;
  function api(path, extra) {
    const initData = BRIDGE().initData || '';
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData }, body: JSON.stringify({ initData, ...(extra || {}) }) }).then(r => r.json()).catch(() => null);
  }
  function haptic(k) { try { if (!tg || !tg.HapticFeedback) return; if (k === 'hit') tg.HapticFeedback.impactOccurred('heavy'); else if (k === 'ok') tg.HapticFeedback.notificationOccurred('success'); else if (k === 'warn') tg.HapticFeedback.notificationOccurred('warning'); else tg.HapticFeedback.impactOccurred('light'); } catch (_) {} }

  // ---- settings (client-side) -------------------------------------------
  const SET = {
    sens: parseFloat(localStorage.getItem('orbyt_sens') || '1'),
    speed: parseFloat(localStorage.getItem('orbyt_speed') || '1'),
  };
  function saveSet() { localStorage.setItem('orbyt_sens', String(SET.sens)); localStorage.setItem('orbyt_speed', String(SET.speed)); }

  // ---- real astronomy (far, tiny — like real space) ---------------------
  const AU_KM = 149597870;
  const PX_PER_AU = 4200;      // farther apart than before
  const EARTH_AU = 1.0;
  const PLANETS = [
    { id: 'mars', name: 'Mars', au: 1.52, dia: 6779, r: 12, x: -220, rings: false, shade: 0.60 },
    { id: 'jupiter', name: 'Jupiter', au: 5.20, dia: 139820, r: 34, x: 300, rings: false, shade: 0.46, bands: true },
    { id: 'saturn', name: 'Saturn', au: 9.58, dia: 116460, r: 30, x: -320, rings: true, shade: 0.70 },
    { id: 'uranus', name: 'Uranus', au: 19.20, dia: 50724, r: 20, x: 320, rings: true, shade: 0.82 },
    { id: 'neptune', name: 'Neptune', au: 30.05, dia: 49244, r: 20, x: -260, rings: false, shade: 0.64 },
  ];
  PLANETS.forEach(p => { p.auFromEarth = p.au - EARTH_AU; });
  const fmt = n => Math.round(n).toLocaleString('en-US');

  // ---- runtime ----------------------------------------------------------
  const cv = $('gameCanvas'), ctx = cv ? cv.getContext('2d') : null;
  let W = 0, H = 0, dpr = 1, running = false, raf = 0, last = 0, t = 0;
  let phase = 'launch', launchT = 0, landT = 0, deadT = 0, shakeT = 0, hintT = 0;
  let boost = 0, boostLeft = 3, shields = 3, invuln = 0, score = 0;
  let stars = [], starsFar = [], exhaust = [], asteroids = [], sats = [], shooters = [], debris = [];
  const rocket = { x: 0, y: 0, vx: 0, vy: 0, ang: -Math.PI / 2 };
  const pointer = { on: false, x: 0, y: 0 };
  let reached = new Set(), current = null, astTimer = 0, satTimer = 0, shootTimer = 0;
  const ROCK_SX = () => W / 2;
  const ROCK_SY = () => H * 0.6;
  const PPAU = () => PX_PER_AU * dpr;
  const EARTH_R = () => 90 * dpr;                 // much smaller Earth
  const EARTH_CY = () => -(EARTH_R() + 6 * dpr);
  const SUN = { x: () => -0.7 * W - 240 * dpr, y: () => -0.12 * PPAU(), r: () => 160 * dpr };
  const MOON = { x: () => 0.42 * W + 220 * dpr, y: () => 0.30 * PPAU(), r: () => 34 * dpr };

  function resize() {
    if (!cv) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = cv.width = Math.round(innerWidth * dpr);
    H = cv.height = Math.round(innerHeight * dpr);
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    buildStars();
  }
  function buildStars() {
    stars = []; starsFar = [];
    const n = Math.round(W * H / (7000));
    for (let i = 0; i < n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, z: 0.5 + Math.random() * 0.6, ph: Math.random() * TAU, r: (0.4 + Math.random() * 1.6) * dpr });
    const nf = Math.round(W * H / (22000));
    for (let i = 0; i < nf; i++) starsFar.push({ x: Math.random() * W, y: Math.random() * H, z: 0.12 + Math.random() * 0.25, ph: Math.random() * TAU, r: (0.3 + Math.random()) * dpr });
  }
  function sx(wx) { return ROCK_SX() + (wx - rocket.x); }
  function sy(wy) { return ROCK_SY() - (wy - rocket.y); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---- rocket shape (tiny; nose at -y) ----------------------------------
  function drawRocketShape(g, s, thrust) {
    if (thrust > 0.02) {
      const fl = (14 + thrust * 26 + Math.random() * 8) * s;
      g.beginPath();
      g.moveTo(-4.4 * s, 12 * s); g.quadraticCurveTo(-2 * s, 12 * s + fl * 0.5, 0, 12 * s + fl);
      g.quadraticCurveTo(2 * s, 12 * s + fl * 0.5, 4.4 * s, 12 * s); g.closePath();
      g.fillStyle = 'rgba(255,255,255,' + (0.55 + 0.4 * Math.random()) + ')'; g.fill();
      g.beginPath(); g.moveTo(-2.4 * s, 12 * s); g.lineTo(0, 12 * s + fl * 0.6); g.lineTo(2.4 * s, 12 * s); g.closePath();
      g.fillStyle = '#000'; g.fill();
    }
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(-4.6 * s, 4 * s); g.lineTo(-10 * s, 14 * s); g.lineTo(-4.6 * s, 12 * s); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(4.6 * s, 4 * s); g.lineTo(10 * s, 14 * s); g.lineTo(4.6 * s, 12 * s); g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(-4.6 * s, 12 * s); g.lineTo(-4.6 * s, -6 * s);
    g.quadraticCurveTo(-4.6 * s, -15 * s, 0, -22 * s);
    g.quadraticCurveTo(4.6 * s, -15 * s, 4.6 * s, -6 * s);
    g.lineTo(4.6 * s, 12 * s); g.closePath();
    g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.arc(0, -5 * s, 3 * s, 0, TAU); g.fillStyle = '#000'; g.fill();
    g.beginPath(); g.arc(-0.8 * s, -5.8 * s, 1.1 * s, 0, TAU); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fill();
  }

  // ---- input ------------------------------------------------------------
  function bindInput() {
    const move = e => { const p = e.touches ? e.touches[0] : e; if (!p) return; pointer.x = p.clientX * dpr; pointer.y = p.clientY * dpr; };
    const down = e => { pointer.on = true; move(e); if (e.cancelable) e.preventDefault(); };
    const up = () => { pointer.on = false; };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', e => { if (pointer.on) move(e); });
    addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('touchstart', down, { passive: false });
    cv.addEventListener('touchmove', e => { if (pointer.on) { move(e); if (e.cancelable) e.preventDefault(); } }, { passive: false });
    addEventListener('touchend', up);
  }
  async function fireBoost() {
    if (phase !== 'fly' || boostLeft < 1) { haptic('warn'); return; }
    boostLeft -= 1; boost = 1.7; shakeT = 0.35; haptic('hit'); updateHud();
    const s = await api('/api/boost/use', {});
    if (s) { if (s.ok === false) { boostLeft += 1; boost = 0; } BRIDGE().paint && BRIDGE().paint(s); syncFromState(s); }
    updateHud();
  }
  function changeSpeed(d) { SET.speed = Math.max(0.5, Math.min(2, +(SET.speed + d).toFixed(1))); saveSet(); updateThrottle(); haptic('light'); }
  function updateThrottle() { const f = $('gThrottleFill'); if (f) f.style.width = ((SET.speed - 0.5) / 1.5 * 100) + '%'; }

  // ---- launch sequence --------------------------------------------------
  function updateLaunch(dt) {
    launchT += dt; shakeT = Math.max(shakeT, 0.06);
    if (launchT < 0.7) { spawnExhaust(3, 1.4); }
    else {
      const a = Math.min(1, (launchT - 0.7) / 2.0);
      rocket.vy += (520 + a * 1400) * dpr * dt; rocket.y += rocket.vy * dt; rocket.ang = -Math.PI / 2;
      spawnExhaust(4, 1.6);
    }
    if (rocket.y > EARTH_R() * 0.9 && launchT > 1.6) { phase = 'fly'; hintT = 3.2; shakeT = 0.2; rocket.vy = Math.min(rocket.vy, 720 * dpr); }
    stepParticles(dt); updateHud();
  }

  // ---- free flight ------------------------------------------------------
  function update(dt) {
    if (phase === 'launch') return updateLaunch(dt);
    if (phase === 'landing') { landT += dt; stepParticles(dt); return; }
    if (phase === 'dead') { deadT += dt; stepParticles(dt); if (deadT > 1.9 && shields > 0) respawn(); return; }
    if (phase === 'over') { deadT += dt; stepParticles(dt); return; }
    if (phase !== 'fly') { stepParticles(dt); return; }
    if (hintT > 0) hintT -= dt;
    boost = Math.max(0, boost - dt * 0.85);
    invuln = Math.max(0, invuln - dt);
    const maxV = (520 * SET.speed + boost * 3400) * dpr;
    if (pointer.on) {
      const dx = pointer.x - ROCK_SX(), dy = pointer.y - ROCK_SY();
      const len = Math.hypot(dx, dy) || 1;
      const acc = (760 * SET.sens + boost * 2800) * dpr;
      rocket.vx += (dx / len) * acc * dt; rocket.vy += (-dy / len) * acc * dt;
      rocket.ang = Math.atan2(-dy, dx); spawnExhaust(2, 1);
    } else { rocket.vx *= (1 - Math.min(1, dt * 0.5)); rocket.vy *= (1 - Math.min(1, dt * 0.5)); }
    const sp = Math.hypot(rocket.vx, rocket.vy);
    if (sp > maxV) { rocket.vx *= maxV / sp; rocket.vy *= maxV / sp; }
    rocket.x += rocket.vx * dt; rocket.y += rocket.vy * dt;
    if (rocket.y < -EARTH_R() * 0.4) { rocket.y = -EARTH_R() * 0.4; rocket.vy = Math.max(0, rocket.vy); }
    score = Math.max(score, rocket.y);
    spawnAsteroids(dt); spawnSats(dt); spawnShooters(dt);
    stepAsteroids(dt); stepSats(dt); stepParticles(dt);
    checkDiscovery(); updateHud();
  }

  // ---- spawners & particles ---------------------------------------------
  function spawnExhaust(count, scale) {
    if (exhaust.length > 140) return;
    const bx = ROCK_SX() - Math.cos(rocket.ang) * 12 * dpr, by = ROCK_SY() - Math.sin(rocket.ang) * 12 * dpr;
    for (let i = 0; i < count; i++) exhaust.push({ x: bx, y: by, vx: (-Math.cos(rocket.ang) * 70 + rand(-50, 50)) * dpr, vy: (-Math.sin(rocket.ang) * 70 + rand(-50, 50)) * dpr, life: rand(0.4, 0.9), r: rand(1, 3) * (scale || 1) * dpr });
  }
  function stepParticles(dt) {
    for (let i = exhaust.length - 1; i >= 0; i--) { const e = exhaust[i]; e.x += e.vx * dt; e.y += e.vy * dt; e.life -= dt * 1.7; if (e.life <= 0) exhaust.splice(i, 1); }
    for (let i = shooters.length - 1; i >= 0; i--) { const s = shooters[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt; if (s.life <= 0) shooters.splice(i, 1); }
    for (let i = debris.length - 1; i >= 0; i--) { const d = debris[i]; d.x += d.vx * dt; d.y += d.vy * dt; d.life -= dt * 1.2; if (d.life <= 0) debris.splice(i, 1); }
  }
  function spawnShooters(dt) {
    shootTimer -= dt; if (shootTimer > 0) return; shootTimer = rand(1.6, 4.2);
    const edge = Math.random() < 0.5;
    shooters.push({ x: edge ? rand(0, W) : -20 * dpr, y: edge ? -20 * dpr : rand(0, H * 0.5), vx: rand(220, 420) * dpr, vy: rand(160, 320) * dpr, life: rand(0.5, 0.9), len: rand(60, 150) * dpr });
  }
  function spawnAsteroids(dt) {
    astTimer -= dt; if (astTimer > 0) return;
    const alt = rocket.y / PPAU();
    const density = Math.min(1, 0.25 + alt * 0.05);
    astTimer = rand(0.7, 1.7) / density;
    const spread = W * 0.9;
    const wx = rocket.x + rand(-spread, spread);
    const wy = rocket.y + H * rand(0.75, 1.25);
    const rad = rand(8, 22) * dpr;
    const verts = []; const vn = 7 + (Math.random() * 4 | 0);
    for (let i = 0; i < vn; i++) verts.push(rad * rand(0.66, 1.15));
    asteroids.push({ x: wx, y: wy, vx: rand(-60, 60) * dpr, vy: -rand(120, 260) * dpr, r: rad, rot: rand(0, TAU), vr: rand(-1.4, 1.4), verts, vn });
  }
  function spawnSats(dt) {
    satTimer -= dt; if (satTimer > 0) return; satTimer = rand(4, 8);
    const spread = W * 0.8;
    sats.push({ x: rocket.x + rand(-spread, spread), y: rocket.y + H * rand(0.8, 1.3), vx: rand(-40, 40) * dpr, vy: -rand(90, 180) * dpr, r: 12 * dpr, rot: rand(0, TAU), vr: rand(-0.8, 0.8) });
  }
  function stepAsteroids(dt) {
    const cr = 7 * dpr;
    for (let i = asteroids.length - 1; i >= 0; i--) {
      const a = asteroids[i]; a.x += a.vx * dt; a.y += a.vy * dt; a.rot += a.vr * dt;
      if (a.y < rocket.y - H * 1.4 || Math.abs(a.x - rocket.x) > W * 1.6) { asteroids.splice(i, 1); continue; }
      if (invuln <= 0 && phase === 'fly' && Math.hypot(a.x - rocket.x, a.y - rocket.y) < a.r + cr) { asteroids.splice(i, 1); hitRocket(a); }
    }
  }
  function stepSats(dt) {
    const cr = 7 * dpr;
    for (let i = sats.length - 1; i >= 0; i--) {
      const a = sats[i]; a.x += a.vx * dt; a.y += a.vy * dt; a.rot += a.vr * dt;
      if (a.y < rocket.y - H * 1.4 || Math.abs(a.x - rocket.x) > W * 1.6) { sats.splice(i, 1); continue; }
      if (invuln <= 0 && phase === 'fly' && Math.hypot(a.x - rocket.x, a.y - rocket.y) < a.r * 1.4 + cr) { sats.splice(i, 1); hitRocket(a); }
    }
  }

  // ---- damage / lives (server authoritative) ----------------------------
  function hitRocket(a) {
    invuln = 1.6; shakeT = 0.5; haptic('warn');
    rocket.vx += (rocket.x - a.x) * 2.0; rocket.vy += (rocket.y - a.y) * 2.0;
    burst(rocket.x, rocket.y, 12, 240);
    shields = Math.max(0, shields - 1); updateHud();
    if (shields <= 0) destroyRocket();
    api('/api/game/hit', {}).then(s => { if (s) { BRIDGE().paint && BRIDGE().paint(s); syncFromState(s, true); } });
  }
  function burst(x, y, n, spd) {
    for (let i = 0; i < n; i++) { const ang = rand(0, TAU); debris.push({ x, y, vx: Math.cos(ang) * rand(spd * 0.4, spd) * dpr, vy: Math.sin(ang) * rand(spd * 0.4, spd) * dpr, life: rand(0.5, 1.1), r: rand(1.2, 3.4) * dpr }); }
  }
  function destroyRocket() {
    if (phase === 'over') return;
    phase = 'over'; deadT = 0; shakeT = 0.9; haptic('warn');
    burst(rocket.x, rocket.y, 60, 460); rocket.vx = rocket.vy = 0;
    setTimeout(() => { updateOverNote(); show('gOver', true); }, 900);
  }
  function respawn() {
    phase = 'fly'; invuln = 2.2; boost = 0; hintT = 2.4;
    asteroids = []; sats = []; rocket.vx = rocket.vy = 0; rocket.ang = -Math.PI / 2;
    show('gOver', false);
  }
  function syncFromState(s, mayRevive) {
    if (!s) return;
    if (s.lives != null) shields = s.lives;
    if (s.boosts_left != null) boostLeft = s.boosts_left;
    if (s.stars != null) { /* store card refreshed by app.paint */ }
    if (mayRevive && phase === 'over' && shields > 0) respawn();
    updateHud();
  }
  function updateOverNote() {
    const n = $('gOverNote'); if (!n) return;
    const st = BRIDGE().state;
    let txt = 'Repairs restore 1 life per hour · or buy more below.';
    if (st && st.lives_repair_secs) {
      const m = Math.ceil(st.lives_repair_secs / 60);
      txt = 'Next life in ~' + m + ' min · or buy more below.';
    }
    n.textContent = txt;
  }

  // ---- discovery --------------------------------------------------------
  function checkDiscovery() {
    for (const p of PLANETS) {
      if (reached.has(p.id)) continue;
      const wx = p.x * dpr, wy = p.auFromEarth * PPAU();
      const d = Math.hypot(wx - rocket.x, wy - rocket.y);
      if (d < (p.r * dpr + 46 * dpr)) { onDiscover(p); break; }
    }
  }

  // ---- render -----------------------------------------------------------
  function render() {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.42, Math.max(W, H) * 0.7);
    bg.addColorStop(0, 'rgba(255,255,255,0.04)'); bg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    drawStarLayer(starsFar, 0.015); drawStarLayer(stars, 0.03);
    drawShooters();
    drawSun(); drawMoon();
    drawBody({ name: 'Earth', r: 90, shade: 0.9, earth: true }, 0, EARTH_CY(), true);
    for (const p of PLANETS) drawBody(p, p.x * dpr, p.auFromEarth * PPAU(), false);
    drawSats(); drawAsteroids();
    for (const e of exhaust) { ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * e.life) + ')'; ctx.arc(e.x, e.y, e.r, 0, TAU); ctx.fill(); }
    for (const d of debris) { ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * d.life) + ')'; ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill(); }
    if (boost > 0.05) {
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.22 * boost) + ')'; ctx.lineWidth = dpr;
      for (let i = 0; i < 22; i++) { const rx = Math.random() * W, ry = Math.random() * H; ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx, ry + 70 * dpr * boost); ctx.stroke(); }
    }
    if (phase !== 'over' && phase !== 'dead') drawRocket();
    else if (phase === 'over' && deadT < 0.7) { ctx.globalAlpha = Math.max(0, 1 - deadT * 1.5); drawRocket(); ctx.globalAlpha = 1; }
  }
  function drawStarLayer(arr, par) {
    for (const s of arr) {
      const ox = (-rocket.x * par * s.z) % W, oy = (rocket.y * par * s.z) % H;
      let x = s.x + ox; if (x < 0) x += W; if (x > W) x -= W;
      let y = s.y + oy; if (y < 0) y += H; if (y > H) y -= H;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.6 + s.ph);
      ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * tw * s.z) + ')'; ctx.arc(x, y, s.r, 0, TAU); ctx.fill();
    }
  }
  function drawShooters() {
    for (const s of shooters) {
      const a = Math.min(1, s.life * 1.6);
      const nx = s.vx / Math.hypot(s.vx, s.vy), ny = s.vy / Math.hypot(s.vx, s.vy);
      const g = ctx.createLinearGradient(s.x, s.y, s.x - nx * s.len, s.y - ny * s.len);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * a) + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.4 * dpr; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - nx * s.len, s.y - ny * s.len); ctx.stroke();
    }
  }
  function drawSun() {
    const x = sx(SUN.x()), y = sy(SUN.y()), r = SUN.r();
    if (x < -r * 2 || x > W + r * 2 || y < -r * 2 || y > H + r * 2) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.7);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.32, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.7, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(x, y, r * 0.5, 0, TAU); ctx.fill();
  }
  function drawMoon() {
    const x = sx(MOON.x()), y = sy(MOON.y()), r = MOON.r();
    if (x < -r * 2 || x > W + r * 2 || y < -r * 2 || y > H + r * 2) return;
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0.18)');
    ctx.beginPath(); ctx.fillStyle = g; ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    [[0.2, -0.3, 0.22], [-0.35, 0.1, 0.3], [0.1, 0.4, 0.18], [0.45, 0.25, 0.14]].forEach(c => { ctx.beginPath(); ctx.arc(x + c[0] * r, y + c[1] * r, c[2] * r, 0, TAU); ctx.fill(); });
    ctx.restore();
    ctx.beginPath(); ctx.lineWidth = 1 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    label('MOON', x, y + r + 14 * dpr, 0.45);
  }
  function drawBody(p, wx, wy, big) {
    const r = (p.earth ? EARTH_R() : p.r * dpr);
    const cy = p.earth ? EARTH_CY() : wy;
    const x = sx(wx), y = sy(cy);
    if (x < -r * 2.5 || x > W + r * 2.5 || y < -r * 2.5 || y > H + r * 2.5) return;
    if (p.rings) { ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5); ctx.scale(1, 0.32); ctx.beginPath(); ctx.arc(0, 0, r * 1.9, 0, TAU); ctx.lineWidth = 5 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, TAU); ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.stroke(); ctx.restore(); }
    const sh = p.shade || 0.6;
    const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.34, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.92 * sh + 0.08) + ')'); g.addColorStop(1, 'rgba(255,255,255,' + (0.1 * sh) + ')');
    ctx.beginPath(); ctx.fillStyle = g; ctx.arc(x, y, r, 0, TAU); ctx.fill();
    if (p.bands || p.earth) {
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.10)'; ctx.lineWidth = r * 0.14;
      for (let i = -2; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(x - r, y + i * r * 0.34); ctx.bezierCurveTo(x - r * 0.3, y + i * r * 0.34 + r * 0.08, x + r * 0.3, y + i * r * 0.34 - r * 0.08, x + r, y + i * r * 0.34); ctx.stroke(); }
      ctx.restore();
    }
    ctx.beginPath(); ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    if (!p.earth) label(p.name.toUpperCase(), x, y + r + 16 * dpr, 0.7);
    else label('EARTH', x, sy(0) - 20 * dpr, 0.55);
  }
  function drawSats() {
    for (const a of sats) {
      const x = sx(a.x), y = sy(a.y);
      if (x < -a.r * 2 || x > W + a.r * 2 || y < -a.r * 2 || y > H + a.r * 2) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a.rot);
      // body
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(-3 * dpr, -3 * dpr, 6 * dpr, 6 * dpr);
      // panels
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(-16 * dpr, -2 * dpr, 11 * dpr, 4 * dpr);
      ctx.fillRect(5 * dpr, -2 * dpr, 11 * dpr, 4 * dpr);
      // outline
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(-3 * dpr, -3 * dpr, 6 * dpr, 6 * dpr);
      ctx.strokeRect(-16 * dpr, -2 * dpr, 11 * dpr, 4 * dpr);
      ctx.strokeRect(5 * dpr, -2 * dpr, 11 * dpr, 4 * dpr);
      ctx.restore();
      label('SAT', x, y + 18 * dpr, 0.4);
    }
  }
  function drawAsteroids() {
    for (const a of asteroids) {
      const x = sx(a.x), y = sy(a.y);
      if (x < -a.r * 2 || x > W + a.r * 2 || y < -a.r * 2 || y > H + a.r * 2) continue;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a.rot);
      ctx.beginPath();
      for (let i = 0; i < a.vn; i++) { const ang = i / a.vn * TAU; const rr = a.verts[i]; const px = Math.cos(ang) * rr, py = Math.sin(ang) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
      ctx.lineWidth = 1.4 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke();
      ctx.restore();
    }
  }
  function drawRocket() {
    const x = ROCK_SX(), y = ROCK_SY();
    if (invuln > 0 && phase === 'fly' && (Math.sin(t * 30) < 0)) return;
    let thrust = pointer.on ? 0.7 : 0.06;
    if (phase === 'launch') thrust = launchT < 0.7 ? (0.4 + Math.random() * 0.4) : 1.2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rocket.ang + Math.PI / 2);
    drawRocketShape(ctx, 0.75 * dpr, thrust);  // 0.75 makes it tiny
    ctx.restore();
    if (invuln > 0 && phase === 'fly') { ctx.beginPath(); ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = 'rgba(255,255,255,' + (0.3 + 0.25 * Math.sin(t * 20)) + ')'; ctx.arc(x, y, 14 * dpr, 0, TAU); ctx.stroke(); }
  }
  function label(txt, x, y, a) {
    ctx.fillStyle = 'rgba(255,255,255,' + (a || 0.8) + ')';
    ctx.font = (10 * dpr) + 'px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center';
    ctx.fillText(txt, x, y);
  }

  // ---- HUD --------------------------------------------------------------
  function updateHud() {
    const sp = Math.hypot(rocket.vx, rocket.vy) / PPAU() * AU_KM / 1000;
    setTxt('gSpeed', fmt(sp) + ' km/s' + (boost > 0.05 ? '  ⚡' : ''));
    const lv = $('gLives'); if (lv) { const n = Math.max(0, shields); const mx = Math.max(3, n); lv.textContent = '♥'.repeat(n) + '♡'.repeat(Math.max(0, mx - n)); }
    let best = null, bd = Infinity;
    for (const p of PLANETS) { if (reached.has(p.id)) continue; const wx = p.x * dpr, wy = p.auFromEarth * PPAU(); const d = Math.hypot(wx - rocket.x, wy - rocket.y); if (d < bd) { bd = d; best = { wx, wy }; } }
    const arrow = $('gArrow'), dist = $('gDist');
    if (arrow && dist) {
      if (best) { const ang = Math.atan2(-(best.wy - rocket.y), best.wx - rocket.x); arrow.style.transform = 'rotate(' + (-ang + Math.PI / 2) + 'rad)'; arrow.style.opacity = '1'; dist.textContent = fmt(bd / PPAU() * AU_KM) + ' km'; }
      else { arrow.style.opacity = '.2'; dist.textContent = 'all found'; }
    }
    const bb = $('gBoost'); if (bb) { bb.classList.toggle('ready', boostLeft > 0 && phase === 'fly'); const bl = $('gBoostLeft'); if (bl) bl.textContent = boostLeft; }
    const msg = $('gMsg');
    if (msg) {
      if (phase === 'over') { msg.hidden = true; }
      else if (phase === 'launch') { msg.hidden = false; msg.className = 'g-msg'; msg.textContent = launchT < 0.7 ? 'IGNITION' : 'LIFT-OFF'; }
      else if (hintT > 0 && phase === 'fly') { msg.hidden = false; msg.className = 'g-msg'; msg.textContent = 'drag to steer · avoid debris'; }
      else msg.hidden = true;
    }
  }
  function setTxt(id, v) { const el = $(id); if (el) el.textContent = v; }

  function loop(now) {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now; t += dt;
    update(dt);
    ctx.save();
    if (shakeT > 0) { shakeT -= dt; const m = (phase === 'launch' ? 5 : phase === 'over' ? 14 : 9) * dpr * Math.min(1, shakeT * 2); ctx.translate(rand(-m, m), rand(-m, m)); }
    render();
    ctx.restore();
    raf = requestAnimationFrame(loop);
  }

  // ---- discovery / land / snapshot --------------------------------------
  function onDiscover(p) {
    reached.add(p.id); current = p; phase = 'discover'; shakeT = 0.4; haptic('ok');
    rocket.vx *= 0.15; rocket.vy *= 0.15;
    setTxt('gpName', p.name);
    $('gpStats').innerHTML =
      '<div><span>DISTANCE FROM SUN</span><b>' + p.au.toFixed(2) + ' AU</b></div>' +
      '<div><span>DIAMETER</span><b>' + fmt(p.dia) + ' km</b></div>' +
      '<div><span>FROM EARTH</span><b>' + fmt(Math.abs(p.auFromEarth) * AU_KM) + ' km</b></div>';
    show('gDiscover', true);
    api('/api/game/discover', { planet_id: p.id }).then(s => { BRIDGE().paint && BRIDGE().paint(s); syncFromState(s); });
  }
  function land() { show('gDiscover', false); phase = 'landing'; landT = 0; setTimeout(makeSnapshot, 1100); }
  function makeSnapshot() {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 1080, 1350);
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(255,255,255,' + (0.2 + Math.random() * 0.7) + ')'; g.beginPath(); g.arc(Math.random() * 1080, Math.random() * 1350, Math.random() * 1.9, 0, TAU); g.fill(); }
    const p = current, cx = 540, cy = 600, R = 300;
    if (p.rings) { g.save(); g.translate(cx, cy); g.rotate(-0.5); g.scale(1, 0.32); g.beginPath(); g.arc(0, 0, R * 1.9, 0, TAU); g.lineWidth = 18; g.strokeStyle = 'rgba(255,255,255,0.5)'; g.stroke(); g.restore(); }
    const rg = g.createRadialGradient(cx - 110, cy - 110, 40, cx, cy, R);
    rg.addColorStop(0, 'rgba(255,255,255,' + (0.9 * p.shade + 0.1) + ')'); rg.addColorStop(1, 'rgba(255,255,255,' + (0.12 * p.shade) + ')');
    g.beginPath(); g.fillStyle = rg; g.arc(cx, cy, R, 0, TAU); g.fill();
    g.beginPath(); g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.save(); g.translate(cx + R * 0.1, cy - R - 6); drawRocketShape(g, 5, 0.2); g.restore();
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = '700 46px ui-monospace,Menlo,monospace'; g.fillText('O R B Y T', 540, 150);
    g.font = '800 92px "SF Pro Display",Arial,sans-serif'; g.fillText(p.name.toUpperCase(), 540, 1030);
    g.font = '400 34px ui-monospace,Menlo,monospace'; g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(p.au.toFixed(2) + ' AU  ·  ⌀ ' + fmt(p.dia) + ' km', 540, 1090);
    g.fillText(new Date().toISOString().slice(0, 10), 540, 1160);
    const url = c.toDataURL('image/png');
    $('gSnapImg').src = url; $('gDownload').href = url; $('gDownload').setAttribute('download', 'orbyt-' + p.id + '.png');
    phase = 'fly'; show('gSnap', true);
  }
  function shareSnap() {
    const p = current; if (!p) return;
    api('/api/game/share', { planet_id: p.id }).then(s => { BRIDGE().paint && BRIDGE().paint(s); syncFromState(s); });
    haptic('ok');
    const u = 'https://t.me/share/url?url=' + encodeURIComponent('https://t.me') + '&text=' + encodeURIComponent('I just reached ' + p.name + ' on ORBYT 🚀');
    try { if (tg && tg.openTelegramLink) tg.openTelegramLink(u); else window.open(u, '_blank'); } catch (_) {}
  }
  function resume() { show('gDiscover', false); show('gSnap', false); phase = 'fly'; }
  function show(id, on) { const el = $(id); if (el) el.hidden = !on; }

  async function buyLife() {
    const btn = $('gBuyLife'); if (btn) btn.classList.add('busy');
    const s = await api('/api/store/buy', { item: 'life1' });
    if (btn) btn.classList.remove('busy');
    if (s && s.ok !== false) { BRIDGE().paint && BRIDGE().paint(s); haptic('ok'); syncFromState(s, true); }
    else { haptic('warn'); if (btn) { const o = btn.textContent; btn.textContent = 'need ⭐'; setTimeout(() => btn.textContent = o, 1100); } }
  }

  // ---- open / close / launch --------------------------------------------
  function open() {
    if (!cv) return;
    const st = BRIDGE().state; reached = new Set((st && st.discovered) || []);
    resize();
    rocket.x = 0; rocket.y = 0; rocket.vx = 0; rocket.vy = 0; rocket.ang = -Math.PI / 2;
    exhaust = []; asteroids = []; sats = []; shooters = []; debris = [];
    boost = 0;
    shields = (st && st.lives != null) ? st.lives : 3;
    boostLeft = (st && st.boosts_left != null) ? st.boosts_left : 3;
    invuln = 0; score = 0;
    phase = 'launch'; launchT = 0; landT = 0; deadT = 0; shakeT = 0.3; hintT = 0; current = null;
    show('gDiscover', false); show('gSnap', false); show('gOver', false); show('gSettings', false);
    updateThrottle();
    const gs = $('gSens'); if (gs) { gs.value = SET.sens; setTxt('gSensVal', SET.sens.toFixed(1) + '×'); }
    const gp = $('gSpeedSet'); if (gp) { gp.value = SET.speed; setTxt('gSpeedVal', SET.speed.toFixed(1) + '×'); }
    const ov = $('gameOverlay'); ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false');
    running = true; last = 0; raf = requestAnimationFrame(loop);
    if (shields <= 0) { setTimeout(() => { updateOverNote(); show('gOver', true); phase = 'over'; }, 400); }
    updateHud();
  }
  function close() {
    running = false; cancelAnimationFrame(raf);
    const ov = $('gameOverlay'); ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true');
    show('gDiscover', false); show('gSnap', false); show('gOver', false); show('gSettings', false);
    const r = BRIDGE().refresh; r && r();
  }
  function launch() {
    const fab = $('rocketLaunch'); if (fab && fab.classList.contains('go')) return;
    if (fab) fab.classList.add('go'); haptic('hit');
    try { if (tg && tg.HapticFeedback) { tg.HapticFeedback.impactOccurred('rigid'); } } catch (_) {}
    const deck = $('deck'); deck && deck.classList.add('launch-shake');
    setTimeout(() => { deck && deck.classList.remove('launch-shake'); }, 520);
    setTimeout(() => { open(); if (fab) fab.classList.remove('go'); }, 620);
  }

  addEventListener('resize', () => { if (running) resize(); });
  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    if (cv) bindInput();
    const on = (id, fn, ev) => { const el = $(id); if (el) el.addEventListener(ev || 'click', fn); };
    const fab = $('rocketLaunch');
    if (fab) { let h = false; const fire = e => { if (h) return; h = true; setTimeout(() => (h = false), 500); if (e && e.preventDefault) e.preventDefault(); launch(); }; fab.addEventListener('click', fire); fab.addEventListener('touchend', fire, { passive: false }); }
    on('gExit', close); on('gBoost', fireBoost);
    on('gLand', land); on('gResume', resume); on('gShare', shareSnap); on('gSnapClose', resume);
    on('gSlow', () => changeSpeed(-0.1)); on('gFast', () => changeSpeed(0.1));
    on('gGear', () => { show('gSettings', true); });
    on('gSettingsClose', () => show('gSettings', false));
    on('gBuyLife', buyLife); on('gOverExit', close);
    const gs = $('gSens'); if (gs) gs.addEventListener('input', () => { SET.sens = parseFloat(gs.value); setTxt('gSensVal', SET.sens.toFixed(1) + '×'); saveSet(); });
    const gp = $('gSpeedSet'); if (gp) gp.addEventListener('input', () => { SET.speed = parseFloat(gp.value); setTxt('gSpeedVal', SET.speed.toFixed(1) + '×'); saveSet(); updateThrottle(); });
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', wire); else wire();
  window.ORBYT_GAME = { open, close, launch };
})();


