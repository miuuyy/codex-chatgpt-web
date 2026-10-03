import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { readCosConfig, readCosEvaluatorKey } from "./config";

export const MAX_GOAL_LOOPS = 30;
type Goal = { revision: string; objective: string; dispatched: number; generation: number; stopped: boolean };
export type GoalDecision = { action: "continue"; reply: string } | { action: "stop" };

/** Only a direct, explicit marker starts a goal. Quoted/history text is not searched. */
export function explicitGoalObjective(message: string): string | undefined {
  const match = /^\s*(?:\[goal\]|\[목표\]|\/goal\b|#goal\b|goal:)\s*([\s\S]+)$/i.exec(message);
  return match?.[1]?.trim() || undefined;
}

export function localGoalDecision(answer: string): GoalDecision {
  return /(?:^- \[ \]|계속 진행할까요|다음 작업을 진행할까요|shall I continue|would you like me to continue)/im.test(answer)
    ? { action: "continue", reply: "계획된 다음 단계를 계속해서 진행하세요." } : { action: "stop" };
}

export class GoalLoopController {
  private readonly goals = new Map<string, Goal>();
  private readonly pending = new Map<string, { revision: string; generation: number; reply: string }>();
  private readonly evaluating = new Map<string, { generation: number; task: Promise<void> }>();
  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (stored.version !== 1 || !Array.isArray(stored.goals)) throw new Error("CoS goal state is invalid");
    for (const [thread, goal] of stored.goals) {
      if (typeof thread !== "string" || !goal || typeof goal.revision !== "string" || typeof goal.objective !== "string"
        || !Number.isInteger(goal.dispatched) || goal.dispatched < 0 || goal.dispatched > MAX_GOAL_LOOPS
        || !Number.isInteger(goal.generation) || typeof goal.stopped !== "boolean") throw new Error("CoS goal state is invalid");
      this.goals.set(thread, { ...goal, stopped: true });
    }
    // Pending follow-ups are deliberately not restored after a process restart.
  }
  begin(thread: string, message: string): boolean {
    this.cancel(thread);
    const objective = explicitGoalObjective(message);
    if (!objective) return false;
    const revision = createHash("sha256").update(objective).digest("hex");
    const previous = this.goals.get(thread);
    const dispatched = previous?.revision === revision ? previous.dispatched : 0;
    this.goals.set(thread, { revision, objective, dispatched,
      generation: (previous?.generation ?? 0) + 1, stopped: dispatched >= MAX_GOAL_LOOPS });
    this.persist();
    return true;
  }
  cancel(thread: string): void {
    this.pending.delete(thread);
    const goal = this.goals.get(thread);
    if (goal) { goal.stopped = true; goal.generation += 1; this.persist(); }
  }
  status(thread: string) {
    const goal = this.goals.get(thread);
    return { enabled: Boolean(goal && !goal.stopped), currentTurn: goal?.dispatched ?? 0, maxTurns: MAX_GOAL_LOOPS };
  }
  statuses() { return [...this.goals.keys()].map(thread => ({ thread, ...this.status(thread) })); }
  async evaluate(thread: string, answer: string, decide: (objective: string, answer: string) => Promise<GoalDecision>, signal?: AbortSignal): Promise<void> {
    const previous = this.evaluating.get(thread);
    if (previous) {
      await previous.task;
      if (previous.generation === this.goals.get(thread)?.generation) return;
    }
    const goal = this.goals.get(thread);
    if (!goal || goal.stopped || goal.dispatched >= MAX_GOAL_LOOPS || signal?.aborted) return;
    const generation = goal.generation;
    const task = (async () => {
      let decision: GoalDecision;
      try { decision = await decide(goal.objective, answer); } catch { decision = localGoalDecision(answer); }
      if (signal?.aborted || goal !== this.goals.get(thread) || goal.stopped || generation !== goal.generation) return;
      if (decision.action === "continue" && typeof decision.reply === "string" && decision.reply.trim()) {
        this.pending.set(thread, { revision: goal.revision, generation, reply: decision.reply.trim().slice(0, 4000) });
      } else { goal.stopped = true; this.pending.delete(thread); this.persist(); }
    })();
    const evaluation = { generation, task };
    this.evaluating.set(thread, evaluation);
    try { await task; } finally { if (this.evaluating.get(thread) === evaluation) this.evaluating.delete(thread); }
  }
  consume(thread: string): string | undefined {
    const next = this.pending.get(thread);
    this.pending.delete(thread);
    const goal = this.goals.get(thread);
    if (!next || !goal || goal.stopped || next.revision !== goal.revision || next.generation !== goal.generation || goal.dispatched >= MAX_GOAL_LOOPS) return;
    goal.dispatched += 1;
    if (goal.dispatched === MAX_GOAL_LOOPS) goal.stopped = true;
    this.persist();
    return next.reply;
  }
  private persist() {
    if (this.file) atomicWriteFile(this.file, JSON.stringify({ version: 1, goals: [...this.goals] }));
  }
}

export async function evaluateConfiguredGoal(objective: string, answer: string, signal?: AbortSignal): Promise<GoalDecision> {
  const config = readCosConfig();
  if (!config.evaluatorEndpoint || !config.evaluatorModel) return localGoalDecision(answer);
  const key = readCosEvaluatorKey();
  if (!key) return localGoalDecision(answer);
  const url = new URL(config.evaluatorEndpoint);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("CoS evaluator requires an HTTPS endpoint");
  const response = await fetch(url, { method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: config.evaluatorModel, max_tokens: 150, temperature: 0.2, messages: [
      { role: "system", content: 'Decide whether this explicit goal needs another step. Return only JSON: {"action":"continue"|"stop","reply":"next step"}.' },
      { role: "user", content: JSON.stringify({ objective, answer: answer.slice(-2500) }) },
    ] }),
  });
  if (!response.ok) throw new Error("CoS evaluator is unavailable");
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const decision = JSON.parse(body.choices?.[0]?.message?.content ?? "");
  if (decision.action === "stop") return { action: "stop" };
  if (decision.action !== "continue" || typeof decision.reply !== "string" || !decision.reply.trim()) throw new Error("CoS evaluator decision is invalid");
  return { action: "continue", reply: decision.reply };
}

let defaultController: { home: string; controller: GoalLoopController } | undefined;
export function goalLoopController(): GoalLoopController {
  const home = getConfigDir();
  if (!defaultController || defaultController.home !== home) defaultController = { home, controller: new GoalLoopController(join(home, "runtime", "cos-goals.json")) };
  return defaultController.controller;
}
