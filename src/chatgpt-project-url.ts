const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_PROJECT_PATH = /^\/g\/g-p-[A-Za-z0-9_-]{1,160}\/project$/;

/**
 * Validates an optional ChatGPT Project page URL and returns its canonical form.
 * Only the exact https://chatgpt.com/g/g-p-<id>/project page is accepted; credentials, ports, queries
 * and fragments are rejected so a mistyped or hostile value can never route chats elsewhere.
 */
export function normalizeChatGptProjectUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || value !== value.trim()) {
    throw new Error("ChatGPT Project URL must be a non-empty https://chatgpt.com/g/g-p-<id>/project URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ChatGPT Project URL is not a valid URL");
  }
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  if (url.origin !== CHATGPT_ORIGIN || url.username || url.password || url.search || url.hash
    || !CHATGPT_PROJECT_PATH.test(pathname)) {
    throw new Error("ChatGPT Project URL must look like https://chatgpt.com/g/g-p-<id>/project");
  }
  return `${CHATGPT_ORIGIN}${pathname}`;
}
