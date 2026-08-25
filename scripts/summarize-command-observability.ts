import { readFileSync } from "node:fs";
import { summarizeCommandObservabilityLog } from "../src/adapters/chatgpt-web/command-observability";

const args = process.argv.slice(2);
const logPath = args.find(arg => !arg.startsWith("--"));
const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

if (!logPath) {
  console.error("usage: bun run scripts/summarize-command-observability.ts <log> [--since=ISO] [--until=ISO]");
  process.exit(2);
}

const summary = summarizeCommandObservabilityLog(readFileSync(logPath, "utf8"), {
  since: option("since"),
  until: option("until"),
});
console.log(JSON.stringify(summary, null, 2));
