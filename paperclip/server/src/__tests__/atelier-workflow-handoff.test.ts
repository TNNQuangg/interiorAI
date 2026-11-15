import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns, issues,
  startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { createAtelierHandoffTask } from "../services/atelier-workflow-handoff.js";

describe("legacy Atelier handoff assignment wake", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) throw new Error("An isolated embedded cluster is required");
    database = await startEmbeddedPostgresTestDatabase("paperclip-atelier-handoff-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(sourceStatus = "done") {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const parentUserId = `parent-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Handoff test", issuePrefix: `T${companyId.replaceAll("-", "").toUpperCase()}` });
    await db.insert(companyMemberships).values([userId, parentUserId].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "owner" })));
    const sourceAgentId = randomUUID();
    const targetAgentId = randomUUID();
    await db.insert(agents).values([sourceAgentId, targetAgentId].map(id => ({ id, companyId, name: id, role: "engineer", adapterType: "process" })));
    const [source] = await db.insert(issues).values({ companyId, title: "Source", status: sourceStatus,
      assigneeAgentId: sourceAgentId, responsibleUserId: parentUserId }).returning();
    const input = {
      title: "Design bedroom bench", description: "Apply the confirmed design", status: "todo",
      parentId: source!.id, parentDepthPolicy: "allow_nested" as const, expectedParentId: source!.id,
      assigneeAgentId: targetAgentId, createdByUserId: userId, actorResponsibleUserId: userId,
      blockedByIssueIds: ["done", "cancelled"].includes(sourceStatus) ? [] : [source!.id],
      idempotencyKey: `handoff-${randomUUID()}`, allowDuplicate: false,
    };
    const wakeup = vi.fn().mockResolvedValue({ status: "queued" });
    const getHeartbeat = vi.fn(() => ({ wakeup }));
    const actor = { actorType: "user" as const, actorId: userId };
    const create = (overrides: Partial<typeof input> = {}) => createAtelierHandoffTask(db, companyId, { ...input, ...overrides }, actor, getHeartbeat);
    return { companyId, userId, parentUserId, sourceAgentId, targetAgentId, source: source!, input, actor, create, wakeup, getHeartbeat };
  }

  it.each(["done", "cancelled"])("queues newly created ready work after a %s source with board sponsorship", async (status) => {
    const f = await fixture(status);
    const result = await f.create();
    expect(result.duplicate).toBe(false);
    expect(result.task.responsibleUserId).toBe(f.userId);
    expect(result.task.blockedBy).toEqual([]);
    expect(f.wakeup).toHaveBeenCalledExactlyOnceWith(f.targetAgentId, expect.objectContaining({
      source: "assignment", reason: "issue_assigned", requestedByActorType: "user", requestedByActorId: f.userId,
      payload: expect.objectContaining({ issueId: result.task.id, mutation: "create" }),
      contextSnapshot: expect.objectContaining({ issueId: result.task.id, source: "atelier.workflow.handoff" }),
    }));
  });

  it.each(["in_progress", "blocked", "in_review"])("retains an unresolved %s dependency without creating heartbeat work", async (status) => {
    const f = await fixture(status);
    const result = await f.create();
    expect(result.task.blockedBy).toEqual([expect.objectContaining({ id: f.source.id, status })]);
    expect(f.getHeartbeat).not.toHaveBeenCalled();
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("checks the persisted blockers even when the source was completed", async () => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Await approval", status: "blocked" }).returning();
    await f.create({ blockedByIssueIds: [blocker!.id] });
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("queues only once for concurrent idempotent requests and later retries", async () => {
    const f = await fixture();
    const results = await Promise.all([f.create(), f.create()]);
    expect(results[0].task.id).toBe(results[1].task.id);
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
    expect((await f.create()).duplicate).toBe(true);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not wake a task reused by the recent-title deduplication policy", async () => {
    const f = await fixture();
    const first = await f.create();
    const duplicate = await f.create({ idempotencyKey: randomUUID() });
    expect(duplicate).toMatchObject({ duplicate: true, task: { id: first.task.id } });
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });

  it("inherits an agent caller's run sponsor through the normal issue service", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.sourceAgentId,
      issueId: f.source.id, responsibleUserId: f.userId, status: "running" }).returning();
    const result = await createAtelierHandoffTask(db, f.companyId, {
      ...f.input, createdByUserId: null, createdByAgentId: f.sourceAgentId,
      actorResponsibleUserId: null, actorRunId: run!.id,
    }, { actorType: "agent", actorId: f.sourceAgentId }, f.getHeartbeat);
    expect(result.task.responsibleUserId).toBe(f.userId);
    expect(result.task.responsibleUserId).not.toBe(f.parentUserId);
    expect(f.wakeup).toHaveBeenCalledWith(f.targetAgentId, expect.objectContaining({ requestedByActorType: "agent", requestedByActorId: f.sourceAgentId }));
  });

  it.each(["backlog", "blocked", "done", "cancelled"])("does not enqueue newly created %s records", async (status) => {
    const f = await fixture();
    await f.create({ status });
    expect(f.wakeup).not.toHaveBeenCalled();
  });

  it("does not enqueue when creation fails", async () => {
    const f = await fixture();
    await expect(f.create({ assigneeAgentId: randomUUID() })).rejects.toThrow();
    expect(f.wakeup).not.toHaveBeenCalled();
  });
});
