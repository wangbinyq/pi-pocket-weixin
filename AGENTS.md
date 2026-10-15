# 给编码 agent 的说明

改代码前先读 [LESSONS.md](LESSONS.md)。本文件只做路由，不写规则；规则在
[docs/code-standards.md](docs/code-standards.md)。

## 干什么活先读什么

| 改动范围                            | 必读                                                                          | 主要测试                                                |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| iLink 协议、字段、轮询、错误码      | `src/ilink.ts`、[docs/hermes-parity.md](docs/hermes-parity.md) 的 commit 锚点 | `test/protocol.test.ts`                                 |
| Pocket API 路径与字段               | `src/pocket.ts`、README「要求」里的 Pocket 版本钉                             | `test/bridge.test.ts`、`POCKET_SOURCE` 集成测试         |
| 会话路由、幂等键、持久化            | `src/store.ts` 的事务边界                                                     | `test/session-routing.test.ts`、`test/recovery.test.ts` |
| 斜杠命令                            | `src/bridge.ts` 的 `switch`，加上 code-standards 第 6 条                      | `test/bridge.test.ts`                                   |
| 运行时控制 `/stop` `/model` `/busy` | `src/bridge.ts`、[docs/runtime-media-review.md](docs/runtime-media-review.md) | `test/runtime-commands.test.ts`                         |
| 媒体与 `/send`                      | `src/media.ts`、`src/weixin-media.ts`、`docs/runtime-media-review.md`         | `test/media.test.ts`、`test/media-migration.test.ts`    |
| 任何安全边界                        | [SECURITY.md](SECURITY.md)、`test/security-invariants.test.ts`                | 见该文件                                                |

## 光读代码读不出来的几件事

- **bot token、context_token、Pocket conversationId 是三个不同的东西**，混用会把回复发到别人那去。
  见 README「配置与数据」。
- **Pocket 的 HTTP API 是内部接口**，README「要求」钉的版本就是唯一依据；不要按公开 API 的直觉改字段。
- **已经发出的 HTTP 请求无法撤回。** 切换会话只取消还没发出的回复，正在飞的仍会到达微信。
- **`/send` 读的是当前项目内的真实文件**，边界靠路径 + 打开后的描述符双重检查，不是内容级 DLP。
  改这条路径逻辑前先读 `docs/runtime-media-review.md` 里人已经签字的边界。

## 硬闸门

- `test/security-invariants.test.ts` 是 SECURITY.md 的可执行副本。它变红说明你在放宽一条安全边界，
  这是人的决定：同一改动里更新 SECURITY.md，不要改测试让它变绿。
- 改 `src/` 必须人审。只有 `docs/**` 和 `test/**` 允许自动合并。
- 没跑的检查要在 PR 里写成 `Not run: …`，不能省略。
- 扩大安全边界的改动另写一份 `docs/<主题>-review.md`：必须由人接受的边界变化、跑了什么、Not run 什么，
  等用户明确确认后才提交。形式照 `docs/runtime-media-review.md`。

## 这个桥接的信任模型一句话

微信那侧只有一个扫码配对的私聊身份，Pocket 那侧是 owner 全权。桥接一旦被放宽，
等于把主机上的任意命令执行权交给微信里任意一个能发消息的人。放宽校验永远不是「修好了一个测试」。
