// Cubinexo multiplayer server.
//   npm install && npm start            (listens on PORT, default 8080)
// Players, chat, blocks, the evolving biosphere and Cubits are all kept here and saved to data/world.json.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const N = require('./noise');
const Bio = require('./biosphere');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'world.json');
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '64', 10);
const MOTD = process.env.MOTD || 'Connected to the shared Cubinexo universe. Press Enter to chat.';
const EPOCH = Date.UTC(2026, 0, 1) / 1000;

// ---------- Planets (same file the game uses) ----------
function loadPlanets() {
  const candidates = [
    process.env.PLANETS,
    path.join(__dirname, '..', 'Assets', 'Cubinexo', 'Resources', 'Cubinexo', 'planets.json'),
    path.join(__dirname, 'planets.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) { console.log('Planets from', c); return JSON.parse(fs.readFileSync(c, 'utf8')).planets; }
  }
  throw new Error('planets.json not found');
}
const planets = loadPlanets();

// ---------- Prices (mirror of Wallet.cs Shop) ----------
const PRICES = { jet2: 150, jet3: 400, pill: 20, tree: 10, bloom: 5, home: 0 };
const BLOCK_COST = [1, 2, 3];
const START_CUBITS = 100;
const DISCOVERY_BONUS = 50;

// ---------- World state ----------
let world = { tick: 0, nextFloraId: 1, nextBlockId: 1, flora: [], blocks: [], accounts: {}, firstDiscoverer: {} };
try {
  if (fs.existsSync(SAVE_FILE)) {
    world = Object.assign(world, JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')));
    console.log(`Loaded world: tick ${world.tick}, ${world.flora.length} flora, ${world.blocks.length} blocks, ${Object.keys(world.accounts).length} accounts`);
  }
} catch (e) { console.error('Could not load save, starting fresh:', e.message); }
if (world.flora.length === 0) { Bio.seedWorld(world, planets); console.log(`Seeded ${world.flora.length} flora`); }

let dirty = false;
function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(world));
    fs.renameSync(tmp, SAVE_FILE);
    dirty = false;
  } catch (e) { console.error('Save failed:', e.message); }
}
setInterval(save, 30000);

// ---------- Helpers ----------
const now = () => Date.now() / 1000 - EPOCH;
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 20);
const cleanColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#f28c33');
const cleanText = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
const publicBlock = (b) => ({ id: b.id, pl: b.pl, p: b.p, r: b.r, c: b.c, k: b.k, o: b.o });

const clients = new Map(); // id -> client
let nextClientId = 1;

function send(c, msg) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); }
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const c of clients.values()) if (c !== except && c.ready && c.ws.readyState === 1) c.ws.send(s);
}
function sysChat(text) { broadcast({ t: 'chat', from: '', text, sys: true }); }
function walletUpdate(c, reason, grant) { send(c, { t: 'wallet', cubits: c.acct.cubits, reason: reason || '', grant: grant || '' }); }
function err(c, msg) { send(c, { t: 'error', msg }); }

function uniqueName(name) {
  const taken = new Set([...clients.values()].filter((c) => c.ready).map((c) => c.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) if (!taken.has((name + i).toLowerCase())) return name + i;
  return name + Math.floor(Math.random() * 1000);
}

function rateOk(c, key, perSecond, burst) {
  const t = Date.now();
  const b = c.buckets[key] || (c.buckets[key] = { tokens: burst, last: t });
  b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * perSecond);
  b.last = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function floraWorldPos(f) {
  const p = planets[f.pl];
  const r = N.surfaceRadius(p, f.d);
  return [p.pos[0] + f.d[0] * r, p.pos[1] + f.d[1] * r, p.pos[2] + f.d[2] * r];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------- Message handlers ----------
function onHello(c, m) {
  let acct = typeof m.token === 'string' && world.accounts[m.token];
  let token = m.token;
  if (!acct) {
    token = crypto.randomBytes(16).toString('hex');
    acct = world.accounts[token] = { cubits: START_CUBITS, discovered: [], owned: [], created: Date.now() };
  }
  acct.lastSeen = Date.now();
  c.token = token;
  c.acct = acct;
  c.name = uniqueName(cleanName(m.name) || 'Explorer');
  c.color = cleanColor(m.color);
  acct.name = c.name;
  c.ready = true;
  dirty = true;
  send(c, {
    t: 'welcome', id: c.id, token, name: c.name, time: now(), tick: world.tick,
    cubits: acct.cubits, owned: acct.owned,
    blocks: world.blocks.map(publicBlock), flora: world.flora,
    players: [...clients.values()].filter((o) => o.ready && o.p).map(stateOf), motd: MOTD,
  });
  broadcast({ t: 'join', id: c.id, name: c.name, color: c.color }, c);
  console.log(`+ ${c.name} (${clients.size} connected)`);
}

const stateOf = (c) => ({ id: c.id, name: c.name, color: c.color, p: c.p || [0, 0, 0], r: c.r || [0, 0, 0, 1], pl: c.pl ?? -1, m: c.m || 0 });

function onState(c, m) {
  if (!rateOk(c, 'state', 30, 30)) return;
  if (!finite(m.p, 3) || !finite(m.r, 4)) return;
  if (Math.hypot(...m.p) > 25000) return;
  c.p = m.p; c.r = m.r;
  c.pl = Number.isInteger(m.pl) && m.pl >= -1 && m.pl < planets.length ? m.pl : -1;
  c.m = m.m === 1 ? 1 : 0;
}

function onChat(c, m) {
  if (!rateOk(c, 'chat', 1.5, 4)) return err(c, 'Slow down a little.');
  const text = cleanText(m.text);
  if (!text) return;
  broadcast({ t: 'chat', from: c.name, text, color: c.color });
}

function onPlace(c, m) {
  if (!rateOk(c, 'place', 8, 12)) return;
  const b = m.b || {};
  const k = Number.isInteger(b.k) && b.k >= 0 && b.k <= 2 ? b.k : 0;
  if (!Number.isInteger(b.pl) || !planets[b.pl] || !finite(b.p, 3) || !finite(b.r, 4)) return err(c, 'Invalid block.');
  const pl = planets[b.pl];
  if (Math.hypot(...b.p) > pl.radius * 1.6 + 200) return err(c, 'Too far from the planet to build.');
  if (c.p && dist(c.p, [pl.pos[0] + b.p[0], pl.pos[1] + b.p[1], pl.pos[2] + b.p[2]]) > 25) return err(c, 'Too far away to build there.');
  if (world.blocks.length >= 60000) return err(c, 'The universe is full of blocks!');
  const cost = BLOCK_COST[k];
  if (c.acct.cubits < cost) return err(c, `Not enough Cubits (need ${cost}). Collect crystals to earn more.`);
  c.acct.cubits -= cost;
  const block = { id: world.nextBlockId++, pl: b.pl, p: b.p, r: b.r, c: cleanColor(b.c), k, o: c.name, ot: c.token };
  world.blocks.push(block);
  dirty = true;
  broadcast({ t: 'place', b: publicBlock(block) });
  walletUpdate(c, '');
}

function onRemove(c, m) {
  if (!rateOk(c, 'place', 8, 12)) return;
  const i = world.blocks.findIndex((b) => b.id === m.id);
  if (i < 0) return;
  const b = world.blocks[i];
  if (b.ot !== c.token) return err(c, `That block belongs to ${b.o}.`);
  world.blocks.splice(i, 1);
  c.acct.cubits += BLOCK_COST[b.k] || 1;
  dirty = true;
  broadcast({ t: 'remove', id: b.id });
  walletUpdate(c, '');
}

function onHarvest(c, m) {
  const i = world.flora.findIndex((f) => f.id === m.id && f.k === 3);
  if (i < 0) return;
  const f = world.flora[i];
  if (!c.p || dist(c.p, floraWorldPos(f)) > 8) return; // must actually be standing at it
  world.flora.splice(i, 1);
  const value = Bio.crystalValue(f);
  c.acct.cubits += value;
  dirty = true;
  broadcast({ t: 'tick', n: world.tick, add: [], rem: [f.id] });
  walletUpdate(c, 'crystal');
}

function onDiscover(c, m) {
  const idx = m.pl;
  if (!Number.isInteger(idx) || !planets[idx] || !c.p) return;
  const p = planets[idx];
  if (dist(c.p, p.pos) > p.radius * 1.4 + 30) return;
  if (c.acct.discovered.includes(idx)) return;
  c.acct.discovered.push(idx);
  c.acct.cubits += DISCOVERY_BONUS;
  dirty = true;
  walletUpdate(c, 'discovered ' + p.name);
  if (world.firstDiscoverer[idx] === undefined && !p.home) {
    world.firstDiscoverer[idx] = c.name;
    sysChat(`${c.name} is the first explorer ever to land on ${p.name}!`);
  }
}

function onBuy(c, m) {
  const item = String(m.item || '');
  const price = PRICES[item];
  if (price === undefined || item === 'home' || item === 'tree' || item === 'bloom') return;
  if ((item === 'jet2' || item === 'jet3') && c.acct.owned.includes(item)) return err(c, 'You already own that.');
  if (item === 'jet3' && !c.acct.owned.includes('jet2')) return err(c, 'Buy the Mk II booster first.');
  if (c.acct.cubits < price) return err(c, `Not enough Cubits (need ${price}).`);
  c.acct.cubits -= price;
  if (item.startsWith('jet')) c.acct.owned.push(item);
  dirty = true;
  walletUpdate(c, '', item);
}

function onPlant(c, m) {
  if (!rateOk(c, 'plant', 1, 3)) return;
  const k = m.k === 0 || m.k === 2 ? m.k : -1;
  if (k < 0 || !Number.isInteger(m.pl) || !planets[m.pl] || !finite(m.d, 3)) return;
  const p = planets[m.pl];
  const d = N.normalize(m.d);
  const price = k === 0 ? PRICES.tree : PRICES.bloom;
  if (c.acct.cubits < price) return err(c, `Not enough Cubits (need ${price}).`);
  if (!Bio.suitable(p, d, k)) return err(c, "That can't grow here.");
  const f = Bio.randomFlora(world, p, m.pl, k, false, d);
  if (!f) return err(c, "That can't grow here.");
  c.acct.cubits -= price;
  world.flora.push(f);
  dirty = true;
  broadcast({ t: 'tick', n: world.tick, add: [f], rem: [] });
  walletUpdate(c, '');
}


// pending trade offers: key = offererSocketId, value = {to, cubits, expires}
const tradeOffers = new Map();

function onTradeOffer(c, m) {
  if (!rateOk(c, 'trade', 2, 3)) return;
  const toId = Number(m.to);
  const target = [...clients.values()].find(x => x.id === toId && x.ready);
  if (!target) return err(c, 'That player is not online.');
  if (target.id === c.id) return err(c, 'You cannot trade with yourself.');
  const cubits = Math.floor(Number(m.cubits) || 0);
  if (cubits < 0 || cubits > (c.acct.cubits || 0)) return err(c, 'You do not have that many Cubits.');
  // store offer
  tradeOffers.set(c.ws, { to: toId, cubits, expires: Date.now() + 30000 });
  send(target, { t: 'trade_offer', from: c.id, name: c.name, color: c.color, cubits });
  send(c, { t: 'chat', from: '', text: 'Trade offer sent! Waiting for ' + target.name + '…', sys: true });
}

function onTradeAccept(c, m) {
  const fromId = Number(m.from);
  const offerer = [...clients.values()].find(x => x.id === fromId && x.ready);
  if (!offerer) return err(c, 'Trader is no longer online.');
  const offer = tradeOffers.get(offerer.ws);
  if (!offer || offer.to !== c.id || Date.now() > offer.expires) return err(c, 'Trade offer expired.');
  tradeOffers.delete(offerer.ws);
  const cubits = offer.cubits;
  if ((offerer.acct.cubits || 0) < cubits) return err(c, 'Trader no longer has enough Cubits.');
  offerer.acct.cubits = (offerer.acct.cubits || 0) - cubits;
  c.acct.cubits = (c.acct.cubits || 0) + cubits;
  walletUpdate(offerer, 'Trade sent');
  walletUpdate(c, 'Trade received');
  const msg = c.name + ' accepted ' + offerer.name + "'s trade (+" + cubits + ' Cubits)!';
  broadcast({ t: 'chat', from: '', text: msg, sys: true });
  dirty = true;
}

function onTradeDecline(c, m) {
  const fromId = Number(m.from);
  const offerer = [...clients.values()].find(x => x.id === fromId && x.ready);
  if (offerer) {
    tradeOffers.delete(offerer.ws);
    send(offerer, { t: 'chat', from: '', text: c.name + ' declined your trade.', sys: true });
  }
}

const handlers = { state: onState, chat: onChat, trade_offer: onTradeOffer, trade_accept: onTradeAccept, trade_decline: onTradeDecline, place: onPlace, remove: onRemove, harvest: onHarvest, discover: onDiscover, buy: onBuy, plant: onPlant };

// ---------- Network ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, game: 'cubinexo', players: [...clients.values()].filter((c) => c.ready).length, tick: world.tick, flora: world.flora.length, blocks: world.blocks.length }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  if (clients.size >= MAX_PLAYERS) { ws.close(1013, 'Server full'); return; }
  const c = { id: nextClientId++, ws, ready: false, buckets: {}, alive: true };
  clients.set(c.id, c);
  const helloTimer = setTimeout(() => { if (!c.ready) ws.close(1008, 'No hello'); }, 10000);

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!c.ready) { if (m.t === 'hello') { clearTimeout(helloTimer); onHello(c, m); } return; }
    const h = handlers[m.t];
    if (h) { try { h(c, m); } catch (e) { console.error('handler', m.t, e); } }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    clients.delete(c.id);
    if (c.ready) { broadcast({ t: 'leave', id: c.id, name: c.name }); console.log(`- ${c.name} (${clients.size} connected)`); }
  });
  ws.on('error', () => {});
});

// Player positions 10x a second
setInterval(() => {
  const list = [...clients.values()].filter((c) => c.ready && c.p).map(stateOf);
  if (list.length) broadcast({ t: 'states', list, time: now() });
}, 100);

// Evolution keeps running whether anyone is online or not
setInterval(() => {
  const { add, rem } = Bio.tick(world, planets);
  dirty = true;
  broadcast({ t: 'tick', n: world.tick, add, rem });
}, Bio.TICK_SECONDS * 1000);

// A small trickle of income for being online (+5 every 5 minutes)
setInterval(() => {
  for (const c of clients.values()) if (c.ready) { c.acct.cubits += 5; walletUpdate(c, 'online time'); }
  dirty = true;
}, 5 * 60 * 1000);

// Drop dead connections
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 20000);

function shutdown() { console.log('Saving and shutting down…'); dirty = true; save(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Cubinexo server on :${PORT}  (ws://localhost:${PORT})`));
