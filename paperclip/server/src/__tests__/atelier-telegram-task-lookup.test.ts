import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions,
  issues, projects, startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { AtelierTelegramTaskManager } from "../services/atelier-telegram/task-manager.js";

// These tests own a disposable cluster; they never use the application's DB.
describe("Telegram exact company-scoped task reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;

  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) {
      throw new Error("Telegram regressions require an isolated embedded cluster, not an external admin URL");
    }
    database = await startEmbeddedPostgresTestDatabase("paperclip-telegram-lookup-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const prefix = `T${companyId.replaceAll("-", "").toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Telegram regression", issuePrefix: prefix });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Designer", role: "engineer", adapterType: "process" });
    const manager = new AtelierTelegramTaskManager(db);
    vi.spyOn(manager, "getCompanyAndProject").mockResolvedValue({ companyId, projectId: "", companyPrefix: prefix });
    async function task(number: number, overrides: Partial<typeof issues.$inferInsert> = {}) {
      const [row] = await db.insert(issues).values({
        companyId, title: `Task ${number}`, identifier: `${prefix}-${number}`,
        issueNumber: number, status: "in_progress", assigneeAgentId: agentId, ...overrides,
      }).returning();
      return row!;
    }
    return { companyId, prefix, agentId, manager, task };
  }

  it("resolves a UUID ending in digits before a colliding issue number", async () => {
    const f = await fixture();
    const decoy = await f.task(1);
    const target = await f.task(15, { id: `${randomUUID().slice(0, 24)}000000000001` });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: target.id, body: "Correct task evidence" });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: decoy.id, body: "Wrong task evidence" });
    const result = await f.manager.getTaskByIdentifierOrId(` ${target.id.toUpperCase()} `);
    expect(result?.issue.id).toBe(target.id);
    expect(result?.comments.map(comment => comment.body)).toEqual(["Correct task evidence"]);
    expect(result?.assignedAgentName).toBe("Designer");
  });

  it("accepts exact full identifiers and bare numbers within the resolved company", async () => {
    const foreign = await fixture();
    await foreign.task(7);
    const f = await fixture();
    const target = await f.task(7);
    for (const input of [` ${target.identifier!.toLowerCase()} `, "7"]) {
      expect((await f.manager.getTaskByIdentifierOrId(input))?.issue.id).toBe(target.id);
    }
  });

  it("never falls back from foreign or missing UUIDs/identifiers to a local numeric suffix", async () => {
    const foreign = await fixture();
    const foreignTask = await foreign.task(1, { id: `${randomUUID().slice(0, 24)}000000000001` });
    const f = await fixture();
    await f.task(1);
    for (const input of [foreignTask.id, foreignTask.identifier!, "MISSING-1", `${randomUUID().slice(0, 24)}000000000001`]) {
      expect(await f.manager.getTaskByIdentifierOrId(input)).toBeNull();
    }
  });

  it("rejects malformed and overflowing inputs without issuing any database query", async () => {
    const f = await fixture();
    const select = vi.spyOn(db, "select");
    for (const input of ["", " ", "0", "-1", "1.0", "1e0", "0001", "junk1", "task ATL-1", "ATL-1 extra", "ATL--1", "not-a-uuid-000000000001", "2147483648", "999999999999999999999"]) {
      expect(await f.manager.getTaskByIdentifierOrId(input)).toBeNull();
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("does not suppress genuine database failures as invalid identifiers", async () => {
    const f = await fixture();
    vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(f.manager.getTaskByIdentifierOrId(randomUUID())).rejects.toThrow("database unavailable");
  });

  it("rejects a foreign cancellation target without changing either task", async () => {
    const foreign = await fixture();
    const foreignTask = await foreign.task(1);
    const f = await fixture();
    const localTask = await f.task(1);
    const update = vi.spyOn(db, "update");
    expect(await f.manager.cancelTask(foreignTask.identifier!, 123)).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect((await f.manager.getTaskByIdentifierOrId(localTask.id))?.issue.status).toBe("in_progress");
  });

  it("uses execution display state consistently in details, lists and progress without lifecycle writes", async () => {
    const f = await fixture();
    const stopped = await f.task(1);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: stopped.id, status: "succeeded" });
    const recovery = await f.task(2);
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: recovery.id,
      kind: "source", ownerType: "board", cause: "process_lost", fingerprint: randomUUID(), nextAction: "Inspect" });
    const waiting = await f.task(3, { executionState: { status: "pending", currentStageId: "review", currentStageType: "review",
      currentParticipant: { type: "user", userId: "reviewer" } } });
    const nextCheckAt = new Date(Date.now() + 60_000);
    const monitoring = await f.task(4, { monitorNextCheckAt: nextCheckAt,
      executionPolicy: { mode: "normal", stages: [], commentRequired: false, monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check" } } });
    const running = await f.task(5);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: running.id, status: "running" });
    const blocked = await f.task(6, { status: "blocked" });
    const done = await f.task(7, { status: "done" });
    const foreign = await fixture();
    const other = await foreign.task(1);
    await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId, issueId: other.id, status: "running" });

    const expected = [[stopped, "todo"], [recovery, "blocked"], [waiting, "in_review"], [monitoring, "monitoring"], [running, "in_progress"], [blocked, "blocked"], [done, "done"]] as const;
    const update = vi.spyOn(db, "update");
    for (const [task, displayStatus] of expected) {
      expect((await f.manager.getTaskByIdentifierOrId(task.id))?.issue).toMatchObject({ status: task.status, displayStatus });
    }
    const active = await f.manager.listActiveTasks();
    expect(active).toHaveLength(6);
    for (const [task, displayStatus] of expected.slice(0, 6)) {
      expect(active.find(row => row.id === task.id)).toMatchObject({ status: task.status, displayStatus });
    }
    expect(await f.manager.getProjectProgress()).toEqual({ nativeProjectId: null, projectName: null, totalTasks: 7, doneTasks: 1, inProgressTasks: 1, inReviewTasks: 1, pendingApprovals: 0, percentDone: 14 });
    expect(update).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, stopped.id)))[0]?.status).toBe("in_progress");
  });

  it("scopes progress and active task lists to the project selected by this chat", async () => {
    const f = await fixture();
    const selectedProjectId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(projects).values([
      { id: selectedProjectId, companyId: f.companyId, name: "Selected bedroom" },
      { id: otherProjectId, companyId: f.companyId, name: "Other project" },
    ]);
    await f.task(1, { projectId: selectedProjectId, status: "done" });
    await f.task(2, { projectId: selectedProjectId, status: "done" });
    await f.task(3, { projectId: selectedProjectId, status: "todo" });
    await f.task(4, { projectId: otherProjectId, status: "todo" });
    await f.task(5, { projectId: selectedProjectId, status: "cancelled" });
    vi.spyOn(f.manager, "resolveProjectContext").mockResolvedValue({
      companyId: f.companyId, companyPrefix: f.prefix, nativeProjectId: selectedProjectId,
      sceneId: "scene-selected", revision: 2, workspaceUrl: "http://workspace", sceneUrl: "http://scene",
    });
    vi.spyOn(f.manager, "listProjects").mockResolvedValue([
      { id: selectedProjectId, name: "Selected bedroom", companyId: f.companyId },
      { id: otherProjectId, name: "Other project", companyId: f.companyId },
    ]);

    expect(await f.manager.getProjectProgress(6556722178)).toEqual({
      nativeProjectId: selectedProjectId, projectName: "Selected bedroom",
      totalTasks: 3, doneTasks: 2, inProgressTasks: 0, inReviewTasks: 0, pendingApprovals: 0, percentDone: 67,
    });
    expect((await f.manager.listActiveTasks(10, 6556722178)).map(task => task.identifier)).toEqual([`${f.prefix}-3`]);
  });
});
