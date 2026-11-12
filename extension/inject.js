/**
 * 运行在页面主世界（page world）的小脚本。
 *
 * 内容脚本默认跑在隔离环境里，读不到页面的 window.__INITIAL_STATE__，
 * 因此这里注入一段脚本把 B 站自己的初始状态取出来，再用 postMessage 交给内容脚本。
 * 这样在多 P 视频、番剧页上拿到的 aid / cid / epId 都是最权威的。
 */
(function () {
  const MARK = '__bili_tv_cast__';

  function pickVideoData(st) {
    const out = {};
    const v = st.videoData;

    if (v && typeof v === 'object') {
      if (v.bvid) out.bvid = v.bvid;
      if (typeof v.aid === 'number') out.aid = v.aid;
      if (typeof v.cid === 'number') out.cid = v.cid;
      if (v.title) out.title = v.title;
      if (Array.isArray(v.pages)) {
        out.pages = v.pages.map((p) => ({
          cid: p.cid,
          page: p.page,
          part: p.part,
          duration: p.duration,
        }));
      }
    }

    if (typeof st.p === 'number') out.page = st.p;

    const ep = st.epInfo;
    if (ep && typeof ep === 'object') {
      if (typeof ep.ep_id === 'number') out.epId = ep.ep_id;
      if (typeof ep.aid === 'number') out.aid = ep.aid;
      if (typeof ep.cid === 'number') out.cid = ep.cid;
      if (typeof ep.season_id === 'number') out.seasonId = ep.season_id;
      if (ep.long_title || ep.title) out.partTitle = ep.long_title || ep.title;
      if (st.h1Title) out.title = st.h1Title;
    }

    if (st.upData && st.upData.name) out.up = st.upData.name;

    return out;
  }

  function grab() {
    try {
      const st = window.__INITIAL_STATE__;
      if (!st) return false;
      const payload = pickVideoData(st);
      payload.href = location.href;
      payload.fullTitle = document.title;
      window.postMessage({ [MARK]: true, payload }, '*');
      return true;
    } catch (err) {
      return false;
    }
  }

  grab();

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (grab() || tries >= 20) clearInterval(timer);
  }, 500);

  // SPA 切换分P/换集时状态会更新，监听一下 URL 变化
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      grab();
    }
  }, 1500);
})();
