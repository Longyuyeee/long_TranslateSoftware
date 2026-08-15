# 2026-08-14 开发进度与收尾审计

审计基线：`master` / `9c295ed`（PR #94）

目标版本：`v0.5.1` DOCX-only MVP

## 结论

DOCX 用户闭环已经完成安全导入、Checkpoint 恢复、有界翻译队列、失败段重试、最小工作台、译文/双语重建、任务取消和不覆盖原子导出。5 份可再生成的合成 DOCX 已执行两种输出模式的 round-trip，并由 LibreOffice 打开全部 10 份成品；Microsoft Word 已完成 5 份双语成品和 1 份纯译文代表样本的可见结构检查。

本轮发布故障审计补齐权限拒绝、磁盘写入失败、文件同步失败和提交时目标竞争。审计发现 Windows `rename` 会在竞争窗口覆盖刚出现的目标文件，因此最终提交改为同卷硬链接创建目标名：目标存在时原子失败；临时名删除失败时回滚目标链接。失败路径均验证源文件逐字节不变、既有目标不变且无 `.long-translate-*` 临时文件残留。

当前仍不是可发布的 `v0.5.1` 候选版。Release 工作流已经与普通 CI 对齐，5 份真实公开文档的自动化与 LibreOffice 视觉验收已经完成，但不能替代 Microsoft Word 逐页视觉验收；版本源继续保持 `0.5.0`。

## 当前复审快照

- `master` 已同步到 `9c295ed`；工作区中的用户本地修改不纳入、不修改。
- `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的版本均为 `0.5.0`，与尚未通过 `v0.5.1` 发布门槛的状态一致。
- 前端 60 个测试文件、305 项测试全部通过；Rust 149 项单元测试、2 项生命周期测试、7 项 Native Host 进程测试和 2 项注册测试通过，2 项显式依赖真实语料/人工视觉结果的测试默认忽略；严格 Clippy 通过。
- 桌面端与浏览器扩展生产构建通过，最大桌面 JavaScript chunk 为 251.25 KiB（门槛 300 KiB），扩展包为 34.33 KiB（门槛 64 KiB）；npm 官方 registry 审计为 0 个漏洞。
- Edge 英文/简体中文 Runtime Smoke、扩展审计和强制 Runtime 质量报告通过；PR #87 将正式 Chrome 的 `ERR_BLOCKED_BY_CLIENT` 与“不开放自动化调试端口”两种已知官方限制统一保留为 `chrome://extensions` 人工门槛，其他 Chrome 错误仍会使 CI 失败。PR 与合并后 `master` CI 均全绿。
- 本轮未发现新的 P0/P1 代码回归。维护风险为 Browserslist 数据已约 6 个月未更新，以及最大桌面 chunk 已使用约 84% 门槛；两项均记录为 P2，不阻断 DOCX 验收，但后续功能增量不得继续无审计扩大主包。
- 发布决策不变：不提升版本、不创建标签或 Release。先完成真实 DOCX 视觉门槛，再进入 `0.5.1` 版本、安装器、原位升级、Updater 与资产完整性收口。

## 已完成范围

### 安全导入、恢复和翻译队列

- ZIP/OPC、Relationship、路径、压缩比、条目数、XML 与资源上限均在 Rust 端验证，错误使用稳定结构化代码。
- 分段保留 paragraph、chunk、byte、Run 和 text-node 锚点；Checkpoint 使用版本化白名单、任务私有目录和受限原子替换。
- 翻译队列具有并发上限、精确取消、恢复后只重试失败段、永久错误快速失败和任务隔离；API Key 不进入 Checkpoint。

### 工作台、重建和导出

- 用户可选择 `.docx`、查看结构警告与分段预览、冻结任务参数、选择译文/双语模式和输出位置，并启动、取消、恢复或重试任务。
- Rust 在重建前重新读取源快照并复核 SHA-256、逐段锚点和资源上限；未修改 ZIP 条目按原始数据复制，成品重新通过结构与分段检查。
- 发布使用 canonical 目标父目录、同卷 `create_new` 临时文件、分块写入、`sync_all`、落盘复核和不覆盖原子提交。
- 重建取消只允许发生在原子提交点之前；成功、失败和取消均不会修改源文件。

### 成品与故障证据

- 5 份无用户数据的确定性 DOCX 夹具覆盖正文/标题/超链接、列表、表格/嵌套表格、多节页眉页脚、Unicode/分页、图片和字段。
- 每份夹具分别生成译文版和双语版，核对重新 inspection 的段顺序/结构、未修改 ZIP 条目逐字节一致以及源文件不变。
- LibreOffice 26.2.4.2 已打开上述 10 份输出并生成非空 PDF；这不等价于 Microsoft Word 视觉兼容验收。
- Microsoft Word Office16 已打开全部 5 份双语输出：标题与超链接、项目符号与编号、多节独立页眉页脚、表格与嵌套表格、Unicode/分页/图片/日期字段均可见且结构顺序正常。
- Microsoft Word 另行打开 `heading-hyperlink-translated.docx`，确认纯译文模式不残留源文且标题样式保持。第二个纯译文代表样本检查因窗口捕获异常中止，因此未记为通过；其余纯译文结构继续由 round-trip 自动化和 LibreOffice 可打开证据覆盖。
- 确定性故障检查点覆盖临时文件创建权限拒绝、写入失败、同步失败和提交时目标竞争；测试不通过填满用户磁盘或修改真实目录 ACL 制造风险。

## 剩余风险与顺序

### P0：Microsoft Word 视觉验收

- 使用至少 5 份匿名真实 DOCX，对译文版和双语版逐页检查文本完整性、顺序、表格、列表、链接、图片、页眉页脚和明显格式降级。
- 自动化语料、LibreOffice 可打开证据和本轮合成语料 Word 检查均不能代替真实文档结论；完成前不得宣称 Word 全面兼容。
- [`DOCX_REAL_DOCUMENT_ACCEPTANCE.md`](DOCX_REAL_DOCUMENT_ACCEPTANCE.md) 已固定私有语料目录、清单格式、双模式成品生成、源哈希复核和 Word/LibreOffice 记录矩阵；入口已用合成夹具模拟验证，但真实语料和人工结论仍未完成。
- 2026-08-15 当前执行环境复核：`.docx-acceptance/docs` 已具备 5 份真实公开 DOCX，最终 10 份双模式成品位于忽略目录 `.docx-acceptance/public-outputs-word-boundary-20260815-001029`；LibreOffice 和 WPS 逐页验收已经完成。PATH、标准安装目录与 COM 身份仍未发现可明确识别的 Microsoft Word，`Word.Application` 当前指向 WPS Office；`npm run audit:docx:word -- -ProbeOnly` 会按预期拒绝其版本、路径、文件身份、公司信息和 Authenticode 签名。WPS/LibreOffice 记录不得据此宣称 Microsoft Word 门槛已通过。

### 已完成：Release 门禁对齐

- `ci.yml` 和 `release.yml` 现在显式执行相同的前端测试、依赖审计、生产构建、包体/扩展审计、浏览器 Runtime Smoke、Windows 生命周期、Rust 全量、严格 Clippy 和强制质量报告。
- 工作流契约测试固定这些命令必须存在，并要求 Release 的全部质量门禁和报告上传发生在签名发布之前。
- Microsoft Word 视觉门槛通过后，再统一提升 `package.json`、Cargo 和 Tauri 配置到 `0.5.1`，更新 Release Notes，构建 NSIS/MSI，并验证 v0.5.0 原位升级、Updater 与资产完整性。

### P1：后续质量工作

- 继续补充 50 MiB、最大段数、最大总文本、长文档耗时和峰值内存基线；这些不能降低现有硬限制。
- 浏览器商店正式 ID、完整 Chrome/Edge 安装生命周期和 Authenticode 保持独立路线，不混入 DOCX MVP。

## 下一步入口

在可明确识别的 Microsoft Word 桌面端打开本轮 5 份真实公开 DOCX 的 10 份双模式输出，完成逐页视觉检查并记录结论。该门槛通过后才能提升 `0.5.1`、构建并发布。

## 2026-08-15 真实文档与单词边界复审

- 从 NSW Crown Lands 官方模板页选取 5 份真实公开 DOCX，只存放在被 Git 忽略的 `.docx-acceptance/docs`，不提交第三方文档或生成物。5 份源文件均为有效 OPC/DOCX，执行前后 SHA-256 不变。
- 两种输出模式共生成并重新打开 10 份 DOCX，结构 round-trip 全部通过。LibreOffice 26.2.5.2 将其转换为 10 份 PDF、共 97 页；14 组联系表逐页抽检未见空白、黑块、正文截断或新增结构破坏。
- 视觉审计发现纯译文中的拉丁单词可能被原 DOCX 的多个 Run/控件边界拆开，例如 `Va` / `lidation`。重建分配现改为：存在空白词界时将非末尾切点吸附到最近词界；无空白文本继续按 Unicode grapheme 安全分配；多 Run 且目标文本较短时保持切点单调，避免切片回退。
- 修复后重新执行完整真实语料 round-trip 和 LibreOffice 批量渲染。61 个双语页与修复前逐像素一致，变化仅落在纯译文路径；纯译文单词保持完整。窄表格列仍可能按原列宽自然换行，不通过扩列改变原模板布局。
- 本地 Rust 全量门禁通过：149 项单元测试通过、2 项显式视觉语料测试忽略，另有 2 项生命周期、7 项 Native Host 进程和 2 项注册测试通过；`cargo clippy --all-targets --all-features -- -D warnings` 通过。全仓 `cargo fmt --check` 被既有 `db.rs`、`ocr.rs` 格式差异阻断，本增量所改 Rust 文件已单独格式化。
- LibreOffice 验收门槛在本轮语料上记为通过。Microsoft Word 仍未安装，`Word.Application` COM 指向 WPS Office，因此 Word 门槛保持 P0 未完成，不提升版本、不创建标签或 Release。

## 2026-08-15 WPS 补充兼容审计

- 使用 WPS Office 12.1.0.28043 打开同一批 10 份真实文档双模式成品并导出 PDF；10/10 导出成功，输入 DOCX 在每次导出前后 SHA-256 不变。
- 10 份 PDF 共 96 页，全部渲染为 PNG 并通过 16 组联系表逐页检查；未发现空白页、黑块、正文截断、新增结构破坏或拉丁单词跨 Run 拆分。
- WPS 与 LibreOffice 的唯一明显分页差异出现在战略计划双语版：WPS 为 5 页，LibreOffice 为 6 页；可见内容完整，归类为排版引擎分页差异，不视为数据丢失。
- WPS 的单个批量 COM 会话在导出第一份后返回 `RPC server unavailable`；改为每份文档独立 COM 会话后 10/10 成功。该差异记录为 WPS 自动化稳定性限制，不影响应用生成的 DOCX，也不转化为新的产品功能范围。
- WPS 验收是新增适配性证据，不是 Microsoft Word 的替代证据。P0、版本 `0.5.0` 与“不创建 Release”的决策保持不变。

## 2026-08-15 Microsoft Word 门槛就绪审计

- PR #92 已合并真实 DOCX 拉丁单词边界修复，PR #93 已合并 WPS 补充审计，PR #94 已合并 Microsoft Word 验收执行器；三项增量的 PR CI 与合并后 `master` CI 均通过，当前复审基线为 `9c295ed`。
- `npm run audit:docx:word` 会验证 Word 16.x/365 COM、`WINWORD.EXE` 原始文件名与 Microsoft 公司信息、有效 Authenticode 签名及 Microsoft 签名者，并为每份成品使用独立只读 Word 会话；输入前后 SHA-256 必须一致。
- 最终输入已经冻结为 `.docx-acceptance/public-outputs-word-boundary-20260815-001029` 中 5 组译文版/双语版共 10 份成品。执行器将输出脱敏 manifest 和人工 review 矩阵，不覆盖历史证据；自动导出成功仍不能替代可见打开和逐页检查。
- 本机再次执行 `npm run audit:docx:word -- -ProbeOnly`，严格拒绝了 WPS COM 身份；这证明 fail-closed 边界生效，不构成 Microsoft Word 通过证据。
- 需求顺序保持不变：先在安装并激活 Microsoft Word 16.x/365 的 Windows 环境完成同一 10 份成品的逐页视觉验收；只有该 P0 通过后，才允许提升 `0.5.1`、构建安装器并执行 v0.5.0 原位升级、Updater、签名与 Release 资产完整性验收。

## 2026-08-15 本机 Runtime Smoke 复验

- 本机 Microsoft Edge 的系统 App Paths 注册项指向标准安装目录下的 `Microsoft Edge.exe`，而不是常见的 `msedge.exe`；该文件的产品名为 Microsoft Edge、公司为 Microsoft Corporation、原始文件名为 `msedge.exe`，Authenticode 签名有效。
- 浏览器 Runtime Smoke 的 Edge 探测已同时覆盖三个标准安装根目录下的 `msedge.exe` 与 `Microsoft Edge.exe`，并过滤缺失的环境根目录，避免退化为相对路径探测；Chrome 的默认门禁和标准路径不变。
- 本机专项回归测试通过，真实 Edge 英文/简体中文检查完成后脚本继续进入 Chrome 阶段；由于本机没有 Chrome，默认双浏览器 Smoke 明确失败，没有把环境缺口伪装成通过。GitHub Windows CI 仍必须使用默认命令完成 Edge/Chrome 策略复核。
- 该修复只提高既有测试工具对已注册 Edge 启动文件名的适配性，不改变产品功能、发布范围或 Microsoft Word P0 顺序；版本继续保持 `0.5.0`。
