import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { findPreparedRoot } from "../mcp/lib/openchatcut-runtime.mjs";
import {
  calculatePatchDigest,
  calculatePreparedSourceDigest,
} from "../scripts/prepare-openchatcut.mjs";
import { readUpstreamLock } from "../scripts/verify-upstream.mjs";

/** @param {string} target @param {Record<string, unknown>} marker */
async function fakePreparedTree(target, marker) {
  await mkdir(resolve(target, "dist"), { recursive: true });
  await mkdir(resolve(target, "node_modules/tsx"), { recursive: true });
  await mkdir(resolve(target, "src"), { recursive: true });
  await writeFile(resolve(target, "dist/index.html"), "<!doctype html>");
  await writeFile(resolve(target, "src/editor.ts"), "export {};\n");
  await writeFile(
    resolve(target, ".codex-chatcut-prepared.json"),
    JSON.stringify({
      ...marker,
      sourceDigest: await calculatePreparedSourceDigest(target),
    }),
  );
}

test("runtime selection requires the exact patch digest and a completed build marker", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-runtime-selection-"));
  try {
    const lock = await readUpstreamLock();
    const digest = await calculatePatchDigest(lock.patches);
    const marker = {
      revision: lock.revision,
      patchDigest: digest,
      patches: lock.patches,
      nodeMajor: lock.nodeMajor,
      builtWithNode: `v${lock.nodeMajor}.0.0`,
    };
    const exact = resolve(
      runtimeRoot,
      `openchatcut-${lock.revision.slice(0, 12)}-${digest.slice(0, 12)}`,
    );
    const stale = resolve(
      runtimeRoot,
      `openchatcut-${lock.revision.slice(0, 12)}-ffffffffffff`,
    );
    await fakePreparedTree(stale, { ...marker, patchDigest: "f".repeat(64), built: true });
    await fakePreparedTree(exact, { ...marker, built: false });

    await assert.rejects(
      findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );

    await fakePreparedTree(exact, { ...marker, nodeMajor: 23, builtWithNode: "v23.11.0", built: true });
    await assert.rejects(
      findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );

    await fakePreparedTree(exact, { ...marker, builtWithNode: "v25.1.0", built: true });
    await assert.rejects(
      findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );

    await fakePreparedTree(exact, { ...marker, built: true });
    assert.equal(await findPreparedRoot({ runtimeRoot }), await realpath(exact));

    await writeFile(resolve(exact, "src/editor.ts"), "export const changed = true;\n");
    await assert.rejects(
      findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
