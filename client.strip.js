/**
 * 视频逐帧查看 — 帧胶片块。
 *
 * 胶片不再把附近每一帧都铺出来，而是**按秒**呈现：
 *   - 默认：显示当前秒附近共 9 秒，每秒一张缩略图（取该秒第一帧）；
 *   - 双击某一秒：展开该秒内的**全部帧**，单击任意缩略帧跳到那一帧；
 *   - 逐帧视图里点「返回每秒」回到按秒视图；跳到别的秒时也会自动收起。
 *
 * ## 为什么抓帧要用一个小池塘
 *
 * 隐藏 <video> 抓一帧要「seek 到时间点 → 等解码器从最近关键帧解到这一帧 →
 * 等画面更新 → 画到 canvas」。H.264 每次 seek 都要重新解码一段，串行做 30 张
 * 就是 30 段解码。这里用 3 个隐藏 video 轮流干活：任意时刻 3 张同时在抓，
 * 其余的排队。实测能把「双击展开一秒」的首屏等待缩短到原来的三分之一左右。
 *
 * 另外缩略图只做 192px 宽、JPEG 质量 0.62 —— 胶片上每张只有一百来像素，
 * 320px/0.72 是白花的编码时间。
 *
 * 抓取顺序按「离当前帧越近越先」排，所以双击展开后当前帧附近的缩略图先出现，
 * 不用等整秒铺完才看到自己在看的那一帧。
 *
 * 缩略图缓存按帧号共享：秒视图抓的是该秒第一帧，展开后同一帧直接复用。
 *
 * 加载方式：入口 client.js 用 require.async('./client.strip.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.strip.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    /** 秒视图一屏显示多少秒。 */
    const STRIP_SECONDS = 9;
    /** 缩略图 JPEG 宽度（像素）；胶片显示宽度约 100px，192 足够 2x 屏。 */
    const THUMB_WIDTH = 192;
    /** 缩略图 JPEG 质量；0.62 在 100px 显示尺寸下看不出差别。 */
    const THUMB_QUALITY = 0.62;
    /** 同时抓帧的隐藏 video 数量。3 路是本地解码与内存的折中。 */
    const THUMB_WORKERS = 3;
    /** 缩略图缓存上限，超过后丢掉最旧的一张。 */
    const THUMB_CACHE_LIMIT = 300;
    /** 一秒内最多展开多少帧；防止畸形文件（例如 1000fps）把 DOM 撑爆。 */
    const MAX_FRAMES_PER_SECOND = 240;
    /** 单击秒图后等待多久再跳转；在这段时间内发生双击就当作「展开」。 */
    const CLICK_DELAY_MS = 220;

    /**
     * 算每一秒的第一帧索引。
     *
     * 用真实帧时间分组（而不是 `index / fps`），因此 VFR 视频也准确：
     * 第 s 秒的第一帧就是第一个 `time >= s` 的帧。
     * @param {null|{times:Float64Array,frameCount:number}} timeline - 帧时间轴。
     * @returns {number[]} 每秒第一帧的索引；视频为空时返回空数组。
     */
    function buildSecondStarts(timeline) {
      if (timeline === null || timeline === undefined || timeline.frameCount === 0) return [];
      const times = timeline.times;
      const count = times.length;
      const last = times[count - 1];
      const totalSeconds = Math.max(1, Math.floor(last) + 1);
      const starts = new Array(totalSeconds);
      let cursor = 0;
      for (let second = 0; second < totalSeconds; second += 1) {
        while (cursor < count && times[cursor] < second) cursor += 1;
        starts[second] = Math.min(cursor, count - 1);
      }
      return starts;
    }

    /**
     * 当前帧属于第几秒。
     * @param {null|{times:Float64Array,frameCount:number}} timeline - 帧时间轴。
     * @param {number} frameIndex - 当前帧号。
     * @returns {number} 秒序号（从 0 开始）。
     */
    function secondOfFrame(timeline, frameIndex) {
      if (timeline === null || timeline === undefined || timeline.frameCount === 0) return 0;
      const index = Math.max(0, Math.min(timeline.frameCount - 1, frameIndex));
      const time = timeline.times[index];
      return Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
    }

    /**
     * 组装帧胶片组件。
     * @param {{css: object, helpers: object}} deps - 样式表与播放辅助函数。
     * @returns {{Filmstrip: Function}} 组件。
     */
    function createFilmstrip({ css, helpers }) {
      const { formatTime, seekToTime, ensureVideoData } = helpers;

      /**
       * 帧胶片：按秒浏览，双击某一秒展开该秒全部帧。
       * @param {{t: Function, source: object, timeline: object, frameIndex: number,
       *   playing: boolean, onSelectFrame: Function}} props -
       *   `onSelectFrame(frame)` 由查看面板提供，负责 seek 并暂停。
       * @returns {object|null} 胶片元素；没有时间轴时为 null。
       */
      function Filmstrip({ t, source, timeline, frameIndex, playing, onSelectFrame }) {
        const [thumbVersion, setThumbVersion] = useState(0);
        const [expandedSecond, setExpandedSecond] = useState(null);
        const cacheRef = useRef(new Map());
        const clickTimerRef = useRef(null);
        /** 隐藏 video 池：每个元素同一时刻只服务一个 seek。 */
        const poolRef = useRef(new Array(THUMB_WORKERS).fill(null));
        /** 池中每个元素是否正在抓帧。 */
        const busyRef = useRef(new Array(THUMB_WORKERS).fill(false));
        /** 池全忙时排队的抓帧请求。 */
        const waitersRef = useRef([]);
        /** 换视频 / 换时间轴时递增；旧任务的结果一律丢弃。 */
        const generationRef = useRef(0);
        /** 抓帧顺序用的当前帧（放在 ref 里，避免翻帧时重启整批任务）。 */
        const frameIndexRef = useRef(frameIndex);

        useEffect(() => {
          frameIndexRef.current = frameIndex;
        }, [frameIndex]);

        /** 池元素的稳定 ref 回调；避免每次渲染都先清空再赋值。 */
        const poolSetters = useMemo(
          () => Array.from({ length: THUMB_WORKERS }, (_, index) => (node) => {
            poolRef.current[index] = node;
          }),
          [],
        );

        /** 换视频或换时间轴：旧缩略图不再对应同一帧，全部作废。 */
        useEffect(() => {
          generationRef.current += 1;
          cacheRef.current.clear();
          setThumbVersion((value) => value + 1);
          setExpandedSecond(null);
        }, [source, timeline]);

        /** 卸载时清掉尚未触发的单击计时器与排队中的抓帧请求。 */
        useEffect(() => () => {
          if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
          waitersRef.current = [];
        }, []);

        const secondStarts = useMemo(() => buildSecondStarts(timeline), [timeline]);
        const currentSecond = useMemo(() => secondOfFrame(timeline, frameIndex), [timeline, frameIndex]);

        /**
         * 当前胶片条目：
         *   - 秒视图：当前秒附近 9 秒，每秒一条；
         *   - 逐帧视图：展开那一秒的所有帧。
         */
        const items = useMemo(() => {
          if (timeline === null || timeline.frameCount === 0) return [];
          if (expandedSecond !== null) {
            const start = secondStarts[expandedSecond];
            if (start === undefined) return [];
            const end = expandedSecond + 1 < secondStarts.length
              ? secondStarts[expandedSecond + 1]
              : timeline.frameCount;
            const limit = Math.min(end, start + MAX_FRAMES_PER_SECOND);
            const list = [];
            for (let frame = start; frame < limit; frame += 1) {
              list.push({ key: 'f' + frame, frame, label: String(frame + 1), second: expandedSecond });
            }
            return list;
          }
          const total = secondStarts.length;
          const count = Math.min(STRIP_SECONDS, total);
          const start = Math.min(
            Math.max(currentSecond - Math.floor(STRIP_SECONDS / 2), 0),
            Math.max(0, total - STRIP_SECONDS),
          );
          const list = [];
          for (let offset = 0; offset < count; offset += 1) {
            const second = start + offset;
            list.push({
              key: 's' + second,
              frame: secondStarts[second],
              label: (second + 1) + 's',
              second,
            });
          }
          return list;
        }, [timeline, expandedSecond, secondStarts, currentSecond]);

        /**
         * 当前帧离开了展开的那一秒（时间轴拖动、键盘跨秒翻帧等），
         * 自动收起，避免「展开的是第 3 秒、画面却在第 5 秒」的错位。
         */
        useEffect(() => {
          if (expandedSecond === null || secondStarts.length === 0) return;
          const start = secondStarts[expandedSecond];
          const end = expandedSecond + 1 < secondStarts.length
            ? secondStarts[expandedSecond + 1]
            : timeline.frameCount;
          if (start === undefined || frameIndex < start || frameIndex >= end) setExpandedSecond(null);
        }, [frameIndex, expandedSecond, secondStarts, timeline]);

        /**
         * 从池里借一个空闲 video；全忙时排队，等别人归还。
         * @returns {Promise<number>} 池下标。
         */
        const acquireSlot = useCallback(() => new Promise((resolve) => {
          for (let index = 0; index < THUMB_WORKERS; index += 1) {
            if (!busyRef.current[index] && poolRef.current[index] !== null) {
              busyRef.current[index] = true;
              resolve(index);
              return;
            }
          }
          waitersRef.current.push(resolve);
        }), []);

        /**
         * 归还一个 video。若有排队者，直接把槽位移交给它（保持 busy）。
         * @param {number} index - 池下标。
         */
        const releaseSlot = useCallback((index) => {
          const next = waitersRef.current.shift();
          if (next !== undefined) {
            next(index);
            return;
          }
          busyRef.current[index] = false;
        }, []);

        /**
         * 在池中的一个 video 上抓一帧，返回 JPEG data URL。
         * @param {number} time - 目标时间（秒）。
         * @returns {Promise<null|string>} 缩略图，失败时 null。
         */
        const captureWithSlot = useCallback(async (time) => {
          const index = await acquireSlot();
          const video = poolRef.current[index];
          try {
            if (video === null || video === undefined) return null;
            const ready = await ensureVideoData(video);
            if (!ready) return null;
            const duration = Number.isFinite(video.duration) ? video.duration : time + 0.1;
            await seekToTime(video, Math.min(time + 0.0004, Math.max(0, duration - 0.0005)));
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!width || !height) return null;
            const canvas = document.createElement('canvas');
            canvas.width = THUMB_WIDTH;
            canvas.height = Math.max(2, Math.round(THUMB_WIDTH * height / width));
            const context = canvas.getContext('2d');
            if (context === null) return null;
            context.imageSmoothingQuality = 'medium';
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
          } finally {
            releaseSlot(index);
          }
        }, [acquireSlot, releaseSlot]);

        /**
         * 暂停时并行生成可见的缩略帧；播放时不做昂贵的 seek。
         *
         * 任务按「离当前帧近的优先」排序，3 个 worker 同时消费同一个队列。
         * `generation` 在换视频时递增，旧任务即使晚到也不会写进新缓存。
         */
        useEffect(() => {
          if (playing || items.length === 0) return undefined;
          const missing = [];
          const seen = new Set();
          for (const item of items) {
            if (seen.has(item.frame)) continue;
            seen.add(item.frame);
            if (!cacheRef.current.has(item.frame)) missing.push(item.frame);
          }
          if (missing.length === 0) return undefined;
          const anchor = frameIndexRef.current;
          missing.sort((left, right) => Math.abs(left - anchor) - Math.abs(right - anchor));
          let cancelled = false;
          const generation = generationRef.current;
          let timer = null;
          timer = setTimeout(() => {
            void (async () => {
              let cursor = 0;
              const worker = async () => {
                while (!cancelled && cursor < missing.length) {
                  const frame = missing[cursor];
                  cursor += 1;
                  const time = timeline.times[frame];
                  if (!Number.isFinite(time)) continue;
                  try {
                    const data = await captureWithSlot(time);
                    if (cancelled || generation !== generationRef.current || data === null) continue;
                    cacheRef.current.set(frame, data);
                    while (cacheRef.current.size > THUMB_CACHE_LIMIT) {
                      const oldest = cacheRef.current.keys().next().value;
                      cacheRef.current.delete(oldest);
                    }
                    setThumbVersion((value) => value + 1);
                  } catch (reason) {
                    console.warn('[video-frame-viewer] 生成缩略帧失败：', reason);
                  }
                }
              };
              const width = Math.min(THUMB_WORKERS, missing.length);
              await Promise.all(Array.from({ length: width }, () => worker()));
            })();
          }, 60);
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }, [items, timeline, playing, captureWithSlot]);

        /**
         * 秒图单击：延迟一点再跳转，给双击留出判定时间。
         * 逐帧视图里的单击没有歧义，立即跳。
         */
        const handleClick = useCallback((item) => {
          if (expandedSecond !== null) {
            onSelectFrame(item.frame);
            return;
          }
          if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            onSelectFrame(item.frame);
          }, CLICK_DELAY_MS);
        }, [expandedSecond, onSelectFrame]);

        /**
         * 双击秒图：展开这一秒的全部帧。
         * 当前帧不在这一秒时才跳到该秒第一帧；已经在里面就保持原位置，
         * 不把用户正在看的帧重置掉。
         */
        const handleDoubleClick = useCallback((item) => {
          if (clickTimerRef.current !== null) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          if (item.second !== currentSecond) onSelectFrame(item.frame);
          setExpandedSecond(item.second);
        }, [currentSecond, onSelectFrame]);

        if (timeline === null || timeline.frameCount === 0) return null;

        return h(React.Fragment, null,
          h('div', { className: css.stripHeader },
            h('span', { className: css.stripTitle },
              expandedSecond === null
                ? t('strip.title')
                : t('strip.expandedTitle', { second: expandedSecond + 1 })),
            h('span', { className: css.stripHint },
              expandedSecond === null ? t('strip.secondsHint') : t('strip.expandedHint')),
            expandedSecond === null ? null : h('button', {
              type: 'button',
              className: css.stripBack,
              onClick: () => setExpandedSecond(null),
            }, t('strip.backToSeconds')),
            h('span', { className: css.stripCount }, t('strip.current', { frame: frameIndex + 1 }))),

          h('div', {
            className: css.filmstrip,
            'data-thumb-version': String(thumbVersion),
            'data-strip-mode': expandedSecond === null ? 'seconds' : 'frames',
          },
            items.map((item) => {
              const active = expandedSecond === null
                ? item.second === currentSecond
                : item.frame === frameIndex;
              const data = cacheRef.current.get(item.frame);
              const frameTime = timeline.times[item.frame];
              const title = expandedSecond === null
                ? `${t('strip.expandedTitle', { second: item.second + 1 })} · ${formatTime(frameTime)}`
                : `${t('strip.current', { frame: item.frame + 1 })} · ${formatTime(frameTime)}`;
              return h('button', {
                key: item.key,
                type: 'button',
                className: css.thumb + (active ? ' ' + css.thumbActive : ''),
                title,
                'aria-label': title,
                onClick: () => handleClick(item),
                onDoubleClick: expandedSecond === null ? () => handleDoubleClick(item) : undefined,
              },
                data === undefined
                  ? h('span', { className: css.thumbShade }, playing ? '' : t('strip.loading'))
                  : h('img', { className: css.thumbImg, src: data, alt: '' }),
                h('span', { className: css.thumbIndex }, item.label));
            })),

          /*
           * 抓帧池：3 个不可见的 video 元素，只负责解码与绘制，不出现在布局里。
           * 它们共用同一个 blob URL；浏览器会缓存文件数据，不会重复读盘。
           */
          Array.from({ length: THUMB_WORKERS }, (_, index) => h('video', {
            key: 'thumb-video-' + index,
            ref: poolSetters[index],
            className: css.thumbVideo,
            src: source === null ? undefined : source.url,
            muted: true,
            preload: 'auto',
            playsInline: true,
            tabIndex: -1,
            'aria-hidden': true,
          })));
      }

      return { Filmstrip, buildSecondStarts, secondOfFrame };
    }

    return { createFilmstrip, buildSecondStarts, secondOfFrame };
  },
});