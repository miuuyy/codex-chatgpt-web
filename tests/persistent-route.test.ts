import { expect, test } from "bun:test";
import { ChatGptRouteQueue } from "../src/adapters/chatgpt-web/concurrency";
import {
  ChatGptBrowserWorker,
  newChatGptAssistantMessageIdentity,
  sameChatGptAssistantMessageSnapshot,
  type ChatGptAssistantMessageSnapshot,
} from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptConversationDeltaPrompt } from "../src/adapters/chatgpt-web/prompt";
import {
  availableChatGptWebModelRoutes,
  requireChatGptWebModelRoute,
} from "../src/chatgpt-web-models";
import {
  canonicalChatGptUrl,
  conversationRouteModelSlug,
  validateChatGptConversationRoutes,
} from "../src/persistent-route";
import { routeChatGptWebRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import type { ChatGptConversationRoute, CodexParsedRequest } from "../src/types";

const route: ChatGptConversationRoute = {
  routeKey: "dcp-pro-advisory",
  routeMode: "conversation",
  conversationUrl: "https://chatgpt.com/opaque/project-route?registered=1",
  expectedProjectLabel: "DCP",
  expectedConversationLabel: "DCP Pro Advisory",
  requiredModel: "pro",
  payloadMode: "signed_capsule_or_delta",
};

function request(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "max" },
    context: {
      systemPrompt: ["do-not-transmit-system"],
      messages: [
        { role: "developer", content: "do-not-transmit-developer", timestamp: 1 },
        { role: "user", content: `old-${"x".repeat(67_000)}`, timestamp: 2 },
        {
          role: "assistant",
          content: [{ type: "text", text: "do-not-transmit-assistant" }],
          timestamp: 3,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "signed-capsule-delta nonce-2" },
            { type: "image", imageUrl: "data:image/png;base64,AAAA" },
          ],
          timestamp: 4,
        },
      ],
    },
    _chatGptConversationRoute: route,
  };
}

test("conversation URLs are canonicalized as opaque ChatGPT URLs without assuming a path schema", () => {
  expect(canonicalChatGptUrl(route.conversationUrl)).toBe(route.conversationUrl);
  expect(canonicalChatGptUrl("https://chatgpt.com/any/future/schema/?b=2&a=1"))
    .toBe("https://chatgpt.com/any/future/schema/?b=2&a=1");
  expect(() => canonicalChatGptUrl("https://example.com/c/id")).toThrow("chatgpt.com");
  expect(() => canonicalChatGptUrl("http://chatgpt.com/c/id")).toThrow("HTTPS");
  expect(() => canonicalChatGptUrl("https://chatgpt.com/c/id#fragment")).toThrow("fragment");
});

test("route registration rejects duplicate keys and duplicate canonical destinations", () => {
  expect(validateChatGptConversationRoutes([route])).toEqual([route]);
  expect(() => validateChatGptConversationRoutes([route, route])).toThrow("duplicate route key");
  expect(() => validateChatGptConversationRoutes([
    route,
    { ...route, routeKey: "second-route" },
  ])).toThrow("duplicate conversation URL");
});

test("registered conversations become explicit Pro route models without changing Temporary Chat models", () => {
  expect(conversationRouteModelSlug(route.routeKey)).toBe("chatgpt-web/project/dcp-pro-advisory");
  const models = availableChatGptWebModelRoutes(true, [route]);
  expect(models.map(model => model.slug)).toContain("chatgpt-web/pro");
  expect(models.map(model => model.slug)).toContain("chatgpt-web/project/dcp-pro-advisory");
  expect(requireChatGptWebModelRoute("chatgpt-web/project/dcp-pro-advisory", true, [route]))
    .toMatchObject({ adapterEffort: "max", requiresPro: true, conversationRouteKey: route.routeKey });
  expect(() => requireChatGptWebModelRoute("chatgpt-web/project/dcp-pro-advisory", false, [route]))
    .toThrow("not available");
});

test("server routing binds the exact registered conversation before replacing the backend model", () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  config.conversationRoutes = [route];
  const parsed = request();
  parsed.modelId = "chatgpt-web/project/dcp-pro-advisory";
  parsed.options.reasoning = "low";

  const selected = routeChatGptWebRequest(parsed, config);

  expect(selected.conversationRouteKey).toBe(route.routeKey);
  expect(parsed._chatGptConversationRoute).toEqual(route);
  expect(parsed.modelId).toBe("gpt-5.6-sol");
  expect(parsed.options.reasoning).toBe("max");
});

test("persistent prompts transmit only the newest capsule or delta", () => {
  const compiled = compileChatGptConversationDeltaPrompt(
    request(),
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(compiled.text).toContain("signed-capsule-delta nonce-2");
  expect(compiled.text).not.toContain("do-not-transmit-system");
  expect(compiled.text).not.toContain("do-not-transmit-developer");
  expect(compiled.text).not.toContain("do-not-transmit-assistant");
  expect(compiled.text).not.toContain("old-");
  expect(compiled.text.length).toBeLessThan(5_000);
  expect(compiled.images).toEqual([{
    ref: "codex-input-image-1",
    imageUrl: "data:image/png;base64,AAAA",
  }]);
});

test("persistent prompts never redispatch an older user message when no current delta is present", () => {
  const parsed = request();
  parsed.context.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "already answered" }],
    timestamp: 5,
  });
  expect(() => compileChatGptConversationDeltaPrompt(
    parsed,
    { localToolsEnabled: false, proAvailable: true },
  )).toThrow("final user message");
});

test("response binding requires one new assistant identity after an unchanged prefix", () => {
  const before: ChatGptAssistantMessageSnapshot = { identities: ["conversation-turn-a", "conversation-turn-b"] };
  expect(newChatGptAssistantMessageIdentity(before, {
    identities: [...before.identities, "conversation-turn-c"],
  })).toBe("conversation-turn-c");
  expect(newChatGptAssistantMessageIdentity(before, {
    identities: ["conversation-turn-a", "conversation-turn-x", "conversation-turn-c"],
  })).toBeUndefined();
  expect(newChatGptAssistantMessageIdentity(before, {
    identities: [...before.identities, "conversation-turn-c", "conversation-turn-d"],
  })).toBeUndefined();
  expect(newChatGptAssistantMessageIdentity(before, {
    identities: [...before.identities, "conversation-turn-b"],
  })).toBeUndefined();
  expect(sameChatGptAssistantMessageSnapshot(before, { identities: [...before.identities] })).toBeTrue();
  expect(sameChatGptAssistantMessageSnapshot(before, {
    identities: ["conversation-turn-a", "conversation-turn-x"],
  })).toBeFalse();
});

test("browser route verification requires the exact opaque URL and both visible labels", async () => {
  const assertConversationRoutePage = (ChatGptBrowserWorker.prototype as unknown as {
    assertConversationRoutePage(page: unknown, route: ChatGptConversationRoute): Promise<void>;
  }).assertConversationRoutePage;
  const visibleLabels = new Set([route.expectedProjectLabel, route.expectedConversationLabel]);
  const page = {
    url: () => route.conversationUrl,
    locator: () => ({
      count: async () => 1,
      nth: () => ({ isVisible: async () => true }),
    }),
    getByText: (label: string, options: { exact: boolean }) => {
      expect(options).toEqual({ exact: true });
      return {
        filter: (filter: { visible: boolean }) => {
          expect(filter).toEqual({ visible: true });
          return { count: async () => visibleLabels.has(label) ? 1 : 0 };
        },
      };
    },
  };

  await expect(assertConversationRoutePage.call({}, page, route)).resolves.toBeUndefined();
  await expect(assertConversationRoutePage.call({}, {
    ...page,
    url: () => "https://chatgpt.com/a-different-opaque-route",
  }, route)).rejects.toThrow("changed unexpectedly");
  visibleLabels.delete(route.expectedProjectLabel);
  await expect(assertConversationRoutePage.call({}, page, route)).rejects.toThrow("expected Project label");
});

test("persistent routes reject a pre-existing composer draft instead of clearing and sending it", async () => {
  const assertConversationComposerEmpty = (ChatGptBrowserWorker.prototype as unknown as {
    assertConversationComposerEmpty(page: unknown, route: ChatGptConversationRoute): Promise<void>;
  }).assertConversationComposerEmpty;
  await expect(assertConversationComposerEmpty.call({
    attachedPromptText: async () => "stale draft",
  }, {}, route)).rejects.toThrow("pre-existing composer draft");
  await expect(assertConversationComposerEmpty.call({
    attachedPromptText: async () => "",
  }, {}, route)).resolves.toBeUndefined();
});

test("same-route requests are FIFO and cannot overlap or consume each other's result", async () => {
  const queue = new ChatGptRouteQueue();
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const events: string[] = [];
  const execute = (name: string, gate?: Promise<void>) => queue.run(route.conversationUrl, undefined, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    events.push(`${name}:start`);
    await gate;
    events.push(`${name}:response`);
    active -= 1;
    return `${name}-answer`;
  });

  const first = execute("first", firstGate);
  await Promise.resolve();
  const second = execute("second");
  await Promise.resolve();
  expect(events).toEqual(["first:start"]);
  releaseFirst();

  expect(await Promise.all([first, second])).toEqual(["first-answer", "second-answer"]);
  expect(events).toEqual(["first:start", "first:response", "second:start", "second:response"]);
  expect(maximumActive).toBe(1);
});
