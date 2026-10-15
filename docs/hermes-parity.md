# Hermes 行为与桥接边界

参考版本：NousResearch/hermes-agent `7bda2a3368024f7ae1c70cef16583e7c2c891674`。这是源码对照，不是完整 Hermes 兼容声明；桥接只使用 Pocket 现有的 agent 和会话。

## 已对齐的核心交互

- 一个本人微信私聊绑定一个当前 Pocket 会话。`/new` 新建并切换，`/resume <ID>` 恢复已有会话，`/pip` 是本桥接的管家入口。
- 普通模型回复只发送正文，不固定添加 `【#ID 名称】`。切换确认、列表、状态和审批定位信息不是普通模型回复。
- 收到旧会话结果不会重新绑定输入目标。桥接切换时停用旧同步并取消旧会话待发消息，不持续订阅所有访问过的会话。
- 被引用的文字按 `[引用: 标题 | 原文]` 加入模型上下文，不作为切换路由或执行桥接命令的依据。
- 快速连续普通文字默认 300ms 静默后合并；末段达到 1800 码点时至少等 1s。桥接将合并结果和去重记录持久化；命令、媒体、间隔和大小限制构成明确边界。
- iLink 轮询 `-14`，以及 `-2` + `prepare failed` / `unknown error` 都暂停 10 分钟；其他错误按 2s、2s、30s 循环退避。
- 回复使用最近的 context_token；失效时尝试一次不带旧令牌发送，不将会话失效误当限流。

`/reset [交接说明]` 是 Pocket 原生“新上下文”：保留会话 ID 和历史记录，仅从后续模型上下文排除旧对话，不等同于 Hermes 的新建/切换会话。忙时在下一处理边界生效，不自动停止任务；无法确认结果时不自动重试。

新增运行时交互：`/stop` 仅停止当前会话并撤回排队输入；`/model [provider/id] [思考级别]` 显式选择已配置模型；`/busy queue|steer|interrupt` 持久化忙时策略。默认仍为 queue，interrupt 是非原子的 stop + submit，不宣称等同 Hermes 原生中断。停止/切模型结果不确定时不自动重复。

新增 typing ticket 缓存和输入中提示，失败不影响任务；文本按段落和 fenced code 分片，超长代码块闭合后重开。图片、文件及其引用通过微信 CDN 下载解密、上传 Pocket 后随同文字提交，不允许只执行缺少附件的残缺任务。

## 保留的差异

| 项目         | Hermes 参考实现                                                           | 本桥接                                                                                                         |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 会话解析     | `/resume` 支持列表索引、ID/标题、压缩延续链，并有来源授权检查             | 使用 Pocket 固定数字 ID，不接受列表序号或标题；PiP 用 `/pip`                                                   |
| 回复来源     | 当前 agent 回答；后台、cron 有独立路由和归属机制                          | 轮询当前 Pocket 会话历史，可能转发网页/定时任务的新最终回复；不实现 Hermes 的通知归属系统                      |
| 切换后的任务 | Hermes 管理自己的 agent 执行和会话边界                                    | 不终止 Pocket 的独立网页/后台任务，旧结果仍可在网页查看；切回从当时历史末尾同步                                |
| 重启         | 恢复 Hermes 会话和 adapter 状态                                           | 保留当前会话水位、收件和发件，不因重启跳过当前会话的新回复；只清理旧多订阅状态                                 |
| `/new`       | Hermes 会话重置语义                                                       | 新建独立 Pocket 会话，可选标题，复用 Pocket 默认模型/目录；创建结果不确定时不自动重复                          |
| `/retry`     | 回退上一轮 transcript 并重发最后一条用户输入                              | 未提供安全的 transcript 回退，明确提示未支持；不假装重新回答                                                   |
| 发送恢复     | adapter/gateway 自己的重试机制                                            | `/retry-send` 仅重试持久化微信发送队列，不启动模型                                                             |
| 忙时输入     | 支持 queue、steer、interrupt，默认 interrupt                              | 支持三种策略但默认 queue；steer 使用 Pocket 原生 API，interrupt 非原子 stop + submit，停止不确定时拒绝自动继续 |
| 去重         | message_id 短期去重，也有相同正文指纹过滤                                 | 持久化精确消息 ID，不按正文丢弃合法重复的“继续”；64 位数字 ID 按原始 JSON 数字文本保留                         |
| 分片         | adapter 上限 2000 字符，Markdown 感知，部分聊天短行可拆泡；默认 1.5s 间隔 | 保守 1800 Unicode 码点，按段落/代码块分片，超长代码块闭合重开，固定至少 1.5s；不会为了兼容而截掉正文           |
| 权限         | 可配置私聊/群聊策略，gateway 有额外授权                                   | 只接受 QR 返回的本人私聊，Pocket 凭证必须为 owner，不开放额外入口                                              |
| 数据可靠性   | Hermes 自己的存储和生命周期                                               | SQLite durable inbox/outbox、固定 Pocket requestId；外部微信发送仍不能保证 exactly-once                        |

## 媒体与导出的安全差异

- Hermes 可自动分发媒体路径；本桥接只通过 `/send <项目内路径>` 显式导出，不自动读取模型回复中的 Markdown/MEDIA 路径，也不下载任意外部 URL。仅限 Linux 本机 loopback 共享文件系统、普通项目会话；PiP 请先切换到项目会话。目录外、符号链接逃逸、常见凭证/数据库和桥接状态一律拒绝。
- 图片/文件及其引用最多 8 个、每个 20 MiB，CDN 使用准确 HTTPS 域名白名单且拒绝重定向。AES raw/base64(hex) 密钥兼容协议，PKCS#7 填充必须正确。每个 Pocket 上传结果落盘，提交重试不丢失附件；上传接口无幂等键，响应丢失可能留下未引用的上传文件。
- 当前 Pocket 内联图片上限 5 MiB，并取决于模型是否支持视觉；普通附件仍是文件上下文，不宣称等于文档解析、语音识别或视频理解。

## 暂未提供

ASR/TTS、原生语音与视频消息处理、自动媒体路径导出、群聊、多用户、多账号、按微信引用消息定向投递 Pocket 会话，以及 Hermes 专属 transcript 回退、通知归属、动态标题/压缩链解析等运行时语义。涉及这些能力的请求不会伪装成 Hermes 已支持。

## 源码依据

以下链接均固定到上述 commit：

- [微信 adapter](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/platforms/weixin.py)：`send()`、`_extract_text()`、`_process_message()`、`_poll_loop()`、默认长度和节流。
- [文字合并](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/platforms/base.py)：`_configure_text_batch_delays()`、`_enqueue_text_event()`、`_flush_text_batch()`。
- [会话命令](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/slash_commands_session.py)：`_handle_resume_command()`、`_handle_retry_command()`；`/retry` 会改 transcript，不能拿“再提交一遍”冒充。
- [会话存储](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/session.py)：当前会话绑定及切换。
- [异步通知归属](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/gateway/run_notifications_ownership.py)：不能将独立任务投递等同于订阅所有旧会话。

媒体/typing 协议依据上述 commit 的 `_get_config()`、`_set_typing()`、`_get_upload_url()`、`_upload_ciphertext()`、`_media_item()`、`_download_media()` 和 `_parse_aes_key()`。Pocket stop/configure/upload/submit 对照 README 钉住的 0.13.2 源码 HTTP routes 与 commands。自动化覆盖临时 Pocket 的真实 upload、视觉图片存储读回、模型选择、steer 和 stop API；不连接生产 Pocket。

真实微信已验证 QR 登录和 `/help`、`/status` 命令收发。自动化使用模拟微信和临时隔离 Pocket；不以此声称真实模型任务、长期通知或媒体已完成端到端验证。
