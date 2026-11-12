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
  125: 'HDR',
  126: '杜比视界',
  127: '8K',
};

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
 * 拉取一个「电视真的能播」的播放地址。
 *
 * 踩过的坑：x/tv/playurl 与 web 的 fnval=1 会给 PCDN 代理地址
 * （*.edge.mountaintoys.cn:4483），电视收到后一律「加载失败（错误码：null）」。
 * 实测 web 的 platform=html5 接口返回普通 *.bilivideo.com 直链，
 * 匿名也能给 720P，带登录 Cookie 一般还能更高，所以以它为主线路。
 *
 * 顺序：
 *   1) 有登录 Cookie：先试 fnval=1 的 1080P 合并流，host 合格才采用
 *   2) platform=html5 主线路（720P，地址实测可播）
 *   3) 电视 App 匿名接口（360P）兜底
 *
 * @param {{aid?:number|string, bvid?:string, cid?:number|string, epId?:number|string,
 *          cookie?:string, qn?:number}} input
 * @returns {Promise<{url:string, qn:number, source:string, timelength:number,
 *                    accept:Array<{qn:number,label:string}>}>}
 */
async function fetchPlayUrl(input) {
  const cid = Number(input.cid) || 0;
  if (!cid) throw new Error('缺少 cid，无法获取播放地址');

  const want = Number(input.qn) || 0;
  const tried = [];
  let accept = [];

  if (input.cookie) {
    const targets = want >= 80 ? [want, 80] : [80];
    for (const qn of [...new Set(targets)]) {
      try {
        const r = await fetchPlayUrlViaWeb(input, cid, qn);
        accept = mergeAccept(accept, r.accept);
        if (isPlayableStreamUrl(r.url)) return { ...r, accept: mergeAccept(accept, r.accept) };
        tried.push(`网页 qn=${qn}（地址电视播不了）`);
      } catch (err) {
        tried.push(`网页 qn=${qn}（${err.message}）`);
      }
    }
  }

  try {
    const r = await fetchPlayUrlViaHtml5(input, cid, want || 64);
    return { ...r, accept: mergeAccept(accept, r.accept) };
  } catch (err) {
    tried.push(`html5（${err.message}）`);
  }

  try {
    const r = await fetchPlayUrlViaTv(input, cid, want);
    return { ...r, accept: mergeAccept(accept, r.accept) };
  } catch (err) {
    tried.push(`电视接口（${err.message}）`);
    throw new Error(`获取播放地址失败：${tried.join('；')}`);
  }
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
  if (cookie) headers.Cookie = `SESSDATA=${cookie}`;
  return headers;
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
  if (!isPlayableStreamUrl(url)) throw new Error('地址电视播不了');

  return {
    url,
    qn: Number(json.data.quality) || qn,
    source: 'html5',
    timelength: Number(json.data.timelength) || 0,
    accept: normalizeAccept(json.data),
  };
}

/** fnval=1：网页端合并流，登录后有机会到 1080P（地址可能是代理，需校验） */
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
    qn: Number(json.data.quality) || qn,
    source: 'web',
    timelength: Number(json.data.timelength) || 0,
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
    },
  });
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `code ${json.code}`);
  }
  const url = pickDurl(json.data);
  if (!url) throw new Error('没有返回合并流');

  return {
    url,
    qn: Number(json.data.quality) || 0,
    source: 'tv',
    timelength: Number(json.data.timelength) || 0,
    accept: normalizeAccept(json.data),
  };
}

/** 只取合并流（durl）；dash 是纯视频轨，电视播了没声音，不要 */
function pickDurl(data) {
  if (Array.isArray(data.durl) && data.durl.length && data.durl[0] && data.durl[0].url) {
    return data.durl[0].url;
  }
  return '';
}

module.exports = {
  resolveVideo,
  resolveBangumi,
  fetchDanmaku,
  fetchPlayUrl,
  fetchFallbackStream,
  isPlayableStreamUrl,
  parseDanmakuXml,
  probeNvaPort: ssdp.probe,
};
