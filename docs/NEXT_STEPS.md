# 开发接手说明

最近更新：2026-08-11

## 当前情况

- 当前稳定版为 `v0.4.9`，正式 Release 的 EXE、MSI、Updater `.sig`、`latest.json` 和质量报告已经发布并核验。
- Windows 桌面端已经具备翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份、WebDAV、单实例、托盘和自动更新闭环。
- Native Messaging v1 已完成严格 Schema、Rust/TypeScript 模型、版本协商、配对状态、错误码、大小/并发限制和 32 位 Chromium 扩展 ID 精确校验；桌面 EXE 可直接进入最小 Host 模式，并已有 manifest 原子写入、Chrome/Edge HKCU 幂等注册/升级/可逆卸载和真实 Windows 注册表测试。固定开发 ID 的最小 Manifest V3 扩展已实现同端口 `hello` / `ping` / `pair`，NSIS/WiX 已接入安装、升级、卸载与回滚；桌面私有 IPC 和授权闭环已完成。真实 Chrome/Edge 烟雾、商店 ID 和翻译能力尚未完成。
- PDF / Word 翻译还没有实现。现有代码没有 PDF 文本层解析、DOCX Open XML 解析/重建、文档任务模型或断点继续能力。
- 后续只推进两条产品主线：`v0.5.0` 浏览器扩展 MVP、`v0.5.1` PDF / Word 文档翻译 MVP。
- 2026-08-11 已实际生成 NSIS/MSI 审计包，确认两种安装器均接受 Native Host 集成；最小扩展生产包约 9.17 KiB，门槛为 64 KiB。完整测试、包体、Clippy 和质量报告仍由本增量的本地门禁与 GitHub CI 复核。

## 接手后按顺序处理

1. 使用固定开发 ID 的现有最小扩展完成 Chrome/Edge `hello` / `ping` 真实烟雾，并验证安装、重复安装、升级和卸载；商店发布前把 Chrome Web Store 与 Edge Add-ons 的正式 ID 一并写入 `allowed_origins`。
2. 桌面私有 IPC、配对状态查询、完整请求确认、批准/拒绝/撤销 UI 与最小持久化已经完成；授权记录不含密钥或翻译内容，落盘失败时不会错误批准。下一步只接 `translate` / `cancel` / `add_word`，并复用桌面翻译核心。
3. 桥接安全边界稳定后，实现 Manifest V3 service worker、content script 和划词翻译浮层，完成 Chrome/Edge 真实烟雾后发布 `v0.5.0`。
4. `v0.5.1` 先固定文档任务契约和配置快照，再实现 DOCX 解析/重建、翻译队列、取消/重试/恢复和 DOCX 导出。
5. DOCX 稳定后加入文本型 PDF 导入、阅读顺序检查和 DOCX 导出；扫描 PDF 与像素级 PDF 版式还原不进入 MVP。

完整范围、风险和退出门槛见 [`DEVELOPMENT_PLAN_2026-08-10.md`](DEVELOPMENT_PLAN_2026-08-10.md)。Native Messaging 的既定安全约束见 [`NATIVE_MESSAGING_PROTOCOL.md`](NATIVE_MESSAGING_PROTOCOL.md)。

## 每一步的交付要求

- 每个 PR 只实现一个边界清晰的增量，并补齐对应自动化和失败路径。
- 协议、文档分段和任务状态先固定契约/夹具，再接 UI。
- 持续审计依赖和安装体积、启动/消息链路耗时、资源上限与失败恢复；没有必要时不增加新进程、新依赖或重复二进制。
- 运行 `npm test`、`npm run build`、`npm run audit:bundle`、`npm run audit:extension`、`npm audit`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 和质量报告。
- 浏览器和文档功能分别保留真实 Windows 交互烟雾，不用单元测试替代最终验收。
- 不提交 `releases/` 下的历史安装包、临时文档、用户原文/译文、诊断敏感内容或任何密钥。
- 推送后等待 GitHub CI；正式发布继续通过版本标签触发 Release workflow。
