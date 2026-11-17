// 分站代理設定頁（PROXY_DEFAULTS、normalizePattern、validProxy 來自 proxy.js）
const $ = (id) => document.getElementById(id);
let dirty = false;

function setSwitch(el, on) { el.setAttribute('aria-checked', String(on)); }
function say(msg, tone) { $('status').textContent = msg; $('status').dataset.tone = tone || ''; }
function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function proxyRow(p = {}) {
  const el = $('proxyTpl').content.firstElementChild.cloneNode(true);
  el.dataset.id = p.id || newId();
  el.querySelector('.name').value = p.name || '';
  el.querySelector('.type').value = p.type || 'http';
  el.querySelector('.host').value = p.host || '';
  el.querySelector('.port').value = p.port || '';
  el.querySelector('.user').value = p.user || '';
  el.querySelector('.pass').value = p.pass || '';
  el.querySelector('.del').onclick = () => { el.remove(); refreshProxyOptions(); markDirty(); emptyHints(); };
  el.querySelector('.name').addEventListener('input', refreshProxyOptions);
  el.querySelector('.test').onclick = () => testRow(el);
  $('proxies').appendChild(el);
  return el;
}

function ruleRow(r = {}) {
  const el = $('ruleTpl').content.firstElementChild.cloneNode(true);
  el.querySelector('.pattern').value = r.pattern || '';
  el.dataset.proxyId = r.proxyId || '';
  el.querySelector('.del').onclick = () => { el.remove(); markDirty(); emptyHints(); };
  el.querySelector('.up').onclick = () => {
    if (el.previousElementSibling && el.previousElementSibling.classList.contains('rule')) {
      el.parentNode.insertBefore(el, el.previousElementSibling); markDirty();
    }
  };
  el.querySelector('.proxyId').addEventListener('change', (e) => { el.dataset.proxyId = e.target.value; });
  $('rules').appendChild(el);
  refreshProxyOptions();
  return el;
}

// 規則的下拉選單跟著 proxy 清單更新
function refreshProxyOptions() {
  const proxies = [...document.querySelectorAll('.item.proxy')].map((el, i) => ({
    id: el.dataset.id,
    label: el.querySelector('.name').value.trim() || (el.querySelector('.host').value.trim() || `Proxy ${i + 1}`)
  }));
  for (const row of document.querySelectorAll('.item.rule')) {
    const sel = row.querySelector('.proxyId');
    const want = row.dataset.proxyId;
    sel.innerHTML = '';
    if (!proxies.length) sel.add(new Option('（先新增 proxy）', ''));
    for (const p of proxies) sel.add(new Option(p.label, p.id));
    if (proxies.some((p) => p.id === want)) sel.value = want;
    row.dataset.proxyId = sel.value;
  }
}

function emptyHints() {
  for (const [box, text] of [[$('proxies'), '還沒有 proxy。'], [$('rules'), '還沒有規則，所有網站都直連。']]) {
    const hasItem = box.querySelector('.item');
    let e = box.querySelector('.empty');
    if (!hasItem && !e) { e = document.createElement('p'); e.className = 'empty'; e.textContent = text; box.appendChild(e); }
    if (hasItem && e) e.remove();
  }
}

function markDirty() { dirty = true; say('有尚未儲存的變更'); }

async function load(handleAdd) {
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  setSwitch($('proxyEnabled'), cfg.proxyEnabled);
  setSwitch($('webrtcGuard'), cfg.webrtcGuard);
  $('proxies').innerHTML = ''; $('rules').innerHTML = '';
  for (const p of cfg.proxies) proxyRow(p);
  for (const r of cfg.proxyRules) ruleRow(r);
  emptyHints();
  dirty = false;
  say('');

  // 從彈出視窗帶網域過來：預先填好一條規則（只處理一次，處理完把參數從網址拿掉，
  // 否則之後儲存、或從彈出視窗按「管理…」回到這個分頁時，又會再插入一條）
  const add = handleAdd ? new URLSearchParams(location.search).get('add') : null;
  if (handleAdd && location.search) history.replaceState(null, '', location.pathname);
  if (add && !cfg.proxyRules.some((r) => r.pattern === add)) {
    const r = ruleRow({ pattern: add });
    emptyHints();
    if (!cfg.proxies.length) proxyRow().querySelector('.name').focus();
    else r.querySelector('.proxyId').focus();
    markDirty();
  }
  await checkStatus();
}

// 其他擴充功能（例如 VPN 擴充）正在控制 proxy 時提醒
async function showControl() {
  try {
    const d = await chrome.proxy.settings.get({});
    const lv = d.levelOfControl;
    const banner = $('control');
    if (lv === 'controlled_by_other_extensions') {
      banner.textContent = '另一個擴充功能（例如 VPN 或 proxy 擴充）正在控制 Chrome 的 proxy 設定，這裡的規則不會生效。請先停用它。';
      banner.hidden = false;
    } else if (lv === 'not_controllable') {
      banner.textContent = 'Chrome 的 proxy 設定被系統原則鎖定，這裡的規則不會生效。';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch (_) {}
}

function collect() {
  const errors = [];
  const proxies = [];
  for (const el of document.querySelectorAll('.item.proxy')) {
    const p = {
      id: el.dataset.id,
      name: el.querySelector('.name').value.trim(),
      type: el.querySelector('.type').value,
      host: el.querySelector('.host').value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''),
      port: Number(el.querySelector('.port').value.trim()),
      user: el.querySelector('.user').value.trim(),
      pass: el.querySelector('.pass').value
    };
    // 允許把「host:port」整串貼進主機欄
    const m = /^([^:]+):(\d+)$/.exec(p.host);
    if (m && !el.querySelector('.port').value.trim()) { p.host = m[1]; p.port = Number(m[2]); }
    const err = validProxy(p);
    el.classList.toggle('invalid', !!err);
    if (err) errors.push(`${p.name || p.host || 'Proxy'}：${err}`);
    proxies.push(p);
  }
  const ids = new Set(proxies.map((p) => p.id));
  const rules = [];
  for (const el of document.querySelectorAll('.item.rule')) {
    const raw = el.querySelector('.pattern').value;
    const pattern = normalizePattern(raw);
    const proxyId = el.querySelector('.proxyId').value;
    const bad = !pattern || !ids.has(proxyId);
    el.classList.toggle('invalid', bad);
    if (!pattern) { errors.push(`規則「${raw || '（空白）'}」：網域格式不正確`); continue; }
    if (!ids.has(proxyId)) { errors.push(`規則「${pattern}」：沒有選擇 proxy`); continue; }
    rules.push({ pattern, proxyId });
  }
  return { proxies, rules, errors };
}

let saving = false;
$('save').addEventListener('click', async () => {
  const { proxies, rules, errors } = collect();
  if (errors.length) { say(errors[0], 'bad'); return; }
  saving = true;
  setTimeout(() => { saving = false; }, 1000);
  await chrome.storage.local.set({ proxies, proxyRules: rules });
  await chrome.runtime.sendMessage({ type: 'proxyApply' }).catch(() => {});
  await load(false);
  say(rules.length ? `已儲存，${rules.length} 條規則已套用。已開著的分頁請重新整理。` : '已儲存，目前沒有規則，所有網站直連', 'ok');
});

for (const key of ['proxyEnabled', 'webrtcGuard']) {
  $(key).addEventListener('click', async () => {
    const next = $(key).getAttribute('aria-checked') !== 'true';
    setSwitch($(key), next);
    await chrome.storage.local.set({ [key]: next });
    say('已更新', 'ok');
  });
}

$('addProxy').addEventListener('click', () => { proxyRow().querySelector('.name').focus(); refreshProxyOptions(); emptyHints(); markDirty(); });
$('addRule').addEventListener('click', () => { ruleRow().querySelector('.pattern').focus(); emptyHints(); markDirty(); });
document.addEventListener('input', (e) => { if (e.target.closest('.item')) markDirty(); });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 測試 proxy ----------
async function testRow(el) {
  const out = el.querySelector('.result');
  out.hidden = false;
  if (dirty) { out.dataset.tone = 'bad'; out.textContent = '請先按「儲存」再測試'; return; }
  out.dataset.tone = ''; out.textContent = '測試中…（經由這個 proxy 連到 ifconfig.co 查出口 IP）';
  const btn = el.querySelector('.test'); btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'proxyTest', proxyId: el.dataset.id });
    if (r && r.ok && r.ip) {
      out.dataset.tone = 'ok';
      out.textContent = `✓ 可以用。出口 IP ${r.ip}` + [r.country, r.city, r.org].filter(Boolean).map((x) => ' · ' + x).join('') + ` · ${r.ms} ms`;
    } else if (r && r.ok) {
      out.dataset.tone = 'ok'; out.textContent = `✓ 連得上（HTTP ${r.status}），但讀不到出口 IP`;
    } else {
      out.dataset.tone = 'bad'; out.textContent = '✕ ' + ((r && r.error) || (r && r.status ? `HTTP ${r.status}` : '測試失敗'));
    }
  } catch (e) {
    out.dataset.tone = 'bad'; out.textContent = '✕ ' + e.message;
  } finally {
    btn.disabled = false;
    checkStatus();
  }
}

// ---------- 連線檢查 ----------
function li(tone, text) {
  const el = document.createElement('li');
  el.className = tone;
  const ic = document.createElement('span'); ic.className = 'ic';
  ic.textContent = { ok: '✓', bad: '✕', warn: '!', info: 'i' }[tone];
  const t = document.createElement('span'); t.textContent = text;
  el.append(ic, t);
  return el;
}

async function checkStatus() {
  await showControl();
  const box = $('checks');
  const items = [];
  const cfg = await chrome.storage.local.get(PROXY_DEFAULTS);
  const pac = buildPac(cfg);
  let d = null;
  try { d = await chrome.proxy.settings.get({}); } catch (_) {}
  const lv = d && d.levelOfControl;
  const mode = d && d.value && d.value.mode;

  if (!cfg.proxyEnabled) items.push(li('warn', '分站代理已關閉，所有網站都直連。'));
  else if (!pac) items.push(li('warn', '沒有有效的規則（規則要選 proxy，proxy 要填完整），所有網站都直連。'));
  else items.push(li('ok', `已設定 ${cfg.proxyRules.length} 條規則。`));

  if (lv === 'controlled_by_this_extension') {
    items.push(li(mode === 'pac_script' ? 'ok' : 'info', mode === 'pac_script' ? 'Chrome 的 proxy 設定由指紋護盾控制中。' : '指紋護盾目前沒有套用任何 proxy。'));
  } else if (lv === 'controlled_by_other_extensions') {
    items.push(li('bad', '另一個擴充功能（例如 SwitchyOmega、VPN 擴充）正在控制 proxy，指紋護盾的規則不會生效。到 chrome://extensions 停用它後按「重新檢查」。'));
  } else if (lv === 'not_controllable') {
    items.push(li('bad', 'Chrome 的 proxy 設定被系統原則或啟動參數鎖定（例如公司電腦、--proxy-server），擴充功能無法變更。'));
  } else if (lv === 'controllable_by_this_extension') {
    items.push(li(pac ? 'bad' : 'info', pac ? '規則還沒套用到 Chrome。按「儲存」或「重新檢查」再試一次。' : '目前沒有套用 proxy（所有網站直連）。'));
    if (pac) chrome.runtime.sendMessage({ type: 'proxyApply' }).catch(() => {});
  }

  try {
    const inc = await chrome.extension.isAllowedIncognitoAccess();
    items.push(li(inc ? 'ok' : 'info', inc ? '無痕視窗也會套用。' : '無痕視窗不會套用：要用的話到 chrome://extensions 的指紋護盾「詳細資料」開啟「允許在無痕模式下執行」。'));
  } catch (_) {}

  try {
    const s = await chrome.storage.session.get(['proxyApplied', 'proxyLastError']);
    if (s.proxyApplied && s.proxyApplied.error) items.push(li('bad', '套用失敗：' + s.proxyApplied.error));
    const e = s.proxyLastError;
    if (e && Date.now() - e.at < 10 * 60 * 1000) {
      const mins = Math.max(1, Math.round((Date.now() - e.at) / 60000));
      items.push(li('warn', `${mins} 分鐘內發生過 proxy 錯誤：${explainNetError(e.error)}${e.details ? '（' + e.details + '）' : ''}`));
    }
  } catch (_) {}

  items.push(li('info', '改了規則後，已經開著的分頁要重新整理；仍看到舊 IP 的話，關掉該網站所有分頁再開（瀏覽器會沿用已建立的連線一小段時間）。'));
  box.replaceChildren(...items);
}

$('recheck').addEventListener('click', checkStatus);

// 彈出視窗改了規則時，設定頁跟著更新（有未儲存的變更就不覆蓋）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('proxies' in changes || 'proxyRules' in changes || 'proxyEnabled' in changes) && !dirty && !saving) load(false);
});

load(true);
