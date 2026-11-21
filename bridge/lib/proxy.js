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

/**
 * 预读块大小。
 *
 * 电视播放器（Bilibili Freedoooooom/MarkII）不是「0- 开放式」拉流，
 * 而是按 625KB 一小段一小段地顺序请求。B 站 CDN 对这种小 Range 请求很抠：
 * 单个 625KB 往往要 1~3 秒才吐完（实测 0.2~0.5MB/s），电视于是永远缓冲不满，
 * 屏幕上就一直显示「没速度」。
 *
 * 解决办法：电视要 625KB，我们向 CDN 一次要 4MB 存进内存，之后它再要相邻的块
 * 就直接从内存回（局域网速度）。实测 4MB 的请求 CDN 给到 6~12MB/s。
 */
const BLOCK = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;

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
    this.mpdHits = 0; // 电视来取清单的次数（0 = 它根本没来拿）
    this.segHits = 0; // 电视来取分片的次数（>0 才说明清单被接受了）
    this.lastClient = '';
    this.lastRange = '';
    this.trace = []; // 最近若干条请求，排查「电视到底卡在哪一步」用
    this.lastSpeed = 0; // KB/s，最近一次采样
    this._lastBytes = 0;
    this._lastActiveAt = 0;
    this._lastSpeedLogAt = 0;
    this._speedTimer = null;
    this.cacheBytes = 0; // 预读缓存占用
    this.cacheHits = 0;
    this.upstreamSlow = 0; // 上游单块耗时超过 1.5s 的次数
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
    // H.265 分轨：后台取一次初始化段，把 hev1 改成 hvc1（见 _prepareHevcInit）
    this._prepareHevcInit(this.routes.get(videoToken), dash.video).catch(() => {});
    return token;
  }

  /**
   * 很多电视/机顶盒的播放器只认 `hvc1`（参数集在 hvcC 里），
   * 而 B 站 H.265 分轨的初始化段写的是 `hev1`，会被直接判为不支持的格式
   * ——表现就是「连上了但 0 网速」。这里提前取回初始化段，把 box 名改掉后
   * 由本机直接应答，字节数完全一致，后面的分片不受影响。
   */
  async _prepareHevcInit(item, track) {
    const v = track;
    if (!item || !v || Number(v.codecid) !== 12) return;
    const m = /^(\d+)-(\d+)$/.exec(String(v.initRange || '').trim());
    if (!m) return;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!(end > start) || end - start > 4 * 1024 * 1024) return;

    const u = new URL(v.url);
    const lib = u.protocol === 'https:' ? https : http;
    const buf = await new Promise((resolve) => {
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            'User-Agent': UA,
            Referer: REFERER,
            Range: `bytes=${start}-${end}`,
          },
        },
        (res) => {
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            resolve(null);
            return;
          }
          const total = Number(String(res.headers['content-range'] || '').split('/')[1]) || 0;
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ buf: Buffer.concat(chunks), total }));
        }
      );
      req.setTimeout(8000, () => req.destroy(new Error('超时')));
      req.on('error', () => resolve(null));
      req.end();
    });
    if (!buf || !buf.buf.length) return;

    const patched = Buffer.from(buf.buf);
    const idx = patched.indexOf(Buffer.from('hev1', 'latin1'));
    if (idx < 0) return;
    patched.write('hvc1', idx, 'latin1');
    item.initPatched = { start, end, buf: patched, total: buf.total || 0 };
    this._note('H.265 初始化段已改写 hvc1');
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
      mpdHits: this.mpdHits,
      segHits: this.segHits,
      bytes: this.bytes,
      lastClient: this.lastClient,
      lastRange: this.lastRange,
      trace: this.trace.slice(-12),
    };
  }

  /** 记一条请求摘要（只留最近 40 条，避免占内存） */
  _note(msg) {
    this.trace.push(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
    if (this.trace.length > 40) this.trace.shift();
  }

  _gc() {
    const now = Date.now();
    for (const [token, item] of this.routes) {
      if (item.expires <= now) this.routes.delete(token);
    }
  }

  _handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (process.env.BILI_PROXY_TRACE === '1') {
      this.onLog(
        'info',
        `请求 ${req.method} ${path.slice(0, 40)} range=${req.headers.range || '-'} ua=${String(
          req.headers['user-agent'] || '-'
        ).slice(0, 28)}`
      );
    }

    const mpd = /^\/mpd\/([a-f0-9]{16,64})\.(mpd|mp4)$/.exec(path);
    if (mpd) {
      const item = this.routes.get(mpd[1]);
      if (!item || item.kind !== 'dash' || item.expires <= Date.now()) {
        this.denied++;
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('mpd expired');
      }
      this.mpdHits++;
      this.lastClient = `${req.socket.remoteAddress || ''} ${req.headers['user-agent'] || ''}`.trim();
      this._note(`取清单 qn=${item.qn || '?'} ← ${req.socket.remoteAddress || '?'}`);
      if (this.mpdHits === 1) {
        this.onLog(
          'info',
          `电视来取清单了（qn=${item.qn || '?'}，${(req.headers['user-agent'] || '未知').slice(0, 60)}）`
        );
      }
      const missIdx = !(item.dash.video.indexRange && item.dash.audio.indexRange);
      if (missIdx) this.onLog('warn', '清单里缺分片索引（indexRange），电视可能一直 0 网速');
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

    // H.265 初始化段直接从内存回（已把 hev1 改成 hvc1）
    if (item.initPatched) {
      const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (r) {
        const s = Number(r[1]);
        const e = r[2] ? Number(r[2]) : item.initPatched.end;
        if (e >= s && s >= item.initPatched.start && e <= item.initPatched.end) {
          const slice = item.initPatched.buf.slice(s - item.initPatched.start, e - item.initPatched.start + 1);
          const total = item.initPatched.total || item.initPatched.end + 1;
          this.hits++;
          this.segHits++;
          this.lastRange = req.headers.range;
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${s}-${e}/${total}`,
            'Content-Length': slice.length,
            'Cache-Control': 'no-store',
          });
          return res.end(req.method === 'HEAD' ? undefined : slice);
        }
      }
    }

    this.hits++;
    this.segHits++;
    this.lastRange = req.headers.range || '整段';
    if (!item._loggedFirstGet) {
      item._loggedFirstGet = true;
      const ua = String(req.headers['user-agent'] || '未知').slice(0, 60);
      this.onLog('info', `电视开始取流（${item.kind || 'stream'}，${this.lastRange}，${ua}）`);
      this._note(`取流 ${item.kind || ''} ${this.lastRange} ← ${req.socket.remoteAddress || '?'}`);
    }
    if (this._tryRangeServe(item, req, res)) return undefined;
    this._forward(item, req, res, 0, 0);
  }

  // ---------------------------------------------------------- 预读块缓存

  /** 在缓存里找能覆盖 [s, e] 的块（e < 0 表示只要起点之后） */
  _cacheSlice(item, s, e) {
    if (!item.blocks || !item.blocks.length) return null;
    for (const b of item.blocks) {
      if (b.start > s) continue;
      if (b.buf.length === 0) continue;
      const end = b.start + b.buf.length - 1;
      if (end < s) continue;
      if (e >= 0 && end < e) continue;
      return { buf: b.buf, start: b.start, end };
    }
    return null;
  }

  _cachePut(item, start, buf, total) {
    if (!buf || !buf.length) return;
    if (!item.blocks) item.blocks = [];
    // 同一轨道最多留 8 块（约 32MB），防止用户长片拖进度条把内存吃满
    while (item.blocks.length >= 8) {
      const old = item.blocks.shift();
      this.cacheBytes -= old.buf.length;
    }
    item.blocks.push({ start, buf });
    this.cacheBytes += buf.length;
    if (total) item.total = total;
    if (item.blocks.length === 1) {
      this.onLog('info', `预读 ${(buf.length / 1048576).toFixed(1)} MB（上游 ${item._lastHost || '?'}）`);
    }
    // 全局上限：超了就从最老的开始丢
    while (this.cacheBytes > MAX_CACHE_BYTES) {
      let victim = null;
      for (const [, it] of this.routes) {
        if (it.blocks && it.blocks.length && (!victim || it.blocks[0].start < victim.blocks[0].start)) victim = it;
      }
      if (!victim) break;
      const old = victim.blocks.shift();
      this.cacheBytes -= old.buf.length;
    }
  }

  /** 向上游取一段字节（带多节点故障切换），返回 { buf, total } */
  _fetchBlock(item, start, end) {
    const list = (Array.isArray(item.urls) && item.urls.length ? item.urls : [item.url]).filter(Boolean);
    const tryOne = (i) =>
      new Promise((resolve, reject) => {
        const target = list[i] || item.url;
        let u;
        try {
          u = new URL(target);
        } catch (_) {
          return reject(new Error('bad url'));
        }
        const lib = u.protocol === 'https:' ? https : http;
        const agent = u.protocol === 'https:' ? agentHttps : agentHttp;
        const t0 = Date.now();
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            agent,
            headers: {
              'User-Agent': UA,
              Referer: REFERER,
              Origin: ORIGIN,
              Accept: '*/*',
              'Accept-Encoding': 'identity',
              Range: `bytes=${start}-${end}`,
            },
          },
          (r) => {
            const code = r.statusCode || 0;
            if (code >= 300 && code < 400 && r.headers.location) {
              r.resume();
              const next = new URL(r.headers.location, target).toString();
              list[i] = next;
              return tryOne(i).then(resolve, reject);
            }
            if (code !== 200 && code !== 206) {
              r.resume();
              return reject(new Error(`HTTP ${code}`));
            }
            const total = Number(String(r.headers['content-range'] || '').split('/')[1]) || 0;
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
              const buf = Buffer.concat(chunks);
              if (!buf.length) return reject(new Error('空响应'));
              // 成功的节点提到首位，后面的块优先用它
              if (i > 0) {
                const h = list.splice(i, 1)[0];
                list.unshift(h);
              }
              item._lastHost = u.hostname;
              const cost = Date.now() - t0;
              if (cost > 1500) this.upstreamSlow++;
              resolve({ buf, total, cost });
            });
            r.on('error', reject);
          }
        );
        req.setTimeout(25000, () => req.destroy(new Error('上游超时')));
        req.on('error', reject);
        req.end();
      });

    const run = (i) => tryOne(i).catch((err) => (i + 1 < list.length ? run(i + 1) : Promise.reject(err)));
    return run(0);
  }

  /**
   * 电视的 Range 请求优先走「整块预读 + 内存应答」。
   * 返回 true 表示已经接管（异步完成），false 表示交回原来的直传逻辑。
   */
  _tryRangeServe(item, req, res) {
    if (req.method !== 'GET') return false;
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (!m) return false;
    const s = Number(m[1]);
    const wantEnd = m[2] ? Number(m[2]) : -1;

    const hit = this._cacheSlice(item, s, wantEnd);
    if (hit) {
      this.cacheHits++;
      const end = wantEnd >= 0 ? Math.min(wantEnd, hit.end) : hit.end;
      const slice = hit.buf.slice(s - hit.start, end - hit.start + 1);
      const total = item.total || end + 1;
      res.writeHead(206, {
        'Content-Type': item.kind === 'dash-audio' ? 'audio/mp4' : 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${s}-${end}/${total}`,
        'Content-Length': slice.length,
        'Cache-Control': 'no-store',
      });
      this.bytes += slice.length;
      res.end(slice);
      return true;
    }

    // 未命中：取一个 4MB 大块，再把电视要的那一小段回给它
    const blockEnd = Math.max(s, s + BLOCK - 1);
    this._fetchBlock(item, s, blockEnd)
      .then(({ buf, total, cost }) => {
        this._cachePut(item, s, buf, total);
        const end = wantEnd >= 0 ? Math.min(wantEnd, s + buf.length - 1) : s + buf.length - 1;
        const slice = buf.slice(0, end - s + 1);
        const all = total || item.total || end + 1;
        if (cost > 1500) this.onLog('warn', `上游这一块花了 ${(cost / 1000).toFixed(1)} 秒，可能节点限速`);
        res.writeHead(206, {
          'Content-Type': item.kind === 'dash-audio' ? 'audio/mp4' : 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${s}-${end}/${all}`,
          'Content-Length': slice.length,
          'Cache-Control': 'no-store',
        });
        this.bytes += slice.length;
        res.end(slice);
      })
      .catch(() => {
        // 预读取失败就退回直传，别让电视干等
        this._forward(item, req, res, 0, 0);
      });
    return true;
  }

  /** 生成 MPD：SegmentBase + indexRange，播放器可以直接按字节区间拖动 */  _buildMpd(item, host) {
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

    // 有些电视播放器只认 hvc1，不认 hev1（两者都是 H.265，只是参数集位置不同）
    const codecOf = (s, fallback) => {
      const c = String(s.codecs || '').trim();
      if (!c) return fallback;
      return c.replace(/^hev1/i, 'hvc1');
    };

    // frameRate 只接受整数或 "a/b" 比例；"29.970" 这种小数有些解析器会直接报错
    const fpsOf = (raw) => {
      const s = String(raw || '').trim();
      if (/^\d+$/.test(s)) return s;
      if (/^\d+\/\d+$/.test(s)) return s;
      if (/^\d+\.\d+$/.test(s)) {
        const n = Number(s);
        if (isFinite(n) && n > 0) return `${Math.round(n * 1000)}/1000`;
      }
      return '';
    };
    const fpsText = fpsOf(video.frameRate);
    const fps = fpsText ? ` frameRate="${fpsText}"` : '';
    const size =
      video.width && video.height
        ? ` width="${video.width}" height="${video.height}"`
        : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${iso}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="${iso}">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1"${size}${fps}>
      <Representation id="v" bandwidth="${video.bandwidth || 2000000}" codecs="${codecOf(video, 'avc1.640028')}"${size}${fps} sar="1:1">
        <BaseURL>${vUrl}</BaseURL>
        ${segBase(video)}
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" lang="und">
      <Representation id="a" bandwidth="${audio.bandwidth || 132000}" codecs="${codecOf(audio, 'mp4a.40.2')}" startWithSAP="1">
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

        // 分轨固定用视频/音频类型：B 站 m4s 常回 application/octet-stream，
        // 严格的电视播放器会因此拒绝解码。
        const forced = item.kind === 'dash-audio' ? 'audio/mp4' : item.kind === 'dash-video' ? 'video/mp4' : '';
        const out = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
        const ct = forced || ur.headers['content-type'] || '';
        if (ct) out['Content-Type'] = ct;
        if (ur.headers['content-length']) out['Content-Length'] = ur.headers['content-length'];
        if (ur.headers['content-range']) out['Content-Range'] = ur.headers['content-range'];

        if (!item._loggedFirstOk) {
          item._loggedFirstOk = true;
          this._note(`上游 ${code} ${u.hostname} ${ur.headers['content-length'] || ''}`);
        }

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
