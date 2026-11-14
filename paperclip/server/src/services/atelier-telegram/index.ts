import type { Db } from "@paperclipai/db";
import { AtelierTelegramPoller } from "./poller.js";
import { AtelierTelegramTaskManager } from "./task-manager.js";
import { loadTelegramConfig } from "./config.js";
import type { IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";

let pollerInstance: AtelierTelegramPoller | null = null;
let taskManagerInstance: AtelierTelegramTaskManager | null = null;

export async function initTelegramBridge(
  db: Db,
  heartbeat?: IssueAssignmentWakeupDeps,
): Promise<{ poller: AtelierTelegramPoller; taskManager: AtelierTelegramTaskManager }> {
  await loadTelegramConfig();

  if (!pollerInstance) {
    pollerInstance = new AtelierTelegramPoller(db, heartbeat);
    taskManagerInstance = new AtelierTelegramTaskManager(db, heartbeat);

    // Auto-start polling if token is configured
    pollerInstance.start().catch((err) => {
      console.warn("[ATELIER Telegram] Initial poller start warning:", err.message || err);
    });
  }

  return {
    poller: pollerInstance,
    taskManager: taskManagerInstance!,
  };
}

export function getTelegramPoller(): AtelierTelegramPoller | null {
  return pollerInstance;
}

export function getTelegramTaskManager(): AtelierTelegramTaskManager | null {
  return taskManagerInstance;
}

export * from "./types.js";
export * from "./config.js";
export * from "./telegram-client.js";
export * from "./task-manager.js";
export * from "./poller.js";
