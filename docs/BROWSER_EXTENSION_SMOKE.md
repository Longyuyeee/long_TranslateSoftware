# Chrome / Edge Native Messaging 烟雾清单

状态：待在签名发布候选安装包上执行

开发扩展 ID：`imaogjlfhfohdnngppnfhapdfkaldmkn`

该清单验收安装器、扩展、Host、桌面配对以及用户主动启用的划词翻译闭环；代码与自动测试通过不代表真实浏览器验收完成。

## 1. 构建前自动门禁

- `npm test`
- `npm run build`
- `npm run audit:bundle`
- `npm run audit:extension`
- `npm audit --audit-level=high`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

在 Windows 审计机完成 release 构建并启动该构建后，先执行：

```powershell
npm run smoke:browser:preflight -- -RegisterNativeHost -RequireDesktop
```

预检会核对 Chrome / Edge 安装、Manifest V3 最小权限、固定开发 ID、64 KiB 包体门槛、双浏览器 HKCU 注册、Host manifest 精确路径与 Origin，以及不泄露令牌的桌面 IPC 元数据。它不会打开网页、批准授权或执行翻译，因此结果为 `pass` 也不能替代后续真实交互步骤。

自动化还会启动真实编译出的桌面 EXE Native Host 子进程，以浏览器相同的 stdin/stdout 帧穿过受认证桌面命名管道，验证翻译、取消和生词本写入的 Origin 与 request ID 关联。该测试覆盖进程边界，但仍不替代 Chrome / Edge 的扩展加载与可视交互。

扩展审计必须确认：Manifest V3、权限严格为 `nativeMessaging`、`activeTab` 和 `scripting`、没有 `host_permissions` / `content_scripts`、开发 ID 与 NSIS/WiX Origin 一致、生产包不超过 64 KiB。

真实浏览器验收还要分别切换英文与简体中文界面、系统浅色与深色主题，确认 Manifest 名称、弹窗、划词浮层、无障碍标签和失败提示同步切换，且长英文按钮没有截断或破坏窄窗口布局。

## 2. 首次安装

1. 在没有旧开发安装的测试用户中安装签名 NSIS 候选。
2. 核对 Chrome 与 Edge 的 HKCU NativeMessagingHosts 项都指向安装目录内的 `com.long.translate.json`。
3. 核对 manifest 的 `path` 指向同目录的 `long-translate.exe`，`allowed_origins` 只包含受控扩展 Origin。
4. 分别在 `chrome://extensions` 与 `edge://extensions` 开启开发者模式，加载 `browser-extension/dist`。
5. 两个浏览器显示的扩展 ID 都必须为 `imaogjlfhfohdnngppnfhapdfkaldmkn`。
6. 打开扩展弹窗并点击“检查连接”；首次应显示桌面版本、`required` 配对状态和非负往返耗时。
7. 发起配对后，桌面主窗口应被唤醒并显示真实扩展 Origin、名称和能力列表；拒绝后不产生长期授权，重新申请后批准，下一次 `hello` 应返回 `approved`。
8. 在桌面高级设置撤销该扩展；下一次 `hello` 应重新返回 `required`，能力列表增加时也必须重新确认。
9. Host 进程结束后不得留下桌面窗口副本、托盘副本或未退出子进程。

## 3. 失败路径

- 暂时注销 Host 后检查：弹窗应在 5 秒内显示明确失败，不持续等待。
- 把开发扩展重新打包成不同 ID 后检查：浏览器或 Host 必须拒绝连接。
- Host manifest 无效、路径不存在或响应 request ID / nonce 不匹配时，扩展必须失败关闭且不继续发送 `ping`。
- 检查浏览器页面权限：扩展只允许 `nativeMessaging`、`activeTab` 和 `scripting`，不得声明 `host_permissions` 或常驻 `content_scripts`；未点击启用前页面不得出现扩展节点，刷新后注入必须消失。

## 4. 重复安装、升级与卸载

1. 重复安装同一候选后，Chrome/Edge 两项和 manifest 内容保持一致，不产生重复文件或第二份 Host 二进制。
2. 使用下一构建覆盖升级，两个浏览器再次通过 `hello` / `ping`；升级期间注册不得出现永久缺失。
3. 卸载后，只有仍指向本安装 manifest 的 Chrome/Edge 项被删除；被改为其他路径的项必须保留。
4. 安装目录内的 manifest、备份和临时 manifest 被清理，不遗留空目录。
5. 卸载后扩展检查应明确失败；重新安装后无需重新加载扩展即可恢复最小连接。

## 5. MSI 对齐

在独立测试用户上对 MSI 重复执行首次安装、覆盖升级和卸载。若 MSI 与 NSIS 的注册结果、回滚或所有权行为不同，不得发布。

完成时记录浏览器版本、安装包 SHA-256、桌面提交、扩展提交及每项结果；不要在记录中包含用户网页文本、文件路径中的用户名或任何密钥。

## 6. `translate` / `cancel` 候选验收

在开发者工具中从扩展自身上下文发送带唯一 `taskId` 的 `native-translate`，确认已批准时返回译文，未批准时返回 `pairing_required`，桌面未就绪时立即返回可重试错误。翻译进行中再发送同一 `taskId` 的 `native-cancel`，确认取消被接受、原请求以取消结束且桌面没有遗留任务。分别在 Chrome 与 Edge 执行，并验证撤销配对后旧授权不能继续翻译。

该项在真实浏览器完成前仍记为 **待验收**；自动化测试和构建成功不能替代此门槛。

## 7. 划词浮层候选验收

1. 在普通 HTTP(S) 页面打开扩展弹窗，点击“在当前页面启用划词翻译”；确认浏览器内部页和扩展商店页明确拒绝，而不是扩大权限。
2. 选中文字后只出现“译”按钮，尚未向桌面发送正文；点击后显示隔离样式浮层。英文默认译为中文，含汉字文本默认译为英文。
3. 验证成功译文、复制、取消、关闭、未配对、桌面未运行、超限选择和窄窗口定位；页面样式不得污染浮层，浮层样式也不得污染页面。
4. 刷新页面后浮层能力消失，重新点击启用才能恢复；检查 manifest 没有 `host_permissions` 或静态 `content_scripts`。

## 8. 生词本收藏候选验收

1. 使用只有 `translation` 能力的旧授权完成翻译，点击“收藏到生词本”；确认写入被拒绝并提示更新桌面授权，不能静默扩大权限。
2. 在扩展弹窗申请更新授权，桌面确认弹窗必须明确显示 `wordbook` 能力；批准后重新执行收藏。
3. 收藏入口只能在翻译成功后出现；成功后桌面生词本包含准确的选中文字和译文，重复收藏复用原词条，不产生重复词条。
4. 撤销配对后再次收藏必须失败；桌面未运行、超长字段或来源不匹配时也必须失败关闭，错误中不得包含网页原文、译文、数据库路径或密钥。
5. 默认请求不得包含选区之外的页面上下文；分别在 Chrome 和 Edge 验证，并确认页面脚本无法直接调用 Native Host。

该项在真实浏览器完成前仍记为 **待验收**；自动化测试只证明协议和编排边界，不替代真实交互门槛。
