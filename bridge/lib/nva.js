'use strict';

/**
 * NVA（Nirvana / 哔哩必连）协议客户端 —— 投屏发送端实现。
 *
 * 这是 B 站自家的私有投屏协议（非 DLNA/UPnP 公有协议），
 * 云视听小电视（com.xiaodianshi.tv.yst）在局域网内以 DLNA 设备身份广播，
 * 但真正的控制通道是一条约 9958 端口的 TCP 长连接：
 *
 *   1) 握手：`SETUP /projection NVA/1.0`（断线重连用 `RESTORE`）
 *   2) 之后双方直接收发二进制帧（0xE0 指令 / 0xC0 回复 / 0xE4 心跳）
 *
 * 帧结构（大端）：
 *   指令   e0 | argc(1) | counter(u32) | 0x01 | 0x07 | "Command" | cmdLen(1) | cmd | [jsonLen(u32) | json]
 *   回复   c0 | argc(1) | counter(u32) | [jsonLen(u32) | json]
 *   心跳   e4 | 0x00    | counter(u32)
 *
 * 协议细节参考公开的抓包分析（xfangfang《分析Bilibili客户端的"哔哩必连"协议》）
 * 及 Macast-plugins 的接收端实现，仅用于个人学习与自用投屏。
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SEND_CMD = 0xe0;
const RET_CMD = 0xc0;
const PING = 0xe4;
const COMMAND = 'Command';

const DEFAULT_PORT = 9958;
const NVA_VERSION = '1';
const USER_AGENT = 'Linux/3.0.0 UPnP/1.0 Platinum/1.0.5.13';
const HANDSHAKE_TIMEOUT = 8000;

/** 客户端设备 UUID：'Y' + 35 位 [0-9A-Z]，同一设备需保持不变 */
function makeDeviceUuid() {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(35);
  let tail = '';
  for (let i = 0; i < 35; i++) tail += alphabet[bytes[i] % alphabet.length];
  return 'Y' + tail;
}

function makeSession() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------- 帧编解码

function encodeCommand(counter, cmd, params) {
  const cmdBuf = Buffer.from(cmd, 'utf8');
  const hasParams = params !== undefined && params !== null;
  const argc = hasParams ? 3 : 2;

  const head = Buffer.alloc(16);
  head[0] = SEND_CMD;
  head[1] = argc;
  head.writeUInt32BE(counter, 2);
  head[6] = 0x01;
  head[7] = 0x07;
  head.write(COMMAND, 8, 7, 'utf8');
  head[15] = cmdBuf.length;

  const parts = [head, cmdBuf];

  if (hasParams) {
    const json = Buffer.from(JSON.stringify(params), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(json.length, 0);
    parts.push(lenBuf, json);
  }

  return Buffer.concat(parts);
}

function encodeReply(counter, params) {
  if (params === undefined || params === null) {
    const buf = Buffer.alloc(6);
    buf[0] = RET_CMD;
    buf[1] = 0;
    buf.writeUInt32BE(counter, 2);
    return buf;
  }
  const json = Buffer.from(JSON.stringify(params), 'utf8');
  const head = Buffer.alloc(10);
  head[0] = RET_CMD;
  head[1] = 1;
  head.writeUInt32BE(counter, 2);
  head.writeUInt32BE(json.length, 6);
  return Buffer.concat([head, json]);
}

function encodePing(counter) {
  const buf = Buffer.alloc(6);
  buf[0] = PING;
  buf[1] = 0;
  buf.writeUInt32BE(counter, 2);
  return buf;
}

/**
 * 增量解析帧流。返回本次解析出的消息数组，并保留不完整的尾部。
 */
class FrameParser {
  constructor() {
    this.cache = Buffer.alloc(0);
  }

  push(chunk) {
    this.cache = Buffer.concat([this.cache, chunk]);
    const out = [];
    let index = 0;
    const data = this.cache;
    const length = data.length;

    while (index < length) {
      if (length - index < 6) break;

      const marker = data[index];
      if (marker !== SEND_CMD && marker !== RET_CMD && marker !== PING) {
        index += 1;
        continue;
      }

      const argc = data[index + 1];
      const counter = data.readUInt32BE(index + 2);

      if (marker === PING) {
        out.push({ kind: 'ping', counter });
        index += 6;
        continue;
      }

      if (marker === SEND_CMD) {
        if (argc !== 2 && argc !== 3) {
          index += 1;
          continue;
        }
        if (length - index - 6 < 10) break;

        // 0x01 | 0x07 | "Command"
        if (data[index + 6] !== 0x01) {
          index += 1;
          continue;
        }
        const cmdStrLen = data[index + 7];
        if (cmdStrLen !== 7) {
          index += 1;
          continue;
        }
        if (data.subarray(index + 8, index + 15).toString('utf8') !== COMMAND) {
          index += 1;
          continue;
        }

        const methodLen = data[index + 15];
        if (length - index - 16 < methodLen) break;

        const method = data
          .subarray(index + 16, index + 16 + methodLen)
          .toString('utf8');

        if (argc === 2) {
          out.push({ kind: 'command', method, params: undefined, counter });
          index += 16 + methodLen;
        } else {
          if (length - index - 16 < methodLen + 4) break;
          const paramLen = data.readUInt32BE(index + 16 + methodLen);
          if (length - index - 16 - methodLen - 4 < paramLen) break;
          const raw = data
            .subarray(index + 16 + methodLen + 4, index + 16 + methodLen + 4 + paramLen)
            .toString('utf8');
          let params;
          try {
            params = JSON.parse(raw);
          } catch (_) {
            params = undefined;
          }
          out.push({ kind: 'command', method, params, counter });
          index += 16 + methodLen + 4 + paramLen;
        }
        continue;
      }

      // RET_CMD
      if (argc !== 0 && argc !== 1) {
        index += 1;
        continue;
      }
      if (argc === 0) {
        out.push({ kind: 'reply', params: undefined, counter });
        index += 6;
        continue;
      }
      if (length - index - 6 < 4) break;
      const paramLen = data.readUInt32BE(index + 6);
      if (length - index - 10 < paramLen) break;
      const raw = data
        .subarray(index + 10, index + 10 + paramLen)
        .toString('utf8');
      let params;
      try {
        params = JSON.parse(raw);
      } catch (_) {
        params = undefined;
      }
      out.push({ kind: 'reply', params, counter });
      index += 10 + paramLen;
    }

    this.cache = data.subarray(index);
    return out;
  }
}

// ---------------------------------------------------------------- 客户端

class NVAClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host 电视 IP
   * @param {number} [opts.port=9958]
   * @param {string} [opts.uuid] 客户端设备 UUID（持久化，重连时复用）
   * @param {string} [opts.session] 会话 ID（重连时复用）
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || DEFAULT_PORT;
    this.uuid = opts.uuid || makeDeviceUuid();
    this.session = opts.session || makeSession();

    this.socket = null;
    this.connected = false;
    this.counter = 0;
    this.parser = new FrameParser();
    this._handshakeDone = false;
    this._buf = Buffer.alloc(0);
    this.serverUuid = null;
  }

  nextCounter() {
    this.counter += 1;
    return this.counter;
  }

  buildHandshake(method = 'SETUP') {
    return (
      `${method} /projection NVA/1.0\r\n` +
      `Session: ${this.session}\r\n` +
      `NvaVersion: ${NVA_VERSION}\r\n` +
      'Connection: Keep-Alive\r\n' +
      `UUID: ${this.uuid}\r\n` +
      `User-Agent: ${USER_AGENT}\r\n` +
      `Host: ${this.host}:${this.port}\r\n` +
      '\r\n'
    );
  }

  /**
   * 建立（或恢复）NVA 会话。
   * @param {'SETUP'|'RESTORE'} method
   */
  connect(method = 'SETUP') {
    return new Promise((resolve, reject) => {
      if (this.socket) this._teardown();

      this.counter = 0;
      this.parser = new FrameParser();
      this._buf = Buffer.alloc(0);
      this._handshakeDone = false;

      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15000);

      const timer = setTimeout(() => {
        cleanup();
        this._teardown();
        reject(new Error(`连接 ${this.host}:${this.port} 握手超时`));
      }, HANDSHAKE_TIMEOUT);

      const onError = (err) => {
        cleanup();
        this._teardown();
        reject(new Error(`无法连接 ${this.host}:${this.port}：${err.message}`));
      };

      const onData = (chunk) => {
        if (this._handshakeDone) {
          this._onFrames(chunk);
          return;
        }
        this._buf = Buffer.concat([this._buf, chunk]);
        const idx = this._buf.indexOf('\r\n\r\n');
        if (idx === -1) return;

        const head = this._buf.subarray(0, idx).toString('utf8');
        const rest = this._buf.subarray(idx + 4);
        this._buf = Buffer.alloc(0);

        const lines = head.split('\r\n');
        const statusLine = lines[0] || '';
        const headers = {};
        for (const line of lines.slice(1)) {
          const p = line.indexOf(':');
          if (p > 0) {
            headers[line.slice(0, p).trim().toLowerCase()] = line.slice(p + 1).trim();
          }
        }

        if (!/^NVA\/1\.0\s+200/.test(statusLine)) {
          cleanup();
          this._teardown();
          reject(new Error(`电视拒绝会话：${statusLine || '(空响应)'}`));
          return;
        }

        cleanup();
        this._handshakeDone = true;
        this.connected = true;
        this.serverUuid = headers.uuid || null;
        socket.on('close', () => this._onClose());
        this.emit('connect', { serverUuid: this.serverUuid, headers });

        if (rest.length) this._onFrames(rest);
        resolve({ serverUuid: this.serverUuid, headers });
      };

      const onClose = () => {
        if (!this._handshakeDone) {
          cleanup();
          reject(new Error('连接被电视关闭'));
          return;
        }
        this._onClose();
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        // 注意：data 监听必须保留，握手后同一个回调会切换到帧解析模式
      };

      socket.once('error', onError);
      socket.on('data', onData);
      socket.once('close', onClose);
      socket.on('error', () => {}); // 握手完成后的错误交给 close 处理

      socket.write(this.buildHandshake(method));
    });
  }

  _teardown() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
      this.socket = null;
    }
    if (wasConnected) this.emit('disconnect');
  }

  _onFrames(chunk) {
    let messages;
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      this.emit('error', err);
      return;
    }

    for (const msg of messages) {
      if (msg.kind === 'ping') {
        this.emit('ping', msg.counter);
      } else if (msg.kind === 'reply') {
        this.emit('reply', msg);
      } else if (msg.kind === 'command') {
        this.emit('command', msg);
      }
    }
  }

  _write(buf) {
    if (!this.socket || !this.connected) {
      throw new Error('NVA 会话未建立');
    }
    this.socket.write(buf);
  }

  /** 发送指令，返回自增序号 */
  sendCommand(cmd, params) {
    const counter = this.nextCounter();
    this._write(encodeCommand(counter, cmd, params));
    this.emit('sent', { cmd, params, counter });
    return counter;
  }

  sendReply(counter, params) {
    this._write(encodeReply(counter, params));
  }

  ping() {
    this._write(encodePing(this.nextCounter()));
  }

  close() {
    this._teardown();
  }

  // ------------------------------------------------- 高层封装（按协议语义）

  play(meta) {
    return this.sendCommand('Play', buildPlayParams(meta));
  }

  pause() {
    return this.sendCommand('Pause');
  }

  resume() {
    return this.sendCommand('Resume');
  }

  stop() {
    return this.sendCommand('Stop');
  }

  seek(seconds) {
    return this.sendCommand('Seek', { seekTs: Math.max(0, Math.round(seconds)) });
  }

  setVolume(volume) {
    return this.sendCommand('SetVolume', { volume: Math.max(0, Math.min(100, volume)) });
  }

  getVolume() {
    return this.sendCommand('GetVolume');
  }

  switchQuality(qn) {
    return this.sendCommand('SwitchQn', { qn });
  }

  switchSpeed(speed) {
    return this.sendCommand('SwitchSpeed', { speed: String(speed) });
  }

  /** 开关电视端弹幕层 */
  switchDanmaku(open) {
    return this.sendCommand('SwitchDanmaku', { open: open ? 'true' : 'false' });
  }

  /**
   * 发送一条弹幕到电视，由电视端做滚动渲染。
   * @param {{content:string, type:number, color:number, size:number, id:number}} dm
   */
  sendDanmaku(dm) {
    return this.sendCommand('SendDanmaku', {
      size: dm.size || 25,
      mRemoteDmId: dm.id | 0,
      content: dm.content !== undefined ? dm.content : dm.text,
      action: '',
      type: dm.type || 1,
      color: dm.color === undefined ? 16777215 : dm.color,
    });
  }
}

/**
 * 组装 Play 参数。
 * 真实客户端发的是下划线命名，Macast 等接收端解的是驼峰命名，
 * 这里同时下发两种拼写，兼容不同电视固件。
 */
function buildPlayParams(meta) {
  const aid = Number(meta.aid) || 0;
  const cid = Number(meta.cid) || 0;
  const epid = Number(meta.epid) || 0;
  const seasonId = Number(meta.seasonId) || 0;
  const oid = epid !== 0 ? epid : aid;

  const params = {
    aid: String(aid),
    cid: String(cid),
    epid: String(epid),
    epId: String(epid),
    oid: String(oid),
    season_id: String(seasonId),
    seasonId: String(seasonId),
    content_type: 1,
    contentType: 1,
    seekTs: Math.max(0, Math.round(Number(meta.seekTs) || 0)),
    current_qn: Number(meta.currentQn) || 0,
    desire_qn: Number(meta.desireQn) || 0,
    userDesireQn: Number(meta.desireQn) || 0,
    danmakuSwitchSave: meta.danmaku !== false,
    userDesireSpeed: 1,
  };

  if (meta.accessKey) {
    params.access_key = meta.accessKey;
    params.accessKey = meta.accessKey;
  }

  return params;
}

module.exports = {
  NVAClient,
  FrameParser,
  encodeCommand,
  encodeReply,
  encodePing,
  buildPlayParams,
  makeDeviceUuid,
  makeSession,
  DEFAULT_PORT,
};
