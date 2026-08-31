import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { McpOAuthServer, ensureMcpOAuthCredentials } from "../src/mcp-oauth";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-oauth-test-"));
  roots.push(root);
  return root;
}

describe("MCP OAuth DCR", () => {
  test("creates private persistent credentials", () => {
    const home = tempHome();
    const first = ensureMcpOAuthCredentials(home);
    const second = ensureMcpOAuthCredentials(home);
    expect(second.passphrase).toBe(first.passphrase);
    expect(readFileSync(first.paths.passphrase, "utf8").trim()).toBe(first.passphrase);
    if (process.platform !== "win32") {
      expect(statSync(first.paths.directory).mode & 0o777).toBe(0o700);
      expect(statSync(first.paths.passphrase).mode & 0o777).toBe(0o600);
      expect(statSync(first.paths.clients).mode & 0o777).toBe(0o600);
      expect(statSync(first.paths.tokens).mode & 0o777).toBe(0o600);
    }
  });

  test("requires passphrase consent and PKCE before a ChatGPT DCR client receives a bearer token", async () => {
    const home = tempHome();
    const oauth = new McpOAuthServer("https://mcp.example.com", `/mcp/${"a".repeat(43)}`, home);
    const passphrase = ensureMcpOAuthCredentials(home).passphrase;
    const callback = "https://chatgpt.com/connector/oauth/test-instance";

    const protectedMetadata = await oauth.handle(
      new Request(`https://mcp.example.com${oauth.protectedResourceMetadataPath}`),
      oauth.protectedResourceMetadataPath,
    );
    expect(await protectedMetadata!.json()).toEqual({
      resource: oauth.mcpUrl,
      authorization_servers: [oauth.issuer],
    });

    const rejected = await oauth.handle(new Request(oauth.registrationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://attacker.invalid/callback"] }),
    }), `${oauth.mcpPath}/oauth/register`);
    expect(rejected?.status).toBe(400);

    const registered = await oauth.handle(new Request(oauth.registrationUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "XR Local MCP",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      }),
    }), `${oauth.mcpPath}/oauth/register`);
    expect(registered?.status).toBe(201);
    const client = await registered!.json() as { client_id: string };

    const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${oauth.issuer}/oauth/authorize`);
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "state-test");
    const consent = await oauth.handle(new Request(authorize), `${oauth.mcpPath}/oauth/authorize`);
    expect(consent?.status).toBe(200);
    expect(await consent!.text()).toContain("Authorize local MCP");

    const approvalBody = new URLSearchParams(authorize.searchParams);
    approvalBody.set("passphrase", passphrase);
    const approved = await oauth.handle(new Request(authorize, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalBody,
      redirect: "manual",
    }), `${oauth.mcpPath}/oauth/authorize`);
    expect(approved?.status).toBe(302);
    const redirect = new URL(approved!.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(callback);
    expect(redirect.searchParams.get("state")).toBe("state-test");

    const token = await oauth.handle(new Request(`${oauth.issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: redirect.searchParams.get("code")!,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    }), `${oauth.mcpPath}/oauth/token`);
    expect(token?.status).toBe(200);
    const credentials = await token!.json() as { access_token: string; refresh_token: string };
    expect(oauth.verify(new Request(oauth.mcpUrl, {
      headers: { authorization: `Bearer ${credentials.access_token}` },
    }))).toBeTrue();
    expect(oauth.verify(new Request(oauth.mcpUrl))).toBeFalse();

    const refreshed = await oauth.handle(new Request(`${oauth.issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: credentials.refresh_token,
      }),
    }), `${oauth.mcpPath}/oauth/token`);
    expect(refreshed?.status).toBe(200);
  });

  test("recovers a saved ChatGPT public client only after passphrase consent", async () => {
    const home = tempHome();
    const oauth = new McpOAuthServer("https://mcp.example.com", `/mcp/${"a".repeat(43)}`, home);
    const credentials = ensureMcpOAuthCredentials(home);
    const clientId = "b".repeat(32);
    const callback = "https://chatgpt.com/connector/oauth/existing-instance";
    const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${oauth.issuer}/oauth/authorize`);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "state-test");

    const consent = await oauth.handle(new Request(authorize), `${oauth.mcpPath}/oauth/authorize`);
    expect(consent?.status).toBe(200);
    expect(JSON.parse(readFileSync(credentials.paths.clients, "utf8"))).toEqual({});

    const wrongBody = new URLSearchParams(authorize.searchParams);
    wrongBody.set("passphrase", "wrong-passphrase");
    const denied = await oauth.handle(new Request(authorize, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: wrongBody,
    }), `${oauth.mcpPath}/oauth/authorize`);
    expect(denied?.status).toBe(401);
    expect(JSON.parse(readFileSync(credentials.paths.clients, "utf8"))).toEqual({});

    const approvalBody = new URLSearchParams(authorize.searchParams);
    approvalBody.set("passphrase", credentials.passphrase);
    const approved = await oauth.handle(new Request(authorize, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: approvalBody,
      redirect: "manual",
    }), `${oauth.mcpPath}/oauth/authorize`);
    expect(approved?.status).toBe(302);
    expect(JSON.parse(readFileSync(credentials.paths.clients, "utf8"))).toEqual({
      [clientId]: {
        clientId,
        clientName: "ChatGPT",
        redirectUris: [callback],
      },
    });

    const restarted = new McpOAuthServer("https://mcp.example.com", oauth.mcpPath, home);
    const resumed = await restarted.handle(new Request(authorize), `${oauth.mcpPath}/oauth/authorize`);
    expect(resumed?.status).toBe(200);
  });

  test("does not recover malformed clients or non-ChatGPT redirects", async () => {
    const oauth = new McpOAuthServer("https://mcp.example.com", `/mcp/${"a".repeat(43)}`, tempHome());
    const authorize = new URL(`${oauth.issuer}/oauth/authorize`);
    authorize.searchParams.set("client_id", "not-a-client-id");
    authorize.searchParams.set("redirect_uri", "https://attacker.invalid/callback");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("code_challenge", "challenge");
    authorize.searchParams.set("code_challenge_method", "S256");

    const rejected = await oauth.handle(new Request(authorize), `${oauth.mcpPath}/oauth/authorize`);
    expect(rejected?.status).toBe(400);
    const help = await rejected!.text();
    expect(help).toContain("Reconnect from ChatGPT");
    expect(help).toContain("Open ChatGPT connector settings");
    expect(help).toContain(oauth.mcpUrl);
    expect(help).toContain(oauth.registrationUrl);

    authorize.searchParams.set("ui_locales", "zh-CN");
    const localized = await oauth.handle(new Request(authorize), `${oauth.mcpPath}/oauth/authorize`);
    expect(localized?.status).toBe(400);
    const localizedHelp = await localized!.text();
    expect(localizedHelp).toContain("需要从 ChatGPT 重新连接");
    expect(localizedHelp).toContain("打开 ChatGPT 连接器设置");
    expect(localizedHelp).toContain("无需先删除原连接器");
  });
});
