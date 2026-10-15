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
/resume <ID> — 恢复指定会话
/new [标题] — 新建并连接会话
/reset [交接说明] — 当前会话开启新上下文，保留历史
/status — 当前目标和待发送消息
/retry-send — 重试暂停的微信发送（不重新运行模型）
/help — 帮助

普通文字发送到当前目标，忙时排队。
仅同步当前会话的新最终回复；切换取消旧会话待发回复，不停止旧任务，也不补发离开期间的回复。
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
    this.store.reconcile();
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
    const head = await this.pocket.head(target.id);
    this.store.select(target, head);
  }
  async receive(signal?: AbortSignal): Promise<void> {
    const batch = await this.weixin.updates(this.store.get("syncCursor") || "", signal);
    const messages = batch.messages.flatMap((raw) => {
      const msg = incomingFor(raw, this.account);
      return msg ? [msg] : [];
    });
    this.store.ingest(this.account, batch.cursor, messages);
    if (batch.messages.length) {
      this.log(
        `Weixin intake: received=${batch.messages.length}, accepted=${messages.length}, filtered=${batch.messages.length - messages.length}. No message bodies are logged.`,
      );
    }
  }
  async processNext(): Promise<boolean> {
    const job = this.store.prepareJob(this.config.textBatchDelayMs ?? 300);
    if (!job || job.due > Date.now()) return false;
    try {
      await this.#authorize();
      if (this.store.get("resetIntent") === job.key) {
        this.store.finish(
          job.key,
          "上次 /reset 的结果不确定，未自动重试，避免再次清除新上下文。请打开 Pocket 检查当前会话的新上下文标记后，再决定是否重新发送 /reset。",
        );
      } else if (job.creating) {
        this.store.finish(
          job.key,
          "上次 /new 的结果不确定，已停止自动重试，避免重复建会话。请 /sessions 检查，再 /resume <ID>。",
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
        if (!target) throw new CommandError("没有目标会话，请先 /pip 或 /resume <ID>。");
        this.store.pinJob(job.key, target);
        if (
          this.store.target()?.id === target.id &&
          !this.store.watches().some((watch) => watch.id === target.id)
        )
          await this.#select(target);
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
      case "/retry-send":
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
          "\n\n/resume <ID> 恢复会话；/pip 返回管家。";
        break;
      }
      case "/pip":
      case "/resume": {
        let target: Target;
        if (command === "/pip") target = await this.pocket.pip();
        else {
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new CommandError("用法：/resume <固定会话 ID>，先 /sessions 查看。");
          const session = (await this.pocket.sessions()).find((entry) => entry.id === id);
          if (!session) throw new CommandError("找不到可访问的会话；PiP 请用 /pip 连接。");
          target = { id, title: session.title || "New session", pip: false };
        }
        await this.#select(target);
        response = this.#connected(target);
        break;
      }
      case "/new": {
        this.store.markCreating(job.key);
        let target: Target;
        try {
          target = await this.pocket.create(argument || "Weixin", this.config.newCwd);
        } catch {
          this.store.finish(
            job.key,
            "新建请求的结果不确定，未自动重试。请 /sessions 检查是否已创建，再 /resume <ID>；也可在网页新建。",
          );
          return;
        }
        this.store.finish(job.key, this.#connected(target), target);
        return;
      }
      case "/reset": {
        const target = this.store.target();
        if (!target) throw new CommandError("没有目标会话，请先 /pip 或 /resume <ID>。");
        const note = job.text.trim().slice(command.length).trim();
        if (note.length > 20_000)
          throw new CommandError("/reset 的交接说明不能超过 20000 字符，本次未执行。");
        this.store.beginReset(job.key, target);
        try {
          await this.pocket.reset(target.id, note || undefined);
        } catch (error) {
          if (error instanceof HttpError && [400, 403, 404, 409, 413].includes(error.status))
            throw new CommandError(
              `Pocket 未接受 /reset（HTTP ${error.status}）。请在网页检查权限、轮流控制和交接说明后重新发送。`,
            );
          this.store.finish(
            job.key,
            "本次 /reset 的结果不确定，未自动重试，避免再次清除新上下文。请打开 Pocket 检查当前会话的新上下文标记后，再决定是否重新发送 /reset。",
          );
          return;
        }
        response = `${this.#label(target)} 新上下文请求已接受。\n历史记录保留，会话 ID 不变；${note ? "已附带交接说明。" : "未附带交接说明。"}忙时在下一处理边界生效，不停止当前任务。\n${this.pocket.link(target.id)}`;
        break;
      }
      case "/status": {
        const target = this.store.target();
        const running = (await this.pocket.running()).find((entry) => entry.id === target?.id);
        const counts = this.store.counts();
        response = `${target ? this.#label(target) : "未连接"}\n${running?.approvals ? "等待网页审批" : running?.busy ? "工作中" : "空闲"}\n待发送 ${counts.pending}，需用户发消息恢复 ${counts.blocked}，发送暂停 ${counts.failed}\n${target ? this.pocket.link(target.id) : ""}`;
        break;
      }
      case "/retry":
        response =
          "这里暂不支持 Hermes 的 /retry（重新回答）。要恢复微信发送队列，请用 /retry-send；重新执行任务请明确发送新请求。";
        break;
      default:
        throw new CommandError(
          "未知桥接命令，没有发送给 Pi。用 /help 查看；审批请在 Pocket 网页操作。",
        );
    }
    this.store.finish(job.key, response);
  }
  #connected(target: Target): string {
    return `${this.#label(target)} 已连接。\n后续文字发送到此会话，仅同步当前会话的新最终回复。切换不停止旧任务，不补发离开期间的回复。\n${this.pocket.link(target.id)}`;
  }
  async collect(): Promise<void> {
    await this.#authorize();
    const running = await this.pocket.running();
    const generation = this.store.generation();
    for (const watch of this.store.watches()) {
      let entries;
      try {
        entries = await this.pocket.after(watch.id, watch.cursor);
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status)) {
          if (this.store.generation() === generation) this.store.unwatch(watch.id);
          continue;
        }
        throw error;
      }
      const current = this.store.watches().find((item) => item.id === watch.id);
      if (
        !current ||
        this.store.target()?.id !== watch.id ||
        this.store.generation() !== generation
      )
        continue;
      this.store.transaction(() => {
        for (const entry of entries) {
          if (entry.id <= current.cursor) continue;
          const text = finalText(entry);
          if (text) this.store.enqueue(`reply:${watch.id}:${entry.id}`, text, watch.id);
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
    const generation = this.store.generation();
    const eligible = () =>
      this.store.isPending(row.key) &&
      (row.conversation === null ||
        (this.store.target()?.id === row.conversation &&
          this.store.generation() === generation &&
          this.store.watches().some((watch) => watch.id === row.conversation)));
    await this.#authorize();
    if (row.conversation !== null) {
      try {
        await this.pocket.head(row.conversation);
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.status)) {
          if (eligible()) this.store.unwatch(row.conversation);
          return false;
        }
        throw error;
      }
    }
    if (!eligible()) return false;
    const context = this.store.get("contextToken");
    try {
      try {
        await this.weixin.send(this.account.peer, row.text, row.key, context || undefined, signal);
      } catch (error) {
        if (!(error instanceof ILinkError && ["session", "auth"].includes(error.kind) && context))
          throw error;
        if (this.store.get("contextToken") === context) this.store.set("contextToken", "");
        if (!eligible()) return false;
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
          : "Weixin delivery deferred; check doctor or use /retry-send if paused.",
      );
      return false;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    const loop = async (task: () => Promise<unknown>, delay: number, label: string) => {
      let failures = 0;
      while (!signal.aborted) {
        let pause = delay;
        try {
          await task();
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          failures++;
          if (error instanceof ILinkError && ["auth", "session"].includes(error.kind)) {
            pause = 600_000;
            failures = 0;
          } else {
            pause = failures >= 3 ? 30_000 : 2000;
            if (failures >= 3) failures = 0;
          }
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
