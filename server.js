'use strict';
/*
 * Сервер квиз-кнопки.
 *
 * Честность «кто первый»:
 *  - телефоны постоянно синхронизируют часы с сервером (ping/pong, берём замер с минимальным RTT);
 *  - при нажатии телефон сразу считает «серверное время нажатия» и шлёт его;
 *  - сервер ждёт JUDGE_WINDOW_MS после первого пришедшего нажатия, собирает остальные
 *    и сортирует по времени нажатия, а не по времени прихода пакета;
 *  - кнопки открываются не «когда дошло сообщение», а в момент armAt (чуть в будущем),
 *    одинаковый для всех по синхронизированным часам.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e84393', '#7f8c8d'];

function createApp(opts = {}) {
  const cfg = {
    port: +(opts.port ?? process.env.PORT ?? 3000),
    hostKey: opts.hostKey ?? process.env.HOST_KEY ?? crypto.randomBytes(4).toString('hex'),
    publicUrl: opts.publicUrl ?? process.env.PUBLIC_URL ?? '',
    armDelayMs: +(opts.armDelayMs ?? process.env.ARM_DELAY_MS ?? 400),
    judgeWindowMs: +(opts.judgeWindowMs ?? process.env.JUDGE_WINDOW_MS ?? 500),
    maxLagMs: +(opts.maxLagMs ?? process.env.MAX_LAG_MS ?? 1500),
    dataFile: opts.dataFile ?? process.env.DATA_FILE ?? path.join(__dirname, 'data', 'state.json'),
    quiet: !!opts.quiet,
  };
  const log = (...a) => { if (!cfg.quiet) console.log(new Date().toISOString(), ...a); };
  const now = () => performance.timeOrigin + performance.now();

  // ---------- постоянное состояние (команды, счёт, настройки) ----------
  let saved = {
    teams: ['Команда 1', 'Команда 2', 'Команда 3'].map((name, i) => ({ id: 't' + (i + 1), name, color: PALETTE[i], score: 0 })),
    cost: 100,
    penaltyMs: 2000,
  };
  try {
    if (opts.dataFile !== null && fs.existsSync(cfg.dataFile)) {
      saved = { ...saved, ...JSON.parse(fs.readFileSync(cfg.dataFile, 'utf8')) };
    }
  } catch (e) { log('не смог прочитать', cfg.dataFile, e.message); }

  let saveTimer = null;
  function persist() {
    if (opts.dataFile === null) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
        fs.writeFileSync(cfg.dataFile, JSON.stringify(saved, null, 2));
      } catch (e) { log('не смог сохранить', e.message); }
    }, 200);
  }

  // ---------- состояние раунда ----------
  const round = {
    phase: 'idle',       // idle | armed | judging | answering
    armAt: 0,
    presses: [],         // {teamId, est, recv, rtt}
    winner: null,
    excluded: new Set(), // команды, которые уже ошиблись на этом вопросе
    judgeTimer: null,
    question: 1,
  };
  const penalties = new Map(); // teamId -> до какого серверного времени заблокирована

  const teamById = (id) => saved.teams.find((t) => t.id === id);

  // ---------- сеть ----------
  const clients = new Set(); // ws с полями .role, .teamId

  function snapshot() {
    const online = {};
    for (const ws of clients) if (ws.role === 'player' && ws.teamId) online[ws.teamId] = (online[ws.teamId] || 0) + 1;
    const first = round.presses[0];
    const t = now();
    const pen = {};
    for (const [id, until] of penalties) if (until > t) pen[id] = until;
    return {
      type: 'state',
      phase: round.phase,
      armAt: round.armAt,
      question: round.question,
      winner: round.winner,
      presses: round.presses.map((p) => ({
        teamId: p.teamId,
        est: p.est,
        diff: first ? Math.round(p.est - first.est) : 0,
        reaction: Math.round(p.est - round.armAt),
        late: !!p.late,
      })),
      excluded: [...round.excluded],
      penalties: pen,
      teams: saved.teams,
      cost: saved.cost,
      penaltyMs: saved.penaltyMs,
      online,
      hostsOnline: [...clients].filter((c) => c.role === 'host').length,
    };
  }

  function broadcast() {
    const msg = JSON.stringify(snapshot());
    for (const ws of clients) if (ws.readyState === 1 && ws.role) ws.send(msg);
  }
  function sendTo(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function event(name, extra = {}) {
    const msg = JSON.stringify({ type: 'event', name, ...extra });
    for (const ws of clients) if (ws.readyState === 1 && ws.role) ws.send(msg);
  }

  // ---------- логика игры ----------
  function arm() {
    const eligible = saved.teams.filter((t) => !round.excluded.has(t.id));
    if (!eligible.length) { resetRound(false); return; }
    clearTimeout(round.judgeTimer);
    round.phase = 'armed';
    round.armAt = now() + cfg.armDelayMs;
    round.presses = [];
    round.winner = null;
    log('кнопки открываются, вопрос', round.question);
    broadcast();
  }

  function resetRound(newQuestion = true) {
    clearTimeout(round.judgeTimer);
    round.phase = 'idle';
    round.presses = [];
    round.winner = null;
    round.armAt = 0;
    if (newQuestion) { round.excluded.clear(); round.question++; penalties.clear(); }
    broadcast();
  }

  function judge() {
    round.presses.sort((a, b) => a.est - b.est || a.recv - b.recv);
    round.winner = round.presses[0]?.teamId ?? null;
    round.phase = round.winner ? 'answering' : 'armed';
    const w = teamById(round.winner);
    log('отвечает:', w?.name, round.presses.map((p) => `${teamById(p.teamId)?.name}@${Math.round(p.est - round.armAt)}ms`).join(', '));
    broadcast();
    event('winner', { teamId: round.winner });
  }

  function onPress(ws, m) {
    const teamId = ws.teamId;
    if (!teamById(teamId)) return;
    const recv = now();
    let est = Number(m.est);
    const rtt = Math.max(0, Number(m.rtt) || 0);
    // санитарные проверки оценки клиента
    if (!Number.isFinite(est) || est > recv) est = recv;
    if (recv - est > cfg.maxLagMs) est = recv - rtt / 2;

    if (round.phase !== 'armed' && round.phase !== 'judging' && round.phase !== 'answering') return;
    if (round.excluded.has(teamId)) return;
    if ((penalties.get(teamId) || 0) > est) return;
    if (est < round.armAt) est = round.armAt; // клиент думал, что уже можно — погрешность синхронизации

    const existing = round.presses.find((p) => p.teamId === teamId);
    if (existing) { // второй телефон той же команды — берём более раннее нажатие
      if (est < existing.est && round.phase !== 'answering') { existing.est = est; existing.recv = recv; }
      return;
    }
    const press = { teamId, est, recv, rtt, late: round.phase === 'answering' };
    round.presses.push(press);
    if (round.phase === 'armed') {
      round.phase = 'judging';
      round.judgeTimer = setTimeout(judge, cfg.judgeWindowMs);
    } else if (round.phase === 'answering') {
      // опоздавшие — просто для информации, победителя не меняем
      const first = round.presses[0];
      round.presses = [first, ...round.presses.slice(1).sort((a, b) => a.est - b.est)];
    }
    broadcast();
  }

  function onEarly(ws, m) {
    const teamId = ws.teamId;
    if (!teamById(teamId) || !saved.penaltyMs) return;
    if (round.excluded.has(teamId)) return;
    const est = Math.min(Number(m.est) || now(), now());
    const isEarly = round.phase === 'idle' || (round.phase === 'armed' && est < round.armAt);
    if (!isEarly) return;
    if ((penalties.get(teamId) || 0) > now()) return; // уже наказаны
    penalties.set(teamId, now() + saved.penaltyMs);
    log('фальстарт:', teamById(teamId).name);
    broadcast();
    event('falseStart', { teamId });
  }

  function onHost(ws, m) {
    switch (m.type) {
      case 'arm': arm(); break;
      case 'reset': resetRound(true); break;
      case 'correct': {
        const w = teamById(round.winner);
        if (round.phase === 'answering' && w) { w.score += saved.cost; persist(); }
        resetRound(true);
        break;
      }
      case 'wrong': {
        const w = teamById(round.winner);
        if (round.phase === 'answering' && w) {
          w.score -= saved.cost; persist();
          round.excluded.add(w.id);
          arm(); // остальные могут жать сразу
        }
        break;
      }
      case 'score': {
        const t = teamById(m.teamId);
        if (t && Number.isFinite(+m.delta)) { t.score += +m.delta; persist(); broadcast(); }
        break;
      }
      case 'resetScores': saved.teams.forEach((t) => (t.score = 0)); persist(); broadcast(); break;
      case 'config': {
        if (Array.isArray(m.teams)) {
          const names = m.teams.map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 8);
          if (names.length) {
            saved.teams = names.map((name, i) => {
              const old = saved.teams[i];
              return { id: old?.id || 't' + crypto.randomBytes(3).toString('hex'), name, color: PALETTE[i % PALETTE.length], score: old?.score || 0 };
            });
          }
        }
        if (Number.isFinite(+m.cost)) saved.cost = Math.max(0, Math.round(+m.cost));
        if (Number.isFinite(+m.penaltyMs)) saved.penaltyMs = Math.max(0, Math.min(10000, Math.round(+m.penaltyMs)));
        persist();
        resetRound(true);
        break;
      }
    }
  }

  // ---------- HTTP ----------
  const STATIC = {
    '/': ['play.html', 'text/html; charset=utf-8'],
    '/play': ['play.html', 'text/html; charset=utf-8'],
    '/host': ['host.html', 'text/html; charset=utf-8'],
    '/sync.js': ['sync.js', 'application/javascript; charset=utf-8'],
  };

  function playerUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl.replace(/\/?$/, '/');
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    return `${proto}://${req.headers.host}/`;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/qr.svg') {
      const svg = await QRCode.toString(playerUrl(req), { type: 'svg', margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    }
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const entry = STATIC[url.pathname];
    if (!entry) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(path.join(__dirname, 'public', entry[0]), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    clients.add(ws);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'ping') return sendTo(ws, { type: 'pong', t0: m.t0, ts: now() });
      if (m.type === 'hello') {
        if (m.role === 'host') {
          if (m.key !== cfg.hostKey) return sendTo(ws, { type: 'auth', ok: false });
          ws.role = 'host';
          sendTo(ws, { type: 'auth', ok: true });
        } else {
          ws.role = 'player';
          ws.teamId = teamById(m.teamId) ? m.teamId : null;
        }
        return broadcast();
      }
      if (ws.role === 'player') {
        if (m.type === 'join') { ws.teamId = teamById(m.teamId) ? m.teamId : null; return broadcast(); }
        if (m.type === 'press') return onPress(ws, m);
        if (m.type === 'early') return onEarly(ws, m);
      }
      if (ws.role === 'host') return onHost(ws, m);
    });
    ws.on('close', () => { clients.delete(ws); broadcast(); });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 10000);

  return {
    cfg,
    server,
    listen: () => new Promise((resolve) => server.listen(cfg.port, () => resolve(server.address().port))),
    close: () => { clearInterval(heartbeat); clearTimeout(round.judgeTimer); for (const ws of clients) ws.terminate(); wss.close(); server.close(); },
  };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.listen().then((port) => {
    console.log(`Квиз-кнопка запущена на порту ${port}`);
    console.log(`  Игроки:   ${app.cfg.publicUrl || `http://localhost:${port}`}/`);
    console.log(`  Ведущий:  ${app.cfg.publicUrl || `http://localhost:${port}`}/host?key=${app.cfg.hostKey}`);
  });
}
