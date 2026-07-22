import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = resolve(root, "vendor/openchatcut");
const patchPath = resolve(root, "patches/openchatcut/0002-windowless-sidecar.patch");
const reviewedRevision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";

/**
 * @param {string[]} args
 * @param {string} cwd
 */
async function runGit(args, cwd) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("the windowless sidecar patch applies independently at the reviewed OpenChatCut pin", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "codex-chatcut-sidecar-patch-"));
  try {
    await runGit(["clone", "--shared", "--no-checkout", upstreamRoot, checkout], root);
    await runGit(["checkout", "--detach", reviewedRevision], checkout);
    await runGit(["apply", "--check", patchPath], checkout);
    await runGit(["apply", patchPath], checkout);

    assert.equal((await runGit(["rev-parse", "HEAD"], checkout)).stdout.trim(), reviewedRevision);
    const source = await readFile(resolve(checkout, "desktop/codex-sidecar.ts"), "utf8");

    assert.match(source, /await import\('\.\/embedded-server\.ts'\)/);
    assert.match(source, /startEmbeddedServer\(distDir\)/);
    assert.doesNotMatch(source, /from ['"]electron['"]|BrowserWindow|new BrowserWindow/);

    assert.match(source, /CODEX_CHATCUT_WORKSPACE_ROOT/);
    assert.match(source, /OPENCHATCUT_DATA_ROOT/);
    assert.match(source, /process\.chdir\(dataRoot\)/);
    assert.match(source, /process\.env\.HOME = dataRoot/);
    assert.match(source, /process\.env\.USERPROFILE = dataRoot/);

    assert.match(source, /type: 'openchatcut-ready'/);
    assert.match(source, /process\.send/);
    assert.match(source, /process\.stderr\.write/);
    assert.doesNotMatch(source, /process\.stdout|console\.log/);

    for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) {
      assert.match(source, new RegExp(`process\\.once\\('${signal}'`));
    }
    assert.match(source, /target\.close\(/);
    assert.match(source, /target\.closeAllConnections\(\)/);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("the patched entry reports an ephemeral loopback origin and closes it on SIGTERM", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "codex-chatcut-sidecar-runtime-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-sidecar-workspace-"));
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  /** @type {string | undefined} */
  let origin;
  try {
    await runGit(["clone", "--shared", "--no-checkout", upstreamRoot, checkout], root);
    await runGit(["checkout", "--detach", reviewedRevision], checkout);
    await runGit(["apply", patchPath], checkout);

    const distDir = resolve(checkout, "dist");
    const dataRoot = resolve(workspaceRoot, ".codex-chatcut/openchatcut");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      resolve(checkout, "desktop/embedded-server.ts"),
      `import { createServer } from 'node:http';
export async function startEmbeddedServer(_distDir) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME }));
  });
  const port = await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
  });
  return { server, port, origin: \`http://127.0.0.1:\${port}\` };
}
`,
    );

    let stdout = "";
    let stderr = "";
    const launched = fork(resolve(checkout, "desktop/codex-sidecar.ts"), [], {
      cwd: checkout,
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      env: {
        ...process.env,
        CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot,
        OPENCHATCUT_DATA_ROOT: dataRoot,
        OPENCHATCUT_DIST_DIR: distDir,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = launched;
    assert.ok(launched.stdout);
    assert.ok(launched.stderr);
    launched.stdout.on("data", (chunk) => { stdout += String(chunk); });
    launched.stderr.on("data", (chunk) => { stderr += String(chunk); });

    /** @type {Promise<{ type: "openchatcut-ready"; origin: string }>} */
    const readyMessage = new Promise((resolveReady, rejectReady) => {
      launched.once("error", rejectReady);
      launched.once("exit", (code, signal) => {
        rejectReady(new Error(`sidecar exited before readiness (${code ?? signal}): ${stderr}`));
      });
      launched.on("message", (message) => {
        if (
          message
          && typeof message === "object"
          && "type" in message
          && message.type === "openchatcut-ready"
          && "origin" in message
          && typeof message.origin === "string"
        ) {
          resolveReady({ type: "openchatcut-ready", origin: message.origin });
        }
      });
    });
    /** @type {Promise<never>} */
    const readyTimeout = new Promise((_, rejectTimeout) => {
      const timer = setTimeout(
        () => rejectTimeout(new Error(`sidecar readiness timed out: ${stderr}`)),
        5_000,
      );
      timer.unref();
    });
    const ready = await Promise.race([readyMessage, readyTimeout]);
    origin = ready.origin;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(origin).port, "0");
    assert.equal(stdout, "");

    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      cwd: await realpath(dataRoot),
      home: await realpath(dataRoot),
    });

    launched.kill("SIGTERM");
    const [code, signal] = await once(launched, "exit");
    assert.equal(code, 0, `unexpected sidecar exit (${code ?? signal}): ${stderr}`);
    child = undefined;
    await assert.rejects(fetch(origin));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(checkout, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
