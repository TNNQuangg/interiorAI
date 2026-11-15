import type { Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

type CreateInput = Parameters<ReturnType<typeof issueService>["create"]>[1];

/** Issue creation owns durable deduplication; execution admission stays with heartbeat. */
export async function createAtelierHandoffTask(
  db: Db,
  companyId: string,
  input: CreateInput,
  actor: { actorType: "user" | "agent"; actorId: string },
  getHeartbeat: () => IssueAssignmentWakeupDeps,
) {
  let duplicate = false;
  const task = await issueService(db).create(companyId, {
    ...input,
    onDeduplicated: (reason) => {
      duplicate = true;
      input.onDeduplicated?.(reason);
    },
  });

  // The returned relations are the persisted dependency graph, not just the
  // request's proposed blockers. Later unblocks use normal dependency wakeups.
  const unresolvedBlockers = task.blockedBy.some((blocker) => !["done", "cancelled"].includes(blocker.status));
  if (!duplicate && task.assigneeAgentId && task.status === "todo" && !unresolvedBlockers) {
    await queueIssueAssignmentWakeup({
      heartbeat: getHeartbeat(),
      issue: task,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "atelier.workflow.handoff",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      taskKey: task.identifier,
    });
  }
  return { task, duplicate };
}
