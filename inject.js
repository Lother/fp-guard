// 指紋護盾：在頁面腳本執行前，替會被拿來當指紋的 API 加上微量雜訊。
//
// 設計原則
// 1. 雜訊由「本次載入的隨機種子 + 像素位置」決定：同一頁內畫兩次結果相同（不會被
//    「畫兩次比對」抓到），但重新載入就換一組，網站拿不到穩定的指紋。
// 2. 兩種模式（由 background 依設定先載入 mode-*.js 決定）：
//    - 打亂模式（預設）：所有不透明像素都可能被加雜訊，效果類似 Brave，
//      網站會知道「指紋被打亂了」，但拿不到穩定值。
//    - 隱匿模式：只動「有邊緣的像素」，純色區塊完全不變，
//      「畫一塊純色再讀回來」的檢測抓不到，看起來像沒裝任何防護。
// 3. 被替換的函式在 Function.prototype.toString 下仍顯示 [native code]，
//    名稱、length、不可 new 等特性都與原生一致。
// 4. 不改 navigator / screen 等屬性，避免和 Worker、HTTP 標頭對不上而被判定為「環境被篡改」。
// 5. Worker / SharedWorker 也受保護：建立時把同一套程式（同一個種子）放在 Worker 腳本最前面。
(() => {
  'use strict';

  const KEY = Symbol.for('fpg.installed');
  const OPTS_KEY = Symbol.for('fpg.opts');

  // 設定由 background 依使用者選擇，先載入 flags/*.js 這些只設旗標的小檔；讀完就刪掉
  let opts = {};
  try {
    opts = Object.assign({}, window[OPTS_KEY]);
    delete window[OPTS_KEY];
  } catch (_) {}

  // 同源的父框架已經裝過，就沿用它的種子與設定，讓父子框架算出一樣的指紋
  let seed = 0;
  let fakes = null; // 同源框架共用的「偽裝函式登記表」
  try {
    if (window[KEY]) return;
    for (let w = window; w.parent && w.parent !== w; w = w.parent) {
      const s = w.parent[KEY];
      if (s) { seed = s.seed; opts = s.opts; fakes = s.fakes || null; break; }
    }
  } catch (_) { /* 跨來源，拿不到就自己產生 */ }
  if (!seed) seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;

  // 萬一背景還沒記到這個網站的 CSP，頁面自己發現 blob 被擋，之後的 Worker 就不再包裝
  try {
    window.addEventListener('securitypolicyviolation', (e) => {
      if (/^blob/.test(e.blockedURI || '')) {
        try { Object.defineProperty(window, Symbol.for('fpg.strictcsp'), { value: true, configurable: true }); } catch (_) {}
      }
    }, true);
  } catch (_) {}

  fpgMain(seed, opts, null, null, fakes);

// ↓ 這個函式會被原封不動地序列化進 Worker，所以不能引用外面的任何變數。
// base：Worker 原本的網址（包裝後用來還原相對路徑與 location）
// strict：已知這個網站的 CSP 不允許 blob: Worker（null = 從頁面旗標讀）
// opts：{ stealth, canvas, webgl, audio, text, screen, gpu, cpu }，未設定的項目預設開啟
//@@FPG_CORE_START
function fpgMain(seed, opts, base, strict, sharedFakes) {
  'use strict';
  opts = opts || {};
  const stealth = !!opts.stealth;
  const on = (k) => opts[k] !== false;
  const KEY = Symbol.for('fpg.installed');
  const STRICT_KEY = Symbol.for('fpg.strictcsp');
  const G = globalThis;

  // ---------- 工具 ----------

  // 32 位元整數雜湊（murmur3 finalizer 變形）
  function hash(a, b) {
    let h = (seed ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // 假函式 -> 原生函式的 toString 字串。
  // 同源 iframe 和主頁面共用同一份：網站會拿 iframe 的 toString 去檢查主頁面的函式，反之亦然
  const fakes = sharedFakes || new WeakMap();
  const nativeFnToString = Function.prototype.toString;
  const SELF_SRC = nativeFnToString.call(fpgMain);

  // 在原型鏈上找屬性描述（全域物件的方法有的在自身、有的在原型）
  function findHolder(obj, name) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      if (Object.getOwnPropertyDescriptor(o, name)) return o;
    }
    return null;
  }

  // 替換建構子（Worker、Request…）：用 Proxy 保留 prototype、instanceof、不加 new 會報錯等行為
  function hookCtor(holder, name, mapArgs) {
    if (!holder) return;
    const desc = Object.getOwnPropertyDescriptor(holder, name);
    if (!desc || typeof desc.value !== 'function') return;
    const Orig = desc.value;
    const P = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const nt = newTarget === P ? target : newTarget;
        let mapped = null;
        try { mapped = mapArgs(args); } catch (_) {}
        if (mapped) {
          try { return Reflect.construct(target, mapped, nt); } catch (_) { /* 改用原參數 */ }
        }
        return Reflect.construct(target, args, nt);
      }
    });
    fakes.set(P, nativeFnToString.call(Orig));
    Object.defineProperty(holder, name, { ...desc, value: P });
    try {
      const cd = Object.getOwnPropertyDescriptor(Orig.prototype, 'constructor');
      if (cd) Object.defineProperty(Orig.prototype, 'constructor', { ...cd, value: P });
    } catch (_) {}
  }

  function disguise(fake, orig) {
    try {
      Object.defineProperty(fake, 'name', { value: orig.name, configurable: true });
      Object.defineProperty(fake, 'length', { value: orig.length, configurable: true });
    } catch (_) {}
    fakes.set(fake, nativeFnToString.call(orig));
    return fake;
  }

  // 替換方法。make(orig) 必須回傳「方法簡寫」建立的函式（沒有 prototype、不能 new）
  function hookMethod(proto, name, make) {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') return;
    const fake = disguise(make(desc.value), desc.value);
    Object.defineProperty(proto, name, { ...desc, value: fake });
  }

  function hookGetter(proto, name, make) {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.get !== 'function') return;
    const fake = disguise(make(desc.get), desc.get);
    Object.defineProperty(proto, name, { ...desc, get: fake });
  }

  // ---------- 像素雜訊 ----------

  // data: RGBA；(x0, y0) 為這塊資料在畫布上的絕對座標，讓雜訊位置固定。
  // ref/refW: 用來判斷邊緣的參考資料（比 data 多一欄一列），沒有就用 data 自己。
  function noisePixels(data, w, h, x0, y0, ref, refW) {
    if (!ref) { ref = data; refW = w; }
    const refH = ref.length / 4 / refW;
    // 隱匿模式：顏色種類很少的區塊（純色、色塊、棋盤格）是檢測站拿來比對「預期結果」的測試圖，
    // 真正的指紋圖（文字、漸層、emoji）會有上百種顏色。前者完全不動，就測不出雜訊。
    if (stealth && fewColors(ref, refW, w, h)) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const j = (y * refW + x) * 4;
        if (ref[j + 3] === 0) continue; // 透明像素不動
        if (stealth) {
          let edge = false;
          // 與右方或下方「不透明」的像素顏色不同才算邊緣；
          // 畫布外讀回來的是透明像素，不算，所以純色畫布完全不會被動到
          if (x + 1 < refW && ref[j + 7] !== 0) {
            const k = j + 4;
            edge = ref[j] !== ref[k] || ref[j + 1] !== ref[k + 1] ||
                   ref[j + 2] !== ref[k + 2] || ref[j + 3] !== ref[k + 3];
          }
          if (!edge && y + 1 < refH && ref[j + refW * 4 + 3] !== 0) {
            const k = j + refW * 4;
            edge = ref[j] !== ref[k] || ref[j + 1] !== ref[k + 1] ||
                   ref[j + 2] !== ref[k + 2] || ref[j + 3] !== ref[k + 3];
          }
          if (!edge) continue; // 隱匿模式：純色區塊不動
        }
        const r = hash(x0 + x, y0 + y);
        if ((r & 3) !== 0) continue; // 約四分之一的候選像素
        data[i + ((r >>> 2) % 3)] ^= 1; // 只翻最低位元，肉眼看不出來
      }
    }
  }

  const FEW = 48; // 少於這麼多種顏色 / 數值，視為可預測的測試內容
  function fewColors(ref, refW, w, h) {
    const seen = new Set();
    for (let y = 0; y < h; y++) {
      const row = y * refW;
      for (let x = 0; x < w; x++) {
        const j = (row + x) * 4;
        seen.add(((ref[j] << 24) | (ref[j + 1] << 16) | (ref[j + 2] << 8) | ref[j + 3]) >>> 0);
        if (seen.size > FEW) return false;
      }
    }
    return true;
  }
  function fewValues(arr) {
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      seen.add(arr[i]);
      if (seen.size > FEW) return false;
    }
    return true;
  }

  const MAX_PIXELS = 4096 * 4096; // 太大的畫布不處理，避免拖慢頁面
  const blobs = new Map();   // 頁面建立的 blob: 網址 -> Blob（建 Worker 時要讀原始碼）
  const wrapped = new Map(); // 原 Worker 網址 -> 包裝後的 blob: 網址（同網址重用，SharedWorker 才連得上）

  // ---------- 安裝到某個 window（含同源 iframe） ----------

  function install(win) {
    try {
      if (win[KEY]) return;
      Object.defineProperty(win, KEY, { value: { seed, opts, fakes }, enumerable: false });
    } catch (_) { return; }

    const doc = win.document;
    const createElement = win.Document && win.Document.prototype.createElement;
    const C2D = win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype;
    const OC2D = win.OffscreenCanvasRenderingContext2D && win.OffscreenCanvasRenderingContext2D.prototype;
    const getContext = win.HTMLCanvasElement && win.HTMLCanvasElement.prototype.getContext;
    const origGetImageData = C2D && C2D.getImageData;
    const origPutImageData = C2D && C2D.putImageData;
    const origDrawImage = C2D && C2D.drawImage;
    // OffscreenCanvas 的原生方法要在 hook 之前先存起來，否則 convertToBlob 會加兩次雜訊而互相抵消
    const ocGet = OC2D && OC2D.getImageData, ocPut = OC2D && OC2D.putImageData, ocDraw = OC2D && OC2D.drawImage;
    const canvasW = win.HTMLCanvasElement &&
      Object.getOwnPropertyDescriptor(win.HTMLCanvasElement.prototype, 'width').get;
    const canvasH = win.HTMLCanvasElement &&
      Object.getOwnPropertyDescriptor(win.HTMLCanvasElement.prototype, 'height').get;

    // Function.prototype.toString：假函式回報原生字串
    hookMethod(win.Function.prototype, 'toString', (orig) => ({
      toString() {
        const s = fakes.get(this);
        if (s !== undefined) return s;
        return Reflect.apply(orig, this, arguments);
      }
    }).toString);

    // 把畫布內容複製到暫存畫布並加上雜訊；失敗回傳 null，呼叫端改走原生路徑
    function noisyCopy(canvas) {
      if (!getContext || !origGetImageData) return null;
      const w = canvasW.call(canvas), h = canvasH.call(canvas);
      if (!w || !h || w * h > MAX_PIXELS) return null;
      try {
        const tmp = createElement.call(doc, 'canvas');
        tmp.width = w; tmp.height = h;
        const ctx = getContext.call(tmp, '2d');
        origDrawImage.call(ctx, canvas, 0, 0);
        const img = origGetImageData.call(ctx, 0, 0, w, h);
        noisePixels(img.data, w, h, 0, 0);
        origPutImageData.call(ctx, img, 0, 0);
        return tmp;
      } catch (_) {
        return null; // 例如跨來源污染的畫布，讓原生函式自己丟出正確的錯誤
      }
    }

    if (on('canvas') && win.HTMLCanvasElement) {
      const P = win.HTMLCanvasElement.prototype;
      hookMethod(P, 'toDataURL', (orig) => ({
        toDataURL() {
          const tmp = noisyCopy(this);
          return Reflect.apply(orig, tmp || this, arguments);
        }
      }).toDataURL);
      hookMethod(P, 'toBlob', (orig) => ({
        toBlob(callback) {
          const tmp = noisyCopy(this);
          return Reflect.apply(orig, tmp || this, arguments);
        }
      }).toBlob);
    }

    // getImageData：多讀一欄一列判斷邊緣，結果與 toDataURL 的雜訊完全一致
    function hookGetImageData(proto) {
      hookMethod(proto, 'getImageData', (orig) => ({
        getImageData(sx, sy, sw, sh) {
          const img = Reflect.apply(orig, this, arguments);
          try {
            const w = img.width, h = img.height;
            if (w * h > MAX_PIXELS) return img;
            let ref = null, refW = 0;
            if (stealth && sw > 0 && sh > 0) {
              const args = [sx, sy, w + 1, h + 1];
              if (arguments.length > 4) args.push(arguments[4]);
              const ext = Reflect.apply(orig, this, args);
              ref = ext.data; refW = w + 1;
              noisePixels(img.data, w, h, sx | 0, sy | 0, ref, refW);
            } else {
              noisePixels(img.data, w, h, 0, 0);
            }
          } catch (_) {}
          return img;
        }
      }).getImageData);
    }
    if (on('canvas')) {
      hookGetImageData(C2D);
      hookGetImageData(OC2D);
    }

    // OffscreenCanvas.convertToBlob
    if (on('canvas') && win.OffscreenCanvas && OC2D) {
      const OP = win.OffscreenCanvas.prototype;
      const ocGetContext = OP.getContext;
      hookMethod(OP, 'convertToBlob', (orig) => ({
        convertToBlob() {
          let target = this;
          try {
            const w = this.width, h = this.height;
            if (w && h && w * h <= MAX_PIXELS) {
              const tmp = new win.OffscreenCanvas(w, h);
              const ctx = ocGetContext.call(tmp, '2d');
              ocDraw.call(ctx, this, 0, 0);
              const img = ocGet.call(ctx, 0, 0, w, h);
              noisePixels(img.data, w, h, 0, 0);
              ocPut.call(ctx, img, 0, 0);
              target = tmp;
            }
          } catch (_) { target = this; }
          return Reflect.apply(orig, target, arguments);
        }
      }).convertToBlob);
    }

    // ---------- WebGL ----------

    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const GL = win[name];
      if (!GL || !on('webgl')) continue;
      const P = GL.prototype;

      // readPixels：讀出的像素加雜訊
      hookMethod(P, 'readPixels', (orig) => ({
        readPixels(x, y, w, h, format, type, pixels) {
          const ret = Reflect.apply(orig, this, arguments);
          try {
            if (pixels instanceof win.Uint8Array && format === 0x1908 /* RGBA */ &&
                type === 0x1401 /* UNSIGNED_BYTE */ && w * h * 4 <= pixels.length &&
                w * h <= MAX_PIXELS) {
              noisePixels(pixels, w, h, x, y);
            }
          } catch (_) {}
          return ret;
        }
      }).readPixels);

      // getSupportedExtensions：數量與內容不變，只依種子打亂順序，
      // 讓「參數串接後取雜湊」的 WebGL 指紋每次都不同，功能完全不受影響
      hookMethod(P, 'getSupportedExtensions', (orig) => ({
        getSupportedExtensions() {
          const list = Reflect.apply(orig, this, arguments);
          if (!Array.isArray(list) || list.length < 2) return list;
          const out = list.slice().sort();
          for (let i = out.length - 1; i > 0; i--) {
            const j = hash(i, 0x5eed) % (i + 1);
            const t = out[i]; out[i] = out[j]; out[j] = t;
          }
          return out;
        }
      }).getSupportedExtensions);
    }

    // ---------- 顯示卡型號 ----------
    // 高階顯示卡（例如 RTX 4090）本身就很少見。同一代、同一家的顯示卡在 ANGLE/D3D11 下
    // WebGL 參數與擴充清單完全相同，只差型號字串，所以把型號（和裝置 ID）換成同代最常見的那張，
    // 其他數值都還是真的，WebGPU 回報的架構也對得上。
    if (opts.gpu !== false) try {
      const GPU_MAP = [
        [/NVIDIA GeForce RTX 40\d0(?: Ti)?(?: SUPER)? Laptop GPU/, 'NVIDIA GeForce RTX 4060 Laptop GPU', '000028E0'],
        [/NVIDIA GeForce RTX 40\d0(?: Ti)?(?: SUPER)?(?! Laptop)/, 'NVIDIA GeForce RTX 4060', '00002882'],
        [/NVIDIA GeForce RTX 30\d0(?: Ti)?(?: Laptop GPU)/, 'NVIDIA GeForce RTX 3060 Laptop GPU', '00002520'],
        [/NVIDIA GeForce RTX 30\d0(?: Ti)?(?! Laptop)/, 'NVIDIA GeForce RTX 3060', '00002504'],
        [/NVIDIA GeForce RTX 20\d0(?: Ti)?(?: SUPER)?(?! Laptop| with Max-Q)/, 'NVIDIA GeForce RTX 2060', '00001F08'],
        [/NVIDIA GeForce GTX 16\d0(?: Ti)?(?: SUPER)?(?! Laptop| with Max-Q)/, 'NVIDIA GeForce GTX 1650', '00001F82']
      ];
      const spoofGpu = (str, withId) => {
        if (typeof str !== 'string') return str;
        for (const [re, model, id] of GPU_MAP) {
          const m = re.exec(str);
          if (!m) continue;
          let out = str.slice(0, m.index) + model + str.slice(m.index + m[0].length);
          if (withId) out = out.replace(/\(0x[0-9A-Fa-f]{8}\)/, '(0x' + id + ')');
          return out;
        }
        return str;
      };

      for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
        const GL = win[name];
        if (!GL) continue;
        hookMethod(GL.prototype, 'getParameter', (orig) => ({
          getParameter(pname) {
            const v = Reflect.apply(orig, this, arguments);
            return pname === 0x9246 /* UNMASKED_RENDERER_WEBGL */ ? spoofGpu(v, true) : v;
          }
        }).getParameter);
      }
      if (win.GPUAdapterInfo) {
        hookGetter(win.GPUAdapterInfo.prototype, 'description', (orig) => Object.getOwnPropertyDescriptor({
          get description() { return spoofGpu(Reflect.apply(orig, this, []), false); }
        }, 'description').get);
      }
    } catch (_) {}

    // ---------- CPU 執行緒與記憶體 ----------
    // 超過 8 執行緒 / 8 GB 的一律回報 8（最常見的值）；Worker 裡也同步，頁面與 Worker 對得上
    if (opts.cpu !== false) try {
      for (const N of [win.Navigator, win.WorkerNavigator]) {
        if (!N) continue;
        for (const prop of ['hardwareConcurrency', 'deviceMemory']) {
          hookGetter(N.prototype, prop, (orig) => Object.getOwnPropertyDescriptor({
            get [prop]() {
              const v = Reflect.apply(orig, this, []);
              return typeof v === 'number' && v > 8 ? 8 : v;
            }
          }, prop).get);
        }
      }
    } catch (_) {}

    // ---------- 音訊 ----------

    if (on('audio') && win.AudioBuffer) {
      const P = win.AudioBuffer.prototype;
      const touched = new WeakMap(); // buffer -> 已加雜訊的聲道
      const origGetChannelData = P.getChannelData;

      function noiseChannel(buf, ch) {
        let set = touched.get(buf);
        if (!set) { set = new Set(); touched.set(buf, set); }
        if (set.has(ch)) return;
        set.add(ch);
        const data = Reflect.apply(origGetChannelData, buf, [ch]);
        // 隱匿模式：固定值、方波這類可預測的訊號不動（檢測站用固定 0.5 的訊號測雜訊）
        if (stealth && fewValues(data)) return;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (v === 0) continue; // 靜音保持靜音
          data[i] = v + ((hash(i, ch + 77) / 4294967296) - 0.5) * 2e-7;
        }
      }

      hookMethod(P, 'getChannelData', (orig) => ({
        getChannelData(channel) {
          const data = Reflect.apply(orig, this, arguments);
          try { noiseChannel(this, channel >>> 0); } catch (_) {}
          return data;
        }
      }).getChannelData);

      hookMethod(P, 'copyFromChannel', (orig) => ({
        copyFromChannel(destination, channelNumber) {
          try { if (channelNumber >>> 0 < this.numberOfChannels) noiseChannel(this, channelNumber >>> 0); } catch (_) {}
          return Reflect.apply(orig, this, arguments);
        }
      }).copyFromChannel);
    }

    if (on('audio') && win.AnalyserNode) {
      hookMethod(win.AnalyserNode.prototype, 'getFloatFrequencyData', (orig) => ({
        getFloatFrequencyData(array) {
          const ret = Reflect.apply(orig, this, arguments);
          try {
            for (let i = 0; i < array.length; i++) {
              if (Number.isFinite(array[i])) array[i] += ((hash(i, 991) / 4294967296) - 0.5) * 1e-4;
            }
          } catch (_) {}
          return ret;
        }
      }).getFloatFrequencyData);
    }

    // ---------- 文字量測 ----------
    // 所有寬度乘上同一個極接近 1 的係數：字型偵測靠「兩個寬度是否相等」，
    // 等式不受影響；但寬度數值本身變了，量測指紋就跟著變。

    if (on('text') && win.TextMetrics) {
      const factor = 1 + ((seed % 2001) - 1000) * 1e-8 + (seed % 2 ? 3e-6 : -3e-6);
      for (const prop of ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight']) {
        hookGetter(win.TextMetrics.prototype, prop, (orig) => Object.getOwnPropertyDescriptor({
          get [prop]() {
            const v = Reflect.apply(orig, this, arguments);
            return typeof v === 'number' ? v * factor : v;
          }
        }, prop).get);
      }
    }

    // ---------- 螢幕 ----------
    // 回報一個「裝得下目前視窗」的常見解析度（1920×1080 → 2560×1440 → 3840×2160），
    // 工作列高度、直橫向維持真實比例；matchMedia 的 device-width/height 與視窗座標也一起對齊，
    // 避免「視窗比螢幕還大」這種一看就假的矛盾。
    if (opts.screen === 'auto' && win.Screen) try {
      const SP = win.Screen.prototype;
      const g = (o, n) => { const d = Object.getOwnPropertyDescriptor(o, n); return d && d.get; };
      const rW = g(SP, 'width'), rH = g(SP, 'height'), rAW = g(SP, 'availWidth'), rAH = g(SP, 'availHeight');
      const wHolder = findHolder(win, 'outerWidth');
      const oW = g(wHolder, 'outerWidth'), oH = g(wHolder, 'outerHeight');
      const iW = g(wHolder, 'innerWidth'), iH = g(wHolder, 'innerHeight');
      const PRESETS = [[1920, 1080], [2560, 1440], [3840, 2160]];
      let cached = null;

      const target = (scr) => {
        const realW = rW.call(scr), realH = rH.call(scr);
        const ww = Math.max(oW ? oW.call(win) : 0, iW ? iW.call(win) : 0);
        const wh = Math.max(oH ? oH.call(win) : 0, iH ? iH.call(win) : 0);
        if (cached && cached[0] >= ww && cached[1] >= wh) return cached;
        const portrait = realH > realW;
        let t = null;
        for (const [a, b] of PRESETS) {
          const w = portrait ? b : a, h = portrait ? a : b;
          if (w >= ww && h >= wh) { t = [w, h]; break; }
        }
        cached = t || [realW, realH]; // 視窗比 4K 還大就用真實值
        return cached;
      };

      if (rW) hookGetter(SP, 'width', (orig) => Object.getOwnPropertyDescriptor({
        get width() { return target(this)[0]; } }, 'width').get);
      if (rH) hookGetter(SP, 'height', (orig) => Object.getOwnPropertyDescriptor({
        get height() { return target(this)[1]; } }, 'height').get);
      if (rAW) hookGetter(SP, 'availWidth', (orig) => Object.getOwnPropertyDescriptor({
        get availWidth() {
          return Math.max(0, target(this)[0] - (rW.call(this) - Reflect.apply(orig, this, [])));
        } }, 'availWidth').get);
      if (rAH) hookGetter(SP, 'availHeight', (orig) => Object.getOwnPropertyDescriptor({
        get availHeight() {
          return Math.max(0, target(this)[1] - (rH.call(this) - Reflect.apply(orig, this, [])));
        } }, 'availHeight').get);

      // 視窗座標：不能超出偽裝後的螢幕
      const scr = win.screen;
      for (const [name, axis] of [['screenX', 0], ['screenLeft', 0], ['screenY', 1], ['screenTop', 1]]) {
        const h = findHolder(win, name);
        if (!h || !g(h, name)) continue;
        hookGetter(h, name, (orig) => Object.getOwnPropertyDescriptor({
          get [name]() {
            const v = Reflect.apply(orig, this, []);
            const t = target(scr);
            const size = axis ? (oH ? oH.call(win) : 0) : (oW ? oW.call(win) : 0);
            return Math.max(0, Math.min(v, t[axis] - size));
          } }, name).get);
      }

      // matchMedia：device-width / device-height 依偽裝值改寫成恆真或恆假的條件
      const mqText = new WeakMap();
      const mmHolder = findHolder(win, 'matchMedia');
      if (mmHolder) hookMethod(mmHolder, 'matchMedia', (orig) => ({
        matchMedia(query) {
          if (!arguments.length) return Reflect.apply(orig, this, arguments);
          const q = String(query);
          if (!/device-(width|height)/i.test(q)) return Reflect.apply(orig, this, arguments);
          const t = target(scr);
          const rewritten = q.replace(/\(\s*(min-|max-)?device-(width|height)\s*:\s*([\d.]+)px\s*\)/gi,
            (m, pre, dim, val) => {
              const v = dim.toLowerCase() === 'width' ? t[0] : t[1];
              const n = parseFloat(val);
              const p = (pre || '').toLowerCase();
              const ok = p === 'min-' ? v >= n : p === 'max-' ? v <= n : v === n;
              return ok ? '(min-width: 0px)' : '(max-width: -1px)';
            });
          const mql = Reflect.apply(orig, this, [rewritten]);
          // media 屬性要回報「原本查詢」經瀏覽器正規化後的字串
          try { mqText.set(mql, Reflect.apply(origMedia, Reflect.apply(orig, this, [q]), [])); } catch (_) {}
          return mql;
        }
      }).matchMedia);
      const origMedia = win.MediaQueryList && g(win.MediaQueryList.prototype, 'media');
      if (origMedia) hookGetter(win.MediaQueryList.prototype, 'media', (orig) => Object.getOwnPropertyDescriptor({
        get media() {
          const q = mqText.get(this);
          return q != null ? q : Reflect.apply(orig, this, []);
        } }, 'media').get);
    } catch (_) {}

    // ---------- Worker ----------
    // 頁面（或 Worker 自己）建立 Worker 時，把 fpgMain 原始碼與同一個種子放在最前面：
    // - blob: Worker：原本的 Blob 前面接上保護程式，換成新的 blob: 網址（CSP 允許原本的就允許新的）
    // - http(s) Worker：用 blob 包一層 importScripts / import 原網址，並還原相對路徑與 location；
    //   若這個網站的 CSP 不允許 blob: Worker（背景記錄的旗標），就不包，免得把網站弄壞
    // SharedWorker 只包 blob:，http(s) 的包了會讓不同分頁連不到同一個 SharedWorker。

    if (win.URL && win.Blob) try {
      const URLC = win.URL;
      const origCreate = URLC.createObjectURL;
      hookMethod(URLC, 'createObjectURL', (orig) => ({
        createObjectURL(obj) {
          const url = Reflect.apply(orig, this, arguments);
          try { if (obj instanceof win.Blob) blobs.set(url, obj); } catch (_) {}
          return url;
        }
      }).createObjectURL);
      hookMethod(URLC, 'revokeObjectURL', (orig) => ({
        revokeObjectURL(url) {
          try { blobs.delete(String(url)); } catch (_) {}
          return Reflect.apply(orig, this, arguments);
        }
      }).revokeObjectURL);

      const isStrict = () => {
        if (strict !== null) return strict;
        try { return !!(win[STRICT_KEY] || (win.top && win.top[STRICT_KEY])); } catch (_) { return !!win[STRICT_KEY]; }
      };

      function wrapWorker(args, allowHttp) {
        if (!args.length) return null;
        const wopts = args[1]; // Worker 的建構選項（別和外層的 opts 設定搞混）
        const isModule = !!(wopts && typeof wopts === 'object' && wopts.type === 'module');
        const abs = new URLC(String(args[0]), base || win.location.href).href;
        const proto = abs.slice(0, abs.indexOf(':') + 1);
        const cacheKey = abs + '|' + isModule + '|' + allowHttp;
        const cached = wrapped.get(cacheKey);
        if (cached) { const a = Array.from(args); a[0] = cached; return a; }

        const strictNow = isStrict();
        const head = '(' + SELF_SRC + ')(' + seed + ',' + JSON.stringify(opts) + ',' +
                     JSON.stringify(abs) + ',' + strictNow + ');\n';
        const T = { type: 'text/javascript' };
        // 模組的 import 會先於本體執行，所以模組要「先 import 保護程式」才能搶在最前面
        const headImport = () => 'import ' +
          JSON.stringify(Reflect.apply(origCreate, URLC, [new win.Blob([head], T)])) + ';\n';
        let blob;
        if (proto === 'blob:') {
          const orig = blobs.get(abs);
          if (!orig) return null;
          blob = isModule && !strictNow ? new win.Blob([headImport(), orig], T)
                                        : new win.Blob([head, orig], T);
        } else if ((proto === 'http:' || proto === 'https:') && allowHttp && !strictNow) {
          blob = isModule
            ? new win.Blob([headImport(), 'import ' + JSON.stringify(abs) + ';'], T)
            : new win.Blob([head, 'importScripts(' + JSON.stringify(abs) + ');'], T);
        } else {
          return null;
        }
        const url = Reflect.apply(origCreate, URLC, [blob]);
        wrapped.set(cacheKey, url);
        const a = Array.from(args); a[0] = url;
        return a;
      }

      hookCtor(findHolder(win, 'Worker'), 'Worker', (args) => wrapWorker(args, true));
      hookCtor(findHolder(win, 'SharedWorker'), 'SharedWorker', (args) => wrapWorker(args, false));
    } catch (_) {}

    // 在包裝過的 Worker 裡：相對路徑要以原本的網址為準，location 也顯示原本的網址
    if (base && /^https?:/.test(base) && win === G && typeof win.WorkerGlobalScope === 'function') try {
      const resolve = (u) => new win.URL(String(u), base).href;
      const isRel = (u) => typeof u === 'string' || u instanceof win.URL;

      const holderIS = findHolder(win, 'importScripts');
      if (holderIS) hookMethod(holderIS, 'importScripts', (orig) => ({
        importScripts() {
          return Reflect.apply(orig, this, Array.from(arguments, (u) => resolve(u)));
        }
      }).importScripts);

      const holderF = findHolder(win, 'fetch');
      if (holderF) hookMethod(holderF, 'fetch', (orig) => ({
        fetch(input) {
          const a = Array.from(arguments);
          if (a.length && isRel(a[0])) a[0] = resolve(a[0]);
          return Reflect.apply(orig, this, a);
        }
      }).fetch);

      for (const name of ['Request', 'EventSource']) {
        hookCtor(findHolder(win, name), name, (args) => {
          if (!args.length || !isRel(args[0])) return null;
          const a = Array.from(args); a[0] = resolve(a[0]); return a;
        });
      }

      if (win.XMLHttpRequest) hookMethod(win.XMLHttpRequest.prototype, 'open', (orig) => ({
        open(method, url) {
          const a = Array.from(arguments);
          if (a.length > 1 && isRel(a[1])) a[1] = resolve(a[1]);
          return Reflect.apply(orig, this, a);
        }
      }).open);

      const holderL = findHolder(win, 'location');
      if (holderL && win.WorkerLocation) {
        const u = new win.URL(base);
        const fake = Object.create(win.WorkerLocation.prototype);
        for (const k of ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
          Object.defineProperty(fake, k, { value: u[k], enumerable: true });
        }
        const ts = ({ toString() { return u.href; } }).toString;
        const nts = win.WorkerLocation.prototype.toString;
        fakes.set(ts, nativeFnToString.call(typeof nts === 'function' ? nts : Object.prototype.toString));
        Object.defineProperty(fake, 'toString', { value: ts });
        hookGetter(holderL, 'location', () => Object.getOwnPropertyDescriptor({
          get location() { return fake; }
        }, 'location').get);
      }
    } catch (_) {}

    // ---------- 同源 iframe ----------
    // 頁面可以建立 iframe 後立刻從 contentWindow 拿乾淨的原生 API，
    // 所以第一次存取時就把同一套保護裝進去，種子也相同。

    for (const name of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement']) {
      const E = win[name];
      if (!E) continue;
      hookGetter(E.prototype, 'contentWindow', (orig) => Object.getOwnPropertyDescriptor({
        get contentWindow() {
          const w = Reflect.apply(orig, this, arguments);
          if (w) { try { install(w); } catch (_) {} }
          return w;
        }
      }, 'contentWindow').get);
      hookGetter(E.prototype, 'contentDocument', (orig) => Object.getOwnPropertyDescriptor({
        get contentDocument() {
          const d = Reflect.apply(orig, this, arguments);
          if (d && d.defaultView) { try { install(d.defaultView); } catch (_) {} }
          return d;
        }
      }, 'contentDocument').get);
    }
  }

  // 任何意外都不能影響網站自己的程式（在 Worker 裡保護程式和網站程式是同一個腳本）
  try { install(G); } catch (_) {}
}
//@@FPG_CORE_END
})();
