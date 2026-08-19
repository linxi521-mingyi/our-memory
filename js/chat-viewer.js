/** Lightweight mobile chat renderer (compact JSON packs, lazy batches). */
(function (global) {
  var BATCH_WECHAT = 50;
  var BATCH_DOUYIN = 60;

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function injectStyle(id, css) {
    if (document.getElementById(id)) return;
    var el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }

  function yieldUI() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        setTimeout(resolve, 0);
      });
    });
  }

  function mountBoot(root) {
    root.innerHTML =
      '<div id="lcvBoot" style="position:fixed;inset:0;z-index:99998;background:#f5f5f5;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;color:#666;">' +
      '<div style="width:44px;height:44px;border:3px solid #e0e0e0;border-top-color:#667eea;border-radius:50%;animation:lcvSpin .8s linear infinite;margin-bottom:16px;"></div>' +
      '<div id="lcvBootText" style="font-size:15px;">正在加载聊天记录…</div>' +
      '<div id="lcvBootPct" style="font-size:12px;color:#999;margin-top:8px;">0%</div></div>' +
      '<style>@keyframes lcvSpin{to{transform:rotate(360deg)}}</style>';
  }

  function setBoot(pct, text) {
    var t = document.getElementById('lcvBootText');
    var p = document.getElementById('lcvBootPct');
    if (t && text) t.textContent = text;
    if (p) p.textContent = Math.round(pct) + '%';
  }

  function hideBoot() {
    var el = document.getElementById('lcvBoot');
    if (el) el.style.display = 'none';
  }

  function renderWechat(root, pack, onProgress) {
    injectStyle(
      'lcv-wechat-css',
      'body{background:#ededed;margin:0}' +
        '.lcv-hdr{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);padding:12px 14px;border-bottom:1px solid #ddd}' +
        '.lcv-hdr h1{font-size:16px;margin:0 0 4px;color:#333}' +
        '.lcv-hdr .info{font-size:12px;color:#888;margin-bottom:8px}' +
        '.lcv-search{width:100%;padding:9px 14px;border:1px solid #ddd;border-radius:18px;font-size:14px;outline:none;box-sizing:border-box}' +
        '.lcv-stats{font-size:12px;color:#999;margin-top:6px}' +
        '#lcvMsgs{max-width:700px;margin:0 auto;padding:10px 8px 80px}' +
        '.date-div{text-align:center;margin:16px 0 8px}' +
        '.date-div span{background:rgba(0,0,0,.08);color:#666;font-size:12px;padding:4px 12px;border-radius:10px}' +
        '.msg{max-width:700px;margin:0 auto 8px;display:flex;flex-direction:column}' +
        '.msg.self{align-items:flex-end}.msg.other{align-items:flex-start}' +
        '.time{font-size:11px;color:#999;margin-bottom:2px;padding:0 4px}' +
        '.bubble{max-width:78%;padding:10px 14px;border-radius:12px;font-size:15px;line-height:1.55;word-break:break-word}' +
        '.msg.self .bubble{background:#95ec69;color:#000}.msg.other .bubble{background:#fff;color:#333;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
        '.lcv-more{text-align:center;padding:16px;color:#888;font-size:13px}' +
        '.lcv-more button{background:#fff;border:1px solid #ccc;border-radius:16px;padding:8px 24px;font-size:13px;color:#555}'
    );

    var msgs = pack.m || [];
    var loaded = 0;
    var lastDate = '';
    var searchResults = null;
    var searchTimer = null;

    root.innerHTML =
      '<div class="lcv-hdr">' +
      '<h1>' +
      esc(pack.title || '微信聊天记录') +
      '</h1>' +
      (pack.info ? '<div class="info">' + esc(pack.info) + '</div>' : '') +
      '<input class="lcv-search" id="lcvSearch" type="search" placeholder="搜索消息…" autocomplete="off">' +
      '<div class="lcv-stats" id="lcvStats">共 ' +
      msgs.length +
      ' 条</div></div>' +
      '<div id="lcvMsgs"></div>' +
      '<div class="lcv-more" id="lcvMore"></div>';

    var box = document.getElementById('lcvMsgs');
    var more = document.getElementById('lcvMore');
    var stats = document.getElementById('lcvStats');

    function source() {
      return searchResults !== null ? searchResults : msgs;
    }

    function appendBatch() {
      var list = source();
      var total = list.length;
      if (loaded >= total) {
        more.innerHTML = total ? '<span>已加载全部 ' + total + ' 条</span>' : '<span>暂无消息</span>';
        return;
      }
      var end = Math.min(loaded + BATCH_WECHAT, total);
      var html = '';
      for (var i = loaded; i < end; i++) {
        var row = list[i];
        var date = row[0];
        var timeHtml = row[1];
        var isMe = row[2];
        var bubble = row[3];
        if (date && date !== lastDate) {
          lastDate = date;
          html += '<div class="date-div"><span>' + esc(date) + '</span></div>';
        }
        html +=
          '<div class="msg ' +
          (isMe ? 'self' : 'other') +
          '"><div class="time">' +
          esc(timeHtml) +
          '</div><div class="bubble">' +
          bubble +
          '</div></div>';
      }
      box.insertAdjacentHTML('beforeend', html);
      loaded = end;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(100, (loaded / total) * 100), '渲染消息', loaded + ' / ' + total);
      }
      if (loaded >= Math.min(BATCH_WECHAT, total)) hideBoot();
      if (loaded < total) {
        more.innerHTML = '<button type="button" id="lcvLoadBtn">继续加载 (' + (total - loaded) + ')</button>';
        document.getElementById('lcvLoadBtn').onclick = function () {
          appendBatch();
        };
      } else {
        more.innerHTML = '<span>已加载全部 ' + total + ' 条</span>';
      }
    }

    document.getElementById('lcvSearch').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      var q = (e.target.value || '').trim().toLowerCase();
      searchTimer = setTimeout(function () {
        loaded = 0;
        lastDate = '';
        box.innerHTML = '';
        if (!q) {
          searchResults = null;
          stats.textContent = '共 ' + msgs.length + ' 条';
          appendBatch();
          return;
        }
        searchResults = [];
        for (var i = 0; i < msgs.length; i++) {
          var s = msgs[i][4] || '';
          if (s.indexOf(q) >= 0) searchResults.push(msgs[i]);
        }
        stats.textContent = '找到 ' + searchResults.length + ' 条';
        appendBatch();
      }, 280);
    });

    mountBoot(root);
    setBoot(5, '准备渲染…');
    appendBatch();
  }

  function renderDouyin(root, pack, onProgress) {
    injectStyle(
      'lcv-douyin-css',
      'body{margin:0;background:linear-gradient(180deg,#fce4ec 0%,#fff5f5 30%,#f3e5f5 60%,#e8eaf6 100%);min-height:100vh}' +
        '.lcv-hdr{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.88);backdrop-filter:blur(12px);padding:12px 14px;border-bottom:1px solid rgba(255,182,193,.3)}' +
        '.lcv-hdr h1{font-size:16px;margin:0 0 4px;background:linear-gradient(135deg,#e91e63,#9c27b0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}' +
        '.lcv-hdr .info{font-size:12px;color:#ad1457;opacity:.7;margin-bottom:8px}' +
        '.lcv-search{width:100%;padding:9px 14px;border:1.5px solid #f8bbd0;border-radius:22px;font-size:14px;outline:none;box-sizing:border-box;background:rgba(255,255,255,.6)}' +
        '.lcv-stats{font-size:12px;color:#ad1457;opacity:.6;margin-top:6px}' +
        '#lcvMsgs{max-width:780px;margin:0 auto;padding:16px 10px 80px}' +
        '.date-div{text-align:center;margin:24px 0 12px}' +
        '.date-div span{background:rgba(255,255,255,.7);color:#ad1457;font-size:12px;padding:5px 14px;border-radius:14px}' +
        '.msg{display:flex;margin-bottom:12px;gap:10px}.msg.me{flex-direction:row-reverse}' +
        '.avatar{width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff}' +
        '.msg.me .avatar{background:linear-gradient(135deg,#e91e63,#f06292)}.msg.her .avatar{background:linear-gradient(135deg,#26c6da,#4dd0e1)}' +
        '.bubble{max-width:68%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.65;word-break:break-word}' +
        '.msg.me .bubble{background:linear-gradient(135deg,#e91e63,#f06292);color:#fff;border-top-right-radius:6px}' +
        '.msg.her .bubble{background:rgba(255,255,255,.92);color:#333;border-top-left-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.05)}' +
        '.bubble .time{font-size:10px;opacity:.5;margin-top:4px;display:block}' +
        '.lcv-more{text-align:center;padding:16px;color:#ad1457;font-size:13px;opacity:.7}' +
        '.lcv-more button{background:rgba(255,255,255,.85);border:1.5px solid #f8bbd0;border-radius:22px;padding:8px 24px;font-size:13px;color:#ad1457}'
    );

    var msgs = pack.m || [];
    var loaded = 0;
    var lastDate = '';
    var searchResults = null;
    var searchTimer = null;

    root.innerHTML =
      '<div class="lcv-hdr">' +
      '<h1>' +
      esc(pack.title || '抖音聊天记录') +
      '</h1>' +
      (pack.info ? '<div class="info">' + esc(pack.info) + '</div>' : '') +
      '<input class="lcv-search" id="lcvSearch" type="search" placeholder="搜索消息…" autocomplete="off">' +
      '<div class="lcv-stats" id="lcvStats">共 ' +
      msgs.length +
      ' 条</div></div>' +
      '<div id="lcvMsgs"></div>' +
      '<div class="lcv-more" id="lcvMore"></div>';

    var box = document.getElementById('lcvMsgs');
    var more = document.getElementById('lcvMore');
    var stats = document.getElementById('lcvStats');

    function source() {
      return searchResults !== null ? searchResults : msgs;
    }

    function appendBatch() {
      var list = source();
      var total = list.length;
      if (loaded >= total) {
        more.innerHTML = total ? '<span>已加载全部 ' + total + ' 条</span>' : '<span>暂无消息</span>';
        return;
      }
      var end = Math.min(loaded + BATCH_DOUYIN, total);
      var html = '';
      for (var i = loaded; i < end; i++) {
        var row = list[i];
        var date = row[0];
        var time = row[1];
        var isMe = row[2];
        var content = row[3];
        if (date && date !== lastDate) {
          lastDate = date;
          html += '<div class="date-div"><span>' + esc(date) + '</span></div>';
        }
        html +=
          '<div class="msg ' +
          (isMe ? 'me' : 'her') +
          '"><div class="avatar">' +
          (isMe ? '我' : '她') +
          '</div><div class="bubble">' +
          esc(content) +
          '<span class="time">' +
          esc(time) +
          '</span></div></div>';
      }
      box.insertAdjacentHTML('beforeend', html);
      loaded = end;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(100, (loaded / total) * 100), '渲染消息', loaded + ' / ' + total);
      }
      if (loaded >= Math.min(BATCH_DOUYIN, total)) hideBoot();
      if (loaded < total) {
        more.innerHTML = '<button type="button" id="lcvLoadBtn">继续加载 (' + (total - loaded) + ')</button>';
        document.getElementById('lcvLoadBtn').onclick = function () {
          appendBatch();
        };
      } else {
        more.innerHTML = '<span>已加载全部 ' + total + ' 条</span>';
      }
    }

    document.getElementById('lcvSearch').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      var q = (e.target.value || '').trim().toLowerCase();
      searchTimer = setTimeout(function () {
        loaded = 0;
        lastDate = '';
        box.innerHTML = '';
        if (!q) {
          searchResults = null;
          stats.textContent = '共 ' + msgs.length + ' 条';
          appendBatch();
          return;
        }
        searchResults = [];
        for (var i = 0; i < msgs.length; i++) {
          if ((msgs[i][3] || '').toLowerCase().indexOf(q) >= 0) searchResults.push(msgs[i]);
        }
        stats.textContent = '找到 ' + searchResults.length + ' 条';
        appendBatch();
      }, 280);
    });

    mountBoot(root);
    setBoot(5, '准备渲染…');
    appendBatch();
  }

  function isChatPack(value) {
    return value && typeof value === 'object' && (value.t === 'wechat' || value.t === 'douyin') && Array.isArray(value.m);
  }

  async function render(root, pack, onProgress) {
    if (!root || !isChatPack(pack)) throw new Error('无效的聊天数据');
    document.title = pack.title || '聊天记录';
    await yieldUI();
    if (pack.t === 'wechat') renderWechat(root, pack, onProgress);
    else renderDouyin(root, pack, onProgress);
  }

  global.LoveChatViewer = {
    render: render,
    isChatPack: isChatPack,
  };
})(window);
