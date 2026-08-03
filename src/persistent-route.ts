import type { ChatGptConversationRoute } from "./types";

export const CHATGPT_CONVERSATION_MODEL_PREFIX = "chatgpt-web/project/";
const ROUTE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function canonicalChatGptUrl(value: string): string {
  if (value !== value.trim() || value.length === 0) {
    throw new Error("ChatGPT conversation URL must be a non-empty canonical URL without surrounding whitespace");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT conversation URL is malformed");
  }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port
    || url.username || url.password || url.hash) {
    throw new Error("ChatGPT conversation URL must be an HTTPS chatgpt.com URL without credentials, a port, or a fragment");
  }
  return url.href;
}

export function conversationRouteModelSlug(routeKey: string): string {
  if (!ROUTE_KEY.test(routeKey)) {
    throw new Error(`Invalid ChatGPT conversation route key: ${routeKey}`);
  }
  return `${CHATGPT_CONVERSATION_MODEL_PREFIX}${routeKey}`;
}

export function validateChatGptConversationRoutes(
  value: unknown,
  label = "conversationRoutes",
): ChatGptConversationRoute[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const routeKeys = new Set<string>();
  const urls = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const route = candidate as Partial<ChatGptConversationRoute>;
    if (typeof route.routeKey !== "string" || !ROUTE_KEY.test(route.routeKey)) {
      throw new Error(`${label}[${index}].routeKey is invalid`);
    }
    if (routeKeys.has(route.routeKey)) throw new Error(`${label} contains duplicate route key ${route.routeKey}`);
    routeKeys.add(route.routeKey);
    if (route.routeMode !== "conversation") throw new Error(`${label}[${index}].routeMode must be conversation`);
    if (typeof route.conversationUrl !== "string") throw new Error(`${label}[${index}].conversationUrl is invalid`);
    const conversationUrl = canonicalChatGptUrl(route.conversationUrl);
    if (urls.has(conversationUrl)) throw new Error(`${label} contains duplicate conversation URL`);
    urls.add(conversationUrl);
    const expectedProjectLabel = route.expectedProjectLabel;
    const expectedConversationLabel = route.expectedConversationLabel;
    for (const [key, text] of [
      ["expectedProjectLabel", expectedProjectLabel],
      ["expectedConversationLabel", expectedConversationLabel],
    ] as const) {
      if (typeof text !== "string" || !text.trim() || text !== text.trim() || text.length > 160) {
        throw new Error(`${label}[${index}].${key} is invalid`);
      }
    }
    if (route.requiredModel !== "pro") throw new Error(`${label}[${index}].requiredModel must be pro`);
    if (route.payloadMode !== "signed_capsule_or_delta") {
      throw new Error(`${label}[${index}].payloadMode must be signed_capsule_or_delta`);
    }
    return {
      routeKey: route.routeKey,
      routeMode: "conversation",
      conversationUrl,
      expectedProjectLabel: expectedProjectLabel!,
      expectedConversationLabel: expectedConversationLabel!,
      requiredModel: "pro",
      payloadMode: "signed_capsule_or_delta",
    };
  });
}

export function chatGptConversationRoute(
  routes: readonly ChatGptConversationRoute[] | undefined,
  routeKey: string,
): ChatGptConversationRoute {
  const route = routes?.find(candidate => candidate.routeKey === routeKey);
  if (!route) throw new Error(`ChatGPT conversation route is not registered: ${routeKey}`);
  return route;
}
