/**
 * MP4 帧时间轴解析单测。
 *
 * 直接读取浏览器代码块 `client.mp4.js`，用一个假的 window.__ModuleLoader__
 * 接住 factory 的返回值，所以在 Node 里测的就是浏览器实际跑的同一份代码。
 *
 * 样例由 ffmpeg 生成（testsrc2 + libx264），期望值来自 ffprobe：
 *   - h264-30fps.mp4            30fps / 60 帧 / 带 B 帧与音轨
 *   - h264-2997.mp4             30000/1001 fps / 90 帧 / 带 B 帧
 *   - h264-25fps-faststart.mp4  25fps / 50 帧 / moov 前置
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const chunkPath = new URL('../client.mp4.js', import.meta.url);

let apiPromise;

/** 在沙箱里执行代码块，拿回它导出的解析 API。 */
function loadApi() {
  if (apiPromise === undefined) {
    apiPromise = (async () => {
      const code = await readFile(chunkPath, 'utf8');
      let api;
      const sandbox = {
        window: {
          __ModuleLoader__: {
            load(definition) {
              api = definition.factory();
            },
          },
        },
        Blob,
        console,
      };
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox, { filename: 'client.mp4.js' });
      if (api === undefined) throw new Error('client.mp4.js 没有注册 factory');
      return api;
    })();
  }
  return apiPromise;
}

/** 读取样例并解析。 */
async function parseFixture(name) {
  const api = await loadApi();
  const buffer = await readFile(new URL('./fixtures/' + name, import.meta.url));
  const timeline = await api.readMp4Timeline(new Blob([buffer]));
  return { api, timeline };
}

test('30fps + B 帧：帧数、帧率、首帧与相邻帧时间戳', async () => {
  const { api, timeline } = await parseFixture('h264-30fps.mp4');
  assert.equal(timeline.ok, true, '应解析成功');
  assert.equal(timeline.exact, true);
  assert.equal(timeline.frameCount, 60, 'ffprobe 报告 60 帧');
  assert.ok(Math.abs(timeline.fps - 30) < 0.01, '帧率应为 30');
  assert.equal(timeline.fpsLabel, '30');
  assert.equal(timeline.times[0], 0, '首帧归一到 0');
  for (let index = 1; index < 10; index += 1) {
    const delta = timeline.times[index] - timeline.times[index - 1];
    assert.ok(delta > 0.032 && delta < 0.034, `第 ${index} 帧间隔应约 1/30 秒，实际 ${delta}`);
  }
  assert.equal(api.indexAtTime(timeline, 0), 0);
  assert.equal(api.indexAtTime(timeline, timeline.times[29] + 0.001), 29);
  assert.equal(api.indexAtTime(timeline, timeline.times[30] - 0.001), 29);
  assert.equal(api.indexAtTime(timeline, 999), 59, '超出末帧时夹到最后一帧');
});

test('29.97fps：非整数帧率与 90 帧', async () => {
  const { timeline } = await parseFixture('h264-2997.mp4');
  assert.equal(timeline.ok, true);
  assert.equal(timeline.frameCount, 90);
  assert.ok(Math.abs(timeline.fps - 29.97002997) < 0.001, `实际帧率 ${timeline.fps}`);
  assert.equal(timeline.fpsLabel, '29.97');
  assert.ok(timeline.duration > 2.99 && timeline.duration < 3.02, `时长 ${timeline.duration}`);
});

test('moov 前置（faststart）+ 25fps', async () => {
  const { timeline } = await parseFixture('h264-25fps-faststart.mp4');
  assert.equal(timeline.ok, true);
  assert.equal(timeline.frameCount, 50);
  assert.ok(Math.abs(timeline.fps - 25) < 0.01);
  assert.equal(timeline.fpsLabel, '25');
  assert.ok(Math.abs(timeline.times[49] - 49 / 25) < 0.001, '末帧时间戳');
});

test('非 MP4 数据返回 not-mp4，而不是抛错', async () => {
  const api = await loadApi();
  const result = await api.readMp4Timeline(new Blob([Buffer.from('not an mp4 file at all, just text')]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-mp4');
});

test('兜底时间轴可按任意帧率铺开', async () => {
  const api = await loadApi();
  const timeline = api.buildFallbackTimeline(2, 25);
  assert.equal(timeline.ok, true);
  assert.equal(timeline.exact, false);
  assert.equal(timeline.frameCount, 50);
  assert.equal(timeline.fpsLabel, '~25');
  assert.equal(timeline.times[10], 10 / 25);
});

test('样例文件路径存在（防止测试静默通过）', async () => {
  const buffer = await readFile(new URL('./fixtures/h264-30fps.mp4', import.meta.url));
  assert.ok(buffer.length > 1000, '样例应有实际内容');
  assert.ok(here.endsWith('/test/'));
});
