# Long翻译 (Long Translate)

<p align="center">
  <img src="public/logo.png" width="160" height="160" alt="Long Translate Logo">
</p>

<p align="center">
  <strong>一款基于 AI 的 Windows 系统级翻译与 OCR 智能工具</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/Longyuyeee/long_TranslateSoftware?style=flat-square&color=3b82f6" alt="Release">
  <img src="https://img.shields.io/badge/Platform-Windows-blue?style=flat-square&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/Powered%20by-Tauri--Rust-orange?style=flat-square&logo=tauri" alt="Tauri">
  <img src="https://img.shields.io/badge/Built%20with-React--TS-61DAFB?style=flat-square&logo=react" alt="React">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
</p>

---

**Long翻译** 是一款专为 Windows 用户打造的极速 AI 翻译与 OCR 工具。它结合了现代 AI 模型的理解能力与系统原生的 OCR 性能，旨在为您提供最顺滑的跨屏、跨软件阅读体验。

---

## 🌟 核心特性

### 🚀 AI 翻译
- **流式实时翻译**: 支持 OpenAI / DeepSeek 及所有兼容接口，毫秒级 SSE 流式响应
- **双模型故障切换**: 主模型不可用时自动切换至备用 API，确保服务不中断
- **可自定义提示词**: 自由定制 AI 翻译 Prompt，支持 `{{targetLang}}` / `{{text}}` 占位符
- **翻译历史**: 自动保存所有翻译记录，支持浏览、复制与删除
- **翻译记忆**: 缓存重复翻译内容，减少 API 调用费用
- **30 种目标语言**: 下拉菜单选择，源语言支持自动检测

### 🔍 系统级 OCR 识别
- 调用 Windows 原生 Media OCR 引擎，本地识别，隐私无忧
- 全屏截图、区域划选，一键提取并翻译
- **OCR 语言选择**: 支持中/英/日/韩/法/德/西 8 种识别语言，不再局限于系统语言

### ⌨️ 快捷键系统
- 默认 `Alt + Q` — 翻译选中文本（智能模拟 Ctrl+C，自动恢复剪贴板）
- 默认 `Alt + W` — 截图 OCR 识别
- 设���中可实时录制自定义组合键，动态注册，无需重启
- 快捷键录制时自动暂停全局监听，避免冲突

### 📚 智能 AI 生词本
- AI 深度解析：音标、中文释义、词源分析、多场景例句、近义词对比
- **导出 CSV / JSON**: 一键导出含例句与近义词的完整数据
- **WebDAV 云端同步**: 支持坚果云、Nextcloud 等所有 WebDAV 服务，双向合并
- 懒加载渲染，数千单词流畅浏览

### 🎙️ 多引擎 TTS (语音合成)
- **本地引擎**: Youdao 词典 API，快速稳定
- **在线引擎**: OpenAI 兼容 TTS API，高保真语音合成
- 智能音频缓存，200MB LRU 自动驱逐
- 可调速、可调音色

### 💾 安全备份
- **密码加密**: 用户密码派生 AES-256-GCM 密钥，告别硬编码
- 导出 `.TLong` 文件，跨设备一键迁移配置与生词本
- 兼容旧版备份格式，无缝升级
- **静态数据加密**: API 密钥与 WebDAV 密码在 SQLite 中加密存储

### 🎨 视觉与体验
- 精美毛玻璃 Apple Style 设计，支持深色/浅色/跟随系统三种主题
- **可调整大小的浮动窗口**: 拖拽边缘自由缩放，适配长短文本
- **Ctrl+1~6 键盘导航**: 快速切换设置标签页
- **通知历史**: 铃铛图标保留最近 10 条系统消息
- **全局字号缩放**: 10-24px 自由调节
- **双语界面**: 中文 / English 一键切换
- **自动更新**: 应用内检查并安装新版本
- **开机自启**: 可配置随系统启动

---

## 📥 下载与安装 (v0.3.0)

> **💡 提示：** 推荐优先使用 **`.exe` (NSIS)** 安装包，具备更优秀的系统权限处理。

| 平台 | 文件类型 | 下载链接 |
| :--- | :--- | :--- |
| **Windows (x64)** | **[推荐] NSIS 安装程序** | [立即下载 .exe](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_Setup.exe) |
| **Windows (x64)** | **MSI 安装包** | [立即下载 .msi](https://github.com/Longyuyeee/long_TranslateSoftware/releases/download/v0.3.0/LongTranslate_0.3.0_x64_zh-CN.msi) |

### 更新日志 (v0.3.0)

<details>
<summary>点击展开完整 Changelog</summary>

**主要新增**
- 翻译历史：自动保存、浏览、复制、删除
- 多模型故障切换：主模型失败自动切换备用 API
- 密码加密备份：替换硬编码密钥，兼容旧格式
- 自动更新：应用内检查并安装新版本
- 浮动窗口可调整大小
- 可自定义 AI 翻译提示词
- 源语言/目标语言下拉菜单（30 种语言）
- OCR 语言独立选择
- 生词本导出 CSV / JSON
- WebDAV 自动创建目录
- 翻译记忆缓存
- 音频缓存 LRU 驱逐 (200MB)
- 通知历史日志
- 键盘快捷键 (Ctrl+1~6)
- 完整中英双语界面
- React ErrorBoundary 崩溃保护

**性能优化**
- 数据库索引 (5 个)
- 生词本懒加载
- API 请求 60 秒超时
- 版本化数据库迁移

**安全修复**
- API 密钥 / WebDAV 密码加密存储
- AES-GCM 随机 Nonce

**Bug 修复**
- OCR 高 DPI 坐标计算
- 剪贴板竞态条件
- WebDAV 网络错误数据保护
- 软删除单词重复添加
- 移除失效 Edge TTS 选项
</details>

---

## 🛡️ 安全与权限说明

由于本项目尚未购买 Windows 数字签名证书（Code Signing Certificate），安装时可能会遇到 **Microsoft Defender SmartScreen** 警告。

### 如何正常安装？
1. 在弹出的"Windows 已保护你的电脑"窗口中，点击 **"更多信息" (More info)**
2. 点击右下角的 **"仍要运行" (Run anyway)** 按钮即可安装

> **💡 为什么会有这个提示？** 这是 Windows 对所有"未知发布者"软件的常规保护机制。本项目完全开源，可在 GitHub 查阅所有[源代码](https://github.com/Longyuyeee/long_TranslateSoftware)，确保安全无毒。

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| **桌面框架** | Tauri 2.0 (Rust) |
| **前端** | React 19 + TypeScript + Vite 7 |
| **样式** | Tailwind CSS v4 + Framer Motion |
| **数据库** | SQLite (rusqlite, bundled) |
| **加密** | AES-256-GCM + SHA-256 |
| **AI 接口** | OpenAI 兼容 API (SSE 流式) |
| **OCR** | Windows Media Ocr (原生) |
| **TTS** | Youdao API + OpenAI TTS + WebSocket |
| **同步** | WebDAV 协议 |

### 环境要求
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 10/11 已预装)
- [WiX Toolset v3.14](https://wixtoolset.org/) (MSI 构建，可选)

### 快速开始
```bash
# 1. 克隆项目
git clone https://github.com/Longyuyeee/long_TranslateSoftware.git

# 2. 安装依赖
npm install

# 3. 运行开发模式
npm run tauri dev

# 4. 构建生产安装包
npm run tauri build
```

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---

<p align="center">
  <i>Developed with ❤️ by <a href="https://github.com/Longyuyeee">longyuye</a></i>
</p>
