# 生词 TSV 导出的离线 License

## 范围与设计

JSON 导出免费且原按钮处理逻辑不变。仅 TSV（Anki）导出付费；无 `.apkg`、音频、图片或书名采集。TSV 是 UTF-8、无表头，每行七列：lemma、lang、gloss、sentence、addedAt（UTC ISO）、known（true/false）、tags（`ilr lang:{lang}`）。制表符和换行转为空格，其他控制字符移除。Anki 导入须关闭 HTML 并把第七列映射为标签。known 使用现有独立已知词表的最新值，不使用过时的生词快照。

Token 为 `base64url(JSON payload).base64url(Ed25519 signature)`。载荷是 `{plan:'vocab-export', exp:<UTC ISO>, name:<客户标签>}`，签名覆盖第一段字符串的 UTF-8 字节。`parseLicense` 验签、检查计划、标签和有效期；无效输入返回 null。纯函数参数允许单测注入临时公钥；持久化与解锁入口始终使用内嵌公钥。无可修改的全局测试开关。

`ilr.license.v1` 只缓存 token，不信任布尔解锁标记。打开生词页、刷新后进入生词页和每次导出点击都重新验签并检查过期。浏览器不支持时保持锁定，显示升级浏览器和 HTTPS/localhost 提示，JSON 仍可用。校验成功但本地存储受限时显示保存失败，不假装持久化成功。

这是静态应用的诚实付费门槛，不是防篡改 DRM：离线验证不能提供可信服务器时间、远程吊销、设备绑定或阻止用户修改自己的客户端。客户标签和有效期可解码，不是密文。

## 密钥处理

- 内嵌公钥（raw base64url）：`GjAUII81WIvw0-LFdY5T18Z7AMUCT0yTjcq-00nKS0Q`。
- 管理员本机私钥路径：`~/.config/interlinear-reader/license-key.json`，位于仓库外，文件权限 `0600`，新建目录权限 `0700`。
- `packages/license-cli/sign.mjs --generate` 用 Node 原生 crypto 创建密钥，独占写入，拒绝覆盖和仓库内路径。签名 CLI 不被前端引用。详见 [签发操作](../../packages/license-cli/README.md)。
- `.gitignore` 忽略本地 license-key 路径作为补充保护。仓库、文档、测试和 bundle 不含私钥、seed 或签名材料。单测通过 `node:crypto.webcrypto` 在每次运行时生成临时密钥，私钥不落盘。
- 有效浏览器测试 token 由 CLI 在临时测试进程中签发，不写进仓库或截图。测试用过期 token 只在临时进程内签发。

## 浏览器兼容性

2026-09-17 查阅 [MDN verify 文档](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify) 与 [MDN Browser Compat Data](https://cdn.jsdelivr.net/gh/mdn/browser-compat-data@main/api/SubtleCrypto.json) 的 `importKey.ed25519`、`verify.ed25519`：

| 浏览器 | 原生 Ed25519 最低版本 |
| --- | --- |
| Chrome / Chromium、Edge | 137 |
| Firefox | 129 |
| Safari / iOS Safari | 17 |

因此 Chrome 155+ 在支持范围内。必须在安全上下文运行（HTTPS，或可信 loopback 本地地址）。运行时实际尝试导入 Ed25519 公钥，不依赖 UA 字符串；不加载 crypto polyfill。此次实际测试为 headless Chromium 153.0.8010.12，不声称实测了其他浏览器。

## 验证记录

起点 `962f60ac9b171ce2e0dda1c5b004d479252a7060`，开始前工作树干净。未安装依赖、未提交。门禁：`node --test tests/unit/*.mjs` 64/64；`npm test` 75/75；`npm run typecheck`（tsc --noEmit）通过；`npm run build` 通过，首屏 gzip 28.6KB / 60KB；`ILR_BASE=http://127.0.0.1:5216 npm run e2e` 2/2。

浏览器使用独立 fresh context、127.0.0.1:5215 的真实生产构建，所有非本端口网络请求被拦截（实测无外部请求）。原生 download 事件捕获 `vocab.tsv` 并逐字节比对七列、控制字符处理、ISO 日期、最新 known 状态和标签。验证未授权面板、过期/篡改错误、CLI License 解锁、刷新保持、缓存布尔值被拒绝、无 WebCrypto 降级提示，以及解锁前后 JSON 内容不变。无 pageerror。

本机临时证据目录：`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-license-evidence-FXDyWw/`。

- `result.json`：浏览器版本与完成检查。
- `01-locked.png`、`02-expired.png`、`02-tampered.png`：锁定及错误状态。
- `03-unlocked.png`、`04-reload.png`、`05-unsupported.png`：成功、刷新及降级状态。
- `vocab.tsv`、`vocab.json`：真实下载内容。
- 临时可重复驱动：`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-license-browser.mjs`。

CLI 额外检查通过：仓库外生成、0600 权限、已存在文件拒绝覆盖、仓库内路径拒绝、token 签名和载荷验证、负数年限拒绝。对自身 diff、新源码/文档/测试和构建 JS 共 19 个文件扫描私钥实际值及私钥标记，均无命中；git check-ignore 已验证四种本地密钥路径。构建产物的改动在验收后还原，仅保留源码与文档。

证据仅留本地；环境未安装 `lh`，无法发布 acceptance 链接。首轮临时驱动误用“生词本”定位导航按钮，调整为实际“📝 生词”后全部通过，产品代码未因此修改。未实测 Anki 桌面端导入，已按其文本导入格式验证下载内容。
