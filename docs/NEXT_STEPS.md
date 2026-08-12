# 开发接手说明

最近更新：2026-08-11

## 当前情况

- 当前稳定版为 `v0.4.9`，正式 Release 的 EXE、MSI、Updater `.sig`、`latest.json` 和质量报告已经发布并核验。
- Windows 桌面端已经具备翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份、WebDAV、单实例、托盘和自动更新闭环。
- Native Messaging v1、单 EXE Host、Windows 安装集成、桌面私有 IPC、配对授权和 `translate` / `cancel` / `add_word` 已完成；固定开发 ID 的 Manifest V3 扩展可由用户通过 `activeTab` 在当前页注入划词浮层，不声明持久网站权限。真实 Chrome/Edge 烟雾和商店 ID 尚未完成。
- PDF / Word 翻译还没有实现。现有代码没有 PDF 文本层解析、DOCX Open XML 解析/重建、文档任务模型或断点继续能力。
- 后续只推进两条产品主线：`v0.5.0` 浏览器扩展 MVP、`v0.5.1` PDF / Word 文档翻译 MVP。
- 2026-08-11 已实际生成 NSIS/MSI 审计包，确认两种安装器均接受 Native Host 集成；最小扩展生产包约 9.17 KiB，门槛为 64 KiB。完整测试、包体、Clippy 和质量报告仍由本增量的本地门禁与 GitHub CI 复核。

## 接手后按顺序处理

1. 使用固定开发 ID 的现有最小扩展完成 Chrome/Edge `hello` / `ping` 真实烟雾，并验证安装、重复安装、升级和卸载；商店发布前把 Chrome Web Store 与 Edge Add-ons 的正式 ID 一并写入 `allowed_origins`。
2. `translate` / `cancel`、划词浮层与独立 `wordbook` 授权的 `add_word` 收藏入口已经完成代码接入；翻译旧授权不会自动获得数据写入权。
3. 下一步完成 Chrome/Edge 安装、配对、划词、翻译、取消、收藏、升级和卸载真实烟雾，通过后发布 `v0.5.0`。
   Windows 预检脚本可先固定浏览器、扩展包、双注册项、Host manifest 与桌面 IPC 环境，减少误用旧 EXE 或错误 Origin；预检通过不等于真实烟雾通过。
4. `v0.5.1` 先固定文档任务契约和配置快照，再实现 DOCX 解析/重建、翻译队列、取消/重试/恢复和 DOCX 导出。
5. DOCX 稳定后加入文本型 PDF 导入、阅读顺序检查和 DOCX 导出；扫描 PDF 与像素级 PDF 版式还原不进入 MVP。

完整范围、风险和退出门槛见 [`DEVELOPMENT_PLAN_2026-08-10.md`](DEVELOPMENT_PLAN_2026-08-10.md)。Native Messaging 的既定安全约束见 [`NATIVE_MESSAGING_PROTOCOL.md`](NATIVE_MESSAGING_PROTOCOL.md)。

## 2026-08-12 接手状态更新

- `translate` / `cancel` / `add_word` 已从 Manifest V3 service worker 经单 EXE Native Host、受认证桌面 IPC 接入现有桌面核心；请求保留精确 Origin 与 request ID，翻译支持同端口并发取消，收藏只返回最小词条 ID。
- 桌面前端通过显式 ready 状态避免 WebView 监听器未挂载时产生 65 秒假等待；Host 断开、撤销授权和界面卸载会取消在途任务。
- content script 与 Shadow DOM 隔离的划词浮层已完成，采用用户点击弹窗后单页注入、刷新失效的 `activeTab` 模式；翻译成功后才允许把所选文字和译文写入桌面生词本，不默认收集页面上下文。下一步完成 Chrome / Edge 全链路烟雾。PDF / Word 仍保持在 v0.5.1。
- Native Host 子进程回归已覆盖真实 EXE 的 stdin/stdout framing、受认证桌面命名管道、翻译取消与生词本写入，并固定 Origin/request ID 不串线；剩余缺口属于 Chrome / Edge 扩展加载、安装生命周期和可视交互验收。

## 每一步的交付要求

- 每个 PR 只实现一个边界清晰的增量，并补齐对应自动化和失败路径。
- 协议、文档分段和任务状态先固定契约/夹具，再接 UI。
- 持续审计依赖和安装体积、启动/消息链路耗时、资源上限与失败恢复；没有必要时不增加新进程、新依赖或重复二进制。
- 运行 `npm test`、`npm run build`、`npm run audit:bundle`、`npm run audit:extension`、`npm audit`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 和质量报告。
- 浏览器和文档功能分别保留真实 Windows 交互烟雾，不用单元测试替代最终验收。
- 不提交 `releases/` 下的历史安装包、临时文档、用户原文/译文、诊断敏感内容或任何密钥。
- 推送后等待 GitHub CI；正式发布继续通过版本标签触发 Release workflow。
