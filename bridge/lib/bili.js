'use strict';

/**
 * B 站数据获取：视频元信息解析 + 弹幕抓取。
 *
 * 这些请求全部在本地桥接进程里发起（Node 直接走 https），
 * 因此不受浏览器同源策略限制，也方便带上正确的 Referer。
 */

const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const ssdp = require('./ssdp');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function request(url, { headers = {}, timeout = 8000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate',
          ...headers,
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(request(next, { headers, timeout, redirects: redirects - 1 }));
          return;
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} ${url}`));
            return;
          }
          resolve(decompress(Buffer.concat(chunks), res.headers['content-encoding']));
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function decompress(buf, encoding) {
  const enc = (encoding || '').toLowerCase();
  const tryOne = (fn) => {
    try {
      return fn(buf);
    } catch (_) {
      return null;
    }
  };

  if (enc.includes('br')) {
    const out = tryOne((b) => zlib.brotliDecompressSync(b));
    if (out) return out;
  }
  if (enc.includes('gzip')) {
    const out = tryOne((b) => zlib.gunzipSync(b));
    if (out) return out;
  }
  if (enc.includes('deflate')) {
    const out =
      tryOne((b) => zlib.inflateSync(b)) || tryOne((b) => zlib.inflateRawSync(b));
    if (out) return out;
  }

  // 服务端常常忽略 Accept-Encoding 直接返回 deflate，需要嗅探
  if (buf.length > 2) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const out = tryOne((b) => zlib.gunzipSync(b));
      if (out) return out;
    }
    if (buf[0] === 0x78) {
      const out = tryOne((b) => zlib.inflateSync(b));
      if (out) return out;
    }
    const raw = tryOne((b) => zlib.inflateRawSync(b));
    if (raw && raw.length > buf.length) return raw;
  }

  return buf;
}

async function getJson(url, opts) {
  const buf = await request(url, opts);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new Error(`接口返回非 JSON：${url}`);
  }
}

// ------------------------------------------------------------------ 元信息

/**
 * 解析视频信息（普通稿件 / 番剧）。
 * @param {{bvid?:string, aid?:number, epId?:number, page?:number}} input
 */
async function resolveVideo(input) {
  if (input.epId) return resolveBangumi(input.epId);

  const q = input.bvid ? `bvid=${encodeURIComponent(input.bvid)}` : `aid=${input.aid}`;
  const json = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`);

  if (json.code !== 0 || !json.data) {
    throw new Error(`获取视频信息失败：${json.message || json.code}`);
  }

  const data = json.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const index = Math.min(Math.max((input.page || 1) - 1, 0), Math.max(pages.length - 1, 0));
  const page = pages[index] || { cid: data.cid, page: 1, part: data.title, duration: data.duration };

  return {
    aid: data.aid,
    bvid: data.bvid,
    cid: page.cid,
    epid: 0,
    seasonId: 0,
    title: data.title,
    partTitle: pages.length > 1 ? page.part : '',
    page: index + 1,
    pageCount: pages.length || 1,
    duration: page.duration || data.duration || 0,
    danmakuCount: data.stat ? data.stat.danmaku : 0,
    kind: 'video',
  };
}

async function resolveBangumi(epId) {
  const json = await getJson(
    `https://api.bilibili.com/pgc/view/web/season?ep_id=${encodeURIComponent(epId)}`
  );
  if (json.code !== 0 || !json.result) {
    throw new Error(`获取番剧信息失败：${json.message || json.code}`);
  }

  const result = json.result;
  const episodes = result.episodes || [];
  const ep = episodes.find((e) => String(e.id) === String(epId)) || episodes[0];
  if (!ep) throw new Error('未找到对应剧集');

  return {
    aid: ep.aid,
    bvid: ep.bvid || '',
    cid: ep.cid,
    epid: ep.id,
    seasonId: result.season_id,
    title: result.season_title || result.title || '',
    partTitle: ep.long_title || ep.title || '',
    page: ep.title || '',
    pageCount: episodes.length,
    duration: ep.duration || 0,
    danmakuCount: 0,
    kind: 'bangumi',
  };
}

// ------------------------------------------------------------------ 弹幕

const danmakuCache = new Map(); // cid -> { at, list }
const CACHE_TTL = 10 * 60 * 1000;

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** 弹幕 id（字符串）→ 32 位有符号整数，电视端只拿它做去重标识 */
function toInt32(idStr) {
  const digits = String(idStr).replace(/\D/g, '');
  const tail = digits.length > 9 ? digits.slice(-9) : digits || '0';
  return Number(tail) | 0;
}

function mapMode(mode) {
  switch (mode) {
    case 4:
      return 4; // 底部固定
    case 5:
      return 5; // 顶部固定
    case 1:
    case 2:
    case 3:
    case 6:
      return 1; // 滚动
    default:
      return 0; // 7/8/9 为高级弹幕、代码弹幕，电视端不渲染
  }
}

function mapSize(fontSize) {
  const n = Number(fontSize) || 25;
  if (n <= 18) return 18;
  if (n >= 36) return 36;
  return 25;
}

function parseDanmakuXml(xml) {
  const list = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const parts = m[1].split(',');
    if (parts.length < 4) continue;

    const t = Number(parts[0]);
    const mode = Number(parts[1]);
    const size = Number(parts[2]);
    const color = Number(parts[3]);
    const idStr = parts[7] || parts[0];

    const type = mapMode(mode);
    if (!type) continue;

    const text = decodeEntities(m[2]).trim();
    if (!text) continue;

    list.push({
      t: Number.isFinite(t) ? t : 0,
      type,
      size: mapSize(size),
      color: Number.isFinite(color) ? color : 16777215,
      text,
      id: toInt32(idStr),
    });
  }

  list.sort((a, b) => a.t - b.t);
  return list;
}

/**
 * 拉取某个 cid 的完整弹幕池。
 * @param {number|string} cid
 * @param {{useCache?:boolean}} [opts]
 */
async function fetchDanmaku(cid, opts = {}) {
  const key = String(cid);
  const hit = danmakuCache.get(key);
  if (opts.useCache !== false && hit && Date.now() - hit.at < CACHE_TTL) {
    return hit.list;
  }

  let xml = null;
  const sources = [
    `https://comment.bilibili.com/${key}.xml`,
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${key}`,
  ];

  for (const url of sources) {
    try {
      const buf = await request(url);
      const text = buf.toString('utf8');
      if (text.includes('<d ') || text.includes('</i>')) {
        xml = text;
        break;
      }
    } catch (_) {
      /* 换下一个源 */
    }
  }

  if (!xml) throw new Error('弹幕拉取失败（可能是版权限制或需要登录）');

  const list = parseDanmakuXml(xml);
  if (list.length > 40000) list.length = 40000;

  danmakuCache.set(key, { at: Date.now(), list });
  return list;
}

// ------------------------------------------------------------------ 播放地址

// 电视端 App 的签名用 appkey（与 Macast 接收端一致）
const NVA_APP_KEY = '4ebafd7c4951b366';
const NVA_APP_SEC = '8cb98205e9b2ad3669aad0fce12a4c13';

const STREAM_UA = 'Macast';
const STREAM_REFERER = 'https://www.bilibili.com/client';

/** 清晰度 qn → 屏显文案（B 站官方叫法） */
const QN_LABEL = {
  6: '240P',
  16: '流畅 360P',
  32: '清晰 480P',
  64: '高清 720P',
  74: '高清 720P60',
  80: '高清 1080P',
  112: '高码率 1080P+',
  116: '高清 1080P60',
  120: '超清 4K',
  125: '真彩 HDR',
  126: '杜比视界',
  127: '8K',
};

/**
 * 电视播放器能认的编码，优先级从高到低。
 * 7=H.264（最稳，几乎所有电视都支持）
 * 12=H.265（多数新电视支持，但 10bit HDR 常常翻车）
 * 13=AV1、14=杜比视界：老电视基本解不了，先排除
 */
const CODEC_AVC = 7;
const CODEC_HEVC = 12;
const CODEC_AV1 = 13;
const CODEC_DV = 14;
const CODEC_RANK = { 7: 3, 12: 2 };

/**
 * 电视端播放器只认「普通 CDN 直链」：实测 B 站给未登录/网页端返回的
 * PCDN 代理地址（如 *.edge.mountaintoys.cn:4483）电视一律「加载失败」，
 * 而 *.bilivideo.com / 裸 IP 的 mp4 直链都能正常播。
 * 所以拉流后要校验 host，不合适的直接换线路。
 */
const GOOD_HOSTS = [
  'bilivideo.com',
  'bilivideo.cn',
  'akamaized.net',
  'ourdvsss.com',
  'szbdyd.com',
  'mcdn.bilivideo.cn',
  'biliapi.com',
  'hdslb.com',
];

function isPlayableStreamUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // 非标准端口多半是 PCDN 代理，电视播不了
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) return true;
  return GOOD_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

function qnLabel(qn, desc) {
  return desc || QN_LABEL[Number(qn)] || `QN${qn}`;
}

/** 把接口返回的 accept_quality / accept_description 归一成清晰度列表 */
function normalizeAccept(data) {
  const qs = Array.isArray(data.accept_quality) ? data.accept_quality : [];
  const ds = Array.isArray(data.accept_description) ? data.accept_description : [];
  const out = [];
  qs.forEach((q, i) => {
    const qn = Number(q);
    if (qn > 0) out.push({ qn, label: qnLabel(qn, ds[i]) });
  });
  return out;
}

function mergeAccept(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (!map.has(item.qn)) map.set(item.qn, item);
    }
  }
  return [...map.values()].sort((a, b) => b.qn - a.qn);
}

function nvaSignQuery(params) {
  const withTs = { ...params, appkey: NVA_APP_KEY, ts: Math.floor(Date.now() / 1000) };
  const build = (obj) =>
    Object.keys(obj)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(String(obj[k]))}`)
      .join('&');
  withTs.sign = crypto.createHash('md5').update(build(withTs) + NVA_APP_SEC).digest('hex');
  return build(withTs);
}

/**
 * 拉取一个能投给电视的播放地址。
 *
 * 关键事实（都实测过）：
 *   - `platform=html5&high_quality=1` 的地址**无 Referer 鉴权**，可直接给电视播；
 *     登录后该参数可让画质上到 1080P（未登录 B 站只给 720P）
 *   - `platform=pc` 的地址带 Referer 防盗链，电视裸连一律 403，
 *     必须经本机流转发（bridge/lib/proxy.js）补上 Referer 才能播
 *
 * 所以策略是：先要 html5 的免鉴权地址；拿不到目标清晰度时，
 * 再用 pc 接口要更高的，并把地址标记为「需要本机转发」。
 *
 * @param {{aid?:number|string, bvid?:string, cid?:number|string, epId?:number|string,
 *          cookie?:string, qn?:number}} input
 * @returns {Promise<{url:string, qn:number, source:string, timelength:number, needsProxy:boolean,
 *                    accept:Array<{qn:number,label:string}>}>}
 */
async function fetchPlayUrl(input) {
  const cid = Number(input.cid) || 0;
  if (!cid) throw new Error('缺少 cid，无法获取播放地址');

  const want = Number(input.qn) || 0;
  const tried = [];
  const lines = [];
  const cands = [];

  // 0) 用户明确要 1080P 且合并流拿不到时，走 DASH（音视频分轨，交给本机合流/直发）
  if (input.preferDash) {
    try {
      const dash = await fetchDashStreams(input, want || 80);
      return {
        url: '',
        dash,
        qn: dash.video.id,
        source: 'dash',
        timelength: dash.duration * 1000,
        needsProxy: false,
        accept: [],
        lines: [{ source: 'dash', qn: dash.video.id }],
      };
    } catch (err) {
      tried.push(`dash（${err.message}）`);
      lines.push({ source: 'dash', qn: 0, err: err.message });
    }
  }

  // 1) html5 线路：地址免鉴权，登录后 high_quality=1 可到 1080P
  try {
    const r = await fetchPlayUrlViaHtml5(input, cid, want || 80);
    cands.push(r);
    lines.push({ source: 'html5', qn: r.qn });
  } catch (err) {
    tried.push(`html5（${err.message}）`);
    lines.push({ source: 'html5', qn: 0, err: err.message });
  }

  // 2) 目标档位比 html5 给的高，再按「网页播放器同款」顺序要更高的：
  //    wbi 签名接口（最贴近真实网页播放）→ 老接口（fnval=1, platform=pc）
  const top = pickBest(cands);
  if (want >= 80 && (!top || top.qn < want)) {
    for (const qn of [...new Set([want, 80])]) {
      if (top && qn <= top.qn) continue;
      try {
        const r = await fetchPlayUrlViaWbi(input, cid, qn);
        cands.push(r);
        lines.push({ source: 'wbi', qn: r.qn });
        if (r.qn >= want) break;
      } catch (err) {
        tried.push(`wbi qn=${qn}（${err.message}）`);
        lines.push({ source: 'wbi', qn: 0, err: err.message });
      }
      try {
        const r = await fetchPlayUrlViaWeb(input, cid, qn);
        cands.push(r);
        lines.push({ source: 'web', qn: r.qn });
        if (r.qn >= want) break;
      } catch (err) {
        tried.push(`网页 qn=${qn}（${err.message}）`);
        lines.push({ source: 'web', qn: 0, err: err.message });
      }
    }
  }

  const winner = pickBest(cands);
  if (winner && (!want || winner.qn >= want)) {
    return { ...winner, accept: mergeAccept(...cands.map((c) => c.accept)), lines };
  }

  // 3) 电视/App 端接口：返回的是合并好的 mp4（durl），
  //    它的权限口径和网页端不同——文档里 qn=80 就是 TV 端默认，登录即可。
  //    网页端新视频的 1080P 只剩 DASH 分轨时，这条路常常还有 mp4。
  try {
    const r = await fetchPlayUrlViaTv(input, cid, want || 80);
    // 电视接口的 accept 列表虚高（匿名也报 112/80），不作为 UI 清晰度来源
    r.accept = [];
    cands.push(r);
    lines.push({ source: 'tv', qn: r.qn });
  } catch (err) {
    tried.push(`电视接口（${err.message}）`);
    lines.push({ source: 'tv', qn: 0, err: err.message });
  }

  const best = pickBest(cands);
  if (best) {
    return { ...best, accept: mergeAccept(...cands.map((c) => c.accept)), lines };
  }

  throw new Error(`获取播放地址失败：${tried.join('；')}`);
}

/** 候选里挑一个：清晰度高的优先；同清晰度优先不需要转发的 */
function pickBest(list) {
  const usable = (list || []).filter((x) => x && x.url);
  if (!usable.length) return null;
  return usable.sort((a, b) => {
    if (b.qn !== a.qn) return b.qn - a.qn;
    return Number(a.needsProxy) - Number(b.needsProxy);
  })[0];
}

/** 兼容兜底：只走电视 App 匿名接口（360P），用于自动降级 */
async function fetchFallbackStream(input) {
  const cid = Number(input.cid) || 0;
  if (!cid) throw new Error('缺少 cid');
  return fetchPlayUrlViaTv(input, cid, 0);
}

/** 拼公共查询串（番剧用 ep_id，普通稿件用 bvid/avid） */
function buildStreamQuery(input, cid) {
  const q = new URLSearchParams({ cid: String(cid) });
  const epId = Number(input.epId) || 0;
  if (epId) q.set('ep_id', String(epId));
  if (input.bvid) q.set('bvid', String(input.bvid));
  else if (input.aid) q.set('avid', String(input.aid));
  return q;
}

function cookieHeaders(cookie) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
  const raw = String(cookie || '').trim();
  if (raw) {
    // 兼容两种形态：完整 "k=v; k=v" 串，或只有 SESSDATA 裸值（裸值里不会出现 =）
    headers.Cookie = raw.includes('=') ? raw : `SESSDATA=${raw}`;
  }
  return headers;
}

// ------------------------------------------------------------------ Wbi 签名
// B 站网页播放器走的是 x/player/wbi/playurl（带 wbi 签名），这是和
// 「用户实际看到的画质」最一致的一条线路；老的 playurl 接口在部分
// 账号/环境下会被风控悄悄压回 720P。

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26,
  17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

let wbiCache = { keys: null, at: 0 };

function basenameNoExt(u) {
  const name = String(u || '').split('/').pop() || '';
  return name.replace(/\.[a-z]+$/i, '');
}

async function getWbiKeys() {
  if (wbiCache.keys && Date.now() - wbiCache.at < 3600 * 1000) return wbiCache.keys;
  const json = await getJson('https://api.bilibili.com/x/web-interface/nav');
  const img = json && json.data && json.data.wbi_img;
  if (!img || !img.img_url || !img.sub_url) throw new Error('拿不到 wbi 密钥');
  const keys = {
    img: basenameNoExt(img.img_url),
    sub: basenameNoExt(img.sub_url),
  };
  wbiCache = { keys, at: Date.now() };
  return keys;
}

function wbiMixinKey(keys) {
  const orig = keys.img + keys.sub;
  let out = '';
  for (const i of MIXIN_TAB) if (orig[i]) out += orig[i];
  return out.slice(0, 32);
}

function wbiSign(params, mixinKey) {
  const cleaned = {};
  for (const [k, v] of Object.entries(params)) {
    // 官方前端同款：过滤值里的 !'()* 字符
    cleaned[k] = String(v).replace(/[!'()*]/g, '');
  }
  cleaned.wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(cleaned)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k])}`)
    .join('&');
  const sign = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${sign}`;
}

/** 登录态校验（带缓存）：用于把「拿不到 1080P」的原因说准 */
let loginCache = { key: '', at: 0, info: null };
async function checkLogin(cookie) {
  const key = String(cookie || '');
  if (!key) return { isLogin: false, uname: '', vip: 0 };
  if (loginCache.key === key && Date.now() - loginCache.at < 5 * 60 * 1000) {
    return loginCache.info;
  }
  let info = { isLogin: false, uname: '', vip: 0 };
  try {
    const json = await getJson('https://api.bilibili.com/x/web-interface/nav', {
      headers: cookieHeaders(key),
    });
    const d = json && json.data;
    if (d && d.isLogin) {
      info = { isLogin: true, uname: d.uname || '', vip: Number(d.vipStatus) || 0 };
    }
  } catch (_) {
    /* 网络问题不当作未登录，保持默认并让拉流线路自己说话 */
    info = { isLogin: null, uname: '', vip: 0 };
  }
  loginCache = { key, at: Date.now(), info };
  return info;
}

/** 拉一次 DASH 信息（不用于播放，只用于诊断）：
 *  accept = 接口按「账号权限」允许的清晰度；encoded = 视频实际编码的清晰度。
 *  两者一对比就知道到底是「视频没有 1080P」还是「账号/登录没被承认」。 */
async function fetchDashInfo(input, qn = 80) {
  const cid = Number(input.cid) || 0;
  if (!cid) throw new Error('缺少 cid');
  const q = {
    cid: String(cid),
    qn: String(qn),
    fnval: '16',
    fnver: '0',
    fourk: '1',
    platform: 'pc',
  };
  if (input.epId) q.ep_id = String(input.epId);
  if (input.bvid) q.bvid = String(input.bvid);
  else if (input.aid) q.avid = String(input.aid);

  const keys = await getWbiKeys();
  const json = await getJson(
    `https://api.bilibili.com/x/player/wbi/playurl?${wbiSign(q, wbiMixinKey(keys))}`,
    { headers: cookieHeaders(input.cookie) }
  );
  if (json.code !== 0 || !json.data) throw new Error(json.message || `code ${json.code}`);
  const d = json.data;
  const encoded = [];
  for (const v of (d.dash && d.dash.video) || []) {
    const id = Number(v.id);
    if (id && !encoded.includes(id)) encoded.push(id);
  }
  encoded.sort((a, b) => b - a);
  return { accept: normalizeAccept(d), encoded, quality: Number(d.quality) || 0 };
}

/**
 * 清晰度诊断：一次把「登录态 + 接口允许 + 视频实际编码」都查清。
 * 只在没拿到目标清晰度时调用，不参与正常播放。
 */
async function diagnose(input, want = 0) {
  const out = { login: { isLogin: null, uname: '', vip: 0 }, accept: [], encoded: [], mp4: 0, err: '' };
  out.login = await checkLogin(input.cookie);
  try {
    const d = await fetchDashInfo(input, want >= 80 ? want : 80);
    out.accept = d.accept.map((x) => x.qn);
    out.encoded = d.encoded;
    out.mp4 = d.quality;
  } catch (err) {
    out.err = err.message;
  }
  return out;
}

async function fetchPlayUrlViaHtml5(input, cid, qn) {
  const q = buildStreamQuery(input, cid);
  q.set('qn', String(qn || 64));
  q.set('fnver', '0');
  q.set('platform', 'html5');
  q.set('high_quality', '1');

  const json = await getJson(`https://api.bilibili.com/x/player/playurl?${q.toString()}`, {
    headers: cookieHeaders(input.cookie),
  });
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `code ${json.code}`);
  }
  const url = pickDurl(json.data);
  if (!url) throw new Error('没有返回合并流');

  return {
    url,
    urls: durlUrls(json.data),
    parts: durlParts(json.data),
    qn: Number(json.data.quality) || qn,
    source: 'html5',
    timelength: Number(json.data.timelength) || 0,
    // html5 线路理论上免鉴权；万一给了非常规地址，也走本机转发兜住
    needsProxy: !isPlayableStreamUrl(url),
    accept: normalizeAccept(json.data),
  };
}

/** fnval=1：网页端合并流，登录后可到 1080P；地址有 Referer 鉴权，必须走本机转发 */
async function fetchPlayUrlViaWeb(input, cid, qn) {
  const q = buildStreamQuery(input, cid);
  q.set('qn', String(qn || 80));
  q.set('fnval', '1');
  q.set('fnver', '0');
  q.set('fourk', '1');
  q.set('platform', 'pc');

  const json = await getJson(`https://api.bilibili.com/x/player/playurl?${q.toString()}`, {
    headers: cookieHeaders(input.cookie),
  });
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `code ${json.code}`);
  }
  const url = pickDurl(json.data);
  if (!url) throw new Error('没有返回合并流');

  return {
    url,
    urls: durlUrls(json.data),
    parts: durlParts(json.data),
    qn: Number(json.data.quality) || qn,
    source: 'web',
    timelength: Number(json.data.timelength) || 0,
    needsProxy: true,
    accept: normalizeAccept(json.data),
  };
}

/** x/player/wbi/playurl：B 站网页播放器实际使用的接口（带 wbi 签名），
 *  对登录账号的 1080P 授权判定最准确；地址有 Referer 鉴权，走本机转发 */
async function fetchPlayUrlViaWbi(input, cid, qn) {
  const q = {
    cid: String(cid),
    qn: String(qn || 80),
    fnval: '1',
    fnver: '0',
    fourk: '1',
    platform: 'pc',
    high_quality: '1',
  };
  if (input.epId) q.ep_id = String(input.epId);
  if (input.bvid) q.bvid = String(input.bvid);
  else if (input.aid) q.avid = String(input.aid);

  const keys = await getWbiKeys();
  const query = wbiSign(q, wbiMixinKey(keys));

  const json = await getJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, {
    headers: cookieHeaders(input.cookie),
  });
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `code ${json.code}`);
  }
  const url = pickDurl(json.data);
  if (!url) throw new Error('没有返回合并流');

  return {
    url,
    urls: durlUrls(json.data),
    parts: durlParts(json.data),
    qn: Number(json.data.quality) || qn,
    source: 'wbi',
    timelength: Number(json.data.timelength) || 0,
    needsProxy: true,
    accept: normalizeAccept(json.data),
  };
}

async function fetchPlayUrlViaTv(input, cid, qn) {
  const aid = Number(input.aid) || 0;
  const epId = Number(input.epId) || 0;
  const oid = epId !== 0 ? epId : aid;
  if (!oid) throw new Error('缺少 aid/epId');

  const query = nvaSignQuery({
    access_key: '',
    actionKey: 'appkey',
    build: 36700100,
    cid,
    fourk: 1,
    is_proj: 1,
    mobile_access_key: '',
    object_id: oid,
    ogv_aid: aid,
    platform: 'ios',
    playurl_type: epId !== 0 ? 2 : 1,
    protocol: 0,
    qn: Number(qn) || 0,
  });

  const json = await getJson(`https://api.bilibili.com/x/tv/playurl?${query}`, {
    headers: {
      'User-Agent': STREAM_UA,
      Referer: STREAM_REFERER,
      Origin: 'https://www.bilibili.com',
      ...(input.cookie ? { Cookie: String(input.cookie).includes('=') ? String(input.cookie) : `SESSDATA=${input.cookie}` } : {}),
    },
  });
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `code ${json.code}`);
  }
  const url = pickDurl(json.data);
  if (!url) throw new Error('没有返回合并流');

  return {
    url,
    urls: durlUrls(json.data),
    parts: durlParts(json.data),
    qn: Number(json.data.quality) || 0,
    source: 'tv',
    timelength: Number(json.data.timelength) || 0,
    needsProxy: true,
    accept: normalizeAccept(json.data),
  };
}

/** PCDN 节点：第三方播放器上容易掉速，选节点时让位给官方 upos */
const PCDN_RE = /(mcdn\.bilivideo|szbdyd\.com|mountaintoys\.cn|pcdn|bilivideo\.com\.mcdn)/i;

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function isPcdnUrl(url) {
  return PCDN_RE.test(safeHost(url));
}

/** 试拉 128KB，量一下这个节点实际给多快（B 站每个分轨会给 2~4 个备用地址） */
function probeNode(url, timeout = 2500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      resolve({ url, ok: false, err: '地址无效' });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : require('http');
    const t0 = Date.now();
    let bytes = 0;
    let done = false;
    let req = null;
    const timer = setTimeout(() => {
      try {
        req && req.destroy();
      } catch (_) {
        /* ignore */
      }
      finish({ url, ok: bytes > 16384, bytes, speed: 0, err: '超时' });
    }, timeout);

    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    }

    req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Range: 'bytes=0-131071',
        },
      },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          finish({ url, ok: false, status: res.statusCode });
          return;
        }
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes >= 65536) {
            const ms = Math.max(1, Date.now() - t0);
            try {
              req.destroy();
            } catch (_) {
              /* ignore */
            }
            finish({ url, ok: true, bytes, ms, speed: Math.round(bytes / 1024 / (ms / 1000)) });
          }
        });
        res.on('end', () => {
          const ms = Math.max(1, Date.now() - t0);
          finish({
            url,
            ok: bytes > 16384,
            bytes,
            ms,
            speed: Math.round(bytes / 1024 / (ms / 1000)),
          });
        });
        res.on('error', () => finish({ url, ok: bytes > 16384, bytes, speed: 0 }));
      }
    );
    req.on('error', (e) => finish({ url, ok: false, err: e.message }));
    req.end();
  });
}

/** 并行测速挑最快的节点；速度接近时优先官方 upos（PCDN 长时间容易掉速） */
async function pickFastestNode(urls, avoidHost) {
  const all = [...new Set((urls || []).filter(Boolean))];
  if (!all.length) return { url: '', host: '', speed: 0, candidates: [] };
  // 上一轮用过的节点没播起来时，优先换别的节点
  const alts = avoidHost ? all.filter((u) => safeHost(u) !== avoidHost) : all;
  const list = alts.length ? alts : all;
  if (list.length === 1) {
    return { url: list[0], host: safeHost(list[0]), speed: 0, candidates: all };
  }
  const probes = await Promise.all(list.slice(0, 4).map((u) => probeNode(u)));
  const ok = probes.filter((p) => p.ok && p.speed > 0).sort((a, b) => b.speed - a.speed);
  if (
    ok.length > 1 &&
    isPcdnUrl(ok[0].url) &&
    !isPcdnUrl(ok[1].url) &&
    ok[0].speed < ok[1].speed * 1.3
  ) {
    [ok[0], ok[1]] = [ok[1], ok[0]];
  }
  const best = ok[0];
  if (!best) {
    return { url: list[0], host: safeHost(list[0]), speed: 0, candidates: all };
  }
  return {
    url: best.url,
    host: safeHost(best.url),
    speed: Math.round(best.speed || 0),
    candidates: [...new Set([best.url, ...all.filter((u) => u !== best.url)])],
  };
}

/**
 * 挑电视能解码的音轨：只要 AAC（mp4a）。
 * 大会员账号的 DASH 里会多出杜比全景声（ec-3）、Hi-Res（FLAC）等音轨，
 * 带宽比 AAC 大得多，按带宽挑就会选中它们——电视解不了，表现就是
 * 「一直缓冲、网速为 0」。手机 App 投屏正常是因为它自己会挑 AAC。
 */
function pickAudioTrack(audios) {
  const aac = audios.filter((a) => /^mp4a/i.test(String(a.codecs || '')) || a.id === 30216 || a.id === 30232 || a.id === 30280);
  const pool = aac.length ? aac : audios;
  return pool.sort((a, b) => {
    // 同是 AAC 时优先 192K（30280），再按带宽
    const rank = (t) => (t.id === 30280 ? 3 : t.id === 30232 ? 2 : t.id === 30216 ? 1 : 0);
    return rank(b) - rank(a) || b.bandwidth - a.bandwidth;
  })[0];
}

/** 取一小段字节，用来检查分轨的文件结构 */
function fetchRange(url, start, end, timeout = 6000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      resolve(Buffer.alloc(0));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : require('http');
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Range: `bytes=${start}-${end}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          resolve(Buffer.alloc(0));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('超时')));
    req.on('error', () => resolve(Buffer.alloc(0)));
    req.end();
  });
}

/** 扫一遍顶层 MP4 box，拿到 ftyp/moov/sidx 的字节区间 */
function scanTopBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      out.push({ type, start: off, end: buf.length - 1 });
      break;
    }
    if (size < header + 1 || off + size > buf.length) break;
    out.push({ type, start: off, end: off + size - 1 });
    off += size;
  }
  return out;
}

/**
 * 补齐分轨的 initialization / index 区间。
 * B 站一般直接给 segment_base，但个别清晰度只给空对象；这时清单里没有
 * 分片信息，播放器会「连上了但一个字节都不取」——看着就是 0 网速。
 * 这里自己读前 256KB 把 moov/sidx 找出来补上。
 */
async function repairSegmentBase(track) {
  if (!track || (track.initRange && track.indexRange)) return track;
  const head = await fetchRange(track.url, 0, 262143);
  if (!head.length) return track;
  const boxes = scanTopBoxes(head);
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const moov = boxes.find((b) => b.type === 'moov');
  const sidx = boxes.find((b) => b.type === 'sidx');
  if (!track.initRange && moov) {
    track.initRange = `${ftyp ? ftyp.start : 0}-${moov.end}`;
    track.repaired = true;
  }
  if (!track.indexRange && sidx) {
    track.indexRange = `${sidx.start}-${sidx.end}`;
    track.repaired = true;
  }
  return track;
}

/**
 * 挑视频轨：先看用户要的那一档，同档位优先 H.264。
 * allowHevc=false 时只用 H.264（电视解不了 H.265 时的保命选项）。
 */
function pickVideoTrack(videos, wantQn, opts = {}) {
  const allowHevc = opts.allowHevc !== false;
  let pool = videos.filter((v) => v.codecid !== CODEC_AV1 && v.codecid !== CODEC_DV);
  if (!allowHevc) {
    const avc = pool.filter((v) => v.codecid === CODEC_AVC || !v.codecid);
    if (avc.length) pool = avc;
  }
  if (!pool.length) pool = videos.slice();

  const cap = Number(wantQn) || 0;
  const within = cap ? pool.filter((v) => v.id <= cap) : pool;
  const usable = within.length ? within : pool;
  const maxId = Math.max(...usable.map((v) => v.id));

  // 4K 及以上：电视硬件解不了 High Profile L5.2 的 4K H.264（实测
  // ff_video_dec fail ret:-100 codec_id:27，拉了 68MB 也出不了画面），
  // 必须优先 H.265；1080P 及以下反过来 H.264 兼容性最好。
  const needHevc = maxId >= 112;
  const avcLevel = (v) => {
    const m = String(v.codecs || '').match(/([0-9A-Fa-f]{2})$/);
    return m ? parseInt(m[1], 16) : 0; // avc1.640034 → 0x34 = Level 5.2
  };
  const rank = (v) => {
    if (v.codecid === CODEC_HEVC) return needHevc ? 4 : 2;
    if (v.codecid === CODEC_AVC || !v.codecid) {
      // H.264 规格超过 Level 5.1 的（只有 4K 轨会这样），电视多半解不了
      return avcLevel(v) >= 0x33 ? (needHevc ? 1 : 3) : 3;
    }
    return 0;
  };
  const same = usable
    .filter((v) => v.id === maxId)
    .sort((a, b) => rank(b) - rank(a) || b.bandwidth - a.bandwidth);
  return same[0] || null;
}

/** 取 DASH 分轨（音视频分离）：新视频的 1080P 只存在这里 */
async function fetchDashStreams(input, wantQn, opts = {}) {
  const cid = Number(input.cid) || 0;
  if (!cid) throw new Error('缺少 cid');
  const q = {
    cid: String(cid),
    qn: String(wantQn || 80),
    // 4048 = DASH(16) + 8K/HDR/杜比 等全部特性位：
    // 用 16 时接口不会把「真彩 HDR」「杜比视界」放进清晰度列表
    fnval: '4048',
    fnver: '0',
    fourk: '1',
    platform: 'pc',
  };
  if (input.epId) q.ep_id = String(input.epId);
  if (input.bvid) q.bvid = String(input.bvid);
  else if (input.aid) q.avid = String(input.aid);

  const keys = await getWbiKeys();
  const json = await getJson(
    `https://api.bilibili.com/x/player/wbi/playurl?${wbiSign(q, wbiMixinKey(keys))}`,
    { headers: cookieHeaders(input.cookie) }
  );
  if (json.code !== 0 || !json.data) throw new Error(json.message || `code ${json.code}`);
  const d = json.data;
  if (!d.dash) throw new Error('接口没有返回 DASH 流');

  const norm = (s) => {
    if (!s) return null;
    const url = s.baseUrl || s.base_url || '';
    if (!url) return null;
    const sb = s.segment_base || s.segmentBase || {};
    const backups = s.backupUrl || s.backup_url || [];
    return {
      url,
      urls: [...new Set([url, ...backups].filter(Boolean))],
      backup: backups[0] || '',
      id: Number(s.id) || 0,
      codecid: Number(s.codecid) || 0,
      codecs: s.codecs || '',
      bandwidth: Number(s.bandwidth) || 0,
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      frameRate: s.frameRate || s.frame_rate || '',
      mimeType: s.mimeType || s.mime_type || '',
      initRange: sb.initialization || '',
      indexRange: sb.index_range || sb.indexRange || '',
    };
  };

  const videos = (d.dash.video || []).map(norm).filter(Boolean);
  const audios = (d.dash.audio || []).map(norm).filter(Boolean);
  if (!videos.length || !audios.length) throw new Error('DASH 流不完整');

  const videoTrack = pickVideoTrack(videos, Number(wantQn) || 80, {
    allowHevc: opts.allowHevc !== false,
  });
  const audioTrack = pickAudioTrack(audios);
  if (!videoTrack || !audioTrack) throw new Error('DASH 流不完整');

  // 个别清晰度不带 segment_base，清单会缺分片信息（电视会 0 网速），这里补齐
  await Promise.all([repairSegmentBase(videoTrack), repairSegmentBase(audioTrack)]);

  // 每个分轨都有若干个 CDN 地址，实测挑最快的；其余留作转发层故障切换
  const [vpick, apick] = await Promise.all([
    pickFastestNode(videoTrack.urls, input.avoidHost),
    pickFastestNode(audioTrack.urls, input.avoidHost),
  ]);

  const maxOf = (cid) => Math.max(0, ...videos.filter((v) => v.codecid === cid).map((v) => v.id));

  return {
    video: { ...videoTrack, url: vpick.url, urls: vpick.candidates, host: vpick.host, speed: vpick.speed },
    audio: { ...audioTrack, url: apick.url, urls: apick.candidates, host: apick.host, speed: apick.speed },
    duration: Math.round((Number(d.timelength) || 0) / 1000),
    // 接口这份才是完整清晰度表（html5 线路会少给 4K/HDR）
    accept: normalizeAccept(d),
    codec: videoTrack.codecid,
    avcMax: maxOf(CODEC_AVC),
    hevcMax: maxOf(CODEC_HEVC),
  };
}

/** 只取合并流（durl）；dash 是纯视频轨，电视播了没声音，不要 */
function pickDurl(data) {
  if (Array.isArray(data.durl) && data.durl.length && data.durl[0] && data.durl[0].url) {
    return data.durl[0].url;
  }
  return '';
}

/** 合并流的全部备用地址（CDN 有多条，转发层可自动切换） */
function durlUrls(data) {
  const d = Array.isArray(data.durl) && data.durl[0];
  if (!d || !d.url) return [];
  return [...new Set([d.url, ...(d.backup_url || d.backupUrl || [])].filter(Boolean))];
}

/** durl 分段数：>1 表示这个清晰度被切成了多段，投屏只能播第一段，不如走 DASH */
function durlParts(data) {
  return Array.isArray(data.durl) ? data.durl.length : 0;
}

module.exports = {
  resolveVideo,
  resolveBangumi,
  fetchDanmaku,
  fetchPlayUrl,
  fetchDashStreams,
  fetchFallbackStream,
  isPlayableStreamUrl,
  parseDanmakuXml,
  qnLabel,
  checkLogin,
  diagnose,
  probeNvaPort: ssdp.probe,
};
