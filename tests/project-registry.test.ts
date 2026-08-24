import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectRegistry,
  computeProjectId,
  derivePrimaryProjectRoot,
  PROJECT_CONTINUITY_MAX_CHARS,
  MAX_PROJECT_THREADS,
} from "../src/project-registry";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

function mockEnv(cwd: string, roots: string[] = [cwd]): ChatGptTurnEnvironment {
  return {
    cwd,
    roots,
    writableRoots: roots,
    sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess: true },
    tools: [],
  };
}

describe("ProjectRegistry", () => {

  it("removes evicted thread IDs from the in-memory lookup immediately", () => {
    const registry = new ProjectRegistry();
    const env = mockEnv("/workspace/thread-cap", ["/workspace/thread-cap"]);
    for (let i = 0; i <= MAX_PROJECT_THREADS; i += 1) {
      registry.resolveProject(env, `thread_${i}`);
    }
    expect(registry.getProjectForThread("thread_0")).toBeUndefined();
    expect(registry.getProjectForThread(`thread_${MAX_PROJECT_THREADS}`)?.projectId).toBe(computeProjectId("/workspace/thread-cap"));
  });


  it("computes deterministic project IDs based on normalized root path", () => {
    const root1 = "/workspace/project-alpha";
    const root2 = "/workspace/project-alpha/";
    const root3 = "/workspace/project-beta";

    const id1 = computeProjectId(root1);
    const id2 = computeProjectId(root2);
    const id3 = computeProjectId(root3);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith("proj_")).toBe(true);
  });

  it("derives primary project root accurately from cwd and workspace roots", () => {
    const root = "/workspace/repo";
    const subDir = "/workspace/repo/src/components";
    const primary = derivePrimaryProjectRoot(subDir, [root]);
    expect(primary).toBe(root);

    const outsideCwd = "/tmp/other";
    const fallback = derivePrimaryProjectRoot(outsideCwd, [root]);
    expect(fallback).toBe(root);
  });

  it("automatically registers a project on first resolve and persists atomically", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-test-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry = new ProjectRegistry(statePath);
      const env = mockEnv("/workspace/my-app", ["/workspace/my-app"]);
      const project = registry.resolveProject(env, "thread_123");

      expect(project.projectId).toBe(computeProjectId("/workspace/my-app"));
      expect(project.name).toBe("my-app");
      expect(project.threadIds).toContain("thread_123");
      expect(existsSync(statePath)).toBe(true);

      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      expect(saved.version).toBe(1);
      expect(saved.projects[project.projectId]).toBeDefined();

      const lookup = registry.getProjectForThread("thread_123");
      expect(lookup?.projectId).toBe(project.projectId);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("links spawned subagent thread lineage to the parent thread project", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-lineage-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry = new ProjectRegistry(statePath);
      const env = mockEnv("/workspace/parent-app", ["/workspace/parent-app"]);
      const parentProject = registry.resolveProject(env, "thread_parent");

      const linked = registry.linkThreadToParent("thread_child", "thread_parent");
      expect(linked?.projectId).toBe(parentProject.projectId);
      expect(linked?.threadIds).toContain("thread_child");

      const childLookup = registry.getProjectForThread("thread_child");
      expect(childLookup?.projectId).toBe(parentProject.projectId);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves bounded semantic project continuity and isolates independent threads", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-continuity-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry = new ProjectRegistry(statePath);
      const envA = mockEnv("/workspace/project-a", ["/workspace/project-a"]);
      const envB = mockEnv("/workspace/project-b", ["/workspace/project-b"]);

      const projA = registry.resolveProject(envA, "thread_a1");
      const projB = registry.resolveProject(envB, "thread_b1");

      registry.updateSemanticState(projA.projectId, {
        summary: "Project A is an e-commerce API",
        keyDecisions: ["Use PostgreSQL", "Use Redis for caching"],
        conventions: ["TDD required", "CamelCase naming"],
        activeTasks: ["Implement cart checkout"],
      });

      const contextA = registry.getProjectContinuityContext(projA.projectId);
      expect(contextA).toBeDefined();
      expect(contextA).toContain("Project A is an e-commerce API");
      expect(contextA).toContain("Use PostgreSQL");
      expect(contextA).toContain("TDD required");

      // Independent project B has no continuity from project A
      const contextB = registry.getProjectContinuityContext(projB.projectId);
      expect(contextB).toBeUndefined();

      // Thread A2 in Project A gets Project A context
      registry.resolveProject(envA, "thread_a2");
      const projForA2 = registry.getProjectForThread("thread_a2");
      expect(projForA2?.projectId).toBe(projA.projectId);
      const continuityForA2 = registry.getProjectContinuityContext(projForA2!.projectId);
      expect(continuityForA2).toBe(contextA);

      // Thread B1 gets nothing from Project A
      const projForB1 = registry.getProjectForThread("thread_b1");
      expect(projForB1?.projectId).toBe(projB.projectId);
      expect(registry.getProjectContinuityContext(projForB1!.projectId)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("truncates oversized continuity context strictly at bounded character limit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-trunc-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry = new ProjectRegistry(statePath);
      const env = mockEnv("/workspace/big-app");
      const proj = registry.resolveProject(env);

      const massiveSummary = "A".repeat(10_000);
      registry.updateSemanticState(proj.projectId, { summary: massiveSummary });

      const context = registry.getProjectContinuityContext(proj.projectId);
      expect(context).toBeDefined();
      expect(context!.length).toBeLessThanOrEqual(PROJECT_CONTINUITY_MAX_CHARS);
      expect(context!.endsWith("...[truncated]")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("recovers gracefully from corrupted state files without crashing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-corrupt-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      writeFileSync(statePath, "{ broken json ...", "utf8");
      const registry = new ProjectRegistry(statePath);
      const env = mockEnv("/workspace/repaired-app");
      const project = registry.resolveProject(env, "thread_new");

      expect(project.name).toBe("repaired-app");
      const inspect = registry.inspect();
      expect(inspect.ok).toBe(true);
      expect(inspect.count).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prunes expired projects beyond TTL", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-ttl-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      let currentTime = 100_000_000;
      const registry = new ProjectRegistry(statePath, () => currentTime);
      const envOld = mockEnv("/workspace/old-app");
      registry.resolveProject(envOld, "thread_old");

      expect(registry.inspect().count).toBe(1);

      // Advance time by 31 days
      currentTime += 31 * 24 * 60 * 60_000;
      const envNew = mockEnv("/workspace/new-app");
      registry.resolveProject(envNew, "thread_new");

      expect(registry.inspect().count).toBe(1);
      expect(registry.getProjectForThread("thread_old")).toBeUndefined();
      expect(registry.getProjectForThread("thread_new")).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("guarantees disjoint workspace roots resolve to isolated projects with zero continuity leakage", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-disjoint-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry = new ProjectRegistry(statePath);
      const envOriginal = mockEnv("/workspace/repo-a", ["/workspace/repo-a"]);
      const projectA = registry.resolveProject(envOriginal, "thread_orig");
      registry.updateSemanticState(projectA.projectId, { summary: "Confidential Project A info" });

      const envDisjoint = mockEnv("/completely/different/workspace", ["/completely/different/workspace"]);
      const projectB = registry.resolveProject(envDisjoint, "thread_disjoint");

      expect(projectA.projectId).not.toBe(projectB.projectId);
      expect(registry.getProjectForThread("thread_orig")?.projectId).toBe(projectA.projectId);
      expect(registry.getProjectForThread("thread_disjoint")?.projectId).toBe(projectB.projectId);

      // Thread in disjoint project cannot see project A's continuity
      const continuityForB = registry.getProjectContinuityContext(projectB.projectId);
      expect(continuityForB).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("semantic state survives registry reloads and retains structured sections", () => {
    const tmp = mkdtempSync(join(tmpdir(), "project-reg-reload-"));
    const statePath = join(tmp, "project-registry.json");
    try {
      const registry1 = new ProjectRegistry(statePath);
      const env = mockEnv("/workspace/reload-app", ["/workspace/reload-app"]);
      const project = registry1.resolveProject(env, "thread_reload_1");

      registry1.updateSemanticState(project.projectId, {
        summary: "Reload app summary",
        keyDecisions: ["Decision 1", "Decision 2"],
        conventions: ["Convention 1"],
        activeTasks: ["Task 1"],
      });

      // Reload in a fresh instance
      const registry2 = new ProjectRegistry(statePath);
      const reloaded = registry2.getProject(project.projectId);
      expect(reloaded).toBeDefined();
      expect(reloaded?.semanticState?.summary).toBe("Reload app summary");
      expect(reloaded?.semanticState?.keyDecisions).toEqual(["Decision 1", "Decision 2"]);
      expect(reloaded?.semanticState?.conventions).toEqual(["Convention 1"]);
      expect(reloaded?.semanticState?.activeTasks).toEqual(["Task 1"]);

      const continuity = registry2.getProjectContinuityContext(project.projectId);
      expect(continuity).toContain("Reload app summary");
      expect(continuity).toContain("Decision 1");
      expect(continuity).toContain("Convention 1");
      expect(continuity).toContain("Task 1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
