export async function fetchLoopback(url: string, init: RequestInit = {}): Promise<Response> {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "[::1]") throw new Error(`Not a loopback URL: ${url}`);
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(",");
  }
  return await fetch(url, init);
}
