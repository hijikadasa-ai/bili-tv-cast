'use strict';

/**
 * 投屏会话编排：NVA 会话管理 + 弹幕同步调度 + 清晰度切换。
 *
 * 几个关键设计：
 * 1) 由桥接进程自己拉流（bili.fetchPlayUrl），再用 PlayUrl 把地址递给电视。
 *    电视端自己请求接口这条路会被 B 站拒（表现为「加载失败（错误码：null）」）。
 * 2) 起播后挂一个看门狗：13 秒还没进入「播放中」就自动换兼容线路重试一次，
 *    避免某个清晰度的 CDN 地址电视不认时一直卡在加载失败。
 * 3) 弹幕有两种来源：电视自己渲染（native，默认）或电脑逐条推送（relay）。
 *    两者同时开会出现「每条弹幕两份」，所以默认只让电视自己渲染。
 */

const { EventEmitter } = require('events');
const nva = require('./nva');
const bili = require('./bili');

const PLAY_STATE = {
  LOADING: 3,
  PLAYING: 4,
  PAUSED: 5,
  ENDED: 6,
  STOPPED: 7,
};

const SEND_INTERVAL = 80; // ms
const SEND_PER_TICK = 3;
const QUEUE_LIMIT = 400;
const RESYNC_FORWARD = 8; // 进度向前跳变超过 8s 视为 seek
const RESYNC_BACKWARD = 1.5; // 向后跳变超过 1.5s 视为 seek（容忍进度抖动）
const LOOKBACK = 0.6; // 起播/seek 时补发多少秒内的弹幕
const WATCHDOG_MS = 13000; // 起播看门狗
const DANMAKU_MODES = ['native', 'relay', 'off'];

class Caster extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.clientUuid = opts.clientUuid || nva.makeDeviceUuid();
    this.session = nva.makeSession();

    this.client = null;
    this.device = null;
    this.video = null;

    this.danmaku = [];
    this.cursor = 0;
    this.queue = [];
    this.danmakuMode = opts.danmakuMode || (opts.danmaku === false ? 'off' : 'native');
    this.sentCount = 0;
    this._sentKeys = new Set();

    this.stream = null;
    this.quality = 0;
    this.qualities = [];
    this.accessCookie = '';
    this.requestedQn = 0;
    this._pendingSeek = 0;
    this._seekTries = 0;
    this._lastSeekAt = 0;
    this._playIssuedAt = 0;
    this._switching = false;

    this.position = 0;
    this.duration = 0;
    this.playState = 0;
    this.volume = 50;
    this.lastPos = 0;

    this._timer = null;
    this._watchdog = null;
    this._watchdogDepth = 0;
    this._danmakuRetry = null;
    this._reconnecting = false;
    this._stoppedByUser = false;

    this.state = 'idle'; // idle | connecting | casting | error
    this.lastError = '';
  }

  // ------------------------------------------------------------- 状态输出

  snapshot() {
    return {
      state: this.state,
      device: this.device,
      video: this.video,
      playState: this.playState,
      playStateText: stateText(this.playState),
      position: Math.round(this.position),
      duration: Math.round(this.duration),
      volume: this.volume,
      quality: {
        qn: this.quality,
        label: qualityLabel(this.qualities, this.quality),
        source: this.stream ? this.stream.source : '',
      },
      qualities: this.qualities,
      danmaku: {
        mode: this.danmakuMode,
        enabled: this.danmakuMode !== 'off',
        total: this.danmaku.length,
        sent: this.sentCount,
        loaded: this.danmaku.length > 0,
      },
      error: this.lastError,
    };
  }

  _emitState() {
    this.emit('state', this.snapshot());
  }

  _log(level, message) {
    this.emit('log', { level, message, at: Date.now() });
  }

  // ------------------------------------------------------------- 连接管理

  async connect(device, { restore = false } = {}) {
    this.closeClient();

    this.device = device;
    this.state = 'connecting';
    this._emitState();

    const client = new nva.NVAClient({
      host: device.ip,
      port: device.port || nva.DEFAULT_PORT,
      uuid: this.clientUuid,
      session: this.session,
    });

    this.client = client;
    this._bind(client);

    const info = await client.connect(restore ? 'RESTORE' : 'SETUP');
    this.state = 'casting';
    this.lastError = '';
    this._log(
      'info',
      `已连接 ${device.name || device.ip}（电视 UUID ${String(info.serverUuid || '').slice(0, 8)}…）`
    );
    this._emitState();
    return info;
  }

  _bind(client) {
    client.on('command', (msg) => this._onCommand(msg));
    client.on('disconnect', () => this._onDisconnect());
    client.on('error', (err) => {
      this._log('error', `协议错误：${err.message}`);
    });
  }

  _onDisconnect() {
    if (this._reconnecting || this._stoppedByUser || this.state === 'idle') return;

    this._log('warn', '与电视的连接断开，尝试恢复会话…');
    this._reconnecting = true;
    this.state = 'connecting';
    this._emitState();

    let attempt = 0;
    const retry = async () => {
      attempt += 1;
      try {
        if (!this.device) throw new Error('设备信息丢失');
        const client = new nva.NVAClient({
          host: this.device.ip,
          port: this.device.port || nva.DEFAULT_PORT,
          uuid: this.clientUuid,
          session: this.session,
        });
        this.client = client;
        this._bind(client);
        await client.connect('RESTORE');

        this.state = 'casting';
        this._reconnecting = false;
        this._log('info', '会话已恢复');
        this._emitState();
      } catch (err) {
        if (attempt >= 3) {
          this._reconnecting = false;
          this.state = 'error';
          this.lastError = err.message;
          this._log('error', `恢复失败：${err.message}`);
          this._emitState();
          return;
        }
        setTimeout(retry, 1200 * attempt);
      }
    };

    setTimeout(retry, 500);
  }

  closeClient() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  // ------------------------------------------------------------- 投屏动作

  /**
   * @param {object} device 电视设备
   * @param {object} video  {aid, bvid, cid, epid, seasonId, title, seekTs}
   * @param {{cookie?:string, danmakuMode?:'native'|'relay'|'off', danmaku?:boolean, qn?:number}} [opts]
   */
  async cast(device, video, opts = {}) {
    this._stoppedByUser = false;

    if (DANMAKU_MODES.includes(opts.danmakuMode)) this.danmakuMode = opts.danmakuMode;
    else if (typeof opts.danmaku === 'boolean') this.danmakuMode = opts.danmaku ? 'native' : 'off';

    this.accessCookie = opts.cookie || '';
    this.requestedQn = Number(opts.qn) || 0;

    await this.connect(device);

    this.video = video;
    this.position = Number(video.seekTs) || 0;
    this.lastPos = this.position;
    this.duration = Number(video.duration) || 0;
    this.playState = PLAY_STATE.LOADING;
    this.cursor = this._lowerBound(this.position);
    this.queue = [];
    this.sentCount = 0;
    this._sentKeys.clear();
    this.danmaku = [];

    // 1) 弹幕（只有 relay 模式才需要，失败不影响播放）
    const loadTask =
      this.danmakuMode === 'relay'
        ? bili
            .fetchDanmaku(video.cid)
            .then((list) => {
              this.danmaku = list;
              this.cursor = this._lowerBound(this.position);
              this._log('info', `弹幕已加载 ${list.length} 条`);
              this._emitState();
            })
            .catch((err) => {
              this._log('warn', `弹幕加载失败：${err.message}`);
            })
        : Promise.resolve();

    // 2) 拉播放地址
    this._log('info', '正在获取播放地址…');
    const stream = await bili.fetchPlayUrl({
      aid: video.aid,
      bvid: video.bvid,
      cid: video.cid,
      epId: video.epid || video.epId || 0,
      cookie: this.accessCookie,
      qn: this.requestedQn,
    });
    this.stream = stream;
    this.quality = stream.qn;
    this.qualities = stream.accept && stream.accept.length ? stream.accept : [];
    this._log(
      'info',
      `播放地址已就绪：${qualityLabel(this.qualities, stream.qn)}（来源 ${stream.source}）`
    );

    // 3) 起播
    this.client.getVolume();
    this._pendingSeek = this.position > 3 ? this.position : 0;
    this._seekTries = 0;
    this._sendPlayUrl(stream, this.position);
    this._applyDanmakuMode();
    this._armWatchdog(0);

    this._log('info', `已下发 PlayUrl：${video.title || video.bvid || video.cid}`);
    this._startTicker();
    this._emitState();

    await loadTask;
    this._emitState();
  }

  /**
   * 下发 PlayUrl（含 nva_ext，电视端从这里读 aid/cid/seek 等）。
   * @param {{url:string, qn:number}} stream
   * @param {number} seekTs
   */
  _sendPlayUrl(stream, seekTs) {
    if (!this.client) throw new Error('NVA 会话未建立');
    const video = this.video || {};
    const epId = Number(video.epid || video.epId) || 0;
    const aid = Number(video.aid) || 0;
    const oid = epId !== 0 ? epId : aid;

    const content = {
      aid: String(video.aid || ''),
      cid: String(video.cid || ''),
      oid: String(oid),
      epId: String(epId),
      epid: String(epId),
      seasonId: String(video.seasonId || 0),
      season_id: String(video.seasonId || 0),
      contentType: 1,
      content_type: 1,
      seekTs: Math.max(0, Math.round(seekTs) || 0),
      current_qn: stream.qn || 0,
      desire_qn: stream.qn || 0,
      userDesireQn: stream.qn || 0,
      danmakuSwitchSave: this.danmakuMode !== 'off',
      userDesireSpeed: 1,
      build: '106400100',
    };

    const url = stream.url + '&nva_ext=' + encodeURIComponent(JSON.stringify({ ver: 2, content }));
    this.client.sendCommand('PlayUrl', { url, title: video.title || '' });
    this._playIssuedAt = Date.now();
  }

  /**
   * 切换清晰度：重新拉目标 qn 的地址，带当前进度重新下发 PlayUrl。
   * 电视端自己重新请求接口会失败，所以必须由电脑换地址。
   */
  async switchQuality(qn) {
    if (!this.video || !this.client) throw new Error('当前没有正在投屏的视频');
    if (this._switching) throw new Error('正在切换清晰度，请稍候');
    const target = Number(qn) || 0;
    const pos = Math.max(0, Math.round(this.position) || 0);

    this._switching = true;
    try {
      this._log('info', '正在获取新的清晰度地址…');
      const stream = await bili.fetchPlayUrl({
        aid: this.video.aid,
        bvid: this.video.bvid,
        cid: this.video.cid,
        epId: this.video.epid || this.video.epId || 0,
        cookie: this.accessCookie,
        qn: target,
      });

      if (!this.client || this._stoppedByUser) return this.snapshot();

      this.stream = stream;
      this.quality = stream.qn;
      if (stream.accept && stream.accept.length) this.qualities = stream.accept;

      this.queue = [];
      this.cursor = this._lowerBound(pos);
      this.position = pos;
      this.lastPos = pos;
      this.playState = PLAY_STATE.LOADING;
      this._pendingSeek = pos > 3 ? pos : 0;
      this._seekTries = 0;

      this._sendPlayUrl(stream, pos);
      this._applyDanmakuMode();
      this._armWatchdog(0);

      const label = qualityLabel(this.qualities, stream.qn);
      this._log(
        'info',
        stream.qn === target
          ? `已切换到 ${label}，从 ${pos} 秒继续`
          : `目标清晰度不可用，已用 ${label}，从 ${pos} 秒继续`
      );
      this._emitState();
      return this.snapshot();
    } finally {
      this._switching = false;
    }
  }

  pause() {
    this.client && this.client.pause();
  }

  resume() {
    this.client && this.client.resume();
  }

  seek(seconds) {
    if (!this.client) return;
    const target = Math.max(0, Math.round(seconds));
    this.client.seek(target);
    this.position = target;
    this.lastPos = target;
    this.queue = [];
    this.cursor = this._lowerBound(target);
    this._emitState();
  }

  setDanmakuMode(mode) {
    if (!DANMAKU_MODES.includes(mode)) return;
    this.danmakuMode = mode;
    this._applyDanmakuMode();
    this.queue = [];
    this.cursor = this._lowerBound(this.position);
    if (mode === 'relay' && !this.danmaku.length && this.video) {
      bili
        .fetchDanmaku(this.video.cid)
        .then((list) => {
          this.danmaku = list;
          this.cursor = this._lowerBound(this.position);
          this._log('info', `弹幕已加载 ${list.length} 条`);
          this._emitState();
        })
        .catch((err) => this._log('warn', `弹幕加载失败：${err.message}`));
    }
    this._log(
      'info',
      mode === 'native'
        ? '弹幕交给电视自己渲染'
        : mode === 'relay'
        ? '改为电脑逐条推送弹幕'
        : '已关闭电视弹幕'
    );
    this._emitState();
  }

  /** 兼容旧接口：true=电视自己渲染，false=关闭 */
  setDanmaku(open) {
    this.setDanmakuMode(open ? 'native' : 'off');
  }

  _applyDanmakuMode() {
    if (!this.client) return;
    const open = this.danmakuMode !== 'off';
    try {
      this.client.switchDanmaku(open);
    } catch (_) {
      /* ignore */
    }
    // 起播瞬间下发的开关会被电视端重置，2 秒后补一次
    if (this._danmakuRetry) clearTimeout(this._danmakuRetry);
    this._danmakuRetry = setTimeout(() => {
      this._danmakuRetry = null;
      try {
        if (this.client) this.client.switchDanmaku(open);
      } catch (_) {
        /* ignore */
      }
    }, 2000);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Number(v) || 0));
    this.client && this.client.setVolume(this.volume);
    this._emitState();
  }

  stop() {
    this._stoppedByUser = true;
    this._stopTicker();
    this._clearWatchdog();
    this._pendingSeek = 0;
    if (this._danmakuRetry) {
      clearTimeout(this._danmakuRetry);
      this._danmakuRetry = null;
    }

    const client = this.client;
    try {
      if (client) client.stop();
    } catch (_) {
      /* ignore */
    }

    this.state = 'idle';
    this.playState = PLAY_STATE.STOPPED;
    this.queue = [];
    this._log('info', '已停止投屏');
    this._emitState();

    // Stop 帧是异步写出的，稍等一下再断连接，避免指令丢了
    setTimeout(() => {
      if (this.client === client) this.closeClient();
    }, 250);
  }

  // ------------------------------------------------------------- 起播看门狗

  _armWatchdog(depth) {
    this._clearWatchdog();
    this._watchdogDepth = depth;
    this._watchdog = setTimeout(() => this._onWatchdog(), WATCHDOG_MS);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  _clearWatchdog() {
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  }

  _onWatchdog() {
    this._watchdog = null;
    if (this._stoppedByUser || this.state !== 'casting') return;

    // 已经在播（有进度）就不管了
    if (this.playState === PLAY_STATE.PLAYING && this.position > 0) return;
    if (this.playState === PLAY_STATE.PAUSED) return;

    // 已经在最兼容的线路上，再降级也没意义
    if (this.stream && this.stream.source === 'tv') {
      this._log('error', '电视没能加载这个视频（连 360P 也不行），请确认电视网络能上网后重新投屏');
      return;
    }

    const depth = this._watchdogDepth || 0;
    if (depth >= 1) {
      this._log('error', '电视一直没能加载出画面，请确认电视网络正常后重新投屏');
      return;
    }

    Promise.resolve()
      .then(async () => {
        this._log('warn', '电视没能加载当前地址，正在切换兼容线路重试…');
        const stream = await bili.fetchFallbackStream({
          aid: this.video && this.video.aid,
          bvid: this.video && this.video.bvid,
          cid: this.video && this.video.cid,
          epId: (this.video && (this.video.epid || this.video.epId)) || 0,
        });
        if (this._stoppedByUser || !this.client) return;
        this.stream = stream;
        this.quality = stream.qn;
        if (!this.qualities.some((q) => q.qn === stream.qn)) {
          this.qualities = [...this.qualities, { qn: stream.qn, label: qualityLabel([], stream.qn) }].sort(
            (a, b) => b.qn - a.qn
          );
        }
        this._sendPlayUrl(stream, this.position);
        this._pendingSeek = this.position > 3 ? this.position : 0;
        this._seekTries = 0;
        this._applyDanmakuMode();
        this._armWatchdog(depth + 1);
        this._log('info', `已切换到兼容线路：${qualityLabel(this.qualities, stream.qn)}`);
        this._emitState();
      })
      .catch((err) => this._log('error', `切换兼容线路失败：${err.message}`));
  }

  // ------------------------------------------------------------- 上行指令

  _onCommand(msg) {
    const { method, params, counter } = msg;

    switch (method) {
      case 'OnProgress': {
        const pos = Number(params && params.position) || 0;
        const dur = Number(params && params.duration) || 0;
        if (dur > 0 && pos > 0) this._clearWatchdog();
        this._onProgress(pos, dur);
        this._ack(counter);
        break;
      }
      case 'OnPlayState': {
        this.playState = Number(params && params.playState) || 0;
        // 4=播放中、5=暂停都算加载成功；2 是「准备中」，不是错误
        if (this.playState === PLAY_STATE.PLAYING || this.playState === PLAY_STATE.PAUSED) {
          this._clearWatchdog();
        }
        if (this.playState === PLAY_STATE.ENDED || this.playState === PLAY_STATE.STOPPED) {
          this.queue = [];
          this._clearWatchdog();
        }
        this._emitState();
        this._ack(counter);
        break;
      }
      case 'OnDanmakuSwitch': {
        if (params && typeof params.open !== 'undefined') {
          // 电视端自己开关弹幕时，同步本地模式
          const open = params.open === true || params.open === 'true';
          if (!open && this.danmakuMode !== 'off') this.danmakuMode = 'off';
          else if (open && this.danmakuMode === 'off') this.danmakuMode = 'native';
          this._emitState();
        }
        this._ack(counter);
        break;
      }
      case 'OnQnSwitch': {
        // 电视端切清晰度（用户按遥控器）：qn 可能在 params 里，也可能是裸值
        const qn = Number((params && (params.qn || params.quality)) || params || 0) || 0;
        this._ack(counter);
        const justIssued = Date.now() - (this._playIssuedAt || 0) < 5000;
        if (qn >= 16 && qn !== this.quality && !justIssued && !this._switching && this.state === 'casting') {
          this.switchQuality(qn).catch((err) => this._log('warn', `跟随电视切换清晰度失败：${err.message}`));
        }
        break;
      }
      case 'OnEpisodeSwitch':
      case 'SpeedChanged':
      case 'PLAY_SUCCESS': {
        this._ack(counter);
        break;
      }
      case 'GetVolume': {
        this.client && this.client.sendReply(counter, { volume: this.volume });
        break;
      }
      case 'SetVolume': {
        this.volume = Number(params && params.volume) || this.volume;
        this._emitState();
        this._ack(counter);
        break;
      }
      case 'Pause':
      case 'Resume':
      case 'Seek':
      case 'Stop':
      case 'SwitchQn':
      case 'SwitchSpeed': {
        this._log('info', `电视端操作：${method}`);
        this._ack(counter);
        break;
      }
      default: {
        this._ack(counter);
        break;
      }
    }
  }

  _ack(counter) {
    try {
      this.client && this.client.sendReply(counter);
    } catch (_) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- 弹幕调度

  _onProgress(position, duration) {
    if (duration) this.duration = duration;

    const prev = this.lastPos;
    this.position = position;

    // 只有真的跳转才重排游标：进度往回抖 1 秒内不算 seek，
    // 否则每秒都会重新入队，弹幕就会「每条出现两次」
    const backward = prev - position;
    const forward = position - prev;
    if (backward > RESYNC_BACKWARD || forward > RESYNC_FORWARD) {
      this.cursor = this._lowerBound(position);
      this.queue = [];
      this._log('info', `进度跳转到 ${Math.round(position)} 秒，弹幕已重新对齐`);
    }

    this.lastPos = position;
    this._applyPendingSeek(position);
    this._enqueueWindow(position);
    this._emitState();
  }

  /**
   * 电视收到 PlayUrl 后通常从 0 秒开始播（它不理会 nva_ext 里的 seekTs），
   * 所以起播/切清晰度后要补一条 Seek 回到原进度。
   */
  _applyPendingSeek(position) {
    const target = this._pendingSeek;
    if (!target || !this.client) return;
    // PlayUrl 刚下发时电视还会回报旧进度，先忽略，等它真的重启后再纠偏
    if (Date.now() - (this._playIssuedAt || 0) < 1500) return;
    if (Math.abs(position - target) <= 3 || position > target - 2) {
      this._pendingSeek = 0;
      return;
    }
    if (this._seekTries >= 2) {
      this._pendingSeek = 0;
      return;
    }
    if (Date.now() - this._lastSeekAt < 2500) return;

    this._seekTries += 1;
    this._lastSeekAt = Date.now();
    try {
      this.client.seek(target);
      this.lastPos = target;
      this._log('info', `已跳到 ${Math.round(target)} 秒继续播放`);
    } catch (_) {
      /* ignore */
    }
  }

  _enqueueWindow(position) {
    if (this.danmakuMode !== 'relay') return;
    if (!this.danmaku.length) return;
    if (this.playState === PLAY_STATE.PAUSED) return;
    if (this.queue.length > QUEUE_LIMIT) return;

    const upper = position + LOOKBACK;
    while (this.cursor < this.danmaku.length && this.danmaku[this.cursor].t <= upper) {
      const dm = this.danmaku[this.cursor];
      this.cursor += 1;
      if (dm.t < position - LOOKBACK) continue;
      const key = `${dm.t}|${dm.text}`;
      if (this._sentKeys.has(key)) continue;
      this._sentKeys.add(key);
      this.queue.push(dm);
      if (this.queue.length > QUEUE_LIMIT) break;
    }

    if (this._sentKeys.size > 20000) this._sentKeys.clear();
  }

  _startTicker() {
    this._stopTicker();
    this._timer = setInterval(() => this._tick(), SEND_INTERVAL);
    if (this._timer.unref) this._timer.unref();
  }

  _stopTicker() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    if (!this.client || !this.queue.length) return;
    if (this.danmakuMode !== 'relay') return;
    if (this.playState === PLAY_STATE.PAUSED) return;

    let sent = 0;
    while (this.queue.length && sent < SEND_PER_TICK) {
      const dm = this.queue.shift();
      try {
        this.client.sendDanmaku(dm);
        this.sentCount += 1;
        sent += 1;
      } catch (err) {
        this._log('warn', `弹幕发送失败：${err.message}`);
        break;
      }
    }
    if (sent) this._emitState();
  }

  _lowerBound(t) {
    let lo = 0;
    let hi = this.danmaku.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.danmaku[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function qualityLabel(list, qn) {
  const hit = (list || []).find((q) => Number(q.qn) === Number(qn));
  return hit ? hit.label : qn ? `QN${qn}` : '自动';
}

function stateText(code) {
  switch (code) {
    case 2:
      return '准备中';
    case PLAY_STATE.LOADING:
      return '缓冲中';
    case PLAY_STATE.PLAYING:
      return '播放中';
    case PLAY_STATE.PAUSED:
      return '已暂停';
    case PLAY_STATE.ENDED:
      return '播放结束';
    case PLAY_STATE.STOPPED:
      return '已停止';
    default:
      return '待机';
  }
}

module.exports = { Caster, PLAY_STATE };
