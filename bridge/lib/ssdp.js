'use strict';

/**
 * 局域网发现：SSDP（UPnP 发现协议）+ 子网主动探测兜底。
 *
 * 云视听小电视对外仍是一个 DLNA MediaRenderer，但它会额外广播
 * `urn:schemas-upnp-org:service:NirvanaControl:3` 这个 B 站专属服务类型，
 * 设备描述 XML 里还带有 <capability>（254 = 支持弹幕，1 = 弹幕 + 4K）等标记。
 * 我们据此把「小电视」和普通 DLNA 接收端区分开。
 *
 * 重要：Windows 上如果直接 bind(0) 发多播，机器装了 VPN / ZeroTier / 虚拟机网卡
 * 等虚拟适配器时，多播包常常从错误的那块网卡出去（或者回包被丢），导致搜不到电视。
 * 所以这里按「每块物理网卡各发一轮」的方式做，另外再用 TCP 9958 扫一遍子网兜底。
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');
const os = require('os');
const { URL } = require('url');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const NVA_PORT = 9958;

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:service:NirvanaControl:3',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'upnp:rootdevice',
];

function buildMSearch(st, mx = 2) {
  return (
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `MX: ${mx}\r\n` +
    `ST: ${st}\r\n` +
    '\r\n'
  );
}

function parseHeaders(text) {
  const headers = {};
  const lines = String(text).split(/\r\n/);
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function fetchText(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.get(
        url,
        { timeout, headers: { 'User-Agent': 'Linux/3.0.0 UPnP/1.0 Platinum/1.0.5.13' } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d) => {
            body += d;
            if (body.length > 256 * 1024) {
              res.destroy();
              resolve(body);
            }
          });
          res.on('end', () => resolve(body));
        }
      );
    } catch (err) {
      reject(err);
      return;
    }
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i'));
  return m ? m[1] : '';
}

async function inspect(location) {
  let xml;
  try {
    xml = await fetchText(location);
  } catch (_) {
    return null;
  }

  const host = (() => {
    try {
      return new URL(location).hostname;
    } catch (_) {
      return '';
    }
  })();

  const hasNva = /NirvanaControl/i.test(xml);
  const friendlyName = tag(xml, 'friendlyName');
  const modelName = tag(xml, 'modelName');
  const modelDescription = tag(xml, 'modelDescription');
  const brand = tag(xml, 'X_brandName');
  const capability = tag(xml, 'capability');

  const looksBili =
    hasNva ||
    /哔哩|bilibili|小电视|云视听/i.test(`${friendlyName}${modelName}${modelDescription}${brand}`) ||
    Boolean(capability);

  if (!looksBili) return null;

  let port = NVA_PORT;
  const urlBase = tag(xml, 'URLBase');
  if (urlBase) {
    try {
      const p = Number(new URL(urlBase).port);
      if (p) port = p;
    } catch (_) {
      /* ignore */
    }
  }
  // 描述文件本身如果就是 9958 端口上的 /bilibili/description.xml，以它为准
  try {
    const locPort = Number(new URL(location).port);
    if (locPort && /\/bilibili\//i.test(location)) port = locPort;
  } catch (_) {
    /* ignore */
  }

  return {
    id: `${host}:${port}`,
    ip: host,
    port,
    name: friendlyName || modelName || host,
    model: modelName || modelDescription || '',
    brand: brand || '',
    capability: capability || '',
    danmaku: capability === '254' || capability === '1' || capability === '255' || hasNva,
    location,
  };
}

// ---------------------------------------------------------------- 网卡

/** 本机所有可用的 IPv4 网卡（跳过回环、APIPA 169.254） */
function localInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (String(item.address).startsWith('169.254.')) continue; // 未连上，纯占位地址
      out.push({
        name,
        address: item.address,
        netmask: item.netmask || '255.255.255.0',
      });
    }
  }
  return out;
}

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n) {
  const v = n >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

// ---------------------------------------------------------------- SSDP 搜索

/**
 * 在指定网卡上做一轮 SSDP 搜索。
 * @param {{address?:string, name?:string}} iface address 为空表示默认网卡
 */
function searchOnInterface(iface, { rounds = 3, gap = 550, listenMs = 1800, onLocation }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
      resolve();
    };

    socket.on('error', () => finish());
    socket.on('message', (msg) => {
      const headers = parseHeaders(msg.toString('utf8'));
      if (headers.LOCATION) onLocation(headers.LOCATION, headers);
    });

    const start = () => {
      try {
        socket.setMulticastTTL(2);
      } catch (_) {
        /* ignore */
      }
      if (iface.address) {
        // 关键：显式指定多播出口网卡，避免被 VPN / 虚拟网卡抢走
        try {
          socket.setMulticastInterface(iface.address);
        } catch (_) {
          /* ignore */
        }
      }

      let round = 0;
      const sendRound = () => {
        if (closed) return;
        if (round >= rounds) return;
        round += 1;
        for (const st of SEARCH_TARGETS) {
          const buf = Buffer.from(buildMSearch(st));
          socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDRESS, () => {});
        }
        setTimeout(sendRound, gap);
      };
      sendRound();
      setTimeout(finish, rounds * gap + listenMs);
    };

    const bindDefault = () => {
      try {
        socket.bind(0, start);
      } catch (_) {
        finish();
      }
    };

    if (iface.address) {
      try {
        socket.bind(0, iface.address, start);
      } catch (_) {
        bindDefault();
      }
    } else {
      bindDefault();
    }
  });
}

// ---------------------------------------------------------------- 子网兜底扫描

function connectOnce(ip, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 扫一块网卡所在子网的 9958 端口，返回有响应的 IP 列表 */
async function scanSubnet(iface, port = NVA_PORT, { timeout = 350, concurrency = 96 } = {}) {
  const selfInt = ipToInt(iface.address);
  const maskInt = ipToInt(iface.netmask);
  if (!selfInt || !maskInt) return [];

  const size = (~maskInt >>> 0) + 1;
  let start = (selfInt & maskInt) >>> 0;
  let count = size;

  if (count > 1024) {
    // 大网段（/8、/16 之类）只扫自己所在的 /24，防止扫爆
    const m = 0xffffff00;
    start = (selfInt & m) >>> 0;
    count = 256;
  }

  const hosts = [];
  for (let i = 1; i < count - 1; i++) {
    const ip = intToIp(start + i);
    if (ip === iface.address) continue;
    hosts.push(ip);
  }

  const found = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < hosts.length) {
      const ip = hosts[cursor++];
      if (await connectOnce(ip, port, timeout)) found.push(ip);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

// ---------------------------------------------------------------- 对外

/**
 * 主动搜索局域网内的 B 站电视设备。
 * @param {{timeoutMs?:number, port?:number}} opts
 * @returns {Promise<Array<object>>}
 */
async function discover(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 2200;
  const port = Number(opts.port) || NVA_PORT;

  const locations = new Map(); // location -> {st, server}
  const onLocation = (location, headers) => {
    if (!locations.has(location)) {
      locations.set(location, { st: headers.ST || '', server: headers.SERVER || '' });
    }
  };

  const ifaces = localInterfaces();
  // 默认网卡 + 每块网卡各发一轮，并行，互不影响
  const targets = [{ name: '(默认)', address: undefined }, ...ifaces];

  const ssdpTask = Promise.all(
    targets.map((iface) =>
      searchOnInterface(iface, {
        rounds: 3,
        gap: 550,
        listenMs: Math.max(800, timeoutMs - 550 * 3),
        onLocation,
      }).catch(() => {})
    )
  );

  // 兜底：同时扫子网 9958，防止路由器隔离多播 / 电视不回 M-SEARCH
  const scanTask = (async () => {
    const hits = [];
    await Promise.all(
      ifaces.map(async (iface) => {
        const ips = await scanSubnet(iface, port).catch(() => []);
        for (const ip of ips) hits.push(ip);
      })
    );
    return [...new Set(hits)];
  })();

  await ssdpTask;
  const scanned = await scanTask;

  const devices = [];
  const seenIds = new Set();
  const push = (item) => {
    if (!item || seenIds.has(item.id)) return;
    seenIds.add(item.id);
    devices.push(item);
  };

  const results = await Promise.all([...locations.keys()].map((loc) => inspect(loc).catch(() => null)));
  for (const item of results) push(item);

  // 兜底结果：先试 /bilibili/description.xml，再试根描述
  const extra = await Promise.all(
    scanned.map(async (ip) => {
      const urls = [
        `http://${ip}:${port}/bilibili/description.xml`,
        `http://${ip}:${port}/description.xml`,
        `http://${ip}:${port}/`,
      ];
      for (const url of urls) {
        const item = await inspect(url).catch(() => null);
        if (item) return item;
      }
      return null;
    })
  );
  for (const item of extra) push(item);

  return devices;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** TCP 探测 9958 端口，判断该 IP 是否是 NVA 接收端（用户手动填 IP 时用） */
function probe(ip, port = NVA_PORT, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (ok, err) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve({ ok, error: err ? String(err.message || err) : undefined });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, new Error('连接超时')));
    socket.once('error', (err) => done(false, err));
  });
}

module.exports = { discover, probe, inspect, localInterfaces, NVA_PORT };
