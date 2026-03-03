# 胧翻译 (Long Translate) - AI 智能助手

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Logo">
</p>

<p align="center">
  <strong>一款基于 AI 的 Windows 系统级翻译与 OCR 工具</strong>
</p>

---

## ✨ 核心特性

- 🚀 **AI 流式翻译**：支持 OpenAI / DeepSeek 兼容接口，提供毫秒级流式响应。
- 🔍 **系统级 OCR**：调用 Windows 原生 Media OCR 引擎，本地识别，隐私无忧。
- ⌨️ **动态快捷键**：
  - 支持 `Alt + Q` (选中文本翻译)、`Alt + W` (截图识别)。
  - **新特性**：支持在设置中实时录制并修改组合键，具备冲突检测与静默录制机制。
- 💾 **加密备份还原**：
  - **新特性**：支持导出 `.TLong` 加密备份文件，一键迁移所有设置与生词本。
- 📚 **智能生词本**：AI 深度分析单词词源、例句、近义词，支持 WebDAV 云端同步。
- 🎙️ **智能语音 (TTS)**：支持系统本地语音及 OpenAI 在线高音质音色。
- 🎨 **极简视觉**：采用 Apple Style 设计语言，支持深色模式与全局 UI 缩放。

## 📥 下载与安装

> **⚠️ 推荐下载：** 建议优先下载并使用 **`.exe` (NSIS)** 安装包，它具有更好的兼容性和权限处理能力。

- **[推荐] [EXE 安装包 (v0.1.0)](releases/LongTranslate_0.1.0_x64_Setup.exe)**
- **[MSI 安装程序 (v0.1.0)](releases/LongTranslate_0.1.0_x64_zh-CN.msi)**

## 🛠️ 开发与构建

项目采用 **Tauri 2.0 + React 19 + Rust** 构建。

### 环境要求
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 10/11 已内置)

### 构建指令
```bash
# 安装依赖
npm install

# 开发模式运行
npm run tauri dev

# 生产环境打包
npm run tauri build
```

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---
*Developed with ❤️ by [Longyuyeee](https://github.com/Longyuyeee)*
