import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandPreviousResponseInput, flushResponseState, previousResponseReplayPrefixLength, rememberResponseState } from "../../src/responses/state";

const mode = process.argv[2];
const snapshot = join(process.env.CODEX_CHATGPT_WEB_HOME!, "responses-state.json");
if (mode === "load") {
  const request = { previous_response_id: "saved", input: "next" };
  const expanded = expandPreviousResponseInput(request) as { input: unknown };
  rememberResponseState({ input: "new" }, { id: "new", output: [], status: "completed" });
  flushResponseState();
  console.log(JSON.stringify({ recovered: expanded !== request, prefix: previousResponseReplayPrefixLength(expanded), bytes: statSync(snapshot).size }));
} else {
  const payload = mode === "entry" ? "한🙂".repeat(310_000) : "한🙂".repeat(150_000);
  const count = mode === "entry" ? 1 : 30;
  for (let index = 0; index < count; index++) rememberResponseState({ input: payload }, { id: `state-${index}`, output: [], status: "completed" });
  flushResponseState();
  const data = JSON.parse(readFileSync(snapshot, "utf8"));
  console.log(JSON.stringify({ ids: data.states.map((entry: [string, unknown]) => entry[0]), bytes: statSync(snapshot).size,
    memoryRecovered: expandPreviousResponseInput({ previous_response_id: "state-0", input: "next" }) !== undefined,
    exists: existsSync(snapshot) }));
}
