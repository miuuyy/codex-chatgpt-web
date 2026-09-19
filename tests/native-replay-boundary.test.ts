import { expect, test } from "bun:test";
import { forwardNativeCodexRequest } from "../src/native-passthrough";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { encodeReasoningEnvelope } from "../src/responses/reasoning-envelope";

// A router which sends native requests directly to OpenAI bypasses this boundary.
// Pin the bridge-owned boundary for normal turns and both compaction protocols.
for (const mode of ["turn", "compact-v1", "compact-v2"] as const) {
  for (const encoding of ["identity", "zstd"] as const) {
    test(`mixed Web history is normalized before native ${mode} (${encoding})`, async () => {
      const endpoint = mode === "compact-v1" ? "responses/compact" : "responses";
      const summary = "Türkçe özet: preserve the pending test.\nKeep this trailing space. ";
      const nativeCompaction = "future-native-compaction-format";
      const nativeReasoning = "future-native-reasoning-format";
      const call = {
        type: "function_call", call_id: "call_synthetic", name: "read_file", arguments: "{}",
      };
      const result = { type: "function_call_output", call_id: "call_synthetic", output: "synthetic result" };
      const tail = mode === "compact-v2" ? [{ type: "compaction_trigger" }] : [];
      const payload = {
        model: "gpt-6-astra", previous_response_id: "resp_synthetic_browser_turn",
        input: [
          { type: "compaction", id: "cmp_synthetic_browser", encrypted_content: encodeCompactionSummary(summary) },
          { type: "reasoning", id: "rs_synthetic_browser", summary: [],
            encrypted_content: encodeReasoningEnvelope({ txt: "SYNTHETIC_PRIVATE_STATE" }) },
          { type: "compaction", id: "cmp_synthetic_native", encrypted_content: nativeCompaction },
          { type: "reasoning", id: "rs_synthetic_native", summary: [], encrypted_content: nativeReasoning },
          call, result,
          { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
          ...tail,
        ],
      };
      const original = JSON.stringify(payload);
      const bytes = encoding === "zstd" ? Bun.zstdCompressSync(Buffer.from(original)) : Buffer.from(original);
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      const request = new Request(`http://127.0.0.1:17841/v1/${endpoint}`, {
        method: "POST", body,
        headers: { authorization: "Bearer synthetic-test-token", "content-type": "application/json",
          "content-encoding": encoding, "content-length": String(bytes.byteLength) },
      });
      let calls = 0;
      const response = await forwardNativeCodexRequest(request, endpoint, async forwarded => {
        calls += 1;
        expect(forwarded.url).toBe(`https://chatgpt.com/backend-api/codex/${endpoint}`);
        expect(forwarded.headers.get("content-encoding")).toBeNull();
        expect(forwarded.headers.get("content-length")).toBeNull();
        expect(forwarded.headers.get("authorization")).toBe("Bearer synthetic-test-token");
        const text = await forwarded.text();
        expect(text).not.toContain("ocx1:");
        expect(text).not.toContain("ocxr1:");
        expect(text).not.toContain("SYNTHETIC_PRIVATE_STATE");
        const replay = JSON.parse(text);
        expect(replay).not.toHaveProperty("previous_response_id");
        expect(replay.input).toEqual([
          { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }] },
          { type: "compaction", encrypted_content: nativeCompaction },
          { type: "reasoning", summary: [], encrypted_content: nativeReasoning },
          call, result,
          { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
          ...tail,
        ]);
        return Response.json({ output: [] });
      });
      expect(response.status).toBe(200);
      expect(calls).toBe(1);
      expect(JSON.stringify(payload)).toBe(original);
    });
  }
}
