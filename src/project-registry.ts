import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "./config";
import type { ChatGptTurnEnvironment } from "./adapters/chatgpt-web/environment";

export const MAX_PROJECTS = 256;
export const MAX_PROJECT_THREADS = 64;
export const PROJECT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
export const PROJECT_CONTINUITY_MAX_CHARS = 4_000;
export const PROJECT_CONTINUITY_MAX_TOKENS = 1_000;
export const MAX_DECISIONS_COUNT = 32;
export const MAX_CONVENTIONS_COUNT = 32;
export const MAX_ACTIVE_TASKS_COUNT = 32;
export const MAX_ENTRY_STRING_LENGTH = 1_000;
export const MAX_SUMMARY_LENGTH = 20_000;

export interface ProjectSemanticState {
  summary?: string;
  keyDecisions?: string[];
  conventions?: string[];
  activeTasks?: string[];
  updatedAt: number;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  rootPath: string;
  workspaceRoots: string[];
  threadIds: string[];
  createdAt: number;
  updatedAt: number;
  semanticState?: ProjectSemanticState;
}

export interface StoredProjectRegistryFile {
  version: 1;
  projects: Record<string, ProjectRecord>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function containsPath(root: string, targetPath: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function derivePrimaryProjectRoot(cwd: string, roots: string[]): string {
  const normalizedCwd = resolve(cwd);
  for (const root of roots) {
    const normalizedRoot = resolve(root);
    if (containsPath(normalizedRoot, normalizedCwd)) {
      return normalizedRoot;
    }
  }
  return roots.length > 0 ? resolve(roots[0]!) : normalizedCwd;
}

export function computeProjectId(rootPath: string): string {
  const normalized = pathIdentity(rootPath);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `proj_${hash}`;
}

function validateStringArray(value: unknown, maxItems: number, maxLength: number, field: string): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        result.push(trimmed.slice(0, maxLength));
      }
    }
    if (result.length >= maxItems) break;
  }
  return result;
}

function validateSemanticState(value: unknown): ProjectSemanticState | undefined {
  const parsed = record(value);
  if (!parsed || typeof parsed.updatedAt !== "number") return undefined;
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
    : undefined;
  const keyDecisions = validateStringArray(parsed.keyDecisions, MAX_DECISIONS_COUNT, MAX_ENTRY_STRING_LENGTH, "keyDecisions");
  const conventions = validateStringArray(parsed.conventions, MAX_CONVENTIONS_COUNT, MAX_ENTRY_STRING_LENGTH, "conventions");
  const activeTasks = validateStringArray(parsed.activeTasks, MAX_ACTIVE_TASKS_COUNT, MAX_ENTRY_STRING_LENGTH, "activeTasks");
  return {
    ...(summary ? { summary } : {}),
    ...(keyDecisions.length > 0 ? { keyDecisions } : {}),
    ...(conventions.length > 0 ? { conventions } : {}),
    ...(activeTasks.length > 0 ? { activeTasks } : {}),
    updatedAt: parsed.updatedAt,
  };
}

function validateStoredProject(value: unknown): ProjectRecord | undefined {
  const parsed = record(value);
  if (!parsed
    || typeof parsed.projectId !== "string"
    || !parsed.projectId.startsWith("proj_")
    || typeof parsed.name !== "string"
    || typeof parsed.rootPath !== "string"
    || !isAbsolute(parsed.rootPath)
    || !Array.isArray(parsed.workspaceRoots)
    || typeof parsed.createdAt !== "number"
    || typeof parsed.updatedAt !== "number") {
    return undefined;
  }
  const workspaceRoots = parsed.workspaceRoots
    .filter((r): r is string => typeof r === "string" && isAbsolute(r))
    .map(r => resolve(r));
  if (workspaceRoots.length === 0) return undefined;
  const threadIds = Array.isArray(parsed.threadIds)
    ? parsed.threadIds.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(-MAX_PROJECT_THREADS)
    : [];
  const semanticState = validateSemanticState(parsed.semanticState);
  return {
    projectId: parsed.projectId,
    name: parsed.name.slice(0, 128),
    rootPath: resolve(parsed.rootPath),
    workspaceRoots,
    threadIds,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    ...(semanticState ? { semanticState } : {}),
  };
}

export class ProjectRegistry {
  private loaded = false;
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly threadToProject = new Map<string, string>();

  constructor(
    readonly statePath?: string,
    private readonly now: () => number = Date.now,
  ) {}

  resolveProject(environment: ChatGptTurnEnvironment, threadId?: string): ProjectRecord {
    this.load();
    this.prune();
    const primaryRoot = derivePrimaryProjectRoot(environment.cwd, environment.roots);
    const projectId = computeProjectId(primaryRoot);
    const existing = this.projects.get(projectId);
    const nowTimestamp = this.now();

    if (existing) {
      // Validate workspace affinity to prevent disjoint workspace contamination
      const envRoots = environment.roots.map(r => resolve(r));
      const hasOverlap = envRoots.some(r =>
        existing.workspaceRoots.some(existingRoot =>
          containsPath(existingRoot, r) || containsPath(r, existingRoot),
        ),
      );
      if (!hasOverlap) {
        throw new Error(`Environment workspace roots conflict with existing project ${existing.projectId}`);
      }

      existing.updatedAt = nowTimestamp;
      // Add any new roots if valid
      for (const root of envRoots) {
        if (!existing.workspaceRoots.some(r => pathIdentity(r) === pathIdentity(root))) {
          existing.workspaceRoots.push(root);
        }
      }
      if (threadId) {
        const cleanThreadId = threadId.trim();
        if (cleanThreadId && !existing.threadIds.includes(cleanThreadId)) {
          existing.threadIds.push(cleanThreadId);
          if (existing.threadIds.length > MAX_PROJECT_THREADS) {
            const evictedThreadId = existing.threadIds.shift();
            if (evictedThreadId) this.threadToProject.delete(evictedThreadId);
          }
        }
        if (cleanThreadId) {
          this.threadToProject.set(cleanThreadId, projectId);
        }
      }
      this.persist();
      return structuredClone(existing);
    }

    const name = basename(primaryRoot) || "workspace";
    const newRecord: ProjectRecord = {
      projectId,
      name,
      rootPath: primaryRoot,
      workspaceRoots: environment.roots.map(r => resolve(r)),
      threadIds: threadId && threadId.trim() ? [threadId.trim()] : [],
      createdAt: nowTimestamp,
      updatedAt: nowTimestamp,
    };
    this.projects.set(projectId, newRecord);
    if (threadId && threadId.trim()) {
      this.threadToProject.set(threadId.trim(), projectId);
    }
    this.prune();
    this.persist();
    return structuredClone(newRecord);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    this.load();
    this.prune();
    const record = this.projects.get(projectId);
    return record ? structuredClone(record) : undefined;
  }

  getProjectForThread(threadId: string): ProjectRecord | undefined {
    this.load();
    this.prune();
    const cleanThreadId = threadId.trim();
    if (!cleanThreadId) return undefined;
    const projectId = this.threadToProject.get(cleanThreadId);
    if (!projectId) return undefined;
    const record = this.projects.get(projectId);
    return record ? structuredClone(record) : undefined;
  }

  linkThreadToParent(childThreadId: string, parentThreadId: string): ProjectRecord | undefined {
    this.load();
    this.prune();
    const cleanChild = childThreadId.trim();
    const cleanParent = parentThreadId.trim();
    if (!cleanChild || !cleanParent) return undefined;
    const parentProject = this.getProjectForThread(cleanParent);
    if (!parentProject) return undefined;
    const record = this.projects.get(parentProject.projectId);
    if (!record) return undefined;
    if (!record.threadIds.includes(cleanChild)) {
      record.threadIds.push(cleanChild);
      if (record.threadIds.length > MAX_PROJECT_THREADS) {
        const evictedThreadId = record.threadIds.shift();
        if (evictedThreadId) this.threadToProject.delete(evictedThreadId);
      }
    }
    record.updatedAt = this.now();
    this.threadToProject.set(cleanChild, record.projectId);
    this.persist();
    return structuredClone(record);
  }

  updateSemanticState(projectId: string, patch: Partial<ProjectSemanticState>): ProjectRecord {
    this.load();
    const record = this.projects.get(projectId);
    if (!record) {
      throw new Error(`Project not found in registry: ${projectId}`);
    }
    const current = record.semanticState ?? { updatedAt: this.now() };
    const nowTimestamp = this.now();
    const summary = patch.summary !== undefined
      ? (patch.summary.trim() ? patch.summary.trim().slice(0, MAX_SUMMARY_LENGTH) : undefined)
      : current.summary;
    const keyDecisions = patch.keyDecisions !== undefined
      ? validateStringArray(patch.keyDecisions, MAX_DECISIONS_COUNT, MAX_ENTRY_STRING_LENGTH, "keyDecisions")
      : current.keyDecisions;
    const conventions = patch.conventions !== undefined
      ? validateStringArray(patch.conventions, MAX_CONVENTIONS_COUNT, MAX_ENTRY_STRING_LENGTH, "conventions")
      : current.conventions;
    const activeTasks = patch.activeTasks !== undefined
      ? validateStringArray(patch.activeTasks, MAX_ACTIVE_TASKS_COUNT, MAX_ENTRY_STRING_LENGTH, "activeTasks")
      : current.activeTasks;

    record.semanticState = {
      ...(summary ? { summary } : {}),
      ...(keyDecisions && keyDecisions.length > 0 ? { keyDecisions } : {}),
      ...(conventions && conventions.length > 0 ? { conventions } : {}),
      ...(activeTasks && activeTasks.length > 0 ? { activeTasks } : {}),
      updatedAt: nowTimestamp,
    };
    record.updatedAt = nowTimestamp;
    this.persist();
    return structuredClone(record);
  }

  getProjectContinuityContext(projectId: string): string | undefined {
    this.load();
    const record = this.projects.get(projectId);
    if (!record || !record.semanticState) return undefined;
    const state = record.semanticState;
    const parts: string[] = [];
    parts.push(`[Project Continuity: ${record.name}]`);
    parts.push("Verified cross-thread semantic project continuity for this workspace:");
    if (state.summary) {
      parts.push(`- Summary: ${state.summary}`);
    }
    if (state.keyDecisions && state.keyDecisions.length > 0) {
      parts.push("- Key Decisions:");
      for (const decision of state.keyDecisions) {
        parts.push(`  * ${decision}`);
      }
    }
    if (state.conventions && state.conventions.length > 0) {
      parts.push("- Project Conventions:");
      for (const convention of state.conventions) {
        parts.push(`  * ${convention}`);
      }
    }
    if (state.activeTasks && state.activeTasks.length > 0) {
      parts.push("- Active Workstream:");
      for (const task of state.activeTasks) {
        parts.push(`  * ${task}`);
      }
    }
    if (parts.length <= 2) return undefined;
    const combined = parts.join("\n");
    if (combined.length <= PROJECT_CONTINUITY_MAX_CHARS) {
      return combined;
    }
    return `${combined.slice(0, PROJECT_CONTINUITY_MAX_CHARS - 16)}...[truncated]`;
  }

  inspect(): { ok: boolean; count: number; activeThreads: number; path?: string; error?: string } {
    try {
      this.load();
      return {
        ok: true,
        count: this.projects.size,
        activeThreads: this.threadToProject.size,
        ...(this.statePath ? { path: this.statePath } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        count: 0,
        activeThreads: 0,
        ...(this.statePath ? { path: this.statePath } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  clear(): void {
    this.projects.clear();
    this.threadToProject.clear();
    this.persist();
  }

  private prune(): void {
    const cutoff = this.now() - PROJECT_TTL_MS;
    for (const [id, project] of this.projects) {
      if (project.updatedAt < cutoff) {
        this.projects.delete(id);
        for (const threadId of project.threadIds) {
          this.threadToProject.delete(threadId);
        }
      }
    }
    while (this.projects.size > MAX_PROJECTS) {
      let oldestId: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [id, project] of this.projects) {
        if (project.updatedAt < oldestTime) {
          oldestTime = project.updatedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      const project = this.projects.get(oldestId);
      if (project) {
        for (const threadId of project.threadIds) {
          this.threadToProject.delete(threadId);
        }
      }
      this.projects.delete(oldestId);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredProjectRegistryFile>;
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== "object") {
        console.warn(`[project-registry] invalid version or shape in ${this.statePath}, recovering cleanly`);
        return;
      }
      const cutoff = this.now() - PROJECT_TTL_MS;
      for (const [id, value] of Object.entries(parsed.projects)) {
        const validated = validateStoredProject(value);
        if (validated && validated.updatedAt >= cutoff) {
          this.projects.set(id, validated);
          for (const threadId of validated.threadIds) {
            this.threadToProject.set(threadId, id);
          }
        }
      }
    } catch (error) {
      console.warn(`[project-registry] failed to read ${this.statePath}: ${error instanceof Error ? error.message : String(error)}, initializing clean registry`);
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      const payload: StoredProjectRegistryFile = {
        version: 1,
        projects: Object.fromEntries(this.projects),
      };
      atomicWriteFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      console.error(`[project-registry] failed to persist ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
