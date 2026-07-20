// @ts-check

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectUpstream, readUpstreamLock } from "./verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function patchDigest(patches) {
  const hash = createHash("sha256");
  for (const patch of patches) {
    hash.update(patch);
    hash.update("\0");
    hash.update(await readFile(resolve(root, patch)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function prepareOpenChatCut(options = {}) {
  await inspectUpstream();
  const lock = await readUpstreamLock();
  const digest = await patchDigest(lock.patches);
  const runtimeRoot = resolve(root, ".runtime");
  const target = resolve(
    runtimeRoot,
    `openchatcut-${lock.revision.slice(0, 12)}-${digest.slice(0, 12)}`,
  );
  const markerPath = resolve(target, ".codex-chatcut-prepared.json");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

  if (!(await pathExists(target))) {
    await run(
      "git",
      ["clone", "--shared", "--no-checkout", resolve(root, "vendor/openchatcut"), target],
      root,
    );
    await run("git", ["checkout", "--detach", lock.revision], target);
    for (const patch of lock.patches) {
      await run("git", ["apply", resolve(root, patch)], target);
    }
    await writeFile(
      markerPath,
      `${JSON.stringify({ revision: lock.revision, patchDigest: digest, patches: lock.patches }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } else {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.revision !== lock.revision || marker.patchDigest !== digest) {
      throw new Error(`Prepared OpenChatCut directory has an unexpected marker: ${target}`);
    }
  }

  if (options.build) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major !== lock.nodeMajor) {
      throw new Error(`OpenChatCut build requires Node ${lock.nodeMajor}; current Node is ${process.version}.`);
    }
    await run("npm", ["ci"], target);
    await run("npm", ["run", "build"], target);
  }

  return { target, revision: lock.revision, patchDigest: digest, built: options.build === true };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await prepareOpenChatCut({ build: process.argv.includes("--build") });
  console.log(JSON.stringify(result, null, 2));
}
