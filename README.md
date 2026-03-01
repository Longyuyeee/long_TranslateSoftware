# 龙语翻译助手 (Long Translate Assistant)

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Logo">
</p>

一个基于 **Tauri 2.0 + React + Rust** 开发的现代桌面翻译工具。利用 AI 模型实现精准翻译，结合 Windows 原生 OCR 引擎提供流畅的截图识字体验。

---

## ✨ 核心特性 (Features)

- 🤖 **AI 驱动翻译**：支持 DeepSeek、OpenAI 等兼容 API，流式渲染翻译结果，响应极速。
- 📸 **原生 OCR 识字**：调用 Windows 10/11 原生 OCR 引擎，无需上传图片至云端，隐私安全且速度极快。
- 🪟 **多窗口模式**：
  - **主界面**：完整的配置管理与翻译历史。
  - **悬浮窗**：简洁的翻译挂件，支持置顶，适合阅读时随手翻译。
  - **OCR 遮罩层**：自由划选屏幕区域进行即时识别与翻译。
- 🔊 **智能语音 (TTS)**：
  - 集成有道本地引擎及 OpenAI 高质量在线语音。
  - 具备音频本地缓存机制，节省流量并提升二次播放速度。
- ⌨️ **全局快捷键**：支持自定义快捷键唤起 OCR 或悬浮窗。
- 🎨 **现代 UI**：使用 Tailwind CSS 与 Framer Motion 打造，支持磨砂玻璃效果与流畅动画。

## 🛠️ 技术栈 (Tech Stack)

- **前端**: React 19, TypeScript, Vite, Tailwind CSS, Framer Motion
- **后端**: Rust, Tauri 2.0
- **数据库**: SQLite (Rusqlite) 用于存储配置与历史
- **OCR**: Windows Media OCR (via `windows-rs`)

## 🚀 快速开始 (Getting Started)

### 运行环境
- Windows 10/11
- [Rust](https://www.rust-lang.org/tools/install) 环境
- [Node.js](https://nodejs.org/) (推荐 v18+)

### 开发与构建
1. **安装依赖**
   ```bash
   npm install
   ```
2. **启动开发模式**
   ```bash
   npm run tauri dev
   ```
3. **构建打包**
   ```bash
   npm run tauri build
   ```

## ⚙️ 配置说明 (Configuration)

首次启动后，请在设置界面配置以下内容以启用 AI 功能：
- **API Key**: 填入您的 DeepSeek 或 OpenAI Key。
- **Base URL**: 默认为 `https://api.openai.com/v1`。
- **Model Name**: 建议使用 `deepseek-chat` 或 `gpt-4o`。

## 📄 开源协议 (License)

本项目采用 MIT 协议开源。

---
*Developed with ❤️ by [Longyuyeee](https://github.com/Longyuyeee)*
