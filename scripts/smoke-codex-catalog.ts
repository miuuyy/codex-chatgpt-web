import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const bundled = runCodex(["debug", "models", "--bundled"]);
const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
  throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
process.env.CODEX_HOME = join(root, "codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const config = defaultConfig("browser-only");
config.proAvailable = true;
const catalogPath = join(root, "augmented-models.json");
writeFileSync(catalogPath, `${JSON.stringify(augmentNativeModelCatalog(sourceCatalog, config))}\n`);
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
try {
  const result = runCodex(["debug", "models"], { ...process.env, CODEX_HOME: process.env.CODEX_HOME });
  const catalog = JSON.parse(result.stdout) as {
    models?: Array<{
      slug?: string;
      supported_reasoning_levels?: unknown[];
      multi_agent_version?: string;
      supported_in_api?: boolean;
      visibility?: string;
      priority?: number;
    }>;
  };
  const web = catalog.models?.filter(model => model.slug?.startsWith("chatgpt-web/")) ?? [];
  const expected = CHATGPT_WEB_MODEL_ROUTES.map(route => ({ slug: route.slug, effort: route.codexEffort }));
  const actual = web.map(model => ({
    slug: model.slug,
    effort: Array.isArray(model.supported_reasoning_levels)
      ? (model.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort).join(",")
      : "",
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Codex did not preserve the fixed ChatGPT Web model contract: ${JSON.stringify(actual)}`);
  }
  const nativeSol = catalog.models?.find(model => model.slug === "gpt-5.6-sol");
  const webPro = catalog.models?.find(model => model.slug === "chatgpt-web/pro");
  if (nativeSol?.multi_agent_version !== "v1" || webPro?.multi_agent_version !== "v1") {
    throw new Error(
      `Codex did not preserve the readable V1 subagent surface: ${JSON.stringify({ nativeSol, webPro })}`,
    );
  }
  const spawnOverrides = (catalog.models ?? [])
    .filter(model => model.supported_in_api === true && model.visibility === "list")
    .toSorted((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 5)
    .map(model => model.slug);
  if (JSON.stringify(spawnOverrides) !== JSON.stringify(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug))) {
    throw new Error(`Codex did not feature the five ChatGPT Web subagent overrides: ${JSON.stringify(spawnOverrides)}`);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
