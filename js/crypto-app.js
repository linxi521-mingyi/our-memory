/** Shared Web Crypto helpers for Our Memory (PBKDF2 + AES-256-GCM). */
(function (global) {
  const META_URL = 'enc/meta.json';
  const KEY_STORAGE = 'love_aes_key';
  const LOGIN_FLAG = 'love_logged_in';

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

  async function loadMeta() {
    const res = await fetch(META_URL + '?t=' + Date.now());
    if (!res.ok) throw new Error('无法加载加密元数据');
    return res.json();
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

  async function decryptPayload(key, payload) {
    const iv = b64ToBytes(payload.iv);
    const ct = b64ToBytes(payload.ct);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(plain);
  }

  async function fetchAndDecrypt(key, encPath) {
    const res = await fetch(encPath + '?t=' + Date.now());
    if (!res.ok) throw new Error('无法加载 ' + encPath);
    const payload = await res.json();
    return decryptPayload(key, payload);
  }

  async function fetchAndDecryptText(key, encPath) {
    const bytes = await fetchAndDecrypt(key, encPath);
    return new TextDecoder().decode(bytes);
  }

  async function fetchAndDecryptJson(key, encPath) {
    return JSON.parse(await fetchAndDecryptText(key, encPath));
  }

  function saveSessionKey(rawB64) {
    sessionStorage.setItem(KEY_STORAGE, rawB64);
    sessionStorage.setItem(LOGIN_FLAG, 'true');
    localStorage.removeItem(LOGIN_FLAG);
  }

  function clearSession() {
    sessionStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(LOGIN_FLAG);
    localStorage.removeItem(LOGIN_FLAG);
  }

  function getSessionKeyB64() {
    return sessionStorage.getItem(KEY_STORAGE);
  }

  async function getSessionKey() {
    const b64 = getSessionKeyB64();
    if (!b64) return null;
    return importRawKey(b64);
  }

  async function unlockWithPassword(username, password) {
    const meta = await loadMeta();
    const key = await deriveKey(password, meta);
    let auth;
    try {
      auth = await fetchAndDecryptJson(key, 'enc/auth.enc');
    } catch (e) {
      throw new Error('密码错误');
    }
    if (!auth || !auth.ok || auth.username !== username) {
      throw new Error('用户名或密码错误');
    }
    const raw = await exportRawKey(key);
    saveSessionKey(raw);
    return key;
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

  async function openDecryptedHtml(legacyPath, { target = 'tab', title = '' } = {}) {
    const encPath = ENC_MAP[legacyPath];
    if (!encPath) throw new Error('未知资源: ' + legacyPath);
    const key = await getSessionKey();
    if (!key) {
      location.replace('login.html');
      return null;
    }
    const bytes = await fetchAndDecrypt(key, encPath);
    const blob = new Blob([bytes], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    if (target === 'tab') {
      window.open(url, '_blank');
      setTimeout(() => revokeBlob(url), 120_000);
    }
    return { url, title, revoke: () => revokeBlob(url) };
  }

  global.LoveCrypto = {
    META_URL,
    KEY_STORAGE,
    loadMeta,
    deriveKey,
    unlockWithPassword,
    getSessionKey,
    getSessionKeyB64,
    clearSession,
    fetchAndDecryptText,
    fetchAndDecryptJson,
    fetchAndDecrypt,
    openDecryptedHtml,
    ENC_MAP,
    revokeBlob,
  };
})(window);
