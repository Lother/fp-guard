const DEFAULTS = { enabled: true, whitelist: [], mode: 'stealth', canvas: true, webgl: true, audio: true, text: true, gpu: true, cpu: true, screen: 'auto', sw: false };
const $ = (id) => document.getElementById(id);
let host = null;
let tabId = null;

function setSwitch(el, on) { el.setAttribute('aria-checked', String(on)); }
function say(msg) { $('status').textContent = msg; }

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  try {
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname.replace(/^www\./, '');
  } catch (_) {}

  const cfg = await chrome.storage.local.get(DEFAULTS);
  setSwitch($('enabled'), cfg.enabled);
  $('globalHint').textContent = cfg.enabled ? '已開啟' : '已關閉';
  $('host').textContent = host || '這個頁面無法套用';
  $('siteOff').disabled = !host;
  setSwitch($('siteOff'), !!host && cfg.whitelist.includes(host));
  $('mode').value = cfg.mode;
  modeHint();
  for (const el of document.querySelectorAll('.opt')) {
    const k = el.dataset.key;
    setSwitch(el, k === 'screen' ? cfg.screen === 'auto' : cfg[k] !== false);
  }
  setSwitch($('sw'), !!cfg.sw);
  await loadProxy();
}

// ---------- 此網站的代理 ----------
async function loadProxy() {
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  const sel = $('siteProxy');
  sel.innerHTML = '';
  sel.add(new Option('直連（不使用代理）', ''));
  for (const p of cfg.proxies) sel.add(new Option(p.name || `${p.host}:${p.port}`, p.id));
  sel.add(new Option('＋ 新增 proxy…', '__new'));
  sel.disabled = !host;

  const hint = $('proxyHint');
  if (!host) { hint.textContent = '這個頁面無法套用'; return; }
  const exact = cfg.proxyRules.find((r) => r.pattern === host);
  const hit = matchRule(cfg, host);
  sel.value = exact ? exact.proxyId : '';
  let lv = null;
  try { lv = (await chrome.proxy.settings.get({})).levelOfControl; } catch (_) {}
  if (lv === 'controlled_by_other_extensions') hint.textContent = '⚠ 另一個擴充功能正在控制 proxy，這裡的設定不會生效（按「管理…」看詳情）';
  else if (lv === 'not_controllable') hint.textContent = '⚠ Chrome 的 proxy 設定被系統鎖定，這裡的設定不會生效';
  else if (!cfg.proxyEnabled) hint.textContent = '分站代理目前已關閉（到「管理…」開啟）';
  else if (hit && !exact) {
    const p = cfg.proxies.find((x) => x.id === hit.proxyId);
    hint.textContent = `目前由規則「${hit.pattern}」套用 ${p ? (p.name || p.host) : '?'}`;
  } else if (exact) hint.textContent = `${host} 和它的子網域走這個代理，立即生效`;
  else hint.textContent = '選一個 proxy，這個網站（含子網域）就改走它';
}

$('siteProxy').addEventListener('change', async () => {
  const v = $('siteProxy').value;
  if (v === '__new') {
    const url = chrome.runtime.getURL('options.html');
    const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl || '').startsWith(url));
    if (t) await chrome.tabs.remove(t.id); // 舊的設定頁關掉，避免停在舊內容
    await chrome.tabs.create({ url: url + '?add=' + encodeURIComponent(host) });
    window.close();
    return;
  }
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  const rules = cfg.proxyRules.filter((r) => r.pattern !== host);
  if (v) rules.unshift({ pattern: host, proxyId: v }); // 放最上面，優先於其他規則
  await chrome.storage.local.set({ proxyRules: rules });
  await loadProxy();
  // 代理立即生效，但已經載入的頁面要重新整理才會用新的連線
  changed();
});

$('manageProxy').addEventListener('click', async () => {
  // 已經開著設定頁就切過去，否則開新分頁
  const url = chrome.runtime.getURL('options.html');
  const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl || '').startsWith(url));
  if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
  window.close();
});

async function changed() {
  say('已更新，重新整理分頁後生效');
  if (tabId != null) {
    $('status').innerHTML = '';
    const a = document.createElement('a');
    a.href = '#'; a.textContent = '已更新，按這裡重新整理分頁';
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.reload(tabId); window.close(); };
    $('status').appendChild(a);
  }
}

$('enabled').addEventListener('click', async () => {
  const next = $('enabled').getAttribute('aria-checked') !== 'true';
  await chrome.storage.local.set({ enabled: next });
  setSwitch($('enabled'), next);
  $('globalHint').textContent = next ? '已開啟' : '已關閉';
  changed();
});

$('siteOff').addEventListener('click', async () => {
  if (!host) return;
  const { whitelist } = await chrome.storage.local.get(DEFAULTS);
  const on = !whitelist.includes(host);
  const next = on ? [...whitelist, host] : whitelist.filter((h) => h !== host);
  await chrome.storage.local.set({ whitelist: next });
  setSwitch($('siteOff'), on);
  changed();
});

function modeHint() {
  $('modeHint').textContent = $('mode').value === 'stealth'
    ? '網站察覺不到防護，指紋仍每次不同；檢測站只靠「測不測得到雜訊」判斷，所以會顯示「一直不變」。'
    : '像 Brave 一樣明著打亂；檢測站測得到雜訊，會判定為「環境被篡改」。';
}

$('mode').addEventListener('change', async () => {
  await chrome.storage.local.set({ mode: $('mode').value });
  modeHint();
  changed();
});

for (const el of document.querySelectorAll('.opt')) {
  el.addEventListener('click', async () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    const k = el.dataset.key;
    await chrome.storage.local.set({ [k]: k === 'screen' ? (next ? 'auto' : 'off') : next });
    setSwitch(el, next);
    changed();
  });
}

// Service Worker 保護：開關只決定背景要不要附加偵錯器（權限已在 manifest 宣告）
$('sw').addEventListener('click', async () => {
  const next = $('sw').getAttribute('aria-checked') !== 'true';
  await chrome.storage.local.set({ sw: next });
  setSwitch($('sw'), next);
  changed();
});

// 一鍵預設
const PRESETS = {
  // 混入人群：不加雜訊（維持跟大家一樣的真實值），只偽裝少見的硬體
  blend: { canvas: false, webgl: false, audio: false, text: false, gpu: true, cpu: true, screen: 'auto' },
  // 打亂：全部加雜訊，每次載入都不同
  shuffle: { canvas: true, webgl: true, audio: true, text: true, gpu: true, cpu: true, screen: 'auto' }
};
for (const el of document.querySelectorAll('[data-preset]')) {
  el.addEventListener('click', async () => {
    await chrome.storage.local.set(PRESETS[el.dataset.preset]);
    await load();
    changed();
  });
}

$('test').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://who.1ms.dog/zh-cn/' });
});

load();
