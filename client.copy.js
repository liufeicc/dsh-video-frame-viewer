/**
 * 视频逐帧查看 — 复制控件。
 *
 * 从查看面板里拆出来的两件事：
 *   - `useFrameCopy`：复制状态机（idle / busy / done / failed / unsupported），
 *     调用 client.sheet.js 把当前帧、选中帧或拼接图写入剪贴板；
 *   - `FrameCopyButton`：播放控制条最右侧的复制按钮，负责多选文案、
 *     播放中禁用和成功/失败图标。
 *
 * 这样 client.view.js 不用再背复制按钮的一长串 title/aria-label 分支，
 * 单个文件也能控制在 800 行以内。
 *
 * 加载方式：入口 client.js 用 require.async('./client.copy.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.copy.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useState } = React;
    const h = React.createElement;

    /**
     * 复制状态与动作。
     *
     * @param {{grabber: object, sheet: object, videoRef: object, timelineRef: object,
     *   selectedFrames: number[]}} input - 抓帧器、拼图模块、主视频与时间轴 ref、
     *   逐帧视图选中的帧号（升序）。
     * @returns {{copyStatus: string, copyFrame: Function}} 状态与触发函数。
     */
    function useFrameCopy({ grabber, sheet, videoRef, timelineRef, selectedFrames }) {
      const [copyStatus, setCopyStatus] = useState('idle');

      /**
       * 复制到系统剪贴板：
       *   - 选了多帧：按帧号升序拼成一张大图；
       *   - 选了 1 帧：精确抓取那一帧（原始分辨率）；
       *   - 没选：复制主播放器的当前帧（原始分辨率）。
       *
       * 播放中直接返回（按钮也会禁用）：画面一直在变，复制到的帧不确定。
       * 剪贴板 API 不可用（非安全上下文/浏览器不支持）时给出明确反馈。
       */
      const copyFrame = useCallback(async () => {
        const video = videoRef.current;
        const active = timelineRef.current;
        if (video === null || !video.paused || video.videoWidth === 0 || video.videoHeight === 0) return;
        if (active === null) return;
        if (typeof ClipboardItem === 'undefined'
          || typeof navigator === 'undefined'
          || navigator.clipboard === undefined
          || typeof navigator.clipboard.write !== 'function') {
          setCopyStatus('unsupported');
          return;
        }
        setCopyStatus('busy');
        const result = await sheet.copyFramesToClipboard({
          grabber,
          mainVideo: video,
          times: active.times,
          frames: selectedFrames.length > 0 ? selectedFrames : null,
        });
        if (result.ok === true) setCopyStatus('done');
        else setCopyStatus(result.reason === 'unsupported' ? 'unsupported' : 'failed');
      }, [grabber, selectedFrames, sheet, timelineRef, videoRef]);

      /** done / failed / unsupported 都是短暂反馈，1.8 秒后回到 idle。 */
      useEffect(() => {
        if (copyStatus === 'idle' || copyStatus === 'busy') return undefined;
        const timer = setTimeout(() => setCopyStatus('idle'), 1800);
        return () => clearTimeout(timer);
      }, [copyStatus]);

      return { copyStatus, copyFrame };
    }

    /**
     * 复制按钮。
     *
     * @param {{t: Function, css: object, icons: object, copyStatus: string,
     *   playing: boolean, selectedCount: number, onClick: Function}} props -
     *   文案函数、样式、图标、复制状态、播放状态、选中帧数与点击回调。
     * @returns {object} 按钮元素。
     */
    function FrameCopyButton({ t, css, icons, copyStatus, playing, selectedCount, onClick }) {
      const multi = selectedCount > 1;
      const doneLabel = multi
        ? t('controls.copiedSelected', { count: selectedCount })
        : t('controls.copied');
      const idleLabel = multi
        ? t('controls.copySelected', { count: selectedCount })
        : t('controls.copyFrame');
      const title = copyStatus === 'done'
        ? doneLabel
        : copyStatus === 'failed'
          ? t('controls.copyFailed')
          : copyStatus === 'unsupported'
            ? t('controls.copyUnsupported')
            : copyStatus === 'busy'
              ? t('controls.copyBuilding')
              : playing
                ? t('controls.copyWhilePlaying')
                : multi
                  ? t('controls.copySelectedHint', { count: selectedCount })
                  : t('controls.copyFrame');
      const label = copyStatus === 'done'
        ? doneLabel
        : copyStatus === 'failed'
          ? t('controls.copyFailed')
          : copyStatus === 'unsupported'
            ? t('controls.copyUnsupported')
            : idleLabel;
      return h('button', {
        type: 'button',
        'data-copy-frame': 'true',
        className: css.iconButton
          + (copyStatus === 'done' ? ' ' + css.iconButtonDone : '')
          + (copyStatus === 'failed' || copyStatus === 'unsupported' ? ' ' + css.iconButtonFailed : '')
          + (multi ? ' ' + css.iconButtonSelected : ''),
        title,
        'aria-label': label,
        onClick,
        disabled: playing || copyStatus === 'busy',
      },
        copyStatus === 'done'
          ? h(icons.CheckGlyph)
          : copyStatus === 'failed' || copyStatus === 'unsupported'
            ? h(icons.AlertIcon)
            : h(icons.CopyGlyph));
    }

    return { useFrameCopy, FrameCopyButton };
  },
});