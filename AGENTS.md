# 给编码 agent 的说明

改代码前先读 [LESSONS.md](LESSONS.md)。本文件只做路由，不写规则；规则在
[docs/code-standards.md](docs/code-standards.md)。

## 干什么活先读什么

| 改动范围                       | 必读                                                                          | 主要测试                                                |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| iLink 协议、字段、轮询、错误码 | `src/ilink.ts`、[docs/hermes-parity.md](docs/hermes-parity.md) 的 commit 锚点 | `test/protocol.test.ts`                                 |
| Pocket API 路径与字段          | `src/pocket.ts`、README「要求」里的 Pocket 版本钉                             | `test/bridge.test.ts`、`POCKET_SOURCE` 集成测试         |
| 会话路由、幂等键、持久化       | `src/store.ts` 的事务边界                                                     | `test/session-routing.test.ts`、`test/recovery.test.ts` |
| 斜杠命令                       | `src/bridge.ts` 的 `switch`，加上 code-standards 第 6 条                      | `test/bridge.test.ts`                                   |
| 媒体（进行中）                 | `src/media.ts`、`src/weixin-media.ts`                                         | 尚无，改动时补                                          |
| 任何安全边界                   | [SECURITY.md](SECURITY.md)、`test/security-invariants.test.ts`                | 见该文件                                                |

## 硬闸门

- `test/security-invariants.test.ts` 是 SECURITY.md 的可执行副本。它变红说明你在放宽一条安全边界，
  这是人的决定：同一改动里更新 SECURITY.md，不要改测试让它变绿。
- 改 `src/` 必须人审。只有 `docs/**` 和 `test/**` 允许自动合并。
- 没跑的检查要在 PR 里写成 `Not run: …`，不能省略。

## 这个桥接的信任模型一句话

微信那侧只有一个扫码配对的私聊身份，Pocket 那侧是 owner 全权。桥接一旦被放宽，
等于把主机上的任意命令执行权交给微信里任意一个能发消息的人。放宽校验永远不是「修好了一个测试」。
