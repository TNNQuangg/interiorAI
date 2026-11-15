import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "./execute.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensureCodexSkillsInjected", () => {
  it("copies a resolved skill when the host rejects symbolic links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-codex-skill-"));
    roots.push(root);
    const source = path.join(root, "source");
    const skillsHome = path.join(root, "runtime", "skills");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    const logs: string[] = [];
    const permissionError = Object.assign(new Error("symlink privilege missing"), { code: "EPERM" });

    await ensureCodexSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      {
        skillsHome,
        skillsEntries: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source }],
        desiredSkillNames: ["paperclipai/paperclip/paperclip"],
        linkSkill: async () => {
          throw permissionError;
        },
      },
    );

    await expect(readFile(path.join(skillsHome, "paperclip", "SKILL.md"), "utf8"))
      .resolves.toBe("# Paperclip\n");
    expect(logs.join("\n")).toContain("symbolic links are unavailable");
  });
});
