# 开发接手说明

最近更新：2026-08-13

## 当前情况

- 当前稳定版收口为 `v0.5.0`，Release 应同时提供 EXE、MSI、Updater `.sig`、`latest.json`、浏览器扩展 ZIP 和质量报告。
- Windows 桌面端已经具备翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份、WebDAV、单实例、托盘和自动更新闭环。
- Native Messaging v1、单 EXE Host、Windows 安装集成、桌面私有 IPC、配对授权和 `translate` / `cancel` / `add_word` 已完成；固定开发 ID 的 Manifest V3 扩展通过 Release ZIP 分发，可由用户通过 `activeTab` 在当前页注入划词浮层，不声明持久网站权限。商店正式 ID 与上架流程后续单独处理。
- PDF / Word 翻译尚不可供用户使用。文档任务契约、执行快照和 DOCX Open XML 只读检查/稳定分段已经完成；DOCX 重建、文档队列、断点继续、PDF 文本层解析和 UI 尚未实现。
- 下一条产品主线为 `v0.5.1` PDF / Word 文档翻译 MVP；浏览器商店上架不与文档领域实现混合。
- 2026-08-11 已实际生成 NSIS/MSI 审计包，确认两种安装器均接受 Native Host 集成；最小扩展生产包约 9.17 KiB，门槛为 64 KiB。完整测试、包体、Clippy 和质量报告仍由本增量的本地门禁与 GitHub CI 复核。

## 接手后按顺序处理

1. `v0.5.1` 已固定文档任务契约、状态机、配置快照、输入限制，并完成 DOCX Open XML 只读检查、稳定分段和安全 ZIP 边界。
2. 下一步实现有界翻译队列、进度、取消、失败段重试与断点恢复，再完成 DOCX 基础结构重建和译文版/双语版导出。
3. DOCX 稳定后加入文本型 PDF 导入、阅读顺序检查和 DOCX 导出；扫描 PDF 与像素级 PDF 版式还原不进入 MVP。
4. Chrome Web Store 与 Edge Add-ons 上架前取得正式 ID，将其加入安装器 `allowed_origins`，并单独执行商店包审核与真实交互验收。

完整范围、风险和退出门槛见 [`DEVELOPMENT_PLAN_2026-08-10.md`](DEVELOPMENT_PLAN_2026-08-10.md)。Native Messaging 的既定安全约束见 [`NATIVE_MESSAGING_PROTOCOL.md`](NATIVE_MESSAGING_PROTOCOL.md)。

## 2026-08-12 接手状态更新

- `translate` / `cancel` / `add_word` 已从 Manifest V3 service worker 经单 EXE Native Host、受认证桌面 IPC 接入现有桌面核心；请求保留精确 Origin 与 request ID，翻译支持同端口并发取消，收藏只返回最小词条 ID。
- 桌面前端通过显式 ready 状态避免 WebView 监听器未挂载时产生 65 秒假等待；Host 断开、撤销授权和界面卸载会取消在途任务。
- content script 与 Shadow DOM 隔离的划词浮层已完成，采用用户点击弹窗后单页注入、刷新失效的 `activeTab` 模式；翻译成功后才允许把所选文字和译文写入桌面生词本，不默认收集页面上下文。下一步完成 Chrome / Edge 全链路烟雾。PDF / Word 仍保持在 v0.5.1。
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

- 当前开发分支为 `codex/docx-import-segmentation`，核心提交为 `860c319`，对应 Draft PR [#64](https://github.com/Longyuyeee/long_TranslateSoftware/pull/64)。该 PR 只完成 DOCX Open XML 的只读导入检查、稳定分段、原始位置契约和固定夹具，不包含翻译队列、重建、导出、PDF 解析或 UI。
- Rust 导入命令覆盖正文、标题、列表、表格单元格、页眉、页脚、超链接文本和中英混排；单文件上限为 50 MiB，单分段上限为 32 KiB，并检查 ZIP 路径、条目数、展开体积和压缩比。旧 `.doc`、损坏/缺少主文档及加密 DOCX 明确拒绝，图片、批注、修订、公式和嵌入对象只产生降级提示。
- 本地审计已通过：前端 242 项测试、Rust 114 项测试、Clippy 零警告、桌面与扩展生产构建、235.96 KiB 桌面前端主 chunk 门槛、34.33 KiB 扩展包门槛、npm 官方源 0 漏洞及质量报告 PASS。
- GitHub CI 的 DOCX 代码尚未得到完整远端门禁结论：两次运行均在既有 Edge 扩展烟雾的弹窗启动阶段提前失败，表现为 zh-CN 弹窗仍停在 `about:blank` 或 20 秒内 DOM 未就绪，后续 Rust 步骤因 workflow fail-fast 被跳过。本地相同 en-US/zh-CN 烟雾通过，因此当前判断为既有启动竞态，不应误记为 DOCX 回归，也不得绕过 CI 合并。
- 接手后先对浏览器烟雾增加“扩展弹窗 URL 与 DOM 确实就绪”的有界等待，保留本地化和控件完整性断言；该修复应独立审计并推送到 PR #64。CI 全绿后再把 PR 转为可审阅并合并，随后进入有界文档翻译队列、取消/重试和断点恢复。

## 每一步的交付要求

- 每个 PR 只实现一个边界清晰的增量，并补齐对应自动化和失败路径。
- 协议、文档分段和任务状态先固定契约/夹具，再接 UI。
- 持续审计依赖和安装体积、启动/消息链路耗时、资源上限与失败恢复；没有必要时不增加新进程、新依赖或重复二进制。
- 运行 `npm test`、`npm run build`、`npm run audit:bundle`、`npm run audit:extension`、`npm audit`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 和质量报告。
- 浏览器和文档功能分别保留真实 Windows 交互烟雾，不用单元测试替代最终验收。
- 不提交 `releases/` 下的历史安装包、临时文档、用户原文/译文、诊断敏感内容或任何密钥。
- 推送后等待 GitHub CI；正式发布继续通过版本标签触发 Release workflow。
