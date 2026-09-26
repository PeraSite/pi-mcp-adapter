import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import { getAuthEntry, getAuthEntryFilePath, resetAuthEntryCache, saveAuthEntry } from "../mcp-auth.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";

const serverUrl = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";
const storage = { credentialStore: "file" as const };
const clientInfo = { clientId: "client", redirectUris: ["http://localhost:49001/callback"], issuer };

describe("OAuth credentials shared by Pi processes", () => {
  const originalDir = process.env.MCP_OAUTH_DIR;
  const originalDisable = process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-shared-auth-"));
    process.env.MCP_OAUTH_DIR = dir;
    delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
    resetAuthEntryCache();
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = originalDir;
    if (originalDisable === undefined) delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
    else process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = originalDisable;
    resetAuthEntryCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function replaceFromOtherProcess(accessToken: string, refreshToken = "new-refresh"): void {
    const file = getAuthEntryFilePath("shared", storage);
    writeFileSync(`${file}.replacement`, JSON.stringify({
      serverUrl, clientInfo, tokens: { accessToken, refreshToken, issuer },
    }), { mode: 0o600 });
    renameSync(`${file}.replacement`, file);
  }

  it("sees external rotation and logout without retrying a consumed refresh token", async () => {
    saveAuthEntry("shared", { clientInfo, tokens: { accessToken: "old", refreshToken: "old-refresh" } }, serverUrl, storage);
    const provider = new McpOAuthProvider("shared", serverUrl, {}, { onRedirect() {} }, storage);
    expect((await provider.tokens())?.access_token).toBe("old");
    replaceFromOtherProcess("new");
    expect((await provider.tokens({ issuer }))?.refresh_token).toBe("new-refresh");
    rmSync(getAuthEntryFilePath("shared", storage));
    expect(await provider.tokens()).toBeUndefined();
  });

  it("sees an external login after an absent read", () => {
    saveAuthEntry("shared", { clientInfo }, serverUrl, storage);
    const file = getAuthEntryFilePath("shared", storage);
    rmSync(file);
    resetAuthEntryCache();
    expect(getAuthEntry("shared", storage)).toBeUndefined();
    replaceFromOtherProcess("new");
    expect(getAuthEntry("shared", storage)?.tokens?.accessToken).toBe("new");
  });

  it("retries invalid_grant with the replacement grant, not a newly registered client", async () => {
    saveAuthEntry("shared", {
      clientInfo, tokens: { accessToken: "old", refreshToken: "old-refresh", issuer },
    }, serverUrl, storage);
    const provider = new McpOAuthProvider("shared", serverUrl, {}, { onRedirect() {} }, storage);
    await provider.saveDiscoveryState({
      authorizationServerUrl: issuer,
      resourceMetadata: { resource: serverUrl },
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    });
    const requests: string[] = [];
    const result = await auth(provider, {
      serverUrl,
      fetchFn: async (input, init) => {
        requests.push(String(input));
        expect(String(input)).toBe(`${issuer}/token`);
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("client_id")).toBe("client");
        if (requests.length === 1) {
          expect(params.get("refresh_token")).toBe("old-refresh");
          replaceFromOtherProcess("new");
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        expect(params.get("refresh_token")).toBe("new-refresh");
        return Response.json({ access_token: "final", refresh_token: "final-refresh", token_type: "Bearer" });
      },
    });
    expect(result).toBe("AUTHORIZED");
    expect(requests).toHaveLength(2);
    expect(getAuthEntry("shared", storage)?.clientInfo?.clientId).toBe("client");
    expect(getAuthEntry("shared", storage)?.tokens?.refreshToken).toBe("final-refresh");
  });
});
