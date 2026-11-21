/**
 * 视频逐帧查看 — 中英词典。
 *
 * 只包含本插件界面自己显示的文案；注册到 DSH 的 locale 命名空间
 * `video-frame-viewer`，组件里的 `t` 由插槽的 locale 选项提供。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-frame-viewer/client.dicts.js',
  factory() {
    const zh = {
      'panel.title': '视频逐帧查看',
      'panel.subtitle': '本地 MP4 · 文件不会上传',
      'panel.open': '打开 MP4',
      'panel.closeVideo': '关闭视频',

      'empty.title': '把 MP4 拖进来，或选择文件',
      'empty.desc': '支持播放、慢放快放、逐帧前后翻；单击下面的缩略帧，就能直接查看那一帧。',
      'empty.hint': '视频只在本地浏览器里读取，不会上传到服务器。',
      'empty.action': '选择 MP4 文件',

      'status.parsing': '正在读取帧索引…',
      'status.probing': '正在实测帧率…',
      'status.exact': '精确帧索引',
      'status.estimated': '估算帧率',
      'status.variable': '可变帧率',
      'status.frames': '{count} 帧',
      'status.fps': '{fps} fps',
      'status.duration': '{time}',
      'status.size': '{size}',

      'controls.play': '播放',
      'controls.pause': '暂停',
      'controls.first': '第一帧',
      'controls.prev': '上一帧',
      'controls.next': '下一帧',
      'controls.last': '最后一帧',
      'controls.speed': '速度',
      'controls.timeline': '时间轴（按帧）',
      'controls.copyFrame': '复制当前帧',
      'controls.copied': '已复制当前帧',
      'controls.copyFailed': '复制失败',
      'controls.copyUnsupported': '当前浏览器不支持复制图片',
      'controls.copyWhilePlaying': '播放时不能复制，请先暂停',
      'controls.speedValue': '{speed}×',

      'strip.title': '帧胶片',
      'strip.secondsHint': '每秒一张 · 双击某一秒查看该秒全部帧',
      'strip.expandedHint': '单击缩略帧跳转',
      'strip.expandedTitle': '第 {second} 秒',
      'strip.backToSeconds': '返回每秒',
      'strip.current': '第 {frame} 帧',
      'strip.loading': '生成中…',

      'hints.keyboard': '空格 播放/暂停 · ←/→ 单帧 · Shift+←/→ 10 帧 · Home/End 首尾帧 · [ ] 调速',

      'error.notMp4': '请选择 MP4 文件（.mp4）。',
      'error.decode': '这个 MP4 无法解码，可能是浏览器不支持的编码（例如部分 HEVC），或文件已损坏。',
      'error.noFrames': '没有读到视频帧，无法逐帧查看。',

      'drop.title': '松开以打开 MP4',
      'a11y.video': '视频画面',
      'a11y.openFile': '打开本地 MP4 文件',

      'float.dragHint': '拖动标题栏移动窗口，双击最大化',
      'float.maximize': '最大化',
      'float.restore': '还原窗口',
      'float.close': '关闭窗口',
      'float.resize': '拖动缩放',
    };

    const en = {
      'panel.title': 'Video Frame Viewer',
      'panel.subtitle': 'Local MP4 · never uploaded',
      'panel.open': 'Open MP4',
      'panel.closeVideo': 'Close video',

      'empty.title': 'Drop an MP4 here, or choose a file',
      'empty.desc': 'Play, slow down or speed up, step frame by frame, and click a thumbnail below to inspect that exact frame.',
      'empty.hint': 'The video is read locally in your browser and never uploaded to the server.',
      'empty.action': 'Choose MP4 file',

      'status.parsing': 'Reading frame index…',
      'status.probing': 'Measuring frame rate…',
      'status.exact': 'Exact frame index',
      'status.estimated': 'Estimated frame rate',
      'status.variable': 'Variable frame rate',
      'status.frames': '{count} frames',
      'status.fps': '{fps} fps',
      'status.duration': '{time}',
      'status.size': '{size}',

      'controls.play': 'Play',
      'controls.pause': 'Pause',
      'controls.first': 'First frame',
      'controls.prev': 'Previous frame',
      'controls.next': 'Next frame',
      'controls.last': 'Last frame',
      'controls.speed': 'Speed',
      'controls.timeline': 'Timeline (by frame)',
      'controls.copyFrame': 'Copy current frame',
      'controls.copied': 'Current frame copied',
      'controls.copyFailed': 'Copy failed',
      'controls.copyUnsupported': 'This browser cannot copy images',
      'controls.copyWhilePlaying': 'Pause before copying a frame',
      'controls.speedValue': '{speed}×',

      'strip.title': 'Filmstrip',
      'strip.secondsHint': 'One per second · double-click a second to see every frame in it',
      'strip.expandedHint': 'Click a thumbnail to jump to that frame',
      'strip.expandedTitle': 'Second {second}',
      'strip.backToSeconds': 'Back to seconds',
      'strip.current': 'Frame {frame}',
      'strip.loading': 'Rendering…',

      'hints.keyboard': 'Space play/pause · ←/→ one frame · Shift+←/→ 10 frames · Home/End first/last · [ ] speed',

      'error.notMp4': 'Please choose an MP4 file (.mp4).',
      'error.decode': 'This MP4 cannot be decoded by the browser — it may use an unsupported codec (such as some HEVC), or the file is damaged.',
      'error.noFrames': 'No video frames were found, so frame stepping is unavailable.',

      'drop.title': 'Release to open the MP4',
      'a11y.video': 'Video picture',
      'a11y.openFile': 'Open a local MP4 file',

      'float.dragHint': 'Drag the title bar to move; double-click to maximize',
      'float.maximize': 'Maximize',
      'float.restore': 'Restore window',
      'float.close': 'Close window',
      'float.resize': 'Drag to resize',
    };

    return { zh, en };
  },
});
