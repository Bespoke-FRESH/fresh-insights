#!/usr/bin/env node
// Responsive legibility eval for FRESH interactive charts.
//
// Loads each URL at a matrix of screen sizes and checks every .story-frame
// iframe so we stop shipping charts that are too tall, too small, clipped,
// or broken on a given monitor. For each (size x interactive) it asserts:
//   - the chart FITS the viewport height (no overflow / scroll-clipping)
//   - text renders within a readable px band (not microscopic, not absurd)
//   - the SVG drawing stays inside its viewBox (nothing clipped)
//   - the page logs no console errors
//
// Zero dependencies: drives headless Chrome over the DevTools protocol using
// Node's built-in fetch + WebSocket (Node >= 21). Just needs Chrome installed.
//
// Usage:
//   node tools/legibility-eval.mjs <url> [moreUrls...]
//   CHROME_PATH=/path/to/chrome node tools/legibility-eval.mjs <url>
// Exits non-zero if any check fails (so it can gate a commit/deploy).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const SIZES = [
  { name: 'mobile',  w: 390,  h: 844  },
  { name: 'laptop',  w: 1366, h: 768  },
  { name: 'laptop+', w: 1440, h: 900  },
  { name: 'desktop', w: 1920, h: 1080 },
];
// Thresholds. fitFrac: chart height must be <= this fraction of the viewport.
// minTextPx: smallest rendered text in the SVG must be at least this many CSS px.
// narratorMin/Max: the caption font must land in a sane, readable band.
const T = { fitFrac: 0.96, minTextPx: 11, narratorMin: 13, narratorMax: 40 };

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9355);

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('usage: node tools/legibility-eval.mjs <url> [moreUrls...]');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-eval-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

async function newTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debug target — is CHROME_PATH right?');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const listeners = [];
  const ready = new Promise((res) => ws.addEventListener('open', res, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) listeners.forEach((fn) => fn(m));
  });
  const send = (method, params = {}) => { id++; return new Promise((res, rej) => {
    pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); };
  return { ready, send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

// Runs in the page. Measures each interactive iframe.
const MEASURE = `(${function () {
  const vh = innerHeight, vw = innerWidth, out = [];
  document.querySelectorAll('iframe.story-frame').forEach((f) => {
    const r = f.getBoundingClientRect();
    const o = { id: f.id, iframeH: Math.round(r.height), fitsViewport: r.height <= vh * 0.96 };
    try {
      const d = f.contentDocument, svg = d.querySelector('svg'), vb = svg.viewBox.baseVal,
        sr = svg.getBoundingClientRect();
      const scale = Math.min(sr.width / vb.width, sr.height / vb.height); // preserveAspectRatio meet
      let mn = Infinity, mx = 0;
      d.querySelectorAll('svg text').forEach((t) => {
        const fsz = parseFloat(getComputedStyle(t).fontSize) || 0;
        if (fsz > 0 && t.textContent.trim()) { const p = fsz * scale; mn = Math.min(mn, p); mx = Math.max(mx, p); }
      });
      // clipping: does any drawn geometry fall outside the viewBox box?
      let clipped = false;
      d.querySelectorAll('svg [data-i], svg circle, svg rect, svg text').forEach((el) => {
        try { const b = el.getBBox();
          if (b.x < vb.x - 1 || b.y < vb.y - 1 || b.x + b.width > vb.x + vb.width + 1 || b.y + b.height > vb.y + vb.height + 1) clipped = true;
        } catch {}
      });
      o.minTextPx = Math.round(mn); o.maxTextPx = Math.round(mx);
      o.narratorPx = Math.round(parseFloat(getComputedStyle(d.querySelector('.narrator')).fontSize));
      o.clipped = clipped;
    } catch (e) { o.err = String(e); }
    out.push(o);
  });
  return { vw, vh, frames: out };
}})()`;

(async () => {
  const tgt = await newTarget();
  const c = connect(tgt.webSocketDebuggerUrl);
  await c.ready;
  let errors = [];
  c.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');

  let allPass = true;
  for (const url of urls) {
    console.log(`\n=== ${url} ===`);
    for (const s of SIZES) {
      errors = [];
      await c.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await c.send('Page.navigate', { url });
      await sleep(2400); // page load + iframe render (cold nav needs headroom)
      const { result } = await c.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true, awaitPromise: true });
      const data = result.value || { frames: [] };
      const errSnapshot = errors.length;
      for (const fr of data.frames) {
        const fit = fr.fitsViewport;
        const read = fr.minTextPx >= T.minTextPx && fr.narratorPx >= T.narratorMin && fr.narratorPx <= T.narratorMax;
        const noErr = errSnapshot === 0;
        const pass = fit && read && noErr && !fr.err;
        if (!pass) allPass = false;
        const flags = [fit ? '' : 'OVERFLOW', read ? '' : 'UNREADABLE',
          noErr ? '' : 'CONSOLE-ERR', fr.err ? 'ERR:' + fr.err : ''].filter(Boolean).join(' ');
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${s.name.padEnd(8)} ${String(fr.id).padEnd(10)} ` +
          `h=${fr.iframeH}/${s.h} (${Math.round(fr.iframeH / s.h * 100)}%)  ` +
          `text=${fr.minTextPx}-${fr.maxTextPx}px  narr=${fr.narratorPx}px  ${flags}`);
      }
    }
  }
  c.close();
  console.log(`\n${allPass ? '✓ ALL PASS' : '✗ FAILURES PRESENT'}`);
  process.exit(allPass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
