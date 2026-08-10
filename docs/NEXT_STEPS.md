# 开发接手说明

最近更新：2026-08-10

## 当前情况

- 当前稳定版为 `v0.4.9`，正式 Release 的 EXE、MSI、Updater `.sig`、`latest.json` 和质量报告已经发布并核验。
- Windows 桌面端已经具备翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份、WebDAV、单实例、托盘和自动更新闭环。
- Native Messaging v1 已完成严格 Schema、Rust/TypeScript 模型、版本协商、配对状态、错误码、大小/并发限制和精确 Origin 校验；还没有可运行 Host、注册器、私有 IPC 或浏览器扩展。
- PDF / Word 翻译还没有实现。现有代码没有 PDF 文本层解析、DOCX Open XML 解析/重建、文档任务模型或断点继续能力。
- 后续只推进两条产品主线：`v0.5.0` 浏览器扩展 MVP、`v0.5.1` PDF / Word 文档翻译 MVP。
- 2026-08-10 基线测试、构建、包体、Clippy 和质量报告通过；PR #38 已升级受影响的 `postcss` / `nanoid` 锁定版本，npm 官方审计恢复为 0 个已知漏洞。

## 接手后按顺序处理

1. 从最新 `master` 开始 `v0.5.0` 最小 Native Host，只实现 framing、1 MiB 预解析限制、精确 Origin 校验和 `hello` / `ping` 子进程测试。
2. Host 审计通过后，依次实现 Chrome/Edge 注册、桌面私有 IPC、配对与撤销、`translate` / `cancel` / `add_word`。
3. 桥接安全边界稳定后，实现 Manifest V3 service worker、content script 和划词翻译浮层，完成 Chrome/Edge 真实烟雾后发布 `v0.5.0`。
4. `v0.5.1` 先固定文档任务契约和配置快照，再实现 DOCX 解析/重建、翻译队列、取消/重试/恢复和 DOCX 导出。
5. DOCX 稳定后加入文本型 PDF 导入、阅读顺序检查和 DOCX 导出；扫描 PDF 与像素级 PDF 版式还原不进入 MVP。

完整范围、风险和退出门槛见 [`DEVELOPMENT_PLAN_2026-08-10.md`](DEVELOPMENT_PLAN_2026-08-10.md)。Native Messaging 的既定安全约束见 [`NATIVE_MESSAGING_PROTOCOL.md`](NATIVE_MESSAGING_PROTOCOL.md)。

## 每一步的交付要求

- 每个 PR 只实现一个边界清晰的增量，并补齐对应自动化和失败路径。
- 协议、文档分段和任务状态先固定契约/夹具，再接 UI。
- 运行 `npm test`、`npm run build`、`npm run audit:bundle`、`npm audit`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 和质量报告。
- 浏览器和文档功能分别保留真实 Windows 交互烟雾，不用单元测试替代最终验收。
- 不提交 `releases/` 下的历史安装包、临时文档、用户原文/译文、诊断敏感内容或任何密钥。
- 推送后等待 GitHub CI；正式发布继续通过版本标签触发 Release workflow。
