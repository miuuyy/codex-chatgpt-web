import { readCosConfig } from "./config";
import { goalLoopController } from "./goal-loop";

const events: Array<{ at: string; event: string }> = [];
const usage = { turns: 0, compactions: 0, inputTokens: 0, outputTokens: 0, lastInputTokens: 0 };
export function recordCosUsage(response: Record<string, unknown>, compaction: boolean): void {
  if (response.status !== "completed") return;
  const value = response.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  const input = typeof value?.input_tokens === "number" && Number.isSafeInteger(value.input_tokens) && value.input_tokens >= 0 ? value.input_tokens : 0;
  const output = typeof value?.output_tokens === "number" && Number.isSafeInteger(value.output_tokens) && value.output_tokens >= 0 ? value.output_tokens : 0;
  if (compaction) usage.compactions++; else usage.turns++;
  usage.inputTokens += input; usage.outputTokens += output; usage.lastInputTokens = input;
  recordCosEvent(compaction ? "compaction_completed" : "turn_completed");
}
export function recordCosEvent(event: "turn_completed" | "compaction_completed" | "goal_stopped" | "goal_dispatched") {
  events.push({ at: new Date().toISOString(), event });
  if (events.length > 100) events.splice(0, events.length - 100);
}

// DOM textContent is intentional: model output and account data are never HTML or diagnostics.
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>CoS dashboard</title><style>body{font:16px system-ui;background:#141414;color:#eee;max-width:960px;margin:40px auto;padding:20px}section{padding:20px;border:1px solid #555;border-radius:12px;margin:16px 0}button{padding:8px}pre{white-space:pre-wrap}</style>
<h1>CoS dashboard</h1><section><h2>Runtime</h2><pre id="runtime"></pre></section><section><h2>Usage</h2><pre id="usage"></pre></section><section><h2>Explicit goals</h2><div id="goals"></div></section><section><h2>Recent events</h2><pre id="events"></pre></section>
<script>let stopped=false,running=false,timer; async function update(){if(running)return;running=true;clearTimeout(timer);try{const response=await fetch('/api/status');if(!response.ok)throw Error('Status unavailable');const s=await response.json();document.querySelector('#runtime').textContent=JSON.stringify(s.runtime,null,2);document.querySelector('#usage').textContent=JSON.stringify(s.usage,null,2);const box=document.querySelector('#goals');box.replaceChildren();for(const g of s.goals){const row=document.createElement('p');row.textContent=g.thread+': '+g.currentTurn+'/'+g.maxTurns+' '+(g.enabled?'active':'stopped');if(g.enabled){const b=document.createElement('button');b.textContent='Stop';b.onclick=async()=>{await fetch('/api/goal/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({thread:g.thread})});await update()};row.append(b)}box.append(row)}document.querySelector('#events').textContent=s.events.map(e=>e.at+' '+e.event).join('\n')}catch{document.querySelector('#runtime').textContent='Runtime unavailable'}finally{running=false;if(!stopped)timer=setTimeout(update,3000)}}window.addEventListener('pagehide',()=>stopped=true);update()</script></html>`;

export function createCosDashboardHandler(runtimeStatus: () => Promise<unknown>, origin: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response("Invalid host", { status: 403 });
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (request.method === "GET" && url.pathname === "/") return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/api/status") return Response.json({
      runtime: await runtimeStatus(), usage, goals: goalLoopController().statuses(), events,
    }, { headers });
    if (request.method === "POST" && url.pathname === "/api/goal/stop") {
      if (request.headers.get("origin") !== origin || request.headers.get("content-type") !== "application/json") return new Response("Invalid origin", { status: 403 });
      const body = await request.text();
      if (body.length > 4096) return new Response("Request too large", { status: 413 });
      try {
        const { thread } = JSON.parse(body);
        if (typeof thread !== "string" || thread.length > 256) throw new Error();
        goalLoopController().cancel(thread);
        recordCosEvent("goal_stopped");
        return Response.json({ stopped: true }, { headers });
      } catch { return new Response("Invalid request", { status: 400 }); }
    }
    return new Response("Not found", { status: 404 });
  };
}

export function startCosDashboard(runtimeStatus: () => Promise<unknown>) {
  const config = readCosConfig();
  if (!config.dashboard) return;
  const origin = `http://127.0.0.1:${config.dashboardPort}`;
  return Bun.serve({ hostname: "127.0.0.1", port: config.dashboardPort,
    fetch: createCosDashboardHandler(runtimeStatus, origin),
  });
}
