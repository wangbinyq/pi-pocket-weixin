import { oneLine } from "./format.ts";
import type { Diagnostics, Running, Target } from "./pocket.ts";
import type { Watch } from "./store.ts";

export function statusText(info: {
  target?: Target;
  watch?: Watch;
  diagnostics: Diagnostics;
  running?: Running;
  runningKnown: boolean;
  counts: { inbox: number; pending: number; blocked: number; failed: number };
  lastInboundAt?: number;
  version: string;
  startedAt: number;
  now: number;
}): string {
  const { target, watch, diagnostics: data, counts } = info;
  const timestamp = (value?: number) =>
    value && value > 0 && Number.isFinite(value)
      ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + "Z"
      : "unknown";
  const age = info.lastInboundAt === undefined ? undefined : info.now - info.lastInboundAt;
  const window =
    age === undefined || age < 0 || !Number.isFinite(age)
      ? "unknown"
      : age >= 86_400_000
        ? "EXPIRED 超过24h"
        : `OPEN 剩${((86_400_000 - age) / 3_600_000).toFixed(1)}h`;
  const tokens = data.contextTokens;
  const capacity = data.contextWindow;
  const percent =
    tokens === undefined || capacity === undefined
      ? "unknown"
      : `${((tokens / capacity) * 100).toFixed(1)}%`;
  const activity = !info.runningKnown
    ? "unknown"
    : info.running?.approvals
      ? "等待网页审批"
      : info.running?.busy
        ? "工作中"
        : "空闲";
  return [
    target
      ? `【#${target.id} ${oneLine(target.title)}】${target.pip ? " PiP" : ""}`
      : "会话 unknown",
    `路由 ${watch ? "同步中" : "未同步"} · 游标 ${watch?.cursor ?? "unknown"}`,
    `模型 ${data.model ? oneLine(data.model.provider + "/" + data.model.modelId) : "unknown"}`,
    `上下文 ${tokens ?? "unknown"}/${capacity ?? "unknown"} tokens`,
    `占用 ${percent} · ${tokens === undefined ? "unknown" : data.contextEstimated ? "Pocket估算" : "最近响应用量"}`,
    `Pocket ${activity}`,
    `队列 入${counts.inbox} 待发${counts.pending}`,
    `发送 blocked=${counts.blocked} failed=${counts.failed}`,
    `入站 ${timestamp(info.lastInboundAt)}`,
    `24h ${window}（接收时间参考）`,
    `桥接 ${info.version}`,
    `重启 ${timestamp(info.startedAt)}`,
  ].join("\n");
}
