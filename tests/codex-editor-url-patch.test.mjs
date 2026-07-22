import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "vendor/openchatcut");
const patchPath = resolve(root, "patches/openchatcut/0005-codex-editor-url.patch");
const revision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";

/** @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

test("Codex editor URLs stay credential-free, loopback, and in editor-only Host Mode", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "codex-chatcut-editor-url-"));
  const bundleRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-editor-url-bundle-"));
  try {
    await git(["clone", "--shared", "--no-checkout", upstream, checkout], root);
    await git(["checkout", "--detach", revision], checkout);
    await git(["apply", "--check", patchPath], checkout);
    await git(["apply", patchPath], checkout);

    const output = resolve(bundleRoot, "editor-url.mjs");
    await build({
      entryPoints: [resolve(checkout, "server/external-agent/editor-url.ts")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const { externalEditorUrl } = await import(`${pathToFileURL(output).href}?t=${Date.now()}`);

    const loopback = "http://127.0.0.1:54321";
    assert.equal(
      externalEditorUrl({ editorBaseUrl: "https://attacker.example/?token=secret" }, "project / 1", loopback, "codex"),
      `${loopback}/?host=codex#/editor/project%20%2F%201`,
    );
    assert.equal(
      externalEditorUrl({ editorBaseUrl: "https://editor.example" }, "project-2", loopback, "standalone"),
      "https://editor.example/#/editor/project-2",
    );
    assert.doesNotMatch(
      externalEditorUrl({}, "project-3", loopback, "codex"),
      /token|secret|attacker/i,
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(bundleRoot, { recursive: true, force: true });
  }
});
