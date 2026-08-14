# 开发接手说明

最近更新：2026-08-15

## 当前情况

- 当前稳定版收口为 `v0.5.0`，Release 应同时提供 EXE、MSI、Updater `.sig`、`latest.json`、浏览器扩展 ZIP 和质量报告。
- Windows 桌面端已经具备翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份、WebDAV、单实例、托盘和自动更新闭环。
- Native Messaging v1、单 EXE Host、Windows 安装集成、桌面私有 IPC、配对授权和 `translate` / `cancel` / `add_word` 已完成；固定开发 ID 的 Manifest V3 扩展通过 Release ZIP 分发，可由用户通过 `activeTab` 在当前页注入划词浮层，不声明持久网站权限。商店正式 ID 与上架流程后续单独处理。
- v0.5.1 的 DOCX 用户闭环已经接通安全导入、Checkpoint 恢复、有界翻译队列、安全重试、译文/双语重建、发布前取消和不覆盖原子导出；发布故障矩阵与 Release 自动化门禁均已收口。2026-08-15 又使用 5 份可公开复核的真实政府 DOCX 完成双模式 round-trip 与 LibreOffice 逐页验收，并修复译文跨原始 Run/控件边界时拆开拉丁单词的问题；当前只剩 Microsoft Word 真实文档逐页验收和版本发布。
- 最新已合并复审基线为 `master` / `9c295ed`（PR #94）。PR #92 已修复真实 DOCX 纯译文跨 Run/控件边界拆开拉丁单词的问题，PR #93 已记录 WPS 补充兼容验收，PR #94 已加入严格拒绝 WPS 冒充的 Microsoft Word 验收执行器；各 PR 与合并后 `master` CI 均通过。当前前端门禁为 60 个测试文件、305 项测试通过；Rust 全量门禁为 149 项单元测试通过、2 项显式视觉语料测试忽略，另有 2 项生命周期、7 项 Native Host 进程和 2 项注册测试通过；严格 Clippy 通过。全仓 `cargo fmt --check` 仍会被既有 `db.rs`、`ocr.rs` 格式差异阻断，后续增量只格式化所改文件，不夹带无关改动。
- 当前包体仍在门槛内：最大桌面 JavaScript chunk 251.25 KiB / 300 KiB，浏览器扩展 34.33 KiB / 64 KiB。Browserslist 数据已约 6 个月未更新，作为 P2 维护项在 DOCX 发布门槛之后处理；新增功能必须继续复核主包增长。
- 下一条产品主线收缩为 `v0.5.1` DOCX 文档翻译 MVP；PDF、浏览器商店上架、Authenticode 和无关大型重构均不与本版本混合。
- 2026-08-11 已实际生成 NSIS/MSI 审计包，确认两种安装器均接受 Native Host 集成；最小扩展生产包约 9.17 KiB，门槛为 64 KiB。完整测试、包体、Clippy 和质量报告仍由本增量的本地门禁与 GitHub CI 复核。

## 接手后按顺序处理

1. 按 [`DOCX_REAL_DOCUMENT_ACCEPTANCE.md`](DOCX_REAL_DOCUMENT_ACCEPTANCE.md) 使用 `npm run audit:docx:word` 验证真实 Microsoft Word 身份、隔离导出本轮 5 份真实 DOCX 的译文版与双语版，并完成逐页视觉验收；LibreOffice/WPS 侧已经完成，不能替代 Word 门槛。
2. 视觉门槛通过后统一提升 `0.5.1` 版本、更新发布文档并执行安装、升级、Updater 和资产完整性验收。

当前执行前置检查（2026-08-15）：忽略目录 `.docx-acceptance/docs` 已放入 5 份来自 NSW Crown Lands 官方模板页的真实公开 DOCX，最终输入目录 `.docx-acceptance/public-outputs-word-boundary-20260815-001029` 已具备 5 组译文版/双语版共 10 份成品；LibreOffice 26.2.5.2 与 WPS Office 12.1.0.28043 均已完成双模式逐页验收。本机 `npm run audit:docx:word -- -ProbeOnly` 会按预期拒绝当前 WPS COM 身份，PATH/标准安装位置仍未发现 Microsoft Word；WPS 结论只扩大兼容性证据，不能替代剩余 Word 门槛。

当前审计结论和下一入口见 [`DEVELOPMENT_AUDIT_2026-08-14.md`](DEVELOPMENT_AUDIT_2026-08-14.md)，唯一执行顺序、逐步验收目标和发布门槛见 [`V0.5.1_DOCX_CLOSEOUT_PLAN.md`](V0.5.1_DOCX_CLOSEOUT_PLAN.md)。历史范围背景见 [`DEVELOPMENT_PLAN_2026-08-10.md`](DEVELOPMENT_PLAN_2026-08-10.md)，Native Messaging 的既定安全约束见 [`NATIVE_MESSAGING_PROTOCOL.md`](NATIVE_MESSAGING_PROTOCOL.md)。

## 2026-08-12 接手状态更新

- `translate` / `cancel` / `add_word` 已从 Manifest V3 service worker 经单 EXE Native Host、受认证桌面 IPC 接入现有桌面核心；请求保留精确 Origin 与 request ID，翻译支持同端口并发取消，收藏只返回最小词条 ID。
- 桌面前端通过显式 ready 状态避免 WebView 监听器未挂载时产生 65 秒假等待；Host 断开、撤销授权和界面卸载会取消在途任务。
- content script 与 Shadow DOM 隔离的划词浮层已完成，采用用户点击弹窗后单页注入、刷新失效的 `activeTab` 模式；翻译成功后才允许把所选文字和译文写入桌面生词本，不默认收集页面上下文。完整 Chrome / Edge 人工安装生命周期烟雾和商店上架作为浏览器独立后续工作；v0.5.1 只推进 DOCX 文档翻译闭环。
- Native Host 子进程回归已覆盖真实 EXE 的 stdin/stdout framing、受认证桌面命名管道、翻译取消与生词本写入，并固定 Origin/request ID 不串线；剩余缺口属于 Chrome / Edge 扩展加载、安装生命周期和可视交互验收。
- 扩展 Manifest、弹窗、划词浮层、无障碍标签和固定状态提示已接入 Chromium i18n，随浏览器语言提供英文与简体中文；弹窗和浮层均跟随系统浅色/深色主题，语言键引用、语言包完整性、主题契约和构建产物一致性纳入 64 KiB 扩展审计。
- 隔离浏览器运行时烟雾已在真实 Edge 中加载固定 ID 的 MV3 扩展，验证 service worker、英文/简体中文弹窗 DOM 和主要控件，并已加入 Windows CI；正式 Chrome 137+ 的命令行加载限制会被识别并保留为 `chrome://extensions` 人工验收，不把 `ERR_BLOCKED_BY_CLIENT` 误记为通过。
- 运行时烟雾可通过显式 `--require-desktop` 点击真实 Edge 弹窗的连接检查，验证浏览器 → Native Host → 受认证桌面 IPC 的 `hello` / `ping` 闭环，并核对桌面版本、配对状态和往返耗时；默认模式仍不隐式依赖桌面进程。
- Edge 运行时烟雾已在隔离普通 HTTP 页面执行生产 content script，验证 Shadow DOM 浮层、点击“译”前不发送所选正文、点击后才创建翻译请求，以及刷新后注入消失；工具栏点击产生的 `activeTab` 临时授权无法由调试接口真实复现，继续作为发布候选人工门槛，不为自动化扩大 manifest 权限。
- 划词运行时烟雾已覆盖进行中翻译的取消交互：`native-cancel` 必须复用原 `native-translate` 的 task ID，随后浮层显示已取消并隐藏取消按钮。该项固定浏览器页面侧的关联契约；真实桌面任务终止仍由 Native Host 子进程回归覆盖，发布候选继续人工复核二者组合链路。
- 划词成功路径已在真实 Edge 页面执行生产 content script 验证：译文成功后才显示复制与收藏，收藏消息严格只包含所选原文和译文，不携带页面 URL、上下文或其他字段，并在成功回调后进入已收藏状态。真实桌面授权与数据库落盘仍由 Native Host 子进程回归覆盖，发布候选人工复核组合链路。
- 选区资源上限已在真实 Edge 页面验证：32 KiB + 1 字节的选区只显示超限提示，不创建翻译启动器或面板，且不会向扩展后台或桌面端发送任何消息；32 KiB 阈值继续由生产 content script 和扩展审计共同固定。
- 划词浮层的窄视口定位已在真实 Edge 页面验证：在 420×320 页面视口、100% / 150% / 200% 页面缩放和四角选区组合下，“译”启动器与成功态翻译面板均按 `visualViewport` 完整收纳；该回归固定生产 content script 的缩放与边缘定位契约，正式 Chrome 的工具栏注入和可见交互仍保留为发布候选人工门槛。
- 划词翻译失败态已在真实 Edge 页面按英文与简体中文验证：未配对和 Native Host 不存在会分别显示本地化安全提示，取消、复制和收藏保持隐藏，原始 Host 错误不会写入页面浮层；真实撤销授权和桌面进程退出仍由发布候选组合链路复核。
- 生词本收藏失败态已在真实 Edge 页面按英文与简体中文验证：旧授权缺少 `wordbook` 能力和 Native Host 不存在会分别显示本地化安全提示，收藏按钮恢复为可重试状态，请求仍只包含所选原文和译文，原始 Host 错误不会写入页面浮层；真实撤销授权和数据库落盘仍由发布候选组合链路复核。

## 2026-08-13 DOCX 增量交接状态

- PR [#64](https://github.com/Longyuyeee/long_TranslateSoftware/pull/64) 已通过真实 DOCX 验收和 CI 并合并；后续严格按阶段 2 Checkpoint 持久化推进，不提前混入翻译队列、重建、导出、PDF 或 UI。
- Rust 导入命令覆盖正文、标题、列表、表格单元格、超链接、多节页眉页脚和自定义部件名；验证 OPC 内容类型与 Relationship，只读取被引用部件。单文件上限 50 MiB、单段 32 KiB、总文本 24 MiB、最多 20,000 段、检查结果最多 48 MiB，并限制 ZIP 路径、重复 Entry、条目数、展开体积、XML 大小和压缩比。
- 错误使用稳定的 `unsupported-format`、`input-too-large`、`invalid-input` 和 `parse-failed` 结构化代码；分段保留段落、字节、Run 和文本节点范围，Unicode grapheme 优先保持完整。批注、图片、嵌入对象、修订、公式、文本框和字段产生明确降级警告。
- 本地审计通过前端 242 项测试、Rust 113+2+7+2 项测试、Clippy、桌面/扩展构建、235.96 KiB 桌面主 chunk、34.33 KiB 扩展包、npm 0 漏洞和非强制 Runtime 质量报告。本机缺少 Edge 与 `en-US` OCR Runtime；GitHub Windows CI [run 31710587063](https://github.com/Longyuyeee/long_TranslateSoftware/actions/runs/31710587063) 已通过真实 Edge Smoke、Windows 生命周期、Rust、Clippy、强制 Runtime 质量报告和报告上传，门禁没有降低。
- 5 份匿名真实 DOCX 已由 LibreOffice 26.2.5.2 渲染为 7 页并逐页复核；正文、超链接、列表、表格/嵌套表格、多节页眉页脚、Unicode、图片和字段的可见顺序与产品解析结果一致，源文件不变。页眉页脚作为独立部件流按引用顺序追加且去重，不按每页重复翻译。AES 加密 DOCX 也已验证为稳定的 `invalid-input` 拒绝。
- 阶段 2 已实现 v1 白名单 Checkpoint、每任务私有目录、受限原子保存/读取/删除、崩溃状态回退、损坏隔离、未来版本保留拒绝、终态保留期和过期临时文件清理；并发、磁盘写满、权限拒绝与真实 Windows 文件独占均证明旧文件不被破坏。存储子系统通过后进入有界翻译队列；“翻译中强制结束应用并恢复”和 UI 删除动作在队列/UI 接通后执行端到端人工验收。
- PR [#66](https://github.com/Longyuyeee/long_TranslateSoftware/pull/66) 已通过 CI 并合并。阶段 3A 当前只推进无 UI 的有界调度核心：冻结快照、并发上限、精确取消、失败隔离、可持久化错误和重建前完整性门禁已落地；下一增量接 Checkpoint 节流、恢复与只重试失败段，之后才接 UI 和端到端强制退出验收。
- PR [#67](https://github.com/Longyuyeee/long_TranslateSoftware/pull/67) 已通过 CI 并合并。阶段 3B 的第一增量正在把队列状态接入串行、节流且终态强制落盘的 Checkpoint writer；存储失败会取消请求并向上返回，下一步是恢复后只重试失败段和有上限退避。
- PR [#68](https://github.com/Longyuyeee/long_TranslateSoftware/pull/68) 在 Chrome Runtime 瞬时启动失败后重跑全绿并合并。当前增量将队列状态接入串行、节流且终态强制落盘的 Checkpoint writer；存储失败会取消请求并向上返回。
- PR [#69](https://github.com/Longyuyeee/long_TranslateSoftware/pull/69) 已通过完整 CI 并合并。当前增量实现恢复后只选择可重试失败段、单次运行最多 2 次自动重试、可取消指数退避以及永久错误快速失败；成功段不会重发或覆盖。
- PR [#70](https://github.com/Longyuyeee/long_TranslateSoftware/pull/70) 已通过完整 CI 并合并，阶段 3 无 UI 核心收口。最后补齐任务注册表、重复启动拒绝、多任务隔离和统一 `cancelAll`；长文档、强制结束和恢复提示继续作为 UI 接入后的人工发布门禁。
- PR [#71](https://github.com/Longyuyeee/long_TranslateSoftware/pull/71) 已通过完整 CI 并合并。阶段 4 第一增量建立 DOCX 重建 preflight：重新校验源指纹与完整段锚点，生成不含凭据的替换白名单并拒绝源路径覆盖；尚不写 XML 或输出文件。
- PR [#72](https://github.com/Longyuyeee/long_TranslateSoftware/pull/72) 已通过完整 Windows CI 并合并。阶段 4 第二增量在 Rust 端以白名单反序列化、重新 inspection、SHA-256、完整锚点和资源上限独立复核计划。
- PR [#73](https://github.com/Longyuyeee/long_TranslateSoftware/pull/73) 已通过完整 Windows CI 并合并。阶段 4 第三增量完成纯内存 DOCX 重建：按文本节点权重保留 Run 结构、双语模式追加硬换行译文、raw copy 未修改 ZIP 条目并重新打开成品验证。
- PR [#74](https://github.com/Longyuyeee/long_TranslateSoftware/pull/74) 已通过完整 Windows CI 并合并。阶段 4 最后一项增量完成 canonical 目标父目录、同卷临时文件、写入同步、落盘复检、不覆盖原子发布和失败清理；当前入口转为阶段 5A 最小 DOCX 工作台，随后接阶段 5B 重建取消，再执行真实 Word/LibreOffice 成品与发布候选验收。

## 每一步的交付要求

- 每个 PR 只实现一个边界清晰的增量，并补齐对应自动化和失败路径。
- 协议、文档分段和任务状态先固定契约/夹具，再接 UI。
- 持续审计依赖和安装体积、启动/消息链路耗时、资源上限与失败恢复；没有必要时不增加新进程、新依赖或重复二进制。
- 运行 `npm test`、`npm run build`、`npm run audit:bundle`、`npm run audit:extension`、`npm audit`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 和质量报告。
- 浏览器和文档功能分别保留真实 Windows 交互烟雾，不用单元测试替代最终验收。
- 不提交 `releases/` 下的历史安装包、临时文档、用户原文/译文、诊断敏感内容或任何密钥。
- 推送后等待 GitHub CI；正式发布继续通过版本标签触发 Release workflow。

## 2026-08-14 阶段 5A 工作台进展

- 已完成第一段用户闭环：新增 DOCX 导航页、系统 `.docx` 选择器、只读 inspection、结构警告、文件统计和最多 100 段预览，并完成中英文、浅色/深色主题和窄窗口纵向滚动适配。
- 稳定性与隐私边界已固定：重复点击不会并发打开多个选择器；取消选择保留既有结果；UI 只呈现白名单错误码，不显示完整路径、后端原始消息或文档正文错误详情。
- 本地审计已通过前端 274 项、Rust 136+2+7+2 项、Clippy、桌面生产构建、包体/扩展/依赖/质量报告门禁和 Edge 中英文 Runtime Smoke；正式 Chrome 扩展加载仍按发布候选人工门槛执行。
- 阶段 5A 第二增量已完成 inspection → `ready` 冻结任务确认：用户可选择译文/双语模式和新的 `.docx` 输出位置；确认时只读取一次已保存的模型、语言、提示词与术语表，持久化任务快照不含 API Key，也不会启动网络请求、写 Checkpoint 或创建输出文件。
- 输出选择复用最终重建的 canonical 父目录、目标不存在、保留设备名和源文件不覆盖边界；界面只展示输出文件名。更换源文档、模式或目标后旧确认立即失效，重复点击和晚到异步结果不会串入新任务。
- 阶段 5A 第三增量已把已确认任务交给现有任务注册表：用户必须显式开始，`ready` Checkpoint 成功落盘后才允许发送模型请求；工作台显示有界进度并支持取消。窗口级运行协调层可跨文档页卸载/重新挂载保留当前进度，但不持有第二套队列状态机，也不把 API Key 写入 Checkpoint。
- 当前下一步进入阶段 5B：从现有 Checkpoint 接通恢复与只重试失败段，并把任务级取消贯穿至同步 DOCX 重建/原子发布；当前仍不宣称已经能够导出成品。
- 第二增量本地门禁通过前端 56 个测试文件 / 286 项、Rust 138 项单元测试（另 1 项显式视觉语料验收忽略）与 11 项进程/注册集成测试、Clippy、生产构建、244.23 KiB 主 chunk、34.33 KiB 扩展包、npm 0 漏洞、质量报告和 Edge 中英文 Runtime Smoke；正式 Chrome 继续保留为发布人工门槛。
- PDF、浏览器商店上架、Authenticode 和无关优化继续不进入 `v0.5.1` DOCX MVP；版本仍保持 `0.5.0`，必须完成阶段 5B、真实成品矩阵和 Release 门禁后才能提升。
