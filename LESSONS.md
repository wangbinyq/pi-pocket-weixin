<!-- reviewed-through: c58e4e1 (2026-10-15) -->

# 合并后学到的东西

改代码前先读这里。每条是一条规则，然后是原因和证据。

格式：

```
**一句话规则** — 哪个 commit / issue 出的事、后果是什么 — 修复的 commit
- Done right: 做对的例子
- Seen N× (YYYY-MM-DD, …)
```

同一条在 **3 个不同日子**被记到，就从这里挪进
[docs/code-standards.md](docs/code-standards.md)，变成每次审查都要逐条对的硬规则。

## 流程

**提交前重新确认 HEAD，不要假设工作区没变** — 本文件旁边的安全测试是针对一个**未提交**的工作区写的，
当时另一个会话正在同一目录里改媒体支持与 `/stop` `/model` `/busy`。期间那个会话提交了
`c58e4e1`，schema 升到 v3、Pocket 多了 `upload` 端点，于是「未来版本」的断言必须是 4 而不是 3，
端点白名单要加 `POST /api/c/{id}/upload`。判定基准在你手下会变。

- 提交前在 HEAD 的干净 worktree 里重跑一遍：`git worktree add /tmp/x HEAD`。
- Seen 1× (2026-10-15)

## Done right（照这个来）

**64 位消息 ID 在解析时就保住原文** — `src/ilink.ts` 的 `parseILinkJson` 用 `JSON.parse` 的
reviver，配合 `context.source` 在数值已经丢精度之前返回原始数字文本。
先 `JSON.parse` 再想办法修是修不回来的，精度在解析那一刻就没了。
对应测试：`test/large-message-id.test.ts`。

**结果不确定的写操作先落盘意图再发请求** — `/new`、`/reset`、`/stop` 和 interrupt 的停止阶段
都没有幂等键，所以先把意图写进 SQLite，再发 HTTP。响应丢失或进程中断后，重试路径明确回复
「结果不确定，未自动重复」，而不是重放。
对应测试：`test/recovery.test.ts`、`test/reset.test.ts`、`test/runtime-commands.test.ts`。

**日志只说状态，不说内容** — `src/bridge.ts` 每条 `log()` 都是固定文案，带计数但不带正文
（"No message bodies are logged."）。对应测试：SEC-LOG。

**扩大安全边界的改动单独留一份人审记录** — `docs/runtime-media-review.md`（`c58e4e1`）分三块写：
必须由人接受的边界变化（新端点、`/model` 换模型、`/send` 读项目内文件、CDN 下载、私有库存媒体密钥）、
跑了什么、**Not run** 什么。里面一句话是标准：

> `SECURITY.md` 与对应可执行清单已一起呈现这些变更，不能将测试通过当作人工接受了边界扩大。
