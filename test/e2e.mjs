/**
 * 真实页面 E2E：用 CDP 驱动无头 Chrome。
 *
 * 前置：
 *   1. 一个带 --remote-debugging-port=9222 的 Chrome 已在运行；
 *   2. 环境变量 DSH_WEB_URL 是带鉴权 token 的 Web GUI 地址。
 *
 * 验证内容：
 *   - 左侧图标栏出现「视频逐帧查看」，点击后主区出现整页面板；
 *   - 通过 CDP 给隐藏的 file input 设置一个真实 MP4；
 *   - 精确帧索引加载（60 帧 / 30 fps / 精确）；
 *   - 下一帧、秒视图、双击展开逐帧、单击缩略帧、2× 播放、播放/暂停；
 *   - 截图保存到 test/screenshots/。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
/** 优先用显式给出的 E2E 地址；否则读桌面壳公告的带 token 入口。 */
async function resolveWebUrl() {
  if (process.env.DSH_E2E_URL) return process.env.DSH_E2E_URL;
  try {
    const endpoint = JSON.parse(await readFile(join(homedir(), '.dsh-desktop', 'endpoint.json'), 'utf8'));
    if (typeof endpoint.url === 'string' && endpoint.url !== '') return endpoint.url;
  } catch {
    /* 没有桌面壳时退回 DSH_WEB_URL。 */
  }
  return process.env.DSH_WEB_URL;
}
const WEB_URL = await resolveWebUrl();
const FIXTURE = fileURLToPath(new URL('./fixtures/h264-30fps.mp4', import.meta.url));
const FIXTURE_2997 = fileURLToPath(new URL('./fixtures/h264-2997.mp4', import.meta.url));
const FIXTURE_FRAGMENTED = fileURLToPath(new URL('./fixtures/fragmented-30fps.mp4', import.meta.url));
const SHOT_DIR = fileURLToPath(new URL('./screenshots/', import.meta.url));

if (!WEB_URL) {
  console.error('缺少 DSH_WEB_URL（带鉴权 token 的 GUI 地址）');
  process.exit(2);
}

const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 0;
const pending = new Map();
const listeners = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  const key = (message.sessionId || '') + ':' + message.method;
  const handlers = listeners.get(key);
  if (handlers !== undefined) {
    for (const handler of [...handlers]) handler(message.params);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
  }
};

/** 发送一条 CDP 命令。 */
function send(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
}

/** 等一个 CDP 事件。 */
function waitEvent(method, sessionId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const key = (sessionId || '') + ':' + method;
    const set = listeners.get(key) || new Set();
    const handler = (params) => {
      clearTimeout(timer);
      set.delete(handler);
      resolve(params);
    };
    set.add(handler);
    listeners.set(key, set);
    const timer = setTimeout(() => {
      set.delete(handler);
      reject(new Error('等待事件超时: ' + method));
    }, timeoutMs);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 页面上下文里求值。 */
async function evaluate(expression, sessionId) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error('页面求值失败: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  }
  return result.result.value;
}

/** 轮询直到表达式为真。 */
async function waitFor(expression, sessionId, timeoutMs = 15000, label = expression) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let value;
    try {
      value = await evaluate(expression, sessionId);
    } catch (error) {
      value = undefined;
    }
    if (value) return value;
    await sleep(150);
  }
  throw new Error('等待超时: ' + label);
}

const failures = [];
function check(condition, message, detail) {
  if (condition) {
    console.log('  ✓ ' + message);
  } else {
    failures.push(message + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
    console.log('  ✗ ' + message + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
  }
}

await mkdir(SHOT_DIR, { recursive: true });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('DOM.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);

/*
 * 剪贴板 mock：无头 Chrome 的真实剪贴板写入可能受权限/焦点限制，
 * 这里只替换 navigator.clipboard.write，把写入的 ClipboardItem 记下来，
 * 这样测试能确认真实代码构造出了 image/png，而不是检查 mock 自身。
 */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const calls = [];
    window.__vfvClipboard = calls;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get() {
          return {
            write: async (items) => {
              const record = [];
              for (const item of items) {
                const types = Array.from(item.types || []);
                const blobs = {};
                for (const type of types) {
                  const blob = await item.getType(type);
                  blobs[type] = { size: blob.size, type: blob.type };
                }
                record.push({ types, blobs });
              }
              calls.push(record);
            },
            read: async () => { throw new Error('not mocked'); },
          };
        },
      });
    } catch (error) {
      window.__vfvClipboardError = String(error);
    }
  })();`,
}, sessionId);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
}, sessionId);

/**
 * 把文件塞进当前面板隐藏的 file input。
 * 面板切换会重建 DOM，所以每次都重新查 nodeId，不能复用上一次的。
 * @param {string} path - 本地 MP4 绝对路径。
 */
async function setFile(path) {
  const document = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"][accept*=".mp4"]',
  }, sessionId);
  if (!nodeId) throw new Error('找不到 MP4 文件输入框');
  await send('DOM.setFileInputFiles', { nodeId, files: [path] }, sessionId);
}

const loaded = waitEvent('Page.loadEventFired', sessionId, 20000);
await send('Page.navigate', { url: WEB_URL }, sessionId);
await loaded.catch(() => {});
await sleep(1500);

const pageTitle = await evaluate('document.title', sessionId);
console.log('页面标题:', pageTitle);

// 1) 找到左侧图标栏里的入口
await waitFor(`[...document.querySelectorAll('button')].some((b) => /视频逐帧查看|Video Frame Viewer/.test((b.getAttribute('aria-label') || '') + b.textContent))`, sessionId, 20000, '侧边栏视频按钮');
const clicked = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => /视频逐帧查看|Video Frame Viewer/.test((b.getAttribute('aria-label') || '') + b.textContent));
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(clicked === true, '点击左侧「视频逐帧查看」按钮');

// 2) 面板出现
await waitFor(`document.querySelector('.dshVfv_root') !== null`, sessionId, 10000, '查看面板');
const initialText = await evaluate(`document.querySelector('.dshVfv_root').innerText`, sessionId);
check(/把 MP4 拖进来|Drop an MP4/.test(initialText), '空状态文案正确', initialText.slice(0, 120));

// 3) 通过 CDP 给隐藏 input 设置真实 MP4
const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
const { nodeId } = await send('DOM.querySelector', {
  nodeId: root.nodeId,
  selector: 'input[type="file"][accept*=".mp4"]',
}, sessionId);
check(Number(nodeId) > 0, '找到 MP4 文件输入框', nodeId);
await setFile(FIXTURE);

// 4) 等视频与精确索引
await waitFor(`(() => {
  const root = document.querySelector('.dshVfv_root');
  const video = document.querySelector('.dshVfv_video');
  return root !== null && video !== null && video.readyState >= 1 && /精确帧索引|Exact frame index/.test(root.innerText);
})()`, sessionId, 15000, '精确帧索引');

const afterOpen = await evaluate(`
  (() => {
    const root = document.querySelector('.dshVfv_root');
    const video = document.querySelector('.dshVfv_video');
    return {
      text: root.innerText,
      duration: video.duration,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      thumbCount: root.querySelectorAll('img.dshVfv_thumbImg').length,
    };
  })()
`, sessionId);
check(Math.abs(afterOpen.duration - 2) < 0.1, '视频时长为 2 秒', afterOpen.duration);
check(/60 帧|60 frames/.test(afterOpen.text), '界面显示 60 帧', afterOpen.text.slice(0, 300));
check(/30 fps/.test(afterOpen.text), '界面显示 30 fps', afterOpen.text.slice(0, 300));
check(afterOpen.videoWidth === 320, '视频分辨率为 320×180', afterOpen.videoWidth);

// 5) 下一帧
const nextClicked = await evaluate(`
  (() => {
    const button = document.querySelector('button[aria-label="下一帧"], button[aria-label="Next frame"]');
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(nextClicked === true, '点击「下一帧」');
await sleep(400);
const afterNext = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    const strong = document.querySelector('.dshVfv_timecodeStrong');
    return { time: video.currentTime, paused: video.paused, frameText: strong ? strong.textContent : '' };
  })()
`, sessionId);
check(afterNext.paused === true, '翻帧后视频处于暂停');
check(afterNext.time > 0.03 && afterNext.time < 0.04, '当前时间约为第 2 帧（0.033s）', afterNext.time);
check(afterNext.frameText === '2', '帧号显示为 2', afterNext.frameText);

// 5.5) 复制当前帧到剪贴板
const copyButtonState = await evaluate(`
  (() => {
    const transport = document.querySelector('.dshVfv_transport');
    const buttons = transport === null ? [] : [...transport.querySelectorAll('button')];
    const last = buttons[buttons.length - 1];
    return {
      count: buttons.length,
      found: last !== undefined && last.dataset.copyFrame === 'true',
      label: last ? last.getAttribute('aria-label') : '',
      disabled: last ? last.disabled : null,
      mockReady: Array.isArray(window.__vfvClipboard),
    };
  })()
`, sessionId);
check(copyButtonState.mockReady === true, '剪贴板 mock 已注入');
check(copyButtonState.found === true, '复制按钮位于播放控制组最右侧', copyButtonState);
check(copyButtonState.label === '复制当前帧', '复制按钮文案正确', copyButtonState.label);
check(copyButtonState.disabled === false, '暂停时复制按钮可用');

const copyClicked = await evaluate(`
  (() => {
    const button = document.querySelector('[data-copy-frame="true"]');
    if (button === null) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(copyClicked === true, '点击「复制当前帧」');
await sleep(800);
const copyResult = await evaluate(`
  (() => {
    const calls = Array.isArray(window.__vfvClipboard) ? window.__vfvClipboard : [];
    const button = document.querySelector('[data-copy-frame="true"]');
    return {
      calls: calls.length,
      types: calls.length > 0 ? calls[0][0].types : [],
      pngSize: calls.length > 0 ? calls[0][0].blobs['image/png']?.size ?? -1 : -1,
      buttonClass: button ? button.className : '',
      label: button ? button.getAttribute('aria-label') : '',
    };
  })()
`, sessionId);
check(copyResult.calls === 1, '调用了一次剪贴板写入', copyResult.calls);
check(copyResult.types.includes('image/png'), '剪贴板项类型为 image/png', copyResult.types);
check(copyResult.pngSize > 1000, '复制的 PNG 有实际内容', copyResult.pngSize);
check(/dshVfv_iconButtonDone/.test(copyResult.buttonClass), '复制成功后按钮显示成功状态');
check(copyResult.label === '已复制当前帧', '复制成功后按钮文案变为「已复制当前帧」', copyResult.label);

const copyShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-copy.png', Buffer.from(copyShot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-copy.png');

// 6) 帧胶片：默认每秒一张 → 双击展开该秒的每一帧 → 单击某帧跳转 → 返回每秒
const secondsState = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    if (grid === null) return null;
    const buttons = [...grid.querySelectorAll('.dshVfv_thumb')];
    return {
      mode: grid.dataset.stripMode,
      count: buttons.length,
      labels: buttons.map((button) => (button.querySelector('.dshVfv_thumbIndex') || {}).textContent || ''),
    };
  })()
`, sessionId);
check(secondsState !== null, '帧胶片已渲染');
check(secondsState.mode === 'seconds', '默认是「每秒一张」视图', secondsState.mode);
check(secondsState.count === 2, '2 秒视频显示 2 张秒缩略图', secondsState);
check(secondsState.labels.join(',') === '1s,2s', '秒缩略图标签为 1s / 2s', secondsState.labels);

const doubleClicked = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    const button = grid === null ? null : grid.querySelectorAll('.dshVfv_thumb')[0];
    if (button === null) return false;
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()
`, sessionId);
check(doubleClicked === true, '双击第 1 秒缩略图');
await sleep(500);
const expandedState = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    const buttons = [...grid.querySelectorAll('.dshVfv_thumb')];
    return {
      mode: grid.dataset.stripMode,
      count: buttons.length,
      first: (buttons[0].querySelector('.dshVfv_thumbIndex') || {}).textContent || '',
      last: (buttons[buttons.length - 1].querySelector('.dshVfv_thumbIndex') || {}).textContent || '',
      title: (document.querySelector('.dshVfv_stripTitle') || {}).textContent || '',
      hasBack: document.querySelector('.dshVfv_stripBack') !== null,
    };
  })()
`, sessionId);
check(expandedState.mode === 'frames', '双击后进入逐帧视图', expandedState.mode);
check(expandedState.count === 30, '第 1 秒展开为 30 帧', expandedState.count);
check(expandedState.first === '1' && expandedState.last === '30', '逐帧标签是帧号 1…30', expandedState);
check(expandedState.title === '第 1 秒', '标题显示「第 1 秒」', expandedState.title);
check(expandedState.hasBack === true, '逐帧视图有「返回每秒」按钮');

const expandedShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-strip-expanded.png', Buffer.from(expandedShot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-strip-expanded.png');

// 展开状态下跳到别的秒，应自动收起回每秒视图
const lastClicked = await evaluate(`
  (() => {
    const button = document.querySelector('button[aria-label="最后一帧"], button[aria-label="Last frame"]');
    if (button === null) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(lastClicked === true, '展开状态下点击「最后一帧」');
await sleep(600);
const autoCollapsed = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    return {
      mode: grid.dataset.stripMode,
      count: grid.querySelectorAll('.dshVfv_thumb').length,
      frame: document.querySelector('.dshVfv_timecodeStrong').textContent,
    };
  })()
`, sessionId);
check(autoCollapsed.frame === '60', '跳到了最后一帧（第 60 帧）', autoCollapsed.frame);
check(autoCollapsed.mode === 'seconds', '离开该秒后胶片自动回到每秒视图', autoCollapsed);

// 重新展开第 1 秒，再单击第 5 帧
const doubleClickedAgain = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    const button = grid === null ? null : grid.querySelectorAll('.dshVfv_thumb')[0];
    if (button === null) return false;
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()
`, sessionId);
check(doubleClickedAgain === true, '重新展开第 1 秒');
await sleep(500);
const reopenedMode = await evaluate(`document.querySelector('.dshVfv_filmstrip').dataset.stripMode`, sessionId);
check(reopenedMode === 'frames', '再次进入逐帧视图', reopenedMode);

const thumbClicked = await evaluate(`
  (() => {
    const button = document.querySelector('button[aria-label^="第 5 帧"], button[aria-label^="Frame 5"]');
    if (button === null) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(thumbClicked === true, '单击逐帧视图中的第 5 帧');
await sleep(500);
const afterThumb = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    const strong = document.querySelector('.dshVfv_timecodeStrong');
    return {
      time: video.currentTime,
      paused: video.paused,
      frameText: strong ? strong.textContent : '',
      thumbs: document.querySelectorAll('img.dshVfv_thumbImg').length,
    };
  })()
`, sessionId);
check(afterThumb.paused === true, '单击缩略帧后视频暂停');
check(afterThumb.time > 0.13 && afterThumb.time < 0.14, '跳到第 5 帧（0.133s）', afterThumb.time);
check(afterThumb.frameText === '5', '帧号显示为 5', afterThumb.frameText);
check(afterThumb.thumbs > 0, '帧胶片已生成缩略图', afterThumb.thumbs);

const backClicked = await evaluate(`
  (() => {
    const button = document.querySelector('.dshVfv_stripBack');
    if (button === null) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(backClicked === true, '点击「返回每秒」');
await sleep(300);
const backState = await evaluate(`
  (() => {
    const grid = document.querySelector('.dshVfv_filmstrip');
    return {
      mode: grid.dataset.stripMode,
      count: grid.querySelectorAll('.dshVfv_thumb').length,
      title: (document.querySelector('.dshVfv_stripTitle') || {}).textContent || '',
    };
  })()
`, sessionId);
check(backState.mode === 'seconds' && backState.count === 2, '返回后回到每秒视图', backState);

// 7) 上一帧（向后翻帧）
const prevClicked = await evaluate(`
  (() => {
    const button = document.querySelector('button[aria-label="上一帧"], button[aria-label="Previous frame"]');
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(prevClicked === true, '点击「上一帧」');
await sleep(400);
const afterPrev = await evaluate(`
  (() => ({
    time: document.querySelector('.dshVfv_video').currentTime,
    frame: document.querySelector('.dshVfv_timecodeStrong').textContent,
  }))()
`, sessionId);
check(afterPrev.frame === '4', '向后翻帧到第 4 帧', afterPrev.frame);
check(afterPrev.time > 0.09 && afterPrev.time < 0.11, '第 4 帧时间约 0.100s', afterPrev.time);

// 8) 0.25× 慢放与 2× 快放
const slowClicked = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('.dshVfv_speedChip')].find((b) => b.textContent.trim() === '0.25×');
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(slowClicked === true, '点击 0.25× 慢放');
const slowValue = await evaluate(`document.querySelector('.dshVfv_video').playbackRate`, sessionId);
check(Math.abs(slowValue - 0.25) < 0.001, '播放速率变为 0.25×', slowValue);

const speedClicked = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('.dshVfv_speedChip')].find((b) => b.textContent.trim() === '2×');
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(speedClicked === true, '点击 2× 倍速');
const speedValue = await evaluate(`document.querySelector('.dshVfv_video').playbackRate`, sessionId);
check(Math.abs(speedValue - 2) < 0.001, '播放速率变为 2×', speedValue);

// 9) 播放 300ms 再暂停
const playClicked = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('.dshVfv_playButton')][0];
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(playClicked === true, '点击播放');
await sleep(350);
const playingState = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    const copyButton = document.querySelector('[data-copy-frame="true"]');
    return {
      paused: video.paused,
      time: video.currentTime,
      rate: video.playbackRate,
      copyDisabled: copyButton === null ? null : copyButton.disabled,
      copyTitle: copyButton === null ? '' : copyButton.getAttribute('title'),
    };
  })()
`, sessionId);
check(playingState.paused === false, '视频进入播放状态');
check(playingState.time > 0.3, '播放后时间向前推进', playingState.time);
check(Math.abs(playingState.rate - 2) < 0.001, '播放时仍为 2×', playingState.rate);
check(playingState.copyDisabled === true, '播放时复制按钮不可点击', playingState.copyDisabled);
check(playingState.copyTitle === '播放时不能复制，请先暂停', '播放时按钮提示说明原因', playingState.copyTitle);
await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('.dshVfv_playButton')][0];
    if (button) button.click();
  })()
`, sessionId);
await sleep(200);
const pausedState = await evaluate(`document.querySelector('.dshVfv_video').paused`, sessionId);
check(pausedState === true, '再次点击后暂停');
const pausedCopyEnabled = await evaluate(`document.querySelector('[data-copy-frame="true"]').disabled === false`, sessionId);
check(pausedCopyEnabled === true, '暂停后复制按钮恢复可用');

// 10) 切到别的面板再回来：视频和位置应保留
const beforeSwitch = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    return { time: video.currentTime, frame: document.querySelector('.dshVfv_timecodeStrong').textContent };
  })()
`, sessionId);
const switchedAway = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => /^(插件|Plugins)$/.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(switchedAway === true, '切到「插件」面板');
await sleep(600);
const panelGone = await evaluate(`document.querySelector('.dshVfv_root') === null`, sessionId);
check(panelGone === true, '切走后查看器已卸载');
await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => /视频逐帧查看|Video Frame Viewer/.test((b.getAttribute('aria-label') || '') + b.textContent));
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`(() => {
  const video = document.querySelector('.dshVfv_video');
  const root = document.querySelector('.dshVfv_root');
  return video !== null && root !== null && video.readyState >= 1 && /精确帧索引|Exact frame index/.test(root.innerText);
})()`, sessionId, 15000, '切回后的查看器');
// 等恢复位置完成（seek 是异步的）
await waitFor(`(() => {
  const video = document.querySelector('.dshVfv_video');
  return video !== null && Math.abs(video.currentTime - ${beforeSwitch.time}) < 0.06;
})()`, sessionId, 8000, '恢复上次播放位置');
const afterSwitch = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    return {
      time: video.currentTime,
      paused: video.paused,
      frame: document.querySelector('.dshVfv_timecodeStrong').textContent,
      text: document.querySelector('.dshVfv_root').innerText,
    };
  })()
`, sessionId);
check(afterSwitch.paused === true, '切回后保持暂停');
check(Math.abs(afterSwitch.time - beforeSwitch.time) < 0.06, '切回后回到上次位置', { before: beforeSwitch.time, after: afterSwitch.time });
check(afterSwitch.frame === beforeSwitch.frame, '切回后帧号一致', { before: beforeSwitch.frame, after: afterSwitch.frame });
check(/h264-30fps\.mp4/.test(afterSwitch.text), '切回后仍保留同一个文件');

// 11) 键盘：方向键翻帧、空格播放/暂停
await evaluate(`document.activeElement && document.activeElement.blur()`, sessionId);
const keyboardStart = await evaluate(`
  (() => ({
    time: document.querySelector('.dshVfv_video').currentTime,
    frame: document.querySelector('.dshVfv_timecodeStrong').textContent,
  }))()
`, sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }, sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }, sessionId);
await sleep(400);
const keyboardAfter = await evaluate(`
  (() => {
    const video = document.querySelector('.dshVfv_video');
    return { time: video.currentTime, frame: document.querySelector('.dshVfv_timecodeStrong').textContent };
  })()
`, sessionId);
check(Number(keyboardAfter.frame) === Number(keyboardStart.frame) + 1, '键盘 → 前进一步', { before: keyboardStart, after: keyboardAfter.frame });
check(keyboardAfter.time >= keyboardStart.time, '键盘 → 后时间戳不倒退', { before: keyboardStart.time, after: keyboardAfter.time });

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
await sleep(300);
const spacePlaying = await evaluate(`document.querySelector('.dshVfv_video').paused === false`, sessionId);
check(spacePlaying === true, '空格开始播放');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
await sleep(200);
const spacePaused = await evaluate(`document.querySelector('.dshVfv_video').paused === true`, sessionId);
check(spacePaused === true, '空格再次暂停');

// 12) 正常 30fps 状态截图
const mainShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-main.png', Buffer.from(mainShot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-main.png');

// 13) 29.97fps：非整数帧率走精确索引
await setFile(FIXTURE_2997);
await waitFor(`(() => {
  const root = document.querySelector('.dshVfv_root');
  const video = document.querySelector('.dshVfv_video');
  return root !== null && video !== null && video.readyState >= 1 && /90 帧|90 frames/.test(root.innerText) && /29.97 fps/.test(root.innerText) && /精确帧索引|Exact frame index/.test(root.innerText);
})()`, sessionId, 15000, '29.97fps 精确索引');
const state2997 = await evaluate(`
  (() => ({
    text: document.querySelector('.dshVfv_root').innerText,
    duration: document.querySelector('.dshVfv_video').duration,
  }))()
`, sessionId);
check(Math.abs(state2997.duration - 3.003) < 0.02, '29.97fps 视频时长约 3.003 秒', state2997.duration);
check(/90 帧|90 frames/.test(state2997.text), '29.97fps 显示 90 帧');
check(/29.97 fps/.test(state2997.text), '29.97fps 显示真实帧率');
check(/精确帧索引|Exact frame index/.test(state2997.text), '29.97fps 使用精确索引');

// 14) 分片 MP4：moov 里没有 stts，应退回实测帧率
await setFile(FIXTURE_FRAGMENTED);
await waitFor(`(() => {
  const root = document.querySelector('.dshVfv_root');
  const video = document.querySelector('.dshVfv_video');
  return root !== null && video !== null && video.readyState >= 1 && /估算帧率|Estimated frame rate/.test(root.innerText) && video.paused;
})()`, sessionId, 20000, '分片 MP4 兜底帧率');
const stateFragmented = await evaluate(`
  (() => {
    const root = document.querySelector('.dshVfv_root');
    const video = document.querySelector('.dshVfv_video');
    return {
      text: root.innerText,
      time: video.currentTime,
      paused: video.paused,
      frameText: document.querySelector('.dshVfv_timecodeStrong').textContent,
      fpsChip: [...root.querySelectorAll('.dshVfv_statusChip')].map((n) => n.textContent),
    };
  })()
`, sessionId);
check(/[2-9]\d 帧|[2-9]\d frames/.test(stateFragmented.text), '分片 MP4 仍能按估算帧率铺出可用的帧数', stateFragmented.text.slice(0, 200));
check(stateFragmented.paused === true, '分片 MP4 实测帧率后回到暂停');
const fragNext = await evaluate(`
  (() => {
    const button = document.querySelector('button[aria-label="下一帧"], button[aria-label="Next frame"]');
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(fragNext === true, '分片 MP4 下点击「下一帧」');
await sleep(450);
const fragAfter = await evaluate(`
  (() => ({
    time: document.querySelector('.dshVfv_video').currentTime,
    frame: document.querySelector('.dshVfv_timecodeStrong').textContent,
  }))()
`, sessionId);
check(Number(fragAfter.frame) === Number(stateFragmented.frameText) + 1, '分片 MP4 翻帧后帧号加 1', { before: stateFragmented.frameText, after: fragAfter.frame });
check(fragAfter.time >= stateFragmented.time, '分片 MP4 翻帧时间不倒退', { before: stateFragmented.time, after: fragAfter.time });
await evaluate(`
  (() => {
    const root = document.querySelector('.dshVfv_root');
    if (root) root.scrollTop = 0;
  })()
`, sessionId);

// 15) 关闭视频 → 空状态，再模拟一次文件拖放
const closed = await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => /^(关闭视频|Close video)$/.test((b.textContent || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  })()
`, sessionId);
check(closed === true, '点击「关闭视频」');
await waitFor(`document.querySelector('.dshVfv_empty') !== null`, sessionId, 5000, '关闭后的空状态');
const dropRect = await evaluate(`
  (() => {
    const node = document.querySelector('.dshVfv_empty');
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()
`, sessionId);
const dragData = { items: [], files: [FIXTURE], dragOperationsMask: 1 };
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: dropRect.x, y: dropRect.y, data: dragData }, sessionId);
await send('Input.dispatchDragEvent', { type: 'dragOver', x: dropRect.x, y: dropRect.y, data: dragData }, sessionId);
await send('Input.dispatchDragEvent', { type: 'drop', x: dropRect.x, y: dropRect.y, data: dragData }, sessionId);
await waitFor(`(() => {
  const root = document.querySelector('.dshVfv_root');
  const video = document.querySelector('.dshVfv_video');
  return root !== null && video !== null && video.readyState >= 1 && /60 帧|60 frames/.test(root.innerText) && /精确帧索引|Exact frame index/.test(root.innerText);
})()`, sessionId, 15000, '拖放打开 MP4');
const dropped = await evaluate(`
  (() => ({
    name: document.querySelector('.dshVfv_chip') ? document.querySelector('.dshVfv_chip').textContent : '',
    text: document.querySelector('.dshVfv_root').innerText.slice(0, 200),
  }))()
`, sessionId);
check(/h264-30fps\.mp4/.test(dropped.name), '拖放后打开的是同一个 MP4', dropped.name);

// 16) 截图
const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-drop.png', Buffer.from(screenshot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-drop.png');

// 10) 输出诊断
const finalText = await evaluate(`document.querySelector('.dshVfv_root').innerText`, sessionId);
console.log('--- 面板文字 ---');
console.log(finalText.slice(0, 1200));
if (consoleErrors.length > 0) {
  console.log('--- console.error ---');
  for (const line of consoleErrors) console.log(line);
}
if (pageErrors.length > 0) {
  console.log('--- page exceptions ---');
  for (const line of pageErrors) console.log(line);
}

ws.close();
if (failures.length > 0) {
  console.error('\n失败 ' + failures.length + ' 项:');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log('\n全部检查通过');
