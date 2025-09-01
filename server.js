import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { CookieJar } from "tough-cookie";
import { Impit } from "impit";
import { createCanvas, loadImage } from "canvas";
import { router as sseRouter, sendToAll } from "./sse.js";

// --- Setup Data Directory ---
const dataDir = "./data";
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// --- Logging and Utility Functions ---
const log = async (id, name, data, error) => {
    const timestamp = new Date().toLocaleString();
    const identifier = `(${name}#${id})`;
    if (error) {
        console.error(`[${timestamp}] ${identifier} ${data}:`, error);
        appendFileSync(path.join(dataDir, `errors.log`), `[${timestamp}] ${identifier} ${data}: ${error.stack || error.message}\n`);
    } else {
        console.log(`[${timestamp}] ${identifier} ${data}`);
        appendFileSync(path.join(dataDir, `logs.log`), `[${timestamp}] ${identifier} ${data}\n`);
    };
};

const duration = (durationMs) => {
    if (durationMs <= 0) return "0s";
    const totalSeconds = Math.floor(durationMs / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 统一把购买模式标准化：优先用枚举，其次兼容老的两个布尔
function normalizePurchaseMode(body = {}) {
    const RAW = String(body.purchaseMode || '').trim();
    const valid = ['none', 'normal', 'max'];
    const mode = valid.includes(RAW)
      ? RAW
      : (body.canBuyMaxCharges ? 'max'
         : (body.canBuyCharges ? 'normal' : 'none'));
  
    return {
      purchaseMode: mode,                          // 'none' | 'normal' | 'max'
      canBuyCharges: (mode === 'normal' || mode === 'max'),
      canBuyMaxCharges: (mode === 'max'),
    };
  }
  
// —— 统一常量（按你站点实际值来；若已有常量就复用已有的）——
const UNIT_PIXELS_PER_PACK = 30;   // 每包增加的像素数
const UNIT_DROPLET_COST    = 500;  // 每包消耗的 droplets

// 计算“可用于购买”的 droplets：当前滴滴 - 预留值（最低为 0）
function affordableDropletsOf(userInfo, reserve = currentSettings.dropletReserve) {
  const d = Number(userInfo?.droplets) || 0;
  const r = Number(reserve) || 0;
  return Math.max(0, d - r);
}

// 计算应该买几包：受剩余像素、钱包、上限共同约束
function calcPacksToBuy(pixelsRemaining, userInfo, opts = {}) {
  const { reserve = currentSettings.dropletReserve,
          maxPacks = (currentSettings.maxPacksPerTurn ?? 3) } = opts;

  const afford = affordableDropletsOf(userInfo, reserve);
  const packsByNeed  = Math.ceil(Math.max(0, pixelsRemaining) / UNIT_PIXELS_PER_PACK);
  const packsByMoney = Math.floor(afford / UNIT_DROPLET_COST);
  return Math.max(0, Math.min(packsByNeed, packsByMoney, maxPacks));
}


// === JWT 过期时间解析 ===
function readJwtExp(jwt) {
    if (!jwt || typeof jwt !== 'string' || !jwt.includes('.')) return null;
    try {
      const payloadB64 = jwt.split('.')[1];
      const json = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
      return Number(json.exp) || null; // 秒级时间戳
    } catch { return null; }
  }
  function getCookieJwt(user) {
    return user?.cookies?.j || null;
  }
  
  // --- Express App Setup ---
const app = express();
app.use(cors());
app.use(express.static("public"));
app.use(express.json({ limit: Infinity }));


  // === SSE 路由 & 广播 ===
  app.use("/api", sseRouter);
  
  function broadcastUserUpdate(userInfo, extra = {}) {
    if (!userInfo || !userInfo.id) return;
    const persisted = users[userInfo.id] || {};
    const jwt = getCookieJwt(persisted);
    const expSec = readJwtExp(jwt);
    const jwtExpMs = expSec ? expSec * 1000 : null;
  
    sendToAll("user_update", {
      userId: userInfo.id,
      username: userInfo.name,
      charges: Number.isFinite(userInfo?.charges?.count) ? userInfo.charges.count : null,
      maxCharges: Number.isFinite(userInfo?.charges?.max) ? userInfo.charges.max : null,
      level: userInfo?.level ?? null,
      droplets: userInfo?.droplets ?? null,
      recentlySuspended: !!extra.recentlySuspended,
      suspendedUntil: persisted?.suspendedUntil ?? null,
      jwtExp: jwtExpMs,
      ts: Date.now(),
    });
  }
// --- WPlacer Core Classes and Constants ---
class SuspensionError extends Error {
    constructor(message, durationMs) {
      super(message);
      this.name = "SuspensionError";
     const MIN = 10 * 60 * 1000;            // 10 分钟兜底
     const safeDur = Math.max(Number(durationMs) || 0, MIN);
     this.durationMs = safeDur;
    this.suspendedUntil = Date.now() + safeDur;
    }
  }
 

// Custom error for network/Cloudflare issues
class NetworkError extends Error {
    constructor(message) {
        super(message);
        this.name = "NetworkError";
    }
}

const basic_colors = { "0,0,0": 1, "60,60,60": 2, "120,120,120": 3, "210,210,210": 4, "255,255,255": 5, "96,0,24": 6, "237,28,36": 7, "255,127,39": 8, "246,170,9": 9, "249,221,59": 10, "255,250,188": 11, "14,185,104": 12, "19,230,123": 13, "135,255,94": 14, "12,129,110": 15, "16,174,166": 16, "19,225,190": 17, "40,80,158": 18, "64,147,228": 19, "96,247,242": 20, "107,80,246": 21, "153,177,251": 22, "120,12,153": 23, "170,56,185": 24, "224,159,249": 25, "203,0,122": 26, "236,31,128": 27, "243,141,169": 28, "104,70,52": 29, "149,104,42": 30, "248,178,119": 31 };
const premium_colors = { "170,170,170": 32, "165,14,30": 33, "250,128,114": 34, "228,92,26": 35, "214,181,148": 36, "156,132,49": 37, "197,173,49": 38, "232,212,95": 39, "74,107,58": 40, "90,148,74": 41, "132,197,115": 42, "15,121,159": 43, "187,250,242": 44, "125,199,255": 45, "77,49,184": 46, "74,66,132": 47, "122,113,196": 48, "181,174,241": 49, "219,164,99": 50, "209,128,81": 51, "255,197,165": 52, "155,82,73": 53, "209,128,120": 54, "250,182,164": 55, "123,99,82": 56, "156,132,107": 57, "51,57,65": 58, "109,117,141": 59, "179,185,209": 60, "109,100,63": 61, "148,140,107": 62, "205,197,158": 63 };
const pallete = { ...basic_colors, ...premium_colors };
const colorBitmapShift = Object.keys(basic_colors).length + 1;

let loadedProxies = [];
const loadProxies = () => {
    const proxyPath = path.join(dataDir, "proxies.txt");
    if (!existsSync(proxyPath)) {
        writeFileSync(proxyPath, ""); // Create empty file if it doesn't exist
        console.log('[SYSTEM] `data/proxies.txt` not found, created an empty one.');
        loadedProxies = [];
        return;
    }

    const lines = readFileSync(proxyPath, "utf8").split('\n').filter(line => line.trim() !== '');
    const proxies = [];
    const proxyRegex = /^(http|https|socks4|socks5):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/;

    for (const line of lines) {
        const match = line.trim().match(proxyRegex);
        if (match) {
            proxies.push({
                protocol: match[1],
                username: match[2] || '',
                password: match[3] || '',
                host: match[4],
                port: parseInt(match[5], 10)
            });
        } else {
            console.log(`[SYSTEM] WARNING: Invalid proxy format skipped: "${line}"`);
        }
    }
    loadedProxies = proxies;
};


let nextProxyIndex = 0;
const getNextProxy = () => {
    const { proxyEnabled, proxyRotationMode } = currentSettings;
    if (!proxyEnabled || loadedProxies.length === 0) {
        return null;
    }

    let proxy;
    if (proxyRotationMode === 'random') {
        const randomIndex = Math.floor(Math.random() * loadedProxies.length);
        proxy = loadedProxies[randomIndex];
    } else { // Default to sequential
        proxy = loadedProxies[nextProxyIndex];
        nextProxyIndex = (nextProxyIndex + 1) % loadedProxies.length;
    }

    let proxyUrl = `${proxy.protocol}://`;
    if (proxy.username && proxy.password) {
        proxyUrl += `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
    }
    proxyUrl += `${proxy.host}:${proxy.port}`;
    return proxyUrl;
};

class WPlacer {
    constructor(template, coords, settings, templateName) {
        this.template = template;
        this.templateName = templateName;
        this.coords = coords;
        this.settings = settings;
        this.cookies = null;
        this.browser = null;
        this.userInfo = null;
        this.tiles = new Map();
        this.token = null;
    };

    async login(cookies) {
        this.cookies = cookies;
        let jar = new CookieJar();
        for (const cookie of Object.keys(this.cookies)) {
            jar.setCookieSync(`${cookie}=${this.cookies[cookie]}; Path=/`, "https://backend.wplace.live");
        }

        const impitOptions = {
            cookieJar: jar,
            browser: "chrome",
            ignoreTlsErrors: true
        };

        const proxyUrl = getNextProxy();
        if (proxyUrl) {
            impitOptions.proxyUrl = proxyUrl;
            if (currentSettings.logProxyUsage) {
                log('SYSTEM', 'wplacer', `Using proxy: ${proxyUrl.split('@').pop()}`);
            }
        }

        this.browser = new Impit(impitOptions);
        await this.loadUserInfo();
        return this.userInfo;
    };

    async switchUser(cookies) {
        this.cookies = cookies;
        let jar = new CookieJar();
        for (const cookie of Object.keys(this.cookies)) {
            jar.setCookieSync(`${cookie}=${this.cookies[cookie]}; Path=/`, "https://backend.wplace.live");
        }
        this.browser.cookieJar = jar;
        await this.loadUserInfo();
        return this.userInfo;
    }

    async loadUserInfo() {
        const url = "https://backend.wplace.live/me";
        const MAX_RETRIES = 4;
        let backoff = 800; // ms
      
        for (let i = 0; i <= MAX_RETRIES; i++) {
          try {
            const resp = await this.browser.fetch(url, {
              headers: { 'Accept': 'application/json,*/*' }
            });
      
            const text = await resp.text();
      
            // Cloudflare 人机/拦截页（HTML），按网络错误处理，进入重试
            if (text.trim().startsWith("<!DOCTYPE html>")) {
              throw new NetworkError("Cloudflare interruption detected.");
            }
      
            // 尝试解析 JSON；失败就保留原文，继续按状态码分流
            let data;
            try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      
            // 成功路径
            if (resp.ok && data?.id && data?.name) {
              this.userInfo = data;
              return true;
            }
      
            // 明确的鉴权/风控
            if (resp.status === 401 || data?.error === "Unauthorized")
              throw new NetworkError("(401) Unauthorized / rate-limited.");
            if (resp.status === 403)
              throw new NetworkError("(403) Forbidden / challenge.");
      
            // 服务端 5xx 一律按可重试的网络错误处理
            if (resp.status >= 500)
              throw new NetworkError(`(${resp.status}) Upstream error.`);
      
            // 其他异常响应：抛出简短说明（不要“解析失败”这种误导信息）
            throw new Error(`Unexpected /me response: ${text.slice(0,200)}`);
      
          } catch (e) {
            // Impit 自身的超时/握手异常也按可重试
            const retryable =
              e.name === 'NetworkError' ||
              /timeout|ECONNRESET|eof|handshake/i.test(String(e.message));
      
            if (retryable && i < MAX_RETRIES) {
              await sleep(backoff + Math.random()*300);
              backoff = Math.min(backoff * 2, 5000);
              continue;
            }
            // 非可重试错误，原样抛出
            throw e;
          }
        }
      }
      

    async post(url, body) {
        const request = await this.browser.fetch(url, {
            method: "POST",
            headers: { "Accept": "*/*", "Content-Type": "text/plain;charset=UTF-8", "Referer": "https://wplace.live/" },
            body: JSON.stringify(body)
        });
        const data = await request.json();
        return { status: request.status, data: data };
    };

    async loadTile(tx,ty)
    {
        const url = `https://backend.wplace.live/files/s0/tiles/${tx}/${ty}.png?t=${Date.now()}`;
        const response = await this.browser.fetch(url, {
            method: "GET",
            headers: {
                "Accept": "image/*",
                "Referer": "https://wplace.live/"
            }
        });

        if(!response.ok)
        {
            throw new NetworkError(`Failed to load tile ${tx},${ty}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const image = await loadImage(buffer);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, image.width, image.height);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const tileData = {
            width: canvas.width,
            height: canvas.height,
            data: Array.from({ length: canvas.width }, () => [])
        };
        for (let x = 0; x < canvas.width; x++) {
            for (let y = 0; y < canvas.height; y++) {
                const i = (y * canvas.width + x) * 4;
                const [r, g, b, a] = [d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3]];
                tileData.data[x][y] = a === 255 ? (pallete[`${r},${g},${b}`] || 0) : 0;
            }
        }
        this.tiles.set(`${tx}_${ty}`, tileData);
    }

    async loadTiles() {
        this.tiles.clear();
        const [tx, ty, px, py] = this.coords;
        const endPx = px + this.template.width;
        const endPy = py + this.template.height;
        const endTx = tx + Math.floor(endPx / 1000);
        const endTy = ty + Math.floor(endPy / 1000);

        const tilePromises = [];
        for (let currentTx = tx; currentTx <= endTx; currentTx++) {
            for (let currentTy = ty; currentTy <= endTy; currentTy++) {
                const promise = this.loadTile(currentTx,currentTy);
                tilePromises.push(promise);
            }
        }
        await Promise.all(tilePromises);
        return true;
    }

    hasColor(id) {
        if (id < colorBitmapShift) return true;
        return !!(this.userInfo.extraColorsBitmap & (1 << (id - colorBitmapShift)));
    }

    async _executePaint(tx, ty, body) {
        if (body.colors.length === 0) return { painted: 0 };
        const response = await this.post(`https://backend.wplace.live/s0/pixel/${tx}/${ty}`, body);

        if (response.data.painted && response.data.painted === body.colors.length) {
            log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] 🎨 Painted ${body.colors.length} pixels on tile ${tx}, ${ty}.`);
            return { painted: body.colors.length };
        }
        if (response.status === 401 && response.data.error === "Unauthorized") {
            throw new NetworkError(`(401) Unauthorized during paint. This is a severe rate-limit.`);
        }
        if (response.status === 403 && (response.data.error === "refresh" || response.data.error === "Unauthorized")) {
            throw new Error('REFRESH_TOKEN');
        }
        if (response.status === 451 && response.data) {
            const s = response.data.suspension || {};
            let dur = Number(response.data.durationMs ?? s.durationMs);
            if (!(dur > 0) && s.until) dur = Math.max(0, Number(s.until) - Date.now());
            throw new SuspensionError(`Account is suspended.`, dur || 0);
            }
        if (response.status === 500) {
            log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] ⏱️ Server error (500). Waiting 40 seconds before retrying...`);
            await sleep(40000);
            return { painted: 0 };
        }
        if (response.status === 429 || (response.data.error && response.data.error.includes("Error 1015"))) {
            throw new NetworkError("(1015) You are being rate-limited.");
        }
        throw Error(`Unexpected response for tile ${tx},${ty}: ${JSON.stringify(response)}`);
    }

    _getMismatchedPixels(currentSkip = 1) {
        const [startX, startY, startPx, startPy] = this.coords;
        const mismatched = [];
        for (let y = 0; y < this.template.height; y++) {
            for (let x = 0; x < this.template.width; x++) {
                if ((x + y) % currentSkip !== 0) continue;

                const templateColor = this.template.data[x][y];
                if (templateColor === 0) continue;

                const globalPx = startPx + x;
                const globalPy = startPy + y;
                const targetTx = startX + Math.floor(globalPx / 1000);
                const targetTy = startY + Math.floor(globalPy / 1000);
                const localPx = globalPx % 1000;
                const localPy = globalPy % 1000;

                const tile = this.tiles.get(`${targetTx}_${targetTy}`);
                if (!tile || !tile.data[localPx]) continue;

                const tileColor = tile.data[localPx][localPy];

                const shouldPaint = this.settings.skipPaintedPixels
                    ? tileColor === 0 // If skip mode is on, only paint if the tile is blank
                    : templateColor !== tileColor; // Otherwise, paint if the color is wrong

                if(templateColor===-1 && tileColor!==0){
                    const neighbors = [this.template.data[x - 1]?.[y], this.template.data[x + 1]?.[y], this.template.data[x]?.[y - 1], this.template.data[x]?.[y + 1]];
                    const isEdge = neighbors.some(n => n === 0 || n === undefined);
                    mismatched.push({ tx: targetTx, ty: targetTy, px: localPx, py: localPy, color: 0, isEdge, localX: x, localY: y })
                }
                else if (templateColor > 0 && shouldPaint && this.hasColor(templateColor)) {
                    const neighbors = [this.template.data[x - 1]?.[y], this.template.data[x + 1]?.[y], this.template.data[x]?.[y - 1], this.template.data[x]?.[y + 1]];
                    const isEdge = neighbors.some(n => n === 0 || n === undefined);
                    mismatched.push({ tx: targetTx, ty: targetTy, px: localPx, py: localPy, color: templateColor, isEdge, localX: x, localY: y });
                }
            }
        }
        return mismatched;
    }

    async paint(currentSkip = 1) {
        await this.loadUserInfo();
        await this.loadTiles();
        if (!this.token) throw new Error("Token not provided to paint method.");

        let mismatchedPixels = this._getMismatchedPixels(currentSkip);
        if (mismatchedPixels.length === 0) return 0;

        log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] Found ${mismatchedPixels.length} mismatched pixels.`);

        let pixelsToProcess = mismatchedPixels;
        let isOutlineTurn = false;

        // 1. Prioritize Outline Mode
        if (this.settings.outlineMode) {
            const edgePixels = mismatchedPixels.filter(p => p.isEdge);
            if (edgePixels.length > 0) {
                pixelsToProcess = edgePixels;
                isOutlineTurn = true;
            }
        }

        // 2. Base Directional Sort
        switch (this.settings.drawingDirection) {
            case 'btt': // Bottom to Top
                pixelsToProcess.sort((a, b) => b.localY - a.localY);
                break;
            case 'ltr': // Left to Right
                pixelsToProcess.sort((a, b) => a.localX - b.localX);
                break;
            case 'rtl': // Right to Left
                pixelsToProcess.sort((a, b) => b.localX - a.localX);
                break;
            case 'center_out': {
                const centerX = this.template.width / 2;
                const centerY = this.template.height / 2;
                const distSq = (p) => Math.pow(p.localX - centerX, 2) + Math.pow(p.localY - centerY, 2);
                pixelsToProcess.sort((a, b) => distSq(a) - distSq(b));
                break;
            }
            case 'ttb': // Top to Bottom
            default:
                pixelsToProcess.sort((a, b) => a.localY - b.localY);
                break;
        }

        // 3. Apply Order Modification
        switch (this.settings.drawingOrder) {
            case 'random':
                for (let i = pixelsToProcess.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pixelsToProcess[i], pixelsToProcess[j]] = [pixelsToProcess[j], pixelsToProcess[i]];
                }
                break;
            case 'color':
            case 'randomColor': {
                const pixelsByColor = pixelsToProcess.reduce((acc, p) => {
                    if (!acc[p.color]) acc[p.color] = [];
                    acc[p.color].push(p);
                    return acc;
                }, {});
                const colors = Object.keys(pixelsByColor);
                if (this.settings.drawingOrder === 'randomColor') {
                    for (let i = colors.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [colors[i], colors[j]] = [colors[j], colors[i]];
                    }
                }
                pixelsToProcess = colors.flatMap(color => pixelsByColor[color]);
                break;
            }
            case 'linear':
            default:
                // Do nothing, keep the directional sort
                break;
        }

        // 4. Prepare and execute the paint job
        const pixelsToPaint = pixelsToProcess.slice(0, Math.floor(this.userInfo.charges.count));
        const bodiesByTile = pixelsToPaint.reduce((acc, p) => {
            const key = `${p.tx},${p.ty}`;
            if (!acc[key]) acc[key] = { colors: [], coords: [] };
            acc[key].colors.push(p.color);
            acc[key].coords.push(p.px, p.py);
            return acc;
        }, {});

        let totalPainted = 0;
        for (const tileKey in bodiesByTile) {
            const [tx, ty] = tileKey.split(',').map(Number);
            const body = { ...bodiesByTile[tileKey], t: this.token };
            const result = await this._executePaint(tx, ty, body);
            totalPainted += result.painted;
        }
        return totalPainted;
    }

    async buyProduct(productId, amount) {
        const response = await this.post(`https://backend.wplace.live/purchase`, { product: { id: productId, amount: amount } });
        if (response.data.success) {
            let purchaseMessage = `🛒 Purchase successful for product #${productId} (amount: ${amount})`;
            if (productId === 80) purchaseMessage = `🛒 Bought ${amount * 30} pixels for ${amount * 500} droplets`;
            else if (productId === 70) purchaseMessage = `🛒 Bought ${amount} Max Charge Upgrade(s) for ${amount * 500} droplets`;
            log(this.userInfo.id, this.userInfo.name, `[${this.templateName}] ${purchaseMessage}`);
            return true;
        }
        if (response.status === 429 || (response.data.error && response.data.error.includes("Error 1015"))) {
            throw new NetworkError("(1015) You are being rate-limited while trying to make a purchase.");
        }
        throw Error(`Unexpected response during purchase: ${JSON.stringify(response)}`);
    };

    async pixelsLeft(currentSkip = 1) {
        await this.loadTiles();
        return this._getMismatchedPixels(currentSkip).length;
    };
}

// --- Data Persistence ---
const loadJSON = (filename) => existsSync(path.join(dataDir, filename)) ? JSON.parse(readFileSync(path.join(dataDir, filename), "utf8")) : {};
const saveJSON = (filename, data) => writeFileSync(path.join(dataDir, filename), JSON.stringify(data, null, 4));

const users = loadJSON("users.json");
const saveUsers = () => saveJSON("users.json", users);

const templates = {}; // In-memory store for active TemplateManager instances
const saveTemplates = () => {
    const templatesToSave = {};
    for (const id in templates) {
        const t = templates[id];
        templatesToSave[id] = {
            name: t.name, template: t.template, coords: t.coords,
            canBuyCharges: t.canBuyCharges, canBuyMaxCharges: t.canBuyMaxCharges,
            purchaseMode: t.purchaseMode,
            antiGriefMode: t.antiGriefMode, enableAutostart: t.enableAutostart, userIds: t.userIds
        };
    }
    saveJSON("templates.json", templatesToSave);
};

let currentSettings = {
    accountCooldown: 20000, purchaseCooldown: 5000,
    keepAliveCooldown: 5000, dropletReserve: 0, antiGriefStandby: 600000,
    drawingDirection: 'ttb', drawingOrder: 'linear', chargeThreshold: 0.5,
    outlineMode: false, skipPaintedPixels: false, accountCheckCooldown: 1000,
    pixelSkip: 1,
    proxyEnabled: false,
    proxyRotationMode: 'sequential',
    logProxyUsage: false,
    banCooldownMinutes: 2
};
if (existsSync(path.join(dataDir, "settings.json"))) {
    currentSettings = { ...currentSettings, ...loadJSON("settings.json") };
}
const saveSettings = () => {
    saveJSON("settings.json", currentSettings);
};

// --- Token Management ---
const TokenManager = {
    tokenQueue: [], // Now stores objects: { token: string, receivedAt: number }
    tokenPromise: null,
    resolvePromise: null,
    isTokenNeeded: false,
    TOKEN_EXPIRATION_MS: 2 * 60 * 1000, // 2 minutes

    _purgeExpiredTokens() {
        const now = Date.now();
        const initialSize = this.tokenQueue.length;
        this.tokenQueue = this.tokenQueue.filter(
            item => now - item.receivedAt < this.TOKEN_EXPIRATION_MS
        );
        const removedCount = initialSize - this.tokenQueue.length;
        if (removedCount > 0) {
            log('SYSTEM', 'wplacer', `TOKEN_MANAGER: Discarded ${removedCount} expired token(s).`);
        }
    },

    getToken() {
        this._purgeExpiredTokens();

        if (this.tokenQueue.length > 0) {
               const item = this.tokenQueue.shift();    // ← 取出即删，避免多账号复用同一 token
               return Promise.resolve(item.token);
             }

        if (!this.tokenPromise) {
            log('SYSTEM', 'wplacer', 'TOKEN_MANAGER: A task is waiting for a token. Flagging for clients.');
            this.isTokenNeeded = true;
            this.tokenPromise = new Promise((resolve) => {
                this.resolvePromise = resolve;
            });
        }
        return this.tokenPromise;
    },

    setToken(t) {
        log('SYSTEM', 'wplacer', `✅ TOKEN_MANAGER: Token received. Queue size: ${this.tokenQueue.length + 1}`);
        this.isTokenNeeded = false;
        const newToken = { token: t, receivedAt: Date.now() };
        this.tokenQueue = [newToken];

        if (this.resolvePromise) {
            this.resolvePromise(newToken.token); // Resolve with the new token
            this.tokenPromise = null;
            this.resolvePromise = null;
        }
    },

    invalidateToken() {
        this.tokenQueue.shift();
        log('SYSTEM', 'wplacer', `🔄 TOKEN_MANAGER: Invalidating token. ${this.tokenQueue.length} tokens remaining.`);
    }
};

// --- Error Handling ---
function logUserError(error, id, name, context) {
    const message = error.message || "An unknown error occurred.";
    if (error.name === 'NetworkError' || message.includes("(500)") || message.includes("(1015)") || message.includes("(502)") || error.name === "SuspensionError") {
        log(id, name, `❌ Failed to ${context}: ${message}`);
    } else {
        log(id, name, `❌ Failed to ${context}`, error);
    }
}
// --- Server State ---  
const activeBrowserUsers = new Set();
let activePaintingTasks = 0;

// --- Template Management ---
class TemplateManager {
    constructor(
      name,
      templateData,
      coords,
      canBuyCharges,
      canBuyMaxCharges,
      antiGriefMode,
      enableAutostart,
      userIds,
      purchaseMode     // ← 如果调用方会传，就接住；否则下面也会从 templateData/布尔推断
    ) {
      this.name = name;
      this.template = templateData;
      this.coords = coords;
  
      // 这些布尔先别急着定最终值，下面会统一由 purchaseMode 推导再覆盖
      this.canBuyCharges = !!canBuyCharges;
      this.canBuyMaxCharges = !!canBuyMaxCharges;
  
      this.antiGriefMode = !!antiGriefMode;
      this.enableAutostart = !!enableAutostart;
  
      this.userIds = userIds || [];
      this.running = false;
      this.status = "Waiting to be started.";
      this.masterId = this.userIds[0];
      this.masterName = (users[this.masterId] && users[this.masterId].name) || 'Unknown';
  
      this.sleepAbortController = null;
      this.totalPixels = (this.template?.data || []).flat().filter(p => p !== 0).length;
      this.pixelsRemaining = this.totalPixels;
      this.currentPixelSkip = currentSettings.pixelSkip;
  
      // backoff
      this.initialRetryDelay = 30 * 1000;
      this.maxRetryDelay = 5 * 60 * 1000;
      this.currentRetryDelay = this.initialRetryDelay;
  
      // 运行期封禁记录
      this.recentlySuspended = new Map();
        
      // —— 统一“买电模式”：优先用入参；否则尝试从模板；否则兼容老布尔 —— //
      const mode =
        (typeof purchaseMode === 'string' && purchaseMode) ||
        (this.template && this.template.purchaseMode) ||
        (this.canBuyMaxCharges ? 'max' : (this.canBuyCharges ? 'normal' : 'none'));
  
      this.purchaseMode = mode;                            // 'none' | 'normal' | 'max'
      this.canBuyCharges    = (mode === 'normal' || mode === 'max'); // 统一布尔（兼容旧代码）
      this.canBuyMaxCharges = (mode === 'max');
  
      log('SYSTEM', 'wplacer',
        `[${this.name}] PurchaseMode=${this.purchaseMode} canBuyCharges=${this.canBuyCharges} canBuyMaxCharges=${this.canBuyMaxCharges}`);
    }
  
    // ========= 放在 constructor 之外！以下是“类方法” =========
    _makePlacer() {
        return new WPlacer(this.template, this.coords, currentSettings, this.name);
      }
    // 账号被封到何时（持久封禁/近期封禁取较大者）
    _blockedUntil(uid) {
      const u = users[uid] || {};
      const persisted = Number(u.suspendedUntil) || 0; // 持久封禁
      const recent = Number((this.recentlySuspended && this.recentlySuspended.get(uid)) || 0); // 近期封禁
      return Math.max(persisted, recent);
    }
  
    // 是否可用：未在执行 + 未处于封禁期
    _isUserAvailable(uid) {
      if (!uid) return false;
      if (activeBrowserUsers.has(uid)) return false; // 并发锁
      const blockedUntil = this._blockedUntil(uid);
      return !(blockedUntil && Date.now() < blockedUntil);
    }
  
    // 过滤出可用账号
    _filterAvailable(ids) {
      return (ids || []).filter((id) => this._isUserAvailable(id));
    }

    
    
    sleep(ms) {
        return new Promise((resolve) => {
            if (this.sleepAbortController) {
                this.sleepAbortController.abort();
            }
            this.sleepAbortController = new AbortController();
            const signal = this.sleepAbortController.signal;

            const timeout = setTimeout(() => {
                this.sleepAbortController = null;
                resolve();
            }, ms);

            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                this.sleepAbortController = null;
                resolve(); // Resolve on abort so the await continues
            });
        });
    }

    interruptSleep() {
        if (this.sleepAbortController) {
            log('SYSTEM', 'wplacer', `[${this.name}] ⚙️ Settings changed, waking up.`);
            this.sleepAbortController.abort();
        }
    }

    async handleUpgrades(wplacer) {
        if (!this.canBuyMaxCharges) return;
        await wplacer.loadUserInfo();
        const affordableDroplets = affordableDropletsOf(wplacer.userInfo);
        const amountToBuy = Math.floor(affordableDroplets / 500);
        if (amountToBuy > 0) {
            log(wplacer.userInfo.id, wplacer.userInfo.name, `💰 Attempting to buy ${amountToBuy} max charge upgrade(s).`);
            try {
                await wplacer.buyProduct(70, amountToBuy);
                await this.sleep(currentSettings.purchaseCooldown);
                await wplacer.loadUserInfo();
            } catch (error) {
                logUserError(error, wplacer.userInfo.id, wplacer.userInfo.name, "purchase max charge upgrades");
            }
        }
    }

    async _maybeBuyChargesAfterTurn(preferredBuyerId) {
        if (!this.canBuyCharges) return false;
        if (this.pixelsRemaining <= 0) return false;
      
        // 用 master 统一购买，避免并发
        const candidates = [preferredBuyerId, this.masterId].filter(Boolean);
        let buyerId = null, buyerInfo = null, buyer = null;
      
        try {
            for (const uid of candidates) {
                  activeBrowserUsers.add(uid);
                  const w = this._makePlacer();  
                  try {
                    const info = await w.login(users[uid].cookies);
                    buyerId = uid; buyerInfo = info; buyer = w; break;
                    } catch (e) {
                    activeBrowserUsers.delete(uid);
                  }
                }
                if (!buyer) { log('SYSTEM','wplacer',`[${this.name}] 🔸 Skip buy: no free buyer (current/master busy).`); return false; }
                if (buyerInfo) broadcastUserUpdate(buyerInfo);
      
                const affordableDroplets = affordableDropletsOf(buyerInfo);
                if (affordableDroplets < 500) { 
                   log(buyerId, users[buyerId].name, `[${this.name}] 🔸 Skip buy: droplets ${buyerInfo.droplets} < reserve+500.`);
                   return false; 
                }
      
            const amountToBuy = calcPacksToBuy(this.pixelsRemaining, buyerInfo);
          if (amountToBuy <= 0) { 
              log(buyerId, users[buyerId].name, `[${this.name}] 🔸 Skip buy: amountToBuy=0 (need/money不足).`);
              return false; 
            }
      
          log(buyerId, users[buyerId].name, `[${this.name}] 💰 Attempting to buy pixel charges. packs=${amountToBuy}`);
          await buyer.buyProduct(80, amountToBuy); // 30px/500滴
          await this.sleep(currentSettings.purchaseCooldown);
          return true;
        } catch (e) {
          logUserError(e, buyerId || this.masterId, users[buyerId || this.masterId]?.name || this.masterName, "attempt to buy pixel charges");
          return false;
        } finally {
          if (buyerId) activeBrowserUsers.delete(buyerId);
        }
      }
      

    async _performPaintTurn(wplacer) {
        let paintingComplete = false;
        while (!paintingComplete && this.running) {
            try {
                wplacer.token = await TokenManager.getToken();
                await wplacer.paint(this.currentPixelSkip);
                paintingComplete = true;
            } catch (error) {
                if (error.name === "SuspensionError") {
                    const suspMs = Number(error.suspendedUntil) || (Date.now() + 10*60*1000);
                    const coolExtra = Math.max(0, Number(currentSettings.banCooldownMinutes) || 0) * 60 * 1000;
                    const blockedUntil = suspMs + coolExtra;
                    const suspStr = new Date(suspMs).toLocaleString();
                    const coolStr = coolExtra ? ` (+ cooldown ${Math.round(coolExtra/60000)}m)` : '';
                    log(wplacer.userInfo.id, wplacer.userInfo.name,
                        `[${this.name}] 🛑 Account suspended until ${suspStr}${coolStr}.`);
                    users[wplacer.userInfo.id].suspendedUntil = blockedUntil;
                    saveUsers();
                    this.recentlySuspended.set(wplacer.userInfo.id, blockedUntil);
                    throw error; // 交给外层循环处理
                    }
                
                if (error.message === 'REFRESH_TOKEN') {
                    log(wplacer.userInfo.id, wplacer.userInfo.name, `[${this.name}] 🔄 Token expired or invalid. Trying next token...`);
                    TokenManager.invalidateToken();
                    await this.sleep(1200 + Math.floor(Math.random() * 800));
                } else {
                    // Re-throw other errors to be handled by the main loop
                    throw error;
                }
            }
        }
    }

    async runUser(userToRun){
        if (activeBrowserUsers.has(userToRun.userId)) return;
        if (userToRun) {
            activeBrowserUsers.add(userToRun.userId);
            const wplacer = this._makePlacer();  
            let paintedInTurn = false;
            try {
                const userInfo = await wplacer.login(users[userToRun.userId].cookies);
                this.status = `Running user ${userInfo.name}#${userInfo.id} | Pass (1/${this.currentPixelSkip})`;
                log(userInfo.id, userInfo.name, `[${this.name}] 🔋 User has ${Math.floor(userInfo.charges.count)} charges. Starting turn...`);

                await this._performPaintTurn(wplacer);
                paintedInTurn = true;

                await this.handleUpgrades(wplacer);
                this.currentRetryDelay = this.initialRetryDelay;

            } catch (error) {
                // SuspensionError is re-thrown and caught here
                if (error.name !== 'SuspensionError') {
                    logUserError(error, userToRun.userId, users[userToRun.userId].name, "perform paint turn");
                }
                if (error.name === 'NetworkError') {
                    log('SYSTEM', 'wplacer', `[${this.name}] Network issue during paint turn. Waiting for ${duration(this.currentRetryDelay)} before retrying.`);
                    await this.sleep(this.currentRetryDelay);
                    this.currentRetryDelay = Math.min(this.currentRetryDelay * 2, this.maxRetryDelay);
                }
            } finally {
                activeBrowserUsers.delete(userToRun.userId);
            }

               // ★ 这里调用：落笔后购买（内部自带各种判定和并发保护）
            if (paintedInTurn && this.running) {
                await this._maybeBuyChargesAfterTurn(userToRun.userId);
            }
              
            if (paintedInTurn && this.running && this.userIds.length > 1) {
                log('SYSTEM', 'wplacer', `[${this.name}] ⏱️ Waiting for account turn cooldown (${duration(currentSettings.accountCooldown)}).`);
                await this.sleep(currentSettings.accountCooldown);
            }

        }  else {
    await this._maybeBuyChargesAfterTurn(null);
    }
        return false; //No purchase was made
    }

    async start() {
        this.running = true;
        this.status = "Started.";
        log('SYSTEM', 'wplacer', `▶️ Starting template "${this.name}"...`);
        activePaintingTasks++;

        try {
            while (this.running) {
                for (this.currentPixelSkip = currentSettings.pixelSkip; this.currentPixelSkip >= 1; this.currentPixelSkip /= 2) {
                    if (!this.running) break;
                    log('SYSTEM', 'wplacer', `[${this.name}] Starting pass (1/${this.currentPixelSkip})`);

                    let passComplete = false;
                    while (this.running && !passComplete) {
                        let pixelsChecked = false;
                        const availableCheckUsers = this.userIds.filter(id => !activeBrowserUsers.has(id));
                        if (availableCheckUsers.length === 0) {
                            log('SYSTEM', 'wplacer', `[${this.name}] ⏳ All users are busy. Waiting...`);
                            await this.sleep(5000);
                            continue;
                        }

                        for (const userId of availableCheckUsers) {
                            const checkWplacer = this._makePlacer();  
                            try {
                                const userInfo = await checkWplacer.login(users[userId].cookies);
                                if (userInfo) broadcastUserUpdate(userInfo);
                                this.pixelsRemaining = await checkWplacer.pixelsLeft(this.currentPixelSkip);
                                this.currentRetryDelay = this.initialRetryDelay;
                                pixelsChecked = true;
                                break;
                            } catch (error) {
                                logUserError(error, userId, users[userId].name, "check pixels left");
                            }
                        }

                        if (!pixelsChecked) {
                            log('SYSTEM', 'wplacer', `[${this.name}] All available users failed to check canvas. Waiting for ${duration(this.currentRetryDelay)} before retrying.`);
                            await this.sleep(this.currentRetryDelay);
                            this.currentRetryDelay = Math.min(this.currentRetryDelay * 2, this.maxRetryDelay);
                            continue;
                        }

                        if (this.pixelsRemaining === 0) {
                            log('SYSTEM', 'wplacer', `[${this.name}] ✅ Pass (1/${this.currentPixelSkip}) complete.`);
                            passComplete = true;
                            continue;
                        }

                        const localUserStates = [];
                        const now = Date.now();
                        
                        // 统一按“封禁到期 + 冷静期”跳过（包含持久化的 suspendedUntil 与进程内 recentlySuspended）
                        const availableUsers = this._filterAvailable(this.userIds);
                        
                        // 日志里把被跳过的数量也打出来，便于观测是否生效
                        const skippedCount = this.userIds.length - availableUsers.length;
                        log('SYSTEM', 'wplacer', `[${this.name}] Checking status for ${availableUsers.length} available users (skipped ${skippedCount} blocked users)...`);
                        
                        for (const userId of availableUsers) {
                          if (activeBrowserUsers.has(userId)) continue;
                          activeBrowserUsers.add(userId);
                          const wplacer = this._makePlacer();  
                          try {
                            const userInfo = await wplacer.login(users[userId].cookies);
                            broadcastUserUpdate(userInfo);
                            localUserStates.push({ userId, charges: userInfo.charges });
                          } catch (error) {
                            logUserError(error, userId, users[userId].name, "check user status");
                          } finally {
                            activeBrowserUsers.delete(userId);
                          }
                          await this.sleep(currentSettings.accountCheckCooldown);
                        }
                        
                        const readyUsers = localUserStates
                            .filter(state => Math.floor(state.charges.count) >= Math.max(1, Math.floor(state.charges.max * currentSettings.chargeThreshold)))
                            .sort((a, b) => b.charges.count - a.charges.count);

                        log('SYSTEM', 'wplacer', `[${this.name}] Found ${readyUsers.length} users ready to paint.`);

                        for (const userToRun of readyUsers){ //let all user ready user take turn
                            await this.runUser(userToRun);
                        }

                        const cooldowns = localUserStates
                            .map(state => state.charges)
                            .map(c => Math.max(0, (Math.max(1, Math.floor(c.max * currentSettings.chargeThreshold)) - Math.floor(c.count)) * c.cooldownMs));

                        const waitTime = (cooldowns.length > 0 ? Math.min(...cooldowns) : 60000) + 2000;
                        this.status = `Waiting for charges.`;
                        log('SYSTEM', 'wplacer', `[${this.name}] ⏳ No users ready to paint. Waiting for charges to replenish (est. ${duration(waitTime)}).`);
                        await this.sleep(waitTime);
                    }
                }

                if (!this.running) break;

                if (this.antiGriefMode) {
                    this.status = "Monitoring for changes.";
                    log('SYSTEM', 'wplacer', `[${this.name}] 🖼 All passes complete. Monitoring... Checking again in ${duration(currentSettings.antiGriefStandby)}.`);
                    await this.sleep(currentSettings.antiGriefStandby);
                    continue; // Restart the main while loop to re-run all passes
                } else {
                    log('SYSTEM', 'wplacer', `[${this.name}] 🖼 All passes complete! Template finished!`);
                    this.status = "Finished.";
                    this.running = false; // This will cause the while loop to terminate
                }
            }
        } finally {
            activePaintingTasks--;
            if (this.status !== "Finished.") {
                this.status = "Stopped.";
            }
        }
    }
}


// --- Autostartup Templates Array ---
const autostartedTemplates = [];

// --- API Endpoints ---
app.get("/token-needed", (req, res) => {
    res.json({ needed: TokenManager.isTokenNeeded });
});

app.post("/t", (req, res) => {
    const { t } = req.body;
    if (!t) return res.sendStatus(400);
    TokenManager.setToken(t);
    res.sendStatus(200);
});

app.get("/users", (_, res) => res.json(users));
app.post("/user", async (req, res) => {
    if (!req.body.cookies || !req.body.cookies.j) return res.sendStatus(400);
    const wplacer = new WPlacer(null, null, currentSettings, "temp");  // Fixed
    try {
        const userInfo = await wplacer.login(req.body.cookies);
        users[userInfo.id] = { name: userInfo.name, cookies: req.body.cookies, expirationDate: req.body.expirationDate };
        broadcastUserUpdate(userInfo);
        saveUsers();
        res.json(userInfo);
    } catch (error) {
        logUserError(error, 'NEW_USER', 'N/A', 'add new user');
        res.status(500).json({ error: error.message });
    }
});

app.delete("/user/:id", async (req, res) => {
    const userIdToDelete = req.params.id;
    if (!userIdToDelete || !users[userIdToDelete]) return res.sendStatus(400);

    const deletedUserName = users[userIdToDelete].name;
    delete users[userIdToDelete];
    saveUsers();
    log('SYSTEM', 'Users', `Deleted user ${deletedUserName}#${userIdToDelete}.`);

    let templatesModified = false;
    for (const templateId in templates) {
        const template = templates[templateId];
        const initialUserCount = template.userIds.length;
        template.userIds = template.userIds.filter(id => id !== userIdToDelete);

        if (template.userIds.length < initialUserCount) {
            templatesModified = true;
            log('SYSTEM', 'Templates', `Removed user ${deletedUserName}#${userIdToDelete} from template "${template.name}".`);
            if (template.masterId === userIdToDelete) {
                template.masterId = template.userIds[0] || null;
                template.masterName = template.masterId ? users[template.masterId].name : null;
            }
            if (template.userIds.length === 0 && template.running) {
                template.running = false;
                log('SYSTEM', 'wplacer', `[${template.name}] 🛑 Template stopped because it has no users left.`);
            }
        }
    }
    if (templatesModified) saveTemplates();
    res.sendStatus(200);
});

app.get("/user/status/:id", async (req, res) => {
    const { id } = req.params;
    if (!users[id] || activeBrowserUsers.has(id)) return res.sendStatus(409);
    activeBrowserUsers.add(id);
    const wplacer = new WPlacer(null, null, currentSettings, "temp");  // Fixed
    try {
        const userInfo = await wplacer.login(users[id].cookies);
        broadcastUserUpdate(userInfo);
        res.status(200).json(userInfo);
    } catch (error) {
        logUserError(error, id, users[id].name, "validate cookie");
        res.status(500).json({ error: error.message });
    } finally {
        activeBrowserUsers.delete(id);
    }
});

// 单账号：替换 cookies 并校验
app.post("/user/:id/cookies", async (req, res) => {
    const { id } = req.params;
    const { cookies, expirationDate } = req.body || {};
    if (!users[id] || !cookies?.j) return res.sendStatus(400);
  
    const w = new WPlacer(null, null, currentSettings, "temp");  // Fixed
    try {
      const info = await w.login(cookies);         // 用新 cookie 校验
      users[id].cookies = cookies;                 // 保存
      users[id].expirationDate = expirationDate || null;
      const expSec = readJwtExp(cookies.j);
      users[id].jwtExp = expSec ? expSec * 1000 : null;
      saveUsers();
  
      broadcastUserUpdate(info);                   // SSE 刷新卡片
      res.json({ ok: true, id, name: info.name });
    } catch (e) {
      logUserError(e, id, users[id].name, "replace cookies");
      res.status(400).json({ ok:false, error: e.message });
    }
  });
  
  // 批量：数组或 JSONL
  app.post("/users/cookies-bulk", async (req, res) => {
    let list = [];
    if (Array.isArray(req.body?.list)) list = req.body.list;
    else if (typeof req.body === 'string') {
      list = req.body.split('\n').map(s=>s.trim()).filter(Boolean).map(JSON.parse);
    } else return res.sendStatus(400);
  
    const results = [];
    for (const item of list) {
      const { id, cookies, expirationDate } = item || {};
      if (!id || !users[id] || !cookies?.j) { results.push({ id, ok:false, error:'bad_entry' }); continue; }
      const w = new WPlacer(null, null, currentSettings, "temp");  // Fixed
      try {
        const info = await w.login(cookies);
        users[id].cookies = cookies;
        users[id].expirationDate = expirationDate || null;
        const expSec = readJwtExp(cookies.j);
        users[id].jwtExp = expSec ? expSec * 1000 : null;
        saveUsers();
        broadcastUserUpdate(info);
        results.push({ id, ok:true, name: info.name });
        await sleep(300);
      } catch (e) {
        logUserError(e, id, users[id].name, "bulk replace cookies");
        results.push({ id, ok:false, error: e.message });
      }
    }
    res.json({ results });
  });
  
app.post("/users/status", async (req, res) => {
    const userIds = Object.keys(users);
    const results = {};
    const concurrencyLimit = 5; // Number of checks to run in parallel

    const checkUser = async (id) => {
        if (activeBrowserUsers.has(id)) {
            results[id] = { success: false, error: "User is busy." };
            return;
        }
        activeBrowserUsers.add(id);
        const wplacer = new WPlacer(null, null, currentSettings, "temp");  // Fixed 
        try {
            const userInfo = await wplacer.login(users[id].cookies);
            broadcastUserUpdate(userInfo);
            results[id] = { success: true, data: userInfo };
        } catch (error) {
            logUserError(error, id, users[id].name, "validate cookie in bulk check");
            results[id] = { success: false, error: error.message };
        } finally {
            activeBrowserUsers.delete(id);
        }
    };

    const queue = [...userIds];
    const workers = Array(concurrencyLimit).fill(null).map(async () => {
        while (queue.length > 0) {
            const userId = queue.shift();
            if (userId) {
                await checkUser(userId);
            }
        }
    });

    await Promise.all(workers);
    res.json(results);
});
// 设置单个用户的分组
app.put("/user/:id/group", (req, res) => {
    const { id } = req.params;
    const { group } = req.body || {};
    if (!users[id]) return res.sendStatus(404);
    users[id].group = group || null;
    saveUsers();
    res.json({ ok: true, id, group: users[id].group });
  });
  
  // 批量给一组用户设分组
  app.post("/users/group-bulk", (req, res) => {
    const { ids, group } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.sendStatus(400);
    const results = [];
    for (const id of ids) {
      if (!users[id]) { results.push({ id, ok:false, error:'not_found' }); continue; }
      users[id].group = group || null;
      results.push({ id, ok:true });
    }
    saveUsers();
    res.json({ ok:true, results });
  });
  
  // 列出已有分组（下拉菜单用）
  app.get("/users/groups", (_, res) => {
    const set = new Set();
    for (const id of Object.keys(users)) {
      if (users[id]?.group) set.add(users[id].group);
    }
    res.json({ groups: Array.from(set).sort() });
  });
  
  app.post("/api/bulkSyncGroup", async (req, res) => {
    const { groupId, userIds = [] } = req.body || {};
    if (!groupId || userIds.length === 0) {
      return res.status(400).json({ error: "参数不全" });
    }
  
    // TODO: 在这里写你的实际同步逻辑
    console.log("分组同步请求:", groupId, userIds);
  
    return res.json({ groupId, count: userIds.length });
  });

  
app.get("/templates", (_, res) => {
    const sanitizedTemplates = {};
    for (const id in templates) {
        const t = templates[id];
        sanitizedTemplates[id] = {
            name: t.name,
            template: t.template,
            coords: t.coords,
            canBuyCharges: t.canBuyCharges,
            canBuyMaxCharges: t.canBuyMaxCharges,
            purchaseMode: t.purchaseMode,
            antiGriefMode: t.antiGriefMode,
            enableAutostart: t.enableAutostart,
            userIds: t.userIds,
            running: t.running,
            status: t.status,
            pixelsRemaining: t.pixelsRemaining,
            totalPixels: t.totalPixels
        };
    }
    res.json(sanitizedTemplates);
});

app.post("/template", async (req, res) => {
    const { templateName, template, coords, userIds, antiGriefMode, enableAutostart } = req.body;
    if (!templateName || !template || !Array.isArray(coords) || coords.length !== 4 || !Array.isArray(userIds) || userIds.length === 0) {
      return res.sendStatus(400);
    }
  
    // 统一模式：返回 { purchaseMode, canBuyCharges, canBuyMaxCharges }
    const { purchaseMode, canBuyCharges, canBuyMaxCharges } = normalizePurchaseMode(req.body);
  
    // 唯一名校验
    if (Object.values(templates).some(t => t.name === templateName)) {
      return res.status(409).json({ error: "A template with this name already exists." });
    }
  
    const templateId = Date.now().toString();
    templates[templateId] = new TemplateManager(
      templateName,
      template,
      coords.map(Number),        // 统一成 number
      canBuyCharges,
      canBuyMaxCharges,
      !!antiGriefMode,
      !!enableAutostart,
      userIds.map(String),       // 统一成 string
      purchaseMode               // ★ 传入枚举
    );
  
    saveTemplates();
    res.status(201).json({ id: templateId });
  });
  

app.delete("/template/:id", async (req, res) => {
    const { id } = req.params;
    if (!id || !templates[id] || templates[id].running) return res.sendStatus(400);
    delete templates[id];
    saveTemplates();
    res.sendStatus(200);
});

app.put("/template/edit/:id", async (req, res) => {
    const { id } = req.params;
    if (!templates[id]) return res.sendStatus(404);
    const manager = templates[id];
    const { templateName, coords, userIds, antiGriefMode, enableAutostart, template } = req.body;
    const { purchaseMode, canBuyCharges, canBuyMaxCharges } = normalizePurchaseMode(req.body);
    const mode = purchaseMode || (canBuyMaxCharges ? 'max' : (canBuyCharges ? 'normal' : 'none'));
    canBuyCharges    = (mode === 'normal' || mode === 'max');
    canBuyMaxCharges = (mode === 'max');
    manager.name = templateName;
    manager.coords = coords;
    manager.userIds = userIds;
    manager.canBuyCharges = canBuyCharges;
    manager.canBuyMaxCharges = canBuyMaxCharges;
    manager.antiGriefMode = antiGriefMode;
    manager.enableAutostart = enableAutostart;
    manager.purchaseMode    = purchaseMode;
    manager.canBuyCharges   = canBuyCharges;
    manager.canBuyMaxCharges= canBuyMaxCharges;

    if (template) {
        manager.template = template;
        manager.totalPixels = manager.template.data.flat().filter(p => p > 0).length;
    }
    manager.masterId = manager.userIds[0];
    manager.masterName = users[manager.masterId].name;
    saveTemplates();
    res.sendStatus(200);
});

app.put("/template/:id", async (req, res) => {
    const { id } = req.params;
    if (!id || !templates[id]) return res.sendStatus(400);
    const manager = templates[id];
    if (req.body.running && !manager.running) {
        manager.start().catch(error => log(id, manager.masterName, "Error starting template", error));
    } else {
        manager.running = false;
    }
    res.sendStatus(200);
});

app.get('/settings', (_, res) => {
    res.json({ ...currentSettings, proxyCount: loadedProxies.length });
});

app.put('/settings', (req, res) => {
    const oldSettings = { ...currentSettings };
    currentSettings = { ...currentSettings, ...req.body };
    saveSettings();
    if (oldSettings.chargeThreshold !== currentSettings.chargeThreshold) {
        for (const id in templates) {
            if (templates[id].running) templates[id].interruptSleep();
        }
    }
    res.sendStatus(200);
});

app.post('/reload-proxies', (req, res) => {
    loadProxies();
    res.status(200).json({ success: true, count: loadedProxies.length });
});

app.get("/canvas", async (req, res) => {
    const { tx, ty } = req.query;
    if (isNaN(parseInt(tx)) || isNaN(parseInt(ty))) return res.sendStatus(400);
    try {
        const url = `https://backend.wplace.live/files/s0/tiles/${tx}/${ty}.png`;
        const response = await fetch(url);
        if (!response.ok) return res.sendStatus(response.status);
        const buffer = Buffer.from(await response.arrayBuffer());
        res.json({ image: `data:image/png;base64,${buffer.toString('base64')}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Server Startup ---
(async () => {
    console.clear();
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    console.log(`\n--- wplacer v${version} by luluwaffless and jinx ---\n`);

    // Load Templates from templates.json
    const loadedTemplates = loadJSON("templates.json");

    // Loop through loaded templates and check validity
    for (const id in loadedTemplates) {
        const t = loadedTemplates[id];
        if (t.userIds.every(uid => users[uid])) {
            templates[id] = new TemplateManager(t.name, t.template, t.coords, t.canBuyCharges, t.canBuyMaxCharges, t.antiGriefMode, t.enableAutostart, t.userIds);

            // Check autostart flag
            if (t.enableAutostart) {
                templates[id].start().catch(error =>
                    log(id, templates[id].masterName, "Error starting autostarted template", error)
                );
                autostartedTemplates.push({ id, name: t.name });
            }
        } else {
            console.warn(`⚠️ Template "${t.name}" was not loaded because its assigned user(s) no longer exist.`);
        }
    }

    // Load proxies
    loadProxies();

    console.log(`✅ Loaded ${Object.keys(templates).length} templates, ${Object.keys(users).length} users and ${loadedProxies.length} proxies.`);

    const port = Number(process.env.PORT) || 3000;
    const host = "0.0.0.0";
    app.listen(port, host, (error) => {
        console.log(`✅ Server listening on http://localhost:${port}`);
        console.log(`   Open the web UI in your browser to start!`);
        if (error) {
            console.error("\n" + error);
        }
    });
})();
