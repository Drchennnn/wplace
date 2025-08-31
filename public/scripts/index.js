// elements
const $ = (id) => document.getElementById(id);
const main = $("main");
const openManageUsers = $("openManageUsers");
const openAddTemplate = $("openAddTemplate");
const openManageTemplates = $("openManageTemplates");
const openSettings = $("openSettings");
const userForm = $("userForm");
const scookie = $("scookie");
const jcookie = $("jcookie");
const submitUser = $("submitUser");
const manageUsers = $("manageUsers");
const manageUsersTitle = $("manageUsersTitle");
const userList = $("userList");
const checkUserStatus = $("checkUserStatus");
const addTemplate = $("addTemplate");
const convert = $("convert");
const details = $("details");
const size = $("size");
const ink = $("ink");
const premiumWarning = $("premiumWarning");
const templateCanvas = $("templateCanvas");
const previewCanvas = $("previewCanvas");
const previewCanvasButton = $("previewCanvasButton");
const previewBorder = $("previewBorder");
const templateForm = $("templateForm");
const templateFormTitle = $("templateFormTitle");
const convertInput = $("convertInput");
const templateName = $("templateName");
const tx = $("tx");
const ty = $("ty");
const px = $("px");
const py = $("py");
const userSelectList = $("userSelectList");
const selectAllUsers = $("selectAllUsers");
const BUILD = 'dbg1';
console.log('[index.js] build =', BUILD);

// === Realtime (SSE) + UI helpers (Final) ===
let __es = null;
let __esRetry = 1000;

// 兼容两种 charges 形态
function getChargeCount(u){
  return Number.isFinite(u?.charges) ? Math.floor(u.charges)
       : Number.isFinite(u?.charges?.count) ? Math.floor(u.charges.count)
       : null;
}
function getMaxCharges(u){
  return Number.isFinite(u?.maxCharges) ? u.maxCharges
       : Number.isFinite(u?.charges?.max) ? u.charges.max
       : null;
}
function getLevel(u){
  return Number.isFinite(u?.level) ? u.level
       : Number.isFinite(u?.stats?.level) ? u.stats.level
       : null;
}
function getDroplets(u){
  return Number.isFinite(u?.droplets) ? u.droplets
       : Number.isFinite(u?.wallet?.droplets) ? u.wallet.droplets
       : null;
}


// 从前端卡片的文字解析用户数值：Charges/Droplets
function parseUserStatsFromDOM(uid) {
    const statsEl = document.querySelector(`.user-card[data-user-id="${uid}"] .stats`);
    if (!statsEl) return { id: uid, cur: 0, max: 0, droplets: 0 };
  
    const text = statsEl.textContent || "";
  
    // Charges: cur / max
    let cur = 0, max = 0;
    const mCharges = text.match(/Charges:\s*(\d+)\s*\/\s*(\d+)/i);
    if (mCharges) { cur = parseInt(mCharges[1], 10) || 0; max = parseInt(mCharges[2], 10) || 0; }
  
    // Droplets: n
    let droplets = 0;
    const mDrops = text.match(/Droplets:\s*(\d+)/i);
    if (mDrops) droplets = parseInt(mDrops[1], 10) || 0;
  
    return { id: uid, cur, max, droplets };
  }
  
/** 在卡片显示 Cookie 到期信息 */
function renderCookieExpiry(card, jwtExpMs) {
  let badge = card.querySelector('.cookie-exp');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'cookie-exp';
    const info = card.querySelector('.user-info') || card;
    info.appendChild(badge);
  }
  if (!jwtExpMs) {
    badge.textContent = 'Cookie: 未知到期';
    badge.style.color = '';
    return;
  }
  const msLeft = Number(jwtExpMs) - Date.now();
  if (msLeft <= 0) {
    badge.textContent = 'Cookie: 已过期';
    badge.style.color = '#ff4d4f';
    return;
  }
  const days = Math.floor(msLeft / 86400000);
  const hours = Math.floor((msLeft % 86400000) / 3600000);
  badge.textContent = `Cookie: ~${days}天 ${hours}小时`;
  badge.style.color = (msLeft <= 3*86400000) ? '#ff4d4f'
                 : (msLeft <= 7*86400000) ? '#ffb020' : '';
}

/** 应用一次后端推送到某张用户卡 */
function applyUserUpdate(u) {
  if (!u || u.userId == null) return;
  const card = document.getElementById(`user-${u.userId}`);
  if (!card) return;

  const count = getChargeCount(u);
  const max   = getMaxCharges(u);
  const lvl   = getLevel(u);
  const drp   = getDroplets(u);

  const stats = card.querySelectorAll('.user-stats b'); // charges / max / level / droplets
  if (stats[0] && count != null) stats[0].textContent = count;
  if (stats[1] && max   != null) stats[1].textContent = max;
  if (stats[2] && lvl   != null) stats[2].textContent = Math.floor(lvl);
  if (stats[3] && drp   != null) stats[3].textContent = drp;

  const lp = card.querySelector('.level-progress');
  if (lp && Number.isFinite(lvl)) {
    lp.textContent = `(${Math.round((lvl % 1) * 100)}%)`;
  }

  // 封禁提示颜色
  const suspended = !!u.recentlySuspended || (u.suspendedUntil && Date.now() < Number(u.suspendedUntil));
  card.querySelectorAll('.user-info > span').forEach(span => {
    span.style.color = suspended ? 'var(--warning-color)' : 'var(--success-color)';
  });

  // Cookie 到期
  renderCookieExpiry(card, u.jwtExp);

  // 微小动画
  card.classList.add('pulse');
  setTimeout(() => card.classList.remove('pulse'), 400);
}

/** 建立/重连 SSE */
function attachUserRealtime() {
  if (__es) return;
  __es = new EventSource('/api/events');

  __es.addEventListener('hello', () => { __esRetry = 1000; });
  __es.addEventListener('user_update', (ev) => {
    try { applyUserUpdate(JSON.parse(ev.data)); } catch {}
  });

  __es.onerror = () => {
    try { __es.close(); } catch {}
    __es = null;
    setTimeout(attachUserRealtime, __esRetry);
    __esRetry = Math.min(__esRetry * 1.8, 10000);
  };

  window.addEventListener('beforeunload', () => { try { __es?.close(); } catch {} });
}

/** 批量 Cookie 同步（配合 Tampermonkey） */
async function openSyncWindow(userId, cbBase) {
  const url = `https://wplace.live/?syncTo=${encodeURIComponent(userId)}&cb=${encodeURIComponent(cbBase)}`;
  return window.open(url, '_blank', 'width=980,height=800');
}
function runBulkCookieSync(userIds) {
  if (!userIds || !userIds.length) return;
  const cbBase = location.origin;
  let idx = 0;

  const onMsg = (ev) => {
    if (ev?.data?.type === 'wplacer-sync-done') {
      idx++;
      if (idx < userIds.length) {
        setTimeout(() => openSyncWindow(userIds[idx], cbBase), 600);
      } else {
        window.removeEventListener('message', onMsg);
        alert('✅ 本组同步完成');
      }
    }
  };
  window.addEventListener('message', onMsg);
  openSyncWindow(userIds[0], cbBase);
}

/** 读取“已勾选”的用户 id（批量同步/分组用） */
function getSelectedUserIds() {
  return Array.from(document.querySelectorAll('.user-check:checked'))
    .map(el => el.dataset.userId);
}


function __renderUserList(list) {
    const container = document.getElementById('userSelectList');
    container.innerHTML = '';
    list.forEach((u, idx) => {
        const row = document.createElement('div');
        row.className = 'user-select-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = `user_${u.id}`;
        cb.name = 'user_checkbox';
        cb.value = u.id;
        cb.dataset.index = String(idx);

        cb.addEventListener('click', (e) => {
            if (!e.shiftKey || __lastCheckedIndex === null) {
                __lastCheckedIndex = idx;
                return;
            }
            const start = Math.min(__lastCheckedIndex, idx);
            const end = Math.max(__lastCheckedIndex, idx);
            const cbs = container.querySelectorAll('input[type="checkbox"]');
            for (let i=start;i<=end;i++) {
                cbs[i].checked = cb.checked;
            }
            __lastCheckedIndex = idx;
        });

        const label = document.createElement('label');
        label.htmlFor = `user_${u.id}`;
        label.textContent = `${u.name} (#${u.id})`;

        row.appendChild(cb);
        row.appendChild(label);
        container.appendChild(row);
    });
}

function __bindUserToolbar() {
    const filter = document.getElementById('userFilter');
    const btnAll = document.getElementById('btnAll');
    const btnNone = document.getElementById('btnNone');
    const btnInvert = document.getElementById('btnInvert');

    if (btnAll) btnAll.onclick = () => {
        document.querySelectorAll('#userSelectList input[type="checkbox"]').forEach(cb => cb.checked = true);
    };
    if (btnNone) btnNone.onclick = () => {
        document.querySelectorAll('#userSelectList input[type="checkbox"]').forEach(cb => cb.checked = false);
    };
    if (btnInvert) btnInvert.onclick = () => {
        document.querySelectorAll('#userSelectList input[type="checkbox"]').forEach(cb => cb.checked = !cb.checked);
    };
    if (filter) filter.oninput = (e) => {
        const q = (e.target.value || '').toLowerCase();
        const filtered = __allUsersCache.filter(u =>
            (u.name||'').toLowerCase().includes(q) ||
            String(u.id).toLowerCase().includes(q) ||
            (u.email||'').toLowerCase().includes(q)
        );
        __renderUserList(filtered);
    };
}

const pmNone   = $("pmNone");
const pmNormal = $("pmNormal");
const pmMax    = $("pmMax");
const antiGriefMode = $("antiGriefMode");
const enableAutostart = $("enableAutostart");
const submitTemplate = $("submitTemplate");
const manageTemplates = $("manageTemplates");
const templateList = $("templateList");
const startAll = $("startAll");
const stopAll = $("stopAll");
const settings = $("settings");
const drawingDirectionSelect = $("drawingDirectionSelect");
const drawingOrderSelect = $("drawingOrderSelect");
const pixelSkipSelect = $("pixelSkipSelect");
const outlineMode = $("outlineMode");
const skipPaintedPixels = $("skipPaintedPixels");
const accountCooldown = $("accountCooldown");
const purchaseCooldown = $("purchaseCooldown");
const accountCheckCooldown = $("accountCheckCooldown");
const dropletReserve = $("dropletReserve");
const antiGriefStandby = $("antiGriefStandby");
const chargeThreshold = $("chargeThreshold");
const totalCharges = $("totalCharges");
const totalMaxCharges = $("totalMaxCharges");
const messageBoxOverlay = $("messageBoxOverlay");
const messageBoxTitle = $("messageBoxTitle");
const messageBoxContent = $("messageBoxContent");
const messageBoxConfirm = $("messageBoxConfirm");
const messageBoxCancel = $("messageBoxCancel");
const proxyEnabled = $("proxyEnabled");
const proxyFormContainer = $("proxyFormContainer");
const proxyRotationMode = $("proxyRotationMode");
const proxyCount = $("proxyCount");
const reloadProxiesBtn = $("reloadProxiesBtn");
const logProxyUsage = $("logProxyUsage");

// --- Global State ---
let templateUpdateInterval = null;

// Message Box
let confirmCallback = null;

const showMessage = (title, content) => {
    messageBoxTitle.innerHTML = title;
    messageBoxContent.innerHTML = content;
    messageBoxCancel.classList.add('hidden');
    messageBoxConfirm.textContent = 'OK';
    messageBoxOverlay.classList.remove('hidden');
    confirmCallback = null;
};

const showConfirmation = (title, content, onConfirm) => {
    messageBoxTitle.innerHTML = title;
    messageBoxContent.innerHTML = content;
    messageBoxCancel.classList.remove('hidden');
    messageBoxConfirm.textContent = 'Confirm';
    messageBoxOverlay.classList.remove('hidden');
    confirmCallback = onConfirm;
};

const closeMessageBox = () => {
    messageBoxOverlay.classList.add('hidden');
    confirmCallback = null;
};

messageBoxConfirm.addEventListener('click', () => {
    if (confirmCallback) {
        confirmCallback();
    }
    closeMessageBox();
});

messageBoxCancel.addEventListener('click', () => {
    closeMessageBox();
});

const handleError = (error) => {
    console.error(error);
    let message = "An unknown error occurred. Check the console for details.";

    if (error.code === 'ERR_NETWORK') {
        message = "Could not connect to the server. Please ensure the bot is running and accessible.";
    } else if (error.response && error.response.data && error.response.data.error) {
        const errMsg = error.response.data.error;
        if (errMsg.includes("(1015)")) {
            message = "You are being rate-limited by the server. Please wait a moment before trying again.";
        } else if (errMsg.includes("(500)")) {
            message = "Authentication failed. The user's cookie may be expired or invalid. Please try adding the user again with a new cookie.";
        } else if (errMsg.includes("(502)")) {
            message = "The server reported a 'Bad Gateway' error. It might be temporarily down or restarting. Please try again in a few moments.";
        } else {
            message = errMsg;
        }
    }
    showMessage("Error", message);
};


// users
const loadUsers = async (f) => {
    try {
        const users = await axios.get("/users");
        if (f) f(users.data);
    } catch (error) {
        handleError(error);
    };
};
userForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const response = await axios.post('/user', { cookies: { s: scookie.value, j: jcookie.value } });
        if (response.status === 200) {
            showMessage("Success", `Logged in as ${response.data.name} (#${response.data.id})!`);
            userForm.reset();
            openManageUsers.click(); // Refresh the view
        }
    } catch (error) {
        handleError(error);
    };
});

// templates
const basic_colors = { "0,0,0": 1, "60,60,60": 2, "120,120,120": 3, "210,210,210": 4, "255,255,255": 5, "96,0,24": 6, "237,28,36": 7, "255,127,39": 8, "246,170,9": 9, "249,221,59": 10, "255,250,188": 11, "14,185,104": 12, "19,230,123": 13, "135,255,94": 14, "12,129,110": 15, "16,174,166": 16, "19,225,190": 17, "40,80,158": 18, "64,147,228": 19, "96,247,242": 20, "107,80,246": 21, "153,177,251": 22, "120,12,153": 23, "170,56,185": 24, "224,159,249": 25, "203,0,122": 26, "236,31,128": 27, "243,141,169": 28, "104,70,52": 29, "149,104,42": 30, "248,178,119": 31 };
const premium_colors = { "170,170,170": 32, "165,14,30": 33, "250,128,114": 34, "228,92,26": 35, "214,181,148": 36, "156,132,49": 37, "197,173,49": 38, "232,212,95": 39, "74,107,58": 40, "90,148,74": 41, "132,197,115": 42, "15,121,159": 43, "187,250,242": 44, "125,199,255": 45, "77,49,184": 46, "74,66,132": 47, "122,113,196": 48, "181,174,241": 49, "219,164,99": 50, "209,128,81": 51, "255,197,165": 52, "155,82,73": 53, "209,128,120": 54, "250,182,164": 55, "123,99,82": 56, "156,132,107": 57, "51,57,65": 58, "109,117,141": 59, "179,185,209": 60, "109,100,63": 61, "148,140,107": 62, "205,197,158": 63 };
const colors = { ...basic_colors, ...premium_colors };

const colorById = (id) => Object.keys(colors).find(key => colors[key] === id);
const closest = color => {
    const [tr, tg, tb] = color.split(',').map(Number);
    // Search all available colors (basic and premium)
    return Object.keys(colors).reduce((closestKey, currentKey) => {
        const [cr, cg, cb] = currentKey.split(',').map(Number);
        const [clR, clG, clB] = closestKey.split(',').map(Number);
        const currentDistance = Math.pow(tr - cr, 2) + Math.pow(tg - cg, 2) + Math.pow(tb - cb, 2);
        const closestDistance = Math.pow(tr - clR, 2) + Math.pow(tg - clG, 2) + Math.pow(tb - clB, 2);
        return currentDistance < closestDistance ? currentKey : closestKey;
    });
};

const drawTemplate = (template, canvas) => {
    canvas.width = template.width;
    canvas.height = template.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, template.width, template.height);
    const imageData = new ImageData(template.width, template.height);
    for (let x = 0; x < template.width; x++) {
        for (let y = 0; y < template.height; y++) {
            const color = template.data[x][y];
            if (color === 0) continue;
            const i = (y * template.width + x) * 4;
            if (color === -1) {
                imageData.data[i] = 158;
                imageData.data[i + 1] = 189;
                imageData.data[i + 2] = 255;
                imageData.data[i + 3] = 255;
                continue;
            };
            const [r, g, b] = colorById(color).split(',').map(Number);
            imageData.data[i] = r;
            imageData.data[i + 1] = g;
            imageData.data[i + 2] = b;
            imageData.data[i + 3] = 255;
        };
    };
    ctx.putImageData(imageData, 0, 0);
};
const loadTemplates = async (f) => {
    try {
        const templates = await axios.get("/templates");
        if (f) f(templates.data);
    } catch (error) {
        handleError(error);
    };
};
const fetchCanvas = async (txVal, tyVal, pxVal, pyVal, width, height) => {
    const TILE_SIZE = 1000;
    const radius = Math.max(0, parseInt(previewBorder.value, 10) || 0);

    const startX = txVal * TILE_SIZE + pxVal - radius;
    const startY = tyVal * TILE_SIZE + pyVal - radius;
    const displayWidth = width + (radius * 2);
    const displayHeight = height + (radius * 2);
    const endX = startX + displayWidth;
    const endY = startY + displayHeight;

    const startTileX = Math.floor(startX / TILE_SIZE);
    const startTileY = Math.floor(startY / TILE_SIZE);
    const endTileX = Math.floor((endX - 1) / TILE_SIZE);
    const endTileY = Math.floor((endY - 1) / TILE_SIZE);

    previewCanvas.width = displayWidth;
    previewCanvas.height = displayHeight;
    const ctx = previewCanvas.getContext('2d');
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    for (let txi = startTileX; txi <= endTileX; txi++) {
        for (let tyi = startTileY; tyi <= endTileY; tyi++) {
            try {
                const response = await axios.get('/canvas', { params: { tx: txi, ty: tyi } });
                const img = new Image();
                img.src = response.data.image;
                await img.decode();
                const sx = (txi === startTileX) ? startX - txi * TILE_SIZE : 0;
                const sy = (tyi === startTileY) ? startY - tyi * TILE_SIZE : 0;
                const ex = (txi === endTileX) ? endX - txi * TILE_SIZE : TILE_SIZE;
                const ey = (tyi === endTileY) ? endY - tyi * TILE_SIZE : TILE_SIZE;
                const sw = ex - sx;
                const sh = ey - sy;
                const dx = txi * TILE_SIZE + sx - startX;
                const dy = tyi * TILE_SIZE + sy - startY;
                ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
            } catch (error) {
                handleError(error);
                return;
            }
        }
    }

    const baseImage = ctx.getImageData(0, 0, displayWidth, displayHeight);
    const templateCtx = templateCanvas.getContext('2d');
    const templateImage = templateCtx.getImageData(0, 0, width, height);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(templateCanvas, radius, radius);
    ctx.globalAlpha = 1;
    const b = baseImage.data;
    const t = templateImage.data;
    for (let i = 0; i < t.length; i += 4) {
        // skip transparent template pixels
        if (t[i + 3] === 0) continue;

        const templateIdx = i / 4;
        const templateX = templateIdx % width;
        const templateY = Math.floor(templateIdx / width);
        const canvasX = templateX + radius;
        const canvasY = templateY + radius;
        const canvasIdx = (canvasY * displayWidth + canvasX) * 4;

        if (b[canvasIdx + 3] === 0) continue;

        ctx.fillStyle = 'rgba(255,0,0,0.8)';
        ctx.fillRect(canvasX, canvasY, 1, 1);
    }
    previewCanvas.style.display = 'block';
};

const nearestimgdecoder = (imageData, width, height) => {
    const d = imageData.data;
    const matrix = Array.from({ length: width }, () => Array(height).fill(0));
    let ink = 0;
    let hasPremium = false;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const a = d[i + 3];
            if (a === 255) {
                const r = d[i], g = d[i + 1], b = d[i + 2];
                const rgb = `${r},${g},${b}`;
                if (rgb == "158,189,255") {
                    matrix[x][y] = -1;
                } else {
                    const id = colors[rgb] || colors[closest(rgb)];
                    matrix[x][y] = id;
                    if (id >= 32) hasPremium = true;
                }
                ink++;
            } else {
                matrix[x][y] = 0;
            }
        }
    }
    return { matrix, ink, hasPremium };
};

let currentTemplate = { width: 0, height: 0, data: [] };

const processImageFile = (file, callback) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const image = new Image();
        image.src = e.target.result;
        image.onload = async () => {
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const { matrix, ink, hasPremium } = nearestimgdecoder(imageData, canvas.width, canvas.height);

            const template = {
                width: canvas.width,
                height: canvas.height,
                ink,
                data: matrix,
                hasPremium
            };

            canvas.remove();
            callback(template);
        };
    };
    reader.readAsDataURL(file);
};
const processEvent = () => {
    const file = convertInput.files[0];
    if (file) {
        templateName.value = file.name.replace(/\.[^/.]+$/, "");
        processImageFile(file, (template) => {
            currentTemplate = template;
            drawTemplate(template, templateCanvas);
            size.innerHTML = `${template.width}x${template.height}px`;
            ink.innerHTML = template.ink;
            if (template.hasPremium) {
                premiumWarning.innerHTML = "<b>Warning:</b> This template uses premium colors. Ensure your selected accounts have purchased them.";
                premiumWarning.style.display = "block";
            } else {
                premiumWarning.style.display = "none";
            }
            templateCanvas.style.display = 'block';
            previewCanvas.style.display = 'none';
            details.style.display = "block";
        });
    };
};
convertInput.addEventListener('change', processEvent);

previewCanvasButton.addEventListener('click', async () => {
    const txVal = parseInt(tx.value, 10);
    const tyVal = parseInt(ty.value, 10);
    const pxVal = parseInt(px.value, 10);
    const pyVal = parseInt(py.value, 10);
    if (isNaN(txVal) || isNaN(tyVal) || isNaN(pxVal) || isNaN(pyVal) || currentTemplate.width === 0) {
        showMessage("Error", "Please convert an image and enter valid coordinates before previewing.");
        return;
    }
    await fetchCanvas(txVal, tyVal, pxVal, pyVal, currentTemplate.width, currentTemplate.height);
});

function pastePinCoordinates(text) {
    const patterns = [
        /Tl X:\s*(\d+),\s*Tl Y:\s*(\d+),\s*Px X:\s*(\d+),\s*Px Y:\s*(\d+)/,
        /^\s*(\d+)[\s,;]+(\d+)[\s,;]+(\d+)[\s,;]+(\d+)\s*$/
    ];
    for (const p of patterns) {
        match = p.exec(text);
        if (match) {
            $("tx").value = match[1];
            $("ty").value = match[2];
            $("px").value = match[3];
            $("py").value = match[4];
            return true;
        }
    }
    return false;
}

document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text");
    if (text && pastePinCoordinates(text)) {
        e.preventDefault();
    }
});

function getPurchaseMode() {
    return document.querySelector('input[name="purchaseMode"]:checked')?.value || 'none';
  }
  function setPurchaseMode(mode) {
    (document.querySelector(`input[name="purchaseMode"][value="${mode}"]`) || pmNone).checked = true;
  }

const resetTemplateForm = () => {
    templateForm.reset();
    templateFormTitle.textContent = "Add Template";
    submitTemplate.innerHTML = '<img src="icons/addTemplate.svg">Add Template';
    delete templateForm.dataset.editId;
    details.style.display = "none";
    premiumWarning.style.display = "none";
    previewCanvas.style.display = 'none';
    currentTemplate = { width: 0, height: 0, data: [] };
};

templateForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const isEditMode = !!templateForm.dataset.editId;

    if (!isEditMode && (!currentTemplate || currentTemplate.width === 0)) {
        showMessage("Error", "Please convert an image before creating a template.");
        return;
    }
    const selectedUsers = Array.from(document.querySelectorAll('input[name="user_checkbox"]:checked')).map(cb => String(cb.value));
    if (selectedUsers.length === 0) {
        showMessage("Error", "Please select at least one user.");
        return;
    }

    const purchaseMode = getPurchaseMode(); // 'none' | 'normal' | 'max'

    const data = {
        templateName: templateName.value,
        coords: [tx.value, ty.value, px.value, py.value].map(Number),
        userIds: selectedUsers,
        purchaseMode,
        canBuyCharges:    purchaseMode === 'normal',
        canBuyMaxCharges: purchaseMode === 'max',
        antiGriefMode: antiGriefMode.checked,
        enableAutostart: enableAutostart.checked
    };

    if (currentTemplate && currentTemplate.width > 0) {
        data.template = currentTemplate;
    }

    try {
        if (isEditMode) {
            await axios.put(`/template/edit/${templateForm.dataset.editId}`, data);
            showMessage("Success", "Template updated!");
        } else {
            await axios.post('/template', data);
            showMessage("Success", "Template created!");
        }
        resetTemplateForm();
        openManageTemplates.click();
    } catch (error) {
        handleError(error);
    };
});
startAll.addEventListener('click', async () => {
    for (const child of templateList.children) {
        try {
            await axios.put(`/template/${child.id}`, { running: true });
        } catch (error) {
            handleError(error);
        };
    };
    showMessage("Success", "Finished! Check console for details.");
    openManageTemplates.click();
});
stopAll.addEventListener('click', async () => {
    for (const child of templateList.children) {
        try {
            await axios.put(`/template/${child.id}`, { running: false });
        } catch (error) {
            handleError(error);
        };
    };
    showMessage("Success", "Finished! Check console for details.");
    openManageTemplates.click();
});


// tabs
let currentTab = main;
const changeTab = (el) => {
  if (templateUpdateInterval) {
    clearInterval(templateUpdateInterval);
    templateUpdateInterval = null;
  }
  currentTab.style.display = "none";
  el.style.display = "block";
  currentTab = el;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

openManageUsers.addEventListener("click", () => {
  userList.innerHTML = "";
  userForm.reset();
  totalCharges.textContent = "?";
  totalMaxCharges.textContent = "?";

  loadUsers(users => {
    const userCount = Object.keys(users).length;
    manageUsersTitle.textContent = `Existing Users (${userCount})`;

    for (const id of Object.keys(users)) {
      const user = document.createElement('div');
      user.className = 'user';
      user.id = `user-${id}`;

      user.innerHTML = `
        <div class="user-info">
          <!-- 勾选框：用于“批量同步（已选）/设置分组” -->
          <input type="checkbox" class="user-check" data-user-id="${id}" title="选择该用户" style="margin-right:6px;">

          <!-- 用户名与ID -->
          <span class="user-name">${users[id].name}</span>
          <span class="user-id">(#${id})</span>

          <!-- Cookie 到期显示（初始占位；SSE 到来后由 applyUserUpdate/renderCookieExpiry 覆盖） -->
          <div class="cookie-exp" style="margin-top:4px; font-size:12px; opacity:.9;">Cookie: 未知到期</div>

          <!-- 统计信息：SSE 到来后由 applyUserUpdate() 更新数字 -->
          <div class="user-stats" style="margin-top:4px;">
            Charges: <b>?</b>/<b>?</b> | Level <b>?</b> <span class="level-progress">(?%)</span><br>
            Droplets: <b>?</b>
          </div>
        </div>

        <div class="user-actions">
          <button class="delete-btn" title="Delete User"><img src="icons/remove.svg"></button>
          <button class="info-btn" title="Get User Info"><img src="icons/code.svg"></button>
        </div>
      `;

      // 删号
      user.querySelector('.delete-btn').addEventListener("click", () => {
        showConfirmation(
          "Delete User",
          `Are you sure you want to delete ${users[id].name} (#${id})? This will also remove them from all templates.`,
          async () => {
            try {
              await axios.delete(`/user/${id}`);
              showMessage("Success", "User deleted.");
              openManageUsers.click();
            } catch (error) {
              handleError(error);
            }
          }
        );
      });

      // 查看详情
      user.querySelector('.info-btn').addEventListener("click", async () => {
        try {
          const response = await axios.get(`/user/status/${id}`);
          const info = `
            <b>User Name:</b> <span style="color: #f97a1f;">${response.data.name}</span><br>
            <b>Charges:</b> <span style="color: #f97a1f;">${Math.floor(response.data.charges.count)}</span>/<span style="color: #f97a1f;">${response.data.charges.max}</span><br>
            <b>Droplets:</b> <span style="color: #f97a1f;">${response.data.droplets}</span><br>
            <b>Favorite Locations:</b> <span style="color: #f97a1f;">${response.data.favoriteLocations.length}</span>/<span style="color: #f97a1f;">${response.data.maxFavoriteLocations}</span><br>
            <b>Flag Equipped:</b> <span style="color: #f97a1f;">${response.data.equippedFlag ? "Yes" : "No"}</span><br>
            <b>Discord:</b> <span style="color: #f97a1f;">${response.data.discord}</span><br>
            <b>Country:</b> <span style="color: #f97a1f;">${response.data.country}</span><br>
            <b>Pixels Painted:</b> <span style="color: #f97a1f;">${response.data.pixelsPainted}</span><br>
            <b>Extra Colors:</b> <span style="color: #f97a1f;">${response.data.extraColorsBitmap}</span><br>
            <b>Alliance ID:</b> <span style="color: #f97a1f;">${response.data.allianceId}</span><br>
            <b>Alliance Role:</b> <span style="color: #f97a1f;">${response.data.allianceRole}</span><br>
            <br>Would you like to copy the <b>Raw Json</b> to your clipboard?
          `;
          showConfirmation("User Info", info, () => {
            navigator.clipboard.writeText(JSON.stringify(response.data, null, 2));
          });
        } catch (error) {
          handleError(error);
        }
      });

      userList.appendChild(user);
    } // end for
  }); // end loadUsers

  // === 实时（SSE）
  attachUserRealtime();

  // === 绑定批量工具（只绑定一次）
  bindBulkToolsOnce();

  // 切换到 ManageUsers 页
  changeTab(manageUsers);
});


// ================== 下面是本段用到的小工具（若全局已有相同函数可忽略） ==================


// 只绑定一次，避免重复监听
function bindBulkToolsOnce() {
  if (window.__bulkToolsBound) return;
  window.__bulkToolsBound = true;

  const bulkSyncSelectedBtn = document.getElementById('bulkSyncSelectedBtn');
  const bulkSyncGroupBtn    = document.getElementById('bulkSyncGroupBtn');
  const assignGroupBtn      = document.getElementById('assignGroupBtn');
  const groupSelect         = document.getElementById('groupSelect');

  if (!bulkSyncSelectedBtn || !bulkSyncGroupBtn || !assignGroupBtn || !groupSelect) {
    console.warn('[BulkTools] 控件未找到（检查 index.html 的 id 是否匹配）');
    return;
  }

  function getSelectedUserIds() {
    return Array.from(document.querySelectorAll('.user-check:checked'))
      .map(el => el.dataset.userId);
  }

  async function refreshGroupSelect() {
    try {
      const users = await axios.get('/users').then(r => r.data);
      const set = new Set();
      Object.values(users).forEach(u => u?.group && set.add(u.group));
      const cur = groupSelect.value || '';
      groupSelect.innerHTML = `<option value="">— Group —</option>` +
        Array.from(set).sort().map(g => `<option value="${g}">${g}</option>`).join('');
      groupSelect.value = cur;
    } catch (e) {
      console.error('[BulkTools] 刷新分组失败：', e);
    }
  }

  // 设置分组（选中）
  assignGroupBtn.addEventListener('click', async () => {
    const ids = getSelectedUserIds();
    if (!ids.length) return alert('请先在卡片上勾选用户');
    const group = prompt('输入分组名（如：mainA；留空清除分组）', '');
    if (group === null) return;
    try {
      const res = await axios.post('/users/group-bulk', { ids, group: group.trim() || null });
      if (!res.data?.ok) throw new Error('后端返回失败');
      // 卡片上的分组标签（你如果有 .user-group 就更新它；没有可忽略）
      ids.forEach(id => {
        const card = document.getElementById(`user-${id}`);
        const tag = card?.querySelector('.user-group');
        if (tag) tag.textContent = group ? ` [${group}]` : '';
      });
      await refreshGroupSelect();
      alert('分组已更新');
    } catch (e) {
      console.error('[BulkTools] 设置分组失败：', e);
      alert('设置分组失败，请查看控制台日志');
    }
  });

  // 批量同步（已选）
  bulkSyncSelectedBtn.addEventListener('click', async () => {
    const ids = getSelectedUserIds();
    if (!ids.length) return alert('请先在卡片上勾选用户');
    if (!confirm(`将依次同步 ${ids.length} 个账号的 Cookie。\n弹窗内请切换到指定小号，脚本会自动上传并关闭。`)) return;
    runBulkCookieSync(ids);
  });

// 批量同步（分组） —— 走 fetch/axios 后端，无弹窗
bulkSyncGroupBtn.addEventListener('click', async () => {
    const g = groupSelect?.value || '';
    if (!g) return alert('请先选择一个分组');
    try {
      const users = await axios.get('/users').then(r => r.data);
      const ids = Object.entries(users).filter(([id, u]) => u.group === g).map(([id]) => id);
      if (!ids.length) return alert('该分组下没有用户');
      if (!confirm(`将为分组 [${g}] 的 ${ids.length} 个账号进行同步。\n（无需弹窗登录，小号由后端用保存的cookie/token执行）`)) return;
  
      // UI 状态
      const old = bulkSyncGroupBtn.innerText;
      bulkSyncGroupBtn.disabled = true;
      bulkSyncGroupBtn.innerText = '分组同步中…';
  
      // ✅ 关键改动：直接调用你自己的后端 API（自行替换为你的真实路径）
      const resp = await axios.post('/api/bulkSyncGroup', {
        groupId: g,
        userIds: ids
      }, { withCredentials: true });
  
      console.log('[BulkTools] bulkSyncGroup result:', resp.data);
      alert(`已提交分组同步：${resp.data.count ?? ids.length} 个账号`);
    } catch (e) {
      console.error('[BulkTools] 分组同步失败：', e);
      alert(`分组同步失败：${e?.response?.data?.error || e.message}`);
    } finally {
      bulkSyncGroupBtn.disabled = false;
      bulkSyncGroupBtn.innerText = '批量同步（分组）';
    }
  });
  

  refreshGroupSelect();
  console.log('[BulkTools] 已绑定');
}

// 打开目标站点窗口（配合 Tampermonkey 等你切号后自动上报）
function openSyncWindow(userId, cbBase) {
    const url = `https://wplace.live/?syncTo=${encodeURIComponent(userId)}&cb=${encodeURIComponent(cbBase)}`;
    return window.open(url, '_blank', 'width=980,height=800');
  }
  

// 顺序跑一组
function runBulkCookieSync(userIds) {
  if (!userIds || !userIds.length) return;
  const cbBase = location.origin;
  let idx = 0;

  function next() {
    if (idx >= userIds.length) {
      alert('✅ 本组同步完成');
      window.removeEventListener('message', onMsg);
      return;
    }
    openSyncWindow(userIds[idx], cbBase);
  }

  function onMsg(ev) {
    if (ev?.data?.type === 'wplacer-sync-done') {
      idx++;
      setTimeout(next, 600); // 给站点/脚本一点缓冲
    }
  }

  window.addEventListener('message', onMsg);
  next();
}


checkUserStatus.addEventListener("click", async () => {
    checkUserStatus.disabled = true;
    checkUserStatus.innerHTML = "Checking...";
    const userElements = Array.from(document.querySelectorAll('.user'));
        // === 批量同步：选中 / 分组 ===
    const bulkSyncSelectedBtn = document.getElementById('bulkSyncSelectedBtn');
    const bulkSyncGroupBtn = document.getElementById('bulkSyncGroupBtn');
    const groupSelect = document.getElementById('groupSelect');

    if (bulkSyncSelectedBtn) {
    bulkSyncSelectedBtn.addEventListener('click', async () => {
        const ids = getSelectedUserIds();
        if (!ids.length) return alert('请先在卡片上勾选用户');
        if (!confirm(`将依次同步 ${ids.length} 个账号的 Cookie。\n弹窗内请切换到指定小号，脚本会自动上传并关闭。`)) return;
        runBulkCookieSync(ids);
    });
    }

    if (bulkSyncGroupBtn) {
    bulkSyncGroupBtn.addEventListener('click', async () => {
        const g = groupSelect?.value || '';
        if (!g) return alert('请先选择一个分组');
        const users = await axios.get('/users').then(r=>r.data);
        const ids = Object.entries(users).filter(([id,u]) => u.group === g).map(([id])=>id);
        if (!ids.length) return alert('该分组下没有用户');
        if (!confirm(`将为分组 [${g}] 的 ${ids.length} 个账号进行同步。\n请先在浏览器登录该分组的“主号”，再点击确定开始。`)) return;
        runBulkCookieSync(ids);
    });
    }

    // 初始化分组下拉（从后端已有 users 里收集）
    async function refreshGroupSelect() {
    const users = await axios.get('/users').then(r=>r.data).catch(()=>({}));
    const set = new Set();
    Object.values(users).forEach(u => u?.group && set.add(u.group));
    if (!groupSelect) return;
    const cur = groupSelect.value || '';
    groupSelect.innerHTML = `<option value="">— Group —</option>` + Array.from(set).sort().map(g => `<option value="${g}">${g}</option>`).join('');
    groupSelect.value = cur;
    }
    refreshGroupSelect();

    // Set all users to "checking" state
    userElements.forEach(userEl => {
        const infoSpans = userEl.querySelectorAll('.user-info > span');
        infoSpans.forEach(span => span.style.color = 'var(--warning-color)');
    });

    let totalCurrent = 0;
    let totalMax = 0;

    try {
        const response = await axios.post('/users/status');
        const statuses = response.data;

        for (const userEl of userElements) {
            const id = userEl.id.split('-')[1];
            const status = statuses[id];

            const infoSpans = userEl.querySelectorAll('.user-info > span');
            const currentChargesEl = userEl.querySelector('.user-stats b:nth-of-type(1)');
            const maxChargesEl = userEl.querySelector('.user-stats b:nth-of-type(2)');
            const currentLevelEl = userEl.querySelector('.user-stats b:nth-of-type(3)');
            const dropletsEl = userEl.querySelector('.user-stats b:nth-of-type(4)');
            const levelProgressEl = userEl.querySelector('.level-progress');

            if (status && status.success) {
                const userInfo = status.data;
                const charges = Math.floor(userInfo.charges.count);
                const max = userInfo.charges.max;
                const level = Math.floor(userInfo.level);
                const progress = Math.round((userInfo.level % 1) * 100);

                currentChargesEl.textContent = charges;
                maxChargesEl.textContent = max;
                currentLevelEl.textContent = level;
                dropletsEl.textContent = userInfo.droplets;
                levelProgressEl.textContent = `(${progress}%)`;
                totalCurrent += charges;
                totalMax += max;

                infoSpans.forEach(span => span.style.color = 'var(--success-color)');
            } else {
                currentChargesEl.textContent = "ERR";
                maxChargesEl.textContent = "ERR";
                currentLevelEl.textContent = "?";
                dropletsEl.textContent = "ERR";
                levelProgressEl.textContent = "(?%)";
                infoSpans.forEach(span => span.style.color = 'var(--error-color)');
            }
        }
    } catch (error) {
        handleError(error);
        // On general error, mark all as failed
        userElements.forEach(userEl => {
            const infoSpans = userEl.querySelectorAll('.user-info > span');
            infoSpans.forEach(span => span.style.color = 'var(--error-color)');
        });
    }

    totalCharges.textContent = totalCurrent;
    totalMaxCharges.textContent = totalMax;

    checkUserStatus.disabled = false;
    checkUserStatus.innerHTML = '<img src="icons/check.svg">Check Account Status';
});

openAddTemplate.addEventListener("click", () => {
    resetTemplateForm();
    userSelectList.innerHTML = "";
    loadUsers(users => {
        if (Object.keys(users).length === 0) {
            userSelectList.innerHTML = "<span>No users added. Please add a user first.</span>";
            return;
        }
        
__allUsersCache = Object.keys(users).map(id => ({
    id,
    name: users[id].name || 'Unknown',
    email: users[id].email || ''
}));
__renderUserList(__allUsersCache);
__bindUserToolbar();
});
    changeTab(addTemplate);
});
selectAllUsers.addEventListener('click', () => {
    const btn = document.getElementById('btnAll'); if (btn) btn.click();
});

const createToggleButton = (template, id, buttonsContainer, progressBarText, currentPercent) => {
    const button = document.createElement('button');
    const isRunning = template.running;

    button.className = isRunning ? 'destructive-button' : 'primary-button';
    button.innerHTML = `<img src="icons/${isRunning ? 'pause' : 'play'}.svg">${isRunning ? 'Stop' : 'Start'} Template`;

    button.addEventListener('click', async () => {
        try {
            await axios.put(`/template/${id}`, { running: !isRunning });
            template.running = !isRunning;
            const newStatus = !isRunning ? 'Started' : 'Stopped';
            const newButton = createToggleButton(template, id, buttonsContainer, progressBarText, currentPercent);
            button.replaceWith(newButton);
            progressBarText.textContent = `${currentPercent}% | ${newStatus}`;
            const progressBar = progressBarText.previousElementSibling;
            progressBar.classList.toggle('stopped', !isRunning);

        } catch (error) {
            handleError(error);
        }
    });
    return button;
};

// —— 可替换原函数：带 ETA —— //
// —— 覆盖原函数：仅用 DOM 解析 + ETA —— //
const updateTemplateStatus = async () => {
    try {
      const { data: templates } = await axios.get("/templates");
  
      for (const id in templates) {
        const t = templates[id];
        const templateElement = $(id);
        if (!templateElement) continue;
  
        const total = t.totalPixels || 1;
        const remaining = (t.pixelsRemaining != null ? t.pixelsRemaining : total);
        const completed = Math.max(0, total - remaining);
        const percent = Math.floor((completed / total) * 100);
  
        const progressBar     = templateElement.querySelector(".progress-bar");
        const progressBarText = templateElement.querySelector(".progress-bar-text");
        const pixelCount      = templateElement.querySelector(".pixel-count");
  
        if (progressBar)     progressBar.style.width = `${percent}%`;
        if (progressBarText) progressBarText.textContent = `${percent}% | ${t.status}`;
        if (pixelCount)      pixelCount.textContent = `${completed} / ${total}`;
  
        if (progressBar) {
          if (t.status === "Finished.") {
            progressBar.classList.add("finished");
            progressBar.classList.remove("stopped");
          } else if (!t.running) {
            progressBar.classList.add("stopped");
            progressBar.classList.remove("finished");
          } else {
            progressBar.classList.remove("stopped", "finished");
          }
        }
  
        // —— 新增：从 DOM 解析账号数值，计算 ETA —— //
        // 若后端提供 t.userIds 就用它；否则退化为“页面上所有 .user-card”
        const userIds = Array.isArray(t.userIds) && t.userIds.length
          ? t.userIds
          : Array.from(document.querySelectorAll(".user-card"))
              .map(el => el.getAttribute("data-user-id"))
              .filter(Boolean);
  
        const accounts = userIds.map(uid => parseUserStatsFromDOM(uid));
  
        if (window.ProgressETA) {
          window.ProgressETA.update(
            templateElement,
            accounts,
            completed,
            total,
            {
              rechargePerSec: 1 / 30,  // 每号 120 点/小时
              boostPerBuy: 30,
              boostCostDroplets: 1,
              spendAllDroplets: true
            }
          );
        }
      }
    } catch (error) {
      console.error("Failed to update template statuses:", error);
    }
  };
  

openManageTemplates.addEventListener("click", () => {
    templateList.innerHTML = "";
    if (templateUpdateInterval) clearInterval(templateUpdateInterval);

    loadUsers(users => {
        loadTemplates(templates => {
            for (const id of Object.keys(templates)) {
                const t = templates[id];
                const userListFormatted = t.userIds.map(userId => {
                    const user = users[userId];
                    return user ? `${user.name}#${userId}` : `Unknown#${userId}`;
                }).join(", ");

                const template = document.createElement('div');
                template.id = id;
                template.className = "template";

                const total = t.totalPixels || 1;
                const remaining = t.pixelsRemaining !== null ? t.pixelsRemaining : total;
                const completed = total - remaining;
                const percent = Math.floor((completed / total) * 100);

                const infoSpan = document.createElement('span');
                infoSpan.innerHTML = `<b>Template Name:</b> ${t.name}<br><b>Assigned Accounts:</b> ${userListFormatted}<br><b>Coordinates:</b> ${t.coords.join(", ")}<br><b>Pixels:</b> <span class="pixel-count">${completed} / ${total}</span>`;
                template.appendChild(infoSpan);

                const progressBarContainer = document.createElement('div');
                progressBarContainer.className = 'progress-bar-container';

                const progressBar = document.createElement('div');
                progressBar.className = 'progress-bar';
                progressBar.style.width = `${percent}%`;

                const progressBarText = document.createElement('span');
                progressBarText.className = 'progress-bar-text';
                progressBarText.textContent = `${percent}% | ${t.status}`;

                if (t.status === "Finished.") {
                    progressBar.classList.add('finished');
                } else if (!t.running) {
                    progressBar.classList.add('stopped');
                }

                progressBarContainer.appendChild(progressBar);
                progressBarContainer.appendChild(progressBarText);
                template.appendChild(progressBarContainer);

                const canvas = document.createElement("canvas");
                drawTemplate(t.template, canvas);
                const buttons = document.createElement('div');
                buttons.className = "template-actions";

                const toggleButton = createToggleButton(t, id, buttons, progressBarText, percent);
                buttons.appendChild(toggleButton);

                const editButton = document.createElement('button');
                editButton.className = 'secondary-button';
                editButton.innerHTML = '<img src="icons/settings.svg">Edit Template';
                editButton.addEventListener('click', () => {
                    openAddTemplate.click();

                    templateFormTitle.textContent = `Edit Template: ${t.name}`;
                    submitTemplate.innerHTML = '<img src="icons/edit.svg">Save Changes';
                    templateForm.dataset.editId = id;

                    templateName.value = t.name;
                    [tx.value, ty.value, px.value, py.value] = t.coords;
                    // ✅ 新：用单选枚举回填（优先用 t.purchaseMode，兼容老字段）
                    const mode = t.purchaseMode
                    ? t.purchaseMode                                  // 'none' | 'normal' | 'max'
                    : (t.canBuyMaxCharges ? 'max'
                        : (t.canBuyCharges ? 'normal' : 'none'));
                    setPurchaseMode(mode);                              // ← 你已实现的工具函数

                    antiGriefMode.checked = t.antiGriefMode;
                    enableAutostart.checked = t.enableAutostart;

                    // Wait for DOM to update, then check appropriate users
                    setTimeout(() => {
                        document.querySelectorAll('input[name="user_checkbox"]').forEach(cb => {
                            cb.checked = t.userIds.map(String).includes(cb.value);
                        });
                    }, 100);
                });

                const delButton = document.createElement('button');
                delButton.className = 'destructive-button';
                delButton.innerHTML = '<img src="icons/remove.svg">Delete Template';
                delButton.addEventListener("click", () => {
                    showConfirmation(
                        "Delete Template",
                        `Are you sure you want to delete template "${t.name}"?`,
                        async () => {
                            try {
                                await axios.delete(`/template/${id}`);
                                openManageTemplates.click();
                            } catch (error) {
                                handleError(error);
                            };
                        }
                    );
                });
                buttons.append(editButton);
                buttons.append(delButton);
                template.append(canvas);
                template.append(buttons);
                templateList.append(template);
            };
            templateUpdateInterval = setInterval(updateTemplateStatus, 2000);
        });
    });
    changeTab(manageTemplates);
});
openSettings.addEventListener("click", async () => {
    try {
        const response = await axios.get('/settings');
        const currentSettings = response.data;
        drawingDirectionSelect.value = currentSettings.drawingDirection;
        drawingOrderSelect.value = currentSettings.drawingOrder;
        pixelSkipSelect.value = currentSettings.pixelSkip;
        outlineMode.checked = currentSettings.outlineMode;
        skipPaintedPixels.checked = currentSettings.skipPaintedPixels;

        proxyEnabled.checked = currentSettings.proxyEnabled;
        proxyRotationMode.value = currentSettings.proxyRotationMode || 'sequential';
        logProxyUsage.checked = currentSettings.logProxyUsage;
        proxyCount.textContent = `${currentSettings.proxyCount} proxies loaded from file.`;
        proxyFormContainer.style.display = proxyEnabled.checked ? 'block' : 'none';

        accountCooldown.value = currentSettings.accountCooldown / 1000;
        purchaseCooldown.value = currentSettings.purchaseCooldown / 1000;
        accountCheckCooldown.value = currentSettings.accountCheckCooldown / 1000;
        dropletReserve.value = currentSettings.dropletReserve;
        antiGriefStandby.value = currentSettings.antiGriefStandby / 60000;
        chargeThreshold.value = currentSettings.chargeThreshold * 100;
    } catch (error) {
        handleError(error);
    }
    changeTab(settings);
});

// Settings
const saveSetting = async (setting) => {
    try {
        await axios.put('/settings', setting);
        showMessage("Success", "Setting saved!");
    } catch (error) {
        handleError(error);
    }
};

drawingDirectionSelect.addEventListener('change', () => saveSetting({ drawingDirection: drawingDirectionSelect.value }));
drawingOrderSelect.addEventListener('change', () => saveSetting({ drawingOrder: drawingOrderSelect.value }));
pixelSkipSelect.addEventListener('change', () => saveSetting({ pixelSkip: parseInt(pixelSkipSelect.value, 10) }));
outlineMode.addEventListener('change', () => saveSetting({ outlineMode: outlineMode.checked }));
skipPaintedPixels.addEventListener('change', () => saveSetting({ skipPaintedPixels: skipPaintedPixels.checked }));

proxyEnabled.addEventListener('change', () => {
    proxyFormContainer.style.display = proxyEnabled.checked ? 'block' : 'none';
    saveSetting({ proxyEnabled: proxyEnabled.checked });
});

logProxyUsage.addEventListener('change', () => {
    saveSetting({ logProxyUsage: logProxyUsage.checked });
});

proxyRotationMode.addEventListener('change', () => {
    saveSetting({ proxyRotationMode: proxyRotationMode.value });
});

reloadProxiesBtn.addEventListener('click', async () => {
    try {
        const response = await axios.post('/reload-proxies');
        if (response.data.success) {
            proxyCount.textContent = `${response.data.count} proxies reloaded from file.`;
            showMessage("Success", "Proxies reloaded successfully!");
        }
    } catch (error) {
        handleError(error);
    }
});

accountCooldown.addEventListener('change', () => {
    const value = parseInt(accountCooldown.value, 10) * 1000;
    if (isNaN(value) || value < 0) {
        showMessage("Error", "Please enter a valid non-negative number.");
        return;
    }
    saveSetting({ accountCooldown: value });
});

purchaseCooldown.addEventListener('change', () => {
    const value = parseInt(purchaseCooldown.value, 10) * 1000;
    if (isNaN(value) || value < 0) {
        showMessage("Error", "Please enter a valid non-negative number.");
        return;
    }
    saveSetting({ purchaseCooldown: value });
});

accountCheckCooldown.addEventListener('change', () => {
    const value = parseInt(accountCheckCooldown.value, 10) * 1000;
    if (isNaN(value) || value < 0) {
        showMessage("Error", "Please enter a valid non-negative number.");
        return;
    }
    saveSetting({ accountCheckCooldown: value });
});

dropletReserve.addEventListener('change', () => {
    const value = parseInt(dropletReserve.value, 10);
    if (isNaN(value) || value < 0) {
        showMessage("Error", "Please enter a valid non-negative number.");
        return;
    }
    saveSetting({ dropletReserve: value });
});

antiGriefStandby.addEventListener('change', () => {
    const value = parseInt(antiGriefStandby.value, 10) * 60000;
    if (isNaN(value) || value < 60000) {
        showMessage("Error", "Please enter a valid number (at least 1 minute).");
        return;
    }
    saveSetting({ antiGriefStandby: value });
});

chargeThreshold.addEventListener('change', () => {
    const value = parseInt(chargeThreshold.value, 10);
    if (isNaN(value) || value < 0 || value > 100) {
        showMessage("Error", "Please enter a valid percentage between 0 and 100.");
        return;
    }
    saveSetting({ chargeThreshold: value / 100 });
});

tx.addEventListener('blur', () => {
    const value = tx.value.trim();
    const urlRegex = /pixel\/(\d+)\/(\d+)\?x=(\d+)&y=(\d+)/;
    const urlMatch = value.match(urlRegex);

    if (urlMatch) {
        tx.value = urlMatch[1];
        ty.value = urlMatch[2];
        px.value = urlMatch[3];
        py.value = urlMatch[4];
    } else {
        const parts = value.split(/\s+/);
        if (parts.length === 4) {
            tx.value = parts[0].replace(/[^0-9]/g, '');
            ty.value = parts[1].replace(/[^0-9]/g, '');
            px.value = parts[2].replace(/[^0-9]/g, '');
            py.value = parts[3].replace(/[^0-9]/g, '');
        } else {
            tx.value = value.replace(/[^0-9]/g, '');
        }
    }
});

[ty, px, py].forEach(input => {
    input.addEventListener('blur', () => {
        input.value = input.value.replace(/[^0-9]/g, '');
    });
});