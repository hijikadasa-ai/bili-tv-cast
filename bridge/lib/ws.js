'use strict';

/**
 * 极简 RFC6455 WebSocket 服务端（零依赖）。
 *
 * 只实现本项目需要的子集：文本帧、分片重组、ping/pong、close。
 * 之所以不引第三方库，是为了让桥接进程 `node bridge/server.js` 开箱即用，
 * 不需要 npm install（国内网络下这一步经常是最大的安装阻力）。
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;

  return Buffer.concat([header, payload]);
}

class Connection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
    socket.setNoDelay(true);
  }

  _onClose() {
    if (!this.alive) return;
    this.alive = false;
    try {
      this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buf.length < offset + 2) return;
        len = this._buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this._buf.length < offset + 8) return;
        const high = this._buf.readUInt32BE(offset);
        const low = this._buf.readUInt32BE(offset + 4);
        if (high !== 0 || low > MAX_PAYLOAD) {
          this.close(1009, 'payload too large');
          return;
        }
        len = low;
        offset += 8;
      }

      if (len > MAX_PAYLOAD) {
        this.close(1009, 'payload too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (this._buf.length < offset + 4) return;
        maskKey = this._buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this._buf.length < offset + len) return;

      let payload = this._buf.subarray(offset, offset + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this._buf = this._buf.subarray(offset + len);

      this._handleFrame(opcode, fin, payload);
    }
  }

  _handleFrame(opcode, fin, payload) {
    switch (opcode) {
      case OP_PING:
        this._write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.close(1000, '');
        return;
      case OP_CONT: {
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          const op = this._fragOpcode;
          this._fragments = [];
          this._fragOpcode = 0;
          this._deliver(op, full);
        }
        return;
      }
      case OP_TEXT:
      case OP_BIN: {
        if (!fin) {
          this._fragments = [payload];
          this._fragOpcode = opcode;
          return;
        }
        this._deliver(opcode, payload);
        return;
      }
      default:
        return;
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('binary', payload);
    }
  }

  _write(buf) {
    if (!this.alive) return;
    try {
      this.socket.write(buf);
    } catch (_) {
      this._onClose();
    }
  }

  send(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this._write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (!this.alive) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._write(encodeFrame(OP_CLOSE, payload));
    this._onClose();
  }
}

/**
 * 在已有的 http.Server 上挂载 WebSocket 升级处理。
 * @param {import('http').Server} server
 * @param {object} opts
 * @param {(req: import('http').IncomingMessage) => boolean} [opts.verifyClient]
 */
function attach(server, opts = {}) {
  const connections = new Set();

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade || '').toLowerCase();

    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (opts.verifyClient && !opts.verifyClient(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );

    const conn = new Connection(socket, req);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));

    if (head && head.length) conn._onData(head);

    if (opts.onConnection) opts.onConnection(conn, req);
  });

  return {
    connections,
    broadcast(obj) {
      for (const c of connections) c.send(obj);
    },
  };
}

module.exports = { attach, Connection };
