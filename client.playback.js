/**
 * 视频逐帧查看 — 播放辅助函数。
 *
 * 这里放与 React 无关的浏览器小工具：
 *   - 时间/文件大小格式化；
 *   - 等 <video> 真正画出目标帧；
 *   - 用 rVFC 实测帧率（精确索引失败时兜底）。
 *
 * 加载方式：入口 client.js 通过 require.async('./client.playback.js') 取得本块，
 * 再把返回的函数注入视图块。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.playback.js',
  factory() {
    /**
     * 把秒数格式化成 mm:ss.mmm；超过一小时自动补上小时位。
     * @param {number} seconds - 秒数。
     * @param {boolean} withMs - 是否显示毫秒，默认显示。
     * @returns {string} 时间文本。
     */
    function formatTime(seconds, withMs = true) {
      if (!Number.isFinite(seconds) || seconds < 0) return withMs ? '00:00.000' : '00:00';
      const whole = Math.floor(seconds);
      const millis = Math.min(999, Math.floor((seconds - whole) * 1000));
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const secs = whole % 60;
      const pad = (value, width = 2) => String(value).padStart(width, '0');
      const clock = hours > 0
        ? `${hours}:${pad(minutes)}:${pad(secs)}`
        : `${pad(minutes)}:${pad(secs)}`;
      return withMs ? `${clock}.${pad(millis, 3)}` : clock;
    }

    /**
     * 文件大小的人类可读写法。
     * @param {number} bytes - 字节数。
     * @returns {string} 例如 12.4 MB。
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    /**
     * 等浏览器把新的一帧画到合成器上。
     *
     * `seeked` 触发时新的画面已经可用，再等一个 rAF 就足以让合成器取到它；
     * 不在这里用 rVFC 等「下一帧」——暂停时它可能迟迟不触发，翻帧会明显变慢。
     * @returns {Promise<void>} 下一帧显示周期后完成。
     */
    function nextPaint() {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(finish, 120);
        let raf = null;
        if (typeof requestAnimationFrame === 'function') {
          raf = requestAnimationFrame(() => finish());
        } else {
          setTimeout(finish, 16);
        }
        function finish() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          resolve();
        }
      });
    }

    /**
     * 把 <video> 定位到指定时间，并等画面真正更新。
     * @param {HTMLVideoElement} video - 视频元素。
     * @param {number} target - 目标时间（秒）。
     * @returns {Promise<void>} 画面更新后完成；超时也会完成，避免界面卡死。
     */
    function seekToTime(video, target) {
      return new Promise((resolve) => {
        if (!video || video.readyState < 1) {
          resolve();
          return;
        }
        const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.0005) : target;
        const time = Math.max(0, Math.min(target, max));
        let settled = false;
        let timer = null;
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          nextPaint().then(finish);
        };
        function finish() {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          video.removeEventListener('seeked', onSeeked);
          resolve();
        }
        if (Math.abs(video.currentTime - time) < 0.0002) {
          nextPaint().then(finish);
          return;
        }
        video.addEventListener('seeked', onSeeked);
        timer = setTimeout(finish, 1000);
        try {
          video.currentTime = time;
        } catch {
          finish();
        }
      });
    }

    /**
     * 等 <video> 有可绘制的尺寸。
     * @param {HTMLVideoElement} video - 视频元素。
     * @param {number} timeoutMs - 最长等待时间。
     * @returns {Promise<boolean>} 是否可用。
     */
    function ensureVideoData(video, timeoutMs = 2000) {
      if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(finish, timeoutMs);
        function finish() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('loadeddata', finish);
          resolve(video.readyState >= 2 && video.videoWidth > 0);
        }
        video.addEventListener('loadeddata', finish);
      });
    }

    /**
     * 解析失败时实测帧率：静音播放一小段，收集 rVFC 的 mediaTime 间隔。
     * 只在 moov 解析失败时使用，结束后恢复原时间、静音与倍速。
     * @param {HTMLVideoElement} video - 主视频元素。
     * @returns {Promise<null|number>} 实测帧率，或 null。
     */
    function probeFrameRate(video) {
      return new Promise((resolve) => {
        if (!video || typeof video.requestVideoFrameCallback !== 'function' || video.readyState < 2) {
          resolve(null);
          return;
        }
        const wasTime = video.currentTime;
        const wasMuted = video.muted;
        const wasRate = video.playbackRate;
        const samples = [];
        const qualityStart = typeof video.getVideoPlaybackQuality === 'function'
          ? video.getVideoPlaybackQuality()
          : null;
        const realStart = performance.now();
        let finished = false;
        let callbackId = null;
        const timer = setTimeout(finish, 1600);
        function cleanup() {
          clearTimeout(timer);
          if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
            try {
              video.cancelVideoFrameCallback(callbackId);
            } catch {
              /* 忽略取消失败。 */
            }
          }
        }
        /**
         * 恢复播放前的现场，并等 seek 真正完成再 resolve。
         *
         * 如果不等这个 seek，调用方会拿一个还在播放中间的时间去铺时间轴，
         * 用户会看到「刚打开就停在第 4 帧」这种瞬时错位。
         */
        function restore() {
          video.pause();
          video.muted = wasMuted;
          video.playbackRate = wasRate;
          return new Promise((done) => {
            if (!Number.isFinite(wasTime) || Math.abs(video.currentTime - wasTime) < 0.001) {
              done();
              return;
            }
            let settled = false;
            const waitTimer = setTimeout(finishRestore, 400);
            function finishRestore() {
              if (settled) return;
              settled = true;
              clearTimeout(waitTimer);
              video.removeEventListener('seeked', finishRestore);
              done();
            }
            video.addEventListener('seeked', finishRestore, { once: true });
            try {
              video.currentTime = wasTime;
            } catch {
              /* 有些解码器在末尾会拒绝 seek，忽略即可。 */
              finishRestore();
            }
          });
        }
        function finish() {
          if (finished) return;
          finished = true;
          cleanup();
          const deltas = [];
          for (let index = 1; index < samples.length; index += 1) {
            const delta = samples[index] - samples[index - 1];
            if (delta > 0.002 && delta < 1) deltas.push(delta);
          }
          let fps = null;
          /*
           * 优先用 totalVideoFrames / 真实耗时。它统计的是「显示 + 丢弃」的帧，
           * 在无头/弱机器上 rVFC 只回调一半帧时仍是源帧率；rVFC 的 mediaTime 间隔
           * 只能拿来兜底。
           */
          if (qualityStart !== null && typeof video.getVideoPlaybackQuality === 'function') {
            const qualityEnd = video.getVideoPlaybackQuality();
            const elapsedReal = (performance.now() - realStart) / 1000;
            const frames = qualityEnd.totalVideoFrames - qualityStart.totalVideoFrames;
            if (elapsedReal > 0.2 && frames >= 3) {
              const measured = frames / elapsedReal;
              if (Number.isFinite(measured) && measured >= 1 && measured <= 240) {
                fps = Math.round(measured * 100) / 100;
              }
            }
          }
          if (fps === null && deltas.length >= 2) {
            deltas.sort((a, b) => a - b);
            const median = deltas[deltas.length >> 1];
            const measured = 1 / median;
            if (Number.isFinite(measured) && measured >= 1 && measured <= 240) {
              fps = Math.round(measured * 100) / 100;
            }
          }
          restore().then(() => resolve(fps));
        }
        function onFrame(_now, metadata) {
          if (finished) return;
          if (Number.isFinite(metadata.mediaTime)) samples.push(metadata.mediaTime);
          if (samples.length >= 9) {
            finish();
            return;
          }
          callbackId = video.requestVideoFrameCallback(onFrame);
        }
        video.muted = true;
        video.playbackRate = 1;
        callbackId = video.requestVideoFrameCallback(onFrame);
        const attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') {
          attempt.catch(() => {
            if (finished) return;
            finished = true;
            cleanup();
            restore().then(() => resolve(null));
          });
        }
      });
    }

    return { formatTime, formatBytes, seekToTime, ensureVideoData, probeFrameRate };
  },
});
