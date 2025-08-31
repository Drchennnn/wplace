// scripts/progress-eta.js

(function () {
    // —— 1) 持续运行 ETA（只考虑 +30） —— //
    function estimateETAContinuous(accounts, backlog, opts = {}) {
      const cfg = {
        rechargePerSec: 1 / 30,  // 每号每秒回 1/30 点 = 每小时 120
        boostPerBuy: 30,         // 一次 +30
        boostCostDroplets: 1,    // 1 滴 = 一次 +30（按你实际改）
        spendAllDroplets: true,  // 是否把“当下能花的滴”都花掉（并不超过各号上限）
        ...opts,
      };
  
      // 初始可用池：所有账号当前点数 + 立刻能买到的 +30（不溢出上限）
      const initialCur = accounts.reduce((s, a) => s + (a.cur || 0), 0);
  
      let boostTimes = 0;
      if (cfg.spendAllDroplets) {
        boostTimes = accounts.reduce((s, a) => {
          const timesByDroplets = Math.floor((a.droplets || 0) / cfg.boostCostDroplets);
          const roomTimes = Math.floor(Math.max(0, (a.max || 0) - (a.cur || 0)) / cfg.boostPerBuy);
          return s + Math.max(0, Math.min(timesByDroplets, roomTimes));
        }, 0);
      }
      const boostTotal = boostTimes * cfg.boostPerBuy;
      const initialPool = initialCur + boostTotal;
  
      // 持续产能（理论上限）：账号数 * 120 点/小时
      const capacityPerHour = accounts.length * (cfg.rechargePerSec * 3600);
  
      if (backlog <= initialPool) {
        return { etaHours: 0, capacityPerHour, initialPool, boostTotal };
      }
      const remain = backlog - initialPool;
      if (capacityPerHour <= 0) {
        return { etaHours: null, capacityPerHour: 0, initialPool, boostTotal };
      }
      const etaHours = remain / capacityPerHour;
      return { etaHours, capacityPerHour, initialPool, boostTotal };
    }
  
    // —— 2) 格式化 —— //
    function formatHours(h) {
      if (h == null) return "无法估算";
      const hrs = Math.floor(h);
      const mins = Math.round((h - hrs) * 60);
      if (hrs <= 0) return `${mins} 分钟`;
      return `${hrs} 小时 ${mins} 分钟`;
    }
  
    // —— 3) 在模板卡片节点下方渲染/更新 ETA —— //
    // node: 模板卡片根节点（包含你的进度条）
    // painted/total: 已完成/总像素
    // accounts: 该模板绑定的账号数组：[{id,max,cur,droplets}, ...]
    function update(node, accounts, painted, total, opts = {}) {
      if (!node) return;
      const backlog = Math.max(0, (total || 0) - (painted || 0));
  
      // 计算 ETA
      const res = estimateETAContinuous(accounts || [], backlog, opts);
  
      // 查找/创建 ETA 容器（放在进度条后面）
      // 你的进度条通常有一个 .progress 容器（index.js 动态生成）
      // 我们把 ETA 放在同一模板卡片内、紧贴在进度条后
      let etaEl = node.querySelector(".progress-eta");
      if (!etaEl) {
        etaEl = document.createElement("div");
        etaEl.className = "progress-eta";
        etaEl.style.marginTop = "6px";
        etaEl.style.fontSize = "12px";
        etaEl.style.opacity = "0.85";
        // 插入到进度条之后；找不到就追加到卡片末尾
        const progressEl = node.querySelector(".progress");
        if (progressEl && progressEl.parentNode) {
          progressEl.parentNode.insertBefore(etaEl, progressEl.nextSibling);
        } else {
          node.appendChild(etaEl);
        }
      }
  
      // 文案
      if (res.etaHours === 0) {
        etaEl.textContent =
          `预计剩余：< 1 分钟（启动可用：${res.initialPool}，+30 注入：${res.boostTotal}` +
          `，持续产能：${(res.capacityPerHour || 0).toFixed(0)} 点/小时）`;
      } else if (res.etaHours == null) {
        etaEl.textContent = `预计剩余：无法估算`;
      } else {
        etaEl.textContent =
          `预计剩余：${formatHours(res.etaHours)}（启动可用：${res.initialPool}` +
          `，+30 注入：${res.boostTotal}，持续产能：${(res.capacityPerHour || 0).toFixed(0)} 点/小时）`;
      }
    }
  
    // 对外暴露
    window.ProgressETA = {
      estimateETAContinuous,
      update,
    };
  })();
  