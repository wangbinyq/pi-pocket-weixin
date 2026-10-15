# 代码标准

一个改动只有在下面 6 条全部有证据时才允许合并或发版。要写清跑了什么、结果是什么。
**没跑的检查要列为没跑，不能省略不写。**

## 1. 回退测试

把旧代码放回去，新写的测试必须真的失败，而且失败信息要说清是哪个行为错了。
编译不过、测试被跳过、断言没执行都不算。然后恢复改动再确认它通过。

## 2. 测试隔离

测试不得接触真实环境：

- 只用 `mkdtempSync` 出来的临时数据目录，不碰 `~/.local/share/pi-pocket-weixin`。
- 不向真实主机发请求。Pocket 用 `FakePocket` 或 `Pocket` + 记录型 `fetcher`；
  微信用 `FakeWeixin`。真实 iLink 与真实 Pocket 的验证在 CI 里做不到，见第 4 条。
- `POCKET_SOURCE` 集成测试只启动临时 Pocket，退出时清理，不连运行中的 Pocket。

## 3. 全量检查

```sh
npm run check && npm run format:check && npm test
```

跑整个套件，不只跑你改的那个文件。跨文件的不变量（路由代际、去重键、日志脱敏）
会在别的测试文件里被打破。

## 4. 真实使用（受限）

真机微信和真 Pocket 无法在 CI 里跑，所以这一条现在是**证据要求**而不是自动检查：

- 涉及 iLink 协议字段的改动，必须写明对照依据：`docs/hermes-parity.md` 里钉住的 Hermes
  commit，或一次真机观察（写明日期、观察到的字段）。
- 涉及 Pocket 接口的改动，必须对照 README「要求」里钉的 Pocket 版本与 commit；
  版本变了就同时更新 README。
- 没有依据就不要改协议字段。

## 5. 没跑的要写出来

PR 正文和 commit 正文要包含跑了什么和没跑什么，例如：

```
Ran: npm run check, npm run format:check, npm test (113 tests, 1 skipped without POCKET_SOURCE)
Not run: 真机微信收发、长期空闲主动推送、媒体上传
```

「没跑」不是失败，隐瞒没跑才是。

## 6. 文档同步

命令清单和能力边界在四个地方描述，必须与 `src/bridge.ts` 的 `switch` 一致：

- `README.md` 的「会话切换」表和「仍不支持」段落
- `docs/hermes-parity.md` 的「暂未提供」
- `SECURITY.md` 的 Boundaries
- `src/bridge.ts` 里的 `HELP`

加一个命令或能力，这四处一起改；删一个也一样。

## 合并与发版

- 合并前在 PR 里写清跑了什么、在哪个 commit 上跑的；用
  `gh pr merge --match-head-commit <审过的 sha>`，审完又被 push 的合并直接失败。
- 打 tag 前，该 commit 的 CI 必须跑完且全绿；被下一次 push 取消的不算。
- 改 `src/` 必须人审。碰 `src/http.ts`、身份校验、URL 校验、重定向、`SECURITY.md`
  的改动，人审是硬性要求。
- 数据库 schema 变更必须递增 `PRAGMA user_version` 并保留旧版本迁移路径；
  更高版本的数据一律拒绝打开。
- 扩大安全边界的改动另写一份 `docs/<主题>-review.md`（形式照 `docs/runtime-media-review.md`）：
  必须由人接受的边界变化、跑了什么、Not run 什么，等用户明确确认后才提交。
  测试通过不等于人工接受了边界扩大。
