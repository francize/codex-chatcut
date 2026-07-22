// @ts-check

import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CODEX_SANDBOX_STATE_META_KEY = "codex/sandbox-state-meta";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} candidate */
async function canonicalDirectory(candidate) {
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("Codex ChatCut workspace root must be a directory.");
  }
  return canonical;
}

/**
 * Resolve the current task workspace from Codex-owned tools/call metadata. The
 * environment variable is intentionally only a fallback for non-Codex clients
 * and tests; metadata from the current call wins whenever the key is present.
 *
 * @param {unknown} requestMeta
 * @param {string | undefined} [explicitWorkspaceRoot]
 */
export async function resolveCodexWorkspaceRoot(
  requestMeta,
  explicitWorkspaceRoot = process.env.CODEX_CHATCUT_WORKSPACE_ROOT,
) {
  const metadata = isRecord(requestMeta) ? requestMeta : null;
  if (metadata && Object.hasOwn(metadata, CODEX_SANDBOX_STATE_META_KEY)) {
    const sandboxState = metadata[CODEX_SANDBOX_STATE_META_KEY];
    if (!isRecord(sandboxState) || typeof sandboxState.sandboxCwd !== "string") {
      throw new Error("Codex sandboxCwd metadata must contain a file URI string.");
    }
    let cwdUrl;
    try {
      cwdUrl = new URL(sandboxState.sandboxCwd);
    } catch {
      throw new Error("Codex sandboxCwd metadata must contain a valid file URI.");
    }
    if (
      cwdUrl.protocol !== "file:" ||
      (cwdUrl.hostname && cwdUrl.hostname !== "localhost") ||
      cwdUrl.username ||
      cwdUrl.password ||
      cwdUrl.search ||
      cwdUrl.hash
    ) {
      throw new Error("Codex sandboxCwd metadata must contain a local file URI.");
    }
    return canonicalDirectory(fileURLToPath(cwdUrl));
  }

  const fallback = explicitWorkspaceRoot?.trim();
  if (fallback) return canonicalDirectory(fallback);

  throw new Error(
    "Codex ChatCut requires trusted Codex workspace metadata or CODEX_CHATCUT_WORKSPACE_ROOT.",
  );
}
