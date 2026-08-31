import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";

const CHATGPT_LEGACY_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_PREFIX = "https://chatgpt.com/connector/oauth/";
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_OAUTH_BODY_CHARS = 1_000_000;

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

interface StoredTokens {
  access: Record<string, { clientId: string; expiresAt: number }>;
  refresh: Record<string, { clientId: string }>;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface McpOAuthCredentialPaths {
  directory: string;
  clients: string;
  passphrase: string;
  tokens: string;
}

export function mcpOAuthCredentialPaths(home = getConfigDir()): McpOAuthCredentialPaths {
  const directory = join(home, "oauth");
  return {
    directory,
    clients: join(directory, "clients.json"),
    passphrase: join(directory, "passphrase.txt"),
    tokens: join(directory, "tokens.json"),
  };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function safeEqual(left: string | null | undefined, right: string): boolean {
  const a = Buffer.from(left ?? "");
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function allowedRedirect(uri: unknown): uri is string {
  return typeof uri === "string"
    && (uri === CHATGPT_LEGACY_CALLBACK || uri.startsWith(CHATGPT_CALLBACK_PREFIX));
}

function recoverableClientId(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function connectionRequestHelp(request: Request, form: URLSearchParams, oauth: McpOAuthServer): string {
  const locale = `${form.get("ui_locales") ?? ""} ${request.headers.get("accept-language") ?? ""}`.toLowerCase();
  const chinese = locale.includes("zh");
  const title = chinese ? "需要从 ChatGPT 重新连接" : "Reconnect from ChatGPT";
  const summary = chinese
    ? "该连接请求与当前 MCP 服务不匹配。授权链接必须由 ChatGPT 生成，不能在这里手动刷新。"
    : "This connection request does not match the current MCP server. ChatGPT must generate the authorization link; it cannot be refreshed here.";
  const steps = chinese
    ? [
      "打开 ChatGPT 的插件/连接器设置，并进入原来的 MCP 连接器。",
      "选择“连接”或“重新连接”。如果没有该按钮，请编辑连接器，确认下方两个 URL 后保存，再选择“连接”。",
      "新的授权页面打开后，输入 Codex Web GPT 中显示的授权口令。无需先删除原连接器。",
    ]
    : [
      "Open ChatGPT plugin or connector settings, then open the existing MCP connector.",
      "Choose Connect or Reconnect. If neither action is shown, edit the connector, confirm the two URLs below, save it, then choose Connect.",
      "Enter the authorization passphrase shown in Codex Web GPT when the new authorization page opens. You do not need to delete the connector first.",
    ];
  const button = chinese ? "打开 ChatGPT 连接器设置" : "Open ChatGPT connector settings";
  const mcpLabel = chinese ? "MCP URL" : "MCP URL";
  const registrationLabel = chinese ? "Registration URL" : "Registration URL";
  return `<!doctype html><html lang="${chinese ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:14px system-ui;background:#f5f5f5;margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(560px,calc(100% - 32px));background:white;border:1px solid #ddd;border-radius:14px;padding:24px;box-sizing:border-box}h1{font-size:19px;margin:0 0 10px}p,li{color:#555;line-height:1.55}ol{padding-left:22px}.field{margin-top:12px}.label{font-size:12px;color:#777;margin-bottom:4px}code{display:block;padding:9px 10px;border-radius:8px;background:#f2f2f2;overflow-wrap:anywhere;user-select:all}a{display:block;margin-top:18px;padding:11px;border-radius:9px;background:#111;color:white;text-align:center;text-decoration:none}</style></head><body><main class="card"><h1>${title}</h1><p>${summary}</p><ol>${steps.map(step => `<li>${step}</li>`).join("")}</ol><div class="field"><div class="label">${mcpLabel}</div><code>${escapeHtml(oauth.mcpUrl)}</code></div><div class="field"><div class="label">${registrationLabel}</div><code>${escapeHtml(oauth.registrationUrl)}</code></div><a href="https://chatgpt.com/#settings/Plugins" target="_blank" rel="noreferrer">${button}</a></main></body></html>`;
}

function response(body: BodyInit | null, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function json(value: unknown, status = 200): Response {
  return response(JSON.stringify(value), status, { "content-type": "application/json; charset=utf-8" });
}

async function requestText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_OAUTH_BODY_CHARS) throw new Error("OAuth request body is too large");
  const text = await request.text();
  if (text.length > MAX_OAUTH_BODY_CHARS) throw new Error("OAuth request body is too large");
  return text;
}

export function ensureMcpOAuthCredentials(home = getConfigDir()): { passphrase: string; paths: McpOAuthCredentialPaths } {
  const paths = mcpOAuthCredentialPaths(home);
  let passphrase: string;
  try {
    passphrase = readFileSync(paths.passphrase, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(passphrase)) throw new Error("invalid passphrase");
  } catch {
    passphrase = randomBytes(12).toString("base64url");
    atomicWriteFile(paths.passphrase, `${passphrase}\n`);
  }
  if (!existsSync(paths.clients)) atomicWriteFile(paths.clients, "{}\n");
  if (!existsSync(paths.tokens)) atomicWriteFile(paths.tokens, '{"access":{},"refresh":{}}\n');
  return { passphrase, paths };
}

export class McpOAuthServer {
  readonly issuer: string;
  readonly mcpUrl: string;
  readonly protectedResourceMetadataPath: string;
  readonly authorizationServerMetadataPath: string;
  readonly registrationUrl: string;
  private readonly passphrase: string;
  private readonly paths: McpOAuthCredentialPaths;
  private readonly codes = new Map<string, AuthorizationCode>();
  private clients: Record<string, RegisteredClient>;
  private tokens: StoredTokens;

  constructor(readonly origin: string, readonly mcpPath: string, home = getConfigDir()) {
    const credentials = ensureMcpOAuthCredentials(home);
    this.passphrase = credentials.passphrase;
    this.paths = credentials.paths;
    this.mcpUrl = `${origin}${mcpPath}`;
    this.issuer = this.mcpUrl;
    this.protectedResourceMetadataPath = `/.well-known/oauth-protected-resource${mcpPath}`;
    this.authorizationServerMetadataPath = `/.well-known/oauth-authorization-server${mcpPath}`;
    this.registrationUrl = `${this.issuer}/oauth/register`;
    this.clients = readJson(this.paths.clients, {});
    this.tokens = readJson(this.paths.tokens, { access: {}, refresh: {} });
  }

  private saveClients(): void {
    atomicWriteFile(this.paths.clients, `${JSON.stringify(this.clients, null, 2)}\n`);
  }

  private saveTokens(): void {
    atomicWriteFile(this.paths.tokens, `${JSON.stringify(this.tokens)}\n`);
  }

  private authorizationMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: this.registrationUrl,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    };
  }

  unauthorized(): Response {
    return response("unauthorized", 401, {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": `Bearer resource_metadata="${this.origin}${this.protectedResourceMetadataPath}"`,
    });
  }

  verify(request: Request): boolean {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return false;
    const token = authorization.slice(7);
    const entry = this.tokens.access[token];
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      delete this.tokens.access[token];
      this.saveTokens();
      return false;
    }
    return true;
  }

  async handle(request: Request, pathname: string): Promise<Response | null> {
    if (request.method === "OPTIONS") {
      return response(null, 204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
      });
    }
    if (request.method === "GET" && pathname === this.protectedResourceMetadataPath) {
      return json({ resource: this.mcpUrl, authorization_servers: [this.issuer] });
    }
    if (request.method === "GET" && (
      pathname === this.authorizationServerMetadataPath
      || pathname === `${this.mcpPath}/.well-known/openid-configuration`
    )) {
      return json(this.authorizationMetadata());
    }
    if (request.method === "POST" && pathname === `${this.mcpPath}/oauth/register`) {
      return this.register(request);
    }
    if ((request.method === "GET" || request.method === "POST")
      && pathname === `${this.mcpPath}/oauth/authorize`) {
      return this.authorize(request);
    }
    if (request.method === "POST" && pathname === `${this.mcpPath}/oauth/token`) {
      return this.token(request);
    }
    return null;
  }

  private async register(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await requestText(request)) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(allowedRedirect)) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    const clientId = randomBytes(16).toString("hex");
    const client: RegisteredClient = {
      clientId,
      clientName: typeof body.client_name === "string" ? body.client_name : "ChatGPT",
      redirectUris: redirects,
    };
    this.clients[clientId] = client;
    this.saveClients();
    return json({
      client_id: clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, 201);
  }

  private async authorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const form = request.method === "GET"
      ? url.searchParams
      : new URLSearchParams(await requestText(request));
    const clientId = form.get("client_id") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const challenge = form.get("code_challenge") || "";
    const state = form.get("state") || "";
    const resource = form.get("resource");
    const client = this.clients[clientId];
    const recoverableClient = !client
      && recoverableClientId(clientId)
      && allowedRedirect(redirectUri);
    if ((!client && !recoverableClient)
      || (client && !client.redirectUris.includes(redirectUri))
      || form.get("response_type") !== "code"
      || form.get("code_challenge_method") !== "S256"
      || !challenge
      || (resource !== null && resource !== this.mcpUrl)) {
      return response(
        connectionRequestHelp(request, form, this),
        400,
        { "content-type": "text/html; charset=utf-8" },
      );
    }
    if (request.method === "GET") {
      const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
      return response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize local MCP</title><style>body{font:14px system-ui;background:#f5f5f5;margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(360px,calc(100% - 32px));background:white;border:1px solid #ddd;border-radius:14px;padding:22px;box-sizing:border-box}h1{font-size:18px;margin:0 0 8px}p{color:#666;line-height:1.5}input,button{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #ccc}button{margin-top:10px;background:#111;color:white;border-color:#111}</style></head><body><form class="card" method="post"><h1>Authorize local MCP</h1><p>${escapeHtml(client?.clientName ?? "ChatGPT")} wants access to this computer. Enter the passphrase shown in Codex Web GPT.</p>${hidden("client_id", clientId)}${hidden("redirect_uri", redirectUri)}${hidden("response_type", "code")}${hidden("code_challenge", challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", state)}<input name="passphrase" type="password" autocomplete="current-password" autofocus><button>Authorize</button></form></body></html>`, 200, { "content-type": "text/html; charset=utf-8" });
    }
    if (!safeEqual(form.get("passphrase"), this.passphrase)) {
      return response("Wrong passphrase", 401, { "content-type": "text/plain; charset=utf-8" });
    }
    if (recoverableClient) {
      this.clients[clientId] = {
        clientId,
        clientName: "ChatGPT",
        redirectUris: [redirectUri],
      };
      this.saveClients();
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("iss", this.issuer);
    if (state) redirect.searchParams.set("state", state);
    return response(null, 302, { location: redirect.toString() });
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await requestText(request));
    const clientId = form.get("client_id") || "";
    if (!this.clients[clientId]) return json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") || "";
      const entry = this.codes.get(code);
      this.codes.delete(code);
      if (!entry
        || entry.expiresAt <= Date.now()
        || entry.clientId !== clientId
        || entry.redirectUri !== form.get("redirect_uri")
        || createHash("sha256").update(form.get("code_verifier") || "").digest("base64url") !== entry.codeChallenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return this.issueTokens(clientId);
    }
    if (form.get("grant_type") === "refresh_token") {
      const refreshToken = form.get("refresh_token") || "";
      if (this.tokens.refresh[refreshToken]?.clientId !== clientId) {
        return json({ error: "invalid_grant" }, 400);
      }
      return this.issueTokens(clientId, refreshToken);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  private issueTokens(clientId: string, refreshToken = randomBytes(32).toString("base64url")): Response {
    const accessToken = randomBytes(32).toString("base64url");
    this.tokens.access[accessToken] = { clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
    this.tokens.refresh[refreshToken] = { clientId };
    this.saveTokens();
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1_000,
      refresh_token: refreshToken,
    });
  }
}
