
/* eslint-disable no-console */
// Cleaned server.js (minimal working skeleton with requested fixes & structure preserved conceptually)
// -------------------------------------------------------------
// This file consolidates duplicate blocks, fixes known bugs,
// and adds purchase-mode enum support + post-turn purchase hook.
//
// IMPORTANT: Replace the network-specific logic in WPlacer with your real requests.
// -------------------------------------------------------------
import { createRequire } from 'module';
const require = createRequire(import.meta.url); // 让 ESM 里可用 require()

import { fileURLToPath } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// ----------------------------
// Utilities
// ----------------------------
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const loadJSON = (file, fallback = {}) => {
  try {
    const p = path.join(dataDir, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[loadJSON] failed:', file, e);
    return fallback;
  }
};
const saveJSON = (file, obj) => {
  const p = path.join(dataDir, file);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}m ${ss}s`;
};

// Basic logging
function log(id, name, msg) {
  const tag = typeof id === 'number' || /^\d+$/.test(String(id)) ? `#${id}` : id;
  console.log(`[${new Date().toISOString().slice(0,19).replace('T',' ')}] (${name}${tag?''+tag:''}) ${msg}`);
}
function logUserError(err, id, name, ctx) {
  console.error(`[ERROR] (${name}#${id}) ${ctx}:`, err && err.stack || err);
}

// ----------------------------
// SSE (very lightweight bus)
// ----------------------------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}
function broadcastUserUpdate(u) { broadcast('user_update', u); }

// ----------------------------
// In-memory state + persistence
// ----------------------------
let users = loadJSON('users.json', {});       // { [id]: {name, cookies, ...} }
let templates = {};                            // { [id]: TemplateManager }
let templatesStore = loadJSON('templates.json', {});

let currentSettings = {
  drawingDirection: 'ltr',
  drawingOrder: 'row',
  pixelSkip: 1,
  outlineMode: false,
  skipPaintedPixels: true,

  // proxy
  proxyEnabled: false,
  proxyRotationMode: 'sequential',
  logProxyUsage: false,
  proxyCount: 0,

  // cooldowns (ms)
  accountCooldown: 20000,
  purchaseCooldown: 2000,
  accountCheckCooldown: 3000,

  // thresholds
  chargeThreshold: 0.3,  // 0..1
  dropletReserve: 0,     // droplets to keep
  antiGriefStandby: 60000,

  // optional caps
  maxPacksPerTurn: 3
};

// merge persisted settings if any
currentSettings = { ...currentSettings, ...loadJSON('settings.json', {}) };

// ----------------------------
// Token Manager (skeleton)
// ----------------------------
class TokenManager {
  constructor() {
    this.waiters = [];
  }
  async ensureValid(user) {
    // Replace with your actual token logic
    // Simulate token fetched
    broadcast('hello', {});
    return true;
  }
}
const tokenManager = new TokenManager();

// ----------------------------
// WPlacer (skeleton) - replace with actual site API
// ----------------------------
class WPlacer {
  constructor(template, coords, settings, templateName) {
    this.template = template;
    this.coords = coords;
    this.settings = settings;
    this.templateName = templateName;
  }
  async login(cookies) {
    // Replace with real login that yields user info from server
    // Fake user info for now
    return {
      id: Math.floor(Math.random()*1000000),
      name: 'User',
      charges: { count: 200, max: 333 },
      droplets: 5000,
      level: 10 + Math.random(),
      jwtExp: Date.now() + 7*86400000
    };
  }
  async getStatus(userId) {
    // Replace with real query
    return {
      charges: { count: 200, max: 333 },
      droplets: 5000
    };
  }
  async buyProduct(productId, amount = 1) {
    // Replace with real purchase request. productId 80=30px/500 droplet
    await sleep(200);
    return { ok: true, status: 200, body: { productId, amount } };
  }
  async paint(user, template, cfg) {
    // Replace with real painting logic. Return pixels painted.
    await sleep(300);
    return Math.min(200, Math.floor(100 + Math.random()*200));
  }
}

// ----------------------------
// Template Manager
// ----------------------------
const activeBrowserUsers = new Set();

let nextTemplateId = 1;

class TemplateManager {
  constructor(opts) {
    this.id = String(opts.id || nextTemplateId++);
    this.name = opts.name;
    this.template = opts.template;     // matrix etc.
    this.coords = opts.coords || [0,0,0,0];
    this.userIds = opts.userIds || [];
    this.canBuyCharges = !!opts.canBuyCharges;
    this.canBuyMaxCharges = !!opts.canBuyMaxCharges;
    this.purchaseMode = opts.purchaseMode || null; // enum
    this.antiGriefMode = !!opts.antiGriefMode;
    this.enableAutostart = !!opts.enableAutostart;
    this.running = !!opts.running;
    this.status = 'Idle.';

    this.totalPixels = (opts.template && opts.template.ink) || 0;
    this.pixelsRemaining = this.totalPixels;
    this.currentPixelSkip = currentSettings.pixelSkip;

    this.masterId = this.userIds.length ? this.userIds[0] : null;
    this.masterName = this.masterId && users[this.masterId] ? users[this.masterId].name : 'master';

    // Normalize purchase mode (enum) with backward compatibility
    if (typeof this.purchaseMode !== 'string') {
      this.purchaseMode = this.canBuyMaxCharges ? 'max' : (this.canBuyCharges ? 'normal' : 'none');
    }
    // Keep legacy booleans in sync for old code paths
    this.canBuyCharges    = (this.purchaseMode === 'normal' || this.purchaseMode === 'max');
    this.canBuyMaxCharges = (this.purchaseMode === 'max');
    log('SYSTEM','wplacer',`[${this.name}] PurchaseMode=${this.purchaseMode} canBuyCharges=${this.canBuyCharges} canBuyMaxCharges=${this.canBuyMaxCharges}`);
  }

  toJSON() {
    return {
      name: this.name,
      template: this.template,
      coords: this.coords,
      userIds: this.userIds,
      canBuyCharges: this.canBuyCharges,
      canBuyMaxCharges: this.canBuyMaxCharges,
      purchaseMode: this.purchaseMode,
      antiGriefMode: this.antiGriefMode,
      enableAutostart: this.enableAutostart,
      totalPixels: this.totalPixels,
      pixelsRemaining: this.pixelsRemaining,
      running: this.running,
      status: this.status
    };
  }

  async sleep(ms) { return sleep(ms); }

  async handleUpgrades(wplacer) {
    // Placeholder for max-charges upgrades (SKU e.g., 70). Implement as needed.
    return;
  }

  async _performPaintTurn(wplacer) {
    // Here you'd compute mismatched pixels and paint.
    const painted = await wplacer.paint(null, this.template, currentSettings);
    this.pixelsRemaining = Math.max(0, this.pixelsRemaining - painted);
    log('SYSTEM','wplacer',`[${this.name}] 🎨 Painted ${painted} pixels.`);
    return painted;
  }

  async _maybeBuyChargesAfterTurn(preferredBuyerId) {
    if (this.purchaseMode === 'none') return false;
    if (this.pixelsRemaining <= 0)   return false;

    const candidates = [preferredBuyerId, this.masterId].filter(Boolean);
    let buyerId = null, buyer = null, buyerInfo = null;

    for (const uid of candidates) {
      if (!uid || activeBrowserUsers.has(uid)) continue;
      activeBrowserUsers.add(uid);
      const w = new WPlacer(this.template, this.coords, currentSettings, this.name);
      try {
        buyerInfo = await w.login(users[uid]?.cookies || {});
        buyerId = uid; buyer = w; break;
      } catch {
        activeBrowserUsers.delete(uid);
      }
    }
    if (!buyer) { log('SYSTEM','wplacer',`[${this.name}] 🔸 Skip buy: no free buyer (current/master busy).`); return false; }
    if (buyerInfo) broadcastUserUpdate({ userId: buyerId, ...buyerInfo });

    const affordable = Math.max(0, (buyerInfo.droplets || 0) - currentSettings.dropletReserve);
    if (affordable < 500) { 
      log(buyerId, users[buyerId]?.name || '', `[${this.name}] 🔸 Skip buy: droplets ${buyerInfo.droplets} < reserve+500.`);
      activeBrowserUsers.delete(buyerId); 
      return false; 
    }

    // Map mode to SKU (both point to 80 by default; adjust per your real SKUs)
    const sku = (this.purchaseMode === 'max') ? 80 : 80;
    const unitPixels = 30;
    const unitCost   = 500;

    const packsByNeed  = Math.ceil(this.pixelsRemaining / unitPixels);
    const packsByMoney = Math.floor(affordable / unitCost);
    const amountToBuy  = Math.min(packsByNeed, packsByMoney, currentSettings.maxPacksPerTurn || 3);
    if (amountToBuy <= 0) { 
      log(buyerId, users[buyerId]?.name || '', `[${this.name}] 🔸 Skip buy: amountToBuy=0.`);
      activeBrowserUsers.delete(buyerId); 
      return false; 
    }

    try {
      log(buyerId, users[buyerId]?.name || '', `[${this.name}] 💰 Attempting to buy pixel charges. packs=${amountToBuy}`);
      await buyer.buyProduct(sku, amountToBuy);
      await this.sleep(currentSettings.purchaseCooldown);
      return true;
    } catch (e) {
      logUserError(e, buyerId, users[buyerId]?.name || '', "attempt to buy pixel charges");
      return false;
    } finally {
      activeBrowserUsers.delete(buyerId);
    }
  }

  async runUser(userToRun){
    if (!userToRun) return;
    if (activeBrowserUsers.has(userToRun.userId)) return;
    activeBrowserUsers.add(userToRun.userId);

    const wplacer = new WPlacer(this.template, this.coords, currentSettings, this.name);
    let paintedInTurn = false;
    try {
      const userInfo = await wplacer.login(users[userToRun.userId]?.cookies || {});
      this.status = `Running user ${userInfo.name}#${userInfo.id} | Pass (1/${this.currentPixelSkip})`;
      log(userInfo.id, userInfo.name, `[${this.name}] 🔋 User has ${Math.floor(userInfo.charges.count)} charges. Starting turn...`);

      await tokenManager.ensureValid(userToRun);
      const painted = await this._performPaintTurn(wplacer);
      paintedInTurn = painted > 0;

      await this.handleUpgrades(wplacer);
    } catch (error) {
      if (error.name !== 'SuspensionError') {
        logUserError(error, userToRun.userId, users[userToRun.userId]?.name || '', "perform paint turn");
      }
      if (error.name === 'NetworkError') {
        log('SYSTEM', 'wplacer', `[${this.name}] Network issue during paint turn.`);
        await this.sleep(1000);
      }
    } finally {
      activeBrowserUsers.delete(userToRun.userId);
    }

    // Post-turn purchase hook
    if (paintedInTurn && this.running) {
      await this._maybeBuyChargesAfterTurn(userToRun.userId);
    }

    if (paintedInTurn && this.running && this.userIds.length > 1) {
      log('SYSTEM', 'wplacer', `[${this.name}] ⏱️ Waiting for account turn cooldown (${duration(currentSettings.accountCooldown)}).`);
      await this.sleep(currentSettings.accountCooldown);
    }
  }
}

// ----------------------------
// Templates load into managers
// ----------------------------
const loadTemplatesIntoManagers = () => {
  templates = {};
  for (const id of Object.keys(templatesStore)) {
    const t = templatesStore[id];
    templates[id] = new TemplateManager({ id, ...t });
  }
};
loadTemplatesIntoManagers();

const saveTemplates = () => {
  const obj = {};
  for (const id of Object.keys(templates)) {
    const t = templates[id];
    obj[id] = {
      name: t.name, template: t.template, coords: t.coords,
      userIds: t.userIds,
      canBuyCharges: t.canBuyCharges,
      canBuyMaxCharges: t.canBuyMaxCharges,
      purchaseMode: t.purchaseMode,
      antiGriefMode: t.antiGriefMode,
      enableAutostart: t.enableAutostart,
      totalPixels: t.totalPixels,
      pixelsRemaining: t.pixelsRemaining,
      running: t.running,
      status: t.status
    };
  }
  templatesStore = obj;
  saveJSON('templates.json', templatesStore);
};

// ----------------------------
// Express server
// ----------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// SSE events
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Users
app.get('/users', (req, res) => res.json(users));

app.post('/user', (req, res) => {
  const { cookies } = req.body || {};
  const id = String(Date.now());
  users[id] = { id, name: `User${id.slice(-4)}`, cookies };
  saveJSON('users.json', users);
  res.json(users[id]);
  broadcastUserUpdate({ userId: id, name: users[id].name, charges: { count: 0, max: 0 }, droplets: 0, jwtExp: Date.now()+86400000 });
});

app.delete('/user/:id', (req, res) => {
  const { id } = req.params;
  if (!users[id]) return res.sendStatus(404);
  delete users[id];
  saveJSON('users.json', users);
  // remove from templates
  for (const tid of Object.keys(templates)) {
    templates[tid].userIds = templates[tid].userIds.filter(u => String(u) !== String(id));
  }
  saveTemplates();
  res.json({ ok: true });
});

app.post('/users/status', async (req, res) => {
  // Fake: return current known users with ok:true
  const out = {};
  for (const id of Object.keys(users)) {
    out[id] = {
      success: true,
      data: {
        id,
        name: users[id].name,
        charges: { count: Math.floor(Math.random()*333), max: 333 },
        droplets: 5000,
        level: 10 + Math.random(),
        jwtExp: Date.now() + 7*86400000,
        favoriteLocations: [],
        maxFavoriteLocations: 10,
        equippedFlag: false,
        discord: '',
        country: 'N/A',
        pixelsPainted: Math.floor(Math.random()*10000),
        extraColorsBitmap: 0,
        allianceId: null,
        allianceRole: null
      }
    };
  }
  res.json(out);
});

// Templates
app.get('/templates', (req, res) => {
  const out = {};
  for (const id of Object.keys(templates)) {
    out[id] = templates[id].toJSON();
  }
  res.json(out);
});

app.post('/template', (req, res) => {
  let { templateName, template, coords, userIds, canBuyCharges, canBuyMaxCharges, antiGriefMode, enableAutostart, purchaseMode } = req.body;
  const mode = purchaseMode || (canBuyMaxCharges ? 'max' : (canBuyCharges ? 'normal' : 'none'));
  canBuyCharges    = (mode === 'normal' || mode === 'max');
  canBuyMaxCharges = (mode === 'max');

  const id = String(nextTemplateId++);
  const mgr = new TemplateManager({
    id, name: templateName, template, coords, userIds,
    canBuyCharges, canBuyMaxCharges, antiGriefMode, enableAutostart,
    purchaseMode: mode, running: false
  });
  templates[id] = mgr;
  saveTemplates();
  res.json({ id, ok: true });
});

app.put('/template/edit/:id', (req, res) => {
  const { id } = req.params;
  const t = templates[id];
  if (!t) return res.sendStatus(404);

  let { templateName, coords, userIds, canBuyCharges, canBuyMaxCharges, antiGriefMode, enableAutostart, template, purchaseMode } = req.body;
  const mode = purchaseMode || (canBuyMaxCharges ? 'max' : (canBuyCharges ? 'normal' : 'none'));
  canBuyCharges    = (mode === 'normal' || mode === 'max');
  canBuyMaxCharges = (mode === 'max');

  if (templateName) t.name = templateName;
  if (coords) t.coords = coords.map(Number);
  if (Array.isArray(userIds)) t.userIds = userIds.map(String);
  if (typeof antiGriefMode === 'boolean') t.antiGriefMode = antiGriefMode;
  if (typeof enableAutostart === 'boolean') t.enableAutostart = enableAutostart;
  if (template) { t.template = template; t.totalPixels = template.ink || 0; }
  t.purchaseMode = mode;
  t.canBuyCharges = canBuyCharges;
  t.canBuyMaxCharges = canBuyMaxCharges;

  saveTemplates();
  res.json({ ok: true });
});

app.put('/template/:id', (req, res) => {
  const { id } = req.params;
  const t = templates[id];
  if (!t) return res.sendStatus(404);
  const { running } = req.body;
  if (typeof running === 'boolean') t.running = running;
  saveTemplates();
  res.json({ ok: true });
});

// Settings
app.get('/settings', (req, res) => res.json(currentSettings));

app.put('/settings', (req, res) => {
  Object.assign(currentSettings, req.body || {});
  saveJSON('settings.json', currentSettings);
  res.json({ ok: true });
});

// ----------------------------
// Runner loop (very naive demo)
// ----------------------------
async function mainLoop() {
  for (const id of Object.keys(templates)) {
    const t = templates[id];
    if (!t.running) continue;
    // pick first ready user (demo): in real code, filter by charges vs threshold
    const readyUsers = t.userIds.map(uid => ({ userId: uid }));
    if (!readyUsers.length) continue;
    // run one user turn
    await t.runUser(readyUsers[0]);
  }
  setTimeout(mainLoop, 250);
}
mainLoop();

// ----------------------------
// Start server
// ----------------------------
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
