# Long翻译 · 智能助手 开发与打包指南

本手册包含如何更换软件图标、配置系统自启、以及在 Windows 平台上进行正式版本打包的详细步骤。

---

## 1. 更换软件图标 (Icon Configuration)

Tauri 提供了一键生成全平台图标的工具。

### 准备工作
1. 准备一张 **1024x1024** 像素、**PNG 格式** 的透明背景图片。
2. 将该图片重命名为 `app-icon.png` 并放置在项目的**根目录**（与 `package.json` 同级）。

### 执行命令
在终端（Terminal）中运行以下命令：
```powershell
npm run tauri icon ./app-icon.png
```

### 自动生效范围
该命令会自动生成并覆盖以下文件：
- `src-tauri/icons/*.png`: 用于各种分辨率显示。
- `src-tauri/icons/icon.ico`: 用于 Windows 任务栏和桌面快捷方式。
- `src-tauri/icons/icon.icns`: 用于 macOS 系统。

---

## 2. 环境准备 (Prerequisites)

在第一次打包前，请确保您的电脑已安装：
1. **Rust 编译环境**: [rustup.rs](https://rustup.rs/) (需包含 C++ Build Tools)。
2. **WiX Toolset**: 打包 MSI 必需。Tauri 在打包时若检测不到会自动下载，若下载失败请手动安装 [WiX v3.14](https://wixtoolset.org/releases/)。
3. **WebView2**: Windows 10/11 通常内置。

---

## 3. 正式打包步骤 (Production Build)

### 第一步：清理缓存（推荐）
如果您修改了中文字体、品牌名称或遇到了编译报错，建议先清理旧缓存：
```powershell
cd src-tauri
cargo clean
cd ..
```

### 第二步：执行打包
在根目录下运行：
```powershell
npm run tauri build
```

### 第三步：获取安装包
编译完成后，安装程序将位于：
`src-tauri	argetelease\bundle\msi\Long翻译_0.1.0_x64_zh-CN.msi`

---

## 4. 常见问题处理 (Troubleshooting)

### Q1: 打包时 `light.exe` 报错 (Linker Error)
**原因**: 软件名称包含中文（Long翻译），而 WiX 默认语言为 `en-US`。
**解决**: 我们已在 `tauri.conf.json` 中配置了 `"language": ["zh-CN"]`。如果依然报错，请确保运行了 `cargo clean` 后重试。

### Q2: WebDAV 同步报 404 错误
**原因**: 坚果云等网盘不允许在根目录直接创建文件。
**解决**: 
1. 登录网盘，手动创建一个文件夹（如 `Words`）。
2. 在软件设置中将 URL 填为：`https://dav.jianguoyun.com/dav/Words/`。

### Q3: 任务栏的名字还是显示 "ai-trans-assistant"
**原因**: Windows 图标缓存或未彻底重新编译。
**解决**: 修改 `tauri.conf.json` 中的 `productName`（已修改），并执行 `cargo clean` 后重新打包。

---

## 5. 项目配置说明
- **Identifier**: `com.ai.trans.assistant` (请勿轻易修改，否则会导致用户单词本数据路径丢失)。
- **ProductName**: `Long翻译`
- **Window Title**: `Long翻译 · 智能助手`
