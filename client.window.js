/**
 * 视频逐帧查看 — 浮动窗口块。
 *
 * 这个块只做一件事：把整页的查看面板装进一个可拖动的浮动窗口里，供
 * 「多工作区平铺」等其它界面用按钮唤起。功能本体在 client.view.js 的
 * ViewerPanel 里，本块通过参数拿到它，不复制任何播放逻辑。
 *
 * 为什么用 `shell.overlay` 而不是 portal 到 body：
 *   - 该槽位是框架提供的窗口级浮层，子元素自带 `pointer-events:auto`，
 *     浮窗之外的区域不会挡住页面；
 *   - 主题 token、语言、层级都由框架负责，插件卸载时条目自动移除。
 *
 * 窗口交互：
 *   - 拖动标题栏移动（双击标题栏最大化 / 还原）；
 *   - 右下角手柄缩放，最小 680×460；
 *   - Esc 只在焦点位于窗口内时关闭，不抢页面上其它弹层的按键。
 *
 * 加载方式：入口 client.js 用 require.async('./client.window.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.window.js',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;

    /** 数值夹取。 */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    /**
     * 浮动窗口的初始矩形：默认居中、占视口约八成，但不小于可用尺寸。
     * @returns {{left:number,top:number,width:number,height:number}} 像素矩形。
     */
    function initialWindowRect() {
      if (typeof window === 'undefined') return { left: 40, top: 40, width: 1080, height: 720 };
      const width = Math.min(1280, Math.max(760, Math.round(window.innerWidth * 0.8)));
      const height = Math.min(900, Math.max(540, Math.round(window.innerHeight * 0.82)));
      return {
        left: Math.max(8, Math.round((window.innerWidth - width) / 2)),
        top: Math.max(8, Math.round((window.innerHeight - height) / 2)),
        width,
        height,
      };
    }

    /**
     * 组装浮动窗口。
     * @param {{css: object, icons: object, ViewerPanel: Function}} deps -
     *   样式表、图标组件与查看面板本体。
     * @returns {{FloatingViewer: Function, FloatingWindow: Function}} 两个组件。
     */
    function createWindow({ css, icons, ViewerPanel }) {
      const { FilmPlayIcon } = icons;

      /**
       * 窗口标题栏图标：最大化 / 还原。
       * @param {{restore?: boolean, size?: number}} props - 是否显示「还原」画法。
       * @returns {object} SVG 元素。
       */
      function WindowGlyph({ restore = false, size = 14 }) {
        if (restore) {
          return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('rect', { x: 3, y: 5.5, width: 8, height: 8, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.3 }),
            h('path', {
              d: 'M5.5 5.5V4.2A1.2 1.2 0 0 1 6.7 3h6.1A1.2 1.2 0 0 1 14 4.2v6.1a1.2 1.2 0 0 1-1.2 1.2h-1.3',
              stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
            }));
        }
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }));
      }

      /** 关闭图标。 */
      function CloseGlyph({ size = 14 }) {
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
      }

      /**
       * 浮窗的窗口框：拖动标题栏移动、右下角缩放、双击标题栏最大化、Esc 关闭。
       * 内容区就是完整的面板本体（chromeless 模式）。
       * @param {{t: Function, onClose: Function}} props - 翻译函数与关闭回调。
       * @returns {object} React 元素。
       */
      function FloatingWindow({ t, onClose }) {
        const [rect, setRect] = useState(initialWindowRect);
        const [maximized, setMaximized] = useState(false);
        const [dragging, setDragging] = useState(false);
        const [resizing, setResizing] = useState(false);
        const restoreRef = useRef(null);
        const dragRef = useRef(null);
        const resizeRef = useRef(null);
        const windowRef = useRef(null);

        /** 打开时把焦点给窗口本身，这样 Esc 立刻可用。 */
        useEffect(() => {
          const node = windowRef.current;
          if (node !== null && typeof node.focus === 'function') node.focus({ preventScroll: true });
        }, []);

        /** 最大化 / 还原：最大化时记住原矩形，还原时原样放回。 */
        const toggleMaximize = useCallback(() => {
          if (maximized) {
            if (restoreRef.current !== null) setRect(restoreRef.current);
            setMaximized(false);
          } else {
            restoreRef.current = rect;
            setMaximized(true);
          }
        }, [maximized, rect]);

        /** 标题栏按下：只对非按钮区域起手，避免拖动按钮时把窗口带走。 */
        const onTitlePointerDown = (event) => {
          if (event.button !== 0 || maximized) return;
          const target = event.target;
          if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) return;
          event.preventDefault();
          dragRef.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            left: rect.left,
            top: rect.top,
          };
          setDragging(true);
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        };

        const onTitlePointerMove = (event) => {
          const start = dragRef.current;
          if (start === null) return;
          const maxLeft = Math.max(0, window.innerWidth - 120);
          const maxTop = Math.max(0, window.innerHeight - 48);
          setRect((current) => ({
            ...current,
            left: clamp(start.left + event.clientX - start.pointerX, 120 - current.width, maxLeft),
            top: clamp(start.top + event.clientY - start.pointerY, 0, maxTop),
          }));
        };

        const endTitleDrag = (event) => {
          if (dragRef.current === null) return;
          dragRef.current = null;
          setDragging(false);
          if (typeof event.currentTarget.releasePointerCapture === 'function'
            && event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        };

        /** 右下角缩放：最小 680×460，最大不超过视口。 */
        const onResizePointerDown = (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          resizeRef.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            width: rect.width,
            height: rect.height,
          };
          setResizing(true);
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        };

        const onResizePointerMove = (event) => {
          const start = resizeRef.current;
          if (start === null) return;
          const minWidth = Math.min(680, window.innerWidth - 16);
          const minHeight = Math.min(460, window.innerHeight - 16);
          const maxWidth = Math.max(minWidth, window.innerWidth - Math.max(0, rect.left) - 8);
          const maxHeight = Math.max(minHeight, window.innerHeight - Math.max(0, rect.top) - 8);
          setRect((current) => ({
            ...current,
            width: clamp(start.width + event.clientX - start.pointerX, minWidth, maxWidth),
            height: clamp(start.height + event.clientY - start.pointerY, minHeight, maxHeight),
          }));
        };

        const endResize = (event) => {
          if (resizeRef.current === null) return;
          resizeRef.current = null;
          setResizing(false);
          if (typeof event.currentTarget.releasePointerCapture === 'function'
            && event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        };

        /** Esc 关闭：只在焦点位于窗口内时生效，不抢页面上别的弹层的按键。 */
        const onWindowKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        };

        const style = maximized
          ? undefined
          : { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' };

        return h('section', {
          ref: windowRef,
          className: css.floatWindow
            + (maximized ? ' ' + css.floatMaximized : '')
            + (dragging ? ' ' + css.floatDragging : '')
            + (resizing ? ' ' + css.floatResizing : ''),
          style,
          role: 'dialog',
          'aria-label': t('panel.title'),
          tabIndex: -1,
          onKeyDown: onWindowKeyDown,
        },
          h('header', {
            className: css.floatTitle,
            onPointerDown: onTitlePointerDown,
            onPointerMove: onTitlePointerMove,
            onPointerUp: endTitleDrag,
            onPointerCancel: endTitleDrag,
            onDoubleClick: toggleMaximize,
            title: t('float.dragHint'),
          },
            h('span', { className: css.floatTitleIcon }, h(FilmPlayIcon, { size: 17 })),
            h('span', { className: css.floatTitleText }, t('panel.title')),
            h('div', { className: css.floatTitleActions },
              h('button', {
                type: 'button',
                className: css.floatIconButton,
                onClick: toggleMaximize,
                title: maximized ? t('float.restore') : t('float.maximize'),
                'aria-label': maximized ? t('float.restore') : t('float.maximize'),
              }, h(WindowGlyph, { restore: maximized })),
              h('button', {
                type: 'button',
                className: css.floatIconButton,
                onClick: onClose,
                title: t('float.close'),
                'aria-label': t('float.close'),
              }, h(CloseGlyph)))),
          h('div', { className: css.floatBody },
            h(ViewerPanel, { t, chromeless: true })),
          maximized
            ? null
            : h('span', {
                className: css.floatResize,
                title: t('float.resize'),
                'aria-hidden': true,
                onPointerDown: onResizePointerDown,
                onPointerMove: onResizePointerMove,
                onPointerUp: endResize,
                onPointerCancel: endResize,
              }, h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true },
                h('path', { d: 'M13 5 5 13M13 9 9 13', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))));
      }

      /**
       * `shell.overlay` 条目：按服务的开关状态渲染浮动窗口。
       * @param {{store: object, t: Function}} props - 开关 store 与翻译函数。
       * @returns {object|null} 浮窗，或关闭时的 null。
       */
      function FloatingViewer({ store, t }) {
        const open = useSyncExternalStore(store.subscribe, store.getSnapshot);
        if (!open) return null;
        return h(FloatingWindow, { t, onClose: () => store.set(false) });
      }

      return { FloatingViewer, FloatingWindow };
    }

    return { createWindow };
  },
});