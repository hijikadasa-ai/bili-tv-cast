/**
 * Popup：投屏控制面板。
 *
 * 与本地桥接进程（ws://127.0.0.1:8787）通信，
 * 桥接进程负责真正的 NVA 协议交互，所以关掉本面板不会中断投屏。
 */

const $ = (id) => document.getElementById(id);

const els = {
  bridgePill: $('bridgePill'),
  videoTitle: $('videoTitle'),
  videoMeta: $('videoMeta'),
  deviceList: $('deviceList'),
  scanBtn: $('scanBtn'),
  manualIp: $('manualIp'),
  manualBtn: $('manualBtn'),
  danmakuMode: $('danmakuMode'),
  danmakuHint: $('danmakuHint'),
  ballEnabled: $('ballEnabled'),
  castBtn: $('castBtn'),
  statusCard: $('statusCard'),
  statusText: $('statusText'),
  statusTime: $('statusTime'),
  progressBar: $('progressBar'),
  statusSub: $('statusSub'),
  qualitySelect: $('qualitySelect'),
  qualityNote: $('qualityNote'),
  pauseBtn: $('pauseBtn'),
  seekBackBtn: $('seekBackBtn'),
  logBox: $('logBox'),
};

const prefs = {
  bridgeUrl: 'ws://127.0.0.1:8787',
  danmakuMode: 'native',
  qn: 0,
  devices: [],
  lastDeviceId: null,
};

const DANMAKU_HINT = {
  native: '交给电视自己渲染',
  relay: '电脑逐条推送给电视',
  off: '电视上不显示弹幕',
};

let ws = null;
let bridgeReady = false;
let reconnectTimer = null;
let seq = 0;
const pending = new Map();

let devices = [];
let selectedId = null;
let video = null;
let snapshot = null;
let lastCastingWritten = null;

// ------------------------------------------------------------------ 工具

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function addLog(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `${time} ${message}`;
  els.logBox.prepend(line);
  while (els.logBox.childElementCount > 24) els.logBox.lastElementChild.remove();
}

function setPill(text, variant) {
  els.bridgePill.textContent = text;
  els.bridgePill.className = `pill pill-${variant}`;
}

// ------------------------------------------------------------------ 桥接连接

function connectBridge() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(prefs.bridgeUrl);
  } catch (err) {
    onBridgeDown('桥接地址无效');
    return;
  }

  setPill('连接中…', 'busy');

  ws.onopen = () => {
    bridgeReady = true;
    setPill('桥接已就绪', 'on');
    addLog('已连接本地桥接服务');
    refreshStatus();
    if (!devices.length) scanDevices({ silent: true });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    onBridgeDown('与桥接服务的连接已断开');
  };

  ws.onerror = () => {
    /* onclose 会跟着触发 */
  };
}

function onBridgeDown(reason) {
  bridgeReady = false;
  setPill('桥接未连接', 'off');
  for (const [, p] of pending) p.reject(new Error('桥接已断开'));
  pending.clear();

  if (els.logBox.childElementCount === 0) {
    addLog(reason, 'warn');
    addLog('请先双击运行「启动桥接.bat」（或 node bridge/server.js）', 'error');
  }
  renderCastButton();

  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBridge, 2500);
}

function handleBridgeMessage(msg) {
  switch (msg.type) {
    case 'hello':
      addLog(`桥接服务已就绪${msg.build ? `（build ${msg.build}）` : ''}`);
      if (!msg.build) {
        addLog('桥接是旧版本，请关掉那个黑色窗口，重新双击「1.启动桥接.bat」', 'error');
      }
      if (msg.state) applyState(msg.state);
      break;
    case 'ack': {
      const p = msg.id != null ? pending.get(msg.id) : null;
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.data);
      }
      break;
    }
    case 'error': {
      const p = msg.id != null ? pending.get(msg.id) : null;
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.message));
      } else {
        addLog(msg.message, 'error');
      }
      break;
    }
    case 'state':
      applyState(msg.data);
      break;
    case 'log':
      addLog(msg.data.message, msg.data.level);
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function call(type, payload = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('桥接服务未连接'));
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, payload }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('桥接响应超时'));
      }
    }, timeout);
  });
}

// ------------------------------------------------------------------ 页面信息

async function readVideoFromTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('没有活动标签页');

    if (!/bilibili\.com/.test(tab.url || '')) {
      els.videoTitle.textContent = '当前页面不是 B 站视频页';
      els.videoMeta.textContent = '请打开 bilibili.com 的视频或番剧页面';
      video = null;
      renderCastButton();
      return;
    }

    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO' });
    } catch (_) {
      // 内容脚本可能还没注入（例如扩展刚安装），补一次
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO' });
    }

    if (!resp || !resp.ok) {
      els.videoTitle.textContent = '正在读取视频信息…';
      els.videoMeta.textContent = (resp && resp.reason) || '刷新页面后再试一次';
      video = null;
      renderCastButton();
      return;
    }

    // 注意：ok 在响应外层，video 里没有。这里合并进 video，
    // 否则 renderCastButton 里的 video.ok 永远是 undefined，
    // 会出现「信息都读到了但按钮显示没有可投视频」的问题
    video = { ...resp.video, ok: Boolean(resp.ok) };
    renderVideo();
  } catch (err) {
    els.videoTitle.textContent = '读取页面失败';
    els.videoMeta.textContent = err.message;
    video = null;
  }
  renderCastButton();
}

function renderVideo() {
  if (!video) return;
  const title = video.partTitle
    ? `${video.title} · ${video.partTitle}`
    : video.title || '未命名视频';
  els.videoTitle.textContent = title;

  const bits = [];
  if (video.bvid) bits.push(video.bvid);
  if (video.epId) bits.push(`ep${video.epId}`);
  bits.push(`aid ${video.aid || '—'}`);
  bits.push(`cid ${video.cid}`);
  if (video.pageCount > 1) bits.push(`P${video.page}/${video.pageCount}`);
  if (video.duration) bits.push(fmtTime(video.duration));
  els.videoMeta.textContent = bits.join(' · ');
}

// ------------------------------------------------------------------ 设备

async function scanDevices({ silent = false, full = false } = {}) {
  if (!bridgeReady) {
    addLog('桥接未就绪，无法搜索设备', 'warn');
    return;
  }
  if (els.scanBtn.disabled) return;

  els.scanBtn.disabled = true;
  if (!silent) {
    els.deviceList.innerHTML = full ? '<div class="empty">正在完整搜索…（约 5 秒）</div>' : '<div class="empty">搜索中…（约 5 秒）</div>';
  }

  try {
    // 非完整模式下带上记住的设备，桥接会先快速探测它们（秒回）；
    // 手动点「重新搜索」才做完整发现
    const savedList = full
      ? []
      : devices
          .filter((d) => d && d.ip)
          .map((d) => ({
            id: d.id,
            ip: d.ip,
            port: d.port,
            name: d.name,
            model: d.model,
            brand: d.brand,
            capability: d.capability,
            danmaku: d.danmaku,
          }));

    const data = await call('scan', { saved: savedList, full }, 20000);
    const previous = devices;
    devices = data.devices || [];
    if (data.fast) addLog('上次连接的电视仍然在线，直接使用');

    // 完整搜索一条没找到时，不清空已有列表（可能是电视暂时休眠）
    if (!devices.length && previous.length && full) {
      devices = previous;
      addLog('这次没发现新设备，已保留原设备列表（确认电视没在待机？）', 'warn');
    }

    if (data.scanning) addLog('上一次搜索还在进行中', 'warn');

    if (!devices.length) {
      els.deviceList.innerHTML =
        '<div class="empty">没找到电视<br />确认电视开着「云视听小电视」，且和电脑在同一个 WiFi</div>';
    } else {
      renderDevices();
      saveDevices();
      addLog(devices.length > 1 ? `发现 ${devices.length} 台电视` : `已就绪：${devices[0].name || devices[0].ip}`);
    }
  } catch (err) {
    els.deviceList.innerHTML = `<div class="empty">搜索失败：${err.message}</div>`;
    addLog(`搜索失败：${err.message}`, 'error');
  } finally {
    els.scanBtn.disabled = false;
    renderCastButton();
  }
}

function saveDevices() {
  chrome.storage.local.set({ devices });
}

function renderDevices() {
  els.deviceList.innerHTML = '';

  if (!selectedId && devices.length) {
    const preferred = devices.find((d) => d.id === prefs.lastDeviceId);
    selectedId = preferred ? preferred.id : devices[0].id;
  }

  for (const device of devices) {
    const row = document.createElement('div');
    row.className = `device ${device.id === selectedId ? 'active' : ''}`;
    row.dataset.id = device.id;

    const dot = document.createElement('span');
    dot.className = 'device-dot';

    const body = document.createElement('div');
    body.className = 'device-body';
    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name || device.ip;
    const sub = document.createElement('div');
    sub.className = 'device-sub';
    sub.textContent = `${device.ip}:${device.port}${device.model ? ` · ${device.model}` : ''}`;
    body.append(name, sub);

    row.append(dot, body);

    if (device.danmaku) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = device.capability === '1' ? '弹幕 · 4K' : '弹幕';
      row.append(badge);
    }

    row.addEventListener('click', () => {
      selectedId = device.id;
      prefs.lastDeviceId = device.id;
      chrome.storage.local.set({ lastDeviceId: device.id });
      renderDevices();
      renderCastButton();
    });

    els.deviceList.append(row);
  }
}

async function addManualDevice() {
  const raw = els.manualIp.value.trim();
  const [ip, portText] = raw.split(':');
  const port = Number(portText) || 9958;

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    addLog('请输入正确的 IPv4 地址，可带端口，如 192.168.1.23:9958', 'warn');
    return;
  }
  if (!bridgeReady) {
    addLog('桥接未就绪', 'warn');
    return;
  }
  els.manualBtn.disabled = true;
  try {
    const data = await call('probe', { ip, port });
    devices = data.devices || [data.device];
    selectedId = data.device.id;
    prefs.lastDeviceId = selectedId;
    chrome.storage.local.set({ lastDeviceId: selectedId });
    renderDevices();
    saveDevices();
    renderCastButton();
    addLog(`已添加 ${ip}:${port}（端口可用）`);
  } catch (err) {
    addLog(err.message, 'error');
  } finally {
    els.manualBtn.disabled = false;
  }
}

// ------------------------------------------------------------------ 投屏

function currentDevice() {
  return devices.find((d) => d.id === selectedId) || null;
}

function isCasting() {
  return snapshot && (snapshot.state === 'casting' || snapshot.state === 'connecting');
}

function renderCastButton() {
  const casting = isCasting();
  const device = currentDevice();

  if (casting) {
    els.castBtn.textContent = snapshot.state === 'connecting' ? '正在连接…' : '停止投屏';
    els.castBtn.className = 'primary stop';
    els.castBtn.disabled = snapshot.state === 'connecting';
    return;
  }

  els.castBtn.className = 'primary';
  els.castBtn.disabled = !(bridgeReady && video && video.ok && device);
  els.castBtn.textContent = !bridgeReady
    ? '等待本地桥接服务'
    : !video || !video.ok
    ? '当前页面没有可投的视频'
    : !device
    ? '请先选择电视'
    : '投屏到电视';
}

async function doCast() {
  if (isCasting()) {
    await doStop();
    return;
  }
  const device = currentDevice();
  if (!device || !video) return;

  els.castBtn.disabled = true;
  els.castBtn.textContent = '正在投屏…';
  addLog(`投屏到 ${device.name || device.ip}，从 ${fmtTime(video.currentTime)} 开始`);

  // 读 B 站登录 Cookie（SESSDATA），让桥接能拿到更高清晰度的播放地址
  let sessdata = '';
  try {
    const c = await chrome.cookies.get({ url: 'https://www.bilibili.com/', name: 'SESSDATA' });
    sessdata = c ? c.value : '';
  } catch (_) {
    /* 没有 cookies 权限时忽略 */
  }

  try {
    const data = await call(
      'cast',
      {
        device,
        cookie: sessdata,
        qn: Number(els.qualitySelect.value) || prefs.qn || 0,
        danmakuMode: prefs.danmakuMode,
        video: {
          bvid: video.bvid,
          aid: video.aid,
          epId: video.epId || undefined,
          page: video.page,
          seekTs: video.currentTime || 0,
          duration: video.duration,
          title: video.title,
        },
      },
      35000
    );
    if (data) applyState(data);
    addLog('投屏指令已下发，电视开始起播');
  } catch (err) {
    addLog(err.message, 'error');
  } finally {
    renderCastButton();
  }
}

async function doStop() {
  try {
    const data = await call('control', { action: 'stop' });
    if (data) applyState(data);
  } catch (err) {
    addLog(err.message, 'error');
  }
  renderCastButton();
}

async function doPause() {
  const paused = snapshot && snapshot.playState === 5;
  try {
    const data = await call('control', { action: paused ? 'resume' : 'pause' });
    if (data) applyState(data);
  } catch (err) {
    addLog(err.message, 'error');
  }
}

async function doSeek(delta) {
  if (!snapshot) return;
  const target = Math.max(0, (snapshot.position || 0) + delta);
  try {
    const data = await call('control', { action: 'seek', value: target });
    if (data) applyState(data);
  } catch (err) {
    addLog(err.message, 'error');
  }
}

async function setDanmakuMode(mode) {
  prefs.danmakuMode = mode;
  chrome.storage.local.set({ danmakuMode: mode });
  els.danmakuHint.textContent = DANMAKU_HINT[mode] || '';

  if (!isCasting()) return;
  try {
    const data = await call('control', { action: 'danmakuMode', value: mode });
    if (data) applyState(data);
  } catch (err) {
    addLog(err.message, 'error');
  }
}

async function switchQuality(qn) {
  const value = Number(qn) || 0;
  prefs.qn = value;
  chrome.storage.local.set({ qn: value });
  if (!isCasting()) return;

  els.qualitySelect.disabled = true;
  addLog(`切换清晰度到 ${els.qualitySelect.selectedOptions[0]?.textContent || value}…`);
  try {
    const data = await call('control', { action: 'quality', value }, 35000);
    if (data) applyState(data);
    addLog('清晰度已切换');
  } catch (err) {
    addLog(`切换清晰度失败：${err.message}`, 'error');
  } finally {
    els.qualitySelect.disabled = false;
  }
}

async function refreshStatus() {
  if (!bridgeReady) return;
  try {
    const data = await call('status', {}, 4000);
    if (data) applyState(data);
  } catch (_) {
    /* ignore */
  }
}

// ------------------------------------------------------------------ 状态渲染

function applyState(state) {
  snapshot = state;
  if (!state) return;

  const active = state.state === 'casting' || state.state === 'connecting';
  els.statusCard.classList.toggle('hidden', !active);

  // 状态每秒都会推一次，只在布尔值变化时落盘，避免无谓的存储写入
  if (lastCastingWritten !== active) {
    lastCastingWritten = active;
    chrome.storage.local.set({ casting: active });
  }

  if (active) {
    const pos = state.position || 0;
    const dur = state.duration || 0;
    els.statusText.textContent = state.state === 'connecting' ? '重连中…' : state.playStateText;
    els.statusTime.textContent = `${fmtTime(pos)} / ${dur ? fmtTime(dur) : '--:--'}`;
    els.progressBar.style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
    els.pauseBtn.textContent = state.playState === 5 ? '继续' : '暂停';

    const dm = state.danmaku || {};
    const dmText =
      dm.mode === 'off'
        ? '弹幕已关闭'
        : dm.mode === 'relay'
        ? dm.total
          ? `弹幕已推送 ${dm.sent}/${dm.total} 条`
          : '弹幕加载中…'
        : '弹幕由电视渲染';

    const deviceName = (state.device && (state.device.name || state.device.ip)) || '电视';
    const qnText = state.quality && state.quality.label ? ` · ${state.quality.label}` : '';
    els.statusSub.textContent = `${deviceName} · ${dmText}${qnText}`;

    // 目标清晰度没拿到时，把原因说清楚，而不是静默降一档
    const note = state.qualityNote || '';
    if (note) {
      els.qualityNote.textContent = note;
      els.qualityNote.classList.remove('hidden');
    } else {
      els.qualityNote.textContent = '';
      els.qualityNote.classList.add('hidden');
    }

    renderQualities(state);
    renderDanmakuMode(state);
  }

  if (state.state === 'error' && state.error) {
    addLog(state.error, 'error');
  }

  renderCastButton();
}

let lastQualityKey = '';

/** 用桥接回来的清晰度列表刷新下拉框 */
function renderQualities(state) {
  const list = Array.isArray(state.qualities) ? state.qualities : [];
  const key = list.map((q) => `${q.qn}:${q.label}`).join('|');

  if (key !== lastQualityKey) {
    lastQualityKey = key;
    els.qualitySelect.innerHTML = '';
    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = '自动';
      els.qualitySelect.append(opt);
    }
    for (const q of list) {
      const opt = document.createElement('option');
      opt.value = String(q.qn);
      opt.textContent = q.label;
      els.qualitySelect.append(opt);
    }
  }

  const current = state.quality && state.quality.qn;
  if (current) {
    const v = String(current);
    if (els.qualitySelect.value !== v) els.qualitySelect.value = v;
  }
  els.qualitySelect.disabled = !list.length || state.state !== 'casting';
}

/** 电视端自己开关弹幕时，把下拉框同步回来 */
function renderDanmakuMode(state) {
  const mode = state.danmaku && state.danmaku.mode;
  if (!mode || mode === prefs.danmakuMode) return;
  prefs.danmakuMode = mode;
  els.danmakuMode.value = mode;
  els.danmakuHint.textContent = DANMAKU_HINT[mode] || '';
  chrome.storage.local.set({ danmakuMode: mode });
}

// ------------------------------------------------------------------ 启动

async function boot() {
  const saved = await chrome.storage.local.get([
    'bridgeUrl',
    'danmaku',
    'danmakuMode',
    'qn',
    'lastDeviceId',
    'devices',
    'ballEnabled',
  ]);
  if (saved.bridgeUrl) prefs.bridgeUrl = saved.bridgeUrl;
  if (saved.danmakuMode) prefs.danmakuMode = saved.danmakuMode;
  else if (typeof saved.danmaku === 'boolean') prefs.danmakuMode = saved.danmaku ? 'native' : 'off';
  if (Number(saved.qn)) prefs.qn = Number(saved.qn);
  if (saved.lastDeviceId) prefs.lastDeviceId = saved.lastDeviceId;
  if (Array.isArray(saved.devices) && saved.devices.length) {
    devices = saved.devices;
    renderDevices();
  }

  els.danmakuMode.value = prefs.danmakuMode;
  els.danmakuHint.textContent = DANMAKU_HINT[prefs.danmakuMode] || '';
  els.ballEnabled.value = saved.ballEnabled === false ? 'off' : 'on';

  els.scanBtn.addEventListener('click', () => scanDevices({ full: true }));
  els.manualBtn.addEventListener('click', addManualDevice);
  els.manualIp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addManualDevice();
  });
  els.castBtn.addEventListener('click', doCast);
  els.pauseBtn.addEventListener('click', doPause);
  els.seekBackBtn.addEventListener('click', () => doSeek(-10));
  els.danmakuMode.addEventListener('change', () => setDanmakuMode(els.danmakuMode.value));
  els.qualitySelect.addEventListener('change', () => switchQuality(els.qualitySelect.value));
  els.ballEnabled.addEventListener('change', () => {
    const on = els.ballEnabled.value !== 'off';
    chrome.storage.local.set({ ballEnabled: on });
    addLog(on ? '网页悬浮球已开启（刷新页面后出现在右下角）' : '网页悬浮球已隐藏');
  });

  connectBridge();
  await readVideoFromTab();
  renderCastButton();
}

boot();
