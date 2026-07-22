import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  calculatePatchDigest,
  calculatePreparedSourceDigest,
} from "../scripts/prepare-openchatcut.mjs";
import { readUpstreamLock } from "../scripts/verify-upstream.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} source @param {string} target */
async function copyRepositoryFile(source, target) {
  const destination = resolve(target, source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(repositoryRoot, source), destination);
}

/** @param {string} fixtureRoot */
async function createPreparedFixture(fixtureRoot) {
  const lock = await readUpstreamLock();
  const digest = await calculatePatchDigest(lock.patches);
  await Promise.all([
    copyRepositoryFile("UPSTREAM.json", fixtureRoot),
    copyRepositoryFile("scripts/prepare-openchatcut.mjs", fixtureRoot),
    copyRepositoryFile("scripts/verify-upstream.mjs", fixtureRoot),
    copyRepositoryFile("mcp/lib/openchatcut-runtime.mjs", fixtureRoot),
    ...lock.patches.map((patch) => copyRepositoryFile(patch, fixtureRoot)),
  ]);

  const fixtureUpstream = resolve(fixtureRoot, "vendor/openchatcut");
  await mkdir(dirname(fixtureUpstream), { recursive: true });
  await execFileAsync(
    "git",
    ["clone", "--shared", "--no-checkout", resolve(repositoryRoot, "vendor/openchatcut"), fixtureUpstream],
  );
  await execFileAsync("git", ["checkout", "--detach", lock.revision], { cwd: fixtureUpstream });
  await execFileAsync("git", ["remote", "set-url", "origin", lock.repository], {
    cwd: fixtureUpstream,
  });

  const runtimeRoot = resolve(fixtureRoot, ".runtime");
  const target = resolve(
    runtimeRoot,
    `openchatcut-${lock.revision.slice(0, 12)}-${digest.slice(0, 12)}`,
  );
  const markerPath = resolve(target, ".codex-chatcut-prepared.json");
  const marker = {
    revision: lock.revision,
    patchDigest: digest,
    patches: lock.patches,
    nodeMajor: lock.nodeMajor,
    builtWithNode: `v${lock.nodeMajor}.0.0`,
    built: true,
  };
  await mkdir(resolve(target, "dist"), { recursive: true });
  await mkdir(resolve(target, "node_modules/tsx"), { recursive: true });
  await writeFile(resolve(target, "dist/index.html"), "<!doctype html>");
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  const prepareRunner = resolve(fixtureRoot, "run-prepare.mjs");
  await writeFile(
    prepareRunner,
    'import { prepareOpenChatCut } from "./scripts/prepare-openchatcut.mjs";\n' +
      "await prepareOpenChatCut({ build: true });\n",
  );
  return { lock, digest, runtimeRoot, target, markerPath, prepareRunner };
}

/** @param {string} path */
async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

test("a failed repeated build invalidates the old prepared runtime before npm mutates it", {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-rebuild-"));
  try {
    const { markerPath, prepareRunner, runtimeRoot } = await createPreparedFixture(fixtureRoot);

    const fakeBin = resolve(fixtureRoot, "fake-bin");
    const fakeNpm = resolve(fakeBin, "npm");
    await mkdir(fakeBin);
    await writeFile(
      fakeNpm,
      [
        "#!/bin/sh",
        "printf 'half rebuilt\\n' > \"$PWD/dist/half-rebuilt.txt\"",
        "printf 'simulated npm failure\\n' >&2",
        "exit 42",
        "",
      ].join("\n"),
    );
    await chmod(fakeNpm, 0o700);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [prepareRunner],
        {
          cwd: fixtureRoot,
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        },
      ),
      /simulated npm failure/,
    );

    const markerAfterFailure = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(markerAfterFailure.built, false);

    const fixtureRuntime = await import(
      `${pathToFileURL(resolve(fixtureRoot, "mcp/lib/openchatcut-runtime.mjs")).href}?fixture=${Date.now()}`
    );
    await assert.rejects(
      fixtureRuntime.findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("an incomplete existing prepared target gives an exact recoverable cleanup instruction", {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-incomplete-runtime-"));
  try {
    const { markerPath, prepareRunner, target } = await createPreparedFixture(fixtureRoot);
    await rm(markerPath);

    await assert.rejects(
      execFileAsync(process.execPath, [prepareRunner], { cwd: fixtureRoot }),
      (error) => {
        assert.match(String(error), /Prepared OpenChatCut directory is incomplete or inconsistent/u);
        assert.match(String(error), new RegExp(target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.match(String(error), /Remove this exact directory and rerun/u);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a successful build records the lock major and full Node builder version", {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-node-provenance-"));
  try {
    const { lock, markerPath, prepareRunner, target } = await createPreparedFixture(fixtureRoot);
    const fakeBin = resolve(fixtureRoot, "fake-bin");
    const fakeNpm = resolve(fakeBin, "npm");
    await mkdir(fakeBin);
    await writeFile(fakeNpm, "#!/bin/sh\nexit 0\n");
    await chmod(fakeNpm, 0o700);

    await execFileAsync(process.execPath, [prepareRunner], {
      cwd: fixtureRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });

    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.built, true);
    assert.equal(marker.nodeMajor, lock.nodeMajor);
    assert.equal(marker.builtWithNode, process.version);
    assert.equal(marker.sourceDigest, await calculatePreparedSourceDigest(target));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a repeated build replaces locally modified prepared source with the pinned tree", {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-canonical-rebuild-"));
  try {
    const { prepareRunner, target } = await createPreparedFixture(fixtureRoot);
    const fakeBin = resolve(fixtureRoot, "fake-bin");
    const fakeNpm = resolve(fakeBin, "npm");
    await mkdir(fakeBin);
    await writeFile(fakeNpm, "#!/bin/sh\nexit 0\n");
    await chmod(fakeNpm, 0o700);
    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };

    await rm(target, { recursive: true, force: true });
    await execFileAsync(process.execPath, [prepareRunner], {
      cwd: fixtureRoot,
      env: environment,
    });
    const canonicalPackage = await readFile(resolve(target, "package.json"), "utf8");

    await writeFile(resolve(target, "package.json"), '{"name":"locally-modified"}\n');
    await execFileAsync(process.execPath, [prepareRunner], {
      cwd: fixtureRoot,
      env: environment,
    });

    assert.equal(await readFile(resolve(target, "package.json"), "utf8"), canonicalPackage);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a concurrent prepare is rejected without restoring a ready marker", {
  timeout: 60_000,
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-concurrent-rebuild-"));
  const coordinationRoot = resolve(fixtureRoot, "coordination");
  const holderStarted = resolve(coordinationRoot, "holder-started");
  const releaseHolder = resolve(coordinationRoot, "release-holder");
  /** @type {ReturnType<typeof execFileAsync> | null} */
  let holder = null;
  try {
    const { markerPath, prepareRunner, runtimeRoot, target } =
      await createPreparedFixture(fixtureRoot);
    const fakeBin = resolve(fixtureRoot, "fake-bin");
    const fakeNpm = resolve(fakeBin, "npm");
    await mkdir(fakeBin);
    await mkdir(coordinationRoot);
    await writeFile(
      fakeNpm,
      [
        "#!/bin/sh",
        "if [ \"$BUILD_ROLE\" = \"holder\" ]; then",
        "  : > \"$BUILD_COORDINATION/holder-started\"",
        "  while [ ! -f \"$BUILD_COORDINATION/release-holder\" ]; do sleep 0.05; done",
        "  printf 'simulated holder failure\\n' >&2",
        "  exit 43",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(fakeNpm, 0o700);
    const baseEnvironment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      BUILD_COORDINATION: coordinationRoot,
    };

    holder = execFileAsync(process.execPath, [prepareRunner], {
      cwd: fixtureRoot,
      env: { ...baseEnvironment, BUILD_ROLE: "holder" },
    });
    await waitForFile(holderStarted);

    const fixtureRuntime = await import(
      `${pathToFileURL(resolve(fixtureRoot, "mcp/lib/openchatcut-runtime.mjs")).href}?fixture=${Date.now()}`
    );
    await assert.rejects(
      fixtureRuntime.findPreparedRoot({ runtimeRoot }),
      /currently being prepared/,
    );

    await assert.rejects(
      execFileAsync(process.execPath, [prepareRunner], {
        cwd: fixtureRoot,
        env: { ...baseEnvironment, BUILD_ROLE: "contender" },
      }),
      /already being prepared/,
    );

    await writeFile(releaseHolder, "release\n");
    await assert.rejects(holder, /simulated holder failure/);
    holder = null;

    const markerAfterFailure = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(markerAfterFailure.built, false);
    await assert.rejects(
      fixtureRuntime.findPreparedRoot({ runtimeRoot }),
      /No built OpenChatCut tree matches UPSTREAM\.json/,
    );
    await assert.rejects(readFile(`${target}.prepare.lock`), /ENOENT/);
  } finally {
    await writeFile(releaseHolder, "release\n").catch(() => undefined);
    await holder?.catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
