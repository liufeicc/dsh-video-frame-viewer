/**
 * 视频逐帧查看 — 视图块。
 *
 * 这里只有 React 组件和浏览器交互：
 *   - 整页面板（ViewerPanel）：打开/关闭视频、播放器、变速、逐帧、帧胶片
 *
 * 图标在 client.icons.js，MP4 解析在 client.mp4.js，样式在 client.styles.js，
 * 文案在 client.dicts.js，播放辅助在 client.playback.js。它们由入口 client.js
 * 装载后注入本块的 createView()，因为 DSH 的包内代码块之间不能互相 require。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.view.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    /** 速度快捷档位；滑杆可以在 0.1–4 之间细调。 */
    const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

    /**
     * 组装视图组件。
     * @param {{css: object, mp4: object, helpers: object, icons: object,
     *   strip: object, sheet: object, copy: object}} deps -
     *   样式表、MP4 解析 API、播放辅助函数、图标组件、帧胶片块、抓帧/拼图块与复制控件。
     * @returns {{ViewerPanel: Function}} 查看面板本体（整页与浮窗共用）。
     */
    function createView({ css, mp4, helpers, icons, strip, sheet, copy }) {
      const { formatTime, formatBytes, seekToTime, probeFrameRate } = helpers;
      const { FilmPlayIcon, FolderIcon, AlertIcon, PlayGlyph, PauseGlyph, FrameGlyph } = icons;
      const { Filmstrip } = strip.createFilmstrip({ css, helpers });
      const { useFrameCopy, FrameCopyButton } = copy;

      /*
       * 面板切换会把整页组件卸载（main 槽位只渲染当前面板）。把「当前视频 + 停在哪一帧」
       * 留在这个模块作用域里：切去对话/插件页再切回来，视频还在，且停在原来的位置。
       * 对象 URL 因此不能随卸载释放，只在换视频或明确关闭视频时释放。
       */
      const session = {
        source: null,
        position: 0,
        speed: 1,
      };
      /**
       * 查看面板本体。整页面板与浮动窗口共用同一个组件，所以两边功能完全一致。
       * @param {{t: Function, chromeless?: boolean}} props -
       *   `t` 是插槽注入的翻译函数；`chromeless` 为真时省掉大标题栏，
       *   只留一行紧凑的「打开 MP4 / 关闭视频」，避免与浮动窗口的标题栏重复。
       * @returns {object} React 元素。
       */
      function ViewerPanel({ t, chromeless = false }) {
        const [source, setSource] = useState(session.source);
        const [meta, setMeta] = useState(null);
        const [timeline, setTimeline] = useState(null);
        const [parseState, setParseState] = useState('idle');
        const [frameIndex, setFrameIndex] = useState(0);
        const [currentTime, setCurrentTime] = useState(0);
        const [playing, setPlaying] = useState(false);
        const [speed, setSpeed] = useState(session.speed);
        const [error, setError] = useState(null);
        const [dropActive, setDropActive] = useState(false);
        /**
         * 逐帧视图里选中的帧号（升序，由帧胶片组件报告）。
         * 超过 1 帧时复制按钮改为「拼接成一张图」。
         */
        const [selectedFrames, setSelectedFrames] = useState([]);
        /**
         * 抓帧器与它的隐藏 video 池：缩略图和拼图复制共用。
         * 池元素由下面的 JSX 渲染，ref 回调把节点交给 grabber。
         */
        const grabber = useMemo(() => sheet.createFrameGrabber({ helpers }), [sheet, helpers]);
        const grabberSetters = useMemo(
          () => Array.from({ length: grabber.workerCount }, (_, index) => (node) => {
            grabber.attach(index, node);
          }),
          [grabber],
        );

        const fileInputRef = useRef(null);
        const videoRef = useRef(null);
        const timelineRef = useRef(null);
        const { copyStatus, copyFrame } = useFrameCopy({
          grabber,
          sheet,
          videoRef,
          timelineRef,
          selectedFrames,
        });
        const frameRef = useRef(0);
        const speedRef = useRef(session.speed);
        const sourceRef = useRef(session.source);
        /*
         * 当前播放位置的独立副本。
         *
         * 卸载时不能依赖 videoRef —— DOM 可能已经先被摘掉、ref 已经变成 null。
         * 这个 ref 由 timeupdate / seek / 翻帧持续更新，卸载收尾时直接读它。
         */
        const positionRef = useRef(session.position);
        /** 重新挂载后要恢复的播放位置；只有一次消费机会。 */
        const pendingRestoreRef = useRef(session.source === null ? 0 : session.position);
        /** 上一次实际使用的对象 URL，用于换片/关闭后延迟释放。 */
        const lastUrlRef = useRef(session.source === null ? null : session.source.url);
        const seekSeqRef = useRef(0);
        const dragDepthRef = useRef(0);
        const probeStartedRef = useRef(false);

        /** 当前视频 → 状态，供稳定回调读取。 */
        useEffect(() => {
          sourceRef.current = source;
        }, [source]);

        /*
         * 换视频或关闭视频后，旧对象 URL 延迟到下一轮事件循环再释放：
         * 此时 React 已经卸载了旧的 <video>，不会让旧元素先报一次解码错误。
         * 组件仅仅卸载（切走面板）时不释放 —— 视频还要在回来时恢复。
         */
        useEffect(() => {
          const previous = lastUrlRef.current;
          const current = source === null ? null : source.url;
          lastUrlRef.current = current;
          if (previous === null || previous === current) return undefined;
          const timer = setTimeout(() => URL.revokeObjectURL(previous), 0);
          return () => clearTimeout(timer);
        }, [source]);

        /** 卸载时停止播放并保存现场，避免切走面板后还有声音。 */
        useEffect(() => () => {
          session.position = positionRef.current;
          session.speed = speedRef.current;
          const video = videoRef.current;
          if (video !== null) video.pause();
        }, []);

        /**
         * 把视频当前时间同步到界面状态。
         * 播放时由 100ms 的定时器调用；暂停/seek 后由事件调用。
         */
        const syncFromVideo = useCallback(() => {
          const video = videoRef.current;
          if (video === null) return;
          const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
          positionRef.current = time;
          setCurrentTime(time);
          const active = timelineRef.current;
          if (active === null) return;
          const index = mp4.indexAtTime(active, time);
          if (index !== frameRef.current) {
            frameRef.current = index;
            setFrameIndex(index);
          }
        }, []);

        /**
         * 换一条时间轴，并把当前帧号重新对齐。
         * @param {object} next - 新时间轴。
         * @param {string|undefined} state - 同时更新的解析状态。
         */
        const applyTimeline = useCallback((next, state) => {
          timelineRef.current = next;
          setTimeline(next);
          if (state !== undefined) setParseState(state);
          const video = videoRef.current;
          if (video !== null) {
            const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
            positionRef.current = time;
            setCurrentTime(time);
            const index = mp4.indexAtTime(next, time);
            frameRef.current = index;
            setFrameIndex(index);
          }
        }, [mp4]);

        /**
         * 跳到某一帧并停住。
         * @param {number} target - 目标帧号（从 0 开始）。
         */
        const goToFrame = useCallback(async (target) => {
          const active = timelineRef.current;
          const video = videoRef.current;
          if (active === null || video === null || active.frameCount === 0) return;
          const index = Math.max(0, Math.min(active.frameCount - 1, Math.round(target)));
          const sequence = seekSeqRef.current + 1;
          seekSeqRef.current = sequence;
          frameRef.current = index;
          setFrameIndex(index);
          if (!video.paused) video.pause();
          const frameTime = active.times[index];
          if (!Number.isFinite(frameTime)) return;
          let seeked = await seekToTime(video, frameTime + 0.0004);
          if (seekSeqRef.current !== sequence) return;
          /*
           * 长 GOP / 大视频第一次 seek 可能超时（还在解码）。重试一次，
           * 仍然失败就保留旧画面并记录日志，不假装已经跳到了目标帧。
           */
          if (!seeked) {
            seeked = await seekToTime(video, frameTime + 0.0004);
            if (seekSeqRef.current !== sequence) return;
          }
          if (!seeked) {
            console.warn('[video-frame-viewer] seek 未在超时内完成，画面可能仍是上一帧');
            return;
          }
          positionRef.current = video.currentTime;
          setCurrentTime(video.currentTime);
          setFrameIndex(index);
        }, []);

        /**
         * 帧胶片点击的回调。必须保持引用稳定：Filmstrip 里的 Thumb 用 React.memo
         * 做了浅比较，如果每次渲染都传新函数，所有缩略图都会重新渲染。
         */
        const handleFilmstripSelect = useCallback((frame) => {
          void goToFrame(frame);
        }, [goToFrame]);

        /** 前后翻帧；播放中会先暂停。 */
        const stepFrames = useCallback((delta) => {
          const active = timelineRef.current;
          if (active === null) return;
          void goToFrame(frameRef.current + delta);
        }, [goToFrame]);

        /** 播放 / 暂停。 */
        const togglePlay = useCallback(() => {
          const video = videoRef.current;
          if (video === null || sourceRef.current === null) return;
          if (video.paused) {
            const attempt = video.play();
            if (attempt && typeof attempt.catch === 'function') {
              attempt.catch(() => setError(t('error.decode')));
            }
          } else {
            video.pause();
          }
        }, [t]);


        /** 设置倍速，范围 0.1–4，保留两位小数。 */
        const applySpeed = useCallback((next) => {
          const value = Math.round(Math.min(4, Math.max(0.1, next)) * 100) / 100;
          speedRef.current = value;
          session.speed = value;
          setSpeed(value);
          const video = videoRef.current;
          if (video !== null) video.playbackRate = value;
        }, []);

        /**
         * 打开一个本地文件。只接受 .mp4 / video/mp4。
         * @param {File} file - 用户选中的文件。
         */
        const openFile = useCallback((file) => {
          if (!file) return;
          const name = file.name || 'video.mp4';
          if (!/\.mp4$/i.test(name) && file.type !== 'video/mp4') {
            setError(t('error.notMp4'));
            return;
          }
          /* 新视频从 1× 开始；倍速是上一段视频的偏好，不应该悄悄带过来。 */
          applySpeed(1);
          const url = URL.createObjectURL(file);
          const next = { file, url, name, size: file.size };
          sourceRef.current = next;
          session.source = next;
          session.position = 0;
          positionRef.current = 0;
          pendingRestoreRef.current = 0;
          setSource(next);
          setMeta(null);
          setTimeline(null);
          timelineRef.current = null;
          setParseState('parsing');
          setFrameIndex(0);
          frameRef.current = 0;
          setCurrentTime(0);
          setPlaying(false);
          setError(null);
          probeStartedRef.current = false;
          setSelectedFrames([]);
        }, [t, applySpeed]);

        /** 关闭当前视频，回到空状态。 */
        const closeVideo = useCallback(() => {
          const video = videoRef.current;
          if (video !== null) video.pause();
          sourceRef.current = null;
          session.source = null;
          session.position = 0;
          positionRef.current = 0;
          pendingRestoreRef.current = 0;
          setSource(null);
          setMeta(null);
          setTimeline(null);
          timelineRef.current = null;
          setParseState('idle');
          setFrameIndex(0);
          frameRef.current = 0;
          setCurrentTime(0);
          setPlaying(false);
          setError(null);
          probeStartedRef.current = false;
          setSelectedFrames([]);
        }, []);

        /** 打开新的元数据：记录分辨率/时长，若精确索引还没到就先铺一条兜底时间轴。 */
        const handleLoadedMetadata = useCallback(() => {
          const video = videoRef.current;
          if (video === null) return;
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          setMeta({ duration, width: video.videoWidth, height: video.videoHeight });
          video.playbackRate = speedRef.current;
          if (video.videoWidth === 0) setError(t('error.noFrames'));
          if (timelineRef.current === null && duration > 0) {
            const fallback = mp4.buildFallbackTimeline(duration, 30);
            timelineRef.current = fallback;
            setTimeline(fallback);
          }
          /* 先把「当前已就绪的画面」同步给界面，再处理位置恢复。 */
          syncFromVideo();
          /*
           * 从别的面板切回来：元数据就绪后回到上次停下的位置。
           * 目标夹到时长以内；seek 完成后 onSeeked 会把帧号同步回来。
           */
          const restore = pendingRestoreRef.current;
          pendingRestoreRef.current = 0;
          if (restore > 0 && duration > 0) {
            const target = Math.min(restore, Math.max(0, duration - 0.001));
            try {
              video.currentTime = target;
            } catch {
              /* 解码器拒绝 seek 时保持第一帧。 */
            }
            positionRef.current = target;
            setCurrentTime(target);
          }
        }, [mp4, syncFromVideo, t]);

        /** 解码失败：浏览器通常拒绝不支持的编码。 */
        const handleVideoError = useCallback(() => {
          if (sourceRef.current === null) return;
          setPlaying(false);
          setError(t('error.decode'));
        }, [t]);

        /**
         * 读取 MP4 精确帧索引。成功就替换兜底时间轴，失败则等元数据做帧率实测。
         * 读取的是文件里的 moov，不把整个视频载入内存。
         */
        useEffect(() => {
          if (source === null) return undefined;
          let cancelled = false;
          setParseState('parsing');
          mp4.readMp4Timeline(source.file).then((result) => {
            if (cancelled) return;
            if (result.ok === true) {
              applyTimeline(result, 'exact');
              return;
            }
            console.warn('[video-frame-viewer] 精确帧索引不可用，将实测帧率：', result.reason);
            setParseState('failed');
          }).catch((reason) => {
            if (cancelled) return;
            console.warn('[video-frame-viewer] 读取帧索引失败：', reason);
            setParseState('failed');
          });
          return () => {
            cancelled = true;
          };
        }, [source, mp4, applyTimeline]);

        /**
         * 精确索引失败时的兜底：用 rVFC 实测帧率，成功与否都铺一条时间轴。
         * 只在「解析失败 + 已有元数据」时跑一次，避免重复播放。
         */
        useEffect(() => {
          if (parseState !== 'failed' || meta === null || source === null) return undefined;
          if (probeStartedRef.current) return undefined;
          probeStartedRef.current = true;
          const video = videoRef.current;
          const duration = meta.duration;
          if (video === null || video.readyState < 2 || !video.paused) {
            applyTimeline(mp4.buildFallbackTimeline(duration, 30), 'estimated');
            return undefined;
          }
          let cancelled = false;
          probeFrameRate(video).then((fps) => {
            if (cancelled) return;
            applyTimeline(mp4.buildFallbackTimeline(duration, fps === null ? 30 : fps), 'estimated');
            if (fps === null) console.warn('[video-frame-viewer] 实测帧率失败，按 30fps 估算');
          }).catch((reason) => {
            if (cancelled) return;
            console.warn('[video-frame-viewer] 实测帧率异常，按 30fps 估算：', reason);
            applyTimeline(mp4.buildFallbackTimeline(duration, 30), 'estimated');
          });
          return () => {
            cancelled = true;
          };
        }, [parseState, meta, source, mp4, applyTimeline]);

        /** 播放中用 100ms 的节拍刷新画面时间；视频本身的播放是独立的。 */
        useEffect(() => {
          if (!playing) return undefined;
          const timer = setInterval(syncFromVideo, 250);
          return () => clearInterval(timer);
        }, [playing, syncFromVideo]);

        /** 键盘：空格播放/暂停、←/→ 单帧、Shift+←/→ 10 帧、Home/End 首尾、[ ] 调速。 */
        useEffect(() => {
          if (source === null) return undefined;
          const onKeyDown = (event) => {
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target;
            const tag = target && target.tagName;
            if (target && (target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
            // 空格在按钮上是浏览器原生的「按下」语义，交给按钮自己处理。
            if (event.key === ' ' && tag === 'BUTTON') return;
            if (event.key === ' ') {
              event.preventDefault();
              togglePlay();
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              stepFrames(event.shiftKey ? -10 : -1);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              stepFrames(event.shiftKey ? 10 : 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              void goToFrame(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              const active = timelineRef.current;
              if (active !== null) void goToFrame(active.frameCount - 1);
            } else if (event.key === '[') {
              event.preventDefault();
              applySpeed(speedRef.current - 0.25);
            } else if (event.key === ']') {
              event.preventDefault();
              applySpeed(speedRef.current + 0.25);
            }
          };
          document.addEventListener('keydown', onKeyDown);
          return () => {
            document.removeEventListener('keydown', onKeyDown);
          };
        }, [source, togglePlay, stepFrames, goToFrame, applySpeed]);

        const frameCount = timeline === null ? 0 : timeline.frameCount;
        const duration = meta === null
          ? (timeline === null ? 0 : timeline.duration)
          : meta.duration;
        const fpsLabel = timeline === null ? '' : timeline.fpsLabel;
        const canStep = frameCount > 1;
        const statusText = parseState === 'exact'
          ? t('status.exact')
          : parseState === 'estimated'
            ? t('status.estimated')
            : parseState === 'failed'
              ? t('status.probing')
              : parseState === 'parsing'
                  ? t('status.parsing')
                  : '';
        const statusDot = parseState === 'exact'
          ? css.statusDot + ' ' + css.statusDotOk
          : parseState === 'parsing' || parseState === 'failed'
            ? css.statusDot + ' ' + css.statusDotBusy
            : css.statusDot;

        /** 打开按钮：点隐藏的 file input。 */
        const chooseFile = () => {
          if (fileInputRef.current !== null) fileInputRef.current.click();
        };

        /** 选择文件后清空 input，允许再次选同一个文件。 */
        const onFileInput = (event) => {
          const file = event.target.files && event.target.files[0];
          event.target.value = '';
          if (file) openFile(file);
        };

        const onDragEnter = (event) => {
          event.preventDefault();
          dragDepthRef.current += 1;
          setDropActive(true);
        };
        const onDragOver = (event) => {
          event.preventDefault();
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
        };
        const onDragLeave = (event) => {
          event.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        };
        const onDrop = (event) => {
          event.preventDefault();
          dragDepthRef.current = 0;
          setDropActive(false);
          const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
          if (file) openFile(file);
        };

        /** 一个播放控制按钮。 */
        const iconButton = (label, glyph, onClick, disabled = false) => h('button', {
          type: 'button',
          className: css.iconButton,
          title: label,
          'aria-label': label,
          onClick,
          disabled,
        }, glyph);

        return h('div', {
          className: css.root,
          onDragEnter,
          onDragOver,
          onDragLeave,
          onDrop,
          /*
           * 鼠标点击按钮后把焦点还给页面：否则随后按空格会再次触发那个按钮，
           * 而不是播放/暂停。键盘用户（event.detail === 0）保留焦点。
           */
          onClickCapture: (event) => {
            if (event.detail === 0) return;
            const target = event.target;
            const button = target && typeof target.closest === 'function' ? target.closest('button') : null;
            if (button !== null) button.blur();
          },
        },
          chromeless
            ? h('div', { className: css.windowBar },
                h('button', {
                  type: 'button',
                  className: css.button + ' ' + css.buttonPrimary,
                  onClick: chooseFile,
                  title: t('a11y.openFile'),
                }, h(FolderIcon), t('panel.open')),
                source === null ? null : h('button', {
                  type: 'button',
                  className: css.button + ' ' + css.buttonGhost,
                  onClick: closeVideo,
                }, t('panel.closeVideo')))
            : h('header', { className: css.header },
                h('div', { className: css.heading },
                  h('span', { className: css.headingIcon }, h(FilmPlayIcon, { size: 22 })),
                  h('div', { className: css.titleBlock },
                    h('h1', { className: css.title }, t('panel.title')),
                    h('p', { className: css.subtitle }, t('panel.subtitle')))),
                h('div', { className: css.headerActions },
                  source === null ? null : h('button', {
                    type: 'button',
                    className: css.button + ' ' + css.buttonGhost,
                    onClick: closeVideo,
                  }, t('panel.closeVideo')),
                  h('button', {
                    type: 'button',
                    className: css.button + ' ' + css.buttonPrimary,
                    onClick: chooseFile,
                    title: t('a11y.openFile'),
                  }, h(FolderIcon), t('panel.open')))),

          error === null ? null : h('div', { className: css.error, role: 'alert' },
            h('span', { className: css.errorIcon }, h(AlertIcon)),
            h('span', { className: css.errorText }, error)),

          h('div', { className: css.body },
            source === null
              ? h('div', { className: css.emptyWrap },
                  h('div', { className: css.empty + (dropActive ? ' ' + css.emptyActive : '') },
                    h('span', { className: css.emptyIcon }, h(FilmPlayIcon, { size: 34 })),
                    h('h2', { className: css.emptyTitle }, t('empty.title')),
                    h('p', { className: css.emptyDesc }, t('empty.desc')),
                    h('div', { className: css.emptyActions },
                      h('button', {
                        type: 'button',
                        className: css.button + ' ' + css.buttonPrimary,
                        onClick: chooseFile,
                      }, h(FolderIcon), t('empty.action'))),
                    h('p', { className: css.emptyHint }, t('empty.hint'))))
              : h('div', { className: css.workspace },
                  h('div', { className: css.stage },
                    h('video', {
                      ref: videoRef,
                      key: source.url,
                      className: css.video,
                      src: source.url,
                      preload: 'auto',
                      playsInline: true,
                      controls: false,
                      'aria-label': t('a11y.video'),
                      onClick: togglePlay,
                      onLoadedMetadata: handleLoadedMetadata,
                      onTimeUpdate: syncFromVideo,
                      onSeeked: syncFromVideo,
                      onPlay: () => setPlaying(true),
                      onPause: () => {
                        setPlaying(false);
                        syncFromVideo();
                      },
                      onEnded: () => {
                        setPlaying(false);
                        syncFromVideo();
                      },
                      onError: handleVideoError,
                    }),
                    h('div', { className: css.stageTop },
                      h('span', { className: css.chip, title: source.name }, source.name),
                      meta !== null && meta.width > 0
                        ? h('span', { className: css.chip }, `${meta.width}×${meta.height}`)
                        : null),
                    h('div', { className: css.stageBottom },
                      h('span', { className: css.chip + ' ' + css.stageTime },
                        `${formatTime(currentTime)} / ${formatTime(duration)}`),
                      h('span', { className: css.chip + ' ' + css.stageTime },
                        `${frameIndex + 1} / ${frameCount === 0 ? '—' : frameCount}${fpsLabel === '' ? '' : ' · ' + fpsLabel + ' fps'}`))),

                  h('div', { className: css.statusRow },
                    statusText === '' ? null : h('span', { className: css.statusChip },
                      h('span', { className: statusDot }),
                      statusText),
                    timeline !== null && timeline.variable
                      ? h('span', { className: css.statusChip }, t('status.variable'))
                      : fpsLabel === ''
                        ? null
                        : h('span', { className: css.statusChip }, t('status.fps', { fps: fpsLabel })),
                    frameCount === 0 ? null : h('span', { className: css.statusChip }, t('status.frames', { count: frameCount })),
                    duration <= 0 ? null : h('span', { className: css.statusChip }, t('status.duration', { time: formatTime(duration, false) })),
                    h('span', { className: css.statusChip }, t('status.size', { size: formatBytes(source.size) }))),

                  h('div', { className: css.controls },
                    h('div', { className: css.transport },
                      iconButton(t('controls.first'), h(FrameGlyph, { direction: 'first' }), () => { void goToFrame(0); }, !canStep),
                      iconButton(t('controls.prev'), h(FrameGlyph, { direction: 'prev' }), () => stepFrames(-1), !canStep),
                      h('button', {
                        type: 'button',
                        className: css.playButton,
                        onClick: togglePlay,
                      }, playing ? h(PauseGlyph) : h(PlayGlyph), playing ? t('controls.pause') : t('controls.play')),
                      iconButton(t('controls.next'), h(FrameGlyph, { direction: 'next' }), () => stepFrames(1), !canStep),
                      iconButton(t('controls.last'), h(FrameGlyph, { direction: 'last' }), () => { void goToFrame(frameCount - 1); }, !canStep),
                      h(FrameCopyButton, {
                        t,
                        css,
                        icons,
                        copyStatus,
                        playing,
                        selectedCount: selectedFrames.length,
                        onClick: () => { void copyFrame(); },
                      }),
                    ),
                    h('div', { className: css.timecode },
                      h('span', { className: css.timecodeStrong }, String(frameIndex + 1)),
                      h('span', null, `/ ${frameCount === 0 ? '—' : frameCount}`),
                      h('span', { className: css.timecodeTime }, formatTime(currentTime))),
                    h('div', { className: css.speedGroup },
                      h('span', { className: css.speedLabel }, t('controls.speed')),
                      h('div', { className: css.speedChips },
                        SPEED_PRESETS.map((value) => h('button', {
                          key: value,
                          type: 'button',
                          className: css.speedChip + (Math.abs(speed - value) < 0.001 ? ' ' + css.speedChipActive : ''),
                          onClick: () => applySpeed(value),
                        }, `${value}×`))),
                      h('input', {
                        type: 'range',
                        className: css.range + ' ' + css.rangeSmall,
                        min: 0.1,
                        max: 4,
                        step: 0.05,
                        value: speed,
                        'aria-label': t('controls.speed'),
                        onChange: (event) => applySpeed(Number(event.target.value)),
                      }),
                      h('span', { className: css.speedValue }, t('controls.speedValue', { speed: speed.toFixed(2) })))),

                  h('div', { className: css.timelineRow },
                    h('input', {
                      type: 'range',
                      className: css.range,
                      min: 0,
                      max: Math.max(0, frameCount - 1),
                      step: 1,
                      value: Math.min(frameIndex, Math.max(0, frameCount - 1)),
                      disabled: !canStep,
                      'aria-label': t('controls.timeline'),
                      onChange: (event) => { void goToFrame(Number(event.target.value)); },
                    })),

                  h(Filmstrip, {
                    key: 'filmstrip',
                    t,
                    source,
                    timeline,
                    frameIndex,
                    playing,
                    grabber,
                    onSelectFrame: handleFilmstripSelect,
                    onSelectionChange: setSelectedFrames,
                  }),

                  h('div', { className: css.hints }, t('hints.keyboard')))),

          /*
           * 抓帧池：3 个不可见的 video 元素，缩略图与拼图复制共用。
           * 它们只负责解码与绘制，不出现在布局里。
           */
          source === null ? null : Array.from({ length: grabber.workerCount }, (_, index) => h('video', {
            key: 'grabber-video-' + index,
            ref: grabberSetters[index],
            className: css.thumbVideo,
            src: source.url,
            muted: true,
            preload: 'auto',
            playsInline: true,
            tabIndex: -1,
            'aria-hidden': true,
          })),

          h('input', {
            ref: fileInputRef,
            type: 'file',
            accept: 'video/mp4,.mp4',
            className: css.visuallyHidden,
            tabIndex: -1,
            'aria-hidden': true,
            onChange: onFileInput,
          }),

          dropActive
            ? h('div', { className: css.dropMask },
                h(FilmPlayIcon, { size: 38 }),
                h('div', { className: css.dropTitle }, t('drop.title')))
            : null);
      }

      return { ViewerPanel };
    }

    return { createView };
  },
});
