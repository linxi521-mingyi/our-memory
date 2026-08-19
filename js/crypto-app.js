/** Shared Web Crypto helpers for Our Memory (PBKDF2 + AES-256-GCM). */
(function (global) {
  const META_URL = 'enc/meta.json';
  const KEY_STORAGE = 'love_aes_key';
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

  async function fetchJsonWithProgress(url, onProgress, p0, p1) {
    report(onProgress, p0, '连接服务器', '正在请求资源');
    const res = await fetch(url, { cache: 'default' });
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
    metaCache.promise = fetchJsonWithProgress(META_URL, onProgress, 2, 8)
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
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    report(onProgress, p1, '解密完成', '内容已解锁');
    return new Uint8Array(plain);
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
      const payload = await fetchJsonWithProgress(encPath, onProgress, 10, 72);
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

  function saveSessionKey(rawB64) {
    sessionStorage.setItem(KEY_STORAGE, rawB64);
    sessionStorage.setItem(LOGIN_FLAG, 'true');
    localStorage.removeItem(LOGIN_FLAG);
  }

  function clearSession() {
    sessionStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(LOGIN_FLAG);
    sessionStorage.removeItem(CONTENT_CACHE_KEY);
    localStorage.removeItem(LOGIN_FLAG);
    decryptCache.clear();
    blobCache.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    });
    blobCache.clear();
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
    saveSessionKey(raw);
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

  const blobUrls = new Set();

  function revokeBlob(url) {
    if (url && blobUrls.has(url)) {
      URL.revokeObjectURL(url);
      blobUrls.delete(url);
    }
  }

  async function openDecryptedHtml(legacyPath, opts) {
    opts = opts || {};
    const target = opts.target || 'tab';
    const title = opts.title || '';
    const onProgress = opts.onProgress;
    const encPath = ENC_MAP[legacyPath];
    if (!encPath) throw new Error('未知资源: ' + legacyPath);
    const key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }

    let url = blobCache.get(legacyPath);
    if (!url) {
      const bytes = await fetchAndDecrypt(key, encPath, onProgress);
      report(onProgress, 98, '生成预览', '即将打开');
      const blob = new Blob([bytes], { type: 'text/html; charset=utf-8' });
      url = URL.createObjectURL(blob);
      blobUrls.add(url);
      blobCache.set(legacyPath, url);
    } else {
      report(onProgress, 100, '读取缓存', '秒开');
    }

    if (target === 'tab') {
      window.open(url, '_blank');
    }
    report(onProgress, 100, '完成', '已打开');
    return { url, title, revoke: function () {} };
  }

  global.LoveCrypto = {
    META_URL,
    KEY_STORAGE,
    CONTENT_CACHE_KEY,
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
    revokeBlob,
  };
})(window);
