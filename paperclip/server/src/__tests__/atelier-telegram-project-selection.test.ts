import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, companyMemberships, createDb, issueApprovals, issueComments, issues, projects, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";

// The live JSON configuration and Telegram API must never be touched by this suite.
const state = vi.hoisted(() => ({ config: {} as any }));
vi.mock("../services/atelier-telegram/config.js", () => ({
  getTelegramConfigSync: () => state.config,
  loadTelegramConfig: async () => state.config,
  saveTelegramConfig: vi.fn(async (updates?: any) => Object.assign(state.config, updates ?? {})),
  addTelegramLog: vi.fn(), maskToken: vi.fn(), recordChatTaskMapping: vi.fn(),
  findTaskMappingByMessageOrChat: vi.fn(), verifyAndPairUser: vi.fn(),
}));
vi.mock("../services/issue-assignment-wakeup.js", () => ({ queueIssueAssignmentWakeup: vi.fn() }));
import { AtelierTelegramTaskManager } from "../services/atelier-telegram/task-manager.js";
import { AtelierTelegramPoller } from "../services/atelier-telegram/poller.js";
import { TelegramProjectContextError } from "../services/atelier-telegram/project-context.js";
import { findTaskMappingByMessageOrChat, saveTelegramConfig } from "../services/atelier-telegram/config.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import { formatTelegramCreationStatus } from "../services/atelier-telegram/task-status.js";
import {
  buildAtelierTelegramApprovalDecisionPatch,
  materializeAtelierTelegramFinalApproval,
} from "../services/atelier-telegram/approval-gate.js";

describe("Telegram chat project selection and creation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) throw new Error("Use an isolated embedded test cluster");
    database = await startEmbeddedPostgresTestDatabase("paperclip-telegram-project-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => {
    state.config = { botToken: "", chatProjectSelections: [], userPairings: [], allowedChatIds: [], allowedUserIds: [123], allowedUsernames: [], stats: { incomingMessages: 0, tasksCreated: 0, errors: 0 } };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  async function fixture(projectCount = 2) {
    const companyId = randomUUID();
    const prefix = `P${companyId.replaceAll("-", "").toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Telegram selection test", issuePrefix: prefix });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Designer", role: "engineer", adapterType: "process" }).returning();
    const nativeProjects = await db.insert(projects).values(Array.from({ length: projectCount }, (_, i) => ({ companyId, name: `Room ${i}` }))).returning();
    const manager = new AtelierTelegramTaskManager(db, {} as any);
    vi.spyOn(manager, "getCompanyAndProject").mockResolvedValue({ companyId, companyPrefix: prefix, projectId: "" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const value = String(url);
      if (value.endsWith("/workspace")) {
        const nativeProjectId = value.split("/").at(-2)!;
        return new Response(JSON.stringify({ company_id: companyId, native_project_id: nativeProjectId, initialization_status: "ready", scenes: [
          { native_project_id: nativeProjectId, scene_id: `scene_${nativeProjectId}`, latest_revision: 7, archived: false },
        ] }));
      }
      const sceneId = value.split("/").at(-1)!;
      return new Response(JSON.stringify({ project_id: sceneId, revision: 7, rooms: [{ id: "room" }], walls: [{ id: "wall" }], pascal_scene_json: { nodes: { room: {} } } }));
    });
    vi.stubGlobal("fetch", fetch);
    const create = (chatId: number) => manager.createTaskFromTelegram({ title: "Add bench", description: "Preserve the bed and add one bench", telegramChatId: chatId, telegramUserId: 123, targetAgentId: agent.id });
    return { companyId, manager, nativeProjects, create, fetch, agent };
  }

  it("persists separate chat selections and creates tasks with fresh canonical context", async () => {
    const f = await fixture();
    await f.manager.selectProjectForChat(6556722178, f.nativeProjects[1].id);
    await f.manager.selectProjectForChat(-222, f.nativeProjects[0].id);
    expect(state.config.chatProjectSelections).toHaveLength(2);
    expect(saveTelegramConfig).toHaveBeenCalledWith(expect.objectContaining({ chatProjectSelections: expect.any(Array) }), true);
    const taskA = await f.create(6556722178);
    const taskB = await f.create(-222);
    for (const [task, project] of [[taskA, f.nativeProjects[1]], [taskB, f.nativeProjects[0]]] as const) {
      const [row] = await db.select().from(issues).where(eq(issues.id, task.issueId));
      expect(row.projectId).toBe(project.id);
      expect(row.companyId).toBe(f.companyId);
      expect(row.description).toContain(`Canonical Pascal scene/project ID: scene_${project.id}`);
      expect(row.description).toContain("Scene revision observed at task creation: 7");
      expect(row.description).toContain("base_revision");
      expect(row.description).toContain("Preserve the bed and add one bench");
      expect(row.description).toContain("Cổng duyệt nghiệm thu bắt buộc");
      expect(row.responsibleUserId).toBe("local-board");
      expect(row.originKind).toBe("chat_channel");
      expect(row.originId).toMatch(/^atelier-telegram:/);
      expect(row.executionPolicy).toMatchObject({
        mode: "normal",
        stages: [{
          type: "approval",
          approvalsNeeded: 1,
          participants: [{ type: "user", userId: "local-board" }],
        }],
      });
      expect(row.status).toBe("todo");
    }
    expect(f.fetch).toHaveBeenCalledTimes(8); // Selection and creation each validate workspace + canonical scene.
    expect(queueIssueAssignmentWakeup).toHaveBeenCalledTimes(2);
  });

  it("routes furniture layout intent ahead of unchanged lighting constraints", async () => {
    const f = await fixture(1);
    const [furniture, lighting] = await db.insert(agents).values([
      { companyId: f.companyId, name: "Furniture Planner", role: "designer", adapterType: "process", metadata: { atelierAgentKey: "agent_furniture" } },
      { companyId: f.companyId, name: "Lighting & Visualization Specialist", role: "designer", adapterType: "process", metadata: { atelierAgentKey: "agent_ceiling_lighting" } },
    ]).returning();
    const selected = await f.manager.findAgentByQuery(
      "Bố trí lại nội thất và đặt giường, tủ sát tường; giữ nguyên trần và không thay đổi chiếu sáng.",
    );
    expect(selected?.id).toBe(furniture!.id);
    expect(selected?.id).not.toBe(lighting!.id);
  });

  it("uses the normal issue service allocator for simultaneous requests", async () => {
    const f = await fixture(1);
    const created = await Promise.all([f.create(1), f.create(2), f.create(3)]);
    expect(new Set(created.map(task => task.identifier)).size).toBe(3);
    expect(created.map(task => task.executionStatus)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  it("materializes one final Approval and maps the human decision back to the task", async () => {
    const f = await fixture(1);
    const created = await f.create(6556722178);
    const [createdIssue] = await db.select().from(issues).where(eq(issues.id, created.issueId));
    const policy = createdIssue.executionPolicy as any;
    const stageId = policy.stages[0].id as string;
    const executionState = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "approval" as const,
      currentParticipant: { type: "user" as const, userId: "local-board", agentId: null },
      returnAssignee: { type: "agent" as const, agentId: f.agent.id, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
      changesRequestedCount: 0,
    };
    const reviewIssue = await issueService(db).update(created.issueId, {
      companyGuard: f.companyId,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionState,
      actorUserId: "local-board",
    });
    expect(reviewIssue).not.toBeNull();

    await db.transaction(async (tx) => {
      await materializeAtelierTelegramFinalApproval(tx as unknown as Db, reviewIssue!);
      await materializeAtelierTelegramFinalApproval(tx as unknown as Db, reviewIssue!);
    });

    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]).toMatchObject({
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: f.agent.id,
    });
    expect(approvalRows[0].payload).toMatchObject({
      kind: "atelier_telegram_final_acceptance",
      taskId: created.issueId,
      projectId: f.nativeProjects[0].id,
      summarySource: "generated_review_notice",
    });
    expect(String(approvalRows[0].payload.summary)).toContain("chờ nghiệm thu chính thức");
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approvalRows[0].id));
    expect(links).toHaveLength(1);
    expect(links[0].issueId).toBe(created.issueId);

    const approvalCreatedAt = new Date(Date.now() - 20 * 60 * 1000);
    const finalCommentCreatedAt = new Date(Date.now() - 10 * 60 * 1000);
    await db
      .update(approvals)
      .set({ createdAt: approvalCreatedAt, updatedAt: approvalCreatedAt })
      .where(eq(approvals.id, approvalRows[0].id));
    await issueService(db).addComment(
      created.issueId,
      "Final verified evidence: Scene revision 13, QA valid, walkway 762mm.",
      { agentId: f.agent.id },
      { createdAt: finalCommentCreatedAt },
    );
    const [refreshedApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalRows[0].id));
    expect(refreshedApproval.payload).toMatchObject({
      summarySource: "recent_agent_comment",
      summary: "Final verified evidence: Scene revision 13, QA valid, walkway 762mm.",
    });

    expect(buildAtelierTelegramApprovalDecisionPatch({
      issue: reviewIssue!,
      approvalId: approvalRows[0].id,
      decision: "approved",
    })).toMatchObject({
      status: "done",
      assigneeAgentId: f.agent.id,
      assigneeUserId: null,
      executionState: { status: "completed", lastDecisionOutcome: "approved" },
    });
    expect(buildAtelierTelegramApprovalDecisionPatch({
      issue: reviewIssue!,
      approvalId: approvalRows[0].id,
      decision: "revision_requested",
      decisionNote: "Điều chỉnh vị trí",
    })).toMatchObject({
      status: "in_progress",
      assigneeAgentId: f.agent.id,
      executionState: {
        status: "changes_requested",
        lastDecisionOutcome: "changes_requested",
        reviewRequest: { instructions: "Điều chỉnh vị trí" },
      },
    });

    expect(await f.manager.decideApproval({
      approvalId: approvalRows[0].id,
      decision: "approved",
      decisionNote: "Nghiệm thu đạt",
      telegramUserId: 123,
    })).toBe(true);
    const [completedIssue] = await db.select().from(issues).where(eq(issues.id, created.issueId));
    expect(completedIssue).toMatchObject({
      status: "done",
      assigneeAgentId: f.agent.id,
      assigneeUserId: null,
      executionState: {
        status: "completed",
        lastDecisionId: approvalRows[0].id,
        lastDecisionOutcome: "approved",
      },
    });
  });

  it.each(["queued", "running", "failed", null] as const)("reports the wake result truthfully: %s", async (status) => {
    const f = await fixture(1);
    vi.mocked(queueIssueAssignmentWakeup).mockResolvedValueOnce(status ? { status } : null);
    const created = await f.create(1);
    expect(created.executionStatus).toBe(status === "queued" || status === "running" ? status : "unconfirmed");
    expect(formatTelegramCreationStatus(created.executionStatus)).not.toContain("in_progress");
  });

  it("validates reply task company before insertion and keeps its original project after selection changes", async () => {
    const f = await fixture();
    await f.manager.selectProjectForChat(1, f.nativeProjects[0].id);
    const original = await f.create(1);
    await f.manager.selectProjectForChat(1, f.nativeProjects[1].id);
    const other = await fixture(1);
    const foreign = await other.create(2);
    await expect(f.manager.addCommentToTask({ issueId: foreign.issueId, comment: "Unauthorized", telegramUserId: 123 })).rejects.toThrow("not found");
    const foreignComments = await db.select().from(issueComments).where(eq(issueComments.issueId, foreign.issueId));
    expect(foreignComments).toHaveLength(1);
    await f.manager.addCommentToTask({ issueId: original.issueId, comment: "Keep original task context", telegramUserId: 123 });
    const [task] = await db.select().from(issues).where(eq(issues.id, original.issueId));
    expect(task.projectId).toBe(f.nativeProjects[0].id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, original.issueId));
    expect(comments.some(comment => comment.body.includes("Keep original task context"))).toBe(true);
  });

  it("rejects foreign/stale choices and multi-project ambiguity before any mutation", async () => {
    const f = await fixture();
    const foreignId = randomUUID();
    await db.insert(companies).values({ id: foreignId, name: "Foreign", issuePrefix: foreignId });
    const [foreign] = await db.insert(projects).values({ companyId: foreignId, name: "Foreign room" }).returning();
    expect((await f.manager.listProjects()).map(p => p.id)).not.toContain(foreign.id);
    await expect(f.manager.selectProjectForChat(1, foreign.id)).rejects.toThrow("unavailable in this company");
    await expect(f.create(1)).rejects.toThrow("Multiple native projects");
    state.config.chatProjectSelections = [{ telegramChatId: 1, companyId: foreignId, nativeProjectId: f.nativeProjects[0].id }];
    await expect(f.create(1)).rejects.toThrow("unavailable in this company");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    expect(queueIssueAssignmentWakeup).not.toHaveBeenCalled();
  });

  it("single-project fallback still requires a ready linked scene and fails closed offline", async () => {
    const f = await fixture(1);
    f.fetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(f.create(1)).rejects.toThrow("Initialize its native workspace");
    f.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(f.create(1)).rejects.toThrow("no task was created");
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(0);
    const result = await f.create(1);
    expect(result.issueId).toBeTruthy();
  });

  it("revalidates a selected workspace before creation and retains selection on failed reselection", async () => {
    const f = await fixture();
    await f.manager.selectProjectForChat(1, f.nativeProjects[0].id);
    f.fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(f.manager.selectProjectForChat(1, f.nativeProjects[1].id)).rejects.toThrow("unavailable");
    expect(state.config.chatProjectSelections[0].nativeProjectId).toBe(f.nativeProjects[0].id);
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ company_id: "foreign", native_project_id: f.nativeProjects[0].id })));
    await expect(f.create(1)).rejects.toThrow("does not match");
    expect(queueIssueAssignmentWakeup).not.toHaveBeenCalled();
  });

  it("keeps commands behind existing authorization, including commands sent as replies", async () => {
    const poller = new AtelierTelegramPoller(db) as any;
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 5 });
    poller.client = { sendMessage };
    const select = vi.fn().mockResolvedValue({ nativeProjectId: "native", sceneId: "canonical", revision: 4 });
    const list = vi.fn().mockResolvedValue([{ id: "native", companyId: "company", name: "Bedroom" }]);
    poller.taskManager = { selectProjectForChat: select, listProjects: list };
    const dispatch = (text: string, userId = 123) => poller.dispatchUpdate({ update_id: 1, message: { message_id: 3, date: 0, text, from: { id: userId }, chat: { id: 6556722178 }, reply_to_message: { message_id: 2 } } });
    await dispatch("/project native", 999);
    await dispatch("/projects", 999);
    expect(select).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    await dispatch("/project@AtelierBot native");
    expect(select).toHaveBeenCalledWith(6556722178, "native");
    await dispatch("/projects");
    expect(list).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(6556722178, expect.stringContaining("/project native"), expect.anything());
    select.mockRejectedValueOnce(new TelegramProjectContextError("Workspace unavailable; retry /project"));
    await dispatch("/project native");
    expect(sendMessage).toHaveBeenCalledWith(6556722178, "Workspace unavailable; retry /project", expect.anything());
  });

  it("passes the actual group chat ID, not the sender ID, into natural-language creation", async () => {
    const poller = new AtelierTelegramPoller(db) as any;
    poller.client = { sendMessage: vi.fn().mockResolvedValue({ message_id: 5 }), sendChatAction: vi.fn() };
    const create = vi.fn().mockRejectedValue(new TelegramProjectContextError("Select a project"));
    poller.taskManager = { findAgentByQuery: vi.fn(), getChiefArchitect: vi.fn(), createTaskFromTelegram: create };
    await poller.dispatchUpdate({ update_id: 1, message: { message_id: 3, date: 0, text: "Add exactly one bench at the foot of the bed", from: { id: 123 }, chat: { id: -456 } } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ telegramChatId: -456, telegramUserId: 123 }));
    expect(state.config.stats.tasksCreated).toBe(0);
  });

  it("keeps explicit task replies attached to their mapped task after switching projects", async () => {
    const poller = new AtelierTelegramPoller(db) as any;
    poller.client = { sendMessage: vi.fn(), sendChatAction: vi.fn() };
    const addComment = vi.fn();
    poller.taskManager = { addCommentToTask: addComment };
    state.config.chatProjectSelections = [{ telegramChatId: 10, companyId: "company", nativeProjectId: "new-project" }];
    vi.mocked(findTaskMappingByMessageOrChat).mockReturnValueOnce({ issueId: "original-task", issueIdentifier: "ATL-15", assignedAgentName: "Designer" } as any);
    await poller.dispatchUpdate({ update_id: 1, message: { message_id: 3, date: 0, text: "Keep the original bed", from: { id: 123 }, chat: { id: 10 }, reply_to_message: { message_id: 2 } } });
    expect(addComment).toHaveBeenCalledWith(expect.objectContaining({ issueId: "original-task" }));
  });

  it("uses selected-project progress for report/progress without demo geometry or estimates", async () => {
    const poller = new AtelierTelegramPoller(db) as any;
    const send = vi.fn();
    poller.client = { sendMessage: send };
    const getProjectProgress = vi.fn().mockResolvedValue({
      nativeProjectId: "bedroom-project", projectName: "Phòng ngủ Japandi",
      totalTasks: 10, doneTasks: 2, inProgressTasks: 1, inReviewTasks: 4, pendingApprovals: 3, percentDone: 20,
    });
    poller.taskManager = { getProjectProgress };
    for (const command of ["/report", "/progress"]) {
      await poller.dispatchUpdate({ update_id: 1, message: { message_id: 3, date: 0, text: command, from: { id: 123 }, chat: { id: 10 } } });
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(getProjectProgress).toHaveBeenNthCalledWith(1, 10);
    expect(getProjectProgress).toHaveBeenNthCalledWith(2, 10);
    for (const [, text] of send.mock.calls) {
      expect(text).toContain("Phòng ngủ Japandi");
      expect(text).toContain("20%");
      expect(text).not.toMatch(/4x5|4.0m|45,800,000|Phòng khách/);
    }
  });
});
