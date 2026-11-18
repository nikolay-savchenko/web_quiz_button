/*
 * Общий клиентский модуль: WebSocket с автопереподключением + синхронизация часов с сервером.
 * Оценка сдвига часов — как в NTP: offset = ts - (t0 + t1) / 2, берём замер с минимальным RTT
 * из последних N (у него наименьшая погрешность).
 */
(function () {
  const now = () => performance.timeOrigin + performance.now();

  function createConnection({ onMessage, onOpen, onStatus }) {
    let ws = null;
    let samples = [];
    let offset = 0;
    let rtt = null;
    let lastRtt = null;
    let pingTimer = null;
    let burstTimer = null;
    let retry = 0;

    function addSample(t0, ts) {
      const t1 = now();
      const r = t1 - t0;
      lastRtt = r;
      samples.push({ r, off: ts - (t0 + t1) / 2 });
      if (samples.length > 15) samples.shift();
      const best = samples.reduce((a, b) => (b.r < a.r ? b : a));
      offset = best.off;
      rtt = best.r;
    }

    function ping() {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: now() }));
    }

    function startPinging() {
      clearInterval(pingTimer);
      clearInterval(burstTimer);
      // быстрая пачка замеров на старте, потом раз в секунду (заодно не даём модему телефона «уснуть»)
      let n = 0;
      burstTimer = setInterval(() => { ping(); if (++n >= 8) clearInterval(burstTimer); }, 120);
      pingTimer = setInterval(ping, 1000);
    }

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      onStatus && onStatus('connecting');
      ws.onopen = () => {
        retry = 0;
        samples = [];
        onStatus && onStatus('online');
        startPinging();
        onOpen && onOpen();
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'pong') return addSample(m.t0, m.ts);
        onMessage(m);
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        clearInterval(burstTimer);
        onStatus && onStatus('offline');
        setTimeout(connect, Math.min(3000, 300 * ++retry));
      };
      ws.onerror = () => ws.close();
    }

    // после сна/сворачивания часы могли «поплыть» — пересинхронизируемся
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        samples = [];
        if (ws && ws.readyState === 1) startPinging();
        else if (ws && ws.readyState > 1) connect();
      }
    });

    setTimeout(connect, 0); // после того как вызывающий код получит объект соединения

    return {
      send: (obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj)),
      serverNow: () => now() + offset,
      get rtt() { return rtt; },
      get lastRtt() { return lastRtt; },
      get synced() { return samples.length >= 3; },
      get online() { return ws && ws.readyState === 1; },
    };
  }

  window.QuizSync = { createConnection, now };
})();
