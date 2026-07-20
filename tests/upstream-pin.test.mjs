import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { inspectUpstream } from "../scripts/verify-upstream.mjs";

test("the OpenChatCut dependency is pinned, clean, licensed, and patchable", async () => {
  const lock = JSON.parse(await readFile(new URL("../UPSTREAM.json", import.meta.url), "utf8"));
  assert.equal(lock.repository, "https://github.com/0xsline/OpenChatCut.git");
  assert.equal(lock.revision, "850c238b894c2b0138ffc7944e8c7e2c30156fcd");
  assert.equal(lock.nodeMajor, 24);

  const report = await inspectUpstream();
  assert.equal(report.revision, lock.revision);
  assert.equal(report.clean, true);
  assert.equal(report.remote, lock.repository);
  assert.deepEqual(report.patches, lock.patches);

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pluginJson = JSON.parse(
    await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.license, "AGPL-3.0-or-later");
  assert.equal(pluginJson.license, "AGPL-3.0-or-later");

  await assert.rejects(
    inspectUpstream({ expectedRevision: "0000000000000000000000000000000000000000" }),
    /does not match the reviewed pin/,
  );
});
