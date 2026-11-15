import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import {
  approvals,
  issueApprovals,
  issueComments,
  type Db,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "../issue-execution-policy.js";

export const ATELIER_TELEGRAM_ORIGIN_PREFIX = "atelier-telegram:";
export const ATELIER_TELEGRAM_FINAL_APPROVAL_KIND =
  "atelier_telegram_final_acceptance";

const FINAL_SUMMARY_MAX_AGE_MS = 5 * 60 * 1000;

type TelegramApprovalIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  originKind: string;
  originId: string | null;
  assigneeAgentId: string | null;
  responsibleUserId: string | null;
  executionState: unknown;
};

export function createAtelierTelegramOriginId(
  telegramChatId: number,
  nonce = randomUUID(),
) {
  return `${ATELIER_TELEGRAM_ORIGIN_PREFIX}${telegramChatId}:${nonce}`;
}

export function isAtelierTelegramApprovalIssue(
  issue: Pick<TelegramApprovalIssue, "originKind" | "originId">,
) {
  return issue.originKind === "chat_channel" &&
    issue.originId?.startsWith(ATELIER_TELEGRAM_ORIGIN_PREFIX) === true;
}

export function createAtelierTelegramApprovalPolicy(
  responsibleUserId: string,
  stageId = randomUUID(),
): Record<string, unknown> {
  const policy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: stageId,
        type: "approval",
        approvalsNeeded: 1,
        participants: [
          {
            id: randomUUID(),
            type: "user",
            userId: responsibleUserId,
            agentId: null,
          },
        ],
      },
    ],
  };
  return policy as unknown as Record<string, unknown>;
}

export const ATELIER_TELEGRAM_FINAL_APPROVAL_INSTRUCTIONS = `
## Cổng duyệt nghiệm thu bắt buộc

- Hoàn thành đầy đủ phần triển khai được giao, bao gồm Scene 2D/3D, BOQ/giá và QA có liên quan.
- Khi đã có kết quả để người dùng nghiệm thu, báo hoàn tất task theo cơ chế chuẩn. Paperclip sẽ tự chuyển task sang \`in_review\` và tạo Approval chính thức.
- Không tự bỏ qua, tự duyệt hoặc giả định rằng một tin nhắn/comment thông thường là quyết định duyệt.
- Nếu người dùng yêu cầu sửa hoặc từ chối, tiếp tục xử lý trên chính task này; không tạo task thay thế nếu không cần thiết.
- Chỉ coi công việc là \`done\` sau khi Approval chính thức được người dùng phê duyệt.
`.trim();

function pendingFinalApprovalState(issue: TelegramApprovalIssue) {
  if (!isAtelierTelegramApprovalIssue(issue)) return null;
  const state = parseIssueExecutionState(issue.executionState);
  if (
    state?.status !== "pending" ||
    state.currentStageType !== "approval" ||
    !state.currentStageId
  ) {
    return null;
  }
  return state;
}

/**
 * Materialize the generic task execution approval stage into the durable
 * Approval entity consumed by both the web Approvals page and Telegram
 * `/approvals`. The caller must pass its current transaction.
 */
export async function materializeAtelierTelegramFinalApproval(
  tx: Db,
  issue: TelegramApprovalIssue,
) {
  const state = pendingFinalApprovalState(issue);
  if (!state) return null;

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`atelier-telegram-approval:${issue.companyId}:${issue.id}:${state.currentStageId}`}, 0))`,
  );

  const latestAgentComment = await tx
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        isNotNull(issueComments.authorAgentId),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const existing = await tx
    .select({
      id: approvals.id,
      payload: approvals.payload,
      createdAt: approvals.createdAt,
    })
    .from(issueApprovals)
    .innerJoin(
      approvals,
      and(
        eq(approvals.id, issueApprovals.approvalId),
        eq(approvals.companyId, issueApprovals.companyId),
      ),
    )
    .where(
      and(
        eq(issueApprovals.companyId, issue.companyId),
        eq(issueApprovals.issueId, issue.id),
        eq(approvals.status, "pending"),
        sql`${approvals.payload}->>'kind' = ${ATELIER_TELEGRAM_FINAL_APPROVAL_KIND}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const now = Date.now();
  const commentAge = latestAgentComment
    ? now - latestAgentComment.createdAt.getTime()
    : Number.POSITIVE_INFINITY;
  const commentWasAddedAfterApproval = Boolean(
    latestAgentComment &&
      existing &&
      latestAgentComment.createdAt.getTime() >= existing.createdAt.getTime(),
  );
  const hasFreshAgentSummary =
    (commentAge >= -60_000 && commentAge <= FINAL_SUMMARY_MAX_AGE_MS) ||
    commentWasAddedAfterApproval;
  const summarySource = hasFreshAgentSummary
    ? "recent_agent_comment"
    : "generated_review_notice";
  const approvalSummary = hasFreshAgentSummary
    ? latestAgentComment!.body
    : `Task ${issue.identifier ?? issue.title} đã hoàn tất lượt thực thi kỹ thuật và đang chờ nghiệm thu chính thức. Hãy kiểm tra Scene 2D/3D, QA, BOQ/giá và revision mới nhất trên task trước khi phê duyệt.`;
  if (existing) {
    const payload = (existing.payload ?? {}) as Record<string, unknown>;
    const currentSource = payload.summarySource;
    const shouldRefreshRecentAgentSummary =
      summarySource === "recent_agent_comment" &&
      (currentSource !== "recent_agent_comment" ||
        payload.summary !== approvalSummary);
    if (!currentSource || shouldRefreshRecentAgentSummary) {
      await tx
        .update(approvals)
        .set({ payload: { ...payload, summary: approvalSummary, summarySource } })
        .where(and(eq(approvals.id, existing.id), eq(approvals.companyId, issue.companyId)));
    }
    return { id: existing.id };
  }

  const requestedByAgentId =
    state.returnAssignee?.type === "agent"
      ? state.returnAssignee.agentId ?? null
      : issue.assigneeAgentId;
  const [approval] = await tx
    .insert(approvals)
    .values({
      companyId: issue.companyId,
      type: "request_board_approval",
      requestedByAgentId,
      requestedByUserId: issue.responsibleUserId,
      status: "pending",
      payload: {
        kind: ATELIER_TELEGRAM_FINAL_APPROVAL_KIND,
        title: `Nghiệm thu ${issue.identifier ?? issue.title}`,
        taskId: issue.id,
        taskIdentifier: issue.identifier,
        projectId: issue.projectId,
        nativeProjectId: issue.projectId,
        executionStageId: state.currentStageId,
        summary: approvalSummary,
        summarySource,
      },
    })
    .returning();

  await tx.insert(issueApprovals).values({
    companyId: issue.companyId,
    issueId: issue.id,
    approvalId: approval.id,
    linkedByAgentId: requestedByAgentId,
    linkedByUserId: requestedByAgentId ? null : issue.responsibleUserId,
  });
  return { id: approval.id };
}

export type AtelierTelegramApprovalDecision =
  | "approved"
  | "rejected"
  | "revision_requested";

export function buildAtelierTelegramApprovalDecisionPatch(input: {
  issue: TelegramApprovalIssue;
  approvalId: string;
  decision: AtelierTelegramApprovalDecision;
  decisionNote?: string | null;
}): {
  status: "done" | "in_progress";
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: Record<string, unknown>;
} | null {
  const state = pendingFinalApprovalState(input.issue);
  if (!state) return null;

  const returnAgentId =
    state.returnAssignee?.type === "agent"
      ? state.returnAssignee.agentId ?? null
      : input.issue.assigneeAgentId;

  if (input.decision === "approved") {
    const executionState: IssueExecutionState = {
      ...state,
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      reviewRequest: null,
      completedStageIds: [
        ...new Set([...state.completedStageIds, state.currentStageId!]),
      ],
      lastDecisionId: input.approvalId,
      lastDecisionOutcome: "approved",
      changesRequestedCount: 0,
    };
    return {
      status: "done",
      assigneeAgentId: returnAgentId,
      assigneeUserId: null,
      executionState: executionState as unknown as Record<string, unknown>,
    };
  }

  const executionState: IssueExecutionState = {
    ...state,
    status: "changes_requested",
    currentParticipant: state.currentParticipant,
    reviewRequest: input.decisionNote?.trim()
      ? { instructions: input.decisionNote.trim() }
      : null,
    lastDecisionId: input.approvalId,
    lastDecisionOutcome: "changes_requested",
    changesRequestedCount: 0,
  };
  return {
    status: "in_progress",
    assigneeAgentId: returnAgentId,
    assigneeUserId: null,
    executionState: executionState as unknown as Record<string, unknown>,
  };
}
