/**
 * Service Worker：初始化配置、图标角标，以及「网页悬浮球」的投屏引擎。
 *
 * 悬浮球在页面里（content.js），它只管 UI；真正连本地桥接、下发投屏指令
 * 都在这里做，这样即使页面刷新、面板关掉，投屏会话也不受影响
 * （桥接进程是常驻的，扩展这边断了也没关系）。
 */

const DEFAULTS = {
  bridgeUrl: 'ws://127.0.0.1:8787',
  danmaku: true,
  danmakuMode: 'native',
  qn: 0,
  devices: [],
  lastDeviceId: null,
  casting: false,
  ballEnabled: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

// ------------------------------------------------------------------ 角标

async function paintBadge(casting) {
  try {
    await chrome.action.setBadgeText({ text: casting ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FB7299' });
    await chrome.action.setTitle({
      title: casting ? '小电视投屏（投屏中）' : '小电视投屏',
    });
  } catch (_) {
    /* ignore */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.casting) paintBadge(Boolean(changes.casting.newValue));
});

chrome.runtime.onStartup.addListener(async () => {
  const { casting } = await chrome.storage.local.get('casting');
  paintBadge(Boolean(casting));
});

// ------------------------------------------------------------------ 桥接连接

const conn = {
  ws: null,
  ready: false,
  opening: null,
  seq: 0,
  pending: new Map(),
  state: null,
  url: DEFAULTS.bridgeUrl,
  build: '',
};

const ballPorts = new Set();
let castingWritten = null;

function setCastingFlag(casting) {
  if (castingWritten === casting) return;
  castingWritten = casting;
  chrome.storage.local.set({ casting });
}

/** 状态变化 → 推给所有打开了悬浮球的页面 */
function broadcastState() {
  const state = conn.state;
  for (const port of ballPorts) send(port, { type: 'BALL_STATE', state, build: conn.build });
  setCastingFlag(Boolean(state && (state.state === 'casting' || state.state === 'connecting')));
}

function send(port, msg) {
  try {
    port.postMessage(msg);
  } catch (_) {
    /* 端口已断开 */
  }
}

function ensureBridge() {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (conn.opening) return conn.opening;

  conn.opening = (async () => {
    const saved = await chrome.storage.local.get('bridgeUrl');
    conn.url = saved.bridgeUrl || DEFAULTS.bridgeUrl;

    let sock;
    try {
      sock = new WebSocket(conn.url);
    } catch (_) {
      conn.opening = null;
      throw new Error('桥接地址无效，请在扩展面板里检查');
    }

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          conn.opening = null;
          conn.ready = false;
          try {
            sock.close();
          } catch (_) {
            /* ignore */
          }
          reject(err);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(
        () => finish(new Error('连不上本地桥接服务，请先双击「1.启动桥接.bat」')),
        4500
      );

      sock.onopen = () => {
        if (done) {
          try {
            sock.close();
          } catch (_) {
            /* ignore */
          }
          return;
        }
        conn.ws = sock;
        conn.ready = true;
        finish(null);
      };

      sock.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        handleBridge(msg);
      };

      sock.onclose = () => {
        conn.ws = null;
        conn.ready = false;
        conn.opening = null;
        for (const [, p] of conn.pending) p.reject(new Error('与桥接的连接断开了'));
        conn.pending.clear();
        if (!conn.state || conn.state.state === 'stopped') {
          broadcastState();
        }
      };

      sock.onerror = () => {
        /* onclose 会跟着触发，交给它处理 */
      };
    });
  })();

  return conn.opening;
}

function handleBridge(msg) {
  switch (msg.type) {
    case 'hello':
      conn.build = msg.build || '';
      if (msg.state) {
        conn.state = msg.state;
        broadcastState();
      }
      break;
    case 'state':
      conn.state = msg.data || null;
      broadcastState();
      break;
    case 'ack': {
      const p = msg.id != null ? conn.pending.get(msg.id) : null;
      if (p) {
        conn.pending.delete(msg.id);
        p.resolve(msg.data);
      }
      break;
    }
    case 'error': {
      const p = msg.id != null ? conn.pending.get(msg.id) : null;
      if (p) {
        conn.pending.delete(msg.id);
        p.reject(new Error(msg.message));
      }
      break;
    }
    default:
      break;
  }
}

function call(type, payload = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('桥接服务未连接'));
      return;
    }
    const id = ++conn.seq;
    conn.pending.set(id, { resolve, reject });
    conn.ws.send(JSON.stringify({ id, type, payload }));
    setTimeout(() => {
      if (conn.pending.has(id)) {
        conn.pending.delete(id);
        reject(new Error('桥接响应超时'));
      }
    }, timeout);
  });
}

// ------------------------------------------------------------------ 投屏

async function sessdata() {
  try {
    // 只带 SESSDATA 时，B 站部分接口会被风控悄悄压回 720P；
    // 按真实浏览器的样子把整串登录 Cookie 带上
    const names = ['SESSDATA', 'buvid3', 'buvid4', 'bili_jct', 'DedeUserID', 'sid'];
    const pairs = [];
    for (const name of names) {
      try {
        const c = await chrome.cookies.get({ url: 'https://www.bilibili.com/', name });
        if (c && c.value) pairs.push(`${name}=${c.value}`);
      } catch (_) {
        /* 单个 cookie 读取失败不影响其他 */
      }
    }
    return pairs.join('; ');
  } catch (_) {
    return '';
  }
}

function mergeDevices(oldList, newList) {
  const map = new Map();
  for (const d of [...oldList, ...newList]) {
    if (d && d.ip) map.set(d.id || `${d.ip}:${d.port || 9958}`, d);
  }
  return [...map.values()];
}

const RETRY_HINTS = /连不上|超时|ECONN|连接|未响应|reset|closed|网络/i;

/**
 * 一键投屏：用扩展里保存的参数投到上次的电视。
 * @param {object} video content.js 读到的页面视频信息
 */
async function ballCast(video) {
  if (!video || (!video.bvid && !video.aid && !video.epId)) {
    throw new Error('没读到视频信息，刷新页面后再点一次');
  }

  const saved = await chrome.storage.local.get(['devices', 'lastDeviceId', 'qn', 'danmakuMode']);
  const devices = Array.isArray(saved.devices) ? saved.devices.filter((d) => d && d.ip) : [];
  const device = devices.find((d) => d.id === saved.lastDeviceId) || devices[0];
  if (!device) throw new Error('还没有选过电视，先点扩展图标搜一次（只需一次）');

  const body = {
    device,
    cookie: await sessdata(),
    qn: Number(saved.qn) || 0,
    danmakuMode: saved.danmakuMode || 'native',
    video: {
      bvid: video.bvid || '',
      aid: Number(video.aid) || 0,
      epId: video.epId || undefined,
      page: Number(video.page) || 1,
      seekTs: Math.max(0, Math.round(Number(video.currentTime) || 0)),
      duration: Number(video.duration) || 0,
      title: video.title || '',
    },
  };

  await ensureBridge();

  try {
    return await call('cast', body, 40000);
  } catch (err) {
    // 电视换了 IP、刚从待机醒来之类的情况：完整搜一次再试
    if (!RETRY_HINTS.test(err.message || '')) throw err;

    const found = await call('scan', { full: true, saved: [] }, 30000).catch(() => null);
    const list = (found && found.devices) || [];
    const alt = list.find((d) => d.ip === device.ip) || list[0];
    if (!alt) throw new Error(`找不到电视：${err.message}`);

    await chrome.storage.local.set({
      devices: mergeDevices(devices, list),
      lastDeviceId: alt.id,
    });
    return await call('cast', { ...body, device: alt }, 40000);
  }
}

async function ballStop() {
  await ensureBridge();
  return call('control', { action: 'stop' }, 15000);
}

// ------------------------------------------------------------------ 悬浮球端口

function sendBallState(port) {
  send(port, { type: 'BALL_STATE', state: conn.state, build: conn.build });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ball') return;
  ballPorts.add(port);
  port.onDisconnect.addListener(() => ballPorts.delete(port));

  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'BALL_PING' || msg.type === 'BALL_GET_STATE') {
      sendBallState(port);
      return;
    }

    if (msg.type === 'BALL_CAST') {
      try {
        const state = await ballCast(msg.video);
        conn.state = state || conn.state;
        const name = (state && state.device && (state.device.name || state.device.ip)) || '电视';
        send(port, { type: 'BALL_RESULT', ok: true, message: `已投到 ${name}`, state: conn.state });
        broadcastState();
      } catch (err) {
        send(port, { type: 'BALL_RESULT', ok: false, message: err.message, state: conn.state });
      }
      return;
    }

    if (msg.type === 'BALL_STOP') {
      try {
        const state = await ballStop();
        conn.state = state || conn.state;
        send(port, { type: 'BALL_RESULT', ok: true, message: '已停止投屏', state: conn.state });
        broadcastState();
      } catch (err) {
        send(port, { type: 'BALL_RESULT', ok: false, message: err.message, state: conn.state });
      }
    }
  });

  // 页面刚打开时先给一次当前状态（桥接没连过就顺手连一下，用于显示「投屏中」）
  sendBallState(port);
  if (!conn.ready) {
    ensureBridge()
      .then(() => {
        sendBallState(port);
        setCastingFlag(Boolean(conn.state && conn.state.state === 'casting'));
      })
      .catch(() => {});
  }
});
