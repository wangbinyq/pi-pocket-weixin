import { setTimeout as sleep } from "node:timers/promises";
import type { Account, Config } from "./config.ts";
import { oneLine } from "./format.ts";
import { HttpError } from "./http.ts";
import { ILinkError, incomingFor, type WeixinPort } from "./ilink.ts";
import { finalText, type PocketPort, type Target, TargetSchema } from "./pocket.ts";
import { type Job, Store } from "./store.ts";

const HELP = `Pi Pocket 微信桥接
/pip — 连接 PiP 管家
/sessions — 列出最近 30 个会话，显示固定 ID
/use <ID> — 连接指定会话
/new [标题] — 新建并连接会话
/status — 当前目标和待发送消息
/watching — 当前回报订阅
/unwatch <ID> — 停止该会话的微信回报（不停止任务）
/retry — 重试暂停的微信发送
/help — 帮助

普通文字发送到当前目标，忙时排队。
连接会话会订阅其后续最终回复，包括网页消息和定时任务产生的回复；切换不会关闭旧订阅。
审批、模型选择和文件操作请打开 Pocket；首版仅支持本人私聊和文字。`;

export class Bridge {
  readonly store: Store;
  readonly pocket: PocketPort;
  readonly weixin: WeixinPort;
  readonly account: Account;
  readonly config: Config;
  readonly log: (message: string) => void;
  #userId = "";
  constructor(
    store: Store,
    pocket: PocketPort,
    weixin: WeixinPort,
    account: Account,
    config: Config,
    log: (message: string) => void = console.log,
  ) {
    this.store = store;
    this.pocket = pocket;
    this.weixin = weixin;
    this.account = account;
    this.config = config;
    this.log = log;
  }
  async initialize(): Promise<void> {
    this.#userId = await this.pocket.principal();
    this.store.bind(this.account, this.config.pocketUrl, this.#userId);
    if (!this.store.target()) await this.#select(await this.pocket.pip());
  }
  async #authorize(): Promise<void> {
    if (!this.#userId || (await this.pocket.principal()) !== this.#userId)
      throw new Error("Pocket identity changed; bridge paused");
  }
  #label(target: { id: number; title: string }): string {
    return `【#${target.id} ${oneLine(target.title)}】`;
  }
  async #select(target: Target): Promise<void> {
    const current = this.store.watches();
    if (!current.some((watch) => watch.id === target.id) && current.length >= 20)
      throw new CommandError("最多订阅 20 个会话，请先 /unwatch <ID>。");
    const head = await this.pocket.head(target.id);
    this.store.transaction(() => {
      this.store.watch(target, head);
      this.store.setTarget(target);
    });
  }
  async receive(signal?: AbortSignal): Promise<void> {
    const batch = await this.weixin.updates(this.store.get("syncCursor") || "", signal);
    const messages = batch.messages.flatMap((raw) => {
      const msg = incomingFor(raw, this.account);
      return msg ? [msg] : [];
    });
    this.store.ingest(this.account, batch.cursor, messages);
  }
  async processNext(): Promise<boolean> {
    const job = this.store.job();
    if (!job || job.due > Date.now()) return false;
    try {
      await this.#authorize();
      if (job.creating) {
        this.store.finish(
          job.key,
          "上次 /new 的结果不确定，已停止自动重试，避免重复建会话。请 /sessions 检查，再 /use <ID>。",
        );
      } else if (job.unsupported) {
        this.store.finish(
          job.key,
          "首版只支持不超过 32000 字符的纯文字，附件和语音请在 Pocket 发送。本条消息没有交给 Pi。",
        );
      } else if (job.text.startsWith("/")) {
        await this.#command(job);
      } else {
        const target = job.target
          ? TargetSchema.parse(JSON.parse(job.target))
          : this.store.target();
        if (!target) throw new CommandError("没有目标会话，请先 /pip 或 /use <ID>。");
        this.store.pinJob(job.key, target);
        if (!this.store.watches().some((watch) => watch.id === target.id)) {
          const cursor = await this.pocket.head(target.id);
          this.store.watch(target, cursor);
        }
        await this.pocket.submit(target.id, job.text, job.key);
        this.store.finish(job.key);
      }
    } catch (error) {
      if (error instanceof CommandError) {
        this.store.finish(job.key, error.message);
      } else if (error instanceof HttpError && [400, 403, 404, 409].includes(error.status)) {
        this.store.finish(
          job.key,
          `Pocket 暂未接受请求（HTTP ${error.status}）。请打开网页检查会话权限、模型、费用限制或轮流控制状态，再重新发送。`,
        );
      } else {
        this.store.retryJob(job);
        this.log("Pocket input deferred; will retry with the same request ID.");
        return false;
      }
    }
    return true;
  }
  async #command(job: Job): Promise<void> {
    const [command, ...words] = job.text.trim().split(/\s+/);
    const argument = words.join(" ");
    const id = /^\d+$/.test(argument) ? Number(argument) : NaN;
    let response: string;
    switch (command) {
      case "/help":
        response = HELP;
        break;
      case "/retry":
        this.store.retryDeliveries();
        response = "已重新排队发送暂停的回复。网络结果不确定时，微信可能收到重复消息。";
        break;
      case "/sessions": {
        const sessions = await this.pocket.sessions();
        response =
          "固定会话 ID（不是列表序号）：\n" +
          sessions
            .slice(0, 30)
            .map(
              (session) =>
                `#${session.id} ${oneLine(session.title || "New session")} · ${session.waiting ? "待审批" : session.busy ? "工作中" : "空闲"}${session.archived ? " · 已归档" : ""}`,
            )
            .join("\n") +
          "\n\n/use <ID> 切换；/pip 返回管家。";
        break;
      }
      case "/pip":
      case "/use": {
        let target: Target;
        if (command === "/pip") target = await this.pocket.pip();
        else {
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new CommandError("用法：/use <固定会话 ID>，先 /sessions 查看。");
          const session = (await this.pocket.sessions()).find((entry) => entry.id === id);
          if (!session) throw new CommandError("找不到可访问的会话；PiP 请用 /pip 连接。");
          target = { id, title: session.title || "New session", pip: false };
        }
        await this.#select(target);
        response = this.#connected(target);
        break;
      }
      case "/new": {
        if (this.store.watches().length >= 20)
          throw new CommandError("订阅已满，请先 /unwatch <ID>。");
        this.store.markCreating(job.key);
        let target: Target;
        try {
          target = await this.pocket.create(argument || "Weixin", this.config.newCwd);
        } catch {
          this.store.finish(
            job.key,
            "新建请求的结果不确定，未自动重试。请 /sessions 检查是否已创建，再 /use <ID>；也可在网页新建。",
          );
          return;
        }
        this.store.finish(job.key, this.#connected(target), target);
        return;
      }
      case "/status": {
        const target = this.store.target();
        const running = (await this.pocket.running()).find((entry) => entry.id === target?.id);
        const counts = this.store.counts();
        response = `${target ? this.#label(target) : "未连接"}\n${running?.approvals ? "等待网页审批" : running?.busy ? "工作中" : "空闲"}\n待发送 ${counts.pending}，需用户发消息恢复 ${counts.blocked}，发送暂停 ${counts.failed}\n${target ? this.pocket.link(target.id) : ""}`;
        break;
      }
      case "/watching":
        response =
          "回报订阅（切换后仍保留）：\n" +
          this.store
            .watches()
            .map((watch) => this.#label(watch))
            .join("\n") +
          "\n/unwatch <ID> 停止同步。";
        break;
      case "/unwatch":
        if (!Number.isSafeInteger(id) || !this.store.watches().some((watch) => watch.id === id))
          throw new CommandError("用法：/unwatch <已订阅的会话 ID>，先 /watching 查看。");
        this.store.unwatch(id);
        response = `已停止 #${id} 的回报并取消未发送的该会话回复；任务不受影响。再次向它发消息会重新订阅。`;
        break;
      default:
        throw new CommandError(
          "未知桥接命令，没有发送给 Pi。用 /help 查看；审批请在 Pocket 网页操作。",
        );
    }
    this.store.finish(job.key, response);
  }
  #connected(target: Target): string {
    return `${this.#label(target)} 已连接。\n后续文字直接发送到此会话。其新的最终回复（含网页和定时任务）将同步到微信；切换保留旧订阅。/unwatch ${target.id} 停止回报。\n${this.pocket.link(target.id)}`;
  }
  async collect(): Promise<void> {
    await this.#authorize();
    const running = await this.pocket.running();
    for (const watch of this.store.watches()) {
      let entries;
      try {
        entries = await this.pocket.after(watch.id, watch.cursor);
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status)) {
          this.store.unwatch(watch.id);
          continue;
        }
        throw error;
      }
      const current = this.store.watches().find((item) => item.id === watch.id);
      if (!current) continue;
      this.store.transaction(() => {
        for (const entry of entries) {
          if (entry.id <= current.cursor) continue;
          const text = finalText(entry);
          if (text)
            this.store.enqueue(
              `reply:${watch.id}:${entry.id}`,
              `${this.#label(watch)}\n${text}`,
              watch.id,
            );
          this.store.advance(watch.id, entry.id);
        }
        const approvals = running.find((item) => item.id === watch.id)?.approvals || 0;
        if (approvals && !current.approval) {
          this.store.enqueue(
            `approval:${watch.id}:${Date.now()}`,
            `${this.#label(watch)} 需要人工审批。请在 Pocket 查看并决定：\n${this.pocket.link(watch.id)}`,
            watch.id,
          );
        }
        this.store.approval(watch.id, approvals);
      });
    }
  }
  async deliverNext(signal?: AbortSignal): Promise<boolean> {
    const row = this.store.delivery();
    if (!row || row.state !== "pending" || row.due > Date.now()) return false;
    await this.#authorize();
    if (row.conversation !== null) {
      try {
        await this.pocket.head(row.conversation);
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status)) {
          this.store.unwatch(row.conversation);
          return false;
        }
        throw error;
      }
      if (!this.store.watches().some((watch) => watch.id === row.conversation)) return false;
    }
    const context = this.store.get("contextToken");
    try {
      try {
        await this.weixin.send(this.account.peer, row.text, row.key, context || undefined, signal);
      } catch (error) {
        if (!(error instanceof ILinkError && ["session", "auth"].includes(error.kind) && context))
          throw error;
        if (this.store.get("contextToken") === context) this.store.set("contextToken", "");
        await this.weixin.send(
          this.account.peer,
          row.text,
          row.key,
          this.store.get("contextToken") || undefined,
          signal,
        );
      }
      this.store.sent(row.key);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      const blocked = error instanceof ILinkError && ["session", "auth"].includes(error.kind);
      this.store.deliveryFailed(
        row,
        blocked,
        error instanceof ILinkError && error.kind === "rate" ? 30_000 : 0,
      );
      this.log(
        blocked
          ? "Weixin reply session is unavailable; send the bot a message or log in again."
          : "Weixin delivery deferred; check doctor or use /retry if paused.",
      );
      return false;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    const loop = async (task: () => Promise<unknown>, delay: number, label: string) => {
      while (!signal.aborted) {
        let pause = delay;
        try {
          await task();
        } catch (error) {
          if (signal.aborted) break;
          pause = error instanceof ILinkError && error.kind === "auth" ? 600_000 : 5000;
          this.log(
            `${label} paused${error instanceof ILinkError ? ` (${error.kind})` : ""}; check credentials/network. No message bodies are logged.`,
          );
        }
        try {
          await sleep(pause, undefined, { signal });
        } catch {
          break;
        }
      }
    };
    await Promise.all([
      loop(() => this.receive(signal), 250, "Weixin polling"),
      loop(() => this.processNext(), 250, "Pocket input"),
      loop(() => this.collect(), 3000, "Pocket replies"),
      loop(() => this.deliverNext(signal), 1500, "Weixin output"),
    ]);
  }
}
class CommandError extends Error {}
