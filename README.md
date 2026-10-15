# pi-pocket-weixin

微信 ↔ **Pi Pocket / Pi in Pocket（PiP）** 的独立 TypeScript 桥接服务。

默认连接你现有的 PiP 管家；用命令切换到已有 Pocket 会话。复用同一个上下文、模型、工具和任务，不另起 Hermes/OpenClaw agent，也不改 Pocket 的源码或数据库。

> **0.1 原型：** 已通过单元测试、协议模拟测试和隔离 Pocket 的真实 API 集成测试。**尚未验证真实微信扫码、账号可用性或收发。** iLink 的开放范围和服务端限制可能变化；这不是腾讯或 Pi Pocket 的官方插件。

## 能做什么

- 微信 iLink 扫码登录、HTTP 长轮询；无需公网回调或浏览器自动化。
- 只接受扫码返回用户身份的私聊，且 Pocket 凭证必须属于 owner。
- PiP 默认入口；固定会话 ID 切换、新建会话。
- 同步订阅会话的新最终回复；切换后的旧任务仍带会话标签回报。
- 提醒在网页审批，不通过微信批准危险操作。
- SQLite 持久化收件、路由、回复游标和待发送消息；重启后恢复。
- 不传输模型思考和工具日志；不使用“相同正文”去重，重复发送“继续”仍有效。

首版**不支持群聊、图片、文件、语音、消息编辑、打字状态、多用户或多机器人实例**。iLink 登录获得的是独立机器人身份，不是对个人微信全部聊天的访问权。

## 要求

- Node.js **24+**，npm。
- 一个可访问的 Pi Pocket 服务，启用 PiP，并在网页选好默认模型。
- 自己的 Pocket owner 登录 token 和可使用 iLink 机器人的微信账号。
- 测试基线：Pi Pocket 0.13.2，commit `de612d5622cdc66b6b8b4900c650c6f2efdf4c63`；HTTP API 属于 Pocket 的内部接口，不保证其他版本兼容。

## 快速开始

```sh
git clone https://github.com/wangbinyq/pi-pocket-weixin.git
cd pi-pocket-weixin
npm ci
cp .env.example .env
chmod 600 .env
```

编辑本地 `.env`：

```dotenv
POCKET_URL=http://127.0.0.1:8080
POCKET_TOKEN=你自己的Pocket-owner-token
# 手机可打开的地址，只用于会话链接，不携带认证信息：
# POCKET_PUBLIC_URL=https://your-pocket.example.com
```

从你自己的 Pocket owner 登录链接取得 token；**不要把整个登录链接填进 POCKET_URL**。不要把 token 发进微信、提交到 Git 或放进截图。示例端口只是占位，以你的服务地址为准。

HTTP 只允许 loopback（localhost、127.0.0.1、127.0.0.2、::1）；远程 Pocket 必须使用 HTTPS。拒绝重定向，防止凭证发送到其他地址。

```sh
npm run login    # 用本人微信扫码并确认；二维码也不要分享
npm run doctor   # 检查 Pocket owner 认证及本地配置；不验证微信登录有效性
npm start
```

在微信中给机器人发 `/help`，然后直接说话。首次启动会创建或打开已有 PiP，但不会自动给模型发送消息。扫码若没有返回用户标识，程序拒绝启动开放式机器人，不允许“第一位发消息的人自动成为 owner”。

按 Ctrl+C 停止。切勿让 Hermes、OpenClaw 或另一个服务同时轮询同一个 iLink 机器人。桥接会锁定自己的数据目录，并在同一系统用户下按机器人账号加锁；无法阻止其他软件或另一台机器抢用账号。

## 会话切换

| 命令          | 行为                                              |
| ------------- | ------------------------------------------------- |
| `/pip`        | 回到现有 PiP 管家                                 |
| `/sessions`   | 列出最近 30 个会话，显示 Pocket 固定 ID           |
| `/use 12`     | 连接会话 #12，不是列表第 12 项                    |
| `/new 标题`   | 新建会话并连接，目录和模型使用 Pocket 的默认值    |
| `/status`     | 当前目标、运行状态和发送队列                      |
| `/watching`   | 查看回报订阅                                      |
| `/unwatch 12` | 取消 #12 的订阅及尚未发出的该会话回复，不停止任务 |
| `/retry`      | 重试因错误暂停的微信发送，可能造成重复送达        |
| `/help`       | 查看帮助                                          |

- **连接和订阅：** 首次连接 PiP 或执行 /use，会从当前历史末尾开始订阅，不回放旧历史。此后该会话的**所有新最终回复**都会进入微信，包括网页上发起的对话、其他参与者触发的回复和定时任务。不是按某一条微信请求精确过滤。
- 切换只改变之后的消息目标，不搬历史，不取消旧任务；旧订阅保持到 /unwatch。最多订阅 20 个会话。
- 向已取消订阅的当前会话再次发消息，会从最新历史末尾重新订阅；取消期间的回复不回放。
- 网页当前选中的会话与微信绑定独立。每条文字在提交前固定目标，重试不会误投到后来切换的会话。
- 普通文字走 Pocket 的正常提交链路，忙时使用 follow-up 排队，不自动打断正在执行的工具。
- 未知 / 命令不转交给模型。模型设置、审批、计划批准、停止任务和上传文件在 Pocket 网页处理。
- 将结果发往微信意味着相应内容离开 Pocket、进入微信服务。只在你愿意同步该会话内容时订阅。

## 配置与数据

可选环境变量：

| 变量                | 默认 / 含义                                         |
| ------------------- | --------------------------------------------------- |
| `WEIXIN_DATA_DIR`   | `~/.local/share/pi-pocket-weixin`；独立私有数据目录 |
| `POCKET_PUBLIC_URL` | 同 POCKET_URL，仅用于手机上的会话链接               |
| `POCKET_NEW_CWD`    | /new 使用的工作目录；不填则由 Pocket 决定           |

程序从当前工作目录读取 .env。不要把数据目录放在仓库里。目录权限 0700，凭证和 SQLite 主文件权限 0600；首版主要面向 Linux/macOS，未验证 Windows 的权限与文件系统行为。

数据目录内：

- `credentials.json`：机器人 token、API 地址和绑定的微信身份。
- `bridge.sqlite`（及 WAL/SHM）：待处理消息、context_token、轮询游标、目标和订阅、待发回复、去重键。

**这三个概念不同：** bot token 是接口凭证；context_token 是某个微信联系人的回复令牌；Pocket conversationId 才是 AI 会话。

首次启动将数据绑定到 Pocket URL + owner ID + 机器人账号 + 微信身份。改变这些身份会拒绝使用旧状态；新账号或其他 Pocket 实例请用新数据目录。仅轮换同一身份的凭证不需要清空状态。更换同一个 Pocket 服务的 URL 也需要单独规划迁移，当前没有迁移命令。

已完成的收件正文和已发送的回复正文会清空，但去重键仍保留。待处理内容属于敏感信息；日志不打印聊天正文、token、模型输出或原始 API 错误体。不要在公开 issue 上传 .env、数据目录或二维码。

## 恢复语义与限制

1. **接收：** 合法消息、最新回复令牌、iLink 游标在同一 SQLite 事务落盘；进程重启后先处理已保存收件。仅处理有稳定 message_id 且身份匹配的纯文字私聊。
2. **Pocket 提交：** 请求 ID 由机器人、发送者和微信消息 ID 派生，固定为 64 位十六进制。响应丢失后重用它，利用 Pocket 的提交去重，避免重复执行同一条输入。
3. **新建会话：** Pocket 的新建接口没有幂等键，因此在发送前记录意图。响应丢失或进程在记录结果前中断时，**不会自动再创建**，而是提示 /sessions 检查；有可能留下一个已创建但尚未连接的空会话。
4. **回复：** 历史分页补齐，回复入 outbox 与读取游标在同一事务提交。使用稳定 client_id 重试，每个分片约 1800 Unicode 码点，发送至少相隔 1.5 秒。
5. **不是端到端 exactly-once：** 微信接受消息后若 HTTP 响应丢失，或进程在记录已发之前退出，重试可能重复。iLink 服务端的 client_id 去重行为尚未实测，不能保证绝不重复。
6. **主动通知有条件：** context_token 失效时尝试一次移除旧令牌发送；仍失败会暂停队列，等待你再次发消息或重新登录。不能保证长期无人交互后仍可主动推送。
7. **发送顺序：** outbox 按顺序处理，遇到暂时错误退避；连续失败最多尝试 8 次，然后暂停，避免无限刷屏。队首暂停会阻塞后面的消息。用 /retry，或停止服务后运行 `node src/cli.ts retry` 恢复。网络不确定的重试可能重复。
8. **本地存储：** SQLite FULL 同步与原子凭证替换防止常见进程中断问题，但不能承诺损坏磁盘或网络盘上的可靠性。使用本地文件系统。去重记录没有自动过期，长期运行要留意磁盘空间。

## 开发与测试

```sh
npm run check
npm test
npm run format:check

# 可选：对已有 Pocket 源码运行隔离集成测试
# Pocket 源码需要已安装自身依赖；测试启动 test/serve.ts，使用临时数据和 faux 模型。
POCKET_SOURCE=/path/to/pi-pocket npm test
```

普通测试不连接真实微信、Pocket 或模型提供商。集成测试只启动临时 Pocket，退出时关闭并清理其数据，不接触运行中的 Pocket。

代码结构：

- `src/ilink.ts`：扫码与 iLink 文本协议、私聊身份过滤。
- `src/pocket.ts`：Pocket 鉴权 API、历史分页和最终回复筛选。
- `src/store.ts`：SQLite 收件箱、发件箱、路由和订阅。
- `src/bridge.ts`：命令、输入路由、回报和重试。
- `src/cli.ts`：登录、检查、进程生命周期与锁。

实现思路参考 Hermes Agent 的 iLink 适配器（MIT），不依赖或加载其 Python 运行时。协议来源、已知限制和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。安全边界见 [SECURITY.md](SECURITY.md)。
