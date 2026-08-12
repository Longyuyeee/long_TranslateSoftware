# Native Messaging v1 协议与威胁模型

状态：协议、单 EXE 最小 Native Host、Windows 注册器、固定开发 ID 的最小 MV3 扩展与安装器集成；尚未完成真实浏览器烟雾、商店 ID、桌面私有 IPC 或翻译扩展

版本：`1`

Schema：`protocol/native-messaging-v1.schema.json`

## 1. 目标与边界

该协议只允许未来的 Chrome / Edge 扩展请求桌面端执行已经存在的能力：

- 翻译纯文本或 Markdown；
- 把确认后的词条加入生词本；
- 取消仍在执行的请求；
- 检查桌面端连接状态；
- 发起需要用户在桌面端确认的配对。

明确不属于协议能力：

- 读取、写入或返回 API Key、WebDAV 密码和 Updater 私钥；
- 返回数据库路径、数据库文件、完整翻译历史或整个生词本；
- 修改模型、同步、更新、自启动、快捷键或安全设置；
- 透传任意 Tauri command、URL、文件路径、Shell 命令或 SQL；
- 让网页或 content script 直接连接 Native Host。

## 2. 浏览器传输约束

Native Host 使用 stdin/stdout。每条消息为：

1. 本机字节序的无符号 32 位消息长度；
2. 对应长度的 UTF-8 JSON。

Windows Host 必须把 stdin/stdout 设置为二进制模式，日志只能写入 stderr。Host 发往 Chrome / Edge 的消息不得超过 1 MiB。虽然 Chrome 允许扩展向 Host 发送更大的消息，本项目双向统一限制为 1 MiB，以便在解析 JSON 前限制内存。

Native Host manifest：

- Host 名称固定使用符合浏览器规则的小写域名式名称；
- `type` 必须是 `stdio`；
- `allowed_origins` 必须逐个写入 Chrome Web Store、Edge Add-ons 和受控开发版本的真实扩展 ID；ID 必须是 32 位小写 `a`–`p`；
- 不接受 `*` 或网页 Origin；
- Windows 安装器分别注册 Chrome 和 Edge 的当前用户注册表项。

为控制安装体积和启动链路，浏览器调用现有桌面 EXE 时由参数分流直接进入 Native Host 模式，不再发布一份重复 sidecar。注册器先完整校验 manifest，再以临时文件和备份替换写入；Chrome 与 Edge 的 HKCU 注册任一步失败都会回滚，卸载只删除仍指向本 manifest 的自有项。

参考：

- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Microsoft Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/developer-guide/native-messaging)

## 3. 信任分层

```text
网页（不可信）
  ↓ 仅选择文本和最小上下文
content script（不可信输入适配）
  ↓ runtime.sendMessage
扩展 service worker（权限与来源检查）
  ↓ runtime.connectNative
Native Host（来源白名单、帧限制、schema、配对）
  ↓ 本机私有 IPC（后续阶段定义）
Long翻译桌面进程（密钥、模型、数据库）
```

浏览器传给 Native Host 的第一个命令行参数是调用扩展 Origin。Host 必须使用该参数做精确白名单匹配，不能相信 JSON 内自报的扩展 ID、名称或 Origin。配对授权绑定经过验证的 Origin，不绑定网页域名。

content script 无权调用 `connectNative`。service worker 必须检查消息发送者、标签页和帧，只转发协议允许的字段；网页文本始终被当作不可信数据。

## 4. 会话状态机

```text
connected
  → hello（首条消息，协商 min/max 版本与能力）
  → unpaired | pending | approved

unpaired
  → 仅允许 ping、hello、pair

pending
  → 桌面端显示真实扩展 Origin 和申请能力
  → pairing_changed: approved | denied

approved
  → translate、add_word、cancel、ping
  → 端口断开时取消未完成请求并清理会话状态
```

`hello` 响应返回选择后的协议版本、桌面版本、随机 `session_id`、原样返回的 `client_nonce`、配对状态、服务端能力和限制。`session_id` 仅用于诊断与同一端口关联，不作为长期认证令牌，也不得写入网页存储。

长期配对记录只保存：

- 精确扩展 Origin；
- 用户批准的能力；
- 首次批准和最后使用时间；
- 可撤销的本机配对 ID。

不保存网页内容、翻译原文或密钥。

## 5. v1 请求

每个请求包含：

- `protocol_version: 1`
- `request_id`：1～64 字节，仅允许字母、数字、`_ . : -`
- `action`
- 除 `ping` 外的类型化 `payload`

动作：

| action | 是否需要配对 | 限制 |
| --- | --- | --- |
| `hello` | 否 | 必须为首条消息；协商范围必须包含 v1 |
| `pair` | 否 | 只发起桌面确认，不可自行批准 |
| `ping` | 否 | 不访问模型和数据库 |
| `translate` | 是 | 文本最多 32 KiB；术语最多 100 条；只允许纯文本/Markdown |
| `add_word` | 是 | 单条写入；桌面端仍负责去重和数据库事务 |
| `cancel` | 是 | 只能取消同一会话中属于该 Origin 的请求 |

单个会话最多同时执行 4 个请求。达到上限返回 `busy`，不无限排队。翻译默认超时 60 秒，Host/桌面 IPC 超时返回 `timeout`；断开连接时取消该会话尚未完成的任务。

## 6. 响应、事件与错误

响应必须复用原 `request_id`：

- 成功：`status: "ok"` 与类型化 `payload`
- 失败：`status: "error"` 与 `code/message/retryable`

流式翻译使用 `translation_progress` 事件；配对状态变化使用 `pairing_changed`。事件仍带原请求 ID，不允许无来源广播用户内容。

稳定错误码：

- `invalid_message`
- `unsupported_version`
- `unauthorized_origin`
- `pairing_required`
- `permission_denied`
- `request_too_large`
- `invalid_request`
- `busy`
- `desktop_unavailable`
- `timeout`
- `cancelled`
- `provider_error`
- `internal_error`

`message` 面向诊断，但不得包含密钥、Authorization Header、供应商原始响应、文件路径、SQL、原文或译文。恢复逻辑只能依赖 `code` 和 `retryable`，不能匹配中英文错误文本。

## 7. 版本兼容

- v1 的字段语义和错误码一经发布保持兼容；
- 新增可选字段或能力不提升主版本；
- 删除字段、修改语义或改变安全模型必须发布 v2；
- Host 至少兼容当前协议和前一协议版本；
- `hello` 无交集时返回 `unsupported_version`，不尝试猜测；
- 未识别字段、动作和错误结构默认拒绝。

## 8. 威胁与缓解

| 威胁 | 缓解 |
| --- | --- |
| 恶意网页伪造桌面请求 | content script 不能直接连接 Host；service worker 只转发白名单动作 |
| 其他扩展连接 Host | manifest `allowed_origins` + Host 对浏览器 argv Origin 二次精确校验 |
| 扩展被重打包后沿用权限 | 扩展 ID 变化导致 Origin 变化，必须重新加入 manifest 并重新配对 |
| 大消息耗尽内存 | 读取 JSON 前执行 1 MiB 帧限制；文本、上下文、术语另有限制 |
| 重放或串线响应 | 每请求唯一 ID、每连接随机 session、hello nonce 回显、响应 ID 关联 |
| 网页读取密钥/数据库 | 协议没有相关动作或响应字段；桌面端只返回最小结果 |
| 任意命令/路径注入 | 无通用 command、shell、URL、文件或 SQL 字段 |
| 并发滥用供应商额度 | 每会话最多 4 个请求、超时、取消、桌面端现有限流继续生效 |
| stdout 日志破坏帧 | Windows 二进制 I/O；stdout 只写协议帧，日志写 stderr |
| 错误泄漏用户内容 | 稳定错误码与脱敏消息，禁止透传供应商正文 |

## 9. 后续实现顺序

1. 已实现只负责二进制帧、1 MiB 预解析限制、Origin 校验和 `hello` / `ping` 的单 EXE 最小 Native Host，并以真实子进程测试固定 stdin/stdout 契约。
2. 已实现 Host manifest、Chrome/Edge 当前用户注册、重复安装/升级、所有权保护和可逆卸载；调试构建在没有 manifest 时仍可显式注入 `LONG_TRANSLATE_NATIVE_ALLOWED_ORIGINS`，release 构建拒绝该降级路径。
3. 已固定受控开发扩展 ID 并把注册命令接入 NSIS/WiX 安装/卸载；下一步完成 Chrome/Edge `hello` / `ping`、升级与卸载的真实烟雾。
4. 已建立桌面侧 Windows 随机命名管道、随机令牌、64 KiB 帧限制和受认证在线探针骨架；下一步接入 Host 转发，并处理桌面未运行、端点过期与配对状态。
5. 在桌面端实现配对确认、授权撤销和最小能力分发。
6. 创建 Manifest V3 service worker，先完成 hello/ping/pair，再接翻译。
7. 最后实现网页划词 UI 和收藏入口。

任何阶段都不得把桌面密钥复制到扩展存储。
