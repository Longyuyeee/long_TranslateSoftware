# 胧翻译 (Long Translate)

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Logo">
</p>

<p align="center">
  <a href="https://github.com/Longyuyeee/long_TranslateSoftware/releases">
    <img src="https://img.shields.io/github/v/release/Longyuyeee/long_TranslateSoftware?color=blue&label=Latest%20Release" alt="Release">
  </a>
  <img src="https://img.shields.io/badge/Platform-Windows-blue" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

---

**胧翻译** 是一款专为 Windows 用户打造的极速 AI 翻译与 OCR 工具。它结合了现代 AI 模型的理解能力与系统原生的 OCR 性能，旨在为您提供最顺滑的跨屏、跨软件阅读体验。

## 📥 下载安装

您可以直接前往 **[Releases 页面](https://github.com/Longyuyeee/long_TranslateSoftware/releases)** 下载最新的安装包：
- **`.msi` 文件**：推荐下载，双击即可完成安装。
- **`.exe` 文件**：解压即可使用的单文件版（如果提供）。

---

## ✨ 核心功能 (Core Features)

### 1. 🤖 AI 智能翻译
- **接口兼容**：完美支持 OpenAI、DeepSeek 以及任何符合 OpenAI 格式的 API 接口。
- **流式响应**：翻译结果实时打字机式呈现，拒绝等待。
- **上下文理解**：基于 LLM 的精准翻译，比传统翻译软件更懂语义。

### 2. 📸 系统级 OCR 识字
- **零延迟**：调用 Windows 10/11 原生 `Windows.Media.Ocr` 引擎。
- **隐私保护**：所有图像识别均在本地完成，不会上传图片到任何云端服务器。
- **区域划选**：支持全屏遮罩划选，精准抓取任何角落的文字。

### 3. 🔊 智能语音 (TTS)
- **多引擎支持**：内置有道本地引擎及 OpenAI 高质量在线语音。
- **智能缓存**：自动缓存已听过的音频，不仅省流量，二次播放瞬间即达。

### 4. 📚 生词本与 WebDAV 同步
- **一键收藏**：翻译结果支持一键加入生词本。
- **云端同步**：支持 WebDAV 协议，可将生词本同步至坚果云、自建 NAS 等，实现多端数据互通。

---

## ⌨️ 快捷键操作 (Shortcuts)

为了提升效率，本软件提供了全局快捷键（即使软件最小化到托盘也有效）：

| 快捷键 | 对应操作 | 功能描述 |
| :--- | :--- | :--- |
| **`Alt + Q`** | **快速翻译** | 自动触发 `Ctrl+C` 抓取选中的文本，并直接弹出悬浮窗显示翻译结果。 |
| **`Alt + W`** | **截图 OCR** | 唤起屏幕截图遮罩层，划选区域后自动识别文字并翻译。 |
| **`Esc`** | **退出/隐藏** | 在 OCR 界面或悬浮窗打开时，按下即可快速退出当前状态。 |

---

## ⚙️ 配置指南

1. **API 配置**：在主界面的“设置”中填入您的 API Key（如 DeepSeek 或 OpenAI）。
2. **Base URL**：如果您使用中转接口，请修改 Base URL。
3. **快捷键说明**：目前默认为 `Alt + Q/W`，未来版本将支持自定义修改。

## 🛠️ 技术栈

- **Core**: [Tauri 2.0](https://tauri.app/) (Rust)
- **UI**: React 19 + TypeScript + Tailwind CSS
- **Animation**: Framer Motion
- **OCR**: Windows Media OCR API
- **DB**: SQLite

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 协议。

---
*Developed with ❤️ by [Longyuyeee](https://github.com/Longyuyeee)*
