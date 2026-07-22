import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "vendor/openchatcut");
const revision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";
const patches = [
  "0001-editor-only-codex-host.patch",
  "0002-windowless-sidecar.patch",
  "0003-secure-external-bridge.patch",
  "0004-reuse-native-proposals.patch",
  "0005-codex-editor-url.patch",
  "0006-cancellable-external-calls.patch",
].map((name) => resolve(root, "patches/openchatcut", name));

/** @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

test("the pinned bridge cancels queued and dispatched calls before editor execution", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-cancellable-patch-"));
  const checkout = join(temporaryRoot, "openchatcut");
  await mkdir(resolve(root, ".scratch"), { recursive: true });
  const compiledRoot = await mkdtemp(resolve(root, ".scratch/cancellable-patch-test-"));

  try {
    await git(["clone", "--shared", "--no-checkout", upstream, checkout], root);
    await git(["checkout", "--detach", revision], checkout);
    for (const patchPath of patches) {
      await git(["apply", "--check", patchPath], checkout);
      await git(["apply", patchPath], checkout);
    }
    await git(["diff", "--check"], checkout);

    const brokerSource = await readFile(
      resolve(checkout, "server/external-agent/broker.ts"),
      "utf8",
    );
    const mcpSource = await readFile(
      resolve(checkout, "server/external-agent/mcp.ts"),
      "utf8",
    );
    const pluginSource = await readFile(
      resolve(checkout, "server/plugins/external-agent.ts"),
      "utf8",
    );
    const bridgeSource = await readFile(
      resolve(checkout, "src/agent/useExternalAgentBridge.ts"),
      "utf8",
    );
    assert.match(brokerSource, /options\.signal\?\.addEventListener\('abort'/);
    assert.match(brokerSource, /export function claimEditorCall/);
    assert.match(mcpSource, /sessionIdGenerator:\s*randomUUID/);
    assert.match(mcpSource, /extra\.signal/);
    assert.match(pluginSource, /url\.pathname === '\/claim'/);
    assert.match(bridgeSource, /if \(!await claimCall\(call\.id\)\) return/);
    assert.match(
      bridgeSource,
      /sendResult[\s\S]*?response\.status === 404[\s\S]*?return false/,
      "a broker-discarded late result must not restart the browser bridge",
    );

    const outfile = resolve(compiledRoot, "broker-check.mjs");
    await build({
      entryPoints: [resolve(checkout, "server/external-agent/broker.check.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(compiledRoot, { recursive: true, force: true });
  }
});
