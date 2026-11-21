/**
 * 视频逐帧查看 — 客户端入口块。
 *
 * 它在 Web 界面里提供三样东西：
 *   1. 左侧全局图标栏的一行（`sidebar.panellist`），点击把主区切到本面板；
 *   2. 整页查看面板（`main`，key = `video-frame-viewer`）；
 *   3. 一个客户端服务 `videoFrameViewer`（`open()` / `close()` / `toggle()`）
 *      与 `shell.overlay` 浮动窗口 —— 其它界面（如多工作区平铺的按钮）调用它，
 *      就能在不离开当前页面的情况下弹出视频查看器。浮窗与整页面板共用同一个组件。
 *
 * 代码按职责拆成几个包内代码块（DSH 的模块系统用 require.async 加载同目录文件）：
 *   - client.styles.js    样式表与 class 名；
 *   - client.dicts.js     中英文案；
 *   - client.mp4.js       MP4 moov 解析、精确帧时间轴；
 *   - client.playback.js  时间格式化、seek 等帧、rVFC 实测帧率；
 *   - client.icons.js     SVG 图标；
 *   - client.view.js      React 视图（查看面板本体）；
 *   - client.window.js    浮动窗口外壳（拖动、缩放、最大化）；
 *   - client.strip.js     帧胶片（每秒一张，双击展开该秒全部帧）。
 *
 * 入口只负责装载、注册插槽和注入样式，不承载业务逻辑。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer',
  factory(require) {
    /** 包名，同时是客户端模块 id。 */
    const PLUGIN_ID = '@local/dsh-video-frame-viewer';
    /** 主面板 key；侧边栏那一行的 id 必须与它一致，点击才会切到本面板。 */
    const PANEL_ID = 'video-frame-viewer';
    /** 词典命名空间。 */
    const NS = 'video-frame-viewer';
    /** 样式表身份标记，避免 HMR 时重复插入。 */
    const CSS_ID = PLUGIN_ID + '/client.css';
    /** 包内代码块清单；顺序与 loadChunks 的解构一致。 */
    const CHUNK_FILES = [
      './client.styles.js',
      './client.dicts.js',
      './client.mp4.js',
      './client.playback.js',
      './client.icons.js',
      './client.view.js',
      './client.window.js',
      './client.strip.js',
    ];

    /**
     * 并行加载全部代码块。
     * @param {Function} require - 模块加载器传入的 require（带 async）。
     * @returns {Promise<object>} 按名字打包的代码块。
     */
    function loadChunks(require) {
      if (typeof require.async !== 'function') {
        return Promise.reject(new Error('client module loader 不支持包内代码块（require.async 缺失）'));
      }
      return Promise.all(CHUNK_FILES.map((file) => require.async(file)))
        .then(([styles, dicts, mp4, playback, icons, view, window, strip]) => ({
          styles,
          dicts,
          mp4,
          playback,
          icons,
          view,
          window,
          strip,
        }));
    }

    /** 每个 factory 实例只装载一次。 */
    const chunks = loadChunks(require);

    /**
     * 极小的布尔快照 store：记录浮动窗口是开还是关。
     *
     * 用 store 而不是普通变量，是因为按钮所在插件与浮窗渲染方都可能在任何时刻读取；
     * store 同时给 React（`useSyncExternalStore`）和服务调用方一个统一的订阅面。
     * @param {boolean} initial - 初始状态。
     * @returns {{getSnapshot: Function, subscribe: Function, set: Function}} store。
     */
    function createFlagStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set: (next) => {
          if (next === value) return;
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * 注册样式、词典、侧边栏图标与主面板。
     * @param {object} ctx - 客户端插件上下文。
     */
    async function apply(ctx) {
      /*
       * 浮动窗口的开关状态与服务入口。
       *
       * 在第一个 await 之前同步发布：其它界面（多工作区平铺的按钮）可能在
       * 本插件代码块还在下载时就查询可用性，早发布能让按钮立即变为可用。
       * 浮窗本体要等代码块到位后才注册，服务只是开关，不依赖它们。
       */
      const floatingStore = createFlagStore(false);
      ctx.provide('videoFrameViewer', {
        open() {
          floatingStore.set(true);
          return true;
        },
        close() {
          floatingStore.set(false);
        },
        toggle() {
          floatingStore.set(!floatingStore.getSnapshot());
        },
        isOpen() {
          return floatingStore.getSnapshot();
        },
        subscribe: floatingStore.subscribe,
      });

      const mods = await chunks;
      const view = mods.view.createView({
        css: mods.styles.css,
        mp4: mods.mp4,
        helpers: mods.playback,
        icons: mods.icons,
        strip: mods.strip,
      });
      const floating = mods.window.createWindow({
        css: mods.styles.css,
        icons: mods.icons,
        ViewerPanel: view.ViewerPanel,
      });

      /* 样式表：同一页面重复加载时只插一次，卸载时移除。 */
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']');
        if (existing !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = mods.styles.CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'video-frame-viewer: styles');

      ctx.effect(
        () => ctx.locale.register(NS, { zh: mods.dicts.zh, en: mods.dicts.en }),
        'video-frame-viewer: dictionaries',
      );
      const t = ctx.locale.bind(NS);

      /*
       * 侧边栏图标：id 就是 main 的 key。侧边栏点击时调用 layout.selectPanel(id)，
       * 主面板槽位按同一个 key 找到这里的整页组件。
       */
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('panel.title'),
      }, mods.icons.PanelIcon)), 'video-frame-viewer: sidebar row');

      /* 整页主面板。 */
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, view.ViewerPanel)), 'video-frame-viewer: main panel');

      /*
       * 浮窗注册在 `shell.overlay` 上，与调用方所在面板的生死无关 ——
       * 用户切走面板时窗口不会被连带卸载；插件卸载时条目随 effect 自动移除。
       */
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'video-frame-viewer.float',
        order: 30,
        label: () => t('panel.title'),
        locale: NS,
        inject: () => ({ store: floatingStore }),
      }, floating.FloatingViewer)), 'video-frame-viewer: floating window');
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
