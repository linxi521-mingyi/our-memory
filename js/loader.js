/** Premium loading overlay with progress for Our Memory */
(function (global) {
  const STYLE_ID = 'love-loader-style';
  const ROOT_ID = 'loveLoader';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = document.createElement('style');
    css.id = STYLE_ID;
    css.textContent = `
#${ROOT_ID}{
  position:fixed;inset:0;z-index:99999;
  display:flex;align-items:center;justify-content:center;
  background:
    radial-gradient(ellipse 80% 60% at 50% 40%, rgba(255,107,157,0.22), transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 80%, rgba(181,126,220,0.18), transparent 55%),
    rgba(18,10,24,0.72);
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity .35s ease,visibility .35s ease;
}
#${ROOT_ID}.show{opacity:1;visibility:visible;pointer-events:auto}
#${ROOT_ID} .ll-card{
  width:min(420px,88vw);
  padding:36px 32px 28px;
  border-radius:24px;
  background:linear-gradient(160deg,rgba(255,255,255,0.97),rgba(255,240,245,0.94));
  box-shadow:
    0 24px 80px rgba(20,8,30,0.35),
    0 0 0 1px rgba(255,255,255,0.65) inset;
  text-align:center;
  transform:translateY(12px) scale(.98);
  transition:transform .4s cubic-bezier(.22,1,.36,1);
}
#${ROOT_ID}.show .ll-card{transform:translateY(0) scale(1)}
#${ROOT_ID} .ll-mark{
  width:56px;height:56px;margin:0 auto 18px;
  border-radius:50%;
  background:linear-gradient(135deg,#FF6B9D,#B57EDC);
  display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:22px;
  box-shadow:0 10px 28px rgba(233,30,99,0.35);
  animation:llPulse 2.2s ease-in-out infinite;
}
#${ROOT_ID} .ll-title{
  font-family:Georgia,'Noto Serif SC','Songti SC',serif;
  font-size:20px;font-weight:700;color:#4A3B52;
  letter-spacing:.08em;margin-bottom:6px;
}
#${ROOT_ID} .ll-sub{
  font-size:13px;color:#9A879A;margin-bottom:22px;
  min-height:1.4em;letter-spacing:.04em;
}
#${ROOT_ID} .ll-track{
  position:relative;height:8px;border-radius:999px;
  background:rgba(233,30,99,0.1);overflow:hidden;
}
#${ROOT_ID} .ll-bar{
  height:100%;width:0%;border-radius:999px;
  background:linear-gradient(90deg,#FF6B9D 0%,#E91E63 45%,#B57EDC 100%);
  background-size:200% 100%;
  box-shadow:0 0 16px rgba(255,107,157,0.55);
  transition:width .25s ease;
  animation:llShimmer 1.6s linear infinite;
}
#${ROOT_ID} .ll-meta{
  display:flex;justify-content:space-between;align-items:center;
  margin-top:12px;font-size:12px;color:#B0A0B0;
  font-variant-numeric:tabular-nums;letter-spacing:.06em;
}
#${ROOT_ID} .ll-pct{color:#E91E63;font-weight:700;font-size:14px}
@keyframes llPulse{
  0%,100%{transform:scale(1)}
  50%{transform:scale(1.06)}
}
@keyframes llShimmer{
  0%{background-position:0% 50%}
  100%{background-position:200% 50%}
}
@media (prefers-reduced-motion:reduce){
  #${ROOT_ID} .ll-mark,#${ROOT_ID} .ll-bar{animation:none}
}
`;
    document.head.appendChild(css);
  }

  function ensureRoot() {
    injectStyles();
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="ll-card" role="status" aria-live="polite">
        <div class="ll-mark">❤</div>
        <div class="ll-title">梦召 &amp; 铭怡</div>
        <div class="ll-sub" id="llSub">正在准备…</div>
        <div class="ll-track"><div class="ll-bar" id="llBar"></div></div>
        <div class="ll-meta">
          <span id="llStage">请稍候</span>
          <span class="ll-pct" id="llPct">0%</span>
        </div>
      </div>`;
    document.body.appendChild(root);
    return root;
  }

  let hideTimer = null;
  let pulseTimer = null;
  let current = 0;

  function stopPulse() {
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
  }

  function startPulse(maxPct, stage, sub) {
    stopPulse();
    maxPct = maxPct == null ? 96 : maxPct;
    pulseTimer = setInterval(function () {
      if (current < maxPct) set(current + 1, stage, sub);
    }, 450);
  }

  function show(titleText) {
    const root = ensureRoot();
    stopPulse();
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (titleText) {
      const t = root.querySelector('.ll-title');
      if (t) t.textContent = titleText;
    }
    current = 0;
    set(0, '正在启动', '准备加密通道');
    root.classList.add('show');
  }

  function set(pct, stage, sub) {
    const root = ensureRoot();
    current = Math.max(current, Math.min(100, Math.round(pct)));
    const bar = document.getElementById('llBar');
    const pctEl = document.getElementById('llPct');
    const stageEl = document.getElementById('llStage');
    const subEl = document.getElementById('llSub');
    if (bar) bar.style.width = current + '%';
    if (pctEl) pctEl.textContent = current + '%';
    if (stage && stageEl) stageEl.textContent = stage;
    if (sub && subEl) subEl.textContent = sub;
  }

  /** Smoothly ease toward a target while an async task runs */
  function pulseToward(target, stage, sub) {
    set(Math.min(target, current + 1), stage, sub);
  }

  function hide(delay) {
    stopPulse();
    const root = ensureRoot();
    set(100, '完成', '欢迎回来');
    hideTimer = setTimeout(function () {
      root.classList.remove('show');
      current = 0;
    }, delay == null ? 320 : delay);
  }

  function fail(msg) {
    stopPulse();
    set(current, '失败', msg || '加载失败，请重试');
    hideTimer = setTimeout(function () {
      const root = document.getElementById(ROOT_ID);
      if (root) root.classList.remove('show');
    }, 1200);
  }

  global.LoveLoader = { show, set, pulseToward, startPulse, stopPulse, hide, fail };
})(window);
