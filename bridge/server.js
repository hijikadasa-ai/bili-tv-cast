#!/usr/bin/env node
'use strict';

/**
 * 本地桥接服务。
 *
 * 职责：把浏览器扩展和电视之间的「B 站私有投屏协议（NVA）」打通。
 * 之所以需要这个进程：Chrome 扩展无法创建原始 TCP/UDP 套接字，
 * 而 NVA 是 TCP 9958 上的二进制长连接 + UDP 1900 上的 SSDP 发现。
 *
 * 启动： node bridge/server.js
 * 端口： 127.0.0.1:8787（可用环境变量 BILI_CAST_PORT 覆盖）
 */

const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ws = require('./lib/ws');
const ssdp = require('./lib/ssdp');
const bili = require('./lib/bili');
const { Caster } = require('./lib/caster');
const { StreamProxy } = require('./lib/proxy');
const nva = require('./lib/nva');

const PORT = Number(process.env.BILI_CAST_PORT || 8787);
const PROXY_PORT = Number(process.env.BILI_CAST_PROXY_PORT || 8790);
const HOST = '127.0.0.1';
const VERSION = '1.0.0';
const BUILD = '1.3.2';
const SERVICE = 'bili-tv-cast';

// 流转发：pc 线路的地址有 Referer 防盗链，电视裸连会 403，需要本机代取
const proxy = new StreamProxy({ port: PROXY_PORT, onLog: (level, msg) => log(level, msg) });

const caster = new Caster({ proxy });
let lastDevices = [];
let scanning = false;

// ------------------------------------------------------------------ 日志

function log(level, message) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const prefix = { info: '[信息]', warn: '[警告]', error: '[错误]' }[level] || '[日志]';
  console.log(`${stamp} ${prefix} ${message}`);
}

// ------------------------------------------------------------------ HTTP

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    return json(res, 200, {
      ok: true,
      service: SERVICE,
      version: VERSION,
      build: BUILD,
      uptime: process.uptime(),
      proxy: proxy.snapshot(),
    });
  }
  if (req.url === '/state') {
    return json(res, 200, caster.snapshot());
  }
  // 只允许本机调用：方便新版启动时把旧实例请下去
  if (req.url === '/shutdown' && isLocal(req)) {
    json(res, 200, { ok: true });
    setTimeout(() => {
      try {
        caster.stop();
      } catch (_) {
        /* ignore */
      }
      process.exit(0);
    }, 120);
    return undefined;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('bili-tv-cast bridge is running.\n');
});

function isLocal(req) {
  const addr = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return addr === '127.0.0.1' || addr === '::1';
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

// ------------------------------------------------------------------ WS

const hub = ws.attach(server, {
  verifyClient(req) {
    // 只接受扩展页面与本机调试客户端；Host 必须回环，防止 DNS rebinding
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return false;

    const origin = req.headers.origin || '';
    if (!origin) return true; // 本机脚本/测试
    return (
      origin.startsWith('chrome-extension://') ||
      origin === `http://127.0.0.1:${PORT}` ||
      origin === `http://localhost:${PORT}`
    );
  },
  onConnection(conn) {
    log('info', '扩展已连接');
    conn.send({ type: 'hello', version: VERSION, build: BUILD, state: caster.snapshot() });
    conn.on('message', (raw) => handleMessage(conn, raw));
    conn.on('close', () => log('info', '扩展已断开'));
  },
});

function reply(conn, id, data) {
  conn.send({ type: 'ack', id, data });
}

function fail(conn, id, message) {
  conn.send({ type: 'error', id, message: String(message) });
}

async function handleMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    return fail(conn, null, '消息格式错误');
  }

  const { id = null, type } = msg;
  const payload = msg.payload || {};

  try {
    switch (type) {
      case 'ping':
        return conn.send({ type: 'pong', at: Date.now() });

      case 'status':
        return reply(conn, id, caster.snapshot());

      case 'scan': {
        if (scanning) return reply(conn, id, { devices: lastDevices, scanning: true });

        // 快速路径：先 TCP 探测扩展记住的上次设备，在线就秒回，不用等完整搜索
        if (!payload.full) {
          const saved = (Array.isArray(payload.saved) ? payload.saved : []).filter((d) =>
            /^\d{1,3}(\.\d{1,3}){3}$/.test(String(d.ip || ''))
          );
          if (saved.length) {
            log('info', '快速探测上次的电视…');
            const alive = (
              await Promise.all(
                saved.map(async (d) => {
                  const r = await ssdp.probe(d.ip, Number(d.port) || ssdp.NVA_PORT, 800);
                  return r.ok
                    ? {
                        id: `${d.ip}:${Number(d.port) || ssdp.NVA_PORT}`,
                        ip: d.ip,
                        port: Number(d.port) || ssdp.NVA_PORT,
                        name: d.name || `上次连接 ${d.ip}`,
                        model: d.model || '',
                        brand: d.brand || '',
                        capability: d.capability || '',
                        danmaku: d.danmaku !== false,
                        remembered: true,
                      }
                    : null;
                })
              )
            ).filter(Boolean);
            if (alive.length) {
              for (const d of alive) {
                if (!lastDevices.some((x) => x.id === d.id)) lastDevices.push(d);
              }
              log('info', `上次连接的电视仍然在线（${alive[0].name || alive[0].ip}）`);
              return reply(conn, id, { devices: alive, scanning: false, fast: true });
            }
            log('info', '上次的电视不在线，开始完整搜索…');
          }
        }

        scanning = true;
        log('info', '开始搜索局域网内的云视听小电视…');
        try {
          const devices = await ssdp.discover({ timeoutMs: payload.timeoutMs || 2200 });
          lastDevices = devices;
          log('info', `发现 ${devices.length} 台 B 站电视设备`);
          return reply(conn, id, { devices, scanning: false });
        } finally {
          scanning = false;
        }
      }

      case 'probe': {
        const ip = String(payload.ip || '').trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return fail(conn, id, 'IP 格式不正确');
        const result = await ssdp.probe(ip, payload.port || ssdp.NVA_PORT);
        if (!result.ok) return fail(conn, id, `连不上 ${ip}:${payload.port || 9958}（${result.error}）`);
        const device = {
          id: `${ip}:${payload.port || ssdp.NVA_PORT}`,
          ip,
          port: payload.port || ssdp.NVA_PORT,
          name: payload.name || `手动添加 ${ip}`,
          danmaku: true,
          manual: true,
        };
        if (!lastDevices.some((d) => d.id === device.id)) lastDevices.push(device);
        return reply(conn, id, { device, devices: lastDevices });
      }

      case 'cast': {
        const device = payload.device;
        if (!device || !device.ip) return fail(conn, id, '请先选择电视设备');

        const input = payload.video || {};
        if (!input.bvid && !input.aid && !input.epId) {
          return fail(conn, id, '没有拿到视频信息，请确认当前页面是 B 站视频页');
        }

        log('info', '解析视频信息…');
        const meta = await bili.resolveVideo({
          bvid: input.bvid,
          aid: input.aid,
          epId: input.epId,
          page: input.page,
        });

        const video = {
          ...meta,
          seekTs: Math.max(0, Number(input.seekTs) || 0),
          title: input.title || meta.title,
        };

        log('info', `投屏：${video.title} ${video.partTitle || ''}（aid=${video.aid} cid=${video.cid}）`);
        await caster.cast(device, video, {
          danmakuMode: payload.danmakuMode,
          danmaku: payload.danmaku !== false,
          cookie: String(payload.cookie || ''),
          qn: Number(payload.qn) || 0,
        });
        return reply(conn, id, caster.snapshot());
      }

      case 'control': {
        const action = payload.action;
        switch (action) {
          case 'pause':
            caster.pause();
            break;
          case 'resume':
            caster.resume();
            break;
          case 'stop':
            caster.stop();
            break;
          case 'seek':
            caster.seek(payload.value);
            break;
          case 'danmaku':
            caster.setDanmaku(payload.value !== false);
            break;
          case 'danmakuMode':
            caster.setDanmakuMode(payload.value);
            break;
          case 'quality': {
            const snap = await caster.switchQuality(payload.value);
            return reply(conn, id, snap);
          }
          case 'volume':
            caster.setVolume(payload.value);
            break;
          default:
            return fail(conn, id, `未知操作：${action}`);
        }
        return reply(conn, id, caster.snapshot());
      }

      default:
        return fail(conn, id, `未知消息类型：${type}`);
    }
  } catch (err) {
    log('error', err.message);
    return fail(conn, id, err.message);
  }
}

// 会话状态广播给所有已连接页面
caster.on('state', (state) => {
  hub.broadcast({ type: 'state', data: state });
});
caster.on('log', (entry) => {
  log(entry.level, entry.message);
  hub.broadcast({ type: 'log', data: entry });
});

// ------------------------------------------------------------------ 启动

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

/** 端口是否已被监听 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function httpJson(url, { method = 'GET', timeout = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 找出监听该端口的 PID（netstat 输出是 GBK，只取 ASCII 数字部分是安全的） */
function findPidOnPort(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'latin1', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) return pid;
    }
  } catch (_) {
    /* ignore */
  }
  return 0;
}

/** 只结束确认是 node 进程的 PID，避免误杀其它程序 */
function killNodePid(pid) {
  try {
    const list = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'latin1',
      windowsHide: true,
    });
    if (!/node\.exe/i.test(list)) {
      log('warn', `占用端口的进程（PID ${pid}）不是 node.exe，不做处理`);
      return false;
    }
    execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

function waitPortFree(port, timeout = 3000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (!(await isPortInUse(port))) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/**
 * 接管端口：如果 8787 上还挂着一个旧的桥接（常见于「黑窗口没关就又双击了一次」
 * 或者升级后旧进程没退出），先把旧实例关掉。否则扩展会连到旧代码上，
 * 表现就是「明明改好了，投屏还是加载失败」。
 */
async function takeoverPort(port) {
  if (!(await isPortInUse(port))) return true;

  const health = await httpJson(`http://${HOST}:${port}/health`).catch(() => null);
  // 新版本带 service 标记；老版本只有 ok/version，也认作自己的旧实例
  const ours =
    health && (health.service === SERVICE || (health.ok === true && typeof health.version === 'string'));
  if (!ours) {
    log('error', `端口 ${port} 被其它程序占用了，请换端口：set BILI_CAST_PORT=8788`);
    return false;
  }

  log(
    'warn',
    `端口 ${port} 上还有一个旧的桥接在运行（${health.build || '旧版本'}），正在结束它…`
  );

  await httpJson(`http://${HOST}:${port}/shutdown`, { method: 'GET' }).catch(() => {});
  if (await waitPortFree(port, 1500)) {
    log('info', '旧实例已退出');
    return true;
  }

  const pid = findPidOnPort(port);
  if (pid && killNodePid(pid)) {
    if (await waitPortFree(port, 3000)) {
      log('info', '旧实例已结束');
      return true;
    }
  }
  log('error', `端口 ${port} 仍被占用，请手动关掉旧的「小电视投屏 · 本地桥接服务」黑窗口后重试`);
  return false;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', `端口 ${PORT} 已被占用，请关闭占用该端口的程序，或设置环境变量 BILI_CAST_PORT 换一个端口`);
  } else {
    log('error', err.message);
  }
  process.exit(1);
});

function onListening() {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │        小电视投屏 · 本地桥接服务             │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  监听      http://${HOST}:${PORT}`);
  console.log(`  版本      ${BUILD}`);
  console.log(`  本机地址  ${localAddresses().join('  ') || '(未检测到局域网地址)'}`);
  console.log(`  客户端 ID ${caster.clientUuid}`);
  console.log(`  流转发    ${PROXY_PORT} 端口${proxy.running ? '（电视经此取流）' : '（未启动）'}`);
  console.log('  协议      NVA / 哔哩必连（B 站私有投屏协议，TCP 9958）');
  console.log('');
  console.log('  保持本窗口运行，然后在 Chrome 里点扩展图标即可投屏。');
  console.log('');
}

(async () => {
  const free = await takeoverPort(PORT);
  if (!free) process.exit(1);
  proxy.start();
  server.listen(PORT, HOST, onListening);
})();

process.on('SIGINT', () => {
  log('info', '正在退出…');
  try {
    caster.stop();
  } catch (_) {
    /* ignore */
  }
  try {
    proxy.stop();
  } catch (_) {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
});

// 兜底：避免未捕获异常直接杀掉桥接进程
process.on('uncaughtException', (err) => log('error', `未捕获异常：${err.message}`));
process.on('unhandledRejection', (err) => log('error', `未处理拒绝：${err && err.message}`));
