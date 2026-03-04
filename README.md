# 胧翻译 (Long Translate) - AI 智能助手

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
  <img src="https://img.shields.io/github/license/Longyuyeee/long_TranslateSoftware?style=flat-square" alt="License">
</p>

---

## 🌟 核心特性

- 🚀 **AI 流式翻译**
  - 支持 OpenAI / DeepSeek 兼容接口，毫秒级流式响应。
  - 自定义翻译角色与目标语言。
- 🔍 **系统级 OCR 识别**
  - 调用 Windows 原生 Media OCR 引擎，本地识别，隐私无忧。
  - 支持全屏截图、区域划选，一键提取并翻译。
- ⌨️ **动态快捷键体系**
  - 默认 `Alt + Q` (选中文本翻译)、`Alt + W` (截图识别)。
  - **新特性**：支持设置中实时录制组合键，自动处理冲突，静默捕获。
- 💾 **加密备份与迁移**
  - 导出 `.TLong` 加密备份文件，跨设备一键迁移所有配置与数据。
- 📚 **智能 AI 生词本**
  - AI 深度解析：词源分析、多场景例句、近义词对比。
  - 支持 **WebDAV** 云端同步，让学习数据永不丢失。
- 🎙️ **多引擎 TTS (语音合成)**
  - 支持 Youdao 本地引擎、Microsoft Edge Neural Voices (高保真) 及 OpenAI 在线引擎。
- 🎨 **极简 Apple Style 视觉**
  - 精心调教的毛玻璃背景，支持深色模式、全局 UI 缩放。

## 📥 下载与安装 (v0.2.2)

> **💡 提示：** 推荐优先使用 **`.exe` (NSIS)** 安装包，它具备更优秀的系统权限处理和更好的安装体验。

| 平台 | 文件类型 | 下载链接 |
| :--- | :--- | :--- |
| **Windows (x64)** | **[推荐] NSIS 安装程序** | **[立即下载 v0.2.2 .exe](releases/LongTranslate_0.2.2_x64_Setup.exe)** |
| **Windows (x64)** | **MSI 安装包** | **[立即下载 v0.2.2 .msi](releases/LongTranslate_0.2.2_x64_zh-CN.msi)** |

## 🛡️ 安全与权限说明

由于本项目尚未购买昂贵的 Windows 数字签名证书（Code Signing Certificate），在安装过程中，您可能会遇到 **Microsoft Defender SmartScreen** 的警告提示。

### 如何正常安装？
1. 在弹出的“Windows 已保护你的电脑”窗口中，点击 **“更多信息” (More info)**。
2. 点击右下角出现的 **“仍要运行” (Run anyway)** 按钮即可开始安装。

> **💡 为什么会有这个提示？**
> 这是 Windows 对所有“未知发布者”软件的常规保护机制。由于本项目是开源的，您可以随时在 GitHub 查阅所有[源代码](https://github.com/Longyuyeee/long_TranslateSoftware)，确保其安全无毒。

---

## 🛠️ 技术栈与构建

本项目基于 **Tauri 2.0** 架构开发。

### 环境要求
- [Rust](https://www.rust-lang.org/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 10/11 已预装)

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

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---
<p align="center">
  <i>Developed with ❤️ by <a href="https://github.com/Longyuyeee">longyuye</a></i>
</p>
