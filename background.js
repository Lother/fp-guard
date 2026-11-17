// 分站代理（proxy.js）
importScripts('proxy.js');
initProxyBackground();

// 以動態註冊的方式把 inject.js 放進頁面的 MAIN world，
// 設定（模式、各項開關）用 flags/*.js 這些只設旗標的小檔傳進去，改了不用重新安裝套件。
const DEFAULTS = {
  enabled: true,
  whitelist: [],
  mode: 'stealth',   // stealth（預設，偵測不到）| shuffle（類似 Brave，會被偵測到有雜訊）
  canvas: true,
  webgl: true,
  audio: true,
  text: true,
  gpu: true,         // 顯示卡型號換成同代常見型號
  cpu: true,         // 執行緒 / 記憶體超過 8 回報 8
  screen: 'auto',    // auto | off
  sw: false,         // Service Worker 保護（需要 debugger 權限）
  strictHosts: []
};
const SCRIPT_ID = 'fpg-inject';
const STRICT_ID = 'fpg-strict';
const MAX_STRICT = 2000;

let syncing = Promise.resolve();
function sync() {
  syncing = syncing.then(doSync, doSync);
  return syncing;
}

function flagFiles(cfg) {
  const files = [];
  if (cfg.mode === 'stealth') files.push('flags/stealth.js');
  for (const k of ['canvas', 'webgl', 'audio', 'text', 'gpu', 'cpu']) if (!cfg[k]) files.push(`flags/${k}-off.js`);
  if (cfg.screen === 'auto') files.push('flags/screen-auto.js');
  return files;
}

async function doSync() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((s) => s.id).filter((id) => id === SCRIPT_ID || id === STRICT_ID);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });

  chrome.action.setBadgeText({ text: cfg.enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  await syncServiceWorkerGuard(cfg);
  if (!cfg.enabled) return;

  const excludeMatches = [];
  for (const host of cfg.whitelist) {
    excludeMatches.push(`*://${host}/*`, `*://*.${host}/*`);
  }

  const scripts = [{
    id: SCRIPT_ID,
    matches: ['<all_urls>'],
    excludeMatches,
    js: [...flagFiles(cfg), 'inject.js'],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    world: 'MAIN',
    persistAcrossSessions: true
  }];

  // CSP 不允許 blob: Worker 的網站：放一個旗標，inject.js 就不包裝 http(s) Worker
  if (cfg.strictHosts.length) {
    scripts.push({
      id: STRICT_ID,
      matches: cfg.strictHosts.map((h) => `*://${h}/*`),
      js: ['flags/strict-csp.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: true
    });
  }

  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (e) {
    // 萬一某個主機名稱不是合法的比對樣式，至少讓主要保護生效
    console.warn('register failed, retrying without strict list', e);
    await chrome.scripting.registerContentScripts([scripts[0]]);
  }
}

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => k in DEFAULTS)) sync();
});

// ---------- 記錄 CSP 不允許 blob: 的網站 ----------

// 某個指令鏈（例如 worker-src → child-src → script-src → default-src）是否允許 blob:
function chainAllowsBlob(dirs, chain) {
  for (const d of chain) {
    if (d in dirs) return dirs[d].includes('blob:');
  }
  return true;
}

function policyBlocksBlob(policy) {
  const dirs = {};
  for (const part of policy.split(';')) {
    const tokens = part.trim().toLowerCase().split(/\s+/);
    if (!tokens[0] || tokens[0] in dirs) continue;
    dirs[tokens[0]] = tokens.slice(1);
  }
  return !chainAllowsBlob(dirs, ['worker-src', 'child-src', 'script-src', 'default-src']) ||
         !chainAllowsBlob(dirs, ['script-src-elem', 'script-src', 'default-src']);
}

let pending = new Set();
let flushTimer = 0;

chrome.webRequest.onHeadersReceived.addListener((details) => {
  let host;
  try {
    const u = new URL(details.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    host = u.hostname;
  } catch (_) { return; }

  // Report-Only 也算：雖然不會擋，但會把違規回報給網站，等於洩漏有裝套件
  const strict = (details.responseHeaders || []).some((h) => {
    const name = h.name.toLowerCase();
    return (name === 'content-security-policy' || name === 'content-security-policy-report-only') &&
           h.value && h.value.split(',').some(policyBlocksBlob);
  });
  if (!strict) return;

  pending.add(host);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    const add = [...pending];
    pending = new Set();
    const { strictHosts } = await chrome.storage.local.get({ strictHosts: [] });
    const set = new Set(strictHosts);
    const before = set.size;
    for (const h of add) set.add(h);
    if (set.size === before) return;
    await chrome.storage.local.set({ strictHosts: [...set].slice(-MAX_STRICT) });
  }, 200);
}, { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }, ['responseHeaders']);

// ---------- Service Worker 保護 ----------
// 擴充功能的 content script 進不了 Service Worker，網站也不能用 blob 註冊 Service Worker，
// 唯一能「搶在網站程式之前」動手的方法是 Chrome 偵錯協定：
// 對每個分頁開啟自動附加（只附加 Service Worker），Service Worker 一啟動就先暫停，
// 注入同一套保護程式後再讓它繼續執行。
// 代價：Chrome 會在視窗頂端顯示「指紋護盾 已開始對這個瀏覽器進行偵錯」的提示列。

const attachedTabs = new Set();
let coreSrc = null;
let swCfg = null;

async function getCore() {
  if (coreSrc) return coreSrc;
  const text = await (await fetch(chrome.runtime.getURL('inject.js'))).text();
  const START = '//@@FPG_CORE_START', END = '//@@FPG_CORE_END';
  coreSrc = text.slice(text.indexOf(START) + START.length, text.indexOf(END)).trim();
  return coreSrc;
}

async function swExpression() {
  const core = await getCore();
  const cfg = swCfg || DEFAULTS;
  const opts = {
    stealth: cfg.mode === 'stealth',
    canvas: cfg.canvas, webgl: cfg.webgl, audio: cfg.audio, text: cfg.text,
    gpu: cfg.gpu, cpu: cfg.cpu
  };
  const seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
  // strict = true：Service Worker 裡沒有 Worker 可以包，也避免任何 blob 動作
  return `(${core})(${seed}, ${JSON.stringify(opts)}, null, true);`;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname.replace(/^www\./, '') : null;
  } catch (_) { return null; }
}

function isWhitelisted(host) {
  const list = (swCfg && swCfg.whitelist) || [];
  return list.some((h) => host === h || host.endsWith('.' + h));
}

async function attachTab(tabId, url) {
  if (!swCfg || !swCfg.sw || !swCfg.enabled || attachedTabs.has(tabId)) return;
  const host = hostOf(url);
  if (!host || isWhitelisted(host)) return;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (_) {
    return; // 例如 chrome:// 頁面，或已經附加
  }
  attachedTabs.add(tabId);
  try {
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      // 一般 Worker 也會被「啟動時暫停」波及，所以一併附加，收到後立刻放行
      filter: [{ type: 'service_worker' }, { type: 'worker' }, { type: 'shared_worker' }, { exclude: true }]
    });
  } catch (e) {
    console.warn('setAutoAttach failed', e);
  }
}

async function detachAll() {
  for (const tabId of [...attachedTabs]) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    attachedTabs.delete(tabId);
  }
}

async function syncServiceWorkerGuard(cfg) {
  swCfg = cfg;
  const has = !!chrome.debugger;
  if (!has || !cfg.sw || !cfg.enabled) { if (has) await detachAll(); return; }
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.url) attachTab(t.id, t.url);
}

const swPending = new Map(); // `${tabId}|${sessionId}` -> instrumentation breakpointId
const swLog = [];
function log(x) { swLog.push(x); if (swLog.length > 50) swLog.shift(); }
self.__fpgSwLog = swLog;

async function cmd(session, method, params) {
  return chrome.debugger.sendCommand(session, method, params || {});
}

async function injectNow(session) {
  const r = await cmd(session, 'Runtime.evaluate', { expression: await swExpression(), silent: true });
  log('inject ' + (r && r.exceptionDetails ? 'error ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : 'ok'));
}

if (chrome.debugger) {
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method === 'Target.attachedToTarget') {
      const session = { tabId: source.tabId, sessionId: params.sessionId };
      const isSW = params.targetInfo && params.targetInfo.type === 'service_worker';
      log('attached ' + (params.targetInfo && params.targetInfo.type) + ' waiting=' + params.waitingForDebugger);
      if (!isSW) {
        if (params.waitingForDebugger) { try { await cmd(session, 'Runtime.runIfWaitingForDebugger'); } catch (_) {} }
        return;
      }
      if (!params.waitingForDebugger) {
        // 已經在跑的 Service Worker：晚了一步，但之後的指紋呼叫仍會被保護
        try { await injectNow(session); } catch (e) { log('late inject failed ' + e.message); }
        return;
      }
      // 還沒執行任何腳本：在「第一個腳本執行前」停下來注入，再放行。
      // 暫停中的 Worker 要等放行後才會回應指令，所以三個指令依序送出、不互相等待。
      const key = source.tabId + '|' + params.sessionId;
      swPending.set(key, null);
      cmd(session, 'Debugger.enable').then(() => log('dbg enabled'), (e) => log('enable err ' + e.message));
      cmd(session, 'Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' })
        .then((bp) => { if (swPending.has(key)) swPending.set(key, bp && bp.breakpointId); log('bp ' + JSON.stringify(bp)); },
              (e) => log('bp err ' + e.message));
      cmd(session, 'Runtime.runIfWaitingForDebugger').then(() => log('resumed'), (e) => log('run err ' + e.message));
      return;
    }

    if (method === 'Debugger.paused') log('paused ' + (params && params.reason) + ' sid=' + source.sessionId);
    if (method === 'Debugger.paused' && source.sessionId) {
      const key = source.tabId + '|' + source.sessionId;
      if (!swPending.has(key)) return;
      const bpId = swPending.get(key);
      swPending.delete(key);
      const session = { tabId: source.tabId, sessionId: source.sessionId };
      try { await injectNow(session); } catch (e) { log('inject failed ' + e.message); }
      try { if (bpId) await cmd(session, 'Debugger.removeBreakpoint', { breakpointId: bpId }); } catch (_) {}
      try { await cmd(session, 'Debugger.resume'); } catch (_) {}
      try { await cmd(session, 'Debugger.disable'); } catch (_) {}
    }
  });

  chrome.debugger.onDetach.addListener(async (source, reason) => {
    if (source.tabId != null) attachedTabs.delete(source.tabId);
    // 使用者在提示列按了「取消」：視為關閉 Service Worker 保護
    if (reason === 'canceled_by_user') await chrome.storage.local.set({ sw: false });
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) attachTab(tabId, tab.url || info.url || '');
});
chrome.tabs.onCreated.addListener((tab) => { if (tab.pendingUrl || tab.url) attachTab(tab.id, tab.pendingUrl || tab.url); });
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

// Service Worker（擴充功能本身的背景）被喚醒時重新載入設定
chrome.storage.local.get(DEFAULTS).then((cfg) => { swCfg = cfg; });
