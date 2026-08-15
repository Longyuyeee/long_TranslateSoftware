# 2026-08-14 开发进度与收尾审计

审计基线：`v0.5.1` / `2e481fb`（PR #102，发布后文档回写除外）

目标版本：`v0.5.1` DOCX-only MVP

## 结论

DOCX 用户闭环已经完成安全导入、Checkpoint 恢复、有界翻译队列、失败段重试、最小工作台、译文/双语重建、任务取消和不覆盖原子导出。5 份可再生成的合成 DOCX 已执行两种输出模式的 round-trip，并由 LibreOffice 打开全部 10 份成品；Microsoft Word 已完成 5 份双语成品和 1 份纯译文代表样本的可见结构检查。

本轮发布故障审计补齐权限拒绝、磁盘写入失败、文件同步失败和提交时目标竞争。审计发现 Windows `rename` 会在竞争窗口覆盖刚出现的目标文件，因此最终提交改为同卷硬链接创建目标名：目标存在时原子失败；临时名删除失败时回滚目标链接。失败路径均验证源文件逐字节不变、既有目标不变且无 `.long-translate-*` 临时文件残留。

Release 工作流已经与普通 CI 对齐，5 份真实公开文档的自动化、LibreOffice 97 页和 WPS Office 96 页逐页验收已经完成。v0.5.1 已以 DOCX 预览能力正式发布，安装、v0.5.0 原位升级、应用内 Updater、签名和 7 个 Release 资产均完成验收；Microsoft Word 同批真实文档验收仍未完成，必须作为明确限制保留。

## 当前复审快照

- `v0.5.1` 标签和正式 Release 基线为 `2e481fb`；工作区中的用户本地修改不纳入、不修改。
- `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 与浏览器扩展 Manifest 的项目版本均为 `0.5.1`，并与标签、Release Notes、扩展包、质量报告和安装后二进制一致。
- 前端 61 个测试文件、308 项测试全部通过；Rust 150 项单元测试、2 项生命周期测试、7 项 Native Host 进程测试和 2 项注册测试通过，2 项显式依赖真实语料/人工视觉结果的测试默认忽略；严格 Clippy 通过。
- 桌面端与浏览器扩展生产构建通过，最大桌面 JavaScript chunk 为 251.25 KiB（门槛 300 KiB），扩展包为 34.33 KiB（门槛 64 KiB）；npm 官方 registry 审计为 0 个漏洞。
- Edge 英文/简体中文 Runtime Smoke、扩展审计和强制 Runtime 质量报告通过；PR #87 将正式 Chrome 的 `ERR_BLOCKED_BY_CLIENT` 与“不开放自动化调试端口”两种已知官方限制统一保留为 `chrome://extensions` 人工门槛，其他 Chrome 错误仍会使 CI 失败。PR 与合并后 `master` CI 均全绿。
- 本轮未发现新的 P0/P1 代码回归。维护风险为 Browserslist 数据已约 6 个月未更新，以及最大桌面 chunk 已使用约 84% 门槛；两项均记录为 P2，不阻断 DOCX 验收，但后续功能增量不得继续无审计扩大主包。
- 发布决策已执行：WPS/LibreOffice 真实文档矩阵作为 v0.5.1 DOCX 预览版证据；安装器、原位升级、Updater 与资产完整性收口完成后已创建正式标签。后续冻结 DOCX MVP，只处理回归，并继续保留 Word 未验证声明。

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

### P2：Microsoft Word 兼容性尚未正式验收

- 后续仍需使用至少 5 份匿名真实 DOCX，对译文版和双语版逐页检查文本完整性、顺序、表格、列表、链接、图片、页眉页脚和明显格式降级。
- 自动化语料、LibreOffice 和 WPS 结果不能推出 Microsoft Word 必然兼容；完成前不得宣称 Word 全面兼容，也不得移除预览标识和限制说明。
- [`DOCX_REAL_DOCUMENT_ACCEPTANCE.md`](DOCX_REAL_DOCUMENT_ACCEPTANCE.md) 已固定语料目录、清单格式、双模式成品生成、源哈希复核和跨引擎记录矩阵。LibreOffice/WPS 矩阵已经完成，Word 矩阵保留为后续兼容性工作。
- 官方 Microsoft Word 已安装且身份、签名验证通过，但当前 Office 许可证未激活。执行器会在创建输出和打开输入前 fail closed；该环境限制不再阻塞 v0.5.1 预览版，但不能被写成 Word 通过证据。

### 已完成：Release 门禁对齐

- `ci.yml` 和 `release.yml` 现在显式执行相同的前端测试、依赖审计、生产构建、包体/扩展审计、浏览器 Runtime Smoke、Windows 生命周期、Rust 全量、严格 Clippy 和强制质量报告。
- 工作流契约测试固定这些命令必须存在，并要求 Release 的全部质量门禁和报告上传发生在签名发布之前。
- 范围声明审计合并后，统一提升 `package.json`、Cargo 和 Tauri 配置到 `0.5.1`，更新 Release Notes，构建 NSIS/MSI，并验证 v0.5.0 原位升级、Updater 与资产完整性。

### P1：后续质量工作

- 继续补充 50 MiB、最大段数、最大总文本、长文档耗时和峰值内存基线；这些不能降低现有硬限制。
- 浏览器商店正式 ID、完整 Chrome/Edge 安装生命周期和 Authenticode 保持独立路线，不混入 DOCX MVP。

## 下一步入口

先合并 DOCX 预览版范围与限制声明，再进入 `0.5.1` 版本同步和发布候选构建。候选版必须完成 NSIS/MSI 安装、v0.5.0 原位升级、Updater、桌面/DOCX 烟雾和资产完整性验证；Microsoft Word 验收作为 P2 后续兼容性工作保留。

## 2026-08-15 真实文档与单词边界复审

- 从 NSW Crown Lands 官方模板页选取 5 份真实公开 DOCX，只存放在被 Git 忽略的 `.docx-acceptance/docs`，不提交第三方文档或生成物。5 份源文件均为有效 OPC/DOCX，执行前后 SHA-256 不变。
- 两种输出模式共生成并重新打开 10 份 DOCX，结构 round-trip 全部通过。LibreOffice 26.2.5.2 将其转换为 10 份 PDF、共 97 页；14 组联系表逐页抽检未见空白、黑块、正文截断或新增结构破坏。
- 视觉审计发现纯译文中的拉丁单词可能被原 DOCX 的多个 Run/控件边界拆开，例如 `Va` / `lidation`。重建分配现改为：存在空白词界时将非末尾切点吸附到最近词界；无空白文本继续按 Unicode grapheme 安全分配；多 Run 且目标文本较短时保持切点单调，避免切片回退。
- 修复后重新执行完整真实语料 round-trip 和 LibreOffice 批量渲染。61 个双语页与修复前逐像素一致，变化仅落在纯译文路径；纯译文单词保持完整。窄表格列仍可能按原列宽自然换行，不通过扩列改变原模板布局。
- 本地 Rust 全量门禁通过：149 项单元测试通过、2 项显式视觉语料测试忽略，另有 2 项生命周期、7 项 Native Host 进程和 2 项注册测试通过；`cargo clippy --all-targets --all-features -- -D warnings` 通过。全仓 `cargo fmt --check` 被既有 `db.rs`、`ocr.rs` 格式差异阻断，本增量所改 Rust 文件已单独格式化。
- LibreOffice 验收门槛在本轮语料上记为通过。当时 Microsoft Word 尚未安装，`Word.Application` COM 指向 WPS Office；后续安装状态见本文末的 Microsoft Word 环境更新。Word 逐页门槛保持 P0 未完成，不提升版本、不创建标签或 Release。

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
- 在该增量当时，此修复只提高既有测试工具对已注册 Edge 启动文件名的适配性，不改变产品功能、发布范围或当时的 Microsoft Word P0 顺序；版本保持 `0.5.0`。

## 2026-08-15 Microsoft Word 环境与执行器修复

- 通过官方 winget 源安装 Microsoft 365 Apps for enterprise；安装器来自 `officecdn.microsoft.com` 且下载哈希与 winget 清单一致。未卸载 WPS，也未修改用户文档。
- `C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE` 已落盘，文件版本为 16.0.20228.20190，产品/公司信息属于 Microsoft Office / Microsoft Corporation，原始文件名为 `WinWord.exe`，Authenticode 状态有效且签名者为 Microsoft Corporation。
- 首次真实探测发现：由 Node/Vitest 启动 Windows PowerShell 5.1 时可能继承 PowerShell 7 模块路径，导致 `Microsoft.PowerShell.Security` 自动加载到不兼容模块，签名校验无法运行。执行器改为从当前 Windows PowerShell 的 `$PSHOME` 显式加载系统安全模块，不依赖继承环境或 COM 启动后的模块自动发现。
- 修复后执行器专项测试、自测和真实 `-ProbeOnly` 均通过，真实 COM 返回 Microsoft Word 16.0，`WINWORD.EXE` 签名通过。该结果只证明身份门槛就绪，不等价于 10 份成品导出、逐页视觉检查或 Office 许可证激活完成。
- 在该增量当时，顺序仍是先独立通过 PR/主分支 CI，再检查安装完成与 Office 激活状态并运行冻结语料的 Word 验收；后续产品范围调整见本文末的决策记录。

## 2026-08-15 Microsoft Word 实机运行第二轮审计

- PR #97 与合并后 `master` CI 已通过，真实 Word 16.0 身份、Microsoft 文件信息和有效 Authenticode 签名可以稳定探测。
- 首次批量运行在处理绝对 `OutputDirectory` 时先把它错误拼接到当前目录，再判断是否为根路径，导致 `.NET GetFullPath` 拒绝 `E:\...\E:\...` 格式。路径解析现先判断 rooted/relative，并由自测分别固定两条分支。
- 修复路径后，真实运行发现 `Get-FileHash` 同样会受 Node 继承的 PowerShell 7 模块路径影响；执行器现在从 Windows PowerShell 5.1 自身 `$PSHOME` 显式加载 Security 与 Utility 两个必需系统模块，哈希与签名命令均使用已加载模块。
- 未激活 Office 会在隐藏 COM 会话中触发不可见的首次运行/许可阻塞。审计中断了无产物的卡住任务，终止5个由本轮创建且无窗口的 Word 自动化进程，保留用户可见的空白 Word 窗口；10份输入 SHA-256 未变，失败目录为空。执行器现通过创建 COM 前后的 WINWORD PID 差集绑定唯一隔离进程；正常 `Quit` 后只在该精确 PID 仍无可见窗口时清理，负向回归前后隐藏进程数均为0。
- 执行器新增 Office 激活 fail-closed 门禁：vNext 证据必须包含 `LicenseState=Licensed`，或 OSPP 必须返回 `---LICENSED---`。当前真实环境无 vNext/device license 且无产品密钥，负向运行在创建输出目录和打开输入前明确退出，未生成假证据。
- 此轮实机审计结束时，唯一剩余的 Word 前置是用户使用有许可证的 Microsoft 365/Office 账号完成激活；后续产品范围调整见下节。

## 2026-08-15 DOCX 预览版范围决策

- 产品确认以已经完成的 WPS Office 12.1.0.28043 与 LibreOffice 26.2.5.2 真实文档矩阵作为 v0.5.1 DOCX 预览版的发布证据，不再把未激活 Microsoft Word 的同批矩阵作为本版本硬阻塞。
- 该决策改变发布范围，不改变技术事实：WPS/LibreOffice 通过不能推出 Microsoft Word 必然兼容。README、Release Notes 和应用说明必须保留“Microsoft Word 尚未完成正式验收”的限制，不得宣传全面 Word 兼容。
- Microsoft Word 执行器、激活 fail-closed 门禁和冻结语料全部保留；Word 同批逐页矩阵降级为 P2 后续兼容性工作，通过后才能移除限制声明。
- 下一步进入阶段 7：统一版本为 `0.5.1`，更新发布说明并构建发布候选；完成 NSIS/MSI 安装、v0.5.0 原位升级、Updater、桌面/DOCX 烟雾和资产完整性验证后，才能创建正式标签与 Release。

## 2026-08-15 v0.5.1 发布候选版本对齐

- package、npm lock、Cargo manifest、Cargo lock、Tauri 配置与浏览器扩展 Manifest 中的项目版本统一为 `0.5.1`；依赖自身出现的 `0.5.0` 不做机械替换。首次生产构建按预期捕获扩展仍为 `0.5.0` 的遗漏，补齐后必须重跑完整构建与扩展审计。
- 新增 `docs/releases/v0.5.1.md`，只描述已经完成的 DOCX 用户闭环、安全边界、WPS/LibreOffice 真实文档证据和已知限制。
- DOCX 工作台中英文说明直接显示预览状态与 Microsoft Word 未正式验收的限制，避免用户只在仓库文档中才能看到兼容性边界。
- 本增量不更新 README 的正式下载链接、不创建标签、不触发 Release；下一步先构建候选安装包并执行安装、原位升级、Updater 与资产完整性验收。

## 2026-08-15 v0.5.1 安装器候选审计

- 本机签名构建生成 NSIS、MSI 与各自 Updater `.sig`；两个签名均使用应用内嵌公钥通过 `minisign-verify` 实际验签。安装包未配置 Authenticode，与既有 SmartScreen 限制一致。
- 官方 v0.5.0 NSIS 资产经 GitHub Release SHA-256 复核后覆盖安装，再用 v0.5.1 NSIS 候选原位升级；两步均保持安装路径、用户数据库和 Local 数据逐文件哈希，候选启动、单实例与窗口恢复通过。
- MSI 候选需要管理员权限；提权安装后发现成品文件表、安装目录和注册表均缺少 Native Host 集成。根因是 WiX Fragment 只有 CustomAction/执行序列，未通过 `componentRefs` 接入 MSI 主 Feature，因此被链接器裁掉。
- 修复要求：WiX Fragment 增加主 Feature 可引用组件；Native Host 清单迁移到当前用户可写的 LocalAppData，避免 Program Files 写权限问题；NSIS 与 MSI 统一该路径，并新增静态安装器契约和真实 MSI 成品/安装回归。修复通过前不得创建 v0.5.1 标签或 Release。
- 修复后 MSI 成品已确认包含 `LongTranslateNativeHostIntegration` 组件、主 Feature 引用及四个安装/回滚自定义动作；重新构建的 MSI SHA-256 为 `9FDD60DDDFF217F8687241AF91218D8F0F13D8ECCEA5A31AE009F16B5998424D`，Updater 签名使用应用内嵌公钥验签通过。
- 修复后 MSI 管理员静默安装、启动、二次启动单实例、窗口恢复及静默卸载均通过。Chrome/Edge 注册统一指向 `%LOCALAPPDATA%\com.long.translate\native-messaging\com.long.translate.json`；卸载后清单、两项浏览器注册和 MSI 标记均被清理，用户词库仍存在且 SHA-256 保持 `590BA9034A09CF5C2BBEC87EAF1926050661CB5C4162CF1B8B7BFF1BA0647D7B`。
- 同一修复重新构建 NSIS，SHA-256 为 `93A179927FC351F9170E3A1164BFE2F1423D43BC36F9F794D1FC39CDCAF0DA94`，Updater 签名验签通过；静默安装后用户目录清单与 Chrome/Edge 注册正确，旧安装目录清单不存在，词库哈希保持不变。当前本机保留该 NSIS v0.5.1 候选用于后续 Updater 验收。
- 修复后的全量门禁通过：Vitest `61` 文件、`308` 用例；Rust 单元测试 `150` 通过、`2` 个显式人工语料测试忽略，另有生命周期 `2`、Native Host 进程 `7`、Windows 注册 `2` 项集成测试通过；Clippy 零警告，生产构建通过，生产依赖审计为 `0` 个漏洞。

## 2026-08-15 v0.5.1 正式发布审计

- PR #101 修复 MSI Native Host 链接与用户可写清单路径，PR #102 校正标签前/发布后的验收时序；两项 PR、各自合并后的 `master` CI 均全绿。标签 `v0.5.1` 最终指向发布基线 `2e481fb`。
- Release workflow `31890953593` 在标签源码上再次通过前端测试、依赖/包体/扩展审计、真实 Edge Runtime、Windows 生命周期、Rust 全量、严格 Clippy 与强制质量报告，再构建、签名并发布正式资产。
- Release 页面 7 个资产齐全且逐一下载；本地 SHA-256 与 GitHub Digest 全部一致。NSIS 为 `49425E69CFE9409FB9EF8C09FF3F11D9E0020C7531A6B5B09E505EBBF5C17D38`，MSI 为 `122731C8023753A87FAB26BD5A47CC3C88C507302C210C933D8D2946EB94C0D6`，两份 `.sig` 均使用应用内嵌公钥实际验签通过。
- `latest.json` 版本、三项 Windows 平台映射和签名正确。Assets API URL 在 Tauri Updater 自动发送 `Accept: application/octet-stream` 时返回完整 NSIS；实下载大小 `7,996,519` 字节，哈希与 Release NSIS 相同。
- 官方 v0.5.0 客户端真实自动发现 v0.5.1，点击应用内更新后完成在线下载、验签、安装与重启；最终安装版本为 0.5.1，Chrome/Edge Native Host 注册仍指向 LocalAppData 清单，词库 SHA-256 保持 `590BA9034A09CF5C2BBEC87EAF1926050661CB5C4162CF1B8B7BFF1BA0647D7B`。
- v0.5.1 由此完成发布收口并冻结 DOCX MVP。Microsoft Word 同批真实文档矩阵、全新 Windows VM 双安装器覆盖、Authenticode 和浏览器商店上架继续作为 P2；README 与应用继续明确 DOCX 预览边界，不从 WPS/LibreOffice 结果推导 Word 已通过。
