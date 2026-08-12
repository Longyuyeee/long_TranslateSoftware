# Chrome / Edge Native Messaging 烟雾清单

状态：待在签名发布候选安装包上执行

开发扩展 ID：`imaogjlfhfohdnngppnfhapdfkaldmkn`

该清单验收安装器、扩展、Host 的 `hello` / `ping` 和桌面配对闭环；不代表翻译或网页划词已经可用。

## 1. 构建前自动门禁

- `npm test`
- `npm run build`
- `npm run audit:bundle`
- `npm run audit:extension`
- `npm audit --audit-level=high`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

扩展审计必须确认：Manifest V3、只含 `nativeMessaging` 权限、没有 `host_permissions` / `content_scripts`、开发 ID 与 NSIS/WiX Origin 一致、生产包不超过 64 KiB。

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
- 检查浏览器页面权限：扩展不得请求任何网站访问权，也不得注入 content script。

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
