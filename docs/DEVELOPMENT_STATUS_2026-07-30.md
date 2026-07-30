# Long翻译开发状态审计与执行计划

审计日期：2026-07-30

审计范围：`master` 至 Draft PR #22（`codex/native-messaging-protocol` / `cdeb675`）

## 1. 结论

项目当前处于两个版本阶段的交界处：

- `v0.4.8` 是当前稳定版，正式 Release 的 NSIS、MSI、Updater 签名、`latest.json` 和质量报告资产齐全。
- `v0.4.9` 的架构与回归收口已经完成大部分，但尚未达到现有文档定义的全部退出门槛。
- Native Messaging v1 协议基线已经在 Draft PR #22 中完成，CI 通过；它是 `v0.5.0` 的设计输入，不代表 Native Host 或浏览器扩展已经可用。

当前不应继续并行扩大功能范围。正确顺序是：

1. Native Messaging 协议基线 PR #22 已审计并合并；
2. 继续完成 `v0.4.9` 剩余架构收口；
3. 生成候选安装包并执行真实交互桌面烟雾；
4. 发布 `v0.4.9`；
5. 从干净的 `master` 开始 `v0.5.0` Native Host。

## 2. 可验证基线

| 项目 | 当前证据 | 判断 |
| --- | --- | --- |
| 稳定版本 | GitHub Release `v0.4.8`，发布于 2026-07-27 | 正常 |
| 发布资产 | NSIS、MSI、两份 Updater `.sig`、`latest.json`、质量报告 | 完整 |
| 当前进展 | PR #22～#25 已合并；翻译 HTTP/SSE 传输边界正在独立分支推进 | 正常 |
| 前端测试 | 40 个文件 / 173 项 | 通过 |
| Rust 测试 | 62 项单元测试 + 2 项真实子进程测试 | 通过 |
| Rust 静态检查 | `cargo clippy --all-targets -- -D warnings` | 通过 |
| 依赖审计 | `npm audit` | 0 个已知漏洞 |
| 包体门槛 | 最大生产 JavaScript 块 234.55 KiB / 300 KiB | 通过 |
| 质量报告 | 翻译、TTS、OCR 统一报告 | PASS |
| GitHub 任务 | 0 个开放 Issue | 路线尚未转为可跟踪任务 |

## 3. 当前已经完成

### 3.1 产品与发布闭环

- 翻译、OCR、TTS、术语表、生词本、FSRS、Anki、备份和 WebDAV 已形成完整 Windows 工作流。
- API Key 与 WebDAV 密码使用 Windows DPAPI 保护；备份使用 Argon2id 与 AES-256-GCM。
- 应用内更新、Updater 签名、标签触发 Release 和质量报告上传已经落地。
- 单实例、手动/自启动模式、窗口恢复、关闭到托盘、托盘动作和通知状态具有自动化回归。

### 3.2 质量与可维护性

- 翻译格式保持、主备模型隔离、缓存上下文、TTS 路由/容器和 Windows OCR CER 已有自动门槛。
- 设置、批量翻译、生词本、历史、术语表、剪贴板监控和系统副作用已拆出独立组件、hook 或 service。
- Rust 已拆出配置、快捷键、生命周期、系统集成、词库、历史、复习、备份、诊断、TTS、OCR、WebDAV 等领域模块。

### 3.3 浏览器扩展前置协议

Draft PR #22 已定义：

- 严格的 Native Messaging v1 JSON Schema；
- Rust 与 TypeScript 双端协议模型；
- `hello`、配对、翻译、收藏、取消和心跳动作；
- 版本协商、稳定错误码、请求关联和兼容策略；
- 1 MiB 消息、32 KiB 正文、100 条术语和每会话 4 并发限制；
- 精确扩展 Origin 白名单、威胁模型和桌面交互烟雾清单。

尚未实现：

- Native Host 可执行文件及 stdin/stdout framing；
- Chrome / Edge Host manifest 与 Windows 注册/注销；
- Host 与桌面进程之间的私有 IPC；
- 桌面端配对确认与权限撤销；
- Manifest V3 service worker、content script 和扩展 UI。

## 4. 未收口问题与风险

### P0：`v0.4.9` 发布证据不完整

- `RELEASE_DESKTOP_SMOKE.md` 已定义双实例、单托盘、前台恢复、自启动和通知检查，但仓库中还没有候选安装包的执行记录。
- `docs/releases/v0.4.9.md` 尚未创建。
- `package.json`、`Cargo.toml` 和 `tauri.conf.json` 仍是 `0.4.8`；在正式发布步骤前保持不变是正确的，但说明 `v0.4.9` 尚未进入发布候选状态。
- Tauri Updater 资产有签名，但 Windows 安装包仍没有 Authenticode，首次安装可能继续触发 SmartScreen。

### P1：既定架构退出门槛尚未全部达到

| 边界 | 当前 | 既定目标/问题 |
| --- | ---: | --- |
| `Dashboard.tsx` | 600 行 | 导航外壳、同步/事件及数据与维护动作已拆分，既定不超过 600 行的目标已达到 |
| `api.ts` | 785 行 | HTTP/SSE 与连接探测已拆分；翻译任务、旧兼容流程和 TTS 仍集中 |
| `GeneralSettingsTab.tsx` | 534 行 | 超过“页签原则上不超过 400 行”的目标 |
| `src-tauri/src/lib.rs` | 667 行、14 个直接命令 | 仍包含数据库查询、WebDAV 编排、导出和统计逻辑 |
| Tauri 错误 | 多处 `Result<_, String>` | 尚未形成统一、可序列化的应用错误结构 |

这些问题不阻止当前稳定版运行，但会放大 Native Host 接入后的修改半径。因此不应在它们未处理时把 Host、IPC 和扩展 UI 同时加入同一版本。

### P1：真实质量样本仍不足

- 翻译门槛主要验证格式与结构，缺少版本化双语语义金标。
- OCR 有生成式 PNG 和 Windows 真机引擎门槛，但缺少真实应用截图及多机器趋势。
- TTS 已验证路由与音频容器，缺少真人抽听记录和远端可用率趋势。
- WebDAV 有隔离服务测试，但缺少 Nextcloud、坚果云等真实服务兼容矩阵。

### P2：项目跟踪仍依赖长文档

GitHub 当前没有开放 Issue。后续阶段如果仍只依靠长文档，任务完成条件、依赖关系和发布阻塞项容易失去可见性。PR #22 合并后应按本文件的阶段拆分 Issue 或里程碑。

## 5. 后续执行计划

### 阶段 A：合并协议基线（已完成）

范围：

- 已审阅并合并 PR #22 的 Schema、双端模型、限制和文档；
- 保持“协议契约”与“可运行 Host”边界清晰；
- CI 绿色后转为 Ready 并合并。

退出门槛：

- PR 无未解决审查意见；
- GitHub `quality` 成功；
- 合并后 `master` 再次通过 CI。

### 阶段 B：完成 `v0.4.9` 架构收口

按依赖顺序拆分：

1. 继续拆分 `api.ts` 的翻译任务、缓存和主备故障切换策略，保留兼容出口。
2. 拆分 `GeneralSettingsTab.tsx` 的 WebDAV、快捷键和维护区块。
3. 将 `lib.rs` 的词库/导出、同步和统计命令迁入对应 Rust 模块。
4. 建立统一 Tauri 错误结构，先覆盖新增路径，再迁移旧命令。

每一步独立提交、独立 PR，并保持前端 173 项和 Rust 64 项既有测试不回退。

退出门槛：

- `Dashboard.tsx` ≤600 行；
- `api.ts` 不再同时承担网络、翻译策略和 TTS；
- `lib.rs` 不包含数据库查询、网络同步或导出格式实现；
- 新增命令不返回依赖自由文本匹配的错误；
- 全量 CI 与质量报告通过。

### 阶段 C：发布 `v0.4.9`

1. 更新前端、Cargo 和 Tauri 三处版本号。
2. 创建 `docs/releases/v0.4.9.md`，只描述已经完成并验证的变化。
3. 构建候选 NSIS 安装包，记录 SHA-256。
4. 在真实 Windows 用户会话执行 `RELEASE_DESKTOP_SMOKE.md` 并保存结果。
5. 从 `v0.4.8` 验证应用内升级到候选版本。
6. 全部通过后创建 `v0.4.9` 标签，由 Release workflow 构建、签名和发布。
7. 核对 EXE、MSI、`.sig`、`latest.json` 和质量报告后再宣布完成。

退出门槛：

- 三处版本一致；
- 自动与人工门禁全部通过；
- Release 资产完整；
- `latest.json` 指向真实可下载的签名 Updater 包。

### 阶段 D：启动 `v0.5.0` 桌面桥接

按安全边界逐层推进：

1. 最小 Native Host：二进制 framing、1 MiB 预解析限制、精确 Origin 校验和 v1 Schema 解析。
2. Windows 安装集成：Chrome/Edge manifest、当前用户注册与可逆注销。
3. 私有 IPC：桌面不可用、超时、取消、并发和断线清理。
4. 桌面配对：一次性确认、能力授权、撤销和审计记录。
5. Manifest V3 service worker：只实现 `hello`、`ping`、`pair`，通过安全审计后再接翻译。
6. 扩展 MVP：划词、有限上下文、翻译、收藏和明确错误状态。

退出门槛：

- 扩展不保存 API Key、WebDAV 密码或数据库内容；
- 未授权 Origin、未知字段、超限消息和版本不兼容默认拒绝；
- Host/桌面断开不会留下孤儿翻译任务；
- Chrome 与 Edge 分别具有安装、升级和卸载测试；
- 完成桥接安全审计后才进入 UI 扩展。

## 6. 暂不进入的方向

在 `v0.5.0` 桌面桥接稳定前，不并行增加：

- 整页双语替换、PDF 或字幕翻译；
- 实时语音同传；
- 新供应商插件体系；
- Firefox、macOS 或 Linux；
- 浏览器侧密钥与独立模型配置。

现阶段的竞争力来自把“翻译 → 校验 → 收藏 → 复习 → 同步”做得可靠、可解释、可升级，而不是继续增加入口数量。
