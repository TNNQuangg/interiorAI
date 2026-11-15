import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ directory: "", failWrites: false }));
// Redirect only this module's config I/O to a disposable real directory. Never read
// or write the checked-out bridge's credentials, selection, counters or pairings.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { default: {
    readFile: () => actual.readFile(path.join(storage.directory, "config.json"), "utf8"),
    mkdir: () => actual.mkdir(storage.directory, { recursive: true }),
    writeFile: (file: string, data: string) => {
      if (storage.failWrites) return Promise.reject(new Error("Storage unavailable"));
      return actual.writeFile(path.join(storage.directory, file.endsWith(".tmp") ? "config.json.tmp" : "config.json"), data, "utf8");
    },
    rename: () => actual.rename(path.join(storage.directory, "config.json.tmp"), path.join(storage.directory, "config.json")),
  } };
});

describe("Telegram project selection configuration persistence", () => {
  let actual: typeof fs;
  beforeAll(async () => {
    actual = await vi.importActual("node:fs/promises");
    storage.directory = await actual.mkdtemp(path.join(os.tmpdir(), "telegram-project-config-"));
  });
  afterAll(async () => {
    if (storage.directory.startsWith(path.join(os.tmpdir(), "telegram-project-config-"))) {
      await actual.rm(storage.directory, { recursive: true, force: true });
    }
  });

  it("loads older configuration, persists selection and reloads it without changing authorization", async () => {
    await actual.writeFile(path.join(storage.directory, "config.json"), JSON.stringify({ allowedUserIds: [123], allowedChatIds: [-789] }));
    let config = await import("./config.js");
    expect((await config.loadTelegramConfig()).chatProjectSelections).toEqual([]);
    const selection = { telegramChatId: 6556722178, companyId: "company-a", nativeProjectId: "eb654960-2510-46d6-ade9-ea68a70bf64f" };
    await config.saveTelegramConfig({ chatProjectSelections: [selection] }, true);
    vi.resetModules();
    config = await import("./config.js");
    const reloaded = await config.loadTelegramConfig();
    expect(reloaded.chatProjectSelections).toEqual([selection]);
    expect(reloaded.allowedUserIds).toEqual([123]);
    expect(reloaded.allowedChatIds).toEqual([-789]);
    // A simultaneous checkpoint and selection write must preserve both fields.
    await Promise.all([
      config.saveTelegramConfig({ lastUpdateId: 25 }),
      config.saveTelegramConfig({ chatProjectSelections: [selection, { ...selection, telegramChatId: -222 }] }, true),
    ]);
    const concurrent = JSON.parse(await actual.readFile(path.join(storage.directory, "config.json"), "utf8"));
    expect(concurrent.lastUpdateId).toBe(25);
    expect(concurrent.chatProjectSelections).toHaveLength(2);
    await config.saveTelegramConfig({ chatProjectSelections: [selection] }, true);
    storage.failWrites = true;
    await expect(config.saveTelegramConfig({ chatProjectSelections: [] }, true)).rejects.toThrow("Could not persist");
    expect(config.getTelegramConfigSync().chatProjectSelections).toEqual([selection]);
    expect(JSON.parse(await actual.readFile(path.join(storage.directory, "config.json"), "utf8")).chatProjectSelections).toEqual([selection]);
  });
});
