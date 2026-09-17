# interlinear-reader · Track D (deploy + unattended harness)

Cloudflare Pages (`packages/web/dist`) + R2 public origin
(`dict/{lang}/{target}.dict.br`, r2.dev direct, no Worker). Free tier only, no DB.
BYOK keys never leave the browser in the web app (browser-direct to provider;
saved in `localStorage`, so any malware that can read the browser profile can
read them). The userscript (`packages/userscript`) remembers its key in GM
storage on disk by default — the same exposure, stated plainly. Neither has a
technical defense against local malware; both UIs recommend a dedicated
low-balance key with hard provider usage/spend limits, rotation, and revocation
as the real mitigation. See
[userscript key security](docs/research/key-security-hardening.md).

- Contract mirror: `CONTRACT.md` (7×2 langs, one asset per source/target pair, A/B/C, sha1 keys, hygiene)
- Deploy/runbook: `DEPLOY.md`
- One-key self-check: `npm run verify` → `artifacts/verify-report.json + .html`
- Dict ship: `npm run deploy:dict` (dry-run) / `npm run deploy:dict:live`
- R2-layout proof: `npm run dict:proof` (needs stub or prod base via `ILR_BASE`)
- Local harness server: `npm run dev:stub` (real dist + dict + `/mock-llm` + `/api/*`)
- Prod poll: `npm run selfcheck [baseUrl]`
- CI: `.github/workflows/verify.yml` (verify on push + nightly prod selfcheck)

## 生词本导出

**JSON 导出免费；TSV（Anki）导出为付费功能，需有效 License。** 在 **生词** 页点击 **导出 TSV（Anki）· 需 License**，在展开的面板输入 License 并点击 **校验**。License 离线验签，保存在当前站点的浏览器本地存储，刷新后仍可用；过期后需续期。

`vocab.tsv` 是 UTF-8 纯文本，每行依次为 `lemma`、`lang`、`gloss`、`sentence`、`addedAt`（UTC ISO）、`known`、`tags`，以制表符分隔，无表头。Anki 导入时选择制表符分隔，将第七列映射为标签，并关闭 **允许在字段中使用 HTML**。制表符和换行转为空格，其他控制字符移除；标签为 `ilr lang:{lang}`。本版本不生成 `.apkg`，不包含音频、图片或书名标签。

License 校验需要支持 Ed25519 的浏览器和 HTTPS（本地可用 localhost）。不支持时页面显示升级提示，JSON 导出不受影响。管理员签发步骤见 [License CLI 指南](packages/license-cli/README.md)，设计与验证见 [TSV 导出记录](docs/research/license-tsv-export.md)。

## 浏览器用户脚本（Tampermonkey）

用户脚本为日语、英语网页正文添加中文逐词注释，不是 Chrome 扩展。先安装 Tampermonkey，再从仓库根目录构建：

```sh
npm run build --workspace packages/userscript
```

产物是 `packages/userscript/dist/interlinear-reader.user.js`。该构建命令是发布产物的来源；用户脚本 `dist` 不提交到 Git。

### 本地安装

1. 打开 Tampermonkey **管理面板 → 实用工具（Utilities）→ 从文件导入**，选择上述 `.user.js` 并确认安装。若管理器没有文件导入入口，新建脚本，用产物的完整内容替换编辑器内容后保存。
2. 在 Chromium 的扩展管理页打开 Tampermonkey 详情，按浏览器提示启用 **允许用户脚本（Allow User Scripts）**。旧版浏览器可能要求开发者模式；以当前管理器提示为准。
3. 在 Tampermonkey 中限制脚本的匹配站点，再启用脚本。刷新允许的文章页，点击 **文 / Annotate**；点击 **↩ Restore** 撤销注释。

### 权限与隐私

- `@match *://*/*` 覆盖 HTTP、HTTPS 网页。避免在邮箱、支付、账户和医疗页面启用；默认不处理 iframe。
- GM storage 保存词典缓存、授权和设置，**默认也保存 API key 到磁盘**。本地恶意软件或能读取浏览器配置的扩展可以读到密钥。使用低余额专用 key，在服务商控制台设置硬性用量/费用限额，定期轮换并及时撤销；菜单的“仅本次会话（不保存）”只减少持久化风险。
- 默认先查词典。LLM 补全需要你配置服务商和 key，并确认向该站点对应的接口发送正文；服务商可能留存文本或计费。
- `@connect pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev` 允许下载词典，请求只带语言对路径。`@connect *` 支持自选 LLM 主机；可将其缩小到你使用的服务商域名。管理器可能要求你确认跨域权限。

完整限制、词典许可和卸载说明见 [用户脚本指南](packages/userscript/README.md)。自动化测试使用 GM stub，不能替代真实 Tampermonkey 安装验证。

### 手动发布（尚未公开发布）

目前 **未发布到 GreasyFork 或 GitHub Releases**。准备 draft 不等于公开发布。发布需要你自己的 GitHub、GreasyFork 账户，以及本仓库的 Release 写入权限。

1. 检查 [GreasyFork 文案](packages/userscript/GREASYFORK.md)，将 OWNER/REPO 占位符替换为 `hu00yan/interlinear-reader`。核对版本、权限和 [词典许可待核验项](DICT_SOURCES.md)。
2. 运行上述构建命令，保留 `packages/userscript/dist/interlinear-reader.user.js`。
3. 打开 [GitHub 新建 Release](https://github.com/hu00yan/interlinear-reader/releases/new)。选择已验证提交和唯一版本标签，填写标题与说明，将构建的 `.user.js` 拖到附件区。先点 **Save draft** 检查附件，最后由你确认 **Publish release**。若已有代理准备的草稿，从 [Releases](https://github.com/hu00yan/interlinear-reader/releases) 打开它，不要重复创建。
4. 登录 [GreasyFork 发布脚本](https://greasyfork.org/zh-CN/scripts/new)，上传或粘贴同一 `.user.js`，使用 `packages/userscript/GREASYFORK.md` 的名称、描述和正文，填写实际主页及反馈链接。审核权限和许可后，由你点击最终发布按钮。
5. 将实际安装链接和已发布版本补回文档。不要发布占位链接，也不要把 API key 写入脚本或发布说明。

Out of scope: web UI features (A), dict content/lemmatizers (B), provider prompts (C).
