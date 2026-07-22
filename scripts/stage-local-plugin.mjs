// @ts-check

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { calculatePreparedSourceDigest } from "./prepare-openchatcut.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_SEGMENTS = new Set([".git", ".scratch", ".codex-chatcut", ".runtime", "tests"]);
const ROOT_FILES = [
  ".mcp.json",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "UPSTREAM.json",
  "package-lock.json",
  "package.json",
];
const RUNTIME_SUPPORT_FILES = [
  "scripts/prepare-openchatcut.mjs",
  "scripts/verify-upstream.mjs",
];
const STAGED_TOP_LEVEL = [
  ".codex-chatcut-local-stage.json",
  ".codex-plugin",
  ".mcp.json",
  ".runtime",
  ...ROOT_FILES.filter((path) => path !== ".mcp.json"),
  "mcp",
  "node_modules",
  "patches",
  "scripts",
  "skills",
].sort();

/** @param {string} path */
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild === "" || (!pathToChild.startsWith("..") && !isAbsolute(pathToChild));
}

/** @param {string} sourceRoot @param {string} path */
function resolveSourcePath(sourceRoot, path) {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error(`Unsafe staging source path: ${path}`);
  }
  const target = resolve(sourceRoot, path);
  if (!isInside(sourceRoot, target)) throw new Error(`Staging source escaped checkout: ${path}`);
  return target;
}

/** @param {string} path @param {string} label */
async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Local plugin staging requires ${label}: ${path}`);
    }
    throw error;
  }
  if (!info.isFile()) throw new Error(`Local plugin staging requires a regular ${label}: ${path}`);
}

/** @param {string} path @param {string} label */
async function requireDirectory(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`Local plugin staging requires ${label}: ${path}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Local plugin staging requires a real ${label}: ${path}`);
  }
}

/** @param {string} path */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read staging metadata ${path}: ${detail}`);
  }
}

/** @param {string} sourceRoot @param {string[]} patches */
async function calculatePatchDigest(sourceRoot, patches) {
  const hash = createHash("sha256");
  for (const patch of patches) {
    if (!patch.startsWith("patches/openchatcut/") || !patch.endsWith(".patch")) {
      throw new Error(`Unsafe Host Patch path in UPSTREAM.json: ${patch}`);
    }
    const absolutePatch = resolveSourcePath(sourceRoot, patch);
    await requireRegularFile(absolutePatch, `Host Patch ${patch}`);
    hash.update(patch);
    hash.update("\0");
    hash.update(await readFile(absolutePatch));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** @param {unknown} value */
function assertUpstreamLock(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !("repository" in value) ||
    typeof value.repository !== "string" ||
    !("revision" in value) ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.revision) ||
    !("nodeMajor" in value) ||
    !Number.isInteger(value.nodeMajor) ||
    !("patches" in value) ||
    !Array.isArray(value.patches) ||
    !value.patches.every((entry) => typeof entry === "string")
  ) {
    throw new Error("UPSTREAM.json does not match the expected local staging lock format.");
  }
  return /** @type {{repository: string, revision: string, nodeMajor: number, patches: string[]}} */ (value);
}

/** @param {string} path */
function containsForbiddenSegment(path) {
  return path.split(/[\\/]/u).some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

/** @param {string} path */
function containsForbiddenStagedSegment(path) {
  return path
    .split(/[\\/]/u)
    .some((segment, index) => FORBIDDEN_SEGMENTS.has(segment) && !(segment === ".runtime" && index === 0));
}

/**
 * Copy a permitted subtree without following links or admitting state/test directories.
 * @param {string} source
 * @param {string} destination
 * @param {string} sourceBoundary
 */
async function copyPermittedTree(source, destination, sourceBoundary) {
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (FORBIDDEN_SEGMENTS.has(entry.name)) continue;
      await copyPermittedTree(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        sourceBoundary,
      );
    }
    return;
  }
  if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
    return;
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(source);
    if (isAbsolute(target)) throw new Error(`Absolute symlink is not allowed in local plugin staging: ${source}`);
    const resolvedTarget = resolve(dirname(source), target);
    const relativeTarget = relative(sourceBoundary, resolvedTarget);
    if (!isInside(sourceBoundary, resolvedTarget) || containsForbiddenSegment(relativeTarget)) {
      throw new Error(`Escaping or forbidden symlink is not allowed in local plugin staging: ${source}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination);
    return;
  }
  throw new Error(`Unsupported filesystem entry in local plugin staging: ${source}`);
}

/**
 * @param {ReturnType<typeof createHash>} hash
 * @param {string} root
 * @param {string} directory
 */
async function hashDirectoryInto(hash, root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (entry.name === ".codex-chatcut-local-stage.json") continue;
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`D\0${path}\0`);
      await hashDirectoryInto(hash, root, absolute);
    } else if (info.isFile()) {
      hash.update(`F\0${path}\0${info.mode & 0o777}\0`);
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      hash.update("\0");
    } else if (info.isSymbolicLink()) {
      hash.update(`L\0${path}\0${await readlink(absolute)}\0`);
    } else {
      throw new Error(`Unsupported staged filesystem entry: ${absolute}`);
    }
  }
}

/** @param {string} root */
async function calculateBundleDigest(root) {
  const hash = createHash("sha256");
  await hashDirectoryInto(hash, root, root);
  return hash.digest("hex");
}

/**
 * Hash one allowlisted source entry under the path it has in the staged bundle.
 * Forbidden state/test directories are omitted exactly as copyPermittedTree omits them.
 * @param {ReturnType<typeof createHash>} hash
 * @param {string} source
 * @param {string} bundlePath
 */
async function hashProjectedEntry(hash, source, bundlePath) {
  const info = await lstat(source);
  const normalizedPath = bundlePath.split(sep).join("/");
  if (info.isDirectory()) {
    hash.update(`D\0${normalizedPath}\0`);
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (FORBIDDEN_SEGMENTS.has(entry.name)) continue;
      await hashProjectedEntry(
        hash,
        resolve(source, entry.name),
        join(bundlePath, entry.name),
      );
    }
    return;
  }
  if (info.isFile()) {
    hash.update(`F\0${normalizedPath}\0${info.mode & 0o777}\0`);
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    hash.update("\0");
    return;
  }
  if (info.isSymbolicLink()) {
    hash.update(`L\0${normalizedPath}\0${await readlink(source)}\0`);
    return;
  }
  throw new Error(`Unsupported allowlisted filesystem entry: ${source}`);
}

/**
 * Digest exactly the source inputs that stageLocalPlugin projects into a bundle.
 * @param {string} sourceRoot
 * @param {{lock: {patches: string[]}, runtimeName: string, runtimeRoot: string}} runtime
 */
async function calculateSourceProjectionDigest(sourceRoot, runtime) {
  const entries = [
    ...ROOT_FILES.map((path) => ({ source: resolveSourcePath(sourceRoot, path), path })),
    {
      source: resolve(sourceRoot, ".codex-plugin/plugin.json"),
      path: ".codex-plugin/plugin.json",
    },
    ...RUNTIME_SUPPORT_FILES.map((path) => ({ source: resolveSourcePath(sourceRoot, path), path })),
    ...["mcp", "skills", "node_modules"].map((path) => ({
      source: resolve(sourceRoot, path),
      path,
    })),
    ...runtime.lock.patches.map((path) => ({ source: resolveSourcePath(sourceRoot, path), path })),
    {
      source: runtime.runtimeRoot,
      path: `.runtime/${runtime.runtimeName}`,
    },
  ];
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`M\0${entry.path}\0`);
    await hashProjectedEntry(hash, entry.source, entry.path);
  }
  return hash.digest("hex");
}

/** @param {string} root @param {string} directory */
async function assertNoForbiddenStagedPaths(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute);
    const segments = path.split(sep);
    for (const [index, segment] of segments.entries()) {
      if (segment === ".runtime" && index === 0) continue;
      if (FORBIDDEN_SEGMENTS.has(segment)) {
        throw new Error(`Staged local plugin contains forbidden path segment ${segment}: ${path}`);
      }
    }
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      await assertNoForbiddenStagedPaths(root, absolute);
    } else if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (isAbsolute(target)) {
        throw new Error(`Staged local plugin contains an absolute symlink: ${path}`);
      }
      const resolvedTarget = resolve(dirname(absolute), target);
      const targetPath = relative(root, resolvedTarget);
      if (!isInside(root, resolvedTarget) || containsForbiddenStagedSegment(targetPath)) {
        throw new Error(`Staged local plugin contains an escaping or forbidden symlink: ${path}`);
      }
    } else if (!info.isFile()) {
      throw new Error(`Staged local plugin contains an unsupported filesystem entry: ${path}`);
    }
  }
}

/**
 * @param {string} sourceRoot
 * @returns {Promise<{
 *   lock: {repository: string, revision: string, nodeMajor: number, patches: string[]},
 *   patchDigest: string,
 *   runtimeName: string,
 *   runtimeRoot: string,
 * }>}
 */
async function describePreparedRuntime(sourceRoot) {
  const lock = assertUpstreamLock(await readJson(resolve(sourceRoot, "UPSTREAM.json")));
  const patchDigest = await calculatePatchDigest(sourceRoot, lock.patches);
  const runtimeName = `openchatcut-${lock.revision.slice(0, 12)}-${patchDigest.slice(0, 12)}`;
  const runtimeRoot = resolve(sourceRoot, ".runtime", runtimeName);
  return { lock, patchDigest, runtimeName, runtimeRoot };
}

/** @param {unknown} version */
function nodeMajorFromVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^v?(\d+)(?:\.|$)/u.exec(version);
  return match ? Number(match[1]) : null;
}

/** @param {string} runtimeRoot */
function prepareLockPath(runtimeRoot) {
  return `${runtimeRoot}.prepare.lock`;
}

/** @param {string} runtimeRoot */
async function acquirePreparedRuntimeGuard(runtimeRoot) {
  const lockPath = prepareLockPath(runtimeRoot);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`OpenChatCut runtime is currently being prepared: ${runtimeRoot}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, operation: "local-plugin-stage" })}\n`,
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
 * @param {string} sourceRoot
 * @param {{lock: {repository: string, revision: string, nodeMajor: number, patches: string[]}, patchDigest: string, runtimeName: string, runtimeRoot: string}} runtime
 * @param {{guardHeld?: boolean}} [options]
 */
async function resolvePreparedRuntime(sourceRoot, runtime, options = {}) {
  if (!options.guardHeld && await exists(prepareLockPath(runtime.runtimeRoot))) {
    throw new Error(`OpenChatCut runtime is currently being prepared: ${runtime.runtimeRoot}`);
  }

  try {
    await requireDirectory(runtime.runtimeRoot, "prepared OpenChatCut runtime directory");
    const marker = await readJson(resolve(runtime.runtimeRoot, ".codex-chatcut-prepared.json"));
    if (
      !marker ||
      typeof marker !== "object" ||
      !("revision" in marker) ||
      marker.revision !== runtime.lock.revision ||
      !("patchDigest" in marker) ||
      marker.patchDigest !== runtime.patchDigest ||
      !("patches" in marker) ||
      JSON.stringify(marker.patches) !== JSON.stringify(runtime.lock.patches) ||
      !("nodeMajor" in marker) ||
      marker.nodeMajor !== runtime.lock.nodeMajor ||
      !("builtWithNode" in marker) ||
      nodeMajorFromVersion(marker.builtWithNode) !== runtime.lock.nodeMajor ||
      !("built" in marker) ||
      marker.built !== true ||
      !("sourceDigest" in marker) ||
      typeof marker.sourceDigest !== "string" ||
      marker.sourceDigest !== await calculatePreparedSourceDigest(runtime.runtimeRoot)
    ) {
      throw new Error(
        `prepared marker does not match UPSTREAM.json with built=true or was not built with Node ${runtime.lock.nodeMajor}`,
      );
    }
    await requireRegularFile(resolve(runtime.runtimeRoot, "dist/index.html"), "prepared editor build");
    await requireRegularFile(resolve(runtime.runtimeRoot, "desktop/codex-sidecar.ts"), "prepared sidecar entry");
    await requireDirectory(resolve(runtime.runtimeRoot, "node_modules/tsx"), "prepared tsx dependency");
    if (!options.guardHeld && await exists(prepareLockPath(runtime.runtimeRoot))) {
      throw new Error(`OpenChatCut runtime is currently being prepared: ${runtime.runtimeRoot}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("currently being prepared")) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No built prepared OpenChatCut runtime matches the current UPSTREAM.json digest (${runtime.runtimeName}). ` +
      `Run Node ${runtime.lock.nodeMajor}: node scripts/prepare-openchatcut.mjs --build. ${detail}`,
    );
  }

  return runtime;
}

/** @param {string} sourceRoot @param {string} destination @param {string} path */
async function copyRootFile(sourceRoot, destination, path) {
  const source = resolveSourcePath(sourceRoot, path);
  await requireRegularFile(source, path);
  const target = resolve(destination, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
}

/** @param {string} current @param {string} next */
async function replaceCurrentDirectory(current, next) {
  if (!(await exists(current))) {
    await rename(next, current);
    return;
  }
  const currentInfo = await lstat(current);
  if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
    throw new Error(`Local plugin current path must be a real directory, not a symlink: ${current}`);
  }
  const backup = resolve(dirname(current), `.previous-${process.pid}-${randomBytes(6).toString("hex")}`);
  await rename(current, backup);
  try {
    await rename(next, current);
  } catch (error) {
    await rename(backup, current);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

/** @param {string} stageRoot */
async function ensureRealStageRoot(stageRoot) {
  await realpath(dirname(stageRoot));
  if (await exists(stageRoot)) {
    const info = await lstat(stageRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Local plugin stage root must be a real directory, not a symlink: ${stageRoot}`);
    }
    return;
  }
  await mkdir(stageRoot, { mode: 0o700 });
  const info = await lstat(stageRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Local plugin stage root must be a real directory, not a symlink: ${stageRoot}`);
  }
}

/** @param {string} detail */
function staleStageError(detail) {
  return new Error(
    `Staged local plugin is stale relative to the canonical source checkout (${detail}). ` +
    "Rerun npm run stage:plugin.",
  );
}

/** @param {string} sourceRoot @param {string} stageRoot */
function assertNonOverlappingStageRoot(sourceRoot, stageRoot) {
  if (stageRoot === sourceRoot) {
    throw new Error("Local plugin stage root cannot replace the source checkout.");
  }
  for (const path of ["mcp", "skills", "node_modules", ".runtime"]) {
    if (isInside(resolve(sourceRoot, path), stageRoot)) {
      throw new Error(
        `Local plugin stage root overlaps recursively copied source ${path}: ${stageRoot}`,
      );
    }
  }
}

/** @param {string} path */
async function canonicalStageRoot(path) {
  return resolve(await realpath(dirname(path)), basename(path));
}

/**
 * @param {{sourceRoot?: string, stageRoot?: string}} [options]
 */
export async function stageLocalPlugin(options = {}) {
  const sourceRoot = await realpath(resolve(options.sourceRoot ?? repositoryRoot));
  const stageRoot = await canonicalStageRoot(
    resolve(options.stageRoot ?? resolve(sourceRoot, ".local-plugin")),
  );
  assertNonOverlappingStageRoot(sourceRoot, stageRoot);

  for (const path of ROOT_FILES) await requireRegularFile(resolveSourcePath(sourceRoot, path), path);
  await requireRegularFile(resolve(sourceRoot, ".codex-plugin/plugin.json"), "plugin manifest");
  for (const path of ["mcp", "skills", "node_modules"]) {
    await requireDirectory(resolve(sourceRoot, path), path);
  }
  for (const path of RUNTIME_SUPPORT_FILES) {
    await requireRegularFile(resolveSourcePath(sourceRoot, path), path);
  }

  const runtime = await describePreparedRuntime(sourceRoot);
  await resolvePreparedRuntime(sourceRoot, runtime);
  const releaseRuntimeGuard = await acquirePreparedRuntimeGuard(runtime.runtimeRoot);
  try {
    await resolvePreparedRuntime(sourceRoot, runtime, { guardHeld: true });
    await ensureRealStageRoot(stageRoot);
    const current = resolve(stageRoot, "current");
    if (await exists(current)) {
      const currentInfo = await lstat(current);
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
        throw new Error(`Local plugin current path must be a real directory, not a symlink: ${current}`);
      }
    }
    const next = resolve(stageRoot, `.next-${process.pid}-${randomBytes(6).toString("hex")}`);
    await mkdir(next, { mode: 0o700 });

    try {
      for (const path of ROOT_FILES) await copyRootFile(sourceRoot, next, path);
      await copyRootFile(sourceRoot, next, ".codex-plugin/plugin.json");
      for (const path of RUNTIME_SUPPORT_FILES) await copyRootFile(sourceRoot, next, path);
      for (const path of ["mcp", "skills", "node_modules"]) {
        await copyPermittedTree(resolve(sourceRoot, path), resolve(next, path), resolve(sourceRoot, path));
      }
      for (const patch of runtime.lock.patches) await copyRootFile(sourceRoot, next, patch);
      await copyPermittedTree(
        runtime.runtimeRoot,
        resolve(next, ".runtime", runtime.runtimeName),
        runtime.runtimeRoot,
      );

      const stagedRuntime = {
        ...runtime,
        runtimeRoot: resolve(next, ".runtime", runtime.runtimeName),
      };
      const sourceProjectionDigest = await calculateSourceProjectionDigest(sourceRoot, runtime);
      const stagedProjectionDigest = await calculateSourceProjectionDigest(next, stagedRuntime);
      if (sourceProjectionDigest !== stagedProjectionDigest) {
        throw new Error(
          "Allowlisted plugin source changed while staging. Rerun npm run stage:plugin.",
        );
      }
      const bundleDigest = await calculateBundleDigest(next);
      const marker = {
        schemaVersion: 2,
        localOnly: true,
        publishable: false,
        contentAddress: `sha256:${bundleDigest}`,
        sourceContentAddress: `sha256:${sourceProjectionDigest}`,
        upstreamRevision: runtime.lock.revision,
        patchDigest: runtime.patchDigest,
        runtime: `.runtime/${runtime.runtimeName}`,
      };
      await writeFile(
        resolve(next, ".codex-chatcut-local-stage.json"),
        `${JSON.stringify(marker, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      if (await exists(current)) {
        const currentInfo = await lstat(current);
        if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
          throw new Error(`Local plugin current path must be a real directory, not a symlink: ${current}`);
        }
        try {
          const currentMarker = await readJson(resolve(current, ".codex-chatcut-local-stage.json"));
          if (
            currentMarker &&
            typeof currentMarker === "object" &&
            "contentAddress" in currentMarker &&
            currentMarker.contentAddress === marker.contentAddress &&
            "sourceContentAddress" in currentMarker &&
            currentMarker.sourceContentAddress === marker.sourceContentAddress &&
            await calculateBundleDigest(current) === bundleDigest
          ) {
            await rm(next, { recursive: true, force: true });
            return {
              bundleRoot: await realpath(current),
              contentAddress: marker.contentAddress,
              runtimeName: runtime.runtimeName,
              reused: true,
            };
          }
        } catch {
          // An incomplete or locally modified ignored stage is safely rebuilt below.
        }
      }

      await replaceCurrentDirectory(current, next);
      return {
        bundleRoot: await realpath(current),
        contentAddress: marker.contentAddress,
        runtimeName: runtime.runtimeName,
        reused: false,
      };
    } catch (error) {
      await rm(next, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await releaseRuntimeGuard();
  }
}

/**
 * @param {{sourceRoot?: string, stageRoot?: string}} [options]
 */
export async function validateLocalPluginStage(options = {}) {
  const sourceRoot = await realpath(resolve(options.sourceRoot ?? repositoryRoot));
  const stageRoot = await canonicalStageRoot(
    resolve(options.stageRoot ?? resolve(sourceRoot, ".local-plugin")),
  );
  assertNonOverlappingStageRoot(sourceRoot, stageRoot);
  const current = resolve(stageRoot, "current");
  if (await exists(stageRoot)) {
    const stageInfo = await lstat(stageRoot);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) {
      throw new Error(`Local plugin stage root must be a real directory, not a symlink: ${stageRoot}`);
    }
  }
  if (!(await exists(current))) {
    throw new Error(
      `No staged local plugin is available at ${current}. Run npm run stage:plugin before registering or installing the marketplace.`,
    );
  }
  await requireDirectory(current, "staged local plugin directory");
  const canonicalCurrent = await realpath(current);
  await assertNoForbiddenStagedPaths(canonicalCurrent, canonicalCurrent);
  const topLevel = (await readdir(canonicalCurrent)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(STAGED_TOP_LEVEL)) {
    throw new Error(
      `Staged local plugin top-level allowlist mismatch. Expected ${STAGED_TOP_LEVEL.join(", ")}; got ${topLevel.join(", ")}.`,
    );
  }
  for (const path of ROOT_FILES) await requireRegularFile(resolve(canonicalCurrent, path), path);
  await requireRegularFile(resolve(canonicalCurrent, ".codex-plugin/plugin.json"), "plugin manifest");
  for (const path of RUNTIME_SUPPORT_FILES) {
    await requireRegularFile(resolve(canonicalCurrent, path), path);
  }
  for (const path of ["mcp", "skills", "node_modules"]) {
    await requireDirectory(resolve(canonicalCurrent, path), path);
  }

  const sourceRuntime = await describePreparedRuntime(sourceRoot);
  const stagedRuntime = await describePreparedRuntime(canonicalCurrent);
  if (
    sourceRuntime.lock.repository !== stagedRuntime.lock.repository ||
    sourceRuntime.lock.revision !== stagedRuntime.lock.revision ||
    sourceRuntime.lock.nodeMajor !== stagedRuntime.lock.nodeMajor ||
    JSON.stringify(sourceRuntime.lock.patches) !== JSON.stringify(stagedRuntime.lock.patches) ||
    sourceRuntime.patchDigest !== stagedRuntime.patchDigest ||
    sourceRuntime.runtimeName !== stagedRuntime.runtimeName
  ) {
    throw staleStageError("UPSTREAM.json revision or Host Patch digest changed");
  }

  await resolvePreparedRuntime(sourceRoot, sourceRuntime);
  const releaseRuntimeGuard = await acquirePreparedRuntimeGuard(sourceRuntime.runtimeRoot);
  try {
    await resolvePreparedRuntime(sourceRoot, sourceRuntime, { guardHeld: true });
    await resolvePreparedRuntime(canonicalCurrent, stagedRuntime);
    const runtimes = await readdir(resolve(canonicalCurrent, ".runtime"));
    if (runtimes.length !== 1 || runtimes[0] !== stagedRuntime.runtimeName) {
      throw new Error(
        `Staged local plugin must contain only .runtime/${stagedRuntime.runtimeName}; ` +
        `got ${runtimes.join(", ") || "none"}.`,
      );
    }

    const sourceProjectionDigest = await calculateSourceProjectionDigest(sourceRoot, sourceRuntime);
    const stagedProjectionDigest = await calculateSourceProjectionDigest(canonicalCurrent, stagedRuntime);
    if (sourceProjectionDigest !== stagedProjectionDigest) {
      throw staleStageError("allowlisted manifest, MCP, skill, package, dependency, patch, or runtime content changed");
    }

    const stageMarker = await readJson(resolve(canonicalCurrent, ".codex-chatcut-local-stage.json"));
    const bundleDigest = await calculateBundleDigest(canonicalCurrent);
    if (
      !stageMarker ||
      typeof stageMarker !== "object" ||
      !("schemaVersion" in stageMarker) ||
      stageMarker.schemaVersion !== 2 ||
      !("localOnly" in stageMarker) ||
      stageMarker.localOnly !== true ||
      !("publishable" in stageMarker) ||
      stageMarker.publishable !== false ||
      !("contentAddress" in stageMarker) ||
      stageMarker.contentAddress !== `sha256:${bundleDigest}` ||
      !("sourceContentAddress" in stageMarker) ||
      stageMarker.sourceContentAddress !== `sha256:${sourceProjectionDigest}` ||
      !("upstreamRevision" in stageMarker) ||
      stageMarker.upstreamRevision !== stagedRuntime.lock.revision ||
      !("patchDigest" in stageMarker) ||
      stageMarker.patchDigest !== stagedRuntime.patchDigest ||
      !("runtime" in stageMarker) ||
      stageMarker.runtime !== `.runtime/${stagedRuntime.runtimeName}`
    ) {
      throw new Error("Staged local plugin marker or content address is invalid.");
    }

    const plugin = await readJson(resolve(canonicalCurrent, ".codex-plugin/plugin.json"));
    const mcp = await readJson(resolve(canonicalCurrent, ".mcp.json"));
    if (
      !plugin ||
      typeof plugin !== "object" ||
      !("mcpServers" in plugin) ||
      plugin.mcpServers !== "./.mcp.json" ||
      !("skills" in plugin) ||
      plugin.skills !== "./skills/"
    ) {
      throw new Error("Staged plugin manifest must expose only the bundled MCP config and skills.");
    }
    if (
      !mcp ||
      typeof mcp !== "object" ||
      !("mcpServers" in mcp) ||
      !mcp.mcpServers ||
      typeof mcp.mcpServers !== "object" ||
      !("codex_chatcut" in mcp.mcpServers)
    ) {
      throw new Error("Staged .mcp.json must declare the codex_chatcut stdio server.");
    }

    return {
      bundleRoot: canonicalCurrent,
      contentAddress: stageMarker.contentAddress,
      runtimeName: stagedRuntime.runtimeName,
      valid: true,
    };
  } finally {
    await releaseRuntimeGuard();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{sourceRoot?: string, stageRoot?: string, check: boolean, json: boolean}} */
  const options = { check: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--check") {
      options.check = true;
    } else if (argument === "--source-root" || argument === "--stage-root") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path.`);
      if (argument === "--source-root") options.sourceRoot = value;
      else options.stageRoot = value;
      index += 1;
    } else {
      throw new Error(`Unknown local plugin staging argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.check
      ? await validateLocalPluginStage(options)
      : await stageLocalPlugin(options);
    if (options.json) console.log(JSON.stringify(result));
    else if (options.check) console.log(`Valid local Codex plugin stage: ${result.bundleRoot}`);
    else {
      console.log(`Staged local Codex plugin at ${result.bundleRoot}`);
      if ("contentAddress" in result) console.log(`Content address: ${result.contentAddress}`);
      console.log("Local-only bundle: do not publish or add it to Git.");
    }
  } catch (error) {
    console.error(`Local plugin staging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
