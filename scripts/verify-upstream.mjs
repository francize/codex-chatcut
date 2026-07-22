// @ts-check

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = resolve(root, "vendor/openchatcut");

/**
 * @typedef {{repository: string, revision: string, nodeMajor: number, patches: string[]}}
 * UpstreamLock
 */

/** @param {string[]} args @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options] */
async function runGit(args, options = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd ?? root,
      env: options.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

/** @param {UpstreamLock} lock */
async function verifyPatchSeries(lock) {
  const scratch = await mkdtemp(join(tmpdir(), "codex-chatcut-patch-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: resolve(scratch, "index") };
  try {
    await runGit(["read-tree", lock.revision], { cwd: upstreamRoot, env });
    for (const patchPath of lock.patches) {
      if (!patchPath.startsWith("patches/openchatcut/") || !patchPath.endsWith(".patch")) {
        throw new Error(`Unsafe Host Patch path in UPSTREAM.json: ${patchPath}`);
      }
      const absolutePatch = resolve(root, patchPath);
      await runGit(["apply", "--cached", "--check", absolutePatch], { cwd: upstreamRoot, env });
      await runGit(["apply", "--cached", absolutePatch], { cwd: upstreamRoot, env });
    }
    await runGit(["diff", "--cached", "--check"], { cwd: upstreamRoot, env });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function readUpstreamLock() {
  const lock = /** @type {UpstreamLock} */ (
    JSON.parse(await readFile(resolve(root, "UPSTREAM.json"), "utf8"))
  );
  if (
    typeof lock.repository !== "string" ||
    !/^[0-9a-f]{40}$/.test(lock.revision) ||
    !Number.isInteger(lock.nodeMajor) ||
    !Array.isArray(lock.patches) ||
    !lock.patches.every((entry) => typeof entry === "string")
  ) {
    throw new Error("UPSTREAM.json does not match the expected lock format.");
  }
  return lock;
}

/** @param {{expectedRevision?: string}} [options] */
export async function inspectUpstream(options = {}) {
  const lock = await readUpstreamLock();
  const expectedRevision = options.expectedRevision ?? lock.revision;
  const revision = await runGit(["rev-parse", "HEAD"], { cwd: upstreamRoot });
  if (revision !== expectedRevision) {
    throw new Error(
      `OpenChatCut revision ${revision} does not match the reviewed pin ${expectedRevision}.`,
    );
  }

  const remote = await runGit(["remote", "get-url", "origin"], { cwd: upstreamRoot });
  if (remote !== lock.repository) {
    throw new Error(`OpenChatCut remote ${remote} does not match ${lock.repository}.`);
  }

  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: upstreamRoot,
  });
  if (status) throw new Error(`OpenChatCut submodule is dirty:\n${status}`);

  await verifyPatchSeries(lock);

  return {
    repository: lock.repository,
    revision,
    remote,
    clean: true,
    nodeMajor: lock.nodeMajor,
    patches: [...lock.patches],
    patchOrderVerified: true,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const report = await inspectUpstream();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(`OK: OpenChatCut ${report.revision} is clean, pinned, and patchable.`);
}
