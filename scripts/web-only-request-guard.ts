/** Gate test clients before forwarding anything to the installed mixed-routing server. */
export const WEB_ONLY_SMOKE_MODELS = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"];

export function allowWebOnlySmokeRequest(method: string, path: string, model: unknown, selectedModel = "chatgpt-web/pro"): boolean {
  return method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(path)
    && WEB_ONLY_SMOKE_MODELS.includes(selectedModel) && model === selectedModel;
}
