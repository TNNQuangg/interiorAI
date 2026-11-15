import type { IssueDisplayStatus } from "@paperclipai/shared";

export function formatTelegramCreationStatus(status: "queued" | "running" | "unconfirmed"): string {
  if (status === "queued") return "queued — agent run accepted; work has not yet been confirmed running";
  if (status === "running") return "running — agent execution confirmed at dispatch";
  return "task saved — agent execution is not confirmed; use /task to inspect its state";
}

/** Presentation only: comments and lifecycle locks do not prove active work. */
export function formatTelegramTaskStatus(task: { status: string; displayStatus?: IssueDisplayStatus }): string {
  if (!task.displayStatus) {
    return `vòng đời \`${task.status}\` (chưa xác minh trạng thái thực thi)`;
  }
  const lifecycle = task.displayStatus !== task.status ? ` (vòng đời: \`${task.status}\`)` : "";
  return `\`${task.displayStatus}\`${lifecycle}`;
}
