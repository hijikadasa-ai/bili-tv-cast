'use strict';

/**
 * 本地流转发代理。
 *
 * 为什么需要它：B 站 `platform=pc` 的播放地址带 Referer 防盗链，
 * 电视端播放器请求时不带 Referer，一律 403（表现为电视上「加载失败」）。
 * 由本机起一个 HTTP 服务，替电视去请求并补上 Referer，电视改连本机地址即可。
 * 实测电视能直接访问电脑的局域网端口（UA 为 `Bilibili Freedoooooom/MarkII`）。
 *
 * 地址形如 http://<本机局域网IP>:<port>/s/<token>.mp4
 * token 与真实地址的映射只存在内存里，重启即失效。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const ORIGIN = 'https://www.bilibili.com';

/** 地址有效期（B 站签名的地址约 120 分钟失效，这里留足余量并定期清理） */
const TTL_MS = 3 * 60 * 60 * 1000;

/**
 * 复用连接去上游。
 * B 站分轨会被播放器切成大量小 Range 请求，每个请求都重新握手 TLS 会平白多出
 * 几十毫秒延迟；1080P 码率高的时候这些延迟会累积成卡顿，所以必须 keep-alive。
 */
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 48, keepAliveMsecs: 30000 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 48, keepAliveMsecs: 30000 });

class StreamProxy {
  constructor(opts = {}) {
    this.port = Number(opts.port) || 8790;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.routes = new Map(); // token -> { url, expires, qn }
    this.server = null;
    this.running = false;
    this.hits = 0;
    this.bytes = 0;
    this.denied = 0;
    this.lastSpeed = 0; // KB/s，最近一次采样
    this._lastBytes = 0;
    this._lastActiveAt = 0;
    this._lastSpeedLogAt = 0;
    this._speedTimer = null;
  }

  /** 登记一个上游地址，返回可给电视使用的 token */
  register(url, meta = {}) {
    this._gc();
    const token = crypto.randomBytes(12).toString('hex');
    const urls = [...new Set([url, ...(meta.urls || [])].filter(Boolean))];
    this.routes.set(token, { url, urls, expires: Date.now() + TTL_MS, ...meta });
    return token;
  }

  /** 拼出给电视用的地址（带 .mp4 后缀，兼容按扩展名判断的播放器） */
  urlFor(host, token) {
    return `http://${host}:${this.port}/s/${token}.mp4`;
  }

  /**
   * 登记一路 DASH（音视频分轨），生成给电视用的 MPD 清单地址。
   * 电视端的播放器本身是吃 DASH 的（B 站 TV 客户端本来就这么播），
   * 所以把分轨地址包装成本机 MPD，比在电脑上转码更省资源、还能拖动。
   */
  registerDash(dash, meta = {}) {
    this._gc();
    const token = crypto.randomBytes(12).toString('hex');
    const videoToken = this.register(dash.video.url, {
      qn: dash.video.id,
      kind: 'dash-video',
      urls: dash.video.urls || [],
    });
    const audioToken = this.register(dash.audio.url, {
      kind: 'dash-audio',
      urls: dash.audio.urls || [],
    });
    this.routes.set(token, {
      kind: 'dash',
      dash,
      videoToken,
      audioToken,
      expires: Date.now() + TTL_MS,
      ...meta,
    });
    return token;
  }

  /** 给电视用的 MPD 地址（部分播放器只认 .mp4 后缀，两种都留） */
  mpdFor(host, token) {
    return `http://${host}:${this.port}/mpd/${token}.mp4`;
  }

  start() {
    if (this.running) return this;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (err) => {
      this.running = false;
      this.onLog('warn', `流转发端口 ${this.port} 启动失败：${err.message}`);
    });
    this.server.listen(this.port, '0.0.0.0', () => {
      this.running = true;
      this.onLog('info', `流转发已就绪（${this.port} 端口），电视将通过本机取流`);
    });
    this._startSpeedMeter();
    return this;
  }

  /** 每 5 秒采样一次实际下发速度：卡顿的时候能直接看出是没数据还是码率不够 */
  _startSpeedMeter() {
    if (this._speedTimer) return;
    this._speedTimer = setInterval(() => {
      const now = Date.now();
      const delta = this.bytes - this._lastBytes;
      this._lastBytes = this.bytes;
      if (delta <= 0) {
        this.lastSpeed = 0;
        return;
      }
      const kbps = Math.round(delta / 1024 / 5);
      this.lastSpeed = kbps;
      this._lastActiveAt = now;
      // 头 8 秒内速度过低，八成是节点限速，提示一句方便排查
      if (kbps < 150 && now - this._lastSpeedLogAt > 20000) {
        this._lastSpeedLogAt = now;
        this.onLog('warn', `取流速度偏低（${kbps} KB/s），可能节点限速，正在观察`);
      } else if (now - this._lastSpeedLogAt > 60000) {
        this._lastSpeedLogAt = now;
        this.onLog('info', `取流速度 ${(kbps / 1024).toFixed(1)} MB/s`);
      }
    }, 5000);
    if (this._speedTimer.unref) this._speedTimer.unref();
  }

  stop() {
    if (this._speedTimer) {
      clearInterval(this._speedTimer);
      this._speedTimer = null;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {
        /* ignore */
      }
      this.server = null;
    }
    this.running = false;
    this.routes.clear();
  }

  snapshot() {
    return {
      port: this.port,
      running: this.running,
      routes: this.routes.size,
      hits: this.hits,
      kbps: this.lastSpeed,
    };
  }

  _gc() {
    const now = Date.now();
    for (const [token, item] of this.routes) {
      if (item.expires <= now) this.routes.delete(token);
    }
  }

  _handle(req, res) {
    const path = String(req.url || '').split('?')[0];

    const mpd = /^\/mpd\/([a-f0-9]{16,64})\.(mpd|mp4)$/.exec(path);
    if (mpd) {
      const item = this.routes.get(mpd[1]);
      if (!item || item.kind !== 'dash' || item.expires <= Date.now()) {
        this.denied++;
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('mpd expired');
      }
      const xml = this._buildMpd(item, req.headers.host || `127.0.0.1:${this.port}`);
      res.writeHead(200, {
        'Content-Type': 'application/dash+xml',
        'Content-Length': Buffer.byteLength(xml),
        'Cache-Control': 'no-store',
      });
      return res.end(xml);
    }

    const m = /^\/s\/([a-f0-9]{16,64})\.mp4$/.exec(path);
    if (!m) {
      this.denied++;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }

    const item = this.routes.get(m[1]);
    if (!item || item.expires <= Date.now()) {
      this.denied++;
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('stream url expired');
    }

    this.hits++;
    this._forward(item, req, res, 0, 0);
  }

  /** 生成 MPD：SegmentBase + indexRange，播放器可以直接按字节区间拖动 */
  _buildMpd(item, host) {
    const { video, audio, duration } = item.dash;
    // host 可能已经带端口（请求头里的 Host）
    const base = host.includes(':') ? `http://${host}` : `http://${host}:${this.port}`;
    const vUrl = `${base}/s/${item.videoToken}.mp4`;
    const aUrl = `${base}/s/${item.audioToken}.mp4`;
    const dur = Math.max(1, Number(duration) || 0);
    const iso = `PT${dur}S`;

    const segBase = (s) => {
      const idx = String(s.indexRange || '').trim();
      const init = String(s.initRange || '').trim();
      if (!idx) return '';
      return `<SegmentBase indexRange="${idx}">${init ? `<Initialization range="${init}"/>` : ''}</SegmentBase>`;
    };

    const vCodec = video.codecs || 'avc1.640028';
    const aCodec = audio.codecs || 'mp4a.40.2';
    const vRs = video.width && video.height ? ` width="${video.width}" height="${video.height}" maxWidth="${video.width}" maxHeight="${video.height}"` : '';
    const fps = video.frameRate ? ` frameRate="${String(video.frameRate).replace('/', '/')}"` : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${iso}" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="${iso}">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1"${vRs}${fps}>
      <Representation id="v" bandwidth="${video.bandwidth || 2000000}" codecs="${vCodec}"${vRs}${fps}>
        <BaseURL>${vUrl}</BaseURL>
        ${segBase(video)}
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" lang="und">
      <Representation id="a" bandwidth="${audio.bandwidth || 132000}" codecs="${aCodec}" audioSamplingRate="48000">
        <BaseURL>${aUrl}</BaseURL>
        ${segBase(audio)}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  }

  /**
   * 把电视的请求转给上游。
   * - 每个分轨登记了多个 CDN 地址：某个节点限速/403/超时就换下一个；
   * - 走 keep-alive 连接池，避免每个小 Range 都重新握手；
   * - 电视断开就掐掉上游，别让连接挂着耗带宽。
   */
  _forward(item, req, res, attempt, redirects) {
    const list = (Array.isArray(item.urls) && item.urls.length ? item.urls : [item.url]).filter(Boolean);
    const target = list[attempt] || item.url;

    let u;
    try {
      u = new URL(target);
    } catch (_) {
      if (attempt + 1 < list.length) return this._forward(item, req, res, attempt + 1, redirects);
      res.writeHead(502);
      return res.end('bad upstream');
    }

    const lib = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? agentHttps : agentHttp;
    const headers = {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: ORIGIN,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    let headerSent = false;

    const upstream = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        agent,
      },
      (ur) => {
        const code = ur.statusCode || 0;

        // CDN 偶尔会 302 到别的节点，跟一下（最多 3 跳）
        if (code >= 300 && code < 400 && ur.headers.location && redirects < 3) {
          ur.resume();
          let next;
          try {
            next = new URL(ur.headers.location, target).toString();
          } catch (_) {
            if (attempt + 1 < list.length) {
              return this._forward(item, req, res, attempt + 1, redirects);
            }
            res.writeHead(502);
            return res.end('bad redirect');
          }
          return this._forward({ ...item, url: next, urls: [next] }, req, res, 0, redirects + 1);
        }

        // 节点不给数据就换备用节点（B 站每个分轨都给 2~4 个）
        if ((code === 403 || code === 404 || code === 410 || code >= 500) && attempt + 1 < list.length) {
          ur.resume();
          this.onLog('warn', `节点 ${u.hostname} 返回 ${code}，自动切换备用节点`);
          return this._forward(item, req, res, attempt + 1, redirects);
        }

        if (code === 403 || code === 401) {
          this.onLog('warn', `上游拒绝访问（${code}），地址可能已过期，重新投屏可刷新`);
        }

        // 切到备用节点后能取流，就把它提到首位，后续请求不用再重试坏节点
        if (attempt > 0 && code >= 200 && code < 300) {
          item.urls = [target, ...(item.urls || []).filter((x) => x !== target)];
          item.url = target;
        }

        const out = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        if (ur.headers['content-type']) out['Content-Type'] = ur.headers['content-type'];
        if (ur.headers['content-length']) out['Content-Length'] = ur.headers['content-length'];
        if (ur.headers['content-range']) out['Content-Range'] = ur.headers['content-range'];

        headerSent = true;
        res.writeHead(code, out);
        if (req.method === 'HEAD') {
          ur.resume();
          return res.end();
        }
        ur.on('data', (chunk) => {
          this.bytes += chunk.length;
        });
        ur.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      if (!headerSent) {
        if (attempt + 1 < list.length) {
          this.onLog('warn', `节点 ${u.hostname} 取流失败（${err.message}），自动切换备用节点`);
          return this._forward(item, req, res, attempt + 1, redirects);
        }
        this.onLog('warn', `流转发失败：${err.message}`);
        try {
          res.writeHead(502);
          res.end();
        } catch (_) {
          /* 已经发过响应头 */
        }
        return;
      }
      try {
        res.destroy();
      } catch (_) {
        /* ignore */
      }
    });

    // 电视提前断流（拖动/停止）时把上游也停掉
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    // 上游连上却迟迟不给数据，视为节点异常。
    // 注意别设太短：电视暂停/缓冲时播放器会停止读取，socket 会短暂空闲，
    // 误杀会让恢复播放时卡住，所以放到 60 秒。
    upstream.setTimeout(60000, () => {
      upstream.destroy(new Error('上游 60 秒没有数据'));
    });

    upstream.end();
  }
}

module.exports = { StreamProxy };
