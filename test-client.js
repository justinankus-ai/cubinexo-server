// End-to-end check of the server: run with `npm test` (starts its own server on a spare port).
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const N = require('./noise');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cubinexo-test-'));
const planets = JSON.parse(fs.readFileSync(path.join(__dirname, 'planets.json'), 'utf8')).planets;
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, name, msgs: [], waiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 4000) => new Promise((res, rej) => {
      const found = c.msgs.find(pred);
      if (found) { c.msgs.splice(c.msgs.indexOf(found), 1); return res(found); }
      const w = { pred, resolve: (m) => { clearTimeout(t); c.msgs.splice(c.msgs.indexOf(m), 1); res(m); } };
      const t = setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); rej(new Error('timeout waiting in ' + name)); }, ms);
      c.waiters.push(w);
    });
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA } });
  srv.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
  srv.stderr.on('data', (d) => process.stdout.write('  [server!] ' + d));
  await new Promise((r) => setTimeout(r, 700));
  try {
    const home = planets[0];
    const fd = N.normalize(home.flatten);
    const spawnR = N.surfaceRadius(home, fd);
    const spot = [fd[0] * (spawnR + 1), fd[1] * (spawnR + 1), fd[2] * (spawnR + 1)];

    const a = await client('A');
    a.send({ t: 'hello', name: 'Justin<script>', color: '#ff8800', token: '' });
    const wa = await a.wait((m) => m.t === 'welcome');
    ok(wa.id > 0 && wa.token && wa.token.length === 32, 'A welcomed with id and token');
    ok(wa.name === 'Justinscript', 'name sanitized: ' + wa.name);
    ok(wa.cubits === 100, 'starting Cubits = 100');
    ok(Array.isArray(wa.flora) && wa.flora.length > 200, `biosphere seeded (${wa.flora.length} flora)`);
    const sizeKb = Math.round(JSON.stringify(wa).length / 1024);
    ok(sizeKb < 600, `welcome size ${sizeKb} KB`);

    // All seeded flora must be on valid ground according to the shared terrain function
    const bad = wa.flora.filter((f) => { const p = planets[f.pl]; return N.hasSea(p) && N.rawHeight(p, f.d) < p.sea; });
    ok(bad.length === 0, 'no flora seeded under the sea');
    const inPlaza = wa.flora.filter((f) => N.inBuildZone(planets[f.pl], f.d, 0));
    ok(inPlaza.length === 0, 'no flora inside the plaza build zone');

    const b = await client('B');
    b.send({ t: 'hello', name: 'Justin', color: 'bad', token: '' });
    const wb = await b.wait((m) => m.t === 'welcome');
    ok(wb.name === 'Justin', 'second player name ok: ' + wb.name);
    await a.wait((m) => m.t === 'join' && m.id === wb.id);
    ok(true, 'A saw B join');

    // Positions
    a.send({ t: 'state', p: spot, r: [0, 0, 0, 1], pl: 0, m: 0 });
    b.send({ t: 'state', p: spot, r: [0, 0, 0, 1], pl: 0, m: 1 });
    const st = await b.wait((m) => m.t === 'states' && m.list.some((p) => p.id === wa.id));
    ok(st.list.length === 2, 'state broadcast contains both players');

    // Chat
    a.send({ t: 'chat', text: '  hello universe \u0007' });
    const ch = await b.wait((m) => m.t === 'chat' && !m.sys);
    ok(ch.from === wa.name && ch.text === 'hello universe', 'chat delivered and cleaned');

    // Blocks
    a.send({ t: 'place', b: { pl: 0, p: spot, r: [0, 0, 0, 1], c: '#336699', k: 0 } });
    const pl = await b.wait((m) => m.t === 'place');
    ok(pl.b.id > 0 && pl.b.o === wa.name && pl.b.ot === undefined, 'block placed, owner token hidden');
    const wal = await a.wait((m) => m.t === 'wallet');
    ok(wal.cubits === 99, 'block cost 1 Cubit');
    b.send({ t: 'remove', id: pl.b.id });
    const e1 = await b.wait((m) => m.t === 'error');
    ok(/belongs/.test(e1.msg), 'cannot remove another player\'s block');
    a.send({ t: 'remove', id: pl.b.id });
    await b.wait((m) => m.t === 'remove' && m.id === pl.b.id);
    ok((await a.wait((m) => m.t === 'wallet')).cubits === 100, 'removing your own block refunds');

    a.send({ t: 'place', b: { pl: 0, p: [9999, 0, 0], r: [0, 0, 0, 1], c: '#336699', k: 0 } });
    ok(/far/i.test((await a.wait((m) => m.t === 'error')).msg), 'rejects blocks far from the planet');

    // Discovery
    a.send({ t: 'discover', pl: 0 });
    const disc = await a.wait((m) => m.t === 'wallet');
    ok(disc.cubits === 150 && /discovered/.test(disc.reason), 'discovery bonus +50');
    a.send({ t: 'discover', pl: 2 });
    a.send({ t: 'discover', pl: 0 });
    await new Promise((r) => setTimeout(r, 300));
    ok(!a.msgs.some((m) => m.t === 'wallet'), 'no bonus for far planet or repeat discovery');

    // Shop
    a.send({ t: 'buy', item: 'jet3' });
    ok(/Mk II/.test((await a.wait((m) => m.t === 'error')).msg), 'jet3 requires jet2');
    a.send({ t: 'buy', item: 'jet2' });
    const bj = await a.wait((m) => m.t === 'wallet');
    ok(bj.cubits === 0 && bj.grant === 'jet2', 'bought jet2 for 150');
    a.send({ t: 'buy', item: 'pill' });
    ok(/Not enough/.test((await a.wait((m) => m.t === 'error')).msg), 'cannot buy without Cubits');

    // Harvest a crystal: teleport B next to one, then collect it
    const crystal = wa.flora.find((f) => f.k === 3 && f.pl === 0);
    if (crystal) {
      const p = planets[0];
      const r = N.surfaceRadius(p, crystal.d);
      b.send({ t: 'harvest', id: crystal.id });
      await new Promise((res) => setTimeout(res, 250));
      ok(!b.msgs.some((m) => m.t === 'wallet'), 'cannot harvest from far away');
      b.send({ t: 'state', p: [crystal.d[0] * (r + 1), crystal.d[1] * (r + 1), crystal.d[2] * (r + 1)], r: [0, 0, 0, 1], pl: 0, m: 0 });
      await new Promise((res) => setTimeout(res, 100));
      b.send({ t: 'harvest', id: crystal.id });
      const hv = await b.wait((m) => m.t === 'wallet' && m.reason === 'crystal');
      ok(hv.cubits > 100, `crystal harvested (+${hv.cubits - 100})`);
      const gone = await a.wait((m) => m.t === 'tick' && m.rem.includes(crystal.id));
      ok(!!gone, 'everyone saw the crystal disappear');
    } else ok(false, 'found a crystal to test');

    // Planting
    const plantDir = wa.flora.find((f) => f.k === 0 && f.pl === 0)?.d;
    if (plantDir) {
      b.send({ t: 'plant', pl: 0, d: plantDir, k: 0 });
      const t = await a.wait((m) => m.t === 'tick' && m.add.length === 1 && m.add[0].k === 0 && m.rem.length === 0);
      ok(t.add[0].g === 0, 'planted tree broadcast to everyone');
    }

    // Evolution ticks arrive on their own
    const tk = await a.wait((m) => m.t === 'tick' && m.n > wa.tick, 5000);
    ok(tk.n === wa.tick + 1 || tk.n > wa.tick, `evolution tick ${tk.n} (+${tk.add.length} / -${tk.rem.length})`);

    // Reconnect with token keeps the account
    a.ws.close();
    await b.wait((m) => m.t === 'leave');
    const a2 = await client('A2');
    a2.send({ t: 'hello', name: 'Justin', color: '#ff8800', token: wa.token });
    const w2 = await a2.wait((m) => m.t === 'welcome');
    ok(w2.cubits === 0 && w2.owned.includes('jet2') && w2.token === wa.token, 'account restored from token');
    ok(w2.name === 'Justin2', 'duplicate live name gets a number: ' + w2.name);
    a2.ws.close(); b.ws.close();
  } catch (e) {
    ok(false, e.message);
  }
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  ok(fs.existsSync(path.join(DATA, 'world.json')), 'world saved on shutdown');
  console.log(failures ? `\n${failures} FAILED` : '\nAll server checks passed');
  process.exit(failures ? 1 : 0);
})();
