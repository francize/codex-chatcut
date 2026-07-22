import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { calculatePreparedSourceDigest } from "../scripts/prepare-openchatcut.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageScript = resolve(repositoryRoot, "scripts/stage-local-plugin.mjs");

/** @param {string} root @param {string} path @param {string} [contents] */
async function writeFixtureFile(root, path, contents = path) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/** @param {string} path @param {string} contents */
function patchDigest(path, contents) {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(contents)
    .update("\0")
    .digest("hex");
}

/** @param {string} root */
async function makeSourceFixture(root) {
  const revision = "a".repeat(40);
  const patchPath = "patches/openchatcut/0001-host.patch";
  const patchContents = "fixture host patch\n";
  const digest = patchDigest(patchPath, patchContents);
  const runtimeName = `openchatcut-${revision.slice(0, 12)}-${digest.slice(0, 12)}`;
  const marker = {
    revision,
    patchDigest: digest,
    patches: [patchPath],
    nodeMajor: 24,
    builtWithNode: "v24.13.0",
    built: true,
  };

  await writeFixtureFile(
    root,
    ".codex-plugin/plugin.json",
    JSON.stringify({
      name: "codex-chatcut",
      version: "0.1.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    }),
  );
  await writeFixtureFile(
    root,
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        codex_chatcut: { command: "node", args: ["./mcp/server.mjs"], cwd: "." },
      },
    }),
  );
  await writeFixtureFile(root, "mcp/server.mjs", "export {};\n");
  await writeFixtureFile(root, "mcp/lib/runtime.mjs", "export {};\n");
  await writeFixtureFile(root, "skills/open-chatcut/SKILL.md", "# fixture skill\n");
  await writeFixtureFile(root, "scripts/prepare-openchatcut.mjs", "export {};\n");
  await writeFixtureFile(root, "scripts/verify-upstream.mjs", "export {};\n");
  await writeFixtureFile(root, patchPath, patchContents);
  await writeFixtureFile(root, "LICENSE", "fixture license\n");
  await writeFixtureFile(root, "NOTICE", "fixture notice\n");
  await writeFixtureFile(root, "THIRD_PARTY_NOTICES.md", "fixture third parties\n");
  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "codex-chatcut", private: true, type: "module" }),
  );
  await writeFixtureFile(
    root,
    "UPSTREAM.json",
    JSON.stringify({ repository: "https://example.invalid/upstream.git", revision, nodeMajor: 24, patches: [patchPath] }),
  );
  await writeFixtureFile(root, "package-lock.json", "fixture dependency lock\n");
  await writeFixtureFile(root, "node_modules/runtime-dependency/index.mjs", "export {};\n");
  await mkdir(resolve(root, "node_modules/.bin"), { recursive: true });
  await symlink(
    "../runtime-dependency/index.mjs",
    resolve(root, "node_modules/.bin/runtime-dependency"),
  );

  const runtimeRoot = resolve(root, ".runtime", runtimeName);
  await writeFixtureFile(runtimeRoot, "dist/index.html", "<!doctype html>\n");
  await writeFixtureFile(runtimeRoot, "desktop/codex-sidecar.ts", "export {};\n");
  await writeFixtureFile(runtimeRoot, "node_modules/tsx/index.mjs", "export {};\n");
  await mkdir(resolve(runtimeRoot, "node_modules/.bin"), { recursive: true });
  await symlink("../tsx/index.mjs", resolve(runtimeRoot, "node_modules/.bin/tsx"));
  await writeFixtureFile(runtimeRoot, "src/editor.ts", "export {};\n");

  for (const path of [
    ".git/config",
    ".scratch/secret.txt",
    ".codex-chatcut/project.json",
    "tests/repository-test.mjs",
    "unrelated-secret.txt",
    `.runtime/${runtimeName}/.git/config`,
    `.runtime/${runtimeName}/.scratch/secret.txt`,
    `.runtime/${runtimeName}/.codex-chatcut/project.json`,
    `.runtime/${runtimeName}/tests/upstream-test.ts`,
    ".runtime/openchatcut-stale/.codex-chatcut-prepared.json",
  ]) {
    await writeFixtureFile(root, path, "must not be staged\n");
  }

  await writeFixtureFile(
    runtimeRoot,
    ".codex-chatcut-prepared.json",
    JSON.stringify({
      ...marker,
      sourceDigest: await calculatePreparedSourceDigest(runtimeRoot),
    }),
  );

  return { runtimeName };
}

/** @param {string} root */
async function listRelativePaths(root) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} directory */
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      paths.push(relative(root, absolute));
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return paths.sort();
}

/** @param {string} sourceRoot @param {string} stageRoot */
async function runStage(sourceRoot, stageRoot) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [stageScript, "--source-root", sourceRoot, "--stage-root", stageRoot, "--json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

/** @param {string} sourceRoot @param {string} stageRoot */
async function validateStage(sourceRoot, stageRoot) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      stageScript,
      "--check",
      "--source-root",
      sourceRoot,
      "--stage-root",
      stageRoot,
      "--json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

/** @param {unknown} error */
function commandStderr(error) {
  return error && typeof error === "object" && "stderr" in error
    ? String(error.stderr)
    : String(error);
}

test("local plugin staging copies only the plugin allowlist and exact prepared runtime", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stage-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stage-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    const result = await runStage(fixtureRoot, stageRoot);
    const bundleRoot = await realpath(result.bundleRoot);

    assert.equal(bundleRoot, await realpath(resolve(stageRoot, "current")));
    const currentInfo = await lstat(resolve(stageRoot, "current"));
    assert.equal(currentInfo.isDirectory(), true);
    assert.equal(currentInfo.isSymbolicLink(), false);
    assert.deepEqual(await readdir(resolve(bundleRoot, ".runtime")), [runtimeName]);

    const topLevel = (await readdir(bundleRoot)).sort();
    assert.deepEqual(topLevel, [
      ".codex-chatcut-local-stage.json",
      ".codex-plugin",
      ".mcp.json",
      ".runtime",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "UPSTREAM.json",
      "mcp",
      "node_modules",
      "package-lock.json",
      "package.json",
      "patches",
      "scripts",
      "skills",
    ]);

    const relativePaths = await listRelativePaths(bundleRoot);
    for (const forbidden of [".git", ".scratch", ".codex-chatcut", "tests"]) {
      assert.equal(
        relativePaths.some((path) => path.split("/").includes(forbidden)),
        false,
        `staged bundle contains forbidden path segment ${forbidden}`,
      );
    }
    assert.equal(relativePaths.includes("unrelated-secret.txt"), false);
    assert.equal(relativePaths.includes("node_modules/runtime-dependency/index.mjs"), true);
    assert.equal(
      relativePaths.includes(`.runtime/${runtimeName}/node_modules/tsx/index.mjs`),
      true,
    );
    assert.equal(
      await readlink(resolve(bundleRoot, "node_modules/.bin/runtime-dependency")),
      "../runtime-dependency/index.mjs",
    );
    assert.equal(
      await readlink(resolve(bundleRoot, ".runtime", runtimeName, "node_modules/.bin/tsx")),
      "../tsx/index.mjs",
    );

    const marker = JSON.parse(
      await readFile(resolve(bundleRoot, ".codex-chatcut-local-stage.json"), "utf8"),
    );
    assert.equal(marker.localOnly, true);
    assert.equal(marker.publishable, false);
    assert.match(marker.contentAddress, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(marker.contentAddress, result.contentAddress);

    const validation = await validateStage(fixtureRoot, stageRoot);
    assert.equal(validation.valid, true);
    assert.equal(validation.contentAddress, result.contentAddress);

    const repeated = await runStage(fixtureRoot, stageRoot);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.contentAddress, result.contentAddress);

    await writeFixtureFile(fixtureRoot, "mcp/server.mjs", "export const changed = true;\n");
    const changed = await runStage(fixtureRoot, stageRoot);
    assert.equal(changed.reused, false);
    assert.notEqual(changed.contentAddress, result.contentAddress);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging rejects prepared source changed after the reviewed build", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stage-dirty-runtime-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stage-dirty-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    await writeFixtureFile(
      resolve(fixtureRoot, ".runtime", runtimeName),
      "src/editor.ts",
      "export const locallyChanged = true;\n",
    );
    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /sourceDigest|prepared marker does not match/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin validation rejects a stage after any allowlisted source input changes", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stale-stage-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-stale-stage-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    await runStage(fixtureRoot, stageRoot);

    /** @type {Array<[string, string, (value: string) => string]>} */
    const cases = [
      ["plugin manifest", ".codex-plugin/plugin.json", (value) => {
        const json = JSON.parse(value);
        json.version = "0.1.1";
        return JSON.stringify(json);
      }],
      ["MCP config", ".mcp.json", (value) => {
        const json = JSON.parse(value);
        json.mcpServers.codex_chatcut.description = "changed";
        return JSON.stringify(json);
      }],
      ["root package", "package.json", (value) => {
        const json = JSON.parse(value);
        json.version = "0.1.1";
        return JSON.stringify(json);
      }],
      ["MCP glue", "mcp/server.mjs", (value) => `${value}\n// changed\n`],
      ["skill", "skills/open-chatcut/SKILL.md", (value) => `${value}\nchanged\n`],
      ["runtime support glue", "scripts/prepare-openchatcut.mjs", (value) => `${value}\n// changed\n`],
      ["root dependency tree", "node_modules/runtime-dependency/index.mjs", (value) => `${value}\n// changed\n`],
      ["Host Patch", "patches/openchatcut/0001-host.patch", (value) => `${value}changed\n`],
      [
        "prepared runtime",
        `.runtime/${runtimeName}/dist/index.html`,
        (value) => `${value}<!-- changed -->\n`,
      ],
      ["upstream lock", "UPSTREAM.json", (value) => {
        const json = JSON.parse(value);
        json.revision = "b".repeat(40);
        return JSON.stringify(json);
      }],
    ];

    for (const [label, path, change] of cases) {
      await t.test(String(label), async () => {
        const absolute = resolve(fixtureRoot, String(path));
        const original = await readFile(absolute, "utf8");
        await writeFile(absolute, change(original));
        try {
          await assert.rejects(
            validateStage(fixtureRoot, stageRoot),
            (error) => {
              assert.match(commandStderr(error), /staged local plugin is stale/isu);
              assert.match(commandStderr(error), /npm run stage:plugin/u);
              return true;
            },
          );
        } finally {
          await writeFile(absolute, original);
        }
      });
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging and validation reject an active prepared-runtime lock", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-locked-runtime-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-locked-runtime-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    const runtimeLock = resolve(fixtureRoot, ".runtime", `${runtimeName}.prepare.lock`);
    await writeFile(runtimeLock, "active prepare\n");

    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /OpenChatCut runtime is currently being prepared/u,
    );
    await assert.rejects(lstat(resolve(stageRoot, "current")), /ENOENT/u);

    await rm(runtimeLock);
    await runStage(fixtureRoot, stageRoot);
    await writeFile(runtimeLock, "active prepare\n");
    await assert.rejects(
      validateStage(fixtureRoot, stageRoot),
      /OpenChatCut runtime is currently being prepared/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging refuses an unbuilt exact runtime even when stale runtimes exist", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-unbuilt-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-unbuilt-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    const markerPath = resolve(
      fixtureRoot,
      ".runtime",
      runtimeName,
      ".codex-chatcut-prepared.json",
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, built: false }));
    await writeFixtureFile(
      fixtureRoot,
      ".runtime/openchatcut-stale/.codex-chatcut-prepared.json",
      JSON.stringify({ ...marker, built: true, patchDigest: "f".repeat(64) }),
    );

    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /No built prepared OpenChatCut runtime matches the current UPSTREAM\.json digest.*built=true/us,
    );
    await assert.rejects(lstat(resolve(stageRoot, "current")), /ENOENT/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging rejects runtime markers built for a different Node major", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-runtime-node-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-runtime-node-output-"));
  try {
    const { runtimeName } = await makeSourceFixture(fixtureRoot);
    const markerPath = resolve(
      fixtureRoot,
      ".runtime",
      runtimeName,
      ".codex-chatcut-prepared.json",
    );
    const original = JSON.parse(await readFile(markerPath, "utf8"));
    for (const [label, marker] of [
      ["lock major mismatch", { ...original, nodeMajor: 23, builtWithNode: "v23.11.0" }],
      ["builder major mismatch", { ...original, nodeMajor: 24, builtWithNode: "v25.1.0" }],
    ]) {
      await t.test(label, async () => {
        await writeFile(markerPath, JSON.stringify(marker));
        await assert.rejects(
          runStage(fixtureRoot, stageRoot),
          /No built prepared OpenChatCut runtime.*built with Node 24/us,
        );
      });
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging explains how to prepare a completely missing runtime", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-missing-runtime-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-missing-runtime-output-"));
  try {
    await makeSourceFixture(fixtureRoot);
    await rm(resolve(fixtureRoot, ".runtime"), { recursive: true, force: true });

    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /No built prepared OpenChatCut runtime.*Run Node 24: node scripts\/prepare-openchatcut\.mjs --build/us,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin staging fails closed when the stage root is a symlink", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-symlink-source-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-symlink-outside-"));
  const stageRoot = resolve(fixtureRoot, ".local-plugin");
  try {
    await makeSourceFixture(fixtureRoot);
    await symlink(outsideRoot, stageRoot, "dir");

    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /stage root must be a real directory, not a symlink/u,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [stageScript, "--check", "--source-root", fixtureRoot, "--stage-root", stageRoot],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
      /stage root must be a real directory, not a symlink/u,
    );
    assert.deepEqual(await readdir(outsideRoot), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("local plugin staging fails closed when current is a symlink", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-current-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-current-stage-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-current-outside-"));
  try {
    await makeSourceFixture(fixtureRoot);
    await symlink(outsideRoot, resolve(stageRoot, "current"), "dir");

    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /current path must be a real directory, not a symlink/u,
    );
    assert.deepEqual(await readdir(outsideRoot), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("local plugin staging rejects an output nested in a recursively copied source tree", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-overlap-source-"));
  try {
    await makeSourceFixture(fixtureRoot);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          stageScript,
          "--source-root",
          fixtureRoot,
          "--stage-root",
          resolve(fixtureRoot, "mcp", "local-stage"),
        ],
        { cwd: repositoryRoot, encoding: "utf8", timeout: 2_000 },
      ),
      /stage root overlaps recursively copied source/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("local plugin staging rejects dependency symlinks that escape their copied subtree", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-link-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-link-stage-"));
  try {
    await makeSourceFixture(fixtureRoot);
    await symlink(
      "../../unrelated-secret.txt",
      resolve(fixtureRoot, "node_modules/.bin/escape"),
    );
    await assert.rejects(
      runStage(fixtureRoot, stageRoot),
      /Escaping or forbidden symlink is not allowed/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("the local marketplace installs only the staged real directory", async () => {
  const marketplace = JSON.parse(
    await readFile(resolve(repositoryRoot, ".agents/plugins/marketplace.json"), "utf8"),
  );
  assert.equal(marketplace.plugins[0].source.source, "local");
  assert.equal(marketplace.plugins[0].source.path, "./.local-plugin/current");
});

test("the generated local plugin bundle is repository-ignored", async () => {
  const { stdout } = await execFileAsync(
    "git",
    ["check-ignore", "--verbose", ".local-plugin/current/.codex-plugin/plugin.json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.match(stdout, /^\.gitignore:\d+:\.local-plugin\//u);
});

test("package scripts expose explicit local plugin staging", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts["stage:plugin"], "node scripts/stage-local-plugin.mjs");
  assert.equal(
    packageJson.scripts["validate:plugin"],
    "node scripts/stage-local-plugin.mjs --check",
  );
});

test("CI stages and validates the real prepared runtime", async () => {
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const prepare = workflow.indexOf("node scripts/prepare-openchatcut.mjs --build");
  const stage = workflow.indexOf("npm run stage:plugin");
  const validate = workflow.indexOf("npm run validate:plugin");
  assert.notEqual(prepare, -1);
  assert.notEqual(stage, -1);
  assert.notEqual(validate, -1);
  assert.ok(prepare < stage, "CI must build the exact runtime before staging it");
  assert.ok(stage < validate, "CI must validate the bundle it just staged");
  assert.match(workflow, /git diff --check "\$base\.\.HEAD"/u);
  assert.doesNotMatch(workflow, /run: git diff --check\s*$/mu);
});

test("source installation documents staging before marketplace install", async () => {
  const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
  const stageCommand = readme.indexOf("npm run stage:plugin");
  const marketplaceCommand = readme.indexOf("codex plugin marketplace add ~/plugins/codex-chatcut");
  assert.notEqual(stageCommand, -1);
  assert.notEqual(marketplaceCommand, -1);
  assert.ok(stageCommand < marketplaceCommand);
  assert.match(readme, /\.local-plugin\/current/u);
  assert.match(readme, /仅用于本机/u);
  assert.match(readme, /不得发布/u);
  assert.doesNotMatch(
    readme,
    /codex plugin marketplace add francize\/codex-chatcut/u,
  );
  assert.match(readme, /远端 Git marketplace snapshot.*不可安装/us);
});

test("local plugin validation gives a clear error before staging", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-unstaged-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-unstaged-output-"));
  try {
    await makeSourceFixture(fixtureRoot);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          stageScript,
          "--check",
          "--source-root",
          fixtureRoot,
          "--stage-root",
          stageRoot,
          "--json",
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
      (error) => {
        assert.match(commandStderr(error), /No staged local plugin is available/u);
        assert.match(commandStderr(error), /npm run stage:plugin/u);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});

test("local plugin validation rejects forbidden paths added after staging", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-tampered-source-"));
  const stageRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-tampered-output-"));
  try {
    await makeSourceFixture(fixtureRoot);
    const staged = await runStage(fixtureRoot, stageRoot);
    await writeFixtureFile(staged.bundleRoot, ".git/config", "leaked repository metadata\n");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          stageScript,
          "--check",
          "--source-root",
          fixtureRoot,
          "--stage-root",
          stageRoot,
          "--json",
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
      (error) => {
        assert.match(commandStderr(error), /forbidden path segment \.git/u);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
});
