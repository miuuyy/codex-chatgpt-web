import { describe, expect, test } from "bun:test";
import { negotiateDrain } from "../src/service";
import { serviceDefinition } from "../src/service";
import { defaultConfig } from "../src/config";

describe("service drain lifecycle", () => {
  test("defines a restartable systemd user service without a shell", () => {
    const definition = serviceDefinition(defaultConfig("browser-only"), "linux");
    expect(definition).toContain("WantedBy=default.target");
    expect(definition).toContain("Restart=always");
    expect(definition).not.toContain("/bin/sh");
  });

  test("compensates when a drain may have reached the daemon before the client times out", async () => {
    const actions: string[] = [];
    let acceptingTurns = true;
    const control = async (action: "drain" | "resume") => {
      actions.push(action);
      acceptingTurns = action === "resume";
      if (action === "drain") throw new Error("request timed out after delivery");
      return { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    };

    await expect(negotiateDrain(control)).rejects.toThrow("atomic idleness could not be proven");
    expect(actions).toEqual(["drain", "resume"]);
    expect(acceptingTurns).toBe(true);
  });

  test("releases a verified idle drain", async () => {
    const actions: string[] = [];
    const lease = await negotiateDrain(async action => {
      actions.push(action);
      return action === "drain"
        ? { accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }
        : { accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
    });
    expect(actions).toEqual(["drain"]);
    await lease.release();
    expect(actions).toEqual(["drain", "resume"]);
  });
});
