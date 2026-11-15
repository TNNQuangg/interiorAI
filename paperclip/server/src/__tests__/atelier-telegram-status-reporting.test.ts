import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Db } from "@paperclipai/db";
import type { IssueDisplayStatus } from "@paperclipai/shared";
import { AtelierTelegramPoller } from "../services/atelier-telegram/poller.js";
import { AtelierTelegramTaskManager } from "../services/atelier-telegram/task-manager.js";
import { TelegramBotClient } from "../services/atelier-telegram/telegram-client.js";
import { formatTelegramTaskStatus } from "../services/atelier-telegram/task-status.js";

const mocks = vi.hoisted(() => ({
  config: { botToken: "", notificationsEnabled: true, chatTaskMappings: [] as Record<string, unknown>[] },
  recordMapping: vi.fn(),
}));
vi.mock("../services/atelier-telegram/config.js", () => ({
  getTelegramConfigSync: () => mocks.config,
  recordChatTaskMapping: mocks.recordMapping,
  addTelegramLog: vi.fn(), loadTelegramConfig: vi.fn(), saveTelegramConfig: vi.fn(),
  maskToken: vi.fn(), findTaskMappingByMessageOrChat: vi.fn(), verifyAndPairUser: vi.fn(),
}));

// Invoke one existing handler pass, without starting timers, polling or network.
type PollerHandlers = {
  checkAndNotifyMappedTaskUpdates(): Promise<void>;
  handleTaskDetailCommand(chatId: number, identifier: string): Promise<void>;
  handleTasksCommand(chatId: number): Promise<void>;
};
type TaskDetail = NonNullable<Awaited<ReturnType<AtelierTelegramTaskManager["getTaskByIdentifierOrId"]>>>;

describe("Telegram execution-state reporting", () => {
  let poller: PollerHandlers;
  let send: MockInstance<TelegramBotClient["sendMessage"]>;
  let lookup: MockInstance<AtelierTelegramTaskManager["getTaskByIdentifierOrId"]>;
  const issueId = "11111111-1111-4111-8111-000000000015";

  function detail(displayStatus?: IssueDisplayStatus, body = "status: blocked\nWaiting for bedroom scene input"): TaskDetail {
    return {
      issue: { id: issueId, identifier: "ATL-15", title: "Bedroom", status: "in_progress", displayStatus, priority: "high" },
      assignedAgentName: "Designer",
      comments: [{ id: "comment-1", body, authorType: "agent", authorAgentId: "agent-1", createdAt: new Date("2026-11-15T01:00:00Z") }],
    } as TaskDetail;
  }

  beforeEach(() => {
    mocks.config.notificationsEnabled = true;
    mocks.config.chatTaskMappings = [{ telegramChatId: 123, telegramMessageId: 42, issueId,
      issueIdentifier: "ATL-15", assignedAgentName: "Designer", lastActivityAt: "2026-11-15T00:00:00Z" }];
    mocks.recordMapping.mockReset();
    send = vi.spyOn(TelegramBotClient.prototype, "sendMessage").mockResolvedValue({ message_id: 43 } as never);
    vi.spyOn(TelegramBotClient.prototype, "hasToken").mockReturnValue(true);
    lookup = vi.spyOn(AtelierTelegramTaskManager.prototype, "getTaskByIdentifierOrId");
    poller = new AtelierTelegramPoller({} as Db) as unknown as PollerHandlers;
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["blocked", "in_review", "todo", "monitoring", "in_progress"] as const)("uses %s for mapped comment notifications and labels lifecycle separately", async (displayStatus) => {
    lookup.mockResolvedValue(detail(displayStatus));
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(lookup).toHaveBeenCalledWith(issueId);
    const text = send.mock.calls[0]![1];
    expect(text).toContain(`Trạng thái hiện tại: \`${displayStatus}\``);
    expect(text).toContain("status: blocked"); // Agent prose is evidence, not a state override.
    if (displayStatus !== "in_progress") {
      expect(text).toContain("(vòng đời: `in_progress`)");
      expect(text).not.toContain("Trạng thái hiện tại: `in_progress`");
    }
    expect(send).toHaveBeenCalledWith(123, expect.any(String), expect.objectContaining({ reply_to_message_id: 42 }));
    expect(mocks.recordMapping).toHaveBeenCalledWith(expect.objectContaining({ lastActivityAt: "2026-11-15T01:00:00.000Z" }));
  });

  it("preserves input requests alongside the canonical display state", async () => {
    lookup.mockResolvedValue(detail("in_review", "status: needs_input\nquestions:\nWhich bedroom?"));
    await poller.checkAndNotifyMappedTaskUpdates();
    const text = send.mock.calls[0]![1];
    expect(text).toContain("cần bạn bổ sung");
    expect(text).toContain("Which bedroom?");
    expect(text).toContain("Trạng thái hiện tại: `in_review`");
    expect(text).toContain("Hãy Reply");
  });

  it("labels raw lifecycle honestly if display state is unavailable", async () => {
    lookup.mockResolvedValue(detail());
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(send.mock.calls[0]![1]).toContain("vòng đời `in_progress` (chưa xác minh trạng thái thực thi)");
    expect(send.mock.calls[0]![1]).not.toContain("Trạng thái hiện tại: `in_progress`");
  });

  it("uses display state in both task details and task lists", async () => {
    lookup.mockResolvedValue(detail("blocked"));
    await poller.handleTaskDetailCommand(123, issueId);
    expect(send.mock.calls[0]![1]).toContain("**Trạng thái:** `blocked` (vòng đời: `in_progress`)");
    vi.spyOn(AtelierTelegramTaskManager.prototype, "listActiveTasks").mockResolvedValue([{
      id: issueId, identifier: "ATL-15", title: "Bedroom", status: "in_progress", displayStatus: "blocked",
      priority: "high", assignedAgentName: "Designer", assignedAgentId: "agent-1", createdAt: "2026-11-15", commentCount: 1,
    }]);
    await poller.handleTasksCommand(123);
    const text = send.mock.calls[1]![1];
    expect(text).toContain("CHƯA KẾT THÚC");
    expect(text).toContain("🚧");
    expect(text).toContain("Trạng thái: `blocked` (vòng đời: `in_progress`)");
    expect(text).not.toContain("⚡");
  });

  it("does not send updates for foreign or missing mappings", async () => {
    lookup.mockResolvedValue(null);
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.recordMapping).not.toHaveBeenCalled();
  });

  it("does not advance delivery state when Telegram rejects the message", async () => {
    lookup.mockResolvedValue(detail("blocked"));
    send.mockRejectedValueOnce(new Error("network unavailable"));
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(mocks.recordMapping).not.toHaveBeenCalled();
  });

  it("does no lookup or delivery when notifications are disabled", async () => {
    mocks.config.notificationsEnabled = false;
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(lookup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not repeat an already delivered comment", async () => {
    mocks.config.chatTaskMappings[0]!.lastActivityAt = "2026-11-15T01:00:00Z";
    lookup.mockResolvedValue(detail("blocked"));
    await poller.checkAndNotifyMappedTaskUpdates();
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves terminal lifecycle status", () => {
    expect(formatTelegramTaskStatus({ status: "done", displayStatus: "done" })).toBe("`done`");
  });
});
