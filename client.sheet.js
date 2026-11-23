/**
 * 视频逐帧查看 — 抓帧池与拼图块。
 *
 * 两件事共用同一组隐藏 <video>：
 *   1. 帧胶片缩略图（由 client.strip.js 调用 `captureDataUrl`）；
 *   2. 复制当前帧/多选拼图（由 client.view.js 调用 `copyFramesToClipboard`）。
 *
 * 抓一帧要「seek → 等解码器从最近关键帧解到目标帧 → 等画面更新 → 画到
 * canvas」，所以这里维持 3 个隐藏 video 并行干活；任意时刻最多 3 个 seek，
 * 其余排队。缩略图和拼图共用这个池，不会各自再开一份解码器。
 *
 * 拼图布局按视频比例动态算列数，目标是接近 16:9、总宽不超过 2400px、
 * 总高不超过 4000px；每格左下角标帧号，帧按传入顺序（调用方保证是
 * 帧号升序）从左到右、从上到下排列。
 *
 * 加载方式：入口 client.js 用 require.async('./client.sheet.js') 取得本块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.sheet.js',
  factory() {
    /** 同时抓帧的隐藏 video 数量。 */
    const WORKERS = 3;
    /** 拼图单元格之间的留白（像素）。 */
    const SHEET_GAP = 8;
    /** 拼图总宽上限（像素）。 */
    const SHEET_MAX_WIDTH = 2400;
    /** 拼图总高上限（像素）。 */
    const SHEET_MAX_HEIGHT = 4000;
    /** 单元格最大/最小宽度。 */
    const SHEET_MAX_CELL = 360;
    const SHEET_MIN_CELL = 120;
    /** 一屏最多多少列。 */
    const SHEET_MAX_COLUMNS = 16;
    /** 拼图背景色（与播放器舞台一致）。 */
    const SHEET_BG = '#0b0d12';

    /**
     * 把 canvas 转成 PNG Blob。
     * @param {HTMLCanvasElement} canvas - 来源画布。
     * @returns {Promise<Blob|null>} PNG；失败时 null。
     */
    function canvasToPng(canvas) {
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    }

    /**
     * 创建一个帧抓取器。
     *
     * 它只管「池」和「抓一帧」，不知道缩略图、拼图或剪贴板；调用方决定
     * 抓下来是变成 data URL 还是画进大图。池中的 video 由调用方渲染并用
     * `attach(index, node)` 挂上来。
     *
     * @param {{helpers: {seekToTime: Function, ensureVideoData: Function}}} deps -
     *   播放辅助函数。
     * @returns {object} 抓取器：`workerCount`、`attach`、`captureCanvas`、`captureDataUrl`。
     */
    function createFrameGrabber({ helpers }) {
      const { seekToTime, ensureVideoData } = helpers;
      const videos = new Array(WORKERS).fill(null);
      const busy = new Array(WORKERS).fill(false);
      const waiters = [];

      /**
       * 借一个空闲 video；全忙时排队。
       * @returns {Promise<number>} 池下标。
       */
      function acquire() {
        return new Promise((resolve) => {
          for (let index = 0; index < WORKERS; index += 1) {
            if (!busy[index] && videos[index] !== null) {
              busy[index] = true;
              resolve(index);
              return;
            }
          }
          waiters.push(resolve);
        });
      }

      /**
       * 归还一个 video；有排队者时直接移交。
       * @param {number} index - 池下标。
       */
      function release(index) {
        const next = waiters.shift();
        if (next !== undefined) {
          next(index);
          return;
        }
        busy[index] = false;
      }

      /**
       * 抓一帧并画到指定宽度的 canvas 上。
       * @param {number} time - 目标时间（秒）。
       * @param {number} width - 输出宽度（像素）；高度按视频比例算。
       * @returns {Promise<HTMLCanvasElement|null>} 画布；失败时 null。
       */
      async function captureCanvas(time, width) {
        const index = await acquire();
        const video = videos[index];
        try {
          if (video === null || video === undefined) return null;
          const ready = await ensureVideoData(video);
          if (!ready) return null;
          const duration = Number.isFinite(video.duration) ? video.duration : time + 0.1;
          const seeked = await seekToTime(video, Math.min(time + 0.0004, Math.max(0, duration - 0.0005)));
          if (!seeked) return null;
          const sourceWidth = video.videoWidth;
          const sourceHeight = video.videoHeight;
          if (!sourceWidth || !sourceHeight) return null;
          const outputWidth = Math.max(2, Math.round(width));
          const canvas = document.createElement('canvas');
          canvas.width = outputWidth;
          canvas.height = Math.max(2, Math.round(outputWidth * sourceHeight / sourceWidth));
          const context = canvas.getContext('2d');
          if (context === null) return null;
          context.imageSmoothingQuality = 'medium';
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          return canvas;
        } finally {
          release(index);
        }
      }

      /**
       * 抓一帧并编码成 JPEG data URL（帧胶片缩略图用）。
       * @param {number} time - 目标时间（秒）。
       * @param {number} width - 输出宽度。
       * @param {number} quality - JPEG 质量。
       * @returns {Promise<string|null>} data URL；失败时 null。
       */
      async function captureDataUrl(time, width, quality) {
        const canvas = await captureCanvas(time, width);
        if (canvas === null) return null;
        const url = canvas.toDataURL('image/jpeg', quality);
        /* 空画布在部分浏览器会得到 "data:,"，不能当缩略图缓存。 */
        return typeof url === 'string' && url.length > 32 ? url : null;
      }

      return {
        workerCount: WORKERS,
        attach(index, node) {
          videos[index] = node;
        },
        captureCanvas,
        captureDataUrl,
      };
    }

    /**
     * 计算拼图布局。
     *
     * 列数按「让总图接近 16:9」推：`columns ≈ sqrt(targetAspect * 单元格高宽比 * 帧数)`。
     * 然后按总宽/总高上限夹取单元格尺寸；帧很多（例如 60fps 一秒 60 帧）时
     * 列数增加而不是无限变高。
     *
     * @param {{count: number, aspect: number}} input - 帧数与视频宽高比。
     * @returns {{columns: number, rows: number, cellWidth: number, cellHeight: number,
     *   width: number, height: number}} 布局。
     */
    function computeSheetLayout({ count, aspect }) {
      const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
      const targetAspect = 16 / 9;
      const columns = Math.max(
        1,
        Math.min(SHEET_MAX_COLUMNS, Math.round(Math.sqrt(targetAspect * (1 / safeAspect) * count))),
      );
      const rows = Math.ceil(count / columns);
      const availableWidth = SHEET_MAX_WIDTH - (columns + 1) * SHEET_GAP;
      let cellWidth = Math.max(SHEET_MIN_CELL, Math.min(SHEET_MAX_CELL, Math.floor(availableWidth / columns)));
      let cellHeight = Math.max(2, Math.round(cellWidth / safeAspect));
      let width = columns * cellWidth + (columns + 1) * SHEET_GAP;
      let height = rows * cellHeight + (rows + 1) * SHEET_GAP;
      if (height > SHEET_MAX_HEIGHT) {
        const scale = SHEET_MAX_HEIGHT / height;
        cellWidth = Math.max(2, Math.round(cellWidth * scale));
        cellHeight = Math.max(2, Math.round(cellHeight * scale));
        width = columns * cellWidth + (columns + 1) * SHEET_GAP;
        height = rows * cellHeight + (rows + 1) * SHEET_GAP;
      }
      return { columns, rows, cellWidth, cellHeight, width, height };
    }

    /**
     * 把一组帧按时间顺序拼成一张大图。
     *
     * 抓帧用 3 路并行，结果按原顺序放进 `cells`，再按从左到右、从上到下
     * 绘制；每格左下角标帧号（从 1 开始，和界面一致）。
     *
     * @param {{grabber: object, frames: number[], times: Float64Array, aspect: number}} input -
     *   抓取器、升序帧号、帧时间轴与视频宽高比。
     * @returns {Promise<Blob|null>} PNG；失败时 null。
     */
    async function buildContactSheet({ grabber, frames, times, aspect }) {
      if (!Array.isArray(frames) || frames.length === 0) return null;
      const count = frames.length;
      const layout = computeSheetLayout({ count, aspect });
      const cells = new Array(count);
      let cursor = 0;
      const worker = async () => {
        while (cursor < count) {
          const index = cursor;
          cursor += 1;
          const time = times[frames[index]];
          if (!Number.isFinite(time)) return null;
          cells[index] = await grabber.captureCanvas(time, layout.cellWidth);
        }
        return null;
      };
      await Promise.all(
        Array.from({ length: Math.min(grabber.workerCount, count) }, () => worker()),
      );
      if (cells.some((cell) => cell === null || cell === undefined)) return null;

      const canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      const context = canvas.getContext('2d');
      if (context === null) return null;
      context.fillStyle = SHEET_BG;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const fontSize = Math.max(10, Math.round(layout.cellWidth * 0.055));
      context.font = `600 ${fontSize}px "Noto Sans CJK SC", "PingFang SC", system-ui, sans-serif`;
      context.textBaseline = 'alphabetic';
      for (let index = 0; index < count; index += 1) {
        const column = index % layout.columns;
        const row = Math.floor(index / layout.columns);
        const x = SHEET_GAP + column * (layout.cellWidth + SHEET_GAP);
        const y = SHEET_GAP + row * (layout.cellHeight + SHEET_GAP);
        context.drawImage(cells[index], x, y, layout.cellWidth, layout.cellHeight);
        const label = String(frames[index] + 1);
        const textWidth = context.measureText(label).width;
        const padding = Math.max(4, Math.round(fontSize * 0.35));
        const boxWidth = textWidth + padding * 2;
        const boxHeight = fontSize + padding * 2;
        context.fillStyle = 'rgba(7,9,13,.74)';
        context.fillRect(x + 4, y + layout.cellHeight - boxHeight - 4, boxWidth, boxHeight);
        context.fillStyle = '#ffffff';
        context.fillText(label, x + 4 + padding, y + layout.cellHeight - boxHeight - 4 + padding + fontSize * 0.82);
      }
      return canvasToPng(canvas);
    }

    /**
     * 从主播放器的当前画面抓一帧（不经过隐藏 video，最快）。
     * @param {HTMLVideoElement} video - 主视频元素。
     * @returns {Promise<Blob|null>} PNG；失败时 null。
     */
    async function captureFromVideo(video) {
      if (!video || !video.videoWidth || !video.videoHeight) return null;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (context === null) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvasToPng(canvas);
    }

    /**
     * 复制帧到系统剪贴板。
     *
     * 三种情况：
     *   - `frames` 为空：复制主播放器的当前帧（原始分辨率）；
     *   - `frames` 只有 1 帧：从隐藏 video 精确抓取那一帧（原始分辨率）；
     *   - `frames` 多于 1 帧：按帧号升序拼成一张大图。
     *
     * @param {{grabber: object, mainVideo: HTMLVideoElement, times: Float64Array,
     *   frames: number[]|null}} input - 抓取器、主视频、帧时间轴与选中帧。
     * @returns {Promise<{ok: boolean, reason?: string, mode?: string, count?: number}>} 结果。
     */
    async function copyFramesToClipboard({ grabber, mainVideo, times, frames }) {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (typeof ClipboardItem === 'undefined' || clipboard === undefined || typeof clipboard.write !== 'function') {
        return { ok: false, reason: 'unsupported' };
      }
      try {
        let blob;
        let mode = 'single';
        let count = 1;
        if (Array.isArray(frames) && frames.length > 1) {
          mode = 'sheet';
          count = frames.length;
          const aspect = mainVideo.videoWidth / mainVideo.videoHeight;
          blob = await buildContactSheet({ grabber, frames, times, aspect });
        } else if (Array.isArray(frames) && frames.length === 1) {
          count = 1;
          const time = times[frames[0]];
          const canvas = await grabber.captureCanvas(time, mainVideo.videoWidth);
          blob = canvas === null ? null : await canvasToPng(canvas);
        } else {
          blob = await captureFromVideo(mainVideo);
        }
        if (blob === null) return { ok: false, reason: 'failed' };
        await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return { ok: true, mode, count };
      } catch (reason) {
        console.warn('[video-frame-viewer] 复制失败：', reason);
        return { ok: false, reason: 'failed' };
      }
    }

    return {
      createFrameGrabber,
      copyFramesToClipboard,
      buildContactSheet,
      computeSheetLayout,
    };
  },
});