/** Shared Web Crypto helpers for Our Memory (PBKDF2 + AES-256-GCM). */
(function (global) {
  const META_URL = 'enc/meta.json';
  const KEY_STORAGE = 'love_aes_key';
  const META_SALT_KEY = 'love_meta_salt';
  const ENC_VERSION_KEY = 'love_enc_version';
  const LOGIN_FLAG = 'love_logged_in';
  const CONTENT_CACHE_KEY = 'love_content_cache_v1';

  const metaCache = { value: null, promise: null };
  const decryptCache = new Map();
  const mobilePackCache = new Map();
  const blobCache = new Map();
  const inflight = new Map();

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function report(onProgress, pct, stage, detail) {
    if (typeof onProgress === 'function') onProgress(pct, stage, detail);
  }

  function yieldToUI() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function formatBytes(n) {
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function readResponseBytes(res, onProgress, p0, p1) {
    var len = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader) {
      report(onProgress, p0 + (p1 - p0) * 0.5, '下载中', '正在获取资源…');
      await yieldToUI();
      var buf = new Uint8Array(await res.arrayBuffer());
      report(onProgress, p1, '下载完成', formatBytes(buf.length) + ' 已就绪');
      return buf;
    }
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;
    var lastReport = 0;
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.length;
      var now = Date.now();
      if (now - lastReport > 80 || received === result.value.length) {
        lastReport = now;
        var t;
        var detail;
        if (len > 0 && received <= len * 1.02) {
          t = p0 + Math.min(1, received / len) * (p1 - p0);
          detail = formatBytes(received) + ' / ' + formatBytes(len);
        } else {
          t = p0 + (1 - 1 / (1 + received / 600000)) * (p1 - p0);
          detail = '已下载 ' + formatBytes(received);
        }
        report(onProgress, t, '下载加密数据', detail);
      }
    }
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    report(onProgress, p1, '下载完成', formatBytes(total) + ' 已下载');
    return out;
  }

  function encUrl(path) {
    const ver = sessionStorage.getItem(ENC_VERSION_KEY) || metaCache.value?.salt || '';
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(ver);
  }

  async function fetchJsonWithProgress(url, onProgress, p0, p1, bustCache) {
    report(onProgress, p0, '连接服务器', '正在请求资源');
    var fetchUrl = bustCache ? encUrl(url) : url;
    var res = await fetch(fetchUrl, { cache: bustCache ? 'no-store' : 'default' });
    if (!res.ok) throw new Error('无法加载 ' + url);
    var mid = p0 + (p1 - p0) * 0.82;
    var bytes = await readResponseBytes(res, onProgress, p0, mid);
    report(onProgress, mid + (p1 - mid) * 0.3, '解析数据', '整理加密包…');
    if (global.LoveLoader && LoveLoader.startPulse) LoveLoader.startPulse(mid + (p1 - mid) * 0.6, '解析数据', '正在解析加密包…');
    await yieldToUI();
    var text = new TextDecoder().decode(bytes);
    report(onProgress, mid + (p1 - mid) * 0.7, '解析数据', '校验格式…');
    await yieldToUI();
    var parsed = JSON.parse(text);
    if (global.LoveLoader && LoveLoader.stopPulse) LoveLoader.stopPulse();
    report(onProgress, p1, '解析完成', '加密包已就绪');
    return parsed;
  }

  async function loadMeta(onProgress) {
    if (metaCache.value) {
      report(onProgress, 8, '读取配置', '已使用缓存');
      return metaCache.value;
    }
    if (metaCache.promise) return metaCache.promise;
    metaCache.promise = fetchJsonWithProgress(META_URL, onProgress, 2, 8, true)
      .then(function (meta) {
        metaCache.value = meta;
        return meta;
      })
      .finally(function () {
        metaCache.promise = null;
      });
    return metaCache.promise;
  }

  async function deriveKey(password, meta) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(meta.salt),
        iterations: meta.iterations || 100000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: (meta.keyLen || 32) * 8 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  async function exportRawKey(key) {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    return bytesToB64(raw);
  }

  async function importRawKey(b64) {
    return crypto.subtle.importKey(
      'raw',
      b64ToBytes(b64),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
  }

  function isLov1(bytes) {
    return bytes.length >= 16 && bytes[0] === 0x4c && bytes[1] === 0x4f && bytes[2] === 0x56 && bytes[3] === 0x31;
  }

  async function fetchEncFile(encPath, onProgress, p0, p1) {
    report(onProgress, p0, '连接服务器', '正在请求资源');
    var res = await fetch(encUrl(encPath), { cache: 'no-store' });
    if (!res.ok) throw new Error('无法加载 ' + encPath);
    var dlEnd = p0 + (p1 - p0) * 0.82;
    return readResponseBytes(res, onProgress, p0, dlEnd);
  }

  async function decryptRawBytes(key, bytes, onProgress, p0, p1) {
    if (isLov1(bytes)) {
      report(onProgress, p0 + (p1 - p0) * 0.15, 'AES 解密', '二进制解锁…');
      await yieldToUI();
      var iv = bytes.subarray(4, 16);
      var ct = bytes.subarray(16);
      report(onProgress, p0 + (p1 - p0) * 0.45, 'AES 解密', '正在解锁 (' + formatBytes(ct.length) + ')…');
      if (global.LoveLoader && LoveLoader.startPulse) LoveLoader.startPulse(p0 + (p1 - p0) * 0.85, 'AES 解密', '请稍候，解密中…');
      await yieldToUI();
      try {
        var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
        if (global.LoveLoader && LoveLoader.stopPulse) LoveLoader.stopPulse();
        report(onProgress, p1, '解密完成', '内容已解锁');
        return new Uint8Array(plain);
      } catch (e) {
        if (global.LoveLoader && LoveLoader.stopPulse) LoveLoader.stopPulse();
        var err = new Error('解密失败，请退出后重新登录');
        err.code = 'DECRYPT_FAILED';
        err.cause = e;
        throw err;
      }
    }
    report(onProgress, p0 + (p1 - p0) * 0.2, '解析数据', '兼容旧格式…');
    await yieldToUI();
    var text = new TextDecoder().decode(bytes);
    var payload = JSON.parse(text);
    return decryptPayload(key, payload, onProgress, p0 + (p1 - p0) * 0.25, p1);
  }

  async function decryptPayload(key, payload, onProgress, p0, p1) {
    report(onProgress, p0, 'AES 解密', '准备密钥…');
    await yieldToUI();
    var iv = b64ToBytes(payload.iv);
    report(onProgress, p0 + (p1 - p0) * 0.25, 'AES 解密', '读取密文…');
    await yieldToUI();
    var ct = b64ToBytes(payload.ct);
    report(onProgress, p0 + (p1 - p0) * 0.45, 'AES 解密', '正在解锁 (' + formatBytes(ct.length) + ')…');
    if (global.LoveLoader && LoveLoader.startPulse) LoveLoader.startPulse(p0 + (p1 - p0) * 0.85, 'AES 解密', '请稍候，大文件解密中…');
    await yieldToUI();
    try {
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      if (global.LoveLoader && LoveLoader.stopPulse) LoveLoader.stopPulse();
      report(onProgress, p1, '解密完成', '内容已解锁');
      return new Uint8Array(plain);
    } catch (e) {
      var err = new Error('解密失败，请退出后重新登录');
      err.code = 'DECRYPT_FAILED';
      err.cause = e;
      throw err;
    }
  }

  async function ensureSessionValid() {
    const meta = await loadMeta();
    const storedSalt = sessionStorage.getItem(META_SALT_KEY);
    const storedVer = sessionStorage.getItem(ENC_VERSION_KEY);
    const ver = String(meta.encVersion || meta.salt || '');
    const hasKey = !!sessionStorage.getItem(KEY_STORAGE);

    if (hasKey && !storedSalt) {
      clearSession();
      throw new Error('请重新登录以解锁最新内容');
    }
    if (storedSalt && storedSalt !== meta.salt) {
      clearSession();
      throw new Error('站点已更新，请重新登录');
    }
    if (storedVer && ver && storedVer !== ver) {
      clearSession();
      throw new Error('站点已更新，请重新登录');
    }
    return meta;
  }

  async function fetchAndDecrypt(key, encPath, onProgress) {
    if (decryptCache.has(encPath)) {
      report(onProgress, 95, '读取缓存', '秒开模式');
      return decryptCache.get(encPath);
    }
    if (inflight.has(encPath)) {
      return inflight.get(encPath);
    }
    const task = (async function () {
      const raw = await fetchEncFile(encPath, onProgress, 10, 72);
      const bytes = await decryptRawBytes(key, raw, onProgress, 72, 96);
      decryptCache.set(encPath, bytes);
      return bytes;
    })();
    inflight.set(encPath, task);
    try {
      return await task;
    } finally {
      inflight.delete(encPath);
    }
  }

  async function fetchAndDecryptText(key, encPath, onProgress) {
    const bytes = await fetchAndDecrypt(key, encPath, onProgress);
    return new TextDecoder().decode(bytes);
  }

  async function fetchAndDecryptJson(key, encPath, onProgress) {
    return JSON.parse(await fetchAndDecryptText(key, encPath, onProgress));
  }

  function saveSessionKey(rawB64, meta) {
    sessionStorage.setItem(KEY_STORAGE, rawB64);
    sessionStorage.setItem(LOGIN_FLAG, 'true');
    if (meta) {
      sessionStorage.setItem(META_SALT_KEY, meta.salt || '');
      sessionStorage.setItem(ENC_VERSION_KEY, String(meta.encVersion || meta.salt || ''));
    }
    localStorage.removeItem(LOGIN_FLAG);
  }

  function clearSession() {
    sessionStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(META_SALT_KEY);
    sessionStorage.removeItem(ENC_VERSION_KEY);
    sessionStorage.removeItem(LOGIN_FLAG);
    sessionStorage.removeItem(CONTENT_CACHE_KEY);
    sessionStorage.removeItem('love_viewer_title');
    localStorage.removeItem(LOGIN_FLAG);
    decryptCache.clear();
    mobilePackCache.clear();
    blobCache.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    });
    blobUrls.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    });
    blobCache.clear();
    blobUrls.clear();
    idbClear();
  }

  function getSessionKeyB64() {
    return sessionStorage.getItem(KEY_STORAGE);
  }

  async function getSessionKey() {
    const b64 = getSessionKeyB64();
    if (!b64) return null;
    return importRawKey(b64);
  }

  async function unlockWithPassword(username, password, onProgress) {
    report(onProgress, 3, '验证身份', '读取安全配置');
    const meta = await loadMeta(onProgress);
    report(onProgress, 18, '派生密钥', 'PBKDF2 · 10万次迭代');
    // Yield so UI can paint progress before heavy KDF
    await new Promise(function (r) { setTimeout(r, 30); });
    const key = await deriveKey(password, meta);
    report(onProgress, 42, '校验口令', '解密身份凭证');
    let auth;
    try {
      auth = await fetchAndDecryptJson(key, 'enc/auth.enc', function (p, s, d) {
        report(onProgress, 42 + p * 0.2, s, d);
      });
    } catch (e) {
      throw new Error('密码错误');
    }
    if (!auth || !auth.ok || auth.username !== username) {
      throw new Error('用户名或密码错误');
    }
    const raw = await exportRawKey(key);
    saveSessionKey(raw, meta);
    report(onProgress, 70, '预加载内容', '解锁时间线与信件');
    try {
      const content = await fetchAndDecryptJson(key, 'enc/content.enc', function (p, s, d) {
        report(onProgress, 70 + p * 0.28, s, d);
      });
      sessionStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(content));
    } catch (e) {
      /* non-fatal */
    }
    report(onProgress, 100, '完成', '正在进入…');
    setTimeout(function () {
      preloadChats();
    }, 800);
    return key;
  }

  async function loadSiteContent(key, onProgress) {
    const cached = sessionStorage.getItem(CONTENT_CACHE_KEY);
    if (cached) {
      report(onProgress, 90, '读取本地缓存', '即将呈现');
      try {
        const data = JSON.parse(cached);
        report(onProgress, 100, '完成', '欢迎回来');
        return data;
      } catch (e) {
        sessionStorage.removeItem(CONTENT_CACHE_KEY);
      }
    }
    const content = await fetchAndDecryptJson(key, 'enc/content.enc', onProgress);
    try {
      sessionStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(content));
    } catch (e) {}
    report(onProgress, 100, '完成', '渲染记忆中');
    return content;
  }

  const ENC_MAP = {
    '微信聊天记录导出/高铭怡聊天记录.html': 'enc/wechat-chat.enc',
    '抖音聊天记录导出/抖音聊天记录.html': 'enc/douyin-chat.enc',
    '微信聊天记录导出/微信聊天频率分析报告.html': 'enc/wechat-freq.enc',
    '抖音聊天记录导出/聊天频率分析报告.html': 'enc/douyin-freq.enc',
    '性格分析报告/性格分析报告.html': 'enc/personality.enc',
    'AI智能体/AI智能体.html': 'enc/ai-agent.enc',
  };

  const MOBILE_ENC_MAP = {
    '微信聊天记录导出/高铭怡聊天记录.html': 'enc/wechat-mobile.enc',
    '抖音聊天记录导出/抖音聊天记录.html': 'enc/douyin-mobile.enc',
  };

  const TITLE_MAP = {
    '微信聊天记录导出/高铭怡聊天记录.html': '微信聊天记录',
    '抖音聊天记录导出/抖音聊天记录.html': '抖音聊天记录',
    '微信聊天记录导出/微信聊天频率分析报告.html': '微信频率分析',
    '抖音聊天记录导出/聊天频率分析报告.html': '抖音频率分析',
    '性格分析报告/性格分析报告.html': '性格分析报告',
    'AI智能体/AI智能体.html': 'AI智能体',
  };

  function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    var ua = navigator.userAgent || '';
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
    return (navigator.maxTouchPoints > 1 && window.innerWidth <= 900);
  }

  function isWeChatBrowser() {
    return /MicroMessenger/i.test((navigator && navigator.userAgent) || '');
  }

  function shouldUseModal(target) {
    if (isWeChatBrowser()) return false;
    return target === 'modal' || (target === 'tab' && isMobileDevice());
  }

  function shouldUseViewer() {
    return isWeChatBrowser();
  }

  function shouldUseViewerFor(legacyPath) {
    if (isWeChatBrowser()) return true;
    if (isMobileDevice() && CHAT_PATHS.indexOf(legacyPath) >= 0) return true;
    return false;
  }

  function useMobilePack(legacyPath) {
    return (isMobileDevice() || isWeChatBrowser()) && !!MOBILE_ENC_MAP[legacyPath];
  }

  function getEncPath(legacyPath) {
    if (useMobilePack(legacyPath)) return MOBILE_ENC_MAP[legacyPath];
    return ENC_MAP[legacyPath];
  }

  var VIEWER_SHORT = {
    'wechat-chat': '微信聊天记录导出/高铭怡聊天记录.html',
    'douyin-chat': '抖音聊天记录导出/抖音聊天记录.html',
    'wechat-freq': '微信聊天记录导出/微信聊天频率分析报告.html',
    'douyin-freq': '抖音聊天记录导出/聊天频率分析报告.html',
    'personality': '性格分析报告/性格分析报告.html',
    'ai-agent': 'AI智能体/AI智能体.html',
  };

  var PATH_TO_SHORT = {};
  Object.keys(VIEWER_SHORT).forEach(function (k) {
    PATH_TO_SHORT[VIEWER_SHORT[k]] = k;
  });

  var IDB_NAME = 'love_memory_viewer_v1';
  var IDB_STORE = 'pages';

  function openViewerDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('浏览器不支持 IndexedDB'));
        return;
      }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function (e) {
        if (!e.target.result.objectStoreNames.contains(IDB_STORE)) {
          e.target.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
  }

  async function idbSet(key, bytes) {
    var db = await openViewerDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function idbGet(key) {
    var db = await openViewerDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbClear() {
    try {
      var db = await openViewerDb();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) {
      /* ignore */
    }
  }

  async function getDecryptedBytes(legacyPath, onProgress) {
    var encPath = getEncPath(legacyPath);
    if (!encPath) throw new Error('未知资源');
    await ensureSessionValid();
    var key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }
    return fetchAndDecrypt(key, encPath, onProgress);
  }

  async function getDecryptedChatPack(legacyPath, onProgress) {
    var encPath = getEncPath(legacyPath);
    if (mobilePackCache.has(encPath)) {
      report(onProgress, 95, '读取缓存', '聊天包已就绪');
      return mobilePackCache.get(encPath);
    }
    await ensureSessionValid();
    var key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }
    var bytes = await fetchAndDecrypt(key, encPath, onProgress);
    report(onProgress, 97, '解析消息', '整理聊天数据…');
    await yieldToUI();
    var pack = JSON.parse(new TextDecoder().decode(bytes));
    mobilePackCache.set(encPath, pack);
    return pack;
  }

  async function ensureViewerCached(legacyPath, onProgress) {
    var vid = PATH_TO_SHORT[legacyPath];
    if (!vid) throw new Error('未知页面');
    report(onProgress, 8, '读取缓存', '检查本地存储…');
    await yieldToUI();
    var cached = await idbGet(vid);
    if (cached) {
      if (global.LoveChatViewer && LoveChatViewer.isChatPack(cached)) {
        mobilePackCache.set(getEncPath(legacyPath), cached);
      }
      report(onProgress, 100, '读取缓存', '本地秒开');
      return { vid: vid, cached: cached };
    }
    if (useMobilePack(legacyPath)) {
      var pack = await getDecryptedChatPack(legacyPath, onProgress);
      if (!pack) return null;
      report(onProgress, 90, '本地缓存', '正在保存聊天包…');
      await yieldToUI();
      await idbSet(vid, pack);
      report(onProgress, 97, '本地缓存', '保存完成');
      return { vid: vid, cached: pack };
    }
    var bytes = await getDecryptedBytes(legacyPath, onProgress);
    if (!bytes) return null;
    report(onProgress, 90, '本地缓存', '正在保存 (' + formatBytes(bytes.length) + ')…');
    await yieldToUI();
    await idbSet(vid, bytes);
    report(onProgress, 97, '本地缓存', '保存完成');
    return { vid: vid, cached: bytes };
  }

  async function openInViewer(legacyPath, title, onProgress) {
    title = title || TITLE_MAP[legacyPath] || '内容';
    sessionStorage.setItem('love_viewer_title', title);
    var info = await ensureViewerCached(legacyPath, onProgress);
    if (!info) return null;
    report(onProgress, 100, '跳转', '正在打开页面…');
    await yieldToUI();
    location.href = 'viewer.html?v=' + encodeURIComponent(info.vid);
    return info;
  }

  function viewerBackBar(title) {
    return (
      '<div id="loveViewerBack" style="position:sticky;top:0;z-index:999999;' +
      'padding:max(10px,env(safe-area-inset-top)) 14px 10px;background:rgba(255,245,247,.96);' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(233,30,99,.15);' +
      'display:flex;align-items:center;gap:10px;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;">' +
      '<a href="index.html" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;' +
      'border-radius:20px;background:linear-gradient(135deg,#E91E63,#B57EDC);color:#fff;text-decoration:none;' +
      'font-size:14px;font-weight:600;">← 返回</a>' +
      '<span style="font-size:14px;color:#7A6B7A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
      (title.replace(/</g, '&lt;')) + '</span></div>'
    );
  }

  async function renderViewerPage(vid) {
    var legacyPath = VIEWER_SHORT[vid];
    if (!legacyPath) throw new Error('无效的页面参数');
    var title = sessionStorage.getItem('love_viewer_title') || TITLE_MAP[legacyPath] || '';
    LoveLoader.set(10, '加载', '读取本地缓存…');
    await yieldToUI();
    var cached = await idbGet(vid);
    if (!cached) {
      LoveLoader.set(15, '解密', '首次加载，正在解密…');
      if (useMobilePack(legacyPath)) {
        cached = await getDecryptedChatPack(legacyPath, function (p, s, d) {
          LoveLoader.set(Math.min(85, p), s, d);
        });
        if (cached) {
          LoveLoader.set(88, '缓存', '正在保存…');
          await yieldToUI();
          await idbSet(vid, cached);
        }
      } else {
        var bytes = await getDecryptedBytes(legacyPath, function (p, s, d) {
          LoveLoader.set(Math.min(85, p), s, d);
        });
        if (bytes) {
          LoveLoader.set(88, '缓存', '正在保存…');
          await yieldToUI();
          await idbSet(vid, bytes);
          cached = bytes;
        }
      }
    } else if (global.LoveChatViewer && LoveChatViewer.isChatPack(cached)) {
      LoveLoader.set(55, '加载', '已从缓存读取聊天包');
    } else {
      LoveLoader.set(55, '加载', '已从缓存读取 (' + formatBytes(cached.byteLength || cached.length || 0) + ')');
    }
    if (!cached) throw new Error('内容为空');

    if (global.LoveChatViewer && LoveChatViewer.isChatPack(cached)) {
      document.body.innerHTML = viewerBackBar(title) + '<div id="loveChatRoot"></div>';
      LoveLoader.set(96, '渲染', '正在显示聊天…');
      await yieldToUI();
      await LoveChatViewer.render(document.getElementById('loveChatRoot'), cached, function (p, s, d) {
        LoveLoader.set(96 + p * 0.03, s, d);
      });
      LoveLoader.set(100, '完成', '欢迎查看');
      LoveLoader.hide(100);
      return;
    }

    var bytes = cached instanceof Uint8Array ? cached : new Uint8Array(cached);
    await yieldToUI();
    LoveLoader.set(92, '渲染', '正在解码页面…');
    await yieldToUI();
    var html = new TextDecoder().decode(bytes);
    LoveLoader.set(96, '渲染', '正在显示内容…');
    await yieldToUI();
    LoveLoader.set(100, '完成', '欢迎查看');
    LoveLoader.hide(100);
    await yieldToUI();
    document.open('text/html', 'replace');
    document.write(viewerBackBar(title) + html);
    document.close();
  }

  const CHAT_PATHS = [
    '微信聊天记录导出/高铭怡聊天记录.html',
    '抖音聊天记录导出/抖音聊天记录.html',
  ];

  function hasCachedHtml(legacyPath) {
    var encPath = getEncPath(legacyPath);
    return blobCache.has(legacyPath) || (encPath && decryptCache.has(encPath)) || mobilePackCache.has(encPath);
  }

  const blobUrls = new Set();

  async function preloadChats(onProgress) {
    if (!isMobileDevice() && !isWeChatBrowser()) return;
    var key = await getSessionKey();
    if (!key) return;
    await Promise.all(
      CHAT_PATHS.map(function (p) {
        return (async function () {
          var vid = PATH_TO_SHORT[p];
          if (vid) {
            try {
              var idbHit = await idbGet(vid);
              if (idbHit) return;
            } catch (e) {}
          }
          var encPath = getEncPath(p);
          if (!encPath) return;
          if (mobilePackCache.has(encPath) || decryptCache.has(encPath)) return;
          try {
            if (useMobilePack(p)) {
              var pack = await getDecryptedChatPack(p, function (pct, stage, detail) {
                if (typeof onProgress === 'function') onProgress(p, pct, stage, detail);
              });
              if (pack && vid) {
                try {
                  await idbSet(vid, pack);
                } catch (e) {}
              }
              return;
            }
            await fetchAndDecrypt(key, encPath, function (pct, stage, detail) {
              if (typeof onProgress === 'function') onProgress(p, pct, stage, detail);
            });
            var bytes = decryptCache.get(encPath);
            if (bytes) {
              if (vid) {
                try {
                  await idbSet(vid, bytes);
                } catch (e) {}
              }
              if (!blobCache.has(p) && !isWeChatBrowser()) {
                var blob = new Blob([bytes], { type: 'text/html; charset=utf-8' });
                var url = URL.createObjectURL(blob);
                blobUrls.add(url);
                blobCache.set(p, url);
              }
            }
          } catch (e) {
            /* non-fatal preload */
          }
        })();
      })
    );
  }

  function revokeBlob(url) {
    if (url && blobUrls.has(url)) {
      URL.revokeObjectURL(url);
      blobUrls.delete(url);
    }
  }

  async function openDecryptedHtml(legacyPath, opts) {
    opts = opts || {};
    var target = opts.target || 'tab';
    var title = opts.title || TITLE_MAP[legacyPath] || '';
    var onProgress = opts.onProgress;
    var encPath = getEncPath(legacyPath);
    if (!encPath) throw new Error('未知资源: ' + legacyPath);
    await ensureSessionValid();
    var key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }

    var url = blobCache.get(legacyPath);
    if (!url) {
      var bytes = await fetchAndDecrypt(key, encPath, onProgress);
      report(onProgress, 98, '生成预览', '即将打开');
      var blob = new Blob([bytes], { type: 'text/html; charset=utf-8' });
      url = URL.createObjectURL(blob);
      blobUrls.add(url);
      blobCache.set(legacyPath, url);
    } else {
      report(onProgress, 100, '读取缓存', '秒开');
    }

    var useModal = shouldUseModal(target);
    if (!useModal && target === 'tab') {
      var w = window.open(url, '_blank');
      if (!w) {
        report(onProgress, 100, '完成', '弹窗被拦截，改用内嵌打开');
        return { url: url, title: title, popupBlocked: true, revoke: function () {} };
      }
      report(onProgress, 100, '完成', '已打开');
      return { url: url, title: title, openedInTab: true, revoke: function () {} };
    }

    report(onProgress, 100, '完成', '已就绪');
    return { url: url, title: title, forModal: useModal || target === 'none', revoke: function () {} };
  }

  global.LoveCrypto = {
    META_URL,
    KEY_STORAGE,
    META_SALT_KEY,
    ENC_VERSION_KEY,
    CONTENT_CACHE_KEY,
    ensureSessionValid,
    loadMeta,
    deriveKey,
    unlockWithPassword,
    getSessionKey,
    getSessionKeyB64,
    clearSession,
    loadSiteContent,
    fetchAndDecryptText,
    fetchAndDecryptJson,
    fetchAndDecrypt,
    openDecryptedHtml,
    ENC_MAP,
    TITLE_MAP,
    isMobileDevice,
    isWeChatBrowser,
    shouldUseViewer,
    shouldUseViewerFor,
    openInViewer,
    renderViewerPage,
    preloadChats,
    hasCachedHtml,
    revokeBlob,
  };
})(window);
