# /status 与公网链接审阅记录（issues #1 / #2）

## 人工接受的范围

wangb 经 PiP 明确要求保持 pi-pocket 不变，并在查明现有接口后明确授权桥接复用 `GET /api/poll?c=<当前会话>` → 首帧 view → `GET /api/poll?session=…&close=1`；不将测试通过等同于额外的独立人工逐行审阅。PiP `/send` 的原限制保持不变。

- 仅新增对 Pocket **已经存在**的 GET /api/poll 的调用，不向 Pocket 增加任何接口、不编辑其源码/配置/数据库。继续使用桥接环境中已有 owner Bearer token；不从 Pocket config.json 取 token。
- 只提取当前会话匹配的 model、contextWindow、contextTokens、contextEstimated；完整 view 可能包含正文，但不存储/转发/记录它。沿用 8 MiB 响应上限、拒绝重定向，读取 4 秒、关闭 2 秒；拿到 session 后在 finally 关闭，关闭失败依赖服务端 60 秒自动清理。响应丢失、超限或无合法 session 时无法主动关闭未知 poller，亦由 TTL 清理。订阅会短暂增加查看者/在线状态。
- tokens 使用 Pocket 的最近有效响应用量；估算明确标记，无数据 unknown。24h 是去重后本人消息的桥接接收时间推算，不是微信服务端窗口保证；本次 /status 本身会刷新接收时间。旧数据 received=0 不编造时间。
- 诊断回执可以越过暂停发送队列，以便用户实际读到 blocked/failed；其优先标记和回执在一个事务持久化，仅最新诊断待发回执优先。不重试、不取消、不改序普通回复，也不绕过 owner 校验或微信窗口。
- 一处出站文本策略在 Store 分片前生效，在 Bridge 外发前复核旧队列。模型正文、命令/帮助、审批及错误等文本一并覆盖。只识别配置的 API、公网 origin、同端口 reviewed loopback 别名及相对会话路由，不猜测其他域名。缺省公网 URL 显式降级，不再回退到 API origin；登录/邀请链接隐藏，凭证/非定位查询/未知锚点移除。此策略不是任意正文的 DLP，不自动导出任何路径或 URL。
- 数据库 schema 仍为 v3，仅使用已有 meta/received；身份、路由、水位、收发键不迁移。lastInboundAt 可从旧 received 恢复；重复消息不刷新。版本为 package version + 启动时 git revision，source archive 的 revision 为 unknown；重启时间为桥接实例创建时间（UTC），不是 Pocket 启动时间。

## 源码依据

Pocket 0.13.2 `de612d5622cdc66b6b8b4900c650c6f2efdf4c63`：`src/server/http/events.ts`、`http/api.ts`、`auth.ts`、`room.ts`、`projection.ts`、`models.ts` 与 `web/store.js`。浏览器通常持续消费 SSE/长轮询，并非本来只读一帧；桥接的短生命周期是对现有协议的受限复用。未改微信协议字段。

## Ran

- HEAD 50a79c2 干净临时 worktree：类型、格式、113 tests 全通过，无跳过。
- 新增状态/链接行为测试；隔离 Pocket 的普通会话及 PiP 实际 model/window/tokens 验证。
- 临时副本回退 old bridge/config/Pocket：6 个已执行的行为断言失败；恢复当前实现后同一断言全部通过。不以编译错误、缺失方法或跳过为证据。
- `npm run check`、`npm run format:check`、`POCKET_SOURCE=/home/wangb/git/pi-pocket npm test`（133 passed，0 failed/skip）、`git diff --check`。CI 结果见 issue 收尾评论。
- 旧队列公网替换变长时重新分片，使用稳定子 client_id，仍保留 1800 码点和片间 1.5 秒；中途失败可能重复已发片段，不声称 exactly-once。

## Not run（提交前）

- 真实微信新 /status 与图片发送/接收；排在两 issue 发布收尾之后，不能将临时 Pocket 或 FakeWeixin 算作真机证据。
- 生产 Pocket 的 stop/model/reset/submit/upload；只允许只读诊断，绝不为验证清空生产上下文或重启 Pocket。
- 长期空闲主动推送、微信服务端幂等保证、全部图片格式/尺寸限制与账户适用性。
- 额外独立人工逐行审阅；用户直接授权本任务及现有 poll 复用不等于该项已执行。
