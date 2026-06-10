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

---

**Long翻译** 是一款专为 Windows 用户打造的 AI 翻译、OCR 截图识别与间隔重复背单词工具。结合现代 AI 模型的理解能力与 Windows 原生 OCR 性能，提供最顺滑的跨屏、跨软件阅读与学习体验。

---

## 🌟 核心特性

### 🚀 AI 翻译
- **流式实时翻译**: 支持 OpenAI / DeepSeek 及所有兼容接口，毫秒级 SSE 流式响应
- **双模型故障切换**: 主模型不可用时自动切换至备用 API，确保服务不中断
- **可自定义提示词**: 自由定制 AI 翻译 Prompt，支持 `{{targetLang}}` / `{{text}}` 占位符
- **术语表 (Glossary)**: 自定义固定术语译法，翻译时自动注入 AI 提示词
- **多模型对比翻译**: 主备模型并行翻译，左右分屏实时对比结果
- **回译验证**: 译文二次回译至源语言，快速校验翻译质量
- **剪贴板监听**: 开启后复制文字自动弹出 AI 翻译浮窗，无需快捷键
- **翻译历史**: 自动保存所有翻译记录，支持浏览、复制与删除
- **翻译记忆**: 缓存重复翻译内容，减少 API 调用费用
- **30 种目标语言**: 下拉菜单选择，源语言支持自动检测

### 🔍 系统级 OCR 识别
- 调用 Windows 原生 Media OCR 引擎，本地识别，隐私无忧
- 全屏截图、区域划选，一键提取并翻译
- **多显示器支持**: OCR 遮罩覆盖全部屏幕，副屏也能正常划选截图
- **OCR 语言选择**: 支持中/英/日/韩/法/德/西 8 种识别语言

### 🧠 SM-2 间隔重复背单词
- **卡片模式**: 3D 翻转卡片，正面单词+音标，点击翻面看释义+例句，评分后自动安排下次复习
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
- **搜索与排序**: 实时搜索过滤单词/释义，支持最新 / A-Z / Z-A 排序
- **Anki APKG 导出**: 一键导出为 `.apkg` 文件（7 字段 + 精美卡片模板），无缝导入 Anki
- **导出 CSV / JSON**: 一键导出含例句与近义词的完整数据
- **WebDAV 云端同步**: 支持坚果云、Nextcloud 等所有 WebDAV 服务，自动创建目录
- 懒加载渲染，数千单词流畅浏览

### 🎙️ 多引擎 TTS (语音合成)
- **本地引擎**: Youdao 词典 API，快速稳定
- **在线引擎**: OpenAI 兼容 TTS API，高保真语音合成
- 智能音频缓存，200MB LRU 自动驱逐
- 可调速、可调音色

### 💾 安全备份
- **密码加密**: 用户密码派生 AES-256-GCM 密钥
- 导出 `.TLong` 文件，跨设备一键迁移配置与生词本（含复习进度）
- 兼容旧版备份格式，无缝升级
- **静态数据加密**: API 密钥与 WebDAV 密码在 SQLite 中 AES-256-GCM 加密存储

### 🎨 视觉与体验
- 精美毛玻璃 Apple Style 设计，深色/浅色/跟随系统三种主题
- **8 色可自定义主题色**: 蓝/靛/紫/粉/橙/绿/青/薄荷，CSS 变量即时切换
- **Toast 通知系统**: 右上角堆叠、spring 动画、自动消失
- **弹性标签切换动画**: 定向滑入，自然流畅
- **暗色模式完整适配**: 所有下拉框、输入框、placeholder 暗色对比度已修复
- **可调整大小的浮动窗口**: 拖拽边缘自由缩放，适配长短文本
- **Ctrl+1~7 键盘导航**: 快速切换设置标签页
- **通知历史**: 铃铛图标保留最近 10 条系统消息
- **全局字号缩放**: 10-24px 自由调节
- **完整双语界面**: 中文 / English，140+ 翻译键全覆盖
- **自动更新**: 应用内检查并安装新版本
- **开机自启**: 可配置随系统启动
- **React ErrorBoundary**: 组件崩溃保护，一键刷新

---

## 📥 下载与安装

> **💡 推荐使用 `.exe` (NSIS)** 安装包，具备更优秀的系统权限处理。

| 平台 | 文件类型 | 下载链接 |
| :--- | :--- | :--- |
| **Windows (x64)** | **[推荐] NSIS 安装程序** | [v0.3.6 .exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.6/LongTranslate_0.3.6_x64_Setup.exe) |
| **Windows (x64)** | **MSI 安装包** | [v0.3.6 .msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.6/LongTranslate_0.3.6_x64_zh-CN.msi) |

<details>
<summary>历史版本</summary>

| 版本 | 日期 | 下载 |
|------|------|------|
| v0.3.5 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.5/LongTranslate_0.3.5_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.5/LongTranslate_0.3.5_x64_zh-CN.msi) |
| v0.3.4 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.4/LongTranslate_0.3.4_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.4/LongTranslate_0.3.4_x64_zh-CN.msi) |
| v0.3.3 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.3/LongTranslate_0.3.3_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.3/LongTranslate_0.3.3_x64_zh-CN.msi) |
| v0.3.2 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.2/LongTranslate_0.3.2_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.2/LongTranslate_0.3.2_x64_zh-CN.msi) |
| v0.3.1 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.1/LongTranslate_0.3.1_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.1/LongTranslate_0.3.1_x64_zh-CN.msi) |
| v0.3.0 | 2026-06 | [exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_Setup.exe) / [msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_zh-CN.msi) |
</details>

### 更新日志

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

| 层 | 技术 |
|---|---|
| **桌面框架** | Tauri 2.0 (Rust) |
| **前端** | React 19 + TypeScript + Vite 7 |
| **样式** | Tailwind CSS v4 + Framer Motion |
| **数据库** | SQLite (rusqlite, bundled, 版本化迁移) |
| **加密** | AES-256-GCM + SHA-256 (PBKDF2) |
| **AI 接口** | OpenAI 兼容 API (SSE 流式) |
| **OCR** | Windows Media Ocr (原生, 多屏支持) |
| **TTS** | Youdao API + OpenAI TTS |
| **同步** | WebDAV 协议 (双向合并) |
| **算法** | SM-2 间隔重复 (Anki 兼容) |

### 环境要求
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 10/11 已预装)
- [WiX Toolset v3.14](https://wixtoolset.org/) (MSI 构建，可选)

### 快速开始
```bash
git clone https://github.com/Longyuyeee/long_TranslateSoftware.git
cd long_TranslateSoftware
npm install
npm run tauri dev      # 开发模式
npm run tauri build    # 生产构建
```

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---

<p align="center">
  <i>Developed with ❤️ by <a href="https://github.com/Longyuyeee">longyuye</a></i>
</p>
