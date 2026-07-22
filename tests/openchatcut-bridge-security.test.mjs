import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "vendor/openchatcut");
const patchPath = resolve(root, "patches/openchatcut/0003-secure-external-bridge.patch");
const embeddedBoundaryPatchPath = resolve(
  root,
  "patches/openchatcut/0007-secure-entire-embedded-surface.patch",
);
const revision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";

/** @param {string} command @param {string[]} args @param {string} cwd */
async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** @param {import("node:http").Server} server @returns {Promise<number>} */
function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("test server did not bind"));
      else resolveListen(address.port);
    });
  });
}

/** @param {import("node:http").Server} server @returns {Promise<void>} */
function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose(undefined)));
  });
}

/**
 * @param {string} origin
 * @param {string} path
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 * @returns {Promise<{status: number | undefined, headers: import("node:http").IncomingHttpHeaders, body: string}>}
 */
function send(origin, path, options = {}) {
  const target = new URL(path, origin);
  const body = options.body ?? "";
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(target, {
      method: options.method ?? "POST",
      headers: {
        ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    }, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

/** @param {any} plugin */
function mountPlugin(plugin) {
  /** @type {Array<{prefix: string, handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => void}>} */
  const routes = [];
  /** @type {any} */
  const fakeServer = {
    middlewares: {
      /**
       * @param {string} prefix
       * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => void} handler
       */
      use(prefix, handler) {
        routes.push({ prefix, handler });
      },
    },
    config: {
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
  };
  const hook = plugin.configureServer;
  const configure = typeof hook === "function" ? hook : hook?.handler;
  configure?.call(plugin, fakeServer);

  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const route = routes.find(({ prefix }) => path === prefix || path.startsWith(`${prefix}/`));
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    request.url = (request.url ?? "/").slice(route.prefix.length) || "/";
    route.handler(request, response, () => response.writeHead(404).end());
  });
}

test("the independent Host Patch authenticates every OpenChatCut bridge route", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-secure-bridge-"));
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const compiledRoot = await mkdtemp(resolve(root, ".scratch/secure-bridge-test-"));
  const mcpToken = "mcp-secret-for-negative-tests";
  const browserToken = "browser-secret-for-negative-tests";
  const previousMcpToken = process.env.OPENCHATCUT_MCP_TOKEN;
  const previousBrowserToken = process.env.OPENCHATCUT_BROWSER_TOKEN;
  const previousEditorUrl = process.env.OPENCHATCUT_EDITOR_URL;
  const originalDateNow = Date.now;
  /** @type {import("node:http").Server | undefined} */
  let server;
  /** @type {import("node:http").Server | undefined} */
  let boundaryServer;

  try {
    await run("git", ["clone", "--shared", "--no-checkout", upstream, temporaryRoot], root);
    await run("git", ["checkout", "--detach", revision], temporaryRoot);
    await run("git", ["apply", "--check", patchPath], temporaryRoot);
    await run("git", ["apply", patchPath], temporaryRoot);
    await run("git", ["apply", "--check", embeddedBoundaryPatchPath], temporaryRoot);
    await run("git", ["apply", embeddedBoundaryPatchPath], temporaryRoot);

    const serverSource = await readFile(
      resolve(temporaryRoot, "server/plugins/external-agent.ts"),
      "utf8",
    );
    const browserSource = await readFile(
      resolve(temporaryRoot, "src/agent/useExternalAgentBridge.ts"),
      "utf8",
    );
    const embeddedSource = await readFile(
      resolve(temporaryRoot, "desktop/embedded-server.ts"),
      "utf8",
    );
    assert.doesNotMatch(serverSource, /x-forwarded-(?:host|proto)/i);
    assert.doesNotMatch(browserSource, /OPENCHATCUT_MCP_TOKEN|authorization:\s*[`'"]/i);
    assert.doesNotMatch(browserSource, /[?&](?:token|capability)=/i);
    assert.match(browserSource, /\/api\/external-agent\/bootstrap/);
    assert.match(browserSource, /credentials:\s*'same-origin'/);
    assert.match(embeddedSource, /embeddedBrowserSecurityMiddleware/);
    assert.ok(
      embeddedSource.indexOf("app.use(embeddedBrowserSecurityMiddleware")
        < embeddedSource.indexOf("app.use('/assemblyai'"),
      "the embedded security boundary must run before the key-injecting AssemblyAI proxy",
    );
    assert.match(embeddedSource, /Remote URL import is disabled in Codex Host Mode/);
    assert.match(embeddedSource, /dynamicPath\(path\)/);

    const bundlePath = resolve(compiledRoot, "external-agent.mjs");
    await build({
      entryPoints: [resolve(temporaryRoot, "server/plugins/external-agent.ts")],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });

    process.env.OPENCHATCUT_MCP_TOKEN = mcpToken;
    process.env.OPENCHATCUT_BROWSER_TOKEN = browserToken;
    delete process.env.OPENCHATCUT_EDITOR_URL;
    const { externalAgentPlugin } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
    server = mountPlugin(externalAgentPlugin());
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;
    const browserHeaders = {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };

    for (const route of ["register", "poll", "result"]) {
      const response = await send(origin, `/api/external-agent/${route}`, {
        headers: browserHeaders,
        body: "this is deliberately not JSON",
      });
      assert.equal(response.status, 401, `${route} must authenticate before parsing its body`);
      assert.match(response.body, /browser capability/i);
      assert.doesNotMatch(response.body, /JSON|body/i);
    }

    process.env.OPENCHATCUT_EDITOR_URL = "https://attacker.example/editor";
    const missingMcp = await send(origin, "/api/external-mcp/mcp", {
      headers: { "content-type": "application/json" },
      body: "this is deliberately not MCP JSON",
    });
    assert.equal(missingMcp.status, 401);
    assert.match(missingMcp.body, /MCP credential/i);
    assert.doesNotMatch(missingMcp.body, /parse|JSON-RPC/i);

    const externalEditorOrigin = await send(origin, "/api/external-mcp/mcp", {
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
      },
      body: "this is deliberately not MCP JSON",
    });
    assert.equal(externalEditorOrigin.status, 500);
    assert.equal(externalEditorOrigin.body, '{"error":"MCP request failed"}');
    assert.doesNotMatch(externalEditorOrigin.body, /attacker\.example/);

    const wrongPort = port === 65_535 ? port - 1 : port + 1;
    process.env.OPENCHATCUT_EDITOR_URL = `http://127.0.0.1:${wrongPort}`;
    const mismatchedLoopbackOrigin = await send(origin, "/api/external-mcp/mcp", {
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
      },
      body: "this is deliberately not MCP JSON",
    });
    assert.equal(mismatchedLoopbackOrigin.status, 500);
    assert.equal(mismatchedLoopbackOrigin.body, '{"error":"MCP request failed"}');
    delete process.env.OPENCHATCUT_EDITOR_URL;

    const wrongMcp = await send(origin, "/api/external-agent/tools", {
      method: "GET",
      headers: { authorization: "Bearer wrong-secret" },
    });
    assert.equal(wrongMcp.status, 401);

    const wrongBrowser = await send(origin, "/api/external-agent/register", {
      headers: {
        ...browserHeaders,
        cookie: "openchatcut_browser_capability=wrong-secret",
      },
      body: JSON.stringify({ projectId: "project-1", editorId: "editor-1", tools: [] }),
    });
    assert.equal(wrongBrowser.status, 401);

    const invalidHost = await send(origin, "/api/external-agent/tools", {
      method: "GET",
      headers: {
        authorization: `Bearer ${mcpToken}`,
        host: `localhost:${port}`,
      },
    });
    assert.equal(invalidHost.status, 403);

    const crossOriginBootstrap = await send(origin, "/api/external-agent/bootstrap", {
      headers: {
        ...browserHeaders,
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(crossOriginBootstrap.status, 403);

    const crossSiteBootstrap = await send(origin, "/api/external-agent/bootstrap", {
      headers: {
        ...browserHeaders,
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    assert.equal(crossSiteBootstrap.status, 403);

    const bootstrap = await send(origin, "/api/external-agent/bootstrap", {
      headers: browserHeaders,
      body: "{}",
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body, '{"ok":true}');
    const setCookie = bootstrap.headers["set-cookie"]?.[0];
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /Max-Age=900/i);
    const browserCookie = setCookie.split(";", 1)[0];
    const browserCapability = browserCookie.slice(browserCookie.indexOf("=") + 1);
    assert.ok(browserCapability.length >= 32);
    assert.equal(browserCapability, browserToken);
    assert.notEqual(browserCapability, mcpToken);
    assert.doesNotMatch(bootstrap.body, new RegExp(browserCapability));

    const crossOriginWithCapability = await send(origin, "/api/external-agent/register", {
      headers: {
        ...browserHeaders,
        cookie: browserCookie,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ projectId: "project-1", editorId: "editor-1", tools: [] }),
    });
    assert.equal(crossOriginWithCapability.status, 403);

    const registered = await send(origin, "/api/external-agent/register", {
      headers: { ...browserHeaders, cookie: browserCookie },
      body: JSON.stringify({ projectId: "project-1", editorId: "editor-1", tools: [] }),
    });
    assert.equal(registered.status, 200);

    const tools = await send(origin, "/api/external-agent/tools", {
      method: "GET",
      headers: { authorization: `Bearer ${mcpToken}` },
    });
    assert.equal(tools.status, 200);
    assert.doesNotMatch(tools.body, new RegExp(`${mcpToken}|${browserCapability}`));

    const securityBundlePath = resolve(compiledRoot, "embedded-security.mjs");
    await build({
      entryPoints: [resolve(temporaryRoot, "server/external-agent/security.ts")],
      outfile: securityBundlePath,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    const {
      ExternalAgentSecurity,
      embeddedBrowserSecurityMiddleware,
    } = await import(`${pathToFileURL(securityBundlePath).href}?test=${Date.now()}`);
    let boundaryNow = originalDateNow();
    Date.now = () => boundaryNow;
    const embeddedSecurity = new ExternalAgentSecurity({
      mcpCredential: mcpToken,
      browserCredential: browserToken,
      capabilityTtlMs: 1_000,
    });
    const embeddedBoundary = embeddedBrowserSecurityMiddleware(embeddedSecurity);
    boundaryServer = createServer((request, response) => {
      embeddedBoundary(request, response, () => {
        if (request.url?.startsWith("/api/external-agent/bootstrap")) {
          const issued = embeddedSecurity.issueBrowserCapability(request, response);
          response.statusCode = issued.ok ? 200 : issued.status;
          response.end(JSON.stringify(issued.ok ? { ok: true } : { error: issued.error }));
          return;
        }
        response.statusCode = request.url?.startsWith("/api/external-mcp/mcp") ? 204 : 200;
        response.end("allowed");
      });
    });
    const boundaryPort = await listen(boundaryServer);
    const boundaryOrigin = `http://127.0.0.1:${boundaryPort}`;
    const sameOriginHeaders = {
      origin: boundaryOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    };

    const bootstrapWithoutNavigation = await send(
      boundaryOrigin,
      "/api/external-agent/bootstrap",
      {
        headers: sameOriginHeaders,
        body: "{}",
      },
    );
    assert.equal(
      bootstrapWithoutNavigation.status,
      401,
      "Codex Host Mode bootstrap must renew an existing navigation capability only",
    );

    const bareNavigation = await send(boundaryOrigin, "/", {
      method: "GET",
      headers: {
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    assert.equal(bareNavigation.status, 307);
    assert.equal(bareNavigation.headers.location, "/?host=codex");
    assert.notEqual(bareNavigation.body, "allowed");

    const navigation = await send(boundaryOrigin, "/?host=codex", {
      method: "GET",
      headers: {
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    assert.equal(navigation.status, 200);
    const navigationSetCookie = navigation.headers["set-cookie"]?.[0];
    assert.ok(navigationSetCookie);
    assert.match(
      navigationSetCookie,
      new RegExp(`^openchatcut_browser_capability_${boundaryPort}=`),
      "browser capabilities must be cookie-name scoped to the random sidecar port",
    );
    assert.match(navigationSetCookie, /HttpOnly/i);
    assert.match(navigationSetCookie, /SameSite=Strict/i);
    assert.match(navigationSetCookie, /Path=\//i);
    assert.equal(navigation.headers["x-frame-options"], "DENY");
    assert.equal(navigation.headers["cross-origin-opener-policy"], "same-origin");
    const navigationCookie = navigationSetCookie.split(";", 1)[0];

    for (const route of [
      "/api/keys",
      "/api/project-store/merge",
      "/upload",
      "/export",
      "/assemblyai/transcript",
      "/media/uploads/private.mp4",
    ]) {
      const crossSite = await send(boundaryOrigin, route, {
        headers: {
          ...sameOriginHeaders,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      });
      assert.equal(crossSite.status, 403, `${route} must reject cross-site access`);

      const missingCapability = await send(boundaryOrigin, route, {
        headers: sameOriginHeaders,
        body: "{}",
      });
      assert.equal(missingCapability.status, 401, `${route} must require the browser capability`);
    }

    const settingsWithCapability = await send(boundaryOrigin, "/api/keys", {
      headers: { ...sameOriginHeaders, cookie: navigationCookie },
      body: "{}",
    });
    assert.equal(settingsWithCapability.status, 200);

    boundaryNow += 900;
    const refreshedCapability = await send(
      boundaryOrigin,
      "/api/external-agent/bootstrap",
      {
        headers: {
          ...sameOriginHeaders,
          cookie: navigationCookie,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(refreshedCapability.status, 200);
    assert.match(refreshedCapability.headers["set-cookie"]?.[0] ?? "", /Path=\//i);
    boundaryNow += 200;
    const afterOriginalExpiry = await send(boundaryOrigin, "/api/project-store", {
      method: "GET",
      headers: { "sec-fetch-site": "same-origin", cookie: navigationCookie },
    });
    assert.equal(
      afterOriginalExpiry.status,
      200,
      "bootstrap must renew the root capability used by non-bridge routes",
    );
    const mediaWithCapability = await send(boundaryOrigin, "/media/uploads/private.mp4", {
      method: "GET",
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "video",
        cookie: navigationCookie,
      },
    });
    assert.equal(mediaWithCapability.status, 200);

    const mcpWithoutBrowserCookie = await send(boundaryOrigin, "/api/external-mcp/mcp", {
      headers: { authorization: `Bearer ${mcpToken}` },
      body: "{}",
    });
    assert.equal(mcpWithoutBrowserCookie.status, 204, "MCP bearer auth remains a separate boundary");
    const reboundMcp = await send(boundaryOrigin, "/api/external-mcp/mcp", {
      headers: { authorization: `Bearer ${mcpToken}`, host: `attacker.example:${boundaryPort}` },
      body: "{}",
    });
    assert.equal(reboundMcp.status, 403, "the global exact Host check precedes MCP bearer auth");
    await close(boundaryServer);
    boundaryServer = undefined;
    Date.now = originalDateNow;

    process.env.OPENCHATCUT_BROWSER_TOKEN = mcpToken;
    assert.throws(
      () => externalAgentPlugin(),
      /MCP and browser credentials must be different/,
    );
    process.env.OPENCHATCUT_BROWSER_TOKEN = browserToken;

    await close(server);
    server = undefined;
    let now = originalDateNow();
    Date.now = () => now;
    server = mountPlugin(externalAgentPlugin({ capabilityTtlMs: 1_000 }));
    const expiryPort = await listen(server);
    const expiryOrigin = `http://127.0.0.1:${expiryPort}`;
    const expiryHeaders = {
      origin: expiryOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const shortBootstrap = await send(expiryOrigin, "/api/external-agent/bootstrap", {
      headers: expiryHeaders,
      body: "{}",
    });
    assert.equal(shortBootstrap.status, 200);
    const shortCookie = shortBootstrap.headers["set-cookie"]?.[0].split(";", 1)[0];
    assert.ok(shortCookie);
    now += 1_001;
    const expiredCapability = await send(expiryOrigin, "/api/external-agent/register", {
      headers: { ...expiryHeaders, cookie: shortCookie },
      body: JSON.stringify({ projectId: "project-1", editorId: "editor-2", tools: [] }),
    });
    assert.equal(expiredCapability.status, 401);
    assert.match(expiredCapability.body, /browser capability/i);
  } finally {
    Date.now = originalDateNow;
    if (boundaryServer) await close(boundaryServer);
    if (server) await close(server);
    if (previousMcpToken === undefined) delete process.env.OPENCHATCUT_MCP_TOKEN;
    else process.env.OPENCHATCUT_MCP_TOKEN = previousMcpToken;
    if (previousBrowserToken === undefined) delete process.env.OPENCHATCUT_BROWSER_TOKEN;
    else process.env.OPENCHATCUT_BROWSER_TOKEN = previousBrowserToken;
    if (previousEditorUrl === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
    else process.env.OPENCHATCUT_EDITOR_URL = previousEditorUrl;
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(compiledRoot, { recursive: true, force: true });
  }
});
