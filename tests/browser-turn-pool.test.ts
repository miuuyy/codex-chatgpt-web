import { describe, expect, test } from "bun:test";
import { ChatGptBrowserTurnPool } from "../src/adapters/chatgpt-web/browser-turn-pool";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("ChatGPT browser turn pool", () => {
  test("runs at most four Ultra turns concurrently", async () => {
    const pool = new ChatGptBrowserTurnPool(4);
    const gates = Array.from({ length: 6 }, deferred);
    const started: number[] = [];
    const turns = gates.map((gate, index) => pool.run("ultra", async () => {
      started.push(index);
      await gate.promise;
      return index;
    }));

    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(pool.state()).toEqual({ active: 4, queued: 2, exclusive: false });

    gates[0]!.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    for (const gate of gates.slice(1)) gate.resolve();
    await expect(Promise.all(turns)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    await pool.waitForIdle();
    expect(pool.state()).toEqual({ active: 0, queued: 0, exclusive: false });
  });

  test("gives a queued normal turn exclusive access before later Ultra work", async () => {
    const pool = new ChatGptBrowserTurnPool(4);
    const first = deferred();
    const second = deferred();
    const normal = deferred();
    const later = deferred();
    const started: string[] = [];

    const running = [
      pool.run("ultra", async () => { started.push("ultra-1"); await first.promise; }),
      pool.run("ultra", async () => { started.push("ultra-2"); await second.promise; }),
      pool.run("exclusive", async () => { started.push("normal"); await normal.promise; }),
      pool.run("ultra", async () => { started.push("ultra-later"); await later.promise; }),
    ];
    await settle();
    expect(started).toEqual(["ultra-1", "ultra-2"]);

    first.resolve();
    second.resolve();
    await settle();
    expect(started).toEqual(["ultra-1", "ultra-2", "normal"]);
    expect(pool.state()).toEqual({ active: 1, queued: 1, exclusive: true });

    normal.resolve();
    await settle();
    expect(started).toEqual(["ultra-1", "ultra-2", "normal", "ultra-later"]);
    later.resolve();
    await Promise.all(running);
  });

  test("removes an aborted queued turn without occupying a slot", async () => {
    const pool = new ChatGptBrowserTurnPool(1);
    const active = deferred();
    const controller = new AbortController();
    const first = pool.run("ultra", async () => active.promise);
    const aborted = pool.run("ultra", async () => "unexpected", controller.signal);
    await settle();
    controller.abort();
    await expect(aborted).rejects.toThrow("aborted");
    expect(pool.state()).toEqual({ active: 1, queued: 0, exclusive: false });
    active.resolve();
    await first;
    await pool.waitForIdle();
  });
});
