// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectUpstream, readUpstreamLock } from "./verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREPARED_MARKER_NAME = ".codex-chatcut-prepared.json";
const GENERATED_RUNTIME_ENTRIES = new Set([
  ".git",
  ".scratch",
  ".codex-chatcut",
  ".runtime",
  "tests",
  "dist",
  "node_modules",
]);

/** @param {string} command @param {string[]} args @param {string} cwd */
async function run(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/** @param {string} path */
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

/** @param {string} markerPath @param {Record<string, unknown>} marker */
async function writeMarkerAtomically(markerPath, marker) {
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, markerPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** @param {string} lockPath */
async function acquirePrepareLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `OpenChatCut runtime is already being prepared: ${lockPath}. ` +
        "If no prepare process is active, remove this exact stale lock file and retry.",
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true });
  };
}

/**
 * @param {string} target
 * @param {number} nodeMajor
 * @param {unknown} cause
 */
function incompletePreparedTargetError(target, nodeMajor, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Prepared OpenChatCut directory is incomplete or inconsistent: ${target}. ` +
    `Remove this exact directory and rerun with Node ${nodeMajor}: ` +
    `node scripts/prepare-openchatcut.mjs --build. ${detail}`,
    { cause },
  );
}

/** @param {string[]} patches */
export async function calculatePatchDigest(patches) {
  const hash = createHash("sha256");
  for (const patch of patches) {
    hash.update(patch);
    hash.update("\0");
    hash.update(await readFile(resolve(root, patch)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Hash the canonical patched source while excluding generated dependencies,
 * build output, Git metadata, and the self-describing marker. This makes a
 * prepared runtime reject source edits made after its reviewed build.
 * @param {string} runtimeRoot
 */
export async function calculatePreparedSourceDigest(runtimeRoot) {
  const hash = createHash("sha256");
  const canonicalRoot = resolve(runtimeRoot);

  /** @param {string} path */
  async function hashEntry(path) {
    const relativePath = relative(canonicalRoot, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isDirectory()) {
      hash.update(`D\0${relativePath}\0`);
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) await hashEntry(resolve(path, entry.name));
      return;
    }
    if (info.isFile()) {
      hash.update(`F\0${relativePath}\0${info.mode & 0o777}\0`);
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      hash.update("\0");
      return;
    }
    if (info.isSymbolicLink()) {
      hash.update(`L\0${relativePath}\0${await readlink(path)}\0`);
      return;
    }
    throw new Error(`Unsupported prepared source entry: ${path}`);
  }

  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.name === PREPARED_MARKER_NAME || GENERATED_RUNTIME_ENTRIES.has(entry.name)) continue;
    await hashEntry(resolve(canonicalRoot, entry.name));
  }
  return hash.digest("hex");
}

/**
 * @param {string} target
 * @param {{revision: string, patches: string[]}} lock
 * @param {Record<string, unknown>} markerBase
 */
async function initializePreparedTarget(target, lock, markerBase) {
  await run(
    "git",
    ["clone", "--shared", "--no-checkout", resolve(root, "vendor/openchatcut"), target],
    root,
  );
  await run("git", ["checkout", "--detach", lock.revision], target);
  for (const patch of lock.patches) await run("git", ["apply", resolve(root, patch)], target);
  const sourceDigest = await calculatePreparedSourceDigest(target);
  await writeMarkerAtomically(resolve(target, PREPARED_MARKER_NAME), {
    ...markerBase,
    sourceDigest,
    built: false,
  });
  return sourceDigest;
}

/** @param {string} current @param {string} replacement */
async function replacePreparedTarget(current, replacement) {
  const backup = `${current}.previous.${process.pid}.${randomUUID()}`;
  await rename(current, backup);
  try {
    await rename(replacement, current);
  } catch (error) {
    await rename(backup, current);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

/** @param {{build?: boolean}} [options] */
export async function prepareOpenChatCut(options = {}) {
  await inspectUpstream();
  const lock = await readUpstreamLock();
  const digest = await calculatePatchDigest(lock.patches);
  const runtimeRoot = resolve(root, ".runtime");
  const target = resolve(
    runtimeRoot,
    `openchatcut-${lock.revision.slice(0, 12)}-${digest.slice(0, 12)}`,
  );
  const markerPath = resolve(target, PREPARED_MARKER_NAME);
  const markerBase = {
    revision: lock.revision,
    patchDigest: digest,
    patches: lock.patches,
    nodeMajor: lock.nodeMajor,
  };
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const releasePrepareLock = await acquirePrepareLock(`${target}.prepare.lock`);

  try {
    const targetExisted = await pathExists(target);
    if (!targetExisted) {
      try {
        await initializePreparedTarget(target, lock, markerBase);
      } catch (error) {
        if (await pathExists(target)) {
          throw incompletePreparedTargetError(target, lock.nodeMajor, error);
        }
        throw error;
      }
    } else {
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8"));
        if (
          marker.revision !== lock.revision ||
          marker.patchDigest !== digest ||
          JSON.stringify(marker.patches) !== JSON.stringify(lock.patches) ||
          (marker.nodeMajor !== undefined && marker.nodeMajor !== lock.nodeMajor)
        ) {
          throw new Error("prepared marker does not match the current revision and Host Patch digest");
        }
        if (
          !options.build &&
          marker.built === true &&
          (typeof marker.sourceDigest !== "string" ||
            marker.sourceDigest !== await calculatePreparedSourceDigest(target))
        ) {
          throw new Error("prepared source does not match its canonical build digest");
        }
      } catch (error) {
        throw incompletePreparedTargetError(target, lock.nodeMajor, error);
      }
    }

    if (options.build) {
      const major = Number(process.versions.node.split(".")[0]);
      if (major !== lock.nodeMajor) {
        throw new Error(`OpenChatCut build requires Node ${lock.nodeMajor}; current Node is ${process.version}.`);
      }

      const buildTarget = targetExisted
        ? `${target}.rebuild.${process.pid}.${randomUUID()}`
        : target;
      try {
        if (targetExisted) {
          await writeMarkerAtomically(markerPath, { ...markerBase, built: false });
          await initializePreparedTarget(buildTarget, lock, markerBase);
        }
        await run("npm", ["ci"], buildTarget);
        await run("npm", ["run", "build"], buildTarget);
        const sourceDigest = await calculatePreparedSourceDigest(buildTarget);
        await writeMarkerAtomically(resolve(buildTarget, PREPARED_MARKER_NAME), {
          ...markerBase,
          sourceDigest,
          builtWithNode: process.version,
          built: true,
        });
        if (targetExisted) await replacePreparedTarget(target, buildTarget);
      } catch (error) {
        if (targetExisted) await rm(buildTarget, { recursive: true, force: true });
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `OpenChatCut rebuild failed; prepared runtime remains built:false at ${target}: ${detail}`,
          { cause: error },
        );
      }
    }

    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return { target, revision: lock.revision, patchDigest: digest, built: marker.built === true };
  } finally {
    await releasePrepareLock();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await prepareOpenChatCut({ build: process.argv.includes("--build") });
  console.log(JSON.stringify(result, null, 2));
}
