/**
 * 内容脚本：只在 B 站视频页运行。
 *
 * 两件事：
 *   1) 把「当前在看什么」告诉扩展（面板、悬浮球都用它）
 *   2) 页面右下角的悬浮球：点一下就按面板里保存的参数投到上次的电视
 *
 * 这里不碰任何投屏协议 —— 协议全部在本地桥接进程里。
 */
(function () {
  const MARK = '__bili_tv_cast__';

  const state = {
    pageInfo: null,
    receivedAt: 0,
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[MARK] !== true) return;
    state.pageInfo = data.payload || {};
    state.receivedAt = Date.now();
  });

  // 注入主世界脚本，用于读取 window.__INITIAL_STATE__
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (err) {
    // 注入失败时仍可依赖 URL 解析
  }

  function parseUrl() {
    const u = new URL(location.href);
    const bv = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const ep = u.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    const ss = u.pathname.match(/\/bangumi\/play\/ss(\d+)/);
    return {
      bvid: bv ? bv[1] : null,
      epId: ep ? Number(ep[1]) : null,
      seasonId: ss ? Number(ss[1]) : null,
      page: Number(u.searchParams.get('p') || 1) || 1,
      isVideoPage: Boolean(bv || ep || ss || /\/list\//.test(u.pathname)),
    };
  }

  function domTitle() {
    const el = document.querySelector(
      'h1.video-title, .video-title, .mediainfo_mediaTitle__Zyiqh, h1[title]'
    );
    const text = el && el.textContent ? el.textContent.trim() : '';
    return text || document.title.replace(/_哔哩哔哩.*$/, '');
  }

  /** 取播放器里的主视频元素（B 站播放器是 <video>，广告/预览可能有多余的，取最长那个） */
  function mainVideoEl() {
    const list = [...document.querySelectorAll('video')].filter((v) => v && v.isConnected);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    return list.reduce((best, v) => {
      const bd = Number.isFinite(best.duration) ? best.duration : 0;
      const vd = Number.isFinite(v.duration) ? v.duration : 0;
      return vd > bd ? v : best;
    }, list[0]);
  }

  function buildPayload() {
    const url = parseUrl();
    const info = state.pageInfo || {};
    const pages = Array.isArray(info.pages) ? info.pages : [];
    const pageIndex = Math.min(Math.max((info.page || url.page || 1) - 1, 0), Math.max(pages.length - 1, 0));
    const currentPage = pages[pageIndex];

    const isBangumi = Boolean(info.epId || url.epId);
    const cid = info.cid || (currentPage && currentPage.cid) || 0;
    const aid = info.aid || 0;
    const bvid = info.bvid || url.bvid || '';
    const epId = info.epId || url.epId || 0;

    const videoEl = mainVideoEl();

    // cid 缺失也没关系：只要拿到 bvid / epId，桥接进程会自己调接口补齐
    const identifiable = Boolean(bvid || epId || (cid && aid));

    return {
      ok: identifiable,
      reason: identifiable ? '' : '还没读到视频信息，等页面加载完再试一次',
      isVideoPage: url.isVideoPage,
      video: {
        bvid,
        aid,
        cid,
        epId,
        seasonId: info.seasonId || url.seasonId || 0,
        page: pageIndex + 1,
        pageCount: pages.length || 1,
        title: info.title || domTitle(),
        partTitle: isBangumi
          ? info.partTitle || ''
          : pages.length > 1 && currentPage
          ? currentPage.part || ''
          : '',
        duration:
          (currentPage && currentPage.duration) ||
          (videoEl && Number.isFinite(videoEl.duration) ? Math.round(videoEl.duration) : 0),
        currentTime: videoEl ? Math.max(0, Math.round(videoEl.currentTime)) : 0,
        paused: videoEl ? videoEl.paused : true,
      },
    };
  }

  /** 页面状态可能晚于扩展的请求，这里做一次短轮询 */
  function waitForPayload(timeout = 1500) {
    const start = Date.now();
    return new Promise((resolve) => {
      const attempt = () => {
        const payload = buildPayload();
        if (payload.ok || Date.now() - start >= timeout) {
          resolve(payload);
          return;
        }
        setTimeout(attempt, 200);
      };
      attempt();
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'GET_VIDEO') return undefined;
    waitForPayload().then(sendResponse);
    return true; // 异步响应
  });

  // ================================================================ 网页悬浮球
  //
  // 交互：
  //   · 空闲时点一下 → 把当前视频投到「上次投屏的电视」（参数沿用扩展面板里的设置）
  //   · 投屏中再点一下 → 停止投屏
  //   · 全屏播放（含网页全屏）时自动隐藏，不挡画面

  const HOST_ID = 'bili-tv-cast-ball';
  const TV_ICON =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">' +
    '<rect x="2.8" y="6.8" width="18.4" height="12.4" rx="3.2" stroke="currentColor" stroke-width="1.9"/>' +
    '<path d="M8.5 6.6 11 3.8M15.5 6.6 13 3.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
    '<path d="M10.5 10.7v3.9l3.3-1.95-3.3-1.95Z" fill="currentColor"/></svg>';
  const STOP_ICON = '<span class="stop"></span>';

  const BALL_CSS = `
    :host { all: initial; }
    .wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", sans-serif;
    }
    .toast {
      max-width: 240px;
      padding: 7px 11px;
      border-radius: 10px;
      background: rgba(24, 26, 32, 0.94);
      color: #fff;
      font-size: 12px;
      line-height: 1.45;
      letter-spacing: 0.1px;
      white-space: normal;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.26);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.err { background: rgba(190, 46, 62, 0.96); }

    .hud {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      background: rgba(24, 26, 32, 0.9);
      color: #fff;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
      pointer-events: none;
    }
    .hud.show { display: flex; }
    .hud .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #fb7299;
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

    .btn {
      position: relative;
      width: 54px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      cursor: pointer;
      color: #fff;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #ff9fbc, #fb7299);
      box-shadow: 0 10px 24px rgba(251, 114, 153, 0.42), 0 2px 6px rgba(0, 0, 0, 0.18);
      transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.2s ease;
    }
    .btn:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 14px 28px rgba(251, 114, 153, 0.5); }
    .btn:active { transform: scale(0.95); }
    .btn.casting {
      background: linear-gradient(135deg, #4b5563, #1f2937);
      box-shadow: 0 10px 24px rgba(31, 41, 55, 0.42), 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    .btn .stop {
      width: 16px; height: 16px; border-radius: 4px;
      background: currentColor; display: block;
    }
    .btn.busy { cursor: progress; }
    .btn.busy::after {
      content: "";
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.75);
      border-top-color: transparent;
      animation: spin 0.85s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .hide {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(24, 26, 32, 0.85);
      color: #fff;
      font-size: 12px;
      line-height: 18px;
      text-align: center;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .wrap:hover .hide { opacity: 1; }
  `;

  const ball = {
    enabled: true,
    host: null,
    root: null,
    btn: null,
    hud: null,
    toast: null,
    busy: false,
    port: null,
    state: null,
    toastTimer: 0,
    healthTimer: 0,
  };

  const FULLSCREEN_BODY_CLASSES = [
    'bilibili-player-fullscreen',
    'bpx-player-fullscreen',
    'bilibili-player-fullscreen-web',
    'bpx-player-fullscreen-web',
  ];

  /** 是否处于全屏（原生全屏 / B 站播放器自己的全屏 / 网页全屏） */
  function isFullscreenNow() {
    if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
      return true;
    }
    const body = document.body;
    if (body) {
      for (const cls of FULLSCREEN_BODY_CLASSES) {
        if (body.classList.contains(cls)) return true;
      }
    }
    const container = document.querySelector('.bpx-player-container, .bilibili-player');
    if (container) {
      const screen = container.getAttribute('data-screen');
      if (screen === 'full' || screen === 'web') return true;
      // 兜底：播放器铺满整个视口也算全屏（B 站不同版本 class 名会变）
      const rect = container.getBoundingClientRect();
      if (rect.width >= window.innerWidth - 2 && rect.height >= window.innerHeight - 2) return true;
    }
    return false;
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(m)}:${pad(s % 60)}`;
  }

  function isCastingState(s) {
    return Boolean(s && (s.state === 'casting' || s.state === 'connecting'));
  }

  function showToast(text, kind) {
    if (!ball.toast) return;
    ball.toast.textContent = text;
    ball.toast.className = `toast show${kind === 'err' ? ' err' : ''}`;
    clearTimeout(ball.toastTimer);
    ball.toastTimer = setTimeout(() => {
      ball.toast.className = 'toast';
    }, kind === 'err' ? 4200 : 2400);
  }

  function renderBall() {
    if (!ball.btn) return;
    const casting = isCastingState(ball.state);
    ball.btn.classList.toggle('casting', casting);
    ball.btn.classList.toggle('busy', ball.busy);
    ball.btn.innerHTML = casting ? STOP_ICON : TV_ICON;

    if (casting) {
      const s = ball.state;
      const pos = fmtClock(s.position);
      const dur = s.duration ? ` / ${fmtClock(s.duration)}` : '';
      const label = s.state === 'connecting' ? '重连中' : s.playStateText || '投屏中';
      ball.hud.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const txt = document.createElement('span');
      txt.textContent = `${label} ${pos}${dur}`;
      ball.hud.append(dot, txt);
      ball.hud.classList.add('show');
      ball.btn.title = '点一下停止投屏';
    } else {
      ball.hud.classList.remove('show');
      ball.btn.title = '投屏到上次的电视（点一下即可）';
    }
  }

  function applyFullscreen() {
    if (!ball.host) return;
    ball.host.style.display = isFullscreenNow() ? 'none' : '';
  }

  function mountBall() {
    if (!ball.enabled || ball.host) return;
    if (!document.documentElement) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;right:20px;bottom:112px;z-index:2147483000;display:block;';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML =
      `<style>${BALL_CSS}</style>` +
      '<div class="wrap">' +
      '<div class="hud"></div>' +
      '<div class="toast"></div>' +
      '<button class="btn" type="button"></button>' +
      '<button class="hide" type="button" title="隐藏悬浮球（可在扩展面板里重新打开）">×</button>' +
      '</div>';

    document.documentElement.appendChild(host);

    ball.host = host;
    ball.root = root;
    ball.btn = root.querySelector('.btn');
    ball.hud = root.querySelector('.hud');
    ball.toast = root.querySelector('.toast');

    ball.btn.addEventListener('click', onBallClick);
    root.querySelector('.hide').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ ballEnabled: false });
      unmountBall();
      showToast('已隐藏悬浮球，可在扩展面板里重新打开');
    });

    renderBall();
    applyFullscreen();

    if (!ball.healthTimer) {
      ball.healthTimer = setInterval(applyFullscreen, 400);
    }
    connectPort();
  }

  function unmountBall() {
    if (ball.healthTimer) {
      clearInterval(ball.healthTimer);
      ball.healthTimer = 0;
    }
    if (ball.host) {
      ball.host.remove();
      ball.host = null;
      ball.root = null;
      ball.btn = null;
      ball.hud = null;
      ball.toast = null;
    }
  }

  // ------------------------------------------------------------ 与后台通信

  function connectPort() {
    if (ball.port) return;
    try {
      ball.port = chrome.runtime.connect({ name: 'ball' });
    } catch (_) {
      ball.port = null;
      return;
    }
    ball.port.onMessage.addListener(onPortMessage);
    ball.port.onDisconnect.addListener(() => {
      ball.port = null;
      // 后台被回收时稍后重连（页面还开着就重连，避免球失灵）
      setTimeout(() => {
        if (ball.host && document.visibilityState !== 'hidden') connectPort();
      }, 1200);
    });
    ball.port.postMessage({ type: 'BALL_GET_STATE' });
  }

  function post(msg) {
    if (!ball.port) connectPort();
    try {
      ball.port.postMessage(msg);
    } catch (_) {
      ball.port = null;
    }
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'BALL_STATE') {
      ball.state = msg.state || null;
      if (!ball.busy) renderBall();
      return;
    }
    if (msg.type === 'BALL_RESULT') {
      ball.busy = false;
      if (msg.state !== undefined) ball.state = msg.state;
      renderBall();
      showToast(msg.message || (msg.ok ? '已发送' : '投屏失败'), msg.ok ? 'ok' : 'err');
    }
  }

  async function onBallClick() {
    if (ball.busy) return;

    if (isCastingState(ball.state)) {
      ball.busy = true;
      renderBall();
      post({ type: 'BALL_STOP' });
      setTimeout(() => {
        if (ball.busy) {
          ball.busy = false;
          renderBall();
        }
      }, 16000);
      return;
    }

    const payload = buildPayload();
    if (!payload.ok) {
      showToast(payload.reason || '没读到视频信息', 'err');
      return;
    }

    ball.busy = true;
    renderBall();
    showToast('正在投到上次的电视…', 'ok');
    post({ type: 'BALL_CAST', video: payload.video });

    // 兜底：万一后台没回话，别让球一直转圈
    setTimeout(() => {
      if (ball.busy) {
        ball.busy = false;
        renderBall();
      }
    }, 45000);
  }

  // 心跳：保持后台 Service Worker 活着（MV3 里没有活跃端口会被回收）
  setInterval(() => {
    if (ball.host) post({ type: 'BALL_PING' });
  }, 20000);

  // 页面从后台切回来时刷新一次状态（比如刚在电视上停了）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ball.host) post({ type: 'BALL_GET_STATE' });
  });

  // ------------------------------------------------------------ 启动

  chrome.storage.local.get(['ballEnabled']).then((saved) => {
    ball.enabled = saved.ballEnabled !== false;
    if (ball.enabled) mountBall();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ballEnabled) return;
    ball.enabled = changes.ballEnabled.newValue !== false;
    if (ball.enabled) mountBall();
    else unmountBall();
  });

  // 播放器进/出全屏时立刻响应（不用等轮询）
  document.addEventListener('fullscreenchange', applyFullscreen, true);
  document.addEventListener('webkitfullscreenchange', applyFullscreen, true);
})();
