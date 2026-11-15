import type { TelegramChatProjectSelection } from "./types.js";

export class TelegramProjectContextError extends Error {}

export interface TelegramNativeProject {
  id: string;
  companyId: string;
  name: string;
}

export interface TelegramProjectContext {
  companyId: string;
  nativeProjectId: string;
  sceneId: string;
  revision: number;
  workspaceUrl: string;
  sceneUrl: string;
  mcpCallUrl: string;
  furnitureLayoutUrl: string;
  sceneNodeCount: number;
}

export function chooseTelegramProject(
  companyId: string,
  projects: TelegramNativeProject[],
  selection?: TelegramChatProjectSelection,
): TelegramNativeProject {
  const scoped = projects.filter((project) => project.companyId === companyId);
  if (selection) {
    const project = scoped.find((entry) => entry.id === selection.nativeProjectId);
    if (selection.companyId !== companyId || !project) {
      throw new TelegramProjectContextError("Selected project is unavailable in this company. Use /projects then /project <native ID>.");
    }
    return project;
  }
  if (scoped.length !== 1) {
    throw new TelegramProjectContextError(scoped.length
      ? "Multiple native projects exist. Use /projects then /project <native ID> to choose for this chat."
      : "No native project exists in this company. Create and link a project, then use /projects and /project <native ID>.");
  }
  return scoped[0];
}

/** One demand-driven, bounded read; never boots a sidecar or starts a polling loop. */
export async function readTelegramProjectContext(
  project: TelegramNativeProject,
  options: { fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string } = {},
): Promise<TelegramProjectContext> {
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? process.env.ATELIER_PYTHON_CAD_API_URL ?? "http://127.0.0.1:8000");
  } catch {
    throw new TelegramProjectContextError("Python workspace API URL configuration is invalid. Repair it before selecting a project.");
  }
  // Context may be copied into agent prompts: never include URL credentials/query secrets.
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  const apiBase = base.toString().replace(/\/$/, "");
  if (!/^https?:$/.test(base.protocol) || apiBase.length > 1000) {
    throw new TelegramProjectContextError("Python workspace API URL configuration is invalid. Repair it before selecting a project.");
  }
  const workspaceUrl = `${apiBase}/api/v1/native-projects/${encodeURIComponent(project.id)}/workspace`;
  const missing = "Project has no usable linked scene. Initialize its native workspace and link the intended canonical scene via the project workspace API, then retry /project <native ID>.";
  let workspace: any;
  try {
    const response = await (options.fetch ?? fetch)(workspaceUrl, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      redirect: "error",
    });
    if (response.status === 404) throw new TelegramProjectContextError(missing);
    if (!response.ok) throw new Error(`Workspace HTTP ${response.status}`);
    workspace = await response.json();
  } catch (error) {
    if (error instanceof TelegramProjectContextError) throw error;
    throw new TelegramProjectContextError("Cannot validate project context: Python workspace API is unavailable or returned an invalid response. Restore the service and retry; no task was created.");
  }
  if (workspace?.company_id !== project.companyId || workspace?.native_project_id !== project.id) {
    throw new TelegramProjectContextError("Workspace company/project does not match the selected native project. Repair its binding before retrying /project.");
  }
  if (workspace.initialization_status !== "ready" || !Array.isArray(workspace.scenes)) {
    throw new TelegramProjectContextError(missing);
  }
  if (workspace.scenes.some((scene: any) => typeof scene?.archived !== "boolean")) {
    throw new TelegramProjectContextError(missing);
  }
  // Archived scenes are historical; multiple active scenes require an explicit repair,
  // never a guess based on array order, name, latest revision, or browser UI selection.
  const scenes = workspace.scenes.filter((scene: any) => scene?.archived === false);
  if (scenes.length > 1) {
    throw new TelegramProjectContextError("Project has multiple active linked scenes; scene context is ambiguous. Use a native project with exactly one active canonical scene, then retry /project <native ID>.");
  }
  const scene = scenes[0];
  if (!scene || scene.native_project_id !== project.id || typeof scene.scene_id !== "string"
    || !/^[A-Za-z0-9_-]{1,200}$/.test(scene.scene_id)
    || !Number.isSafeInteger(scene.latest_revision) || scene.latest_revision < 0) {
    throw new TelegramProjectContextError(missing);
  }
  const sceneUrl = `${apiBase}/api/v1/projects/${encodeURIComponent(scene.scene_id)}`;
  let canonical: any;
  try {
    const response = await (options.fetch ?? fetch)(sceneUrl, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Scene HTTP ${response.status}`);
    canonical = await response.json();
  } catch {
    throw new TelegramProjectContextError("Cannot validate canonical scene: Python scene API is unavailable or returned an invalid response. Restore the service and retry; no task was created.");
  }
  const nodeCount = canonical?.pascal_scene_json?.nodes && typeof canonical.pascal_scene_json.nodes === "object"
    ? Object.keys(canonical.pascal_scene_json.nodes).length
    : 0;
  const hasCanonicalGeometry = Array.isArray(canonical?.rooms) && canonical.rooms.length > 0
    && Array.isArray(canonical?.walls) && canonical.walls.length > 0;
  if (canonical?.project_id !== scene.scene_id || canonical?.revision !== scene.latest_revision) {
    throw new TelegramProjectContextError("Canonical scene identity/revision does not match the selected native workspace. Reload the workspace binding before creating a task.");
  }
  if (!hasCanonicalGeometry && nodeCount === 0) {
    throw new TelegramProjectContextError("Canonical scene is an empty scaffold. Initialize real room geometry before creating a design task.");
  }
  return {
    companyId: project.companyId,
    nativeProjectId: project.id,
    sceneId: scene.scene_id,
    revision: scene.latest_revision,
    workspaceUrl,
    sceneUrl,
    mcpCallUrl: `${apiBase}/api/v1/mcp/call`,
    furnitureLayoutUrl: `${sceneUrl}/furniture/layout`,
    sceneNodeCount: nodeCount,
  };
}

export function describeTelegramProjectContext(context: TelegramProjectContext): string {
  return [
    "## Authoritative Telegram project / scene context",
    `Company ID: ${context.companyId}`,
    `Native Paperclip project ID: ${context.nativeProjectId}`,
    `Canonical Pascal scene/project ID: ${context.sceneId}`,
    `Scene revision observed at task creation: ${context.revision}`,
    `Native workspace (GET): ${context.workspaceUrl}`,
    `Canonical scene (GET): ${context.sceneUrl}`,
    `Canonical Pascal node count observed: ${context.sceneNodeCount}`,
    `Bound Pascal MCP call (POST): ${context.mcpCallUrl}`,
    `Canonical furniture layout write (PATCH): ${context.furnitureLayoutUrl}`,
    "The native project ID is not the Pascal scene ID. Use the canonical scene ID for Pascal scene tools.",
    "Before work, read the workspace and canonical scene; verify the company/project/scene binding and current revision. Stop and report any missing or ambiguous binding. Never substitute the first/demo project or the browser's active scene.",
    `For Pascal MCP read/verify calls, POST ${context.mcpCallUrl} with JSON including project_id=${JSON.stringify(context.sceneId)}, expected_revision=<the revision just read>, tool_name, arguments and agent_id. The backend binds the persisted pascal_scene_json automatically. Do not call an unbound get_scene/default MCP session.`,
    `For canonical writes, use the revision-checked project API for ${context.sceneId}; MCP output alone is not persistence evidence.`,
    `To persist approved existing-furniture transforms, PATCH ${context.furnitureLayoutUrl} with base_revision, a stable idempotency_key, approval_evidence, optional minimum_clearance_mm, and moves [{id,x_mm,y_mm,rotation_deg}]. This endpoint preserves object identity/count, runs deterministic spatial QA, regenerates Pascal 2D/3D, recalculates BOQ and returns the new revision.`,
    "Before each mutation, re-read the scene and use the supported revision-checked API/tools with that current revision (base_revision where required). On revision conflict, reload and re-evaluate; never force overwrite.",
    "Preserve unrelated scene objects. Make requested additions idempotent using stable object IDs; verify persisted geometry and report the resulting scene ID/revision and evidence.",
  ].join("\n");
}
