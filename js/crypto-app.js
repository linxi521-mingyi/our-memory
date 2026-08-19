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

  async function readResponseBytes(res, onProgress, p0, p1) {
    const len = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      report(onProgress, p1, '下载完成', '资源已就绪');
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      let t;
      if (len > 0) {
        t = p0 + (received / len) * (p1 - p0);
      } else {
        t = p0 + (1 - 1 / (1 + received / 800000)) * (p1 - p0);
      }
      const mb = (received / 1048576).toFixed(1);
      report(onProgress, t, '下载加密数据', len ? mb + ' / ' + (len / 1048576).toFixed(1) + ' MB' : mb + ' MB');
    }
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  function encUrl(path) {
    const ver = sessionStorage.getItem(ENC_VERSION_KEY) || metaCache.value?.salt || '';
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(ver);
  }

  async function fetchJsonWithProgress(url, onProgress, p0, p1, bustCache) {
    report(onProgress, p0, '连接服务器', '正在请求资源');
    const fetchUrl = bustCache ? encUrl(url) : url;
    const res = await fetch(fetchUrl, { cache: bustCache ? 'no-store' : 'default' });
    if (!res.ok) throw new Error('无法加载 ' + url);
    const bytes = await readResponseBytes(res, onProgress, p0, p1);
    report(onProgress, p1, '解析数据', '整理加密包');
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
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

  async function decryptPayload(key, payload, onProgress, p0, p1) {
    report(onProgress, p0, 'AES 解密中', '正在解锁内容');
    const iv = b64ToBytes(payload.iv);
    report(onProgress, (p0 + p1) / 2, 'AES 解密中', '校验完整性');
    const ct = b64ToBytes(payload.ct);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      report(onProgress, p1, '解密完成', '内容已解锁');
      return new Uint8Array(plain);
    } catch (e) {
      const err = new Error('解密失败，请退出后重新登录');
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
      const payload = await fetchJsonWithProgress(encPath, onProgress, 10, 72, true);
      const bytes = await decryptPayload(key, payload, onProgress, 72, 96);
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
    var encPath = ENC_MAP[legacyPath];
    if (!encPath) throw new Error('未知资源');
    await ensureSessionValid();
    var key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }
    return fetchAndDecrypt(key, encPath, onProgress);
  }

  async function ensureViewerCached(legacyPath, onProgress) {
    var vid = PATH_TO_SHORT[legacyPath];
    if (!vid) throw new Error('未知页面');
    var cached = await idbGet(vid);
    if (cached) {
      report(onProgress, 100, '读取缓存', '秒开');
      return { vid: vid, bytes: cached };
    }
    var bytes = await getDecryptedBytes(legacyPath, onProgress);
    if (!bytes) return null;
    await idbSet(vid, bytes);
    return { vid: vid, bytes: bytes };
  }

  async function openInViewer(legacyPath, title, onProgress) {
    title = title || TITLE_MAP[legacyPath] || '内容';
    sessionStorage.setItem('love_viewer_title', title);
    report(onProgress, 96, '准备页面', '微信浏览器优化模式');
    var info = await ensureViewerCached(legacyPath, onProgress);
    if (!info) return null;
    report(onProgress, 100, '跳转', '正在打开');
    location.href = 'viewer.html?v=' + encodeURIComponent(info.vid);
    return info;
  }

  async function renderViewerPage(vid) {
    var legacyPath = VIEWER_SHORT[vid];
    if (!legacyPath) throw new Error('无效的页面参数');
    var title = sessionStorage.getItem('love_viewer_title') || TITLE_MAP[legacyPath] || '';
    var bytes = await idbGet(vid);
    if (!bytes) {
      bytes = await getDecryptedBytes(legacyPath, function (p, s, d) {
        LoveLoader.set(Math.min(90, p), s, d);
      });
      if (bytes) await idbSet(vid, bytes);
    }
    if (!bytes) throw new Error('内容为空');
    LoveLoader.set(95, '渲染', '正在显示');
    var html = new TextDecoder().decode(bytes);
    var backBar =
      '<div id="loveViewerBack" style="position:sticky;top:0;z-index:999999;' +
      'padding:max(10px,env(safe-area-inset-top)) 14px 10px;background:rgba(255,245,247,.96);' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid rgba(233,30,99,.15);' +
      'display:flex;align-items:center;gap:10px;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;">' +
      '<a href="index.html" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;' +
      'border-radius:20px;background:linear-gradient(135deg,#E91E63,#B57EDC);color:#fff;text-decoration:none;' +
      'font-size:14px;font-weight:600;">← 返回</a>' +
      '<span style="font-size:14px;color:#7A6B7A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
      (title.replace(/</g, '&lt;')) + '</span></div>';
    LoveLoader.hide(120);
    document.open('text/html', 'replace');
    document.write(backBar + html);
    document.close();
  }

  const CHAT_PATHS = [
    '微信聊天记录导出/高铭怡聊天记录.html',
    '抖音聊天记录导出/抖音聊天记录.html',
  ];

  function hasCachedHtml(legacyPath) {
    return blobCache.has(legacyPath) || (ENC_MAP[legacyPath] && decryptCache.has(ENC_MAP[legacyPath]));
  }

  const blobUrls = new Set();

  async function preloadChats(onProgress) {
    if (!isMobileDevice() && !isWeChatBrowser()) return;
    var key = await getSessionKey();
    if (!key) return;
    for (var i = 0; i < CHAT_PATHS.length; i++) {
      var p = CHAT_PATHS[i];
      var vid = PATH_TO_SHORT[p];
      if (vid) {
        try {
          var idbHit = await idbGet(vid);
          if (idbHit) continue;
        } catch (e) {}
      }
      if (blobCache.has(p) || decryptCache.has(ENC_MAP[p])) continue;
      try {
        await fetchAndDecrypt(key, ENC_MAP[p], function (pct, stage, detail) {
          if (typeof onProgress === 'function') {
            onProgress(p, pct, stage, detail);
          }
        });
        var bytes = decryptCache.get(ENC_MAP[p]);
        if (bytes) {
          var vid = PATH_TO_SHORT[p];
          if (vid) {
            try { await idbSet(vid, bytes); } catch (e) {}
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
    }
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
    var encPath = ENC_MAP[legacyPath];
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
    openInViewer,
    renderViewerPage,
    preloadChats,
    hasCachedHtml,
    revokeBlob,
  };
})(window);
