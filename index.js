/**
 * 视频逐帧查看 —— Host 半边。
 *
 * 这个插件不需要 Host 能力：
 *   - 打开文件走浏览器的 File API，文件不会上传到 Host；
 *   - MP4 解码走浏览器自带的 <video>；
 *   - 帧索引由客户端分块读取文件里的 moov 元数据算出。
 *
 * 这里只保留一个空的 apply，让 bundle 在 profile 里有一行可管理的入口。
 */
export function apply() {}
