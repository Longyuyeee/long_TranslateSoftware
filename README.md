# Long翻译 (Long Translate)

<p align="center">
  <img src="public/logo.png" width="160" height="160" alt="Long Translate Logo">
</p>

<p align="center">
  <strong>一款基于 AI 的 Windows 系统级翻译、OCR 与单词学习工具</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Longyuyeee/long_TranslateSoftware?style=flat-square&color=3b82f6" alt="Release">
  <img src="https://img.shields.io/badge/Platform-Windows-blue?style=flat-square&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/Powered%20by-Tauri--Rust-orange?style=flat-square&logo=tauri" alt="Tauri">
  <img src="https://img.shields.io/badge/Built%20with-React--TS-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
</p>

<p align="center">
  <a href="#-下载与安装">下载安装</a> ·
  <a href="#-核心特性">核心特性</a> ·
  <a href="#更新日志">更新日志</a> ·
  <a href="MARKET_AUDIT.md">产品路线图</a>
</p>

---

**Long翻译** 是一款专为 Windows 用户打造的 AI 翻译、OCR 截图识别与间隔重复背单词工具。结合现代 AI 模型的理解能力与 Windows 原生 OCR 性能，提供最顺滑的跨屏、跨软件阅读与学习体验。

> **v0.4.9 桌面可靠性与架构收口**：修复首次启动仅驻留托盘、重复启动和通知角标问题，改善纵向布局、多语言与主题化下拉框，并完成真实 v0.4.8 → v0.4.9 覆盖升级验证。

---

## 🌟 核心特性

### 🚀 AI 翻译
- **流式实时翻译**: 支持 OpenAI / DeepSeek 及所有兼容接口，毫秒级 SSE 流式响应
- **双模型故障切换**: 主模型不可用时自动切换至备用 API，确保服务不中断
- **可解释任务状态**: 清晰展示准备、缓存检查、主模型、备用模型、成功、失败与取消状态
- **取消与原地重试**: 浮窗和批量翻译均可随时取消，失败后直接使用原文重试
- **可自定义提示词**: 自由定制 AI 翻译 Prompt，支持 `{{targetLang}}` / `{{text}}` 占位符
- **术语表 (Glossary)**: 自定义固定术语译法，仅在原文命中对应术语时注入提示词
- **多模型对比翻译**: 主备模型并行翻译，左右分屏实时对比结果
- **回译验证**: 译文二次回译至源语言，快速校验翻译质量
- **剪贴板监听**: 开启后复制文字自动弹出 AI 翻译浮窗，无需快捷键
- **翻译历史**: 自动保存所有翻译记录，支持浏览、复制与删除
- **翻译记忆**: 缓存随模型、服务商、语言、提示词和术语表变化自动失效，避免返回过期译文
- **30 种目标语言**: 下拉菜单选择，源语言支持自动检测

### 🔍 系统级 OCR 识别
- 调用 Windows 原生 Media OCR 引擎，本地识别，隐私无忧
- **自适应图像增强**: 自动放大小字号截图、增强对比度与锐度，弱结果使用二值化再次识别
- 全屏截图、区域划选，一键提取并翻译
- **识别结果校对**: OCR 后先编辑确认原文，空结果和识别失败可原地重新截图
- **多显示器支持**: OCR 遮罩覆盖全部屏幕，副屏也能正常划选截图
- **OCR 语言选择**: 覆盖约 30 种语言，实际可用语言取决于 Windows 已安装的 OCR 语言包

### 🧠 FSRS 间隔重复背单词
- **卡片模式**: 3D 翻转卡片，正面单词+音标，点击翻面看释义+例句，评分后自动安排下次复习
- **全键盘复习**: 空格翻面、数字 1–4 评分、方向键切换，完成后显示本轮数量和下次复习时间
- **测验模式**: 看单词选释义，10 题一轮即时反馈
- **FSRS 算法**: 新一代间隔重复（Anki 默认），稳定性/难度/可提取性三维记忆模型，准确率 90%
- **AI 记忆钩子**: 谐音、联想、拆分、故事等创意记忆法，琥珀色高亮卡片展示
- **学习统计**: 今日待复习 / 已复习 / 已掌握 / 连续天数

### ⌨️ 快捷键系统
- 默认 `Alt + Q` — 翻译选中文本（智能模拟 Ctrl+C，自动恢复剪贴板）
- 默认 `Alt + W` — 截图 OCR 识别（支持全部显示器）
- 设置中可实时录制自定义组合键，动态注册，无需重启

### 📚 智能 AI 生词本
- AI 深度解析：音标、中文释义、词源分析、多场景例句、近义词对比
- **上下文收藏**: 保存收藏时的原句、译文、来源和时间，同一单词可追加多条上下文
- **搜索与排序**: 实时搜索过滤单词/释义，支持最新 / A-Z / Z-A 排序
- **Anki APKG 导出**: 一键导出为 `.apkg` 文件（7 字段 + 精美卡片模板），无缝导入 Anki
- **导出 CSV / JSON**: 一键导出含例句与近义词的完整数据
- **WebDAV 云端同步**: 支持坚果云、Nextcloud 等所有 WebDAV 服务，自动创建目录
- 懒加载渲染，数千单词流畅浏览

### 🎙️ 多引擎 TTS (语音合成)
- **免费网络引擎**: Youdao 词典语音，适合中英文单词快速朗读
- **Edge 智能语音**: 自动识别中、英、日、韩、俄语和阿拉伯语并匹配对应音色
- **在线引擎**: OpenAI 兼容 TTS API，高保真语音合成
- 智能音频缓存，200MB LRU 自动驱逐
- 可调速、可调音色，语音失败提供明确提示

### 💾 安全备份
- **密码加密**: Argon2id 密钥派生 + AES-256-GCM 认证加密
- 导出 `.TLong` 文件，跨设备一键迁移配置与生词本（含复习进度）
- 兼容旧版备份格式，无缝升级
- **系统级静态保护**: API 密钥与 WebDAV 密码由 Windows DPAPI 加密并绑定当前 Windows 用户；旧数据首次读取时自动迁移
- **脱敏诊断导出**: 仅导出应用/数据库版本、功能配置状态和记录数量，明确排除密钥、密码、私有地址、提示词、词条、上下文、原文和译文

### 🎨 视觉与体验
- 精美毛玻璃 Apple Style 设计，深色/浅色/跟随系统三种主题
- **8 色可自定义主题色**: 蓝/靛/紫/粉/橙/绿/青/薄荷，CSS 变量即时切换
- **Toast 通知系统**: 右上角堆叠、spring 动画、自动消失
- **渐进式设置**: 常用配置优先展示，TTS、WebDAV、缓存和诊断按需展开；未保存状态始终可见
- **弹性标签切换动画**: 定向滑入，自然流畅
- **暗色模式完整适配**: 所有下拉框、输入框、placeholder 暗色对比度已修复
- **可调整大小的浮动窗口**: 拖拽边缘自由缩放，适配长短文本
- **Ctrl+1~7 键盘导航**: 快速切换设置标签页
- **通知历史**: 铃铛图标保留最近 10 条系统消息
- **全局字号缩放**: 10-24px 自由调节
- **完整双语界面**: 中文 / English，140+ 翻译键全覆盖
- **安全自动更新**: 启动后自动检测新版本，也可在设置中手动检查；展示版本说明和下载进度，安装包通过签名校验后静默安装并重启
- **开机自启**: 可配置随系统启动
- **React ErrorBoundary**: 组件崩溃保护，一键刷新

---

## 📥 下载与安装

> **💡 推荐使用 `.exe` (NSIS)** 安装包，具备更优秀的系统权限处理。

| 平台 | 文件类型 | 下载链接 |
| :--- | :--- | :--- |
| **Windows (x64)** | **[推荐] NSIS 安装程序** | [下载 v0.4.9 `.exe`](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.9/LongTranslate_0.4.9_x64_setup.exe) |
| **Windows (x64)** | **MSI 安装包** | [下载 v0.4.9 `.msi`](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.9/LongTranslate_0.4.9_x64.msi) |

<details>
<summary>历史版本</summary>

| 版本 | 日期 | 下载 |
|------|------|------|
| v0.4.8 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.8/LongTranslate_0.4.8_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.8/LongTranslate_0.4.8_x64.msi) |
| v0.4.7 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.7/LongTranslate_0.4.7_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.7/LongTranslate_0.4.7_x64.msi) |
| v0.4.6 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.6/LongTranslate_0.4.6_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.6/LongTranslate_0.4.6_x64.msi) |
| v0.4.5 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.5/LongTranslate_0.4.5_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.5/LongTranslate_0.4.5_x64.msi) |
| v0.4.4 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.4/LongTranslate_0.4.4_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.4/LongTranslate_0.4.4_x64.msi) |
| v0.4.3 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.3/LongTranslate_0.4.3_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.3/LongTranslate_0.4.3_x64.msi) |
| v0.4.2 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.2/LongTranslate_0.4.2_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.2/LongTranslate_0.4.2_x64.msi) |
| v0.4.1 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.1/LongTranslate_0.4.1_x64_setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.1/LongTranslate_0.4.1_x64.msi) |
| v0.4.0 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.0/LongTranslate_0.4.0_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.4.0/LongTranslate_0.4.0_x64_zh-CN.msi) |
| v0.3.7 | 2026-07 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.7/LongTranslate_0.3.7_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.7/LongTranslate_0.3.7_x64_zh-CN.msi) |
| v0.3.6 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.6/LongTranslate_0.3.6_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.6/LongTranslate_0.3.6_x64_zh-CN.msi) |
| v0.3.5 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.5/LongTranslate_0.3.5_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.5/LongTranslate_0.3.5_x64_zh-CN.msi) |
| v0.3.4 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.4/LongTranslate_0.3.4_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.4/LongTranslate_0.3.4_x64_zh-CN.msi) |
| v0.3.3 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.3/LongTranslate_0.3.3_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.3/LongTranslate_0.3.3_x64_zh-CN.msi) |
| v0.3.2 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.2/LongTranslate_0.3.2_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.2/LongTranslate_0.3.2_x64_zh-CN.msi) |
| v0.3.1 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.1/LongTranslate_0.3.1_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.1/LongTranslate_0.3.1_x64_zh-CN.msi) |
| v0.3.0 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_zh-CN.msi) |
</details>

### 更新日志

<details open>
<summary><strong>v0.4.9 — Desktop Reliability & Architecture</strong></summary>

**桌面可靠性**
- 手动启动、重复启动和托盘恢复统一显示、取消最小化并聚焦同一主窗口
- 开机自启继续保持静默托盘模式，单实例进程契约纳入真实子进程测试
- 通知历史打开后清除未读角标，删除最后一条或全部清除时同步关闭面板

**界面与适配**
- 改善较矮窗口和 200% DPI 环境中的纵向滚动与可操作区域
- 补齐中英文用户可见文本，统一主题化下拉框及明暗主题样式
- 设置、翻译、历史、生词本等页面按需加载，最大生产 JavaScript 块保持在 300 KiB 门槛内

**架构与升级**
- 拆分翻译、TTS、OCR、应用统计、生词本和诊断边界，统一结构化命令错误
- 完成正式 v0.4.8 → v0.4.9 原位升级验证，设置、统计数据和开机自启注册项保持兼容
- 保持原有 Updater 公钥与数据库结构，不要求迁移用户数据

</details>

<details>
<summary><strong>v0.4.8 — Measurable Quality & Architecture</strong></summary>

**可量化质量**
- 翻译格式、TTS 路由/音频和 Windows OCR 真实 PNG 识别纳入自动质量门槛
- CI 与正式 Release 生成统一 JSON 质量报告，阈值失败会阻断交付

**数据可靠性**
- WebDAV 使用 ETag 条件写入保护多设备同步，并提供连接测试、结构化错误和同步摘要
- 加密备份在替换数据库前验证内容；Anki 导出修复动态牌组、字段转义和临时文件清理

**前后端架构**
- Rust 拆分历史/记忆、复习、TTS、备份、Anki、WebDAV、OCR、诊断和生词本模块
- 诊断导出与更新器配置判断从应用入口迁入领域模块，`lib.rs` 仅保留应用壳初始化
- 应用统计、OCR 与诊断命令使用稳定的 `code + message` 错误契约，前端同时兼容旧字符串错误
- 前端拆分更新、批量翻译、生词本和设置持久化流程，并覆盖竞态、取消和兼容迁移

**交互与兼容**
- 更新与 OCR 弹窗支持焦点循环、Escape 关闭和焦点恢复，主导航支持完整键盘操作
- 不修改数据库结构，现有设置、生词本、复习进度和 WebDAV 数据保持兼容

</details>

<details>
<summary><strong>v0.4.7 — WebDAV Reliability & Diagnostics</strong></summary>

**连接与诊断**
- 设置页增加 WebDAV 连接测试和延迟显示
- 认证、权限、路径、超时、离线、服务器和远端数据错误均提供中英文分类提示
- 最近同步结果展示新增、更新和上传条目数量

**同步可靠性**
- 使用 ETag 条件写入保护多设备同步；云端在同步期间变化时提示重试，不静默覆盖
- 隔离服务测试覆盖下载、合并、上下文保存、条件上传和并发冲突
- 修复旧数据库中可空生词字段导致同步失败的问题

**大数据量生词本**
- 生词检索、排序和分页移至 Rust 后端，默认每次加载 100 条
- 建立一万条数据的首屏与搜索自动化基线，避免全部记录一次进入前端

**键盘与焦点**
- 更新弹窗和 OCR 确认弹窗支持焦点循环、Escape 关闭及关闭后的焦点恢复
- 主导航支持方向键、Home、End 和 Ctrl+1～7，并提供当前页面与导航区域语义

**错误恢复**
- 前端命令无法解析数据目录时返回可诊断错误，不再直接终止应用
- 启动、托盘、Anki 导出、WebDAV 目录创建和 Edge TTS 请求构造移除生产态 panic 路径
- 高级设置可导出仅包含版本、配置状态和数据量的脱敏诊断 JSON，不包含密钥、密码、私有地址、原文或译文

**架构收口**
- 翻译历史和翻译记忆从主 Rust 入口拆分为独立模块，保持现有前端命令兼容
- 历史查询限制在每次 1～500 条并修正负偏移；独立测试覆盖分页、删除、清空以及模型上下文缓存隔离
- FSRS 调度、到期卡片与学习统计拆分为独立复习模块，评分状态通过单一数据库事务提交
- 到期查询限制在每次 1～200 条，评分限制为 1～4；已删除词条不再影响连续复习天数
- TTS 与音频缓存拆分为独立 Rust 模块；空音频不再写入或命中缓存，普通 HTTP 语音请求会拒绝非成功响应
- TTS 独立测试覆盖请求头安全、语言与语速、SSML 转义、缓存键隔离和容量回收
- 加密备份导入/导出拆分为独立 Rust 模块，保持 `.TLong` 和历史版本解密兼容
- 备份导入会在数据库替换前校验配置与词库结构；空密码或无效备份不会清空现有数据
- Anki APKG 导出拆分为独立 Rust 模块，修正动态牌组配置并保证异常路径自动清理临时文件
- Anki 导出字段会转义 HTML 与字段分隔符；独立测试核对 collection 数据库、7 字段和 APKG 必需条目
- 批量翻译、双模型对比、回译和取消操作从 `Dashboard` 抽离为独立 hook
- 批量翻译界面与术语表组合区按需加载，保留跨页签任务状态；双模型结果在窄窗口自动改为纵向布局
- 批量流程通过请求编号隔离过期回调，并在页面卸载时取消进行中的任务；独立测试覆盖流式输出、历史保存和卸载清理
- 剪贴板监控通过独立 hook 串行轮询并过滤重复文本，停用或卸载后不会再触发迟到的浮窗请求
- 生词本分页、搜索、排序、选择、新增与删除编排从 `Dashboard` 抽离为独立 hook
- 生词本筛选使用防抖与请求编号隔离，避免较慢的旧查询覆盖最新结果；前端补充分页追加、选中项刷新和表单清理测试
- 设置默认值、旧键迁移、OCR 语言回退、脏状态、关闭提醒与保存编排从 `Dashboard` 抽离为独立 service/hook
- 设置加载通过请求编号隔离旧响应；无效界面语言与字号会回到安全范围，加载失败后仍可继续编辑并保存
- 术语表增删改查通过类型化 service/hook 与 `Dashboard` 隔离，旧加载响应不会覆盖最新数据，快速连点不会重复写入
- 术语表编辑器改为独立懒加载组件，补齐失败重试、中英文操作名称、键盘保存/取消和窄窗口纵向布局
- 术语表 Tauri 命令迁入独立 Rust 模块，返回真实创建时间、稳定排序并显式传播数据库读取错误
- 配置 Tauri 命令迁入独立 Rust 模块，批量保存保持事务原子性，敏感键继续使用 DPAPI 并自动迁移旧明文
- 生词本增删改查、上下文读取与 CSV/JSON 导出迁入独立 Rust 模块；兼容旧可空数据，移除未注册且与现行同步实现重复的旧 WebDAV 代码
- 应用统计与翻译计数迁入独立 Rust 模块；计数改为 SQLite 原子自增，损坏计数可恢复，异常或未来安装日期不会产生非正活跃天数
- OCR Base64、截图识别、文本确认与语言枚举命令迁入 OCR Rust 模块；支持 Data URL，显式传播配置错误，并拒绝零尺寸或坐标溢出的截图请求
- 窗口与剪贴板 Tauri 命令迁入独立 Rust 模块；OCR 遮罩按虚拟桌面物理边界覆盖高 DPI 多显示器，负坐标与缩放换算纳入测试
- 全局快捷键解析、注册与模拟复制迁入独立 Rust 模块；无效组合不会替换现有快捷键，快速重复触发被原子隔离，翻译完成后自动恢复文本剪贴板
- 快捷键录制、自启动、音频缓存与诊断导出从 `Dashboard` 下沉到独立 hook/service；卸载时恢复快捷键，迟到结果不再更新界面或弹出通知
- 侧栏、统计、标题栏、通知、保存/更新入口和页签切换动画收敛到独立 `DashboardShell`；鼠标、Ctrl+数字和循环方向键导航具有组件回归测试
- 启动数据加载、应用统计、词库/配置/WebDAV 事件、延迟后台同步、手动同步和连接测试收敛到独立 hook；后台与手动同步互斥，卸载后不再处理迟到结果
- 加密备份导入导出、生词本 CSV/JSON/Anki 导出、缓存清理、自启动与诊断反馈收敛到独立动作 hook；重复导出、迟到结果和导入重载定时器均有隔离保护
- OpenAI 兼容 HTTP 超时、取消、SSE 解析、状态码映射和连接探测收敛到独立传输模块；`api.ts` 保留原有连接测试导出，调用方无需迁移
- 单次翻译任务、术语筛选、提示词、缓存指纹、格式校验和主备故障切换收敛到独立任务模块；`api.ts` 的既有导出仍绑定到新实现
- 双模型对比任务与旧回调式流式/对比入口收敛到独立对比模块；`api.ts` 继续提供相同兼容导出，现有调用方无需迁移
- TTS 配置、缓存、引擎路由、远程音频获取与 Web Audio 播放收敛到独立语音模块；`api.ts` 保留 `speak` 兼容导出
- 通用设置页的快捷键、WebDAV 和存储维护区块拆为独立受控组件；父页只保留核心设置、高级区展开状态和组合布局
- CI 启动真实应用子进程验证手动启动与开机自启决策；窗口恢复、关闭到托盘、托盘菜单和通知清除使用可重复的策略回归测试

**翻译质量门槛**
- 固定评测术语、数字、URL、占位符、Markdown、XML、行内代码和长上下文的格式保持
- 无效缓存会重新请求；主模型遗漏必要内容时自动切换备用模型
- 主备模型均未通过时返回明确错误，且不保存无效译文

**语音质量夹具**
- 固定验证中英日韩俄阿文本的音色路由和语言不匹配降级原因
- 覆盖 MP3、WAV、Ogg、M4A、WebM、AAC 音频容器以及 HTML/JSON 错误响应
- 音频解码失败返回稳定错误信息，便于定位服务响应问题

**OCR 语言与质量基线**
- OCR 设置优先显示 Windows 已安装的识别语言，失败时使用内置列表
- 兼容旧短语言标签，不支持的已保存选项安全回到系统默认
- 新增字符错误率计算与五类文本基线
- 小字号、深色字幕和缩放 PNG 会经过真实 Windows OCR，单场景 CER 超过 20% 时测试失败

**统一质量报告**
- CI 汇总翻译格式、TTS 路由/音频和 OCR 文本/真机指标
- 报告包含期望值、实测值、阈值和 Git 提交号，并作为 Actions artifact 提供下载
- 正式发版会把同一份 JSON 附加到 GitHub Release，报告缺失或失败会阻断交付

</details>

<details>
<summary><strong>v0.4.6 — Recognition & Speech Accuracy</strong></summary>

**OCR 与语言适配**
- 小字号截图自动放大并增强灰度、对比度和锐度，弱识别结果追加二值化重试
- 自动选择原图与增强图中质量更高的识别结果
- OCR 语言选项扩展至约 30 种，并继续使用 Windows 本地识别保护隐私

**翻译准确性**
- 翻译缓存加入模型、服务地址、源语言、提示词和术语表指纹，配置变化后不再复用旧译文
- 术语表只注入原文实际命中的词条，并处理英文词边界、重复词条与长度限制
- 默认提示词强化段落、数字、URL、占位符、专名和语气保真，并隔离原文中的潜在指令

**英语与多语种语音**
- 设置页开放 Edge 智能语音，自动匹配中、英、日、韩、俄语和阿拉伯语音色
- 修复 Edge 语音语言固定为中文、语速不生效及缓存未区分语速的问题
- 将原“本地语音”更名为“免费网络”，并补充语音播放失败提示

> 升级时会清理可再生成的旧翻译缓存，翻译历史、生词本、设置和学习进度不受影响。

</details>

<details>
<summary><strong>v0.4.5 — Secure Storage & Quality Closure</strong></summary>

**安全与同步**
- 敏感配置升级为 Windows DPAPI 用户级保护，旧明文和旧加密格式首次读取时自动迁移
- 修复 WebDAV 同步读取加密密码而导致认证失败的问题
- 跨设备加密备份导入后会使用新电脑的 Windows 用户密钥重新保护配置

**体验与工程质量**
- 更新弹窗新增主操作自动聚焦和 Escape 关闭，更新状态机从 Dashboard 独立拆分
- 主题选择器与更新弹窗增加真实键盘和可访问性组件测试
- 新增持续集成质量门槛，发布正文按版本文档自动生成
- 清理事件广播、音频缓存和互斥锁等用户路径中的可恢复崩溃点

</details>

<details>
<summary><strong>v0.4.4 — Localization & Themed Selectors</strong></summary>

**多语言与主题**
- 全部原生下拉框替换为统一的主题化选择器，完整适配深色、浅色和强调色
- 补齐语言名称、设置说明、备份提示、状态与后台通知的中英文文案
- 修复切换语言后部分后台通知仍使用启动时语言的问题

**交互与布局**
- 下拉菜单支持键盘选择、长列表滚动，并根据视口空间自动调整展开方向
- 优化窄窗口下批量翻译操作区、生词本搜索和排序控件的布局
- 修复生词本输入提示及分析状态显示为模板文本的问题

</details>

<details>
<summary><strong>v0.4.3 — Startup & Interface Reliability</strong></summary>

**启动与托盘**
- 启用桌面端单实例保护，连续点击快捷方式只保留一个进程和一个托盘图标
- 第二次手动启动会唤醒、取消最小化并聚焦已有主窗口
- 手动首次启动直接显示设置主界面，开机自启仍保持静默托盘模式

**界面与通知**
- 优化低高度窗口下的侧栏滚动、标题栏高度、内容间距和统计区域显示
- 通知角标在打开面板后立即标记已读，支持逐条移除和全部清除
- 点击通知面板外部即可关闭，避免空面板和残留未读状态

</details>

<details>
<summary><strong>v0.4.2 — Brand Icon Refresh</strong></summary>

**全新品牌图标**
- 使用清晰的 `L` 形主轮廓，在任务栏、托盘和安装程序的小尺寸场景中保持辨识度
- 冷白与亮蓝对话框通过连续 S 曲线相互咬合，以阴阳式结构表达两种语言的转换与融合
- 琥珀橙与珊瑚橙双向箭头和蓝色主体形成互补色关系，强化翻译语义
- 统一替换 Windows、Appx、macOS、Android 与 iOS 所需的整套图标资源

**发布一致性**
- 前端、Rust 与 Tauri 配置版本统一升级至 `0.4.2`
- 更新 README、Release Notes、安装包与 Updater 签名产物
</details>

<details>
<summary><strong>v0.4.1 — Secure In-App Updates</strong></summary>

**安全更新链路**
- 启动后静默检测新版本，也可在设置页手动检查
- 更新弹窗展示目标版本、发布说明、下载进度、安装状态与失败重试
- 使用 minisign 强制校验更新包签名，校验通过后才允许安装
- Windows 使用被动安装模式，完成后自动重启应用

**自动发布工程**
- 新增 GitHub Actions 发布工作流，版本标签触发测试、构建、签名和 Release 发布
- 自动生成 NSIS / MSI 安装包、对应 `.sig` 签名及 Updater 所需的 `latest.json`
- 私钥保存在 Git 忽略目录，并通过 GitHub Secrets 注入云端构建

> v0.4.1 是自动更新桥接版本。v0.4.0 及更早用户需要手动安装本版本一次，之后即可在应用内升级。
</details>

<details>
<summary><strong>v0.4.0 — Experience Refinement Update</strong></summary>

**翻译体验**
- 浮窗与批量翻译统一为显式任务状态，支持取消、原地重试、缓存提示和过期请求隔离
- 主模型失败后备用模型从空结果开始，模型状态与技术错误不再污染可复制译文
- 模型配置增加 DeepSeek / OpenAI / 自定义预设、连接测试及渐进式高级参数

**OCR 与学习闭环**
- OCR 识别后可编辑确认，支持空结果、失败重试以及 Enter / Shift+Enter / Esc 操作
- 数据库升级至 schema v7；生词可保存多条原句、译文、来源和时间，并参与备份与 WebDAV 合并
- 复习支持全键盘流程、重复提交保护、本轮统计和下次复习时间

**设置、性能与质量**
- 设置页区分基础与高级配置，提供未保存、保存中、已保存和失败反馈
- 配置读取与保存改为单连接批量事务，减少翻译启动和设置加载时的重复数据库访问
- Toast 去重限流，统一焦点、禁用状态和 reduced-motion 行为
- 13 项前端测试、3 项 Rust 测试、严格 Clippy、生产构建和安全审计全部通过
</details>

<details>
<summary><strong>v0.3.7 — Reliability & Security Update</strong></summary>

**稳定性**
- 修复 SSE 数据跨网络分块时可能丢失译文的问题，完整保留拆分的 JSON 与 UTF-8 中文字符
- 更新器未配置发布签名时显示明确引导，并移除重复安装调用
- 清理 Rust Clippy 告警和误提交文件，补充 MIT License

**安全与数据**
- 备份升级为 v3：使用 Argon2id + AES-256-GCM，敏感配置可安全跨设备迁移
- 保持 v0 / v1 / v2 历史 `.TLong` 备份兼容
- 升级 Vite、PostCSS、esbuild 等构建依赖，npm 安全审计归零

**工程质量**
- 新增流式解析和加密备份自动化测试
- 前端升级至 Vite 8，Node.js 最低版本调整为 20.19
</details>

<details>
<summary>v0.3.6 — Vocabulary & Translation Quality Update</summary>

**新增**
- **FSRS 间隔重复算法** — 替换 SM-2，记忆准确性从 47% 提升至 90%（Anki 默认算法）
- **剪贴板监听模式** — 开启后复制任何文字自动弹出 AI 翻译浮窗
- **AI 记忆钩子** — 单词分析新增谐音/联想/拆分等记忆技巧（琥珀色卡片展示）
- **Anki APKG 导出** — 一键导出单词本为 `.apkg` 文件，可导入 Anki 生态
- **回译验证 (Back-translation)** — 将译文回译至源语言，快速校验翻译准确性
- **Batch 标签页语言选择器** — 输入/输出面板可直接切换源语言和目标语言

**优化**
- 单词详情面板全部标签（Meaning/Etymology/Synonyms/Examples）i18n 化
- 已掌握判定从 `repetitions >= 3` 升级为 `stability >= 21 days` (FSRS)
- 数据库 v6 迁移：新增 stability/difficulty 列，SM-2 数据自动转换
</details>

<details>
<summary>v0.3.5 — Feature Update</summary>

**新增**
- **定向弹性动画标签切换** — 左右导航时内容自然滑入，spring 物理曲线
- **Toast 通知系统** — 成功/错误/警告/信息 4 类，右上角堆叠、自动消失
- **单词本搜索与排序** — 实时过滤单词/释义 + 最新 / A-Z / Z-A 排序
- **可自定义主题色** — 8 种预设颜色（蓝/靛/紫/粉/橙/绿/青/薄荷），CSS 变量即时切换
- **术语表 (Glossary)** — 自定义固定术语译法，翻译时自动注入 AI 提示词
- **多模型对比翻译** — 主模型与备用模型并行翻译，左右分屏对比结果

**优化**
- 移除旧 header 状态栏，统一使用 Toast 通知系统
- 全部硬编码 blue-500/600 替换为 runtime CSS 变量 (`--accent`)
- 单词本加载更多按钮在搜索激活时自动隐藏
- 单词表左侧面板增加搜索框与排序下拉
</details>

<details>
<summary>v0.3.4 — Fullscreen Layout Fix</summary>

- 修复全屏时通用设置/模型配置/外观显示内容靠左、右侧大量空白的问题
- 内容区域从 max-w-2xl (672px) 改为 max-w-3xl mx-auto (768px 居中)
</details>

<details>
<summary>v0.3.3 — Dark Mode & i18n Polish</summary>

- 修复所有 `<select>` 下拉框暗色模式白底白字
- 修复 FloatingWindow 暗色文字不可见
- 修复所有输入框/文本域暗色 placeholder 不可见
- 改善侧边栏暗色对比度
- ErrorBoundary / OcrOverlay / ReviewTab 双语化
- FloatingWindow 全部 UI 文字改用 i18n 键
- Dashboard 状态消息统一走 addNotification + i18n
- HTML 标题修正为 "Long翻译 · AI智能助手"
- 移除 db.rs / tray.rs 中的 unwrap panic 风险
</details>

<details>
<summary>v0.3.2 — Multi-Monitor OCR</summary>

- OCR 遮罩覆盖全部显示器，副屏也能正常划选截图
</details>

<details>
<summary>v0.3.1 — Bug Fixes</summary>

- 修复测验模式每次 Next 重新随机出题
- 导出/导入/WebDAV 同步保留 SM-2 复习进度
- 每次卡片复习后刷新侧边栏统计
</details>

<details>
<summary>v0.3.0 — Major Feature Update</summary>

**新增**
- 翻译历史 · 多模型故障切换 · 密码加密备份 · 自动更新 · 浮动窗口可调大小
- 可自定义翻译提示词 · 源/目标语言下拉菜单 · OCR 语言选择
- 生词本导出 CSV/JSON · WebDAV 自动创建目录 · 翻译记忆缓存
- 音频缓存 LRU · 通知历史 · Ctrl+1~6 键盘导航 · 完整中英双语

**优化** — 数据库索引 · 生词本懒加载 · API 超时 · 版本化迁移

**修复** — OCR DPI · 剪贴板竞态 · WebDAV 错误保护 · 软删除 · 移除失效 Edge TTS
</details>

---

## 🛡️ 安全与权限说明

由于本项目尚未购买 Windows 数字签名证书，安装时可能会遇到 **Microsoft Defender SmartScreen** 警告。

1. 点击 **"更多信息" (More info)**
2. 点击 **"仍要运行" (Run anyway)** 即可安装

> 本项目完全开源，可在 GitHub 查阅所有[源代码](https://github.com/Longyuyeee/long_TranslateSoftware)，确保安全无毒。

---

## 🛠️ 技术栈

当前稳定版为 v0.4.9；后续产品主线已收敛为 v0.5.0 Chrome / Edge 浏览器扩展 MVP，以及 v0.5.1 PDF / Word 文档翻译 MVP。详细边界、风险和退出门槛见：

- [v0.5.x 当前开发审计与执行计划（2026-08-10）](docs/DEVELOPMENT_PLAN_2026-08-10.md)
- [开发审计与后续路线](docs/DEVELOPMENT_AUDIT_2026-07-27.md)
- [当前开发状态审计与执行计划（2026-07-30）](docs/DEVELOPMENT_STATUS_2026-07-30.md)
- [开发接手说明](docs/NEXT_STEPS.md)
- [Native Messaging v1 协议与安全边界](docs/NATIVE_MESSAGING_PROTOCOL.md)
- [Chrome / Edge Native Messaging 烟雾清单](docs/BROWSER_EXTENSION_SMOKE.md)
- [Windows 发布候选桌面交互烟雾清单](docs/RELEASE_DESKTOP_SMOKE.md)
- [体验打磨开发计划](EXPERIENCE_DEVELOPMENT_PLAN.md)
- [竞品与功能差距审计](MARKET_AUDIT.md)

浏览器扩展目前已完成协议层、单 EXE Native Host、Windows 注册器、桌面私有 IPC、配对授权、`translate` / `cancel` / `add_word` 以及用户主动启用的划词翻译浮层。扩展只申请 `nativeMessaging`、`activeTab` 和 `scripting`，不声明持久网站权限或常驻 content script；刷新页面即移除注入，只有用户点击“译”后才把所选文字交给桌面翻译核心，翻译成功后才显示收藏入口。生词本写入使用独立的 `wordbook` 能力，旧的只读授权必须由用户重新确认；授权记录不保存 API Key、网页原文或译文。Chrome/Edge 真实交互烟雾与商店正式 ID 尚未完成。PDF / Word 翻译目前处于设计阶段，仓库尚无 PDF 文本层解析、DOCX 解析/重建或文档任务队列。

Windows 审计构建可先运行 `npm run smoke:browser:preflight -- -RegisterNativeHost -RequireDesktop`，排除浏览器缺失、旧 EXE、错误注册、扩展权限扩大和桌面桥接未就绪等环境问题；该预检不会替代 Chrome / Edge 的真实交互烟雾。

| 层 | 技术 |
|---|---|
| **桌面框架** | Tauri 2.0 (Rust) |
| **前端** | React 19 + TypeScript + Vite 8 |
| **样式** | Tailwind CSS v4 + Framer Motion |
| **数据库** | SQLite (rusqlite, bundled, 版本化迁移) |
| **加密** | Argon2id + AES-256-GCM |
| **AI 接口** | OpenAI 兼容 API (SSE 流式) |
| **OCR** | Windows Media Ocr (原生, 多屏支持) |
| **TTS** | Youdao API + OpenAI TTS |
| **同步** | WebDAV 协议 (双向合并) |
| **算法** | FSRS 间隔重复 (Anki 兼容) |
| **浏览器桥接** | Native Messaging v1 + 单 EXE Host + Windows 安装集成 + 最小 MV3 开发扩展（待真实浏览器烟雾） |
| **文档翻译** | v0.5.1 规划中（DOCX 与文本型 PDF MVP） |

### v0.5.0 浏览器桥接最新进度（2026-08-12）

- Native Host、桌面私有 IPC 与现有桌面核心已打通 `translate` / `cancel` / `add_word`，继续由桌面端独占 API Key、模型配置、术语表、生词本和缓存。
- 扩展 service worker 提供带任务 ID 的内部翻译与取消入口；桌面桥接未就绪、未配对、超时、限流和服务商失败均返回结构化错误。
- 划词浮层采用用户触发的 `activeTab` 注入，不申请持久网站访问权；收藏需要独立 `wordbook` 授权，下一步执行 Chrome / Edge 真实配对、翻译、取消与收藏烟雾。

### 环境要求
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Node.js](https://nodejs.org/) (v20.19+)
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 10/11 已预装)
- [WiX Toolset v3.14](https://wixtoolset.org/) (MSI 构建，可选)

### 快速开始
```bash
git clone https://github.com/Longyuyeee/long_TranslateSoftware.git
cd long_TranslateSoftware
npm install
npm test               # 自动化测试
npm run quality:report # 生成质量报告（真机 OCR 数据由 CI/Rust 测试提供）
npm run tauri dev      # 开发模式
npm run tauri build    # 生产构建
```

### 发布与自动更新

推送形如 `v0.4.6` 的版本标签后，GitHub Actions 会自动测试、构建、签名并发布 Windows 安装包和 `latest.json` 更新清单。完整的密钥保管、桥接版本和发版检查说明见 [Updater 发布指南](docs/UPDATER_RELEASE.md)。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---

<p align="center">
  <i>Developed with ❤️ by <a href="https://github.com/Longyuyeee">longyuye</a></i>
</p>
