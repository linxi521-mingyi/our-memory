/** Lightweight mobile chat renderer — uses js/theme.css */
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

  function ensureTheme() {
    if (document.getElementById('love-theme-css')) return;
    var link = document.createElement('link');
    link.id = 'love-theme-css';
    link.rel = 'stylesheet';
    link.href = 'js/theme.css';
    document.head.appendChild(link);
  }

  function yieldUI() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        setTimeout(resolve, 0);
      });
    });
  }

  function mountBoot(root) {
    root.insertAdjacentHTML(
      'afterbegin',
      '<div id="lcvBoot" class="lcv-boot">' +
        '<div class="lcv-boot__spin"></div>' +
        '<div id="lcvBootText" class="lcv-boot__text">正在加载聊天记录…</div>' +
        '<div id="lcvBootPct" class="lcv-boot__pct">0%</div>' +
      '</div>'
    );
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

  function wechatAvatarHtml(isMe) {
    if (isMe) {
      return '<div class="lcv-wx-avatar lcv-wx-avatar--me" aria-hidden="true">我</div>';
    }
    return '<div class="lcv-wx-avatar lcv-wx-avatar--her" aria-hidden="true">怡</div>';
  }

  function headerHtml(pack, platform) {
    var tag = platform === 'wechat' ? 'WECHAT · 微信' : 'DOUYIN · 抖音';
    var count = (pack.m || []).length;
    var searchBlock =
      '<div class="lcv-search-wrap">' +
        '<span class="lcv-search-icon">🔍</span>' +
        '<input class="lcv-search" id="lcvSearch" type="search" placeholder="搜索消息内容…" autocomplete="off">' +
      '</div>' +
      '<div class="lcv-stats" id="lcvStats">共 ' + count + ' 条</div>';

    if (platform === 'wechat') {
      return (
        '<div class="lcv-hdr lcv-hdr--wechat">' +
          '<div class="lcv-wx-hdr-top">' +
            '<div class="lcv-wx-hdr-icon">💬</div>' +
            '<div class="lcv-wx-hdr-text">' +
              '<span class="lcv-hdr__tag">' + tag + '</span>' +
              '<h1>' + esc(pack.title || '聊天记录') + '</h1>' +
            '</div>' +
          '</div>' +
          (pack.info ? '<div class="lcv-wx-chips"><span class="lcv-wx-chip lcv-wx-chip--accent">💕 ' + esc(pack.info) + '</span><span class="lcv-wx-chip">📨 ' + count + ' 条消息</span></div>' : '<div class="lcv-wx-chips"><span class="lcv-wx-chip lcv-wx-chip--accent">💕 我们的微信</span><span class="lcv-wx-chip">📨 ' + count + ' 条消息</span></div>') +
          searchBlock +
        '</div>'
      );
    }

    return (
      '<div class="lcv-hdr">' +
        '<span class="lcv-hdr__tag">' + tag + '</span>' +
        '<h1>' + esc(pack.title || '聊天记录') + '</h1>' +
        (pack.info ? '<div class="info">' + esc(pack.info) + '</div>' : '') +
        searchBlock +
      '</div>'
    );
  }

  function bindSearch(msgs, statsEl, onReset) {
    var searchTimer = null;
    document.getElementById('lcvSearch').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      var q = (e.target.value || '').trim().toLowerCase();
      searchTimer = setTimeout(function () {
        onReset(q);
      }, 260);
    });
  }

  function renderWechat(root, pack, onProgress) {
    root.className = 'lcv-page lcv-page--wechat';
    var msgs = pack.m || [];
    var loaded = 0;
    var lastDate = '';
    var searchResults = null;

    root.innerHTML = headerHtml(pack, 'wechat') + '<div id="lcvMsgs"></div><div class="lcv-more" id="lcvMore"></div>';

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
        more.innerHTML = total ? '<span>已加载全部 ' + total + ' 条消息</span>' : '<span>暂无消息</span>';
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
          html += '<div class="lcv-date"><span>' + esc(date) + '</span></div>';
        }
        html +=
          '<div class="lcv-msg ' + (isMe ? 'self' : 'other') + '">' +
            '<div class="lcv-wx-row">' +
              (isMe ? '' : wechatAvatarHtml(false)) +
              '<div class="lcv-wx-body">' +
                '<div class="lcv-time">' + esc(timeHtml) + '</div>' +
                '<div class="lcv-bubble">' + bubble + '</div>' +
              '</div>' +
              (isMe ? wechatAvatarHtml(true) : '') +
            '</div>' +
          '</div>';
      }
      box.insertAdjacentHTML('beforeend', html);
      loaded = end;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(100, (loaded / total) * 100), '渲染消息', loaded + ' / ' + total);
      }
      if (loaded >= Math.min(BATCH_WECHAT, total)) hideBoot();
      if (loaded < total) {
        more.innerHTML = '<button type="button" id="lcvLoadBtn">继续加载 (' + (total - loaded) + ')</button>';
        document.getElementById('lcvLoadBtn').onclick = appendBatch;
      } else {
        more.innerHTML = '<span>已加载全部 ' + total + ' 条消息</span>';
      }
    }

    bindSearch(msgs, stats, function (q) {
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
        if ((msgs[i][4] || '').indexOf(q) >= 0) searchResults.push(msgs[i]);
      }
      stats.textContent = '找到 ' + searchResults.length + ' 条';
      appendBatch();
    });

    mountBoot(root);
    setBoot(5, '准备渲染…');
    appendBatch();
  }

  function renderDouyin(root, pack, onProgress) {
    root.className = 'lcv-page lcv-page--douyin';
    var msgs = pack.m || [];
    var loaded = 0;
    var lastDate = '';
    var searchResults = null;

    root.innerHTML = headerHtml(pack, 'douyin') + '<div id="lcvMsgs"></div><div class="lcv-more" id="lcvMore"></div>';

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
        more.innerHTML = total ? '<span>已加载全部 ' + total + ' 条消息</span>' : '<span>暂无消息</span>';
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
          html += '<div class="lcv-date"><span>' + esc(date) + '</span></div>';
        }
        html +=
          '<div class="lcv-msg ' + (isMe ? 'me' : 'her') + '">' +
            '<div class="lcv-avatar">' + (isMe ? '我' : '她') + '</div>' +
            '<div class="lcv-bubble">' + esc(content) + '<span class="lcv-time">' + esc(time) + '</span></div>' +
          '</div>';
      }
      box.insertAdjacentHTML('beforeend', html);
      loaded = end;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(100, (loaded / total) * 100), '渲染消息', loaded + ' / ' + total);
      }
      if (loaded >= Math.min(BATCH_DOUYIN, total)) hideBoot();
      if (loaded < total) {
        more.innerHTML = '<button type="button" id="lcvLoadBtn">继续加载 (' + (total - loaded) + ')</button>';
        document.getElementById('lcvLoadBtn').onclick = appendBatch;
      } else {
        more.innerHTML = '<span>已加载全部 ' + total + ' 条消息</span>';
      }
    }

    bindSearch(msgs, stats, function (q) {
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
    ensureTheme();
    document.documentElement.classList.add('love-viewer-page');
    document.body.classList.add('love-viewer-page');
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
