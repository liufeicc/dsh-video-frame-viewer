/**
 * 真实页面 E2E：多工作区平铺 →「任务分派」→「视频逐帧查看」按钮 → 浮动窗口。
 *
 * 前置：
 *   1. 一个带 --remote-debugging-port=9222 的 Chrome 已在运行；
 *   2. 优先读桌面壳公告的带 token 入口（~/.dsh-desktop/endpoint.json），
 *      也可以用 DSH_E2E_URL 指定。
 *
 * 验证内容：
 *   - 任务分派顶部原来的拖拽说明已消失；
 *   - 说明位置出现「视频逐帧查看」按钮，且可用；
 *   - 点击后出现浮动窗口，浮窗内能打开 MP4 并显示精确帧索引 / 60 帧；
 *   - 标题栏可拖动、可最大化 / 还原、可关闭；
 *   - 关闭后平铺面板仍在；再次打开，视频与位置保留。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const FIXTURE = fileURLToPath(new URL('./fixtures/h264-30fps.mp4', import.meta.url));
const SHOT_DIR = fileURLToPath(new URL('./screenshots/', import.meta.url));

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
if (!WEB_URL) {
  console.error('缺少网页入口地址');
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
    } catch {
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

// 关掉残留页面，避免连错目标。
const existing = await (await fetch(`${CDP_HTTP}/json/list`)).json();
for (const page of existing) {
  if (page.type === 'page') {
    try {
      await fetch(`${CDP_HTTP}/json/close/` + page.id);
    } catch {
      /* 忽略。 */
    }
  }
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('DOM.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);
await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
}, sessionId);

/** 把本地 MP4 塞进浮窗里隐藏的 file input。 */
async function setFile(path) {
  const document = await send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const { nodeIds } = await send('DOM.querySelectorAll', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"][accept*=".mp4"]',
  }, sessionId);
  if (nodeIds.length === 0) throw new Error('找不到 MP4 文件输入框');
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[nodeIds.length - 1], files: [path] }, sessionId);
}

const loaded = waitEvent('Page.loadEventFired', sessionId, 20000);
await send('Page.navigate', { url: WEB_URL }, sessionId);
await loaded.catch(() => {});
await sleep(1500);

// 1) 打开左侧「多工作区平铺」
await waitFor(`[...document.querySelectorAll('button')].some((b) => /多工作区平铺|Split Workspaces/.test((b.getAttribute('aria-label') || '') + b.textContent))`, sessionId, 20000, '侧边栏平铺按钮');
await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => /多工作区平铺|Split Workspaces/.test((b.getAttribute('aria-label') || '') + b.textContent));
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`document.querySelector('.dshSplitWs_root') !== null`, sessionId, 15000, '平铺面板');

// 2) 切到「任务分派」模式
await waitFor(`[...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '任务分派')`, sessionId, 10000, '任务分派 tab');
await evaluate(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '任务分派');
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`document.querySelector('.dshSplitWs_graphBar') !== null`, sessionId, 10000, '任务分派工具条');

// 3) 提示语消失、按钮出现且可用
const barState = await evaluate(`
  (() => {
    const bar = document.querySelector('.dshSplitWs_graphBar');
    const button = bar === null ? null : [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '视频逐帧查看');
    return {
      barText: bar === null ? '' : bar.innerText,
      hasHint: document.body.innerText.includes('展开左侧工作区，把会话卡片拖进画布'),
      buttonFound: button !== null,
      buttonDisabled: button === null ? null : button.disabled,
    };
  })()
`, sessionId);
check(barState.hasHint === false, '原来那句拖拽说明已移除');
check(barState.buttonFound === true, '任务分派工具条出现「视频逐帧查看」按钮');
check(barState.buttonDisabled === false, '按钮处于可用状态');

// 4) 点击按钮 → 浮动窗口
await evaluate(`
  (() => {
    const bar = document.querySelector('.dshSplitWs_graphBar');
    const button = bar === null ? null : [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '视频逐帧查看');
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`document.querySelector('.dshVfv_floatWindow') !== null`, sessionId, 10000, '浮动窗口');
const floatState = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    const rect = win.getBoundingClientRect();
    return {
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      title: document.querySelector('.dshVfv_floatTitleText') ? document.querySelector('.dshVfv_floatTitleText').textContent : '',
      splitStillThere: document.querySelector('.dshSplitWs_graphBar') !== null,
      empty: win.innerText.includes('把 MP4 拖进来'),
    };
  })()
`, sessionId);
check(floatState.title === '视频逐帧查看', '浮窗标题正确', floatState.title);
check(floatState.splitStillThere === true, '浮窗打开时平铺面板没有被替换');
check(floatState.empty === true, '浮窗内是视频空状态');
check(floatState.rect.w > 700 && floatState.rect.h > 450, '浮窗尺寸合理', floatState.rect);

// 5) 在浮窗里打开 MP4
await setFile(FIXTURE);
await waitFor(`(() => {
  const win = document.querySelector('.dshVfv_floatWindow');
  const video = win === null ? null : win.querySelector('.dshVfv_video');
  return video !== null && video.readyState >= 1 && /精确帧索引|Exact frame index/.test(win.innerText) && /60 帧|60 frames/.test(win.innerText);
})()`, sessionId, 15000, '浮窗内的精确帧索引');
const playingState = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    const video = win.querySelector('.dshVfv_video');
    return {
      duration: video.duration,
      text: win.innerText.slice(0, 300),
      frame: win.querySelector('.dshVfv_timecodeStrong').textContent,
    };
  })()
`, sessionId);
check(Math.abs(playingState.duration - 2) < 0.1, '浮窗内视频时长为 2 秒', playingState.duration);
check(/60 帧|60 frames/.test(playingState.text), '浮窗内显示 60 帧');

// 6) 拖动标题栏
const beforeDrag = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    const rect = win.getBoundingClientRect();
    const title = win.querySelector('.dshVfv_floatTitle').getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      grabX: Math.round(title.left + title.width / 2),
      grabY: Math.round(title.top + title.height / 2),
    };
  })()
`, sessionId);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beforeDrag.grabX, y: beforeDrag.grabY, button: 'left', clickCount: 1 }, sessionId);
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.grabX + 70, y: beforeDrag.grabY + 60, button: 'left', buttons: 1 }, sessionId);
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeDrag.grabX + 70, y: beforeDrag.grabY + 60, button: 'left', clickCount: 1 }, sessionId);
await sleep(250);
const afterDrag = await evaluate(`
  (() => {
    const rect = document.querySelector('.dshVfv_floatWindow').getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top) };
  })()
`, sessionId);
check(Math.abs(afterDrag.left - beforeDrag.left - 70) <= 3 && Math.abs(afterDrag.top - beforeDrag.top - 60) <= 3, '拖动标题栏移动了窗口', { before: beforeDrag, after: afterDrag });

// 7) 最大化 / 还原
await evaluate(`
  (() => {
    const button = document.querySelector('.dshVfv_floatWindow button[aria-label="最大化"], .dshVfv_floatWindow button[aria-label="Maximize"]');
    if (button) button.click();
  })()
`, sessionId);
await sleep(350);
const maximized = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    const rect = win.getBoundingClientRect();
    return { hasClass: win.classList.contains('dshVfv_floatMaximized'), w: Math.round(rect.width), h: Math.round(rect.height) };
  })()
`, sessionId);
check(maximized.hasClass === true, '最大化生效');
check(maximized.w > 1500 && maximized.h > 900, '最大化后接近整窗尺寸', maximized);
await evaluate(`
  (() => {
    const button = document.querySelector('.dshVfv_floatWindow button[aria-label="还原窗口"], .dshVfv_floatWindow button[aria-label="Restore window"]');
    if (button) button.click();
  })()
`, sessionId);
await sleep(350);
const restored = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    return { hasClass: win.classList.contains('dshVfv_floatMaximized') };
  })()
`, sessionId);
check(restored.hasClass === false, '还原生效');

// 8) 截图（浮窗 + 视频）
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-float.png', Buffer.from(shot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-float.png');

// 9) 关闭浮窗 → 平铺面板仍在
const beforeCloseFrame = await evaluate(`document.querySelector('.dshVfv_floatWindow .dshVfv_timecodeStrong').textContent`, sessionId);
await evaluate(`
  (() => {
    const button = document.querySelector('.dshVfv_floatWindow button[aria-label="关闭窗口"], .dshVfv_floatWindow button[aria-label="Close window"]');
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`document.querySelector('.dshVfv_floatWindow') === null`, sessionId, 5000, '浮窗关闭');
const afterClose = await evaluate(`
  (() => ({
    splitStillThere: document.querySelector('.dshSplitWs_graphBar') !== null,
    videoGone: document.querySelector('.dshVfv_video') === null,
  }))()
`, sessionId);
check(afterClose.splitStillThere === true, '关闭浮窗后平铺面板仍在');
check(afterClose.videoGone === true, '关闭浮窗后视频元素已卸载');

// 10) 再次打开：视频仍在、帧位置保留
await evaluate(`
  (() => {
    const bar = document.querySelector('.dshSplitWs_graphBar');
    const button = bar === null ? null : [...bar.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '视频逐帧查看');
    if (button) button.click();
  })()
`, sessionId);
await waitFor(`(() => {
  const win = document.querySelector('.dshVfv_floatWindow');
  const video = win === null ? null : win.querySelector('.dshVfv_video');
  return video !== null && video.readyState >= 1 && /精确帧索引|Exact frame index/.test(win.innerText);
})()`, sessionId, 15000, '浮窗重新打开');
const reopened = await evaluate(`
  (() => {
    const win = document.querySelector('.dshVfv_floatWindow');
    return {
      frame: win.querySelector('.dshVfv_timecodeStrong').textContent,
      text: win.innerText.slice(0, 200),
    };
  })()
`, sessionId);
check(reopened.frame === beforeCloseFrame, '重新打开后仍是同一帧', { before: beforeCloseFrame, after: reopened.frame });
check(/60 帧|60 frames/.test(reopened.text), '重新打开后视频仍在');

// 11) Esc 关闭浮窗，截图任务分派按钮
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sessionId);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sessionId);
await waitFor(`document.querySelector('.dshVfv_floatWindow') === null`, sessionId, 5000, 'Esc 关闭浮窗');
check(true, 'Esc 关闭浮动窗口');
await sleep(300);
const finalShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(SHOT_DIR + 'e2e-graph-button.png', Buffer.from(finalShot.data, 'base64'));
console.log('截图:', SHOT_DIR + 'e2e-graph-button.png');

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