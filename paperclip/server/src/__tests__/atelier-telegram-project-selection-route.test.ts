import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  select: vi.fn(), company: vi.fn(), restart: vi.fn(), log: vi.fn(),
  config: { allowedChatIds: [6556722178] },
}));
vi.mock("../services/atelier-telegram/index.js", () => ({
  getTelegramTaskManager: () => ({ getCompanyAndProject: mocks.company, selectProjectForChat: mocks.select }),
  getTelegramPoller: () => ({ restart: mocks.restart }),
  initTelegramBridge: vi.fn().mockResolvedValue(undefined), loadTelegramConfig: vi.fn(),
  getTelegramConfigSync: () => mocks.config, saveTelegramConfig: vi.fn(),
  generatePairingCode: vi.fn(), unpairTelegramUser: vi.fn(), getTelegramLogs: vi.fn(), addTelegramLog: vi.fn(),
  TelegramBotClient: vi.fn(),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.log }));
import { atelierTelegramRoutes } from "../routes/atelier-telegram.js";
import { TelegramProjectContextError } from "../services/atelier-telegram/project-context.js";

function app(actor: any) {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api/atelier/telegram", atelierTelegramRoutes({} as Db));
  result.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  return result;
}

describe("board Telegram project configuration", () => {
  const payload = { chatId: 6556722178, nativeProjectId: "eb654960-2510-46d6-ade9-ea68a70bf64f" };
  const board = { type: "board", userId: "board-user", source: "session", companyIds: ["company-a"] };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.company.mockResolvedValue({ companyId: "company-a" });
    mocks.select.mockResolvedValue({ companyId: "company-a", nativeProjectId: payload.nativeProjectId, sceneId: "proj_bedroom_japandi_4x4m", revision: 12 });
  });

  it("configures a permitted chat without restarting the bot or sending Telegram updates", async () => {
    const response = await request(app(board)).post("/api/atelier/telegram/project-selection").send(payload);
    expect(response.status).toBe(200);
    expect(response.body.context.sceneId).toBe("proj_bedroom_japandi_4x4m");
    expect(mocks.select).toHaveBeenCalledWith(payload.chatId, payload.nativeProjectId);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId: "company-a", action: "telegram.project_selected" }));
  });

  it.each([{ type: "none" }, { type: "agent", companyId: "company-a" }, { ...board, companyIds: ["foreign"] }])("rejects unauthorized actor %j", async (actor) => {
    const response = await request(app(actor)).post("/api/atelier/telegram/project-selection").send(payload);
    expect(response.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("requires an already authorized chat and validates input before selection", async () => {
    expect((await request(app(board)).post("/api/atelier/telegram/project-selection").send({ ...payload, chatId: 999 })).status).toBe(403);
    expect((await request(app(board)).post("/api/atelier/telegram/project-selection").send({ ...payload, chatId: "6556722178" })).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("returns actionable context validation failure without restarting", async () => {
    mocks.select.mockRejectedValueOnce(new TelegramProjectContextError("Workspace unavailable; retry /project"));
    const response = await request(app(board)).post("/api/atelier/telegram/project-selection").send(payload);
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("Workspace unavailable");
    expect(mocks.restart).not.toHaveBeenCalled();
  });
});
