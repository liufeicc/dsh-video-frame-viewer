/**
 * 视频逐帧查看 — 帧胶片块。
 *
 * 胶片不再把附近每一帧都铺出来，而是**按秒**呈现：
 *   - 默认：显示当前秒附近共 9 秒，每秒一张缩略图（取该秒第一帧）；
 *   - 双击某一秒：展开该秒内的**全部帧**，单击任意缩略帧跳到那一帧；
 *   - 逐帧视图里点「返回每秒」回到按秒视图；跳到别的秒时也会自动收起。
 *
 * ## 逐帧视图里的多选
 *
 *   - 普通单击：跳到该帧，并把选择重置为这一帧；
 *   - Shift + 单击：从上一次锚点到目标帧的**连续范围**（含两端）；
 *   - Ctrl / Cmd + 单击：把目标帧加入选择或从选择中移除（多选）。
 *
 * 选中的帧会通过 `onSelectionChange` 交给查看面板；面板的「复制」按钮在
 * 选中多帧时把这一组帧按时间顺序拼成一张大图写进剪贴板。
 *
 * ## 为什么抓帧要用一个池塘
 *
 * 隐藏 <video> 抓一帧要「seek 到时间点 → 等解码器从最近关键帧解到这一帧 →
 * 等画面更新 → 画到 canvas」。H.264 每次 seek 都要重新解码一段，串行做 30 张
 * 就是 30 段解码。抓帧池在 client.sheet.js 里，3 个隐藏 video 轮流干活；
 * 帧胶片和拼图复制共用这一个池。
 *
 * 缩略图只做 192px 宽、JPEG 质量 0.62 —— 胶片上每张只有一百来像素。
 * 抓取顺序按「离当前帧越近越先」排，所以双击展开后当前帧附近先出现。
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
    /** 缩略图缓存的并发任务数；抓帧池内部还会把并发限制在 3。 */
    const THUMB_TASKS = 3;
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
      const { formatTime } = helpers;

      /**
       * 单张缩略图。用 React.memo 包住：播放/翻帧时只有 active 变化的那一两张
       * 需要重渲染，其余几十张直接跳过。否则每 100ms 一次的状态更新会把整个
       * 展开视图的 DOM 全部 diff 一遍，长时间播放后会明显卡顿。
       */
      const Thumb = React.memo(function Thumb({
        item,
        active,
        selected,
        data,
        title,
        loadingText,
        css: styles,
        onActivate,
        onExpand,
      }) {
        return h('button', {
          type: 'button',
          className: styles.thumb
            + (active ? ' ' + styles.thumbActive : '')
            + (selected ? ' ' + styles.thumbSelected : ''),
          title,
          'aria-label': title,
          'data-frame': String(item.frame),
          'aria-pressed': onExpand === null ? (selected ? 'true' : 'false') : undefined,
          onClick: (event) => onActivate(item, event),
          onDoubleClick: onExpand === null ? undefined : () => onExpand(item),
        },
          data === undefined
            ? h('span', { className: styles.thumbShade }, loadingText)
            : h('img', { className: styles.thumbImg, src: data, alt: '' }),
          selected
            ? h('span', { className: styles.thumbCheck, 'aria-hidden': true }, '✓')
            : null,
          h('span', { className: styles.thumbIndex }, item.label));
      });

      /**
       * 帧胶片：按秒浏览，双击某一秒展开该秒全部帧，支持 Shift/Ctrl 多选。
       * @param {{t: Function, source: object, timeline: object, frameIndex: number,
       *   playing: boolean, grabber: object, onSelectFrame: Function,
       *   onSelectionChange: Function}} props -
       *   `onSelectFrame(frame)` 由查看面板提供，负责 seek 并暂停；
       *   `onSelectionChange(frames)` 报告当前逐帧选择（升序帧号）。
       * @returns {object|null} 胶片元素；没有时间轴时为 null。
       */
      function Filmstrip({
        t,
        source,
        timeline,
        frameIndex,
        playing,
        grabber,
        onSelectFrame,
        onSelectionChange,
      }) {
        const [thumbVersion, setThumbVersion] = useState(0);
        const [expandedSecond, setExpandedSecond] = useState(null);
        /** 逐帧视图里选中的帧号（无序；对外报告时排序）。 */
        const [selection, setSelection] = useState([]);
        const cacheRef = useRef(new Map());
        /** 当前可见条目；缓存淘汰时用来保护它们，避免正在看的缩略图被删。 */
        const itemsRef = useRef([]);
        /** 缩略图渲染的批量更新计时器（最多 120ms 触发一次）。 */
        const renderTimerRef = useRef(null);
        const clickTimerRef = useRef(null);
        /** 换视频 / 换时间轴时递增；旧任务的结果一律丢弃。 */
        const generationRef = useRef(0);
        /** 抓帧顺序用的当前帧（放在 ref 里，避免翻帧时重启整批任务）。 */
        const frameIndexRef = useRef(frameIndex);
        /** Shift 连选的锚点帧。 */
        const anchorRef = useRef(frameIndex);

        useEffect(() => {
          frameIndexRef.current = frameIndex;
        }, [frameIndex]);

        /** 换视频或换时间轴：旧缩略图不再对应同一帧，全部作废。 */
        useEffect(() => {
          generationRef.current += 1;
          cacheRef.current.clear();
          setThumbVersion((value) => value + 1);
          setExpandedSecond(null);
          setSelection([]);
        }, [source, timeline]);

        /**
         * 进入/退出逐帧视图时重置选择。
         * 锚点取当时的当前帧：双击展开时查看面板会先跳到该秒第一帧，
         * 这一步在 setExpandedSecond 之前同步完成，所以这里读到的是新帧号。
         */
        useEffect(() => {
          setSelection([]);
          anchorRef.current = frameIndex;
          // 只在展开状态变化时重置；翻帧不应清掉正在进行的多选。
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [expandedSecond]);

        /** 把选择（升序）报告给查看面板；秒视图下始终为空。 */
        useEffect(() => {
          const frames = expandedSecond === null ? [] : [...selection].sort((left, right) => left - right);
          if (typeof onSelectionChange === 'function') onSelectionChange(frames);
        }, [selection, expandedSecond, onSelectionChange]);

        /**
         * 缩略图生成是并行的，每生成一张就 setState 会让整个展开视图重渲染
         * 几十次。这里合并成 120ms 一批，肉眼几乎无感，但大幅减少渲染压力。
         */
        const scheduleThumbRender = useCallback(() => {
          if (renderTimerRef.current !== null) return;
          renderTimerRef.current = setTimeout(() => {
            renderTimerRef.current = null;
            setThumbVersion((value) => value + 1);
          }, 120);
        }, []);

        /** 卸载时清掉尚未触发的单击计时器与缩略图批量更新。 */
        useEffect(() => () => {
          if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
          if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
        }, []);

        const secondStarts = useMemo(() => buildSecondStarts(timeline), [timeline]);
        const currentSecond = useMemo(() => secondOfFrame(timeline, frameIndex), [timeline, frameIndex]);

        /**
         * 当前胶片条目：
         *   - 秒视图：当前秒附近 9 秒，每秒一条；
         *   - 逐帧视图：展开那一秒的所有帧。
         */
        const expandedItems = useMemo(() => {
          if (timeline === null || timeline.frameCount === 0 || expandedSecond === null) return [];
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
          /*
           * 注意：不要依赖 frameIndex / currentSecond。展开视图里 playing 时
           * 播放时钟每秒都会变，如果这里跟着重建，60 个 item 全是新对象，
           * Thumb 的 memo 就白做了，整个展开视图每秒重渲染一次。
           */
        }, [timeline, expandedSecond, secondStarts]);

        const secondItems = useMemo(() => {
          if (timeline === null || timeline.frameCount === 0 || expandedSecond !== null) return [];
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

        const items = expandedSecond === null ? secondItems : expandedItems;

        useEffect(() => {
          itemsRef.current = items;
        }, [items]);

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
         * 暂停时并行生成可见的缩略帧；播放时不做昂贵的 seek。
         *
         * 任务按「离当前帧近的优先」排序，3 个 worker 同时消费同一个队列，
         * 抓帧池再把真正的解码并发限制在 3。`generation` 在换视频时递增，
         * 旧任务即使晚到也不会写进新缓存。
         */
        useEffect(() => {
          if (playing || items.length === 0 || grabber === undefined) return undefined;
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
                    const data = await grabber.captureDataUrl(time, THUMB_WIDTH, THUMB_QUALITY);
                    if (cancelled || generation !== generationRef.current || data === null) continue;
                    cacheRef.current.set(frame, data);
                    /*
                     * 淘汰最旧的、但**不在当前可见列表里**的缩略图。
                     * 直接删最旧会把正在看的帧删掉，而生成 effect 又不会因为
                     * 缓存变化重跑，结果就是缩略图变成「生成中」再也回不来。
                     */
                    const visible = new Set(itemsRef.current.map((item) => item.frame));
                    while (cacheRef.current.size > THUMB_CACHE_LIMIT) {
                      let victim = null;
                      for (const key of cacheRef.current.keys()) {
                        if (!visible.has(key)) {
                          victim = key;
                          break;
                        }
                      }
                      if (victim === null) break;
                      cacheRef.current.delete(victim);
                    }
                    scheduleThumbRender();
                  } catch (reason) {
                    console.warn('[video-frame-viewer] 生成缩略帧失败：', reason);
                  }
                }
              };
              const width = Math.min(THUMB_TASKS, missing.length);
              await Promise.all(Array.from({ length: width }, () => worker()));
            })();
          }, 60);
          return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
          };
        }, [items, timeline, playing, grabber, scheduleThumbRender]);

        /**
         * 逐帧视图里的选择逻辑：
         *   - 普通单击：单选，锚点移到该帧；
         *   - Shift：从锚点到目标帧连选（锚点不动）；
         *   - Ctrl / Cmd：切换该帧，锚点移到该帧。
         * 三种情况都会顺便跳到目标帧，方便边选边看。
         * @param {object} item - 被点击的胶片条目。
         * @param {MouseEvent} event - 点击事件（读取修饰键）。
         */
        const applyFrameSelection = useCallback((item, event) => {
          const frame = item.frame;
          if (event !== null && event !== undefined && event.shiftKey) {
            const anchor = anchorRef.current;
            const from = Math.min(anchor, frame);
            const to = Math.max(anchor, frame);
            const next = [];
            for (let index = from; index <= to; index += 1) next.push(index);
            setSelection(next);
          } else if (event !== null && event !== undefined && (event.ctrlKey || event.metaKey)) {
            setSelection((current) => (
              current.includes(frame)
                ? current.filter((value) => value !== frame)
                : [...current, frame]
            ));
            anchorRef.current = frame;
          } else {
            setSelection([frame]);
            anchorRef.current = frame;
          }
          onSelectFrame(frame);
        }, [onSelectFrame]);

        /**
         * 秒图单击：延迟一点再跳转，给双击留出判定时间。
         * 逐帧视图里的单击（含 Shift/Ctrl）直接处理。
         */
        const handleClick = useCallback((item, event) => {
          if (expandedSecond !== null) {
            applyFrameSelection(item, event);
            return;
          }
          if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            onSelectFrame(item.frame);
          }, CLICK_DELAY_MS);
        }, [expandedSecond, applyFrameSelection, onSelectFrame]);

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

        return h('div', {
          className: css.stripSection + (expandedSecond === null ? '' : ' ' + css.stripSectionExpanded),
        },
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
            selection.length > 1
              ? h('span', { className: css.stripSelectedCount }, t('strip.selectedCount', { count: selection.length }))
              : null,
            h('span', { className: css.stripCount }, t('strip.current', { frame: frameIndex + 1 }))),

          h('div', {
            className: css.filmstripScroll,
            'data-filmstrip-scroll': 'true',
          },
            h('div', {
              className: css.filmstrip,
              'data-thumb-version': String(thumbVersion),
              'data-strip-mode': expandedSecond === null ? 'seconds' : 'frames',
            },
            items.map((item) => {
              const active = expandedSecond === null
                ? item.second === currentSecond
                : item.frame === frameIndex;
              const selected = expandedSecond !== null && selection.includes(item.frame);
              const data = cacheRef.current.get(item.frame);
              const frameTime = timeline.times[item.frame];
              const title = expandedSecond === null
                ? `${t('strip.expandedTitle', { second: item.second + 1 })} · ${formatTime(frameTime)}`
                : `${t('strip.current', { frame: item.frame + 1 })} · ${formatTime(frameTime)}`;
              return h(Thumb, {
                key: item.key,
                item,
                active,
                selected,
                data,
                title,
                loadingText: playing ? '' : t('strip.loading'),
                css,
                onActivate: handleClick,
                onExpand: expandedSecond === null ? handleDoubleClick : null,
              });
            }))));
      }

      return { Filmstrip, buildSecondStarts, secondOfFrame };
    }

    return { createFilmstrip, buildSecondStarts, secondOfFrame };
  },
});