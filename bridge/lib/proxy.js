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
  }

  /** 登记一个上游地址，返回可给电视使用的 token */
  register(url, meta = {}) {
    this._gc();
    const token = crypto.randomBytes(12).toString('hex');
    this.routes.set(token, { url, expires: Date.now() + TTL_MS, ...meta });
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
    const videoToken = this.register(dash.video.url, { qn: dash.video.id, kind: 'dash-video' });
    const audioToken = this.register(dash.audio.url, { kind: 'dash-audio' });
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
    return this;
  }

  stop() {
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
    return { port: this.port, running: this.running, routes: this.routes.size, hits: this.hits };
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
    this._forward(item.url, req, res, 0);
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
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${iso}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="${iso}">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1"${vRs}${fps}>
      <Representation id="v" bandwidth="${video.bandwidth || 2000000}" codecs="${vCodec}"${vRs}${fps}>
        <BaseURL>${vUrl}</BaseURL>
        ${segBase(video)}
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" lang="und">
      <Representation id="a" bandwidth="${audio.bandwidth || 132000}" codecs="${aCodec}" audioSamplingRate="44100">
        <BaseURL>${aUrl}</BaseURL>
        ${segBase(audio)}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  }

  _forward(target, req, res, redirects) {
    let u;
    try {
      u = new URL(target);
    } catch (_) {
      res.writeHead(502);
      return res.end('bad upstream');
    }

    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: ORIGIN,
      Accept: '*/*',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
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
            res.writeHead(502);
            return res.end('bad redirect');
          }
          return this._forward(next, req, res, redirects + 1);
        }

        if (code === 403 || code === 401) {
          this.onLog('warn', `上游拒绝访问（${code}），地址可能已过期，重新投屏可刷新`);
        }

        const out = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        if (ur.headers['content-type']) out['Content-Type'] = ur.headers['content-type'];
        if (ur.headers['content-length']) out['Content-Length'] = ur.headers['content-length'];
        if (ur.headers['content-range']) out['Content-Range'] = ur.headers['content-range'];

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
      this.onLog('warn', `流转发失败：${err.message}`);
      try {
        res.writeHead(502);
        res.end();
      } catch (_) {
        /* 已经发过响应头 */
      }
    });

    upstream.setTimeout(20000, () => {
      upstream.destroy(new Error('上游超时'));
    });

    upstream.end();
  }
}

module.exports = { StreamProxy };
