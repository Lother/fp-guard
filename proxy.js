// 分站代理：依網域把請求導向指定的 proxy，其他網站直連。
// 用 chrome.proxy 的 PAC 腳本實作；帳號密碼由 webRequest.onAuthRequired 自動填入。
// 這支檔案同時被 background.js（importScripts）和 options.js（<script>）載入。

const PROXY_DEFAULTS = {
  proxyEnabled: true,
  proxies: [],      // [{ id, name, type: 'http'|'https'|'socks5'|'socks4', host, port, user, pass }]
  proxyRules: [],   // [{ pattern, proxyId }]
  webrtcGuard: true // 有代理規則時，禁止 WebRTC 走 proxy 以外的 UDP，避免洩漏真實 IP
};

const PROXY_TYPES = {
  http: { label: 'HTTP', pac: 'PROXY' },
  https: { label: 'HTTPS', pac: 'HTTPS' },
  socks5: { label: 'SOCKS5', pac: 'SOCKS5' },
  socks4: { label: 'SOCKS4', pac: 'SOCKS' }
};

// 把使用者輸入的網域整理成規則：
//   example.com      → example.com 和所有子網域
//   *.example.com    → 只有子網域
//   其他含 * 或 ? 的 → 萬用字元比對整個主機名稱
function normalizePattern(input) {
  let p = String(input || '').trim().toLowerCase();
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // 去掉 https://
  p = p.replace(/[/?#].*$/, '');                // 去掉路徑
  p = p.replace(/:\d+$/, '');                   // 去掉連接埠
  p = p.replace(/^\.+|\.+$/g, '');
  if (!p || !/^[a-z0-9*?.\-[\]:]+$/.test(p)) return null;
  return p;
}

function validProxy(p) {
  if (!p || !PROXY_TYPES[p.type]) return '類型不正確';
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(String(p.host || ''))) return '主機名稱不正確';
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '連接埠要介於 1–65535';
  if ((p.type === 'socks5' || p.type === 'socks4') && (p.user || p.pass)) {
    return 'Chrome 不支援需要帳號密碼的 SOCKS proxy，請改用 HTTP 類型或不設帳密';
  }
  return null;
}

function pacTarget(p) {
  return PROXY_TYPES[p.type].pac + ' ' + p.host + ':' + Number(p.port);
}

// 產生 PAC 腳本。規則由上而下比對，第一個符合的生效；
// 刻意不加「; DIRECT」退路：proxy 掛掉時寧可連不上，也不要偷偷用真實 IP 連線。
function buildPac(cfg, extraRules) {
  const byId = new Map(cfg.proxies.map((p) => [p.id, p]));
  const rules = [];
  for (const r of [...(extraRules || []), ...cfg.proxyRules]) {
    const p = byId.get(r.proxyId);
    const pattern = normalizePattern(r.pattern);
    if (!p || !pattern || validProxy(p)) continue;
    rules.push([pattern, pacTarget(p)]);
  }
  if (!rules.length) return null;
  return [
    'var RULES = ' + JSON.stringify(rules) + ';',
    'function FindProxyForURL(url, host) {',
    '  host = String(host).toLowerCase();',
    '  for (var i = 0; i < RULES.length; i++) {',
    '    var p = RULES[i][0];',
    '    var hit;',
    '    if (p.indexOf("*.") === 0 && p.slice(2).indexOf("*") < 0 && p.indexOf("?") < 0) {',
    '      var base = p.slice(2);',
    '      hit = host.length > base.length && host.slice(-(base.length + 1)) === "." + base;',
    '    } else if (p.indexOf("*") >= 0 || p.indexOf("?") >= 0) {',
    '      hit = shExpMatch(host, p);',
    '    } else {',
    '      hit = host === p || (host.length > p.length && host.slice(-(p.length + 1)) === "." + p);',
    '    }',
    '    if (hit) return RULES[i][1];',
    '  }',
    '  return "DIRECT";',
    '}'
  ].join('\n');
}

// 某個主機名稱目前會套用哪條規則（彈出視窗用）
function matchRule(cfg, host) {
  host = String(host || '').toLowerCase();
  for (const r of cfg.proxyRules) {
    const p = normalizePattern(r.pattern);
    if (!p) continue;
    let hit;
    if (p.startsWith('*.') && !p.slice(2).includes('*') && !p.includes('?')) {
      hit = host.endsWith('.' + p.slice(2));
    } else if (p.includes('*') || p.includes('?')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      hit = re.test(host);
    } else {
      hit = host === p || host.endsWith('.' + p);
    }
    if (hit) return r;
  }
  return null;
}

// ---------- 以下只在背景執行 ----------

// 把 PAC 套用到一般視窗；有允許無痕模式的話也套用到無痕視窗。
// mandatory: true —— PAC 萬一壞掉，Chrome 會讓連線失敗，而不是默默改用直連（洩漏真實 IP）。
async function setPac(pac) {
  const scopes = ['regular'];
  try { if (await chrome.extension.isAllowedIncognitoAccess()) scopes.push('incognito_persistent'); } catch (_) {}
  for (const scope of scopes) {
    if (pac) await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } }, scope });
    else await chrome.proxy.settings.clear({ scope });
  }
}

let proxyQueue = Promise.resolve();
function queued(fn) { proxyQueue = proxyQueue.then(fn, fn); return proxyQueue; }

function applyProxy() { return queued(applyProxyNow); }

async function applyProxyNow() {
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  const pac = cfg.proxyEnabled ? buildPac(cfg) : null;
  let error = null;
  try { await setPac(pac); } catch (e) { error = String(e && e.message || e); console.warn('proxy apply failed', e); }
  try { await chrome.storage.session.set({ proxyApplied: { at: Date.now(), active: !!pac, error } }); } catch (_) {}

  // WebRTC：有代理規則時改成「只走 proxy，不用其他 UDP」，避免網頁從 WebRTC 拿到真實 IP
  try {
    const net = chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy;
    if (net) {
      if (pac && cfg.webrtcGuard) await net.set({ value: 'disable_non_proxied_udp' });
      else await net.clear({});
    }
  } catch (e) {
    console.warn('webrtc policy failed', e);
  }
}

const NET_ERRORS = {
  'net::ERR_PROXY_CONNECTION_FAILED': '連不上 proxy：伺服器沒開，或主機／連接埠填錯',
  'net::ERR_SOCKS_CONNECTION_FAILED': 'SOCKS proxy 有回應，但它連不到目標網站',
  'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE': 'SOCKS proxy 連不到目標網站',
  'net::ERR_TUNNEL_CONNECTION_FAILED': 'proxy 拒絕建立連線（可能需要帳密或不允許 HTTPS）',
  'net::ERR_PROXY_AUTH_UNSUPPORTED': 'proxy 要求的驗證方式 Chrome 不支援',
  'net::ERR_PROXY_AUTH_REQUESTED': 'proxy 需要帳號密碼',
  'net::ERR_INVALID_AUTH_CREDENTIALS': 'proxy 帳號密碼錯誤',
  'net::ERR_TIMED_OUT': '連線逾時',
  'net::ERR_CONNECTION_TIMED_OUT': '連線逾時',
  'net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED': 'PAC 腳本無法執行'
};
function explainNetError(e) { return NET_ERRORS[e] ? `${NET_ERRORS[e]}（${e}）` : e; }

// 測試某個 proxy：暫時讓測試網址走它，查出口 IP，再還原原本的設定
const TEST_URL = 'https://ifconfig.co/json';
function testProxy(proxyId, url) {
  return queued(() => testProxyNow(proxyId, url || TEST_URL));
}

async function testProxyNow(proxyId, url) {
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  const p = cfg.proxies.find((x) => x.id === proxyId);
  if (!p) return { ok: false, error: '找不到這個 proxy，請先儲存' };
  const bad = validProxy(p);
  if (bad) return { ok: false, error: bad };

  const ctl = await chrome.proxy.settings.get({});
  if (ctl.levelOfControl === 'controlled_by_other_extensions') return { ok: false, error: '另一個擴充功能正在控制 proxy 設定，請先停用它' };
  if (ctl.levelOfControl === 'not_controllable') return { ok: false, error: 'Chrome 的 proxy 設定被系統原則鎖定' };

  const host = new URL(url).hostname;
  const pac = buildPac(cfg, [{ pattern: host, proxyId }]);
  const testStart = Date.now();
  let netError = null;
  const onErr = (d) => { netError = d.error; };
  chrome.webRequest.onErrorOccurred.addListener(onErr, { urls: [`*://${host}/*`] });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    await setPac(pac);
    const t0 = Date.now();
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + t0, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    const text = await r.text();
    let info = {};
    try { info = JSON.parse(text); } catch (_) {}
    return { ok: r.ok, status: r.status, ip: info.ip || null, country: info.country || null,
             city: info.city || null, org: info.asn_org || null, ms: Date.now() - t0 };
  } catch (e) {
    await new Promise((res) => setTimeout(res, 50));
    return { ok: false, error: netError ? explainNetError(netError) : (ctrl.signal.aborted ? '15 秒內沒有回應' : String(e && e.message || e)) };
  } finally {
    clearTimeout(timer);
    chrome.webRequest.onErrorOccurred.removeListener(onErr);
    await applyProxyNow();
    // 測試本身造成的錯誤不算進「最近的 proxy 錯誤」
    try {
      const { proxyLastError } = await chrome.storage.session.get('proxyLastError');
      if (proxyLastError && proxyLastError.at >= testStart) await chrome.storage.session.remove('proxyLastError');
    } catch (_) {}
  }
}

function initProxyBackground() {
  chrome.runtime.onInstalled.addListener(applyProxy);
  chrome.runtime.onStartup.addListener(applyProxy);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k in PROXY_DEFAULTS)) applyProxy();
  });

  // proxy 要求帳號密碼時自動填入；同一個請求只試一次，避免帳密錯誤時無限重試
  const tried = new Set();
  // 記下最近一次 proxy 錯誤，設定頁的「連線檢查」會顯示
  if (chrome.proxy.onProxyError) {
    chrome.proxy.onProxyError.addListener((d) => {
      chrome.storage.session.set({ proxyLastError: { at: Date.now(), error: d.error, details: d.details || '', fatal: d.fatal } }).catch(() => {});
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'proxyTest') { testProxy(msg.proxyId, msg.url).then(reply, (e) => reply({ ok: false, error: String(e) })); return true; }
    if (msg && msg.type === 'proxyApply') { applyProxy().then(() => reply({ ok: true })); return true; }
    return false;
  });

  chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    if (tried.has(details.requestId)) { tried.delete(details.requestId); callback({ cancel: true }); return; }
    chrome.storage.local.get(PROXY_DEFAULTS).then((cfg) => {
      const ch = details.challenger || {};
      const p = cfg.proxies.find((x) =>
        String(x.host).toLowerCase() === String(ch.host || '').toLowerCase() &&
        Number(x.port) === Number(ch.port) && x.user);
      if (!p) { callback({}); return; }
      tried.add(details.requestId);
      callback({ authCredentials: { username: p.user, password: p.pass || '' } });
    }, () => callback({}));
  }, { urls: ['<all_urls>'] }, ['asyncBlocking']);

  const forget = (d) => tried.delete(d.requestId);
  chrome.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });

  // 背景被喚醒時也重新套用一次（設定本來就會保存，這裡是保險）
  applyProxy();
}
