// @ts-check

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readUpstreamLock } from "../../scripts/verify-upstream.mjs";
import {
  calculatePatchDigest,
  calculatePreparedSourceDigest,
} from "../../scripts/prepare-openchatcut.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SIDECAR_ENVIRONMENT_ALLOWLIST = new Set([
  "ALL_PROXY",
  "COMSPEC",
  "COLORTERM",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/**
 * Keep the third-party sidecar from inheriting arbitrary credentials or Node
 * injection flags from the MCP owner. Locale, process lookup, temp, proxy and
 * trust-store settings are the only inherited runtime inputs.
 * @param {NodeJS.ProcessEnv} source
 */
export function sidecarBaseEnvironment(source = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value === "string" &&
      (SIDECAR_ENVIRONMENT_ALLOWLIST.has(name) || name.startsWith("LC_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild === "" || (!pathToChild.startsWith("..") && !isAbsolute(pathToChild));
}

/** @param {string} path */
async function exists(path) {
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

/** @param {unknown} version */
function nodeMajorFromVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^v?(\d+)(?:\.|$)/u.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Create each state-directory segment without following a pre-existing link,
 * then return the verified canonical data root.
 * @param {string} workspaceRoot
 */
async function ensureWorkspaceDataRoot(workspaceRoot) {
  let parent = workspaceRoot;
  for (const segment of [".codex-chatcut", "openchatcut"]) {
    const candidate = resolve(parent, segment);
    if (!isInside(workspaceRoot, candidate)) {
      throw new Error("OpenChatCut state directory escaped the workspace.");
    }
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const entryInfo = await lstat(candidate);
    if (entryInfo.isSymbolicLink()) {
      throw new Error(`OpenChatCut state directory cannot use a symlink: ${candidate}`);
    }
    if (!entryInfo.isDirectory()) {
      throw new Error(`OpenChatCut state path is not a directory: ${candidate}`);
    }
    const canonical = await realpath(candidate);
    const canonicalInfo = await stat(canonical);
    if (
      !isInside(workspaceRoot, canonical) ||
      canonicalInfo.dev !== entryInfo.dev ||
      canonicalInfo.ino !== entryInfo.ino
    ) {
      throw new Error("OpenChatCut state directory escaped or changed during validation.");
    }
    parent = canonical;
  }
  return parent;
}

/** @param {{runtimeRoot?: string}} [options] */
export async function findPreparedRoot(options = {}) {
  const explicit = process.env.CODEX_CHATCUT_PREPARED_ROOT?.trim();
  const lock = await readUpstreamLock();
  const digest = await calculatePatchDigest(lock.patches);
  const runtimeRoot = options.runtimeRoot ?? resolve(root, ".runtime");
  const explicitCandidate = explicit && !options.runtimeRoot ? resolve(explicit) : null;
  const candidate = explicitCandidate ?? resolve(
      runtimeRoot,
      `openchatcut-${lock.revision.slice(0, 12)}-${digest.slice(0, 12)}`,
    );
  if (await exists(`${candidate}.prepare.lock`)) {
    throw new Error(`OpenChatCut runtime is currently being prepared: ${candidate}`);
  }
  try {
    const marker = JSON.parse(
      await readFile(resolve(candidate, ".codex-chatcut-prepared.json"), "utf8"),
    );
    if (
      marker.revision === lock.revision &&
      marker.patchDigest === digest &&
      marker.built === true &&
      marker.nodeMajor === lock.nodeMajor &&
      nodeMajorFromVersion(marker.builtWithNode) === lock.nodeMajor &&
      JSON.stringify(marker.patches) === JSON.stringify(lock.patches) &&
      typeof marker.sourceDigest === "string" &&
      marker.sourceDigest === await calculatePreparedSourceDigest(candidate) &&
      (await exists(resolve(candidate, "dist/index.html"))) &&
      (await exists(resolve(candidate, "node_modules/tsx")))
    ) {
      const canonicalCandidate = await realpath(candidate);
      if (!explicitCandidate) {
        const canonicalRuntime = await realpath(runtimeRoot);
        if (!isInside(canonicalRuntime, canonicalCandidate)) {
          throw new Error("Prepared OpenChatCut tree escaped the runtime root.");
        }
      }
      return canonicalCandidate;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("escaped the runtime root")) throw error;
  }
  throw new Error(
    `No built OpenChatCut tree matches UPSTREAM.json. Run Node ${lock.nodeMajor}: ` +
    "node scripts/prepare-openchatcut.mjs --build",
  );
}

/** @param {string} input */
function validateOrigin(input) {
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`OpenChatCut returned an unsafe sidecar origin: ${input}`);
  }
  return url.origin;
}

/** @param {string} text @param {string[]} secrets */
function redact(text, secrets) {
  return secrets.reduce(
    (value, secret) => (secret ? value.replaceAll(secret, "[redacted]") : value),
    text,
  );
}

/** @param {unknown} value @param {string[]} secrets */
function sidecarDiagnostic(value, secrets) {
  const text = typeof value === "string" ? value : "OpenChatCut sidecar reported an error.";
  return redact(text, secrets).replace(/[\r\n]+/g, " ").slice(0, 2_048);
}

/** @param {AbortSignal} signal */
function throwIfAborted(signal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("OpenChatCut sidecar startup was cancelled.");
}

/** @param {import("node:child_process").ChildProcess} child */
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} graceMs
 */
async function boundedTerminate(child, graceMs) {
  if (hasExited(child)) return;
  await new Promise((resolveExit) => {
    /** @type {NodeJS.Timeout | null} */
    let forceTimer = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      child.off("exit", finish);
      child.off("close", finish);
      resolveExit(undefined);
    };
    child.once("exit", finish);
    child.once("close", finish);
    if (hasExited(child)) {
      finish();
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // The close/exit event remains authoritative if signalling raced a spawn failure.
    }
    forceTimer = setTimeout(() => {
      if (hasExited(child)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Still wait for exit/close so callers never observe a live child as reaped.
      }
    }, graceMs);
  });
}

export class OpenChatCutRuntime {
  /**
   * @param {{workspaceRoot?: string, sidecarEntry?: string, startupTimeoutMs?: number, shutdownGraceMs?: number}} [options]
   */
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.env.CODEX_CHATCUT_WORKSPACE_ROOT?.trim() ?? null;
    this.sidecarEntry = options.sidecarEntry ?? process.env.CODEX_CHATCUT_SIDECAR_ENTRY ?? null;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 2_000);
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    /** @type {string | null} */
    this.origin = null;
    /** @type {string | null} */
    this.mcpToken = null;
    /** @type {Promise<{running: true, origin: string, mcpToken: string}> | null} */
    this.starting = null;
    /** @type {AbortController | null} */
    this.startController = null;
    /** @type {{child: import("node:child_process").ChildProcess, promise: Promise<void>} | null} */
    this.termination = null;
  }

  hasWorkspaceRoot() {
    return typeof this.workspaceRoot === "string" && this.workspaceRoot.length > 0;
  }

  /** @param {string} workspaceRoot */
  setWorkspaceRoot(workspaceRoot) {
    if (this.child || this.starting) {
      throw new Error("OpenChatCut workspace root is fixed once sidecar startup begins.");
    }
    if (this.workspaceRoot && resolve(this.workspaceRoot) !== resolve(workspaceRoot)) {
      throw new Error("OpenChatCut workspace root is already fixed for this MCP process.");
    }
    this.workspaceRoot = workspaceRoot;
  }

  /** @param {AbortSignal} [signal] */
  async start(signal) {
    if (signal) throwIfAborted(signal);
    if (this.child && this.origin && this.mcpToken) {
      return { running: /** @type {const} */ (true), origin: this.origin, mcpToken: this.mcpToken };
    }
    if (this.starting) {
      const controller = this.startController;
      const onAbort = () => controller?.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        return await this.starting;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    const controller = new AbortController();
    this.startController = controller;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const starting = this.startOnce(controller.signal);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.starting === starting) this.starting = null;
      if (this.startController === controller) this.startController = null;
    }
  }

  /** @param {import("node:child_process").ChildProcess} child */
  terminate(child) {
    if (this.termination?.child === child) return this.termination.promise;
    const promise = boundedTerminate(child, this.shutdownGraceMs);
    const termination = { child, promise };
    this.termination = termination;
    const clearTermination = () => {
      if (this.termination === termination) this.termination = null;
    };
    void promise.then(clearTermination, clearTermination);
    return promise;
  }

  /**
   * @param {AbortSignal} signal
   * @returns {Promise<{running: true, origin: string, mcpToken: string}>}
   */
  async startOnce(signal) {
    throwIfAborted(signal);
    if (!this.workspaceRoot) {
      throw new Error(
        "OpenChatCut requires trusted Codex workspace metadata or the explicit " +
        "CODEX_CHATCUT_WORKSPACE_ROOT fallback before startup.",
      );
    }

    const workspaceRoot = await realpath(this.workspaceRoot);
    throwIfAborted(signal);
    const workspaceInfo = await stat(workspaceRoot);
    throwIfAborted(signal);
    if (!workspaceInfo.isDirectory()) throw new Error("Codex ChatCut workspace root must be a directory.");
    const dataRoot = await ensureWorkspaceDataRoot(workspaceRoot);
    throwIfAborted(signal);

    const mcpToken = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const customEntry = this.sidecarEntry ? resolve(this.sidecarEntry) : null;
    const preparedRoot = customEntry ? root : await findPreparedRoot();
    throwIfAborted(signal);
    const entry = customEntry ?? resolve(preparedRoot, "desktop/codex-sidecar.ts");
    if (!(await exists(entry))) throw new Error(`OpenChatCut sidecar entry is missing: ${entry}`);
    throwIfAborted(signal);

    if (!customEntry && Number(process.versions.node.split(".")[0]) !== 24) {
      throw new Error(`OpenChatCut sidecar requires Node 24; current Node is ${process.version}.`);
    }

    const child = fork(entry, [], {
      cwd: preparedRoot,
      execPath: process.execPath,
      execArgv: customEntry ? [] : ["--import", "tsx"],
      env: {
        ...sidecarBaseEnvironment(),
        CODEX_CHATCUT_WORKSPACE_ROOT: workspaceRoot,
        OPENCHATCUT_DATA_ROOT: dataRoot,
        OPENCHATCUT_MCP_TOKEN: mcpToken,
        OPENCHATCUT_BROWSER_TOKEN: browserToken,
        OPENCHATCUT_HOST_MODE: "codex",
        OPENCHATCUT_DIST_DIR: resolve(preparedRoot, "dist"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    this.mcpToken = mcpToken;

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        const message = redact(String(chunk), [mcpToken, browserToken]);
        process.stderr.write(`[openchatcut-sidecar] ${message}`);
      });
    }

    try {
      const origin = await new Promise((resolveOrigin, reject) => {
        /** @type {NodeJS.Timeout | null} */
        let timer = null;
        let settled = false;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          child.off("error", onError);
          child.off("exit", onExit);
          child.off("message", onMessage);
          signal.removeEventListener("abort", onAbort);
        };
        /** @param {unknown} error */
        const rejectOnce = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        /** @param {string} origin */
        const resolveOnce = (origin) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolveOrigin(origin);
        };
        /** @param {Error} error */
        const onError = (error) => rejectOnce(error);
        /** @param {number | null} code @param {NodeJS.Signals | null} exitSignal */
        const onExit = (code, exitSignal) => {
          rejectOnce(new Error(`OpenChatCut sidecar exited before ready (${code ?? exitSignal}).`));
        };
        const onAbort = () => {
          rejectOnce(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("OpenChatCut sidecar startup was cancelled."),
          );
        };
        /** @param {unknown} message */
        const onMessage = (message) => {
          const record = /** @type {{type?: unknown, origin?: unknown, message?: unknown} | null} */ (
            message && typeof message === "object" ? message : null
          );
          if (record?.type === "openchatcut-error") {
            rejectOnce(
              new Error(
                `OpenChatCut sidecar failed: ${sidecarDiagnostic(record.message, [mcpToken, browserToken])}`,
              ),
            );
            return;
          }
          if (
            record?.type === "openchatcut-ready" &&
            typeof record.origin === "string"
          ) {
            try {
              resolveOnce(validateOrigin(record.origin));
            } catch (error) {
              rejectOnce(error);
            }
          }
        };
        timer = setTimeout(
          () => rejectOnce(new Error("OpenChatCut sidecar readiness timed out.")),
          this.startupTimeoutMs,
        );
        child.once("error", onError);
        child.once("exit", onExit);
        child.on("message", onMessage);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      this.origin = origin;
      child.once("exit", () => {
        this.child = null;
        this.origin = null;
        this.mcpToken = null;
      });
      return { running: true, origin, mcpToken };
    } catch (error) {
      await this.terminate(child);
      if (this.child === child) {
        this.child = null;
        this.origin = null;
        this.mcpToken = null;
      }
      throw error;
    }
  }

  /**
   * @returns {{running: true, origin: string, mcpToken: string} | {running: false, origin: null, mcpToken: null}}
   */
  snapshot() {
    if (!this.child || !this.origin || !this.mcpToken) {
      return { running: false, origin: null, mcpToken: null };
    }
    return { running: true, origin: this.origin, mcpToken: this.mcpToken };
  }

  /** @returns {{running: true, origin: string} | {running: false}} */
  publicStatus() {
    return this.origin && this.child
      ? { running: true, origin: this.origin }
      : { running: false };
  }

  async close() {
    const starting = this.starting;
    this.startController?.abort(
      new Error("OpenChatCut sidecar startup was cancelled by close()."),
    );
    const child = this.child;
    this.origin = null;
    this.mcpToken = null;
    if (child) await this.terminate(child);
    await starting?.catch(() => undefined);
    if (this.child === child) this.child = null;
  }
}
