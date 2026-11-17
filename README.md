# 指紋護盾（Chrome 擴充功能）

替網站常用來追蹤你的瀏覽器指紋加入微量雜訊：**每次載入頁面就換一組**，網站無法用指紋長期認出你。

## 安裝
1. 解壓縮，開啟 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 「載入未封裝項目」→ 選 `fp-guard` 資料夾
4. 到 https://who.1ms.dog/zh-cn/ 檢測

## 保護項目
| 指紋來源 | 做法 |
|---|---|
| Canvas（toDataURL / toBlob / getImageData / OffscreenCanvas） | 翻轉部分像素最低位元，肉眼看不出 |
| WebGL | readPixels 加雜訊；getSupportedExtensions 依種子打亂順序（內容與數量不變） |
| 音訊 | AudioBuffer、AnalyserNode 加 1e-7 等級的雜訊（聽不出來） |
| 文字量測 | measureText 所有寬度乘上同一個接近 1 的係數，字型偵測結果不變 |
| Worker / SharedWorker | 建立 Worker 時把同一套保護（同一個種子）放在腳本最前面，Worker 裡的 OffscreenCanvas、WebGL、measureText 一樣加雜訊，算出來的值和頁面一致 |
| 螢幕 | 回報一個裝得下目前視窗的常見解析度（1920×1080 → 2560×1440 → 3840×2160），工作列高度、`matchMedia` 的 device-width/height、視窗座標一起對齊 |
| 顯示卡型號 | 高階卡換成同代最常見型號與裝置 ID（RTX 40 系列 → RTX 4060、30 → 3060、20 → 2060、GTX 16 → 1650，筆電版對應筆電版）；同代顯示卡在 ANGLE/D3D11 下其他 WebGL 參數完全相同，WebGPU 架構也對得上。RTX 50 系列與 Intel/AMD 不變 |
| CPU／記憶體 | `hardwareConcurrency`、`deviceMemory` 超過 8 時回報 8，頁面與 Worker 一致 |
| Service Worker（選用） | 透過 Chrome 偵錯協定，在 Service Worker 執行第一行程式前暫停、注入同一套保護再放行 |
| 同源 iframe | 第一次存取 contentWindow 就裝上同一套保護、同一個種子 |

## 不會被抓到的細節
- 被替換的函式在 `Function.prototype.toString` 下仍是 `[native code]`，名稱、length、不可 `new` 都和原生一致（偵測站「環境被篡改」：沒發現）。
- 同一頁畫兩次結果相同（偵測站「防指紋：畫兩次完全一樣」）。
- **不改** navigator / screen / UA / 時區：改了反而會跟 Worker、HTTP 標頭對不上。

## 分站代理
指定的網站走指定的 proxy，其他網站照常直連。
- **設定頁**（擴充功能的「選項」，或彈出視窗的「管理…」）：新增 proxy（HTTP／HTTPS／SOCKS5／SOCKS4，HTTP 類可填帳號密碼，會自動登入），再新增「網域 → proxy」規則。
- **彈出視窗**：「此網站的代理」下拉選單可以直接把目前網站（含子網域）指定給某個 proxy，立即生效；已經開著的頁面重新整理即可。
- 規則寫法：`example.com` 含所有子網域、`*.example.com` 只含子網域，也可用 `*`、`?` 萬用字元；由上往下比對，第一條符合的生效。
- **proxy 連不上時，該網站直接連線失敗，不會偷偷改用真實 IP。**
- **測試**：每個 proxy 旁的「測試」會經由它連到 ifconfig.co，顯示出口 IP、國家與延遲；失敗時會說明原因（proxy 沒開、帳密錯誤、連不到目標等）。
- **連線檢查**：設定頁最上方會顯示規則是否真的套用到 Chrome、是否被其他擴充功能（例如 SwitchyOmega、VPN 擴充）或系統原則搶走控制權、無痕視窗是否套用，以及最近的 proxy 錯誤。
- 無痕視窗：在 chrome://extensions 允許指紋護盾「在無痕模式下執行」後，規則也會套用到無痕視窗。
- **防 WebRTC 洩漏**（預設開）：有代理規則時，WebRTC 只能走 proxy，避免網站從 WebRTC 看到真實 IP。這是全瀏覽器設定，直連網站的視訊通話品質可能變差。
- 限制：
  - 比對的是「每個請求的主機名稱」，不是分頁。網頁載入的其他網域（CDN、API、登入頁）要另外加規則，否則那些請求會直連。
  - Chrome 不支援需要帳密的 SOCKS proxy。
  - 同一時間只能有一個擴充功能控制 Chrome 的 proxy；裝了其他 VPN／proxy 擴充時，設定頁頂端會提示。
  - 走國外 proxy 時，時區、語言還是台灣的，檢測站的「時區和 IP」會標示不一致。

## 一鍵設定
- **全部打亂**（預設）：所有項目加雜訊，每次載入都不同。檢測站會把 Canvas／WebGL／音訊／綜合指紋標成「獨一份」——因為沒有人跟你一樣，但下次又變了，追蹤不到。
- **混入人群**：不加雜訊，只偽裝少見的硬體（顯示卡型號、CPU、螢幕）。數值跟很多人的真實值相同（例如音訊會回到常見值 `c40eda39·b983616b`），但同一台電腦每次都一樣；檢測站的「指紋追蹤」會顯示「一直不變」。

## 每一項都能單獨開關
彈出視窗可以分別開關 Canvas、WebGL、音訊、文字量測、螢幕偽裝、Service Worker。

**關於「少見／常見／獨一份」**：偵測站是拿你的數值去跟其他訪客做完全比對。
- 加了雜訊的項目每次都是新值，所以會顯示「獨一份」，但下次就變了，網站無法拿來追蹤。
- 想顯示「常見」，就得剛好等於很多人的真實值。螢幕可以做到（偽裝成常見解析度）；音訊在 Chrome 上本來就是常見值，關掉音訊雜訊即可。
- Canvas／WebGL 沒辦法憑空做出「別人的真實值」。如果你的顯示卡顯示為 `Microsoft Basic Render Driver`，代表 Chrome 沒用到顯示卡（硬體加速關閉或驅動異常），這本身就很少見；到 `chrome://settings/system` 開啟「使用圖形加速功能」並更新顯示卡驅動，通常就會變回常見值。

## Service Worker 保護（預設關閉）
擴充功能的 content script 進不了 Service Worker，網站也不能用 blob 註冊 Service Worker，所以唯一能搶在網站程式之前動手的方法是 `chrome.debugger`：
- 「偵錯」權限是安裝時就宣告的（Chrome 不允許它當選用權限），但只有打開這個開關，套件才會真的附加偵錯器；開啟期間 Chrome 頂端會一直顯示「指紋護盾 已開始對這個瀏覽器進行偵錯」，按提示列的「取消」等同關閉此功能。
- 已經在執行中的 Service Worker 是晚一步注入，之後的指紋呼叫才會被保護。
- 和 DevTools 可以同時使用；但會跟 Puppeteer／Playwright 這類自動化工具互搶。

## 兩種模式（在彈出視窗切換）
- **隱匿模式（預設）**：只對「顏色／數值種類很多」的內容加雜訊（文字、漸層、emoji、振盪器音訊——也就是真正拿來算指紋的東西）。檢測站用來比對的純色、色塊、棋盤格、固定值音訊完全不動，所以測不到雜訊；被替換的 54 個介面也都通過「原生函式」與「乾淨 iframe 對照」檢查。指紋仍每次不同，但檢測站只靠「測不測得到雜訊」推斷，會顯示「指紋追蹤：一直不變」。
- **打亂模式**：連純色區塊也加雜訊，效果類似 Brave。檢測站顯示「按網站打亂」，但新版檢測站會把測到的雜訊判定為「環境被篡改」。

## 其他
- 彈出視窗可以對目前網站停用（例如網銀誤判時）。改設定後重新整理分頁生效。
## Worker 保護的細節
- **blob: Worker**（指紋腳本最常用）：在原本的程式前面接上保護程式，換成新的 blob 網址。網站的 CSP 允許原本的，就一定允許新的。
- **一般網址的 Worker**：用 blob 包一層再載入原檔，並把 `importScripts`、`fetch`、`XMLHttpRequest`、`Request` 的相對路徑和 `self.location` 還原成原網址，網站程式不會察覺。
- **模組 Worker**（`type: 'module'`）：先 import 保護程式，確保它比網站的模組先執行。
- **Worker 裡再開 Worker**：一樣會被保護。
- **CSP 不允許 blob: 的網站**：背景會從回應標頭記下這些網站，之後就不包裝一般網址的 Worker，以免把網站弄壞（這種網站本來就不能用 blob Worker 做指紋）。

## 已知限制
- CSP 不允許 blob: 的網站上，一般網址的 Worker 不受保護；用 `<meta>` 宣告的 CSP 背景看不到，第一次載入可能讓那種 Worker 失敗，重新整理就好。
- 一般網址的 SharedWorker 不包裝（包了會讓不同分頁連不到同一個 SharedWorker）。
- `window.frames[i]` 直接存取 iframe 不在保護範圍。
- IP、DNS、時區、語言這類網路層資訊要靠 VPN/代理處理，擴充功能管不到。
