# 第 2 项：运行时与媒体变更审阅记录

状态：**用户在交付说明后明确确认提交、推送并重启桥接。** 以下为提交前验证记录；CI 与生产迁移在发布时另行核验，不把自动化通过等同于独立人工审阅。

## 本次范围

- 当前会话 `/stop`、`/model [provider/id] [思考级别]`、`/busy queue|steer|interrupt`。
- 输入中提示、Markdown 段落/代码块分片。
- 图片/文件及其引用接收、认证上传 Pocket、与文字使用稳定请求 ID 一起提交。
- `/send <项目内路径>` 显式发送项目图片/文件。仅同机 Linux loopback 普通会话，不从模型输出自动读取路径，PiP 请先切换到项目会话。
- SQLite v2→v3 媒体字段迁移，保留路由、游标和已有收发键。
- 不实现 ASR/TTS、原生语音/视频处理、群聊、多用户、Hermes transcript 回退或通知归属。

## 必须由人接受的边界变化

1. Pocket API 新增 `POST /api/c/:id/upload`，只能在 owner 认证下为目标会话上传。`cwd()` 只复用已有 sessions API，不读取 Pocket 数据文件。
2. `/model` 现在可以更换当前会话模型/思考级别；仍只能由配对 owner 显式指定已配置模型。`/stop` 和 interrupt 会停止当前运行并撤回队列，不取消所有独立任务/计划。
3. `/send` 可以读取当前项目内明确指定的普通文件；真实路径和打开后的描述符都检查边界，拒绝敏感文件/桥接状态，但不是内容级 DLP。
4. 微信 CDN 新增有上限的二进制下载/上传。精确 HTTPS host allowlist、拒绝重定向，CDN 不带 bot/Pocket token。
5. 私有数据库开始保存附件引用与媒体密钥，私有缓存保存明文附件快照。发送/取消会清除队列字段；未引用且超过七天的缓存启动时清理，Pocket 上传由 Pocket 管理。

`SECURITY.md` 与对应可执行清单已一起呈现这些变更，不能将测试通过当作人工接受了边界扩大。SEC-3 增加 upload/cwd 覆盖；SEC-DB 的未来版本测试从 3 改为 4，因为当前版本已升到 3。身份、origin、重定向、审批/shell/删历史拒绝测试均保留。

## 已运行

- `npm run check`。
- `npm run format:check`。
- `POCKET_SOURCE=/home/wangb/git/pi-pocket npm test`：113 项全部通过，无跳过；包括隔离 Pocket 的模型选择、steer、stop、图片上传和视觉图片存储读回。
- `git diff --check`。
- 临时目录回退测试：用 `29a9283` 的 bridge/formatter 替换副本，五项新增行为断言失败（stop、model、媒体附件、send、长代码分片），恢复当前实现后五项通过。旧 store 在 v2→v3 版本断言失败，当前 store 同一测试通过。没有用编译失败或缺方法异常冒充回退证据；未替换真实工作区或生产数据。

协议依据：Hermes `7bda2a3368024f7ae1c70cef16583e7c2c891674`；Pocket 0.13.2 `de612d5622cdc66b6b8b4900c650c6f2efdf4c63`。详见 [Hermes 行为与边界](hermes-parity.md)。

## Not run

- 真实微信图片/文件发送、接收、引用媒体与输入中提示的端到端验证。
- 真实微信上的普通模型任务全链路和长期空闲主动通知。
- 正在运行的生产 Pocket 的 stop/model/upload 验证；自动化只运行临时隔离实例。
- 提交前未运行生产桥接的 v2→v3 迁移与新功能重启部署；发布时先备份再核验。
- 提交前未运行本批次 GitHub CI；不声称已完成额外的独立人工逐行代码审阅。

## 审阅后部署注意

先停止桥接、备份桥接自己的 SQLite，再启动；**不重启 Pocket、不编辑 Pocket 配置或数据库**。v3 数据库不能直接交给旧 v2 代码打开。当前 systemd 的 PrivateTmp 保留，`/send` 不应依赖 Pocket 的共享 `/tmp`，文件应放在正常项目目录。
