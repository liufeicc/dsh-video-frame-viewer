/**
 * MP4 帧时间轴解析 — 浏览器端分块读取。
 *
 * 为什么需要它：<video> 只暴露 `duration`，不告诉你有多少帧、帧率是多少。
 * 要做到「精确逐帧」，必须知道每一帧的呈现时间。浏览器 seek 到某一帧的
 * 时间戳后会精确显示那一帧，所以本模块的目标就是把「帧号 → 时间戳」算出来。
 *
 * 读取策略（不把整个视频读进内存）：
 *   1. 按 16 字节的盒子头在文件里逐个跳过顶层 box，mdat 只读头部的 size/type，
 *      真正读取的只有 moov（索引区，通常几十 KB 到几 MB）；
 *   2. 在 moov 里找到 handler = 'vide' 的 trak；
 *   3. 读 mdhd（时间刻度）、stts（每个 sample 的时长）、ctts（B 帧的呈现偏移）；
 *   4. 展开成每个 sample 的 DTS，加上 ctts 偏移得到 PTS，按呈现顺序排序并归一化到 0；
 *   5. 用最常见的 stts 时长算出真实帧率，并标记 VFR。
 *
 * 分片 MP4（moov 里没有 stts，帧信息在 moof/traf/trun）这里不处理：
 * 调用方会退回 <video> 实测帧率，并在界面上标明「估算」。
 *
 * 本文件是 DSH 的「包内代码块」，入口 client.js 通过 require.async 加载。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.mp4.js',
  factory() {
    /** moov 最大读取量：超过这个尺寸就不硬读，退回实测帧率。 */
    const MAX_MOOV_BYTES = 128 * 1024 * 1024;
    /** 单条视频最多接受的帧数，防止畸形文件把浏览器内存撑爆。 */
    const MAX_FRAMES = 3_000_000;
    /** stts 条目数的上限；正常视频通常只有几条到几百条。 */
    const MAX_STTS_ENTRIES = 2_000_000;

    /**
     * 读一个 4 字节 FourCC。
     * @param {DataView} view - 所在缓冲区。
     * @param {number} offset - 起始字节。
     * @returns {string} 四个 ASCII 字符。
     */
    function fourcc(view, offset) {
      return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
      );
    }

    /**
     * 读 64 位无符号整数。MP4 的 size 可能超过 2^32，用 hi/lo 拼。
     * @param {DataView} view - 所在缓冲区。
     * @param {number} offset - 起始字节。
     * @returns {number} 数值（超过 2^53 时精度会损失，但文件尺寸不会到那里）。
     */
    function readUint64(view, offset) {
      return view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4);
    }

    /**
     * 读一个 MP4 盒子头。
     * @param {Blob} blob - 视频文件。
     * @param {number} offset - 盒子起始位置。
     * @returns {Promise<null | {offset:number,size:number,headerSize:number,type:string,dataStart:number,end:number}>} 盒子头；读不出时 null。
     */
    async function readBoxHeader(blob, offset) {
      if (offset < 0 || offset + 8 > blob.size) return null;
      const bytes = new Uint8Array(await blob.slice(offset, offset + 16).arrayBuffer());
      if (bytes.length < 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let size = view.getUint32(0);
      const type = fourcc(view, 4);
      let headerSize = 8;
      if (size === 1) {
        if (bytes.length < 16) return null;
        size = readUint64(view, 8);
        headerSize = 16;
      } else if (size === 0) {
        size = blob.size - offset;
      }
      if (!Number.isFinite(size) || size < headerSize) return null;
      return { offset, size, headerSize, type, dataStart: offset + headerSize, end: offset + size };
    }

    /**
     * 扫顶层盒子，找到 ftyp 与 moov。
     * @param {Blob} blob - 视频文件。
     * @returns {Promise<{isMp4:boolean,moov:null|object,reason?:string}>} 扫描结果。
     */
    async function scanTopLevel(blob) {
      let offset = 0;
      let isMp4 = false;
      let sawMoov = false;
      while (offset + 8 <= blob.size) {
        const box = await readBoxHeader(blob, offset);
        if (box === null) return { isMp4, moov: null, reason: 'invalid-box' };
        if (box.type === 'ftyp') isMp4 = true;
        if (box.type === 'moov') {
          sawMoov = true;
          isMp4 = true;
          if (box.size > MAX_MOOV_BYTES) return { isMp4, moov: null, reason: 'moov-too-large' };
          return { isMp4, moov: box };
        }
        if (box.type === 'moof' && !sawMoov) {
          /*
           * 分片 MP4 的 moof 会排在 moov 前面。不在这里中断：有些文件后面仍有
           * 一个带 stts 的 moov（或至少带 track 信息），继续扫可能还能用；
           * 真到文件末尾也没有 moov 时再按分片处理。
           */
        }
        const next = offset + box.size;
        if (next <= offset || next > blob.size) return { isMp4, moov: null, reason: 'invalid-box' };
        offset = next;
      }
      return { isMp4, moov: null, reason: sawMoov ? 'no-video' : 'fragmented-or-no-moov' };
    }

    /**
     * 把一段缓冲区里的同级盒子列出来。用于在 moov 内部逐层下钻。
     * @param {DataView} view - 缓冲区视图。
     * @param {number} start - 起始字节（相对缓冲区）。
     * @param {number} end - 结束字节。
     * @returns {Array<{type:string,start:number,dataStart:number,end:number,header:number}>} 盒子列表。
     */
    function parseBoxes(view, start, end) {
      const out = [];
      let offset = start;
      while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = fourcc(view, offset + 4);
        let header = 8;
        if (size === 1) {
          if (offset + 16 > end) break;
          size = readUint64(view, offset + 8);
          header = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < header || offset + size > end) break;
        out.push({ type, start: offset, dataStart: offset + header, end: offset + size, header });
        offset += size;
      }
      return out;
    }

    /**
     * 在父盒子里找第一个指定类型的子盒子。
     * @param {DataView} view - 缓冲区视图。
     * @param {object} parent - 父盒子。
     * @param {string} type - 子盒子类型。
     * @returns {object|undefined} 子盒子。
     */
    function childOf(view, parent, type) {
      const boxes = parseBoxes(view, parent.dataStart, parent.end);
      return boxes.find((box) => box.type === type);
    }

    /**
     * 读 mdhd：媒体时间刻度与时长。
     * @param {DataView} view - 缓冲区视图。
     * @param {object} box - mdhd 盒子。
     * @returns {{timescale:number,duration:number}} 时间刻度与时长（媒体单位）。
     */
    function parseMdhd(view, box) {
      const version = view.getUint8(box.dataStart);
      const base = box.dataStart;
      if (version === 1) {
        if (base + 32 > box.end) throw new Error('mdhd truncated');
        return {
          timescale: view.getUint32(base + 20),
          duration: readUint64(view, base + 24),
        };
      }
      if (base + 20 > box.end) throw new Error('mdhd truncated');
      return {
        timescale: view.getUint32(base + 12),
        duration: view.getUint32(base + 16),
      };
    }

    /**
     * 读 stts（time-to-sample）：每个 sample 的持续时间。
     * @param {DataView} view - 缓冲区视图。
     * @param {object} box - stts 盒子。
     * @returns {{entries:Array<[number,number]>,total:number}} [数量, 单位时长] 列表与总帧数。
     */
    function parseStts(view, box) {
      const count = view.getUint32(box.dataStart + 4);
      if (count > MAX_STTS_ENTRIES) throw new Error('stts too large');
      const entries = [];
      let total = 0;
      let p = box.dataStart + 8;
      for (let index = 0; index < count; index += 1) {
        if (p + 8 > box.end) throw new Error('stts truncated');
        const run = view.getUint32(p);
        const delta = view.getUint32(p + 4);
        p += 8;
        if (run === 0 || delta === 0) continue;
        total += run;
        if (total > MAX_FRAMES) throw new Error('too many frames');
        entries.push([run, delta]);
      }
      if (total === 0) throw new Error('empty stts');
      return { entries, total };
    }

    /**
     * 读 ctts（composition time offset）：B 帧的呈现时间偏移。
     * @param {DataView} view - 缓冲区视图。
     * @param {object} box - ctts 盒子。
     * @param {number} total - sample 总数。
     * @returns {Float64Array|null} 每个 sample 的呈现偏移；没有偏移时 null。
     */
    function parseCtts(view, box, total) {
      const version = view.getUint8(box.dataStart);
      const count = view.getUint32(box.dataStart + 4);
      if (count > MAX_STTS_ENTRIES) throw new Error('ctts too large');
      const offsets = new Float64Array(total);
      let p = box.dataStart + 8;
      let cursor = 0;
      let nonZero = false;
      for (let index = 0; index < count; index += 1) {
        if (p + 8 > box.end) throw new Error('ctts truncated');
        const run = view.getUint32(p);
        const raw = view.getUint32(p + 4);
        const offset = version === 1 ? view.getInt32(p + 4) : raw;
        p += 8;
        if (run === 0) continue;
        if (cursor + run > total) throw new Error('ctts overflows samples');
        if (offset !== 0) nonZero = true;
        offsets.fill(offset, cursor, cursor + run);
        cursor += run;
      }
      if (cursor !== total) throw new Error('ctts sample count mismatch');
      return nonZero ? offsets : null;
    }

    /**
     * 把 stts 展开成每个 sample 的 DTS。
     * @param {{entries:Array<[number,number]>,total:number}} stts - 解析结果。
     * @returns {Float64Array} 每个 sample 的开始时间（媒体单位）。
     */
    function expandDts(stts) {
      const starts = new Float64Array(stts.total);
      let cursor = 0;
      let time = 0;
      for (const [run, delta] of stts.entries) {
        for (let index = 0; index < run; index += 1) {
          starts[cursor] = time;
          cursor += 1;
          time += delta;
        }
      }
      return starts;
    }

    /**
     * 最常见的 stts 时长 → 帧率。
     * @param {{entries:Array<[number,number]>,total:number}} stts - 解析结果。
     * @param {number} timescale - 媒体时间刻度。
     * @returns {{fps:number,variable:boolean}} 帧率与是否 VFR。
     */
    function rateOf(stts, timescale) {
      let bestRun = 0;
      let bestDelta = 0;
      for (const [run, delta] of stts.entries) {
        if (run > bestRun) {
          bestRun = run;
          bestDelta = delta;
        }
      }
      const fps = bestDelta > 0 ? timescale / bestDelta : 0;
      const variable = bestRun / stts.total < 0.9;
      return { fps, variable };
    }

    /**
     * 把帧率写成便于显示的形式。
     * @param {number} fps - 帧率。
     * @returns {string} 30、29.97、59.94 这样的文本。
     */
    function fpsText(fps) {
      if (!Number.isFinite(fps) || fps <= 0) return '?';
      const rounded = Math.round(fps);
      if (Math.abs(fps - rounded) < 0.02) return String(rounded);
      return String(Number(fps.toFixed(2)));
    }

    /**
     * 从 moov 中解析出视频轨的帧时间轴。
     * @param {ArrayBuffer} buffer - moov 完整字节（包含盒子头）。
     * @param {number} boxStart - moov 在 buffer 中的起始位置。
     * @param {number} boxSize - moov 的字节数。
     * @returns {object} 时间轴信息。
     */
    function parseMoov(buffer, boxStart, boxSize) {
      const view = new DataView(buffer);
      /*
       * 顶层 moov 可能是 16 字节头（size==1）。这里从 buffer 的第一层重新解析，
       * 直接把 moov 当作父盒子，避免把头部长度写死。
       */
      const top = parseBoxes(view, boxStart, boxStart + boxSize)[0];
      if (top === undefined || top.type !== 'moov') throw new Error('not moov');
      const traks = parseBoxes(view, top.dataStart, top.end).filter((box) => box.type === 'trak');
      let lastReason = 'no-video';
      for (const trak of traks) {
        const mdia = childOf(view, trak, 'mdia');
        if (mdia === undefined) continue;
        const hdlr = childOf(view, mdia, 'hdlr');
        if (hdlr === undefined || hdlr.dataStart + 12 > hdlr.end) continue;
        if (fourcc(view, hdlr.dataStart + 8) !== 'vide') continue;
        const mdhd = childOf(view, mdia, 'mdhd');
        const minf = childOf(view, mdia, 'minf');
        const stbl = minf === undefined ? undefined : childOf(view, minf, 'stbl');
        if (mdhd === undefined || stbl === undefined) {
          lastReason = 'no-track-index';
          continue;
        }
        const stts = childOf(view, stbl, 'stts');
        if (stts === undefined) {
          lastReason = 'fragmented';
          continue;
        }
        const meta = parseMdhd(view, mdhd);
        if (!Number.isFinite(meta.timescale) || meta.timescale <= 0) {
          lastReason = 'bad-timescale';
          continue;
        }
        const samples = parseStts(view, stts);
        const ctts = childOf(view, stbl, 'ctts');
        const offsets = ctts === undefined ? null : parseCtts(view, ctts, samples.total);
        const dts = expandDts(samples);
        const { fps, variable } = rateOf(samples, meta.timescale);

        let points;
        if (offsets === null) {
          points = dts;
        } else {
          points = new Float64Array(samples.total);
          for (let index = 0; index < samples.total; index += 1) {
            points[index] = dts[index] + offsets[index];
          }
          points.sort();
        }

        /*
         * B 帧的 PTS 排序后可能出现重复（同一呈现时刻的多份 sample）。
         * 对逐帧查看来说重复时间戳没有意义，按 0.5 个时间单位合并。
         */
        let unique = 0;
        const merged = new Float64Array(points.length);
        for (let index = 0; index < points.length; index += 1) {
          const value = points[index];
          if (unique === 0 || value - merged[unique - 1] > 0.5) {
            merged[unique] = value;
            unique += 1;
          }
        }
        if (unique === 0) throw new Error('no frames');
        const base = merged[0];
        const times = new Float64Array(unique);
        for (let index = 0; index < unique; index += 1) {
          times[index] = (merged[index] - base) / meta.timescale;
        }
        const duration = dts.length === 0
          ? 0
          : (dts[dts.length - 1] + samples.entries[samples.entries.length - 1][1]) / meta.timescale;

        return {
          ok: true,
          exact: true,
          times,
          frameCount: unique,
          fps,
          fpsLabel: variable ? 'VFR' : fpsText(fps),
          variable,
          duration,
          timescale: meta.timescale,
          source: 'moov',
        };
      }
      return { ok: false, reason: lastReason };
    }

    /**
     * 解析一个本地 MP4 文件，得到精确帧时间轴。
     * @param {Blob} blob - 视频文件。
     * @returns {Promise<object>} `{ok:true,...timeline}` 或 `{ok:false,reason}`。
     */
    async function readMp4Timeline(blob) {
      if (!(blob instanceof Blob) || blob.size < 16) return { ok: false, reason: 'empty' };
      try {
        const scan = await scanTopLevel(blob);
        if (scan.moov === null) {
          return { ok: false, reason: scan.isMp4 ? (scan.reason || 'no-moov') : 'not-mp4' };
        }
        const moov = scan.moov;
        const buffer = await blob.slice(moov.offset, moov.offset + moov.size).arrayBuffer();
        return parseMoov(buffer, 0, moov.size);
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    /**
     * 解析失败时的兜底时间轴：按固定帧率均匀铺开，界面上会标「估算」。
     * @param {number} duration - 视频时长（秒）。
     * @param {number} fps - 估算帧率。
     * @returns {object} 时间轴。
     */
    function buildFallbackTimeline(duration, fps) {
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      const safeFps = Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : 30;
      const frameCount = Math.max(1, Math.round(safeDuration * safeFps) || 1);
      const times = new Float64Array(frameCount);
      for (let index = 0; index < frameCount; index += 1) {
        times[index] = Math.min(index / safeFps, Math.max(0, safeDuration - 0.000001));
      }
      return {
        ok: true,
        exact: false,
        times,
        frameCount,
        fps: safeFps,
        fpsLabel: '~' + fpsText(safeFps),
        variable: false,
        duration: safeDuration,
        source: 'estimated',
      };
    }

    /**
     * 用二分查找当前时间对应的帧号。
     * @param {{times:Float64Array}} timeline - 时间轴。
     * @param {number} time - 当前播放时间（秒）。
     * @returns {number} 帧号（从 0 开始）。
     */
    function indexAtTime(timeline, time) {
      const times = timeline.times;
      if (times.length === 0) return 0;
      let low = 0;
      let high = times.length - 1;
      let answer = 0;
      const target = time + 1e-6;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (times[middle] <= target) {
          answer = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return answer;
    }

    return {
      readMp4Timeline,
      buildFallbackTimeline,
      indexAtTime,
      fpsText,
    };
  },
});
