'use strict';

/**
 * 原生云投（手机端同款）下发模块 —— 实验性功能。
 *
 * 手机 B 站 App 投屏时，只把「带视频编号的 deep link」交给电视，
 * 电视自己调用 B 站 playurl 并播放。我们逆向出了这个链接的结构：
 *
 *   bilibili://projection?from=cloud_projection&cloud=<ProjectionBody JSON>
 *
 * 电视收到后进入「SDK 云投起播」分支，从 cloud JSON 里取 aid/cid，
 * 直接走 is_proj=1 / from_outside=1 的 playurl，不再需要电脑转流。
 *
 * 下发通道目前使用电视已开启的 ADB（5555）：
 * 只有以 Intent.data 启动 ProjectionPlayerActivityV2 才会走 cloud 分支，
 * NVA PlayUrl / DLNA SetAVTransportURI 都会被包装成 extras 而被电视忽略。
 * ADB 不可用时，caster 会自动回退到现有的本机 HLS 方案。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ACTIVITY = 'com.xiaodianshi.tv.yst/com.yst.projection.ProjectionPlayerActivityV2';
const ADB_PORT = 5555;

/** 是否尝试原生云投（默认开启，失败回退 HLS） */
function isEnabled() {
  return process.env.BILI_CLOUD_CAST !== '0';
}

function findAdb() {
  const candidates = [
    process.env.BILI_ADB_PATH,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'AndroidAdCleaner', 'platform-tools', 'adb.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Temp', 'ptools', 'platform-tools', 'adb.exe'),
    '/usr/bin/adb',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* ignore */
    }
  }
  // 最后再试 PATH 里的 adb
  return 'adb';
}

function run(adb, args, timeout = 8000) {
  try {
    return spawnSync(adb, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  } catch (err) {
    return { status: -1, stdout: '', stderr: err.message };
  }
}

/** 连接电视 ADB（`host:5555`），返回是否可用 */
function ensureAdb(adb, host) {
  const target = `${host}:${ADB_PORT}`;
  const listed = run(adb, ['devices']);
  if (listed.status === 0 && String(listed.stdout).includes(target)) return { ok: true, target };
  const connected = run(adb, ['connect', target]);
  const text = `${connected.stdout || ''}${connected.stderr || ''}`;
  if (/connected to|already connected/i.test(text)) return { ok: true, target };
  return { ok: false, target, reason: text.trim().slice(0, 200) };
}

/** 构造 cloud deep link */
function buildUri({ aid, cid, qn, seekTs = 0, bvid = '' }) {
  const sessionId = 'btc-' + Date.now();
  const extra = {
    sessionId,
    accessKey: '', // 电视账号自身即可起播（含 4K），无需手机 AK
    buvid: '',
    danmaku_switch: true,
    autoNext: true,
    deviceName: '电脑投屏',
    userDesireSpeed: 1,
    bizSessionId: sessionId,
    quality: Number(qn) || 80,
    danmakuSwitchSave: true,
    proj_type: 1,
  };
  if (bvid) extra.bvid = String(bvid);

  const body = {
    aid: Number(aid) || 0,
    cid: Number(cid) || 0,
    extra: JSON.stringify(extra),
    mid: 0,
    content_type: 1, // cloud 路径里 1 = UGC 视频
    video_type: 0,
    seekTS: Math.max(0, Math.round(Number(seekTs) || 0)),
    deviceInfo: JSON.stringify({ name: '电脑投屏', model: 'Chrome', version: '1.4.4' }),
    mMessageId: Date.now(),
  };
  return `bilibili://projection?from=cloud_projection&cloud=${encodeURIComponent(JSON.stringify(body))}`;
}

/**
 * 在电视上以原生云投方式起播。
 * @returns {{ok:boolean, reason?:string, qn?:number}}
 */
function launch({ device, video, qn }) {
  if (!isEnabled()) return { ok: false, reason: '原生云投已关闭' };
  const host = process.env.BILI_TV_ADB_HOST || (device && device.ip);
  if (!host) return { ok: false, reason: '未获取到电视 IP' };
  if (!video || !video.aid || !video.cid) return { ok: false, reason: '缺少 aid/cid' };

  const adb = findAdb();
  const conn = ensureAdb(adb, host);
  if (!conn.ok) return { ok: false, reason: `电视 ADB 不可用：${conn.reason || '未连接'}` };

  const targetQn = Number(qn) || 80;
  const uri = buildUri({
    aid: video.aid,
    cid: video.cid,
    qn: targetQn,
    seekTs: video.seekTs || 0,
    bvid: video.bvid,
  });
  // adb shell 会把参数再过一遍设备 shell，URI 必须用单引号包住，
  // 否则 '&cloud=...' 会被当成后台运算符吃掉。
  const res = run(adb, [
    '-s', conn.target,
    'shell', 'am', 'start',
    '-n', ACTIVITY,
    '-d', `'${uri}'`,
  ]);
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  if (/error|failure|not found/i.test(text) && !/Starting: Intent/i.test(text)) {
    return { ok: false, reason: text.trim().slice(0, 200) };
  }
  return { ok: true, qn: targetQn };
}

module.exports = { isEnabled, buildUri, launch, findAdb };
