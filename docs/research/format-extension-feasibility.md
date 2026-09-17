# 格式扩展与网页原位逐词注释：可行性及边界

研究日期：2026-09-17。本文是方案解释，不是实现说明或验收记录。

本轮只读取相关源码、公开一手资料和两个指定样本的少量文件头。没有安装依赖、运行转换器、修改产品代码、制作原型、执行浏览器测试或发布任何内容。浏览器现状验证由独立 verifier 负责。

证据分为三类：**源码事实**表示当前代码可直接确认的行为；**来源事实**表示规范、官方文档或上游维护者的声明；**建议／推断，未实测**表示基于这些证据的本地方案判断。后者不构成兼容性承诺。

## 结论：先解决文本质量，再扩格式与网页入口

- **竖排日文 EPUB 转横排行间注释可行，但前提是存在可提取、顺序合理的文本。** 竖排通常是排版，不是另一种文字编码；横排目标不需要保留原书竖排分页。真正需要处理的是 ruby、正文顺序及非段落结构。[E1][E2][E3][L1]
- **图文混排不是解析器单点问题。** 当前 `BookChapter.paragraphs: string[]` 不承载图片或图文位置；即使换解析库，沿用这个模型仍会丢图。纯图书没有文本时，显示图片与 OCR 是两项不同能力。[L1][L2][E1]
- **DRM-free MOBI7、KF8/AZW3 有浏览器方案，也有本地转换路线。** 浏览器优先候选是 MIT 的 Foliate.js 解析模块；它有近期维护记录，但 API 未稳定，MOBI 与 KF8 各有内存、解压性能限制。现在更稳妥的产品路线是允许用户先用本地 Calibre 转 EPUB，再单独决定是否增加直接导入。[M1][M2][M3][M6]
- **Chrome MV3 可以提供用户要求的“页面按钮 + 原文逐词插注”。** 它不等于把现有独立阅读页搬进侧栏。DOM 还原、动态页面、CSS 冲突和隐私边界是主要新增工作；侧栏只能作为用户选择的补充或兼容模式。[C1][C2]
- **ZIP 开发者模式分发可行；GitHub 下载 CRX 不等于普通 macOS、Windows 用户可直接安装。** 商店自动化能上传更新、查询状态和提交审核，不能替用户完成注册、付款、必要资料或绕过审核。[D1][D2][D3][D4]

上述先后顺序是建议，不是已获准实施的计划。

## 当前仓库：文本摄入已经丢弃源书版式

以下为源码事实，未通过浏览器验证。

1. 根目录使用 npm workspaces；Web 包使用 TypeScript、Vite、JSZip 与 marked。`packages/web/package.json` 没有 MOBI 解析依赖。[L3]
2. `parseEpub()` 读取 `META-INF/container.xml`，定位 OPF，按 spine 顺序逐文档抽取；跳过 `linear=no`、nav 和一些目录文件名。它没有导入书内 CSS、图像资源或布局元数据到 `Book`。[L1]
3. `extractXhtml()` 删除 `script, style, nav, header, footer`，选中 `p,h2,h3,h4,li,blockquote`，读取 `.textContent` 并压缩空白；标题另取。它没有 ruby 特殊处理，没有图片段落类型，也没有 OCR 分支。[L1]
4. `BookChapter` 只有 `id`、`title`、`paragraphs: string[]`。源 CSS 与垂直书写信息无法通过该契约传给阅读器。因此“不保留竖排”与当前抽文本方向一致，不代表当前提取质量已达标。[L2]
5. 文件选择器 `accept` 为 `.epub,.txt,.md`。实际 change handler 只区分 EPUB、MD，**其余一律进入 `decodeTextFile()` → `parseTxt()`**。若用户绕过选择器过滤选中 MOBI/AZW3，代码不会执行格式解析，也没有在这个入口明确拒绝未知后缀；乱码或错误的实际表现需 verifier 确认。[L4]
6. 项目图谱服务的 `list_projects` 未列出本仓库，因此本次按已知相关路径读取源码，并回退到局部文本检索。本文不把其他项目的图谱结果当作本仓库证据。

**额外的提取风险，源码推断：** `blockquote` 或 `li` 包含 `p` 时，父子都被选中，可能重复抽取。只选若干标签可能漏掉 `div`、表格或 SVG 文本；连续同文去重也不等于识别全部结构重复。图片书只剩标题或图注时，不能因“抽到一点文字”就判断正文可读。[L1]

## 日文 EPUB：竖排可横排，但 ruby 必须分层

### 竖排不意味着倒序提取

**来源事实：** CSS `writing-mode` 定义横排、`vertical-rl` 和 `vertical-lr` 的行与块排列方向。日文在横排与竖排中可以使用同一文本；`horizontal-tb` 是初始值。EPUB spine 定义内容文档的默认阅读顺序，而不是要求程序根据页面坐标重新排序字符。[E1][E2]

**建议／推断，未实测：** 对普通可重排 EPUB，按 spine、再按正文 DOM 的逻辑顺序提取，输出横排日文词块即可。不要因为原书 `page-progression-direction="rtl"` 或 CSS 为 `vertical-rl` 就反转字符串、段落或 spine。源文字语言应保留为日文，分词、词形处理与释义质量另行验证。[E1][E2][L1][L2]

### `rt` 是注音，`rp` 是回退标点，不是正文词

**来源事实：** HTML 的 ruby 结构把 base text 与 annotation 分开；`rt` 表示注释，`rp` 表示不支持 ruby 时显示的回退内容。EPUB 3.3 也单列了 `rp` 的使用限制。[E1][E3]

例如，概念上的 `<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>` 若直接取后代文本，会混成“漢かん字じ”。这不是应送入正文分词的“漢字”。当前 `.textContent` 用法存在这一风险；**此例是规范与代码推导，不是本轮运行结果**。[E3][L1]

**建议／推断，未实测：**

- 正文抽取保留 base 的原有顺序，不把 `rt`、`rp` 拼进正文；不能删除整个 `ruby`，否则连汉字一起丢失。
- 若首阶段只做词义注释，可明确不保留原书注音。若要保留，应单独存储 base 与 reading 的关联，再决定注音、原词、词义三者的显示位置，不能把 reading 冒充译义。
- 有些书使用旧式 `rb`、`rtc`、多个 `rt` 或组 ruby；不能假设一个汉字只对应一个假名。复杂结构与正文偏移映射需要专门样本验证。
- 保留段落、诗行、标点边界，不应把所有 `<br>` 都压成普通空格。横排后的省略号、数字、括号及日文断行也需要视觉核对。[E2][E3][L1]

### 固定版式不等于扫描书

**来源事实：** EPUB 支持 XHTML 与 SVG 内容，固定版式可由图片或 CSS 定位实现。`rendition:layout="pre-paginated"` 表明固定版式，而不证明不存在文字；单个 spine item 也可以覆盖布局设置。W3C 的固定版式无障碍资料明确指出：页面上的视觉顺序可能与导出 DOM 的堆叠顺序不同。[E1][E4]

**建议／推断，未实测：** 入口应分别判断“版式”和“文本可用性”：

- 可重排 + 正文文本：适合转横排逐词注释。
- 固定版式 + 可提取文本：有条件可用，先核对阅读顺序、分栏、脚注和图注；不能承诺抽文本即还原语义。
- 图片为主 + 少量标题／隐藏文本：先判断文本层是否完整且可信。
- 纯图片且没有正文文本：只能保留图片浏览或明确提示不支持文字注释，不能自动声称需要／已经完成 OCR。[E1][E4][L1]

## 图文混排与纯图 EPUB：三条产品选择

**源码事实：** 当前解析器不将 `img`、SVG image 或资源引用输出到 `Book`。纯图片 XHTML 若没有所选标签内的非空文本，该章节被跳过；所有章节都为空则报“EPUB 未提取到正文段落”。`img` 的 `alt` 属性也没有专门抽取。[L1][L2]

以下均为**建议／推断，未实测**：

1. **文本优先、明确告知丢图。** 保持现有字符串模型，适合正文以文字为主的书。导入摘要提示忽略图片，纯图或文本不足时给出明确状态；不能悄悄用封面标题替代整本书。
2. **保留图文顺序，图片不参与分词。** 需要能够表达文本块、图片块、图注及资源引用的内容模型，或等价的图片位置映射。图片可懒加载，需管理资源路径、Blob 生命周期、尺寸与阅读分页。现有导出、缓存和分页也要评估，不是只在解析器里追加几个 `img`。[L1][L2][L5]
3. **图片浏览 + 独立 OCR 工作流。** 先保留原图，再由用户明确触发 OCR 或导入外部校对文本。OCR 的语言、竖排识别、阅读顺序、注音分离、置信度及费用需要另立范围。图像上的字不可因“文件是 EPUB”就当作可直接分词的字符串。[E1][E4]

若选择保留资源，建议默认只加载包内已解析的安全资源，不把书内脚本、事件属性或任意远程 URL 直接注入应用。Foliate.js 维护者特别警告 EPUB 脚本与同源 Blob 渲染风险，要求 CSP；解析出文档与安全展示文档是不同步骤。[M1]

## MOBI7、KF8/AZW3：本地转换先行，直接解析可候选

### 格式边界与两个文件头观察

**来源事实：** Foliate.js 支持旧式 Mobipocket、KF8/AZW3 和包含两者的 combo MOBI。Calibre FAQ 称旧式格式为 Mobi6；文件头 version 7 不应被误认成 KF8，KF8 对应 version 8 及相关结构。后缀本身不足以确定内部格式。[M1][M2][M6]

**本地文件头观察，不是解析成功证明：** 只读 `~/Downloads` 下指定文件的 PDB 头及 record 0 的前 264 字节。按 Foliate.js 中 `PDB_HEADER`、`PALMDOC_HEADER`、`MOBI_HEADER` 的偏移解释。[M2]

| 样本简称 | 文件字节数 | PDB 标记 | record 0 偏移 | MOBI version | compression | encryption |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 牧歌 `.mobi` | 474091 | `BOOKMOBI` | 1072 | 7 | 1 | 0 |
| 水手比利·巴德 `.azw3` | 887832 | `BOOKMOBI` | 1632 | 8 | 2 | 0 |

两个 record 0 均含 `MOBI` 标记；compression 1 对应不压缩，2 对应 PalmDOC 压缩；encryption 0 是该头部未标记加密。**未解压正文、未检查全书结构或 combo 的第二部分，也未确认章节、插图、编码和阅读质量。** 没有向第三方上传书籍正文。文件头观察仅支持把它们作为旧式 MOBI 与 KF8 的候选验证样本，不能写成“已兼容”。[M2]

### 具体候选与维护证据

| 候选 | 来源确认的能力与许可证 | 浏览器及体积边界 | 本项目判断，未实测 |
| --- | --- | --- | --- |
| **Foliate.js `mobi.js`** | 上游声明支持 MOBI、KF8/AZW3、combo；MIT。原生 ES modules，无构建步骤；目标是最新 Chromium、Firefox、WebKitGTK。`mobi.js` 在 2026-04-03 有修复提交，属于仍有维护证据的首选候选。[M1][M2][M3] | GitHub contents API 报告 `mobi.js` 原始源文件为 **47716 字节**，不是 gzip 后体积、完整阅读器体积或整合增量。MOBI 一次解压全部文本；KF8 尽量按需解压，但 HUFF/CDIC 可能慢。资源按需加载，压缩字体需外部解压函数；README 推荐 fflate。[M1][M2][M4] | 只评估解析模块与现有文本模型的适配，不必替换整个阅读器。需固定上游提交、拒绝加密输入、核对文本顺序、限制内存与任务耗时。README 明说 API 不稳定、没有正式 release，不能称为无风险即插即用。[M1] |
| **libmobi** | C99，读 MOBI、KF8/AZW3；LGPL-3.0-or-later。官方提供 native 库和 CLI，支持 Linux、macOS、Windows 等。最新 release API 返回 v0.12，发布于 2024-06-17；默认分支最新提交查询为 2024-10-29。[M5] | 官方 README 没有交付浏览器 JS/WASM 构建。把 C 库编成 WASM 是额外移植假设，不能称为已有官方浏览器兼容。v0.12 源码压缩包为 2653654 字节，**不是 WASM 下载体积**；本轮无法给出 browser bundle 或内存上限。[M5] | 作为原生方案参考，而非当前静态站首选。相较 Foliate.js，近期维护证据较弱；LGPL 分发与重新链接义务需要单独审查。库中的加密相关能力不纳入本项目范围。 |
| **Calibre `ebook-convert`** | 官方当前手册列出 MOBI、AZW3 输入与 EPUB 输出，支持旧式 MOBI 与 KF8；GPL v3。它是本地应用及 CLI，不是浏览器依赖。[M6][M7] | 无需把转换器加入 Web bundle，但用户需在本机安装与使用。官方未保证转换所得 EPUB 总是符合规范；转换成功也不保证本项目选择器能完整提取。[M6] | **推荐作为先行路线**：用户在本地把合法、DRM-free 输入转成新 EPUB，再导入。既不上传全书，也不为静态站引入 native 服务。此轮没有安装、执行或验证转换。 |

对于 Foliate.js，Context7 的自动生成 API 摘要把 `open()` 描述为返回 parser 本身，但当前上游源码实际返回初始化后的 `KF8` 或 `MOBI6` 对象。**后续设计以固定提交的源码及正式 README 为准，不把自动摘要当作已验证 API。** 这也是目前不提供可直接复制整合代码的原因。[M1][M2]

**规模限制，建议／推断，未实测：** 上游“无需整文件载入内存”不等于“所有格式都是流式文本解析”。大书需要同时考虑压缩输入、解压文本、DOM、词块和释义缓存。若最终仍生成全书 `paragraphs: string[]`，解析器的按需优势会被部分抵消。当前没有足够证据给出固定“最大 N MB”，更不能把两个不到 1 MB 的样本外推到大型书库。[M1][M2][L2]

### KFX 与 DRM 不应混入承诺

**来源事实：** Calibre 的 KFX 元数据模块使用 `CONT`、`ENTY` 和 Ion 结构，与 MOBI 的 PDB/`BOOKMOBI` 结构不同；Calibre 当前 FAQ 的转换输入列表没有 KFX。读 KFX 元数据不等于支持完整 KFX 转换；Foliate.js 支持列表也未列 KFX。[M1][M2][M6][M8]

**建议：** 首轮直接导入范围若获批，应明确写作“DRM-free MOBI 与 KF8/AZW3”，不写“所有 Kindle 文件”。遇到加密或不支持容器，应说明边界，并引导用户获取有权使用的 DRM-free 版本。这里不研究或提供 DRM 绕过工具、插件或步骤。Calibre 的 DRM 官方说明也明确其不支持打开或转换受 DRM 保护的书。[M9]

### DjVu 可能已有文字层，OCR 是另一条工作流

**来源事实：** DjVuLibre 的 `djvutxt` 用于提取 hidden text，通常由 OCR 生成，并可输出文字位置层级。Calibre 明确仅支持转换包含嵌入文本的 DjVu。[J1][M6]

**建议／推断，未实测：** 将 DjVu 分成“已有可信文字层”和“只有页面图像”。前者可考虑外部提取后导入 TXT/EPUB，但须核对顺序与识别错误；后者需要独立 OCR。不能说所有 DjVu 都只能 OCR，也不能因为 Calibre 支持 DjVu 就说当前项目具备 DjVu 或 OCR 能力。[J1][M6][L4]

## Chrome MV3：以页面原位插注为主，侧栏不替代需求

### 推荐职责划分，尚未实现

**来源事实：** Content script 能读写网页 DOM，并通过消息与扩展通信；默认在 isolated world 运行，但与页面共享 DOM。隔离的是 JavaScript 执行环境，不是自动隔离所有 CSS 和页面结构。[C1]

**建议／推断，未实测：**

- 用户点击扩展按钮后激活当前页，再显示页内的“逐词注释／还原”按钮。首阶段优先 `activeTab` 与 `scripting`，而不是默认读取所有网站；若需要长期自动显示页内按钮，再由用户授予特定站点权限。[C1]
- Content script 管理正文范围、词与 DOM 位置映射、行间词义、选词交互和恢复。工具按钮可放在自有 Shadow DOM 中，插入正文的注释使用局部样式和前缀，避免把独立阅读器的整套全局 CSS 注入网站。Shadow DOM 是减少样式耦合的设计选择，不应宣传为恶意网页无法干预的安全边界。[C1]
- 扩展设置页管理 API endpoint、语言、发送范围和密钥。Service worker 负责网络与缓存协调，content script 不接收完整密钥，也不经页面 `localStorage` 保存密钥。[C2][C3]
- 后台只接收预定义的查词／释义消息，校验发送者、请求长度与目标服务；不能让页面或 content script 把任意 URL 交给后台当通用跨域代理。[C2]

### 网络与密钥：避免复用网页 localStorage

**来源事实：** Content script 的跨域请求仍受页面来源限制，即使扩展拥有 host permissions；扩展 service worker 或扩展页面在获得对应 host permissions 后可访问跨域服务。自定义 `connect-src` 仍需允许目标地址。[C2]

Chrome 文档不推荐扩展使用 Web Storage：content script 与宿主页共享 Web Storage，而 service worker 不能使用它。扩展 `storage.local` 默认向 content script 暴露，可通过 `setAccessLevel` 限制为 `TRUSTED_CONTEXTS`。`storage.session` 默认不向 content script 暴露，保存在内存，扩展禁用、重载、更新或浏览器重启会清除；官方建议敏感数据使用 session，而不是 sync。[C3]

**建议／推断，未实测：** 默认会话保存密钥；用户主动选择记住时才使用受限的扩展本地存储，并清楚说明这不是硬件密钥库，不承诺抵抗本机或扩展自身被攻破。不要默认同步密钥，不写入 DOM、日志或导出文件。网络权限不替代服务商鉴权、配额或用户的数据发送同意。[C2][C3]

### 动态 DOM、还原与隐私是核心兼容性工作

以下是**建议／推断，未实测**，不是 Chrome 提供的现成“自动翻译 API”。依据是 content script 的共享 DOM 能力及其权限边界。[C1][C2]

- 优先用户选择的段落或可见正文，再考虑整篇；默认跳过 `input`、`textarea`、`select`、`contenteditable`、代码区、脚本、样式、隐藏内容及扩展自己的注释节点。对邮箱、账户、支付、医疗等敏感页面，站点级默认禁用比“猜测某元素是否敏感”更可靠。
- 原文跨 `em`、`a` 等节点时，分词需建立文字到 DOM 位置映射，不能用整页 `innerHTML` 重写。保留原有链接、事件、选择与辅助技术语义。
- `MutationObserver` 可作为增量处理手段，但需忽略自写入、批量去抖、避免重复注释。SPA 导航、懒加载与虚拟列表可能删除或复用节点，旧请求返回前应确认内容仍是同一版本。
- 恢复只撤销扩展拥有的修改。若宿主页已经更新，不能用旧快照覆盖用户或网站的新内容。无法安全恢复时应停止该块并说明，而不是强制回填整页。
- 第一阶段不承诺跨域 iframe、封闭 Shadow DOM、浏览器内部页面、商店受限页面、Canvas 或 PDF 阅读器里的全部内容都可注释。`all_frames` 也只覆盖符合相应匹配与授权条件的 frame。[C1]
- 在发出 LLM 请求前说明发送哪些文本、给哪个服务；避免默认发送全页、表单值或整本书。响应仅当作文本／结构化释义使用，不作为 HTML 或代码执行。[C2]

### Service worker 不会永久常驻

**来源事实：** Chrome 文档列出常见终止条件：30 秒无活动、单个事件或 API 请求处理超过 5 分钟、`fetch()` 响应超过 30 秒才到达；事件与 API 调用会影响闲置计时，部分 API 有版本相关例外。全局变量会随 worker 终止丢失。[C4]

**建议／推断，未实测：** 不把“整页注释任务、所有词典和待返回 LLM 请求”只放在后台全局变量。使用分块、超时、可取消与可恢复的状态；持久化必要任务信息，不持久化不必要的原页隐私文本。需单测及浏览器验证 worker 被终止、页面导航、网络失败和重试时不会重复计费或插入过期释义。不要用无休止保活来掩盖生命周期设计。[C3][C4]

### 远程词典数据可以讨论，远程执行代码不能偷换概念

**来源事实：** MV3 的远程托管代码限制覆盖扩展包外加载执行的 JavaScript、WASM；官方明确区分 JSON、CSS 等数据资源。isolated-world content script 的 CSP 也阻止 `eval()` 与外部脚本，MAIN world 则受页面 CSP。[C1][C5]

**建议／推断，未实测：**

- 分词器、解析器、请求和 UI 逻辑随扩展打包。不能从 CDN 下载 JS/WASM 后执行，也不能把远程“配置”解释为通用程序以改变功能。
- 词条 JSON、释义 API 响应与被本地既定逻辑消费的字典数据可以走下载路线；需固定数据 schema、校验版本与完整性、保留离线和下载失败提示。数据能下载不代表任意字典有再分发许可。
- 小型或首语言字典随包：首用离线，安装包较大，词典更新伴随扩展包更新。按语言下载：安装包较小，但需要网络、权限、缓存、清理及词典授权审核。
- `storage.local` 默认 10 MB，可申请 `unlimitedStorage`；不应把大型词典或整本书塞进适合设置的 sync 存储。较大数据可单独评估 IndexedDB 等存储，不能把“unlimited”理解为无限内存或无设备限制。[C3][C4]

### 原位插注与可选侧栏的差别

**原位插注**保留用户正在读的网站，并把词义放在原词旁，直接满足需求；代价是页面布局、交互和恢复复杂。**可选侧栏**在扩展自有页面里重排选中的文本，较易控制版式，但用户要在原页与副本之间切换，也不再是原文逐词插注。[C1][C2]

因此建议只把侧栏用于设置、详细释义或用户主动选择的兼容模式；若打算以侧栏作为首阶段交付，必须先征求用户同意，不能默默替换目标。

## 分发：ZIP 内测可行，商店不是全自动免审核

### 仓库 ZIP、构建 ZIP 与 CRX 不是同一种交付

**来源事实：** Chrome 官方支持在 `chrome://extensions` 开启 Developer mode 后，通过 Load unpacked 选择扩展目录。macOS、Windows 的普通外部安装路径要求 Chrome Web Store；Linux 的自托管和企业策略另有规则。[D1][D2]

**建议／推断，未实测：** 若未来实现扩展，可提供包含根目录 `manifest.json` 和已构建脚本的 ZIP，用户解压后加载。不应把目前 npm workspace 的源仓库 ZIP 描述成“下载就能安装”，也不应将 GitHub CRX 描述成普通 macOS、Windows 的一键安装途径。企业托管例外不适合作为普通读者的安装说明。[D1][D2][L3]

GitHub Releases 支持发布说明与二进制附件，也自动提供 tag 对应源码压缩包。因此发布构建 ZIP 在平台能力上可行，但本轮没有验证本仓库发布权限、生成扩展包或创建 release；源码 archive 和安装用 artifact 应清楚区分。[D6]

### 当前 Chrome Web Store 自动化边界

**来源事实，按 2026-09-17 获取的官方资料：**

- 需要开发者注册、接受协议并付一次性注册费。当前注册文档正文确认“一次性”，未在正文列金额；2020 官方 Chromium 公告的搜索索引明确列 **US$5.00**，但此次抓取公告正文未返回收费段落，也没有进入付款页面。因此 **5 美元只能作有官方历史依据的预算参考，当前账户应付金额／币种尚未现场确认**，不伪称 2026 已付款核验。[D3][D7]
- 官方 API 指南当前展示 **v2**：Google Cloud 项目启用 Chrome Web Store API，配置 OAuth consent/client，经授权取得访问令牌与 refresh token，scope 为 `https://www.googleapis.com/auth/chromewebstore`；请求需要对应 publisher ID 与扩展 ID。[D4]
- 发布或更新要求 Google 账户开启两步验证；新项目发布前仍须在 Developer Dashboard 完成 Store listing 与 Privacy 信息。上传新版本要增加 manifest version。`publish` 是送审，审核通过才发布，不是调用即上架。[D4]
- API 可查上传／发布状态、上传现有 item 的更新、提交发布、取消待审、在符合条件时调整灰度比例。可见性变更有手工发布限制。指南总述虽称可创建项目，但本文不据此承诺 v2 可自动完成首次建项和所有商店资料；本轮核实的 endpoint 是现有 item 工作流。[D4]
- 官方还支持把 Google Cloud service account 关联到 publisher，适合 CI；当前文档说每个 publisher 可添加一个。它减少人工 OAuth 参与，但不消除账户授权、资料与审核门槛。[D5]
- 审核同时使用人工与自动系统，时间不确定；官方说多数几天，也可能几周，广泛 host permissions、新开发者或复杂代码可能增加时间。不能承诺某日必定获批。[D8]

**建议：** 若后续获准分发，先完成本地构建 ZIP 与安装说明，再选择是否进入商店；OAuth 或服务账号凭据只进入受限 CI 凭据管理，不进入仓库、扩展包或用户的 LLM 设置。GitHub 与商店发布都需要另行授权。[D4][D5][D6]

## Userscript：适合受限试用，不承诺等同扩展隔离

**来源事实：** Tampermonkey 提供 `GM_setValue`／`GM.setValue` 的脚本存储，`GM_xmlhttpRequest`／`GM.xmlHttpRequest` 网络 API 和 `@connect` 域名控制。`@grant none` 会关闭 sandbox；`@sandbox` 与浏览器决定 MAIN、ISOLATED、USERSCRIPT 等执行环境，文档描述了不同 CSP 回退行为，不能概括为“用户脚本总能绕开 CORS/CSP 且完全隔离”。[U1]

**建议／推断，未实测：** Userscript 也可显示页内按钮并插入词义，适合少数站点、明确管理器版本的早期试用。密钥用 GM 存储而非页面 localStorage，限定 `@connect`，避免把密钥放在页面脚本、DOM 或 `unsafeWindow`。GM 存储不是对脚本自身、管理器或本机攻击的绝对秘密保险箱。[U1]

与 MV3 相比，它把安装、权限提示、后台能力、CSP 行为和更新信任交给用户脚本管理器；动态 DOM、恢复与隐私问题并未消失。现有模块也不能假定原封不动运行在所有管理器中。因此建议以 MV3 为正式入口方向，Userscript 仅在用户接受这些限制时作为独立选择，而非省略工程边界的“免费替代品”。[U1][C1][C2]

## 下一阶段的决策与证明条件

以下是建议，不包含工期承诺，也不表示开始实施。

1. **先确认 EPUB 文本政策。** 横排是既定目标；还需决定是否保留原注音、怎样处理诗行和嵌套段落。证明条件是清洁正文不含 `rt/rp` 污染，顺序正确，并且已标注的文字可追溯回原文。[L1][E3]
2. **决定图片等级。** 选择“明确丢图”“有序保图”或“图片浏览 + 后续 OCR”。后两者需要评估模型、分页、缓存和导出，而不是提前承诺。[L2][L5]
3. **先让本地 Calibre 转 EPUB 成为候选用户流程。** 如用户更重视一次拖入，再单独批准 Foliate.js 适配调查。证明条件包括 DRM-free MOBI7、纯 KF8、combo、不同压缩、大书、损坏输入与资源释放；现有两个文件头不足以替代这些验证。[M1][M2][M6]
4. **网页入口先锁定原位体验及站点范围。** 确定首批普通文章站、默认注释范围、密钥保存方式、LLM 文本发送同意与还原行为。证明条件包括动态加载、重复开关、SPA 导航、编辑区跳过、无密钥泄漏及 worker 重启后的正确状态。[C1][C2][C3][C4]
5. **最后选择分发与词典策略。** 内测是否接受 Developer mode？是否已有 publisher、付款和两步验证？词典是否可随包再分发、语言包多大、是否允许联网下载？商店注册费当前应付金额需要在实际注册界面由账户持有人确认。[D1][D3][D4][C3][C5]

本轮未证明：任何新格式在当前 UI 中成功导入；任意竖排书的正确分词；大书性能；图文分页；网页按钮或恢复功能；扩展安装包；商店审核通过。后续综合结论应把 verifier 的实际证据与本文的来源研究分开呈现。

## 来源与本地定位

所有网络来源均于 2026-09-17 检索。Context7 用于查询 Foliate.js、Calibre、Chrome Extensions、Tampermonkey 和 EPUB 文档；libmobi 未解析到对应库，改查其官方仓库。DeepWiki 仅用于定位 Foliate.js，一手 README、源码和 GitHub API 用于支撑最终结论。

### 本地源码

- [L1] [`packages/web/src/ingest/epub.ts`](../../packages/web/src/ingest/epub.ts)：`parseEpub` 7–59 行，`extractXhtml` 63–94 行。
- [L2] [`packages/web/src/types.ts`](../../packages/web/src/types.ts)：`BookChapter` 与 `Book`，67–80 行。
- [L3] [`package.json`](../../package.json) 与 [`packages/web/package.json`](../../packages/web/package.json)：workspaces、scripts、dependencies。
- [L4] [`packages/web/src/ui/app.ts`](../../packages/web/src/ui/app.ts)：397–434 行，文件后缀过滤和实际分流。
- [L5] [`packages/web/src/styles.css`](../../packages/web/src/styles.css)：1–20 行，阅读分页与测量几何契约说明。

### EPUB 与文字结构

- [E1] W3C：[EPUB 3.3](https://www.w3.org/TR/epub-33/)，spine、XHTML/SVG、CSS、fixed layout、layout overrides、`rp`。
- [E2] W3C：[CSS Writing Modes Level 3](https://www.w3.org/TR/css-writing-modes-3/#block-flow)，第 3 节与 `writing-mode`。
- [E3] WHATWG：[HTML — ruby、rt、rp](https://html.spec.whatwg.org/multipage/text-level-semantics.html#the-ruby-element)。正文文本的后代顺序语义另见其引用的 [DOM textContent](https://dom.spec.whatwg.org/#dom-node-textcontent)。
- [E4] W3C EPUB 工作组源码：[Fixed-layout accessibility techniques](https://github.com/w3c/epub-specs/blob/main/wg-notes/fxl-a11y-tech/index.html)，堆叠顺序与阅读顺序；经 Context7 返回相关段落。

### Kindle 格式与 DjVu

- [M1] Foliate.js 官方：[README](https://github.com/johnfactotum/foliate-js/blob/main/README.md)，支持格式、稳定性、接口、性能、浏览器、CSP、许可证。
- [M2] Foliate.js 官方：[mobi.js](https://github.com/johnfactotum/foliate-js/blob/main/mobi.js)，文件头、压缩类型、combo 识别、`open()` 返回值及资源处理。
- [M3] Foliate.js：[2026-04-03 MOBI 修复提交](https://github.com/johnfactotum/foliate-js/commit/9a676796f728347b0127162079c13d23a0f7fee8)。
- [M4] GitHub 官方仓库 API：[mobi.js contents](https://api.github.com/repos/johnfactotum/foliate-js/contents/mobi.js)，`size=47716`。
- [M5] libmobi：[README](https://github.com/bfabiszewski/libmobi/blob/public/README.md)、[v0.12 release](https://github.com/bfabiszewski/libmobi/releases/tag/v0.12)、[最新 release API](https://api.github.com/repos/bfabiszewski/libmobi/releases/latest)、[默认分支最后提交查询](https://api.github.com/repos/bfabiszewski/libmobi/commits?per_page=1)。
- [M6] Calibre 官方：[FAQ](https://manual.calibre-ebook.com/faq.html)，支持输入输出、MOBI、DjVu、EPUB 合规限制、许可证。
- [M7] Calibre 官方源码：[conversion CLI](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/conversion/cli.py)，`ebook-convert input_file output_file [options]`，经 Context7 核实；本文未运行该命令。
- [M8] Calibre 官方源码：[KFX metadata parser](https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/metadata/kfx.py)，`CONT`、`ENTY` 与 Ion。
- [M9] Calibre 官方：[DRM](https://manual.calibre-ebook.com/drm.html)，由官方 FAQ 的 DRM 说明关联。
- [J1] DjVuLibre 官方：[djvutxt manual](https://djvu.sourceforge.net/doc/man/djvutxt.html)，hidden text 与文字位置输出。

### Chrome 平台、分发与 Userscript

- [C1] Chrome 官方：[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)，isolated world、DOM、注入、frame、CSP。
- [C2] Chrome 官方：[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)，host permissions、content script 来源限制、消息代理安全与文本插入。
- [C3] Chrome 官方：[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)，Web Storage 限制、local/session/sync、配额、`setAccessLevel`。当前文档展示 `browser.storage`，本文用 `storage.*` 指同一官方 API 功能，不假定现有代码已迁移命名空间。
- [C4] Chrome 官方：[Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)，终止条件、状态持久化、版本差异。
- [C5] Chrome 官方：[Remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)，JavaScript/WASM 与 JSON/CSS 数据的区分。
- [D1] Chrome 官方：[Hello World — Load unpacked](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。
- [D2] Chrome 官方：[Alternative installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)，macOS/Windows、Linux、企业策略边界。
- [D3] Chrome 官方：[Register your developer account](https://developer.chrome.com/docs/webstore/register)，一次性注册费与账户要求。
- [D4] Chrome 官方：[Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)，本次页面显示更新日期 2026-09-16，v2、OAuth、publisher、上传与审核。
- [D5] Chrome 官方：[Service accounts](https://developer.chrome.com/docs/webstore/service-accounts)，publisher 关联、CI 鉴权与密钥风险。
- [D6] GitHub 官方：[About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)，附件、源码压缩包与权限。
- [D7] Chromium 官方：[2020 developer dashboard and registration flow announcement](https://blog.chromium.org/2020/03/new-developer-dashboard-and.html)，US$5.00 的历史官方索引依据；本轮页面提取缺失正文，不作为当前结算金额证明。
- [D8] Chrome 官方：[Review process](https://developer.chrome.com/docs/webstore/review-process)，审核流程、耗时与影响因素。
- [U1] Tampermonkey 官方：[Documentation](https://www.tampermonkey.net/documentation.php)，`GM_setValue`、`GM_xmlhttpRequest`、`@connect`、`@grant`、`@sandbox`；经 Context7 查询返回官方各节。
