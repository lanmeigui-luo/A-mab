// 空操作 Windows 代码签名器（本地自用构建不签名）。
//
// 背景：electron-builder 对 nsis/portable 目标默认要求 Authenticode 签名，
// 会下载 winCodeSign 工具包。但 winCodeSign 的 7z 内含有 macOS 符号链接
// （darwin/10.12/lib/libcrypto.dylib 等），当前账户无「创建符号链接」特权，
// 7z 解压必定失败（ERROR: Cannot create symbolic link : 客户端没有所需的特权）。
//
// 通过 electron-builder.yml 的 `win.sign` 指向本模块，electron-builder 用本函数
// 替代默认 Authenticode 签名（无证书时直接跳过签名步骤）。本地/个人分发无需签名。
//
// ⚠️ 重要：本签名器**不会**阻止 electron-builder 下载 winCodeSign——下载 winCodeSign
// 是为了里面的 rcedit.exe（给 exe 嵌图标/版本资源），与签名无关。winCodeSign 的 7z
// 含 macOS 符号链接，当前账户无建符号链接特权会解压失败；真正的修复是手动把
// winCodeSign-2.6.0 预解压到 %LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0/
// （容忍 2 个 darwin 符号链接错误即可）。详见 PACKAGING-VALIDATION.md 第八节「坑 1」。
//
// 若将来要发布签名版：准备 .pfx 证书，设置 CSC_LINK / CSC_KEY_PASSWORD，
// 并移除本文件引用（或把本模块换成真实签名逻辑）；同时需开启 Windows
//「开发者模式」或以管理员身份运行，使 7z 能创建 winCodeSign 内的符号链接。
module.exports = async function noopSign(/* configuration */) {
  // configuration.path 为待签名的可执行文件路径；本地构建留空即可。
  return;
};
