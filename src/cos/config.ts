import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { getConfigDir } from "../config";

const schema = z.object({
  outputLimit: z.boolean().default(false),
  observeWindow: z.boolean().default(false),
  goalLoop: z.boolean().default(false),
  dashboard: z.boolean().default(false),
  dashboardPort: z.number().int().min(1024).max(65535).default(17842),
  evaluatorEndpoint: z.url().optional(),
  evaluatorModel: z.string().min(1).max(128).optional(),
}).strict();
export type CosConfig = z.infer<typeof schema>;

/** Profile-local configuration, with no side effects when the module is imported. */
export function readCosConfig(home = getConfigDir()): CosConfig {
  const file = join(home, "cos-settings.json");
  return schema.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
}

export function readCosEvaluatorKey(home = getConfigDir()): string | undefined {
  const file = join(home, "secrets", "cos-evaluator-key");
  if (!existsSync(file)) return undefined;
  const key = readFileSync(file, "utf8").trim();
  if (!key || /[\r\n]/.test(key)) throw new Error("CoS evaluator credential is invalid");
  return key;
}
