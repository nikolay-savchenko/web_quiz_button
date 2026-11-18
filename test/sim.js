'use strict';
/*
 * Симуляция: три «телефона» с разной задержкой сети, джиттером и сбитыми часами.
 * Проверяем, что побеждает тот, кто реально нажал раньше, а не тот, у кого быстрее сеть.
 *   node test/sim.js
 */
const assert = require('assert');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');
const { createApp } = require('../server');

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(port, { role = 'player', teamId, key, delay = 10, jitter = 0, skew = 0 }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const local = () => now() + skew; // часы телефона сбиты на skew
  const d = () => delay + Math.random() * jitter;
  const samples = [];
  let offset = 0, rtt = 0;
  const c = { state: null, events: [], ws };
  c.send = (obj) => setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify(obj)), d());
  c.serverNow = () => local() + offset;
  ws.on('message', (raw) => setTimeout(() => {
    const m = JSON.parse(raw);
    if (m.type === 'pong') {
      const t1 = local();
      samples.push({ r: t1 - m.t0, off: m.ts - (m.t0 + t1) / 2 });
      if (samples.length > 15) samples.shift();
      const best = samples.reduce((a, b) => (b.r < a.r ? b : a));
      offset = best.off; rtt = best.r;
    } else if (m.type === 'state') c.state = m;
    else if (m.type === 'event') c.events.push(m);
  }, d()));
  c.ready = new Promise((res) => ws.on('open', () => {
    c.send({ type: 'hello', role, teamId, key });
    c.pinger = setInterval(() => c.send({ type: 'ping', t0: local() }), 100);
    res();
  }));
  // нажать через reactionMs после того, как кнопка «загорелась» у этого телефона
  c.pressAfterUnlock = async (reactionMs) => {
    while (!(c.state && c.state.phase === 'armed')) await sleep(1);
    const wait = c.state.armAt - c.serverNow();
    await sleep(Math.max(0, wait) + reactionMs);
    c.send({ type: 'press', est: c.serverNow(), rtt });
  };
  c.early = () => c.send({ type: 'early', est: c.serverNow() });
  c.close = () => { clearInterval(c.pinger); ws.close(); };
  return c;
}

async function waitFor(c, pred, timeout = 4000) {
  const t = Date.now();
  while (!(c.state && pred(c.state))) {
    if (Date.now() - t > timeout) throw new Error('timeout, state=' + JSON.stringify(c.state && { phase: c.state.phase, presses: c.state.presses }));
    await sleep(5);
  }
  return c.state;
}

(async () => {
  const app = createApp({ port: 0, hostKey: 'test', dataFile: null, quiet: true, armDelayMs: 400, judgeWindowMs: 500 });
  const port = await app.listen();

  const host = makeClient(port, { role: 'host', key: 'test', delay: 1 });
  // A: плохая сеть (300 мс в одну сторону, джиттер 80) и часы спешат на 5 с
  const A = makeClient(port, { teamId: 't1', delay: 300, jitter: 80, skew: 5000 });
  // B: отличная сеть, часы отстают на 3 с
  const B = makeClient(port, { teamId: 't2', delay: 5, jitter: 5, skew: -3000 });
  // C: средняя сеть
  const C = makeClient(port, { teamId: 't3', delay: 60, jitter: 40, skew: 1234 });
  await Promise.all([host.ready, A.ready, B.ready, C.ready]);
  await sleep(2500); // даём синхронизироваться
  const name = (id) => host.state.teams.find((t) => t.id === id).name;
  let failed = 0;
  const check = (title, fn) => { try { fn(); console.log('  ✓', title); } catch (e) { failed++; console.log('  ✗', title, '\n   ', e.message); } };

  // --- 1. медленная сеть, но нажал раньше — должен победить
  console.log('Сценарий 1: A (пинг ~600 мс) жмёт через 80 мс, B (пинг ~10 мс) через 150 мс, C через 200 мс');
  host.send({ type: 'arm' });
  await Promise.all([A.pressAfterUnlock(80), B.pressAfterUnlock(150), C.pressAfterUnlock(200)]);
  let s = await waitFor(host, (s) => s.phase === 'answering');
  console.log('   порядок:', s.presses.map((p) => `${name(p.teamId)} ${p.reaction}мс`).join(', '));
  check('первой отвечает A', () => assert.strictEqual(s.winner, 't1'));
  check('порядок A, B, C', () => assert.deepStrictEqual(s.presses.map((p) => p.teamId), ['t1', 't2', 't3']));
  check('реакции измерены с точностью ±40 мс', () => {
    const exp = { t1: 80, t2: 150, t3: 200 };
    for (const p of s.presses) assert.ok(Math.abs(p.reaction - exp[p.teamId]) < 40, `${p.teamId}: ${p.reaction} vs ${exp[p.teamId]}`);
  });

  // --- 2. неверный ответ: A исключена, кнопки открываются для остальных
  console.log('Сценарий 2: A ответила неверно → жмут B и C');
  host.send({ type: 'wrong' });
  await waitFor(host, (s) => s.phase === 'armed' && s.excluded.includes('t1'));
  await Promise.all([B.pressAfterUnlock(300), C.pressAfterUnlock(100), A.pressAfterUnlock(10)]);
  s = await waitFor(host, (s) => s.phase === 'answering');
  check('A не может жать после ошибки', () => assert.ok(!s.presses.some((p) => p.teamId === 't1')));
  check('отвечает C', () => assert.strictEqual(s.winner, 't3'));
  check('A получила минус', () => assert.strictEqual(s.teams.find((t) => t.id === 't1').score, -100));
  host.send({ type: 'correct' });
  s = await waitFor(host, (s) => s.phase === 'idle' && s.excluded.length === 0);
  check('C получила плюс', () => assert.strictEqual(s.teams.find((t) => t.id === 't3').score, 100));

  // --- 3. фальстарт
  console.log('Сценарий 3: B жмёт до открытия кнопок → штраф 2 с');
  B.early();
  s = await waitFor(host, (s) => !!s.penalties.t2);
  check('B получила штраф', () => assert.ok(s.penalties.t2));
  host.send({ type: 'arm' });
  await Promise.all([B.pressAfterUnlock(20), C.pressAfterUnlock(250)]);
  s = await waitFor(host, (s) => s.phase === 'answering');
  check('нажатие B во время штрафа не засчитано', () => assert.strictEqual(s.winner, 't3'));

  // --- 4. повтор сценария 1 много раз со случайным джиттером
  console.log('Сценарий 4: 15 раундов, разница реакций 25 мс, сеть A хуже на ~600 мс');
  host.send({ type: 'reset' });
  await waitFor(host, (s) => s.phase === 'idle' && !s.penalties.t2);
  await sleep(2100);
  let wins = 0;
  for (let i = 0; i < 15; i++) {
    host.send({ type: 'reset' });
    await waitFor(host, (s) => s.phase === 'idle');
    host.send({ type: 'arm' });
    await Promise.all([A.pressAfterUnlock(100), B.pressAfterUnlock(125)]);
    s = await waitFor(host, (s) => s.phase === 'answering');
    if (s.winner === 't1') wins++;
  }
  check(`A побеждает во всех раундах (${wins}/15)`, () => assert.strictEqual(wins, 15));

  [host, A, B, C].forEach((c) => c.close());
  app.close();
  console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
