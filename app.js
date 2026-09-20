/* ========================================================================
   ORBYT - Telegram Mini App
   monochrome deep-space · horizontal deck · daily streaks · quests · wallet
   ===================================================================== */
(() => {
  'use strict';

  // ---- Telegram bootstrap ----------------------------------------------
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  let initData = '';
  if (tg) {
    tg.ready(); tg.expand();
    initData = tg.initData || '';
    applyTheme(tg.colorScheme);
    tg.onEvent('themeChanged', () => applyTheme(tg.colorScheme));
    try { tg.setHeaderColor && tg.setHeaderColor('#000000'); } catch (_) {}
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (_) {}
  }
  function applyTheme(scheme) { document.body.classList.toggle('light', scheme === 'light'); }
  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'impact') tg.HapticFeedback.impactOccurred('medium');
      else if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
      else if (kind === 'warn') tg.HapticFeedback.notificationOccurred('warning');
      else tg.HapticFeedback.impactOccurred('light');
    } catch (_) {}
  }
  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData, ...(opts.headers || {}) },
  }).then(r => r.json());

  // ---- DOM --------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const streakNum = $('streakNum'), pointsNum = $('pointsNum'), totalNum = $('totalNum');
  const heat = $('heat'), userName = $('userName'), statusEl = $('status');
  const tasksEl = $('tasks'), milestonesEl = $('milestones'), storeEl = $('store');
  const walletState = $('walletState'), walletAddr = $('walletAddr'), walletBtn = $('walletBtn');
  const walletCard = $('walletCard'), popLayer = $('popLayer'), starBal = $('starBal');
  const checkinBtn = $('checkin'), checkinLabel = $('checkinLabel');
  let STATE = null;

  // ---- rolling counters -------------------------------------------------
  function rollTo(el, target) {
    if (!el) return;
    const start = parseInt(el.textContent, 10) || 0;
    if (start === target) return;
    const dur = 700, t0 = performance.now(), ease = t => 1 - Math.pow(1 - t, 3);
    (function step(now) {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(start + (target - start) * ease(p));
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

  // ---- paint ------------------------------------------------------------
  function paint(s) {
    if (!s) return;
    STATE = s; window.ORBYT.state = s;
    rollTo(streakNum, s.streak || 0);
    rollTo(pointsNum, s.points || 0);
    rollTo(totalNum, s.total || 0);
    if (s.name) userName.textContent = s.name.toLowerCase();
    if (s.today) { checkinBtn.classList.add('done'); checkinLabel.innerHTML = 'ORBIT<br/><em>logged today</em>'; }
    else { checkinBtn.classList.remove('done'); checkinLabel.innerHTML = 'CHECK IN<br/><em>+10 energy</em>'; }
    if (s.dev_mode) statusEl.textContent = 'dev mode · sign initData in production';
    if (starBal) starBal.textContent = s.stars != null ? s.stars : 0;
    renderHeat(s.heatmap || []);
    renderTasks(s.tasks || []);
    renderMilestones(s.streak_milestones || []);
    renderWallet(s.wallet);
    renderStore();
  }

  function renderHeat(cells) {
    heat.innerHTML = '';
    cells.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'cell' + (c.active ? ' on' : '') + (i === cells.length - 1 ? ' today' : '');
      heat.appendChild(d);
    });
  }

  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
  const INTERACTIVE = new Set(['manual', 'link', 'wallet']);
  function renderTasks(tasks) {
    tasksEl.innerHTML = '';
    tasks.forEach((t, i) => {
      const el = document.createElement('div');
      const clickable = !t.done && INTERACTIVE.has(t.kind || 'manual');
      el.className = 'task pop-in' + (t.done ? ' done' : '');
      el.setAttribute('data-clickable', clickable ? '1' : '0');
      el.style.animationDelay = (60 + i * 70) + 'ms';
      el.innerHTML =
        '<div class="task-index">' + String(i + 1).padStart(2, '0') + '</div>' +
        '<div class="task-check">' + CHECK + '</div>' +
        '<div class="task-main"><div class="task-title">' + esc(t.title) + '</div>' +
        '<div class="task-hint">' + esc(t.hint || '') + '</div></div>' +
        '<div class="task-reward">+' + (t.reward || 0) + '</div>';
      if (clickable) el.addEventListener('click', () => handleTask(t, el));
      tasksEl.appendChild(el);
    });
  }

  function renderMilestones(list) {
    milestonesEl.innerHTML = '';
    list.forEach((m, i) => {
      const el = document.createElement('div');
      const cls = m.claimed ? 'claimed' : (m.claimable ? 'claimable' : 'locked');
      el.className = 'ms pop-in ' + cls;
      el.style.animationDelay = (40 + i * 45) + 'ms';
      el.innerHTML =
        '<div class="ms-goal">' + m.milestone + '</div>' +
        '<div class="ms-cap">streak</div>' +
        '<div class="ms-rw">+' + m.reward + '</div>';
      if (m.claimable) el.addEventListener('click', () => claimMilestone(m, el));
      milestonesEl.appendChild(el);
    });
  }

  const STORE_ITEMS = [
    { id: 'boost1', ico: '⚡', title: '1 Boost', sub: 'Instant speed burst', cost: 5 },
    { id: 'boost3', ico: '⚡', title: '3 Boosts', sub: 'Best value pack', cost: 12 },
    { id: 'life1', ico: '♥', title: '1 Life', sub: 'Repair your hull', cost: 5 },
    { id: 'life3', ico: '♥', title: '3 Lives', sub: 'Full hull restore', cost: 12 },
  ];
  function renderStore() {
    if (!storeEl) return;
    storeEl.innerHTML = '';
    STORE_ITEMS.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'store-item pop-in';
      el.style.animationDelay = (40 + i * 50) + 'ms';
      el.innerHTML =
        '<div class="si-ico">' + it.ico + '</div>' +
        '<div class="si-main"><div class="si-title">' + it.title + '</div>' +
        '<div class="si-sub">' + it.sub + '</div></div>' +
        '<button class="si-buy">' + it.cost + ' ⭐</button>';
      el.querySelector('.si-buy').addEventListener('click', e => buyStore(it, e.currentTarget));
      storeEl.appendChild(el);
    });
  }

  function renderWallet(addr) {
    if (addr) {
      walletState.textContent = 'Connected';
      walletAddr.textContent = addr.length > 12 ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : addr;
      walletBtn.textContent = 'Disconnect';
      walletCard.classList.add('connected');
    } else {
      walletState.textContent = 'Not connected';
      walletAddr.textContent = '\u2014';
      walletBtn.textContent = 'Connect TON';
      walletCard.classList.remove('connected');
    }
  }

  // ---- actions ----------------------------------------------------------
  async function handleTask(t, el) {
    if (el.classList.contains('busy')) return;
    el.classList.add('busy'); haptic('light');
    const kind = t.kind || 'manual';
    if (kind === 'wallet') { go('pageWallet'); el.classList.remove('busy'); return; }
    if (kind === 'link' && t.url) {
      if (tg && /t\.me\//.test(t.url) && tg.openTelegramLink) tg.openTelegramLink(t.url);
      else if (tg && tg.openLink) tg.openLink(t.url);
      else window.open(t.url, '_blank');
    }
    try { paint(await api('/api/tasks/complete', { method: 'POST', body: JSON.stringify({ initData, task_id: t.id }) })); haptic('success'); }
    catch (_) {} finally { el.classList.remove('busy'); }
  }

  async function claimMilestone(m, el) {
    if (el.classList.contains('busy')) return;
    el.classList.add('busy'); haptic('success');
    try {
      const s = await api('/api/streak/claim', { method: 'POST', body: JSON.stringify({ initData, milestone: m.milestone }) });
      if (s && s.ok !== false) { floatPoints(m.reward, el); paint(s); }
    } catch (_) {} finally { el.classList.remove('busy'); }
  }

  async function buyStore(it, btn) {
    if (btn.classList.contains('busy')) return;
    if (STATE && (STATE.stars || 0) < it.cost) {
      btn.textContent = 'need ⭐'; haptic('warn');
      setTimeout(() => (btn.textContent = it.cost + ' ⭐'), 1100);
      return;
    }
    btn.classList.add('busy'); haptic('impact');
    try {
      const s = await api('/api/store/buy', { method: 'POST', body: JSON.stringify({ initData, item: it.id }) });
      if (s && s.ok === false) { btn.textContent = 'sold out'; }
      else { paint(s); haptic('success'); }
    } catch (_) {} finally { setTimeout(() => btn.classList.remove('busy'), 300); }
  }

  // ---- daily check-in ---------------------------------------------------
  let busy = false;
  async function checkin() {
    if (busy || (STATE && STATE.today)) { if (STATE && STATE.today) haptic('light'); return; }
    busy = true;
    const prev = STATE ? (STATE.points || 0) : 0;
    haptic('impact');
    checkinBtn.classList.remove('pulse'); void checkinBtn.offsetWidth; checkinBtn.classList.add('pulse');
    try {
      const s = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ initData }) });
      const delta = Math.max(0, (s.points || 0) - prev);
      if (delta > 0) floatPoints(delta);
      paint(s); haptic('success');
    } catch (_) { statusEl.textContent = 'connection lost · try again'; }
    finally { setTimeout(() => (busy = false), 400); }
  }
  function floatPoints(n, near) {
    const layer = popLayer; if (!layer) return;
    const s = document.createElement('span');
    s.className = 'float-pt'; s.textContent = '+' + n;
    if (near) {
      const r = near.getBoundingClientRect(), p = layer.getBoundingClientRect();
      s.style.left = (r.left - p.left + r.width / 2) + 'px';
      s.style.top = (r.top - p.top) + 'px'; s.style.transform = 'translateX(-50%)';
    } else { s.style.left = (44 + Math.random() * 12) + '%'; }
    layer.appendChild(s); setTimeout(() => s.remove(), 1500);
  }
  checkinBtn.addEventListener('click', checkin);

  // ---- wallet connect ---------------------------------------------------
  walletBtn.addEventListener('click', async () => {
    if (walletBtn.classList.contains('busy')) return;
    walletBtn.classList.add('busy'); haptic('impact');
    try {
      if (STATE && STATE.wallet) {
        paint(await api('/api/wallet', { method: 'POST', body: JSON.stringify({ initData, address: '' }) }));
      } else {
        walletBtn.textContent = 'Connecting\u2026';
        await new Promise(r => setTimeout(r, 900));
        const addr = 'UQ' + Array.from({ length: 46 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        paint(await api('/api/wallet', { method: 'POST', body: JSON.stringify({ initData, address: addr }) }));
        haptic('success');
      }
    } catch (_) {} finally { walletBtn.classList.remove('busy'); }
  });

  // ---- horizontal navigation -------------------------------------------
  const home = $('pageHome');
  let current = null;
  function go(id) {
    const page = $(id); if (!page || current === id) return;
    haptic('light');
    if (current) { const p = $(current); p && p.classList.remove('on'); }
    home.classList.add('dim');
    page.classList.remove('leaving');
    page.classList.add('on');
    current = id;
    try { if (tg && tg.BackButton) { tg.BackButton.show(); } } catch (_) {}
  }
  function back() {
    if (!current) return;
    haptic('light');
    const page = $(current);
    page.classList.remove('on'); page.classList.add('leaving');
    setTimeout(() => page && page.classList.remove('leaving'), 520);
    home.classList.remove('dim');
    current = null;
    try { if (tg && tg.BackButton) { tg.BackButton.hide(); } } catch (_) {}
  }
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.getAttribute('data-go'))));
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', back));
  try { if (tg && tg.BackButton) tg.BackButton.onClick(back); } catch (_) {}
  window.ORBYT_NAV = { go, back };

  // ---- global tap ripples + bubbles ------------------------------------
  const tapLayer = $('tapLayer');
  function tapFx(x, y) {
    if (!tapLayer) return;
    const r = document.createElement('span');
    r.className = 'ripple';
    const size = 46 + Math.random() * 20;
    r.style.left = x + 'px'; r.style.top = y + 'px';
    r.style.width = r.style.height = size + 'px';
    tapLayer.appendChild(r); setTimeout(() => r.remove(), 640);
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('span');
      b.className = 'tap-bubble';
      const a = Math.random() * 6.2832, d = 18 + Math.random() * 34;
      b.style.left = x + 'px'; b.style.top = y + 'px';
      b.style.setProperty('--bx', (Math.cos(a) * d) + 'px');
      b.style.setProperty('--by', (Math.sin(a) * d) + 'px');
      tapLayer.appendChild(b); setTimeout(() => b.remove(), 820);
    }
  }
  addEventListener('pointerdown', e => {
    if ($('gameOverlay').classList.contains('on')) return;
    tapFx(e.clientX, e.clientY);
  }, { passive: true });

  // ---- micro-interactions ----------------------------------------------
  const chip = $('userChip');
  if (chip) chip.addEventListener('click', () => { chip.style.animation = 'none'; void chip.offsetWidth; chip.style.animation = 'chipIn .6s var(--pop)'; haptic('light'); });
  document.querySelectorAll('.stat').forEach(st => st.addEventListener('click', () => {
    st.classList.remove('ping'); void st.offsetWidth; st.classList.add('ping'); haptic('light');
  }));

  // ---- deep-space drifting starfield + shooting stars ------------------
  (() => {
    const cv = $('space'); const ctx = cv.getContext('2d');
    let W, H, dpr = 1; const layers = []; const shooting = [];
    const px = { x: 0, y: 0 };
    function rand(a, b) { return a + Math.random() * (b - a); }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; build();
    }
    function build() {
      layers.length = 0;
      const mobile = innerWidth < 640, div = mobile ? 1.6 : 1;
      [{ s: 0.6, sp: 0.004, tw: 0.6, n: Math.round(W * H / (15000 * dpr * div)) },
       { s: 1.0, sp: 0.011, tw: 1.0, n: Math.round(W * H / (30000 * dpr * div)) },
       { s: 1.7, sp: 0.022, tw: 1.4, n: Math.round(W * H / (72000 * dpr * div)) }].forEach(d => {
        const stars = [];
        for (let i = 0; i < d.n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, r: (0.3 + Math.random() * d.s) * dpr, ph: Math.random() * 6.28 });
        layers.push({ ...d, stars });
      });
    }
    resize(); addEventListener('resize', resize);
    addEventListener('pointermove', e => { px.x = (e.clientX / innerWidth - 0.5); px.y = (e.clientY / innerHeight - 0.5); }, { passive: true });
    let t = 0;
    function frame() {
      t += 0.016;
      const light = document.body.classList.contains('light');
      const base = light ? '10,12,24' : '255,255,255';
      ctx.clearRect(0, 0, W, H);
      layers.forEach((L, li) => {
        const ox = px.x * (li + 1) * 16 * dpr, oy = px.y * (li + 1) * 16 * dpr;
        for (const s of L.stars) {
          s.y += L.sp * dpr; if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
          const tw = 0.55 + 0.45 * Math.sin(t * L.tw + s.ph);
          ctx.beginPath(); ctx.fillStyle = `rgba(${base},${(light ? 0.45 : 0.85) * tw})`;
          ctx.arc(s.x + ox, s.y + oy, s.r, 0, 6.2832); ctx.fill();
        }
      });
      if (Math.random() < 0.005 && shooting.length < 2)
        shooting.push({ x: rand(-0.1, 0.4) * W, y: rand(0, 0.5) * H, vx: rand(7, 12) * dpr, vy: rand(2, 4) * dpr, life: 1 });
      for (let i = shooting.length - 1; i >= 0; i--) {
        const sh = shooting[i]; sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.012;
        if (sh.life <= 0 || sh.x > W + 80 * dpr) { shooting.splice(i, 1); continue; }
        const tx = sh.x - sh.vx * 9, ty = sh.y - sh.vy * 9;
        const g = ctx.createLinearGradient(tx, ty, sh.x, sh.y);
        g.addColorStop(0, `rgba(${base},0)`); g.addColorStop(1, `rgba(${base},${0.9 * sh.life})`);
        ctx.strokeStyle = g; ctx.lineWidth = 1.6 * dpr; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(sh.x, sh.y); ctx.stroke();
      }
      requestAnimationFrame(frame);
    }
    frame();
  })();

  // ---- intro particles converge -----------------------------------------
  (() => {
    const cv = $('introCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    const cx = W / 2, cy = H / 2;
    function rand(a, b) { return a + Math.random() * (b - a); }
    const N = innerWidth < 640 ? 90 : 150; const ps = [];
    for (let i = 0; i < N; i++) {
      const a = Math.random() * 6.28, far = Math.max(W, H) * (0.4 + Math.random() * 0.5), near = rand(12, 95) * dpr;
      ps.push({ x: cx + Math.cos(a) * far, y: cy + Math.sin(a) * far, tx: cx + Math.cos(a) * near, ty: cy + Math.sin(a) * near, r: rand(0.6, 2) * dpr, delay: Math.random() * 0.45 });
    }
    const intro = $('intro'); const t0 = performance.now();
    function frame(now) {
      const light = document.body.classList.contains('light');
      const base = light ? '10,12,24' : '255,255,255';
      const p = Math.min(1, (now - t0) / 2200), ease = 1 - Math.pow(1 - p, 3);
      ctx.clearRect(0, 0, W, H);
      for (const q of ps) {
        const local = Math.min(1, Math.max(0, (ease - q.delay) / (1 - q.delay)));
        const x = q.x + (q.tx - q.x) * local, y = q.y + (q.ty - q.y) * local;
        ctx.beginPath(); ctx.fillStyle = `rgba(${base},${0.12 + local * 0.6})`;
        ctx.arc(x, y, q.r, 0, 6.2832); ctx.fill();
      }
      if (!(intro && intro.classList.contains('gone'))) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })();

  // ---- liquid bubbles (hero + panels) -----------------------------------
  function initBubbles(id) {
    const cv = document.getElementById(id); if (!cv) return;
    const ctx = cv.getContext('2d'); let W, H, dpr = 1; let bubbles = [];
    function rand(a, b) { return a + Math.random() * (b - a); }
    function mk(spread) {
      const r = rand(4, 22) * dpr;
      return { x: rand(0, W || 300), y: spread ? rand(0, H || 600) : (H || 600) + r + rand(0, (H || 600) * 0.3),
        r, vy: rand(6, 20) * dpr / 60, drift: rand(-7, 7) * dpr / 60, ph: Math.random() * 6.28, wob: rand(0.4, 1.1), fill: Math.random() < 0.5 };
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const b = cv.getBoundingClientRect();
      W = cv.width = Math.max(1, b.width) * dpr; H = cv.height = Math.max(1, b.height) * dpr;
      const n = Math.max(6, Math.round(W * H / (95000 * dpr)));
      bubbles = []; for (let i = 0; i < n; i++) bubbles.push(mk(true));
    }
    new ResizeObserver(resize).observe(cv); resize();
    let t = 0;
    function frame() {
      t += 0.016;
      const light = document.body.classList.contains('light');
      const base = light ? '0,0,0' : '255,255,255';
      ctx.clearRect(0, 0, W, H);
      for (const b of bubbles) {
        b.y -= b.vy; b.x += b.drift + Math.sin(t * b.wob + b.ph) * 0.35 * dpr;
        if (b.y + b.r < 0) Object.assign(b, mk(false));
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.2832);
        if (b.fill) { ctx.fillStyle = `rgba(${base},0.05)`; ctx.fill(); }
        ctx.strokeStyle = `rgba(${base},0.14)`; ctx.lineWidth = dpr; ctx.stroke();
        ctx.beginPath(); ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.18, 0, 6.2832);
        ctx.fillStyle = `rgba(${base},0.24)`; ctx.fill();
      }
      requestAnimationFrame(frame);
    }
    frame();
  }
  initBubbles('bubblesHero'); initBubbles('bubblesTasks'); initBubbles('bubblesWallet');

  // ---- bridge for the space-explorer game -------------------------------
  window.ORBYT = {
    get initData() { return initData; },
    state: null,
    refresh: () => api('/api/state').then(paint).catch(() => {}),
    paint,
  };
  window.PULSE = window.ORBYT; // backward-compat alias

  // ---- intro + initial load --------------------------------------------
  const intro = $('intro');
  setTimeout(() => { if (intro) intro.classList.add('gone'); haptic('light'); }, 2900);
  api('/api/state').then(paint).catch(() => { statusEl.textContent = 'offline · reconnect to sync'; });
})();
