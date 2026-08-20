# PDF 文档翻译 MVP 执行与验收

最近更新：2026-08-20

## 目标与边界

`v0.5.1` 已冻结，只做回归维护。PDF 作为后续独立版本推进，当前第一增量只建立安全、只读的文本层导入基础，不提升版本、不接 UI、不发送翻译请求，也不宣称已经可以导出 PDF 成品。

首版只支持未加密、带可选择文本层的 `.pdf`，最终目标是让用户预览推断后的阅读顺序，再复用既有文档翻译队列并导出译文版或双语版 DOCX。扫描件 OCR、密码输入、像素级还原、多栏自动重排、公式、手写内容和原 PDF 回写不在 MVP 范围内。

## 第一增量完成情况

- 新增受限 PDF 解析模块和 Tauri 只读选择/检查命令；前端只增加类型安全的调用契约，尚未提供用户入口。
- 输入上限 50 MiB、2,000 页、100,000 个对象；单流解压 16 MiB、单页内容 8 MiB、单段 32 KiB、20,000 段、总文本 24 MiB、序列化结果 48 MiB。
- 非 PDF、空文件、无文本层、空密码加密和有密码加密 PDF 均使用稳定错误码拒绝。解析器 panic 被隔离为安全失败，不把文件路径或原文写入错误。
- 每段保留稳定顺序、页码和 `page:<n>:line:<n>` 位置；图片和批注产生降级警告。所有成功导入都会返回 `reading-order-inferred`，要求 UI 在翻译前展示阅读顺序预览。
- 使用 `lopdf 0.44` 且关闭默认功能，避免引入并行、日期和图片嵌入功能；依赖仍带来 PDF 解压、编码和加密识别相关传递包，必须在发布候选继续复核 EXE/安装包增量。
- 同一 Rust 工具链、同一 `--release` 配置和同一构建目录的 A/B 结果：远端 `master` 基线 EXE 为 26,916,352 字节，当前增量为 28,316,160 字节，增加 1,399,808 字节（5.20%）。当前绝对体积仍低于本机 8 月 13 日旧成品 29,688,832 字节，但 PDF 增量的真实成本不可忽略；后续 UI 增量不得继续新增解析库或重复运行时。

## 真实语料：预期、实际与修正

测试文件只下载到被 Git 忽略的 `.pdf-acceptance/`，仓库仅保存公开来源、SHA-256 和断言，避免提交第三方文档。

| 公开样本 | SHA-256 | 独立提取基线 | 产品实际结果 | 差异与处理 |
|---|---|---:|---:|---|
| [GOV.UK Easy Read guidance](https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/147646/dh_121927.pdf.pdf) | `4eeaaa58f2dd453528e6b46fd38e09f09354f590829b0110434bcbd9895c0c3c` | 40 页、47,925 字符 | 40 页、213 段、48,770 文本字节、0 个替换字符 | 独立提取器把一处长横线解码成替换字符，产品输出为正常 `–`；保留页级图片忽略警告。 |
| [NSW Know the warnings](https://www.nsw.gov.au/sites/default/files/noindex/2026-03/fact-sheet-know-the-warnings.pdf) | `55c41c41728ddae50c92a80a9963624c4d96895918c462549f1911d163016134` | 1 页、1,604 字符 | 1 页、4 段、1,643 文本字节、0 个替换字符 | 多栏文字在内容流中合并，不能据自动提取证明视觉阅读顺序；强制显示阅读顺序推断警告。 |
| [NSW Know your neighbours](https://www.nsw.gov.au/sites/default/files/noindex/2026-04/fact-sheet-know-your-neighbours.pdf) | `c02f188227d09b5220d8f7fb3d36f5ba15abe8a04793e49fe85b7c33f462919d` | 1 页、1,225 字符 | 1 页、4 段、1,292 文本字节、0 个替换字符 | 可见大标题不是可选择文本，解析结果从正文开始；不伪造标题，记录图片忽略和阅读顺序警告。 |
| [NSW Get Ready Resource Hub](https://www.nsw.gov.au/sites/default/files/noindex/2026-04/fact-sheet-resource-hub.pdf) | `b85626ba3ba32d70ddb359272834ae7d36cdf5b932fcae301d5c660295fe1de3` | 1 页、2,335 字符 | 1 页、4 段、2,423 文本字节、0 个替换字符 | 可见大标题不在文本层且正文为多栏；首版明确降级，不宣传版式还原。 |

独立基线使用 `pdfplumber` 从同一 SHA 文件提取；产品验收调用实际 Rust 解析路径，校验 SHA、页数、最低正文量、关键正文和 Unicode 替换字符。显式运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml inspects_real_public_pdf_corpus_against_recorded_expectations -- --ignored --nocapture
```

## 下一步顺序

1. 接入最小 PDF 工作台：系统选择器、文件统计、降级警告和有界阅读顺序预览；此阶段仍不翻译、不导出。
2. 将用户确认后的 PDF 段映射到既有文档任务模型，复用 Checkpoint、有界队列、取消和失败段重试；不得复制第二套调度器。
3. 只导出译文版/双语版 DOCX，并执行真实 PDF → DOCX 的 LibreOffice/WPS 逐页验收；PDF 原版式回写继续排除。
4. 审计新增依赖、Release EXE/MSI 增量、冷启动和峰值内存；完成全部质量门禁后再决定版本号和 Release。

每个增量结束必须更新本文件的预期与实际差异，运行全量测试与质量门禁，推送 PR 并等待 CI 通过后再进入下一项。

## 2026-08-20 第一增量审计

- 需求对齐：完成只读文本层导入、安全上限、稳定错误与真实语料；没有加入 UI、模型请求、DOCX 导出、OCR、版本提升或 Release。
- 自动化实际结果：前端 61 个测试文件 / 310 项通过；Rust 155 项单元测试通过，3 项显式语料测试按设计忽略；2 项生命周期、7 项 Native Host 进程和 2 项注册测试通过；严格 Clippy 通过。
- 真实效果：4/4 公开 PDF、共 43 页通过产品解析路径验收，0 个 Unicode 替换字符；空文本层、空密码加密和有密码加密 PDF 均按预期拒绝。可见图形标题缺失、多栏阅读顺序无法自动证明，已通过强制警告和后续 UI 预览要求修正产品承诺。
- 工程门禁：桌面/扩展生产构建通过；最大桌面 chunk 251.43 KiB / 300 KiB，扩展 34.33 KiB / 64 KiB；npm 官方安全审计 0 漏洞；质量报告 PASS。Browserslist 数据约 6 个月未更新，维持既有 P2 维护项。
- 仓库历史格式债未混入本次变更：全仓 `cargo fmt --check` 仍被既有 `db.rs`、`ocr.rs` 阻断，本次新增 Rust 文件已独立 `rustfmt`，`git diff --check` 通过。
