import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runRealUpstream = process.env.CODEX_CHATCUT_REAL_UPSTREAM === "1";
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

/**
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 */
function send(url, options = {}) {
  const body = options.body ?? "";
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(new URL(url), {
      method: options.method ?? "GET",
      headers: {
        ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        ...options.headers,
      },
    }, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolveResponse({
          status: response.statusCode,
          headers: response.headers,
          body: bytes.toString("utf8"),
          bytes,
        });
      });
    });
    request.once("error", rejectResponse);
    request.end(body);
  });
}

/** @param {string} url */
async function eventuallyUnreachable(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail(`real OpenChatCut sidecar remained reachable: ${url}`);
}

/**
 * Each call creates a brand-new stdio MCP process and, once start_chatcut is
 * invoked, a brand-new OpenChatCut sidecar process.
 * @param {string} workspaceRoot
 * @param {string} preparedRoot
 * @param {string} name
 */
function createStdioSession(workspaceRoot, preparedRoot, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      CODEX_CHATCUT_PREPARED_ROOT: resolve(preparedRoot),
      CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot,
    },
  });
  const client = new Client({ name, version: "0.1.0" });
  return { client, transport };
}

test("the stdio proxy drives and restarts the real prepared OpenChatCut sidecar", {
  skip: runRealUpstream ? false : "set CODEX_CHATCUT_REAL_UPSTREAM=1 after preparing OpenChatCut",
  timeout: 60_000,
}, async () => {
  assert.equal(Number(process.versions.node.split(".")[0]), 24, "real upstream requires Node 24");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-real-workspace-"));
  const preparedRoot = process.env.CODEX_CHATCUT_PREPARED_ROOT?.trim();
  assert.ok(preparedRoot, "CODEX_CHATCUT_PREPARED_ROOT must select the reviewed prepared tree");
  const projectName = "Real OpenChatCut Integration";
  /** @type {string | undefined} */
  let projectId;

  try {
    const firstSession = createStdioSession(
      workspaceRoot,
      preparedRoot,
      "real-openchatcut-first-session-test",
    );
    let firstOrigin;
    try {
      await firstSession.client.connect(firstSession.transport);
      const started = await firstSession.client.callTool({ name: "start_chatcut", arguments: {} });
      assert.notEqual(started.isError, true, JSON.stringify(started.content));
      const startedData = /** @type {{origin?: unknown}} */ (started.structuredContent ?? {});
      firstOrigin = String(startedData.origin);
      assert.match(firstOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.doesNotMatch(JSON.stringify(started), /bearer|mcpToken|browserToken|secret/i);

      const tools = await firstSession.client.listTools();
      for (const name of ["list_projects", "create_project", "get_editor_url", "target_project"]) {
        assert.ok(tools.tools.some((tool) => tool.name === name), `${name} must come from OpenChatCut`);
      }

      const created = await firstSession.client.callTool({
        name: "create_project",
        arguments: { name: projectName },
      });
      assert.notEqual(created.isError, true, JSON.stringify(created.content));
      const project = /** @type {{id?: unknown, editorUrl?: unknown}} */ (
        created.structuredContent ?? {}
      );
      projectId = String(project.id);
      assert.match(projectId, /^[0-9a-f-]{36}$/i);
      assert.equal(
        project.editorUrl,
        `${firstOrigin}/?host=codex#/editor/${project.id}`,
      );
      assert.doesNotMatch(JSON.stringify(project), /bearer|token|secret/i);

      const bareEditor = /** @type {any} */ (await send(`${firstOrigin}/`, {
        headers: {
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }));
      assert.equal(bareEditor.status, 307);
      assert.equal(bareEditor.headers.location, "/?host=codex");
      assert.doesNotMatch(bareEditor.body, /<div id="root">/);

      const editor = /** @type {any} */ (await send(String(project.editorUrl), {
        headers: {
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }));
      assert.equal(editor.status, 200);
      assert.match(editor.body, /<div id="root"><\/div>/);
      const setCookie = editor.headers["set-cookie"]?.[0];
      assert.ok(setCookie);
      const sidecarPort = new URL(firstOrigin).port;
      assert.match(setCookie, new RegExp(`^openchatcut_browser_capability_${sidecarPort}=`));
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Path=\//i);
      const browserCookie = setCookie.split(";", 1)[0];
      const sameOriginRead = { "sec-fetch-site": "same-origin", cookie: browserCookie };
      const sameOriginWrite = {
        ...sameOriginRead,
        origin: firstOrigin,
        "content-type": "application/json",
      };

      const mediaName = "authenticated-range-probe.mp4";
      const mediaBytes = Buffer.from([
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d,
      ]);
      const uploadDirectory = join(
        workspaceRoot,
        ".codex-chatcut",
        "openchatcut",
        "public",
        "media",
        "uploads",
      );
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(join(uploadDirectory, mediaName), mediaBytes);

      const unauthenticatedMediaRange = /** @type {any} */ (await send(
        `${firstOrigin}/media/uploads/${mediaName}`,
        {
          headers: {
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "video",
            range: "bytes=2-5",
          },
        },
      ));
      assert.equal(
        unauthenticatedMediaRange.status,
        401,
        "the real upstream media route must reject Range reads without the browser capability",
      );

      const authenticatedMediaRange = /** @type {any} */ (await send(
        `${firstOrigin}/media/uploads/${mediaName}`,
        {
          headers: {
            ...sameOriginRead,
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "video",
            range: "bytes=2-5",
          },
        },
      ));
      assert.equal(authenticatedMediaRange.status, 206);
      assert.equal(authenticatedMediaRange.headers["accept-ranges"], "bytes");
      assert.equal(
        authenticatedMediaRange.headers["content-range"],
        `bytes 2-5/${mediaBytes.length}`,
      );
      assert.equal(authenticatedMediaRange.headers["content-length"], "4");
      assert.equal(authenticatedMediaRange.headers["x-content-type-options"], "nosniff");
      assert.deepEqual(authenticatedMediaRange.bytes, mediaBytes.subarray(2, 6));

      const unsatisfiableMediaRange = /** @type {any} */ (await send(
        `${firstOrigin}/media/uploads/${mediaName}`,
        {
          headers: {
            ...sameOriginRead,
            "sec-fetch-mode": "no-cors",
            "sec-fetch-dest": "video",
            range: `bytes=${mediaBytes.length + 10}-${mediaBytes.length + 20}`,
          },
        },
      ));
      assert.equal(unsatisfiableMediaRange.status, 416);
      assert.equal(
        unsatisfiableMediaRange.headers["content-range"],
        `bytes */${mediaBytes.length}`,
      );

      const scriptPath = /<script[^>]+src="([^"]+)"/.exec(editor.body)?.[1];
      assert.ok(scriptPath, "prepared editor HTML must reference its production script");
      const staticAsset = /** @type {any} */ (await send(`${firstOrigin}${scriptPath}`, {
        headers: sameOriginRead,
      }));
      assert.equal(staticAsset.status, 200, "browser capability must permit static subresources");

      const crossSiteSettings = /** @type {any} */ (await send(`${firstOrigin}/api/keys`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
        },
        body: '{"LLM_PROVIDER":"cross-site-write"}',
      }));
      assert.equal(crossSiteSettings.status, 403);

      const missingBrowserCapability = /** @type {any} */ (await send(
        `${firstOrigin}/api/project-store`,
        { headers: { "sec-fetch-site": "same-origin" } },
      ));
      assert.equal(missingBrowserCapability.status, 401);

      const settings = /** @type {any} */ (await send(`${firstOrigin}/api/keys`, {
        headers: sameOriginRead,
      }));
      assert.equal(settings.status, 200);

      const escapedMediaDirectory = /** @type {any} */ (await send(`${firstOrigin}/api/keys`, {
        method: "POST",
        headers: sameOriginWrite,
        body: JSON.stringify({ MEDIA_DIR: resolve(workspaceRoot, "..", "outside-chatcut") }),
      }));
      assert.equal(escapedMediaDirectory.status, 400);
      assert.match(escapedMediaDirectory.body, /Codex Host Mode|workspace/i);

      const remoteImport = /** @type {any} */ (await send(`${firstOrigin}/api/import-url`, {
        method: "POST",
        headers: sameOriginWrite,
        body: JSON.stringify({ url: "http://127.0.0.1:1/private" }),
      }));
      assert.equal(remoteImport.status, 403);
      assert.match(remoteImport.body, /disabled in Codex Host Mode/i);

      const svgUpload = /** @type {any} */ (await send(
        `${firstOrigin}/upload?name=payload.svg&assetId=active-content`,
        {
          method: "POST",
          headers: {
            ...sameOriginWrite,
            "content-type": "image/svg+xml",
          },
          body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        },
      ));
      assert.ok(svgUpload.status >= 400, `SVG upload unexpectedly returned ${svgUpload.status}`);

      const unknownDynamic = /** @type {any} */ (await send(`${firstOrigin}/api/state`, {
        headers: sameOriginRead,
      }));
      assert.equal(unknownDynamic.status, 404);
      assert.doesNotMatch(unknownDynamic.body, /<div id="root">/);

      const unknownRender = /** @type {any} */ (await send(
        `${firstOrigin}/render-attacker-controlled`,
        { headers: sameOriginRead },
      ));
      assert.equal(unknownRender.status, 404);
      assert.doesNotMatch(unknownRender.body, /<div id="root">/);

      const crossSiteAssembly = /** @type {any} */ (await send(`${firstOrigin}/assemblyai/v2/transcript`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-type": "text/plain",
        },
        body: "{}",
      }));
      assert.equal(crossSiteAssembly.status, 403);

      const unauthenticatedMcp = await fetch(`${firstOrigin}/api/external-mcp/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      assert.equal(unauthenticatedMcp.status, 401);
      assert.match(await unauthenticatedMcp.text(), /MCP credential/i);

      const unauthenticatedBrowser = /** @type {any} */ (await send(
        `${firstOrigin}/api/external-agent/register`,
        {
          method: "POST",
          headers: {
            origin: firstOrigin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: "not-json",
        },
      ));
      assert.equal(unauthenticatedBrowser.status, 401);
      assert.match(unauthenticatedBrowser.body, /browser capability/i);
    } finally {
      try {
        await firstSession.client.close();
      } finally {
        if (firstOrigin) await eventuallyUnreachable(`${firstOrigin}/`);
      }
    }

    assert.ok(projectId, "the first stdio session must create a project before restart");
    const secondSession = createStdioSession(
      workspaceRoot,
      preparedRoot,
      "real-openchatcut-second-session-test",
    );
    let secondOrigin;
    try {
      await secondSession.client.connect(secondSession.transport);
      const restarted = await secondSession.client.callTool({ name: "start_chatcut", arguments: {} });
      assert.notEqual(restarted.isError, true, JSON.stringify(restarted.content));
      const restartedData = /** @type {{origin?: unknown}} */ (restarted.structuredContent ?? {});
      secondOrigin = String(restartedData.origin);
      assert.match(secondOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.doesNotMatch(JSON.stringify(restarted), /bearer|mcpToken|browserToken|secret/i);

      const listed = await secondSession.client.callTool({
        name: "list_projects",
        arguments: {},
      });
      assert.notEqual(listed.isError, true, JSON.stringify(listed.content));
      assert.doesNotMatch(JSON.stringify(listed), /bearer|mcpToken|browserToken|token|secret/i);
      const listedData = /** @type {{result?: unknown}} */ (listed.structuredContent ?? {});
      const projects = /** @type {Array<{id?: unknown, name?: unknown}>} */ (
        listedData.result
      );
      assert.ok(Array.isArray(projects), "real upstream list_projects must return an array");
      assert.ok(
        projects.some((project) => project.id === projectId && project.name === projectName),
        "a fresh stdio MCP and sidecar must reopen projects from the same workspace",
      );
    } finally {
      try {
        await secondSession.client.close();
      } finally {
        if (secondOrigin) await eventuallyUnreachable(`${secondOrigin}/`);
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
