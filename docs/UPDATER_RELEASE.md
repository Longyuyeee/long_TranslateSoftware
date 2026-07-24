# Updater 发布指南

Long翻译使用 Tauri Updater 和 minisign 对更新包进行强制签名校验。应用只安装由当前私钥签发、且与内置公钥匹配的更新包。

## 当前配置

- 应用内公钥位于 `src-tauri/tauri.conf.json`，公钥可以提交。
- 本地私钥目录为项目根目录下的 `.updater-keys/`，已由 `.gitignore` 整目录忽略。
- GitHub Actions 使用仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，无需把私钥提交到 Git。
- 发布工作流位于 `.github/workflows/release.yml`，推送 `v*` 标签时自动运行测试、构建、签名并创建 Release。
- 发布正文自动读取 `docs/releases/v<版本号>.md`；缺少对应文档时工作流会停止，避免发布错误或过期的说明。
- 更新地址固定为 GitHub 最新 Release 的 `latest.json`。

## 私钥保管

`.updater-keys/` 当前包含私钥、公钥副本和密码文件。不要提交、截图、发送或粘贴其中的私钥与密码。

仅放在当前项目目录并不能替代备份：如果电脑或硬盘损坏，旧版本将无法验证使用新密钥签名的更新。请把整个 `.updater-keys/` 目录额外复制到至少一个受密码保护的离线介质或密码管理器附件中。备份后可用文件哈希比对完整性，但不要把私钥哈希当作密钥公开传播。

如果私钥遗失，只能让用户手动安装一个内置新公钥的过渡版本；无法再通过旧版本的自动更新通道完成密钥轮换。如果私钥泄露，应立即停止自动发布、轮换密钥，并发布安全公告。

## 首次桥接规则

v0.4.0 及更早版本没有内置本次生成的有效公钥，因此它们不能直接使用新的安全更新通道。v0.4.1 是桥接版本：现有用户需要手动下载安装一次 v0.4.1；从 v0.4.1 升级到后续版本时，便可在应用内完成检测、下载、签名校验、静默安装和重启。

## 正常发版

1. 同步修改 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 中的版本号。
2. 新建 `docs/releases/v<版本号>.md`，写清用户可感知的变化、兼容性与安全说明。
3. 执行 `npm test`、`npm audit --audit-level=high`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml` 和严格 Clippy。
4. 提交并推送代码，确认持续集成工作流成功。
5. 创建与配置版本完全一致的标签，例如 `git tag v0.4.5`，然后推送该标签。
6. 在 GitHub Actions 中确认发布任务成功。
7. 在 Release 中确认正文来自对应版本文档，并且至少存在 NSIS 安装包、对应 `.sig` 文件以及 `latest.json`。
8. 使用上一正式版本点击“检查更新”，完成一次真实升级验收。

不要手工编辑 `latest.json`，也不要单独替换 Release 中的安装包；安装包、签名和更新清单必须来自同一次构建。

## 本地签名构建

本地验证时，把私钥文件内容和密码分别传入环境变量 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，再执行 `npm run tauri build`。不要把真实值写进脚本、终端历史、日志或 `.env` 文件。

构建完成后，应在 `src-tauri/target/release/bundle/` 下看到安装包及相应的 `.sig` 文件。GitHub Release 使用的 `latest.json` 由发布工作流生成。
