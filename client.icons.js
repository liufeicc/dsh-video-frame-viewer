/**
 * 视频逐帧查看 — 图标块。
 *
 * 只画 SVG，不含状态与逻辑。所有图标使用 currentColor，颜色由所在按钮/容器继承，
 * 因此浅色与深色主题都不需要单独配色。
 *
 * 加载方式：入口 client.js 通过 require.async('./client.icons.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.icons.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 侧边栏用的胶片 + 播放三角图标。 */
    function PanelIcon({ size = 18, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', { x: 4, y: 3, width: 16, height: 18, rx: 3.2, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M4 8h16M4 16h16', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.55 }),
        h('path', {
          d: 'M10 9.2 15.4 12 10 14.8Z',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }));
    }

    /** 面板标题与空状态用的大图标。 */
    function FilmPlayIcon({ size = 24 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 32 32',
        fill: 'none',
        'aria-hidden': true,
      },
        h('rect', { x: 5, y: 4, width: 22, height: 24, rx: 4, stroke: 'currentColor', strokeWidth: 1.8 }),
        h('path', { d: 'M5 11h22M5 21h22', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.5 }),
        h('path', { d: 'M13.5 12.4 21 16l-7.5 3.6Z', fill: 'currentColor' }));
    }

    /** 打开文件的小图标。 */
    function FolderIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.2 4.4A1.2 1.2 0 0 1 3.4 3.2h2.3l1.3 1.6h5.6a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }));
    }

    /** 错误提示的感叹号。 */
    function AlertIcon({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6.3, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M8 4.8v3.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 11.2, r: 0.8, fill: 'currentColor' }));
    }

    /** 播放三角。 */
    function PlayGlyph({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M4.6 2.9 13 8l-8.4 5.1Z' }));
    }

    /** 暂停双竖线。 */
    function PauseGlyph({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
        h('rect', { x: 4, y: 3, width: 3, height: 10, rx: 1 }),
        h('rect', { x: 9, y: 3, width: 3, height: 10, rx: 1 }));
    }

    /** 上一帧 / 下一帧 / 首帧 / 末帧。 */
    function FrameGlyph({ direction }) {
      if (direction === 'first') {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M4 3.5v9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M12.5 4.2 6.6 8l5.9 3.8Z', fill: 'currentColor' }));
      }
      if (direction === 'last') {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M12 3.5v9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M3.5 4.2 9.4 8l-5.9 3.8Z', fill: 'currentColor' }));
      }
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: direction === 'prev' ? 'M10.5 3.8 5.6 8l4.9 4.2' : 'M5.5 3.8 10.4 8l-4.9 4.2',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /** 复制图标：两张叠在一起的纸。 */
    function CopyGlyph({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /** 对勾：复制成功后的短暂反馈。 */
    function CheckGlyph({ size = 15 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M3.2 8.4 6.4 11.5 12.8 4.8',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    return { PanelIcon, FilmPlayIcon, FolderIcon, AlertIcon, PlayGlyph, PauseGlyph, FrameGlyph, CopyGlyph, CheckGlyph };
  },
});
