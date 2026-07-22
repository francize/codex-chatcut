import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const upstreamRoot = resolve(repositoryRoot, "vendor/openchatcut");
const hostPatch = resolve(
  repositoryRoot,
  "patches/openchatcut/0001-editor-only-codex-host.patch",
);
const pinnedRevision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";

/** @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

test("the Host Patch applies to the pin and removes chat from Codex Host Mode at the source composition seam", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-host-patch-"));
  const checkout = join(temporaryRoot, "openchatcut");

  try {
    assert.equal(await git(["rev-parse", "HEAD"], upstreamRoot), pinnedRevision);
    await git(["clone", "--shared", "--no-checkout", upstreamRoot, checkout], repositoryRoot);
    await git(["checkout", "--detach", pinnedRevision], checkout);

    // This is deliberately independent of the prepared runtime and UPSTREAM.json:
    // the patch itself must remain a portable artifact for the reviewed pin.
    await git(["apply", "--check", hostPatch], checkout);
    await git(["apply", hostPatch], checkout);
    await git(["diff", "--check"], checkout);

    const changedFiles = (await git(["diff", "--name-only"], checkout)).split("\n");
    assert.deepEqual(changedFiles, [
      "src/App.tsx",
      "src/Editor.tsx",
      "src/components/TopBar.tsx",
      "src/library/LibraryPanel.tsx",
      "src/library/TemplateBrowser.tsx",
      "src/shortcuts/useEditorActions.ts",
    ]);

    const app = await readFile(join(checkout, "src/App.tsx"), "utf8");
    const editor = await readFile(join(checkout, "src/Editor.tsx"), "utf8");
    const topBar = await readFile(join(checkout, "src/components/TopBar.tsx"), "utf8");
    const library = await readFile(join(checkout, "src/library/LibraryPanel.tsx"), "utf8");
    const templates = await readFile(join(checkout, "src/library/TemplateBrowser.tsx"), "utf8");
    const actions = await readFile(join(checkout, "src/shortcuts/useEditorActions.ts"), "utf8");

    assert.match(app, /const isCodexHost = new URLSearchParams\(window\.location\.search\)\.get\('host'\) === 'codex';/);
    assert.match(app, /if \(isCodexHost\) return;/);
    assert.match(app, /\}, \[isCodexHost\]\);/);
    assert.match(editor, /const isCodexHost = new URLSearchParams\(window\.location\.search\)\.get\('host'\) === 'codex';/);
    assert.doesNotMatch(editor, /import \{ ChatPanel \} from/);
    assert.match(editor, /const ChatPanel = lazy\(\(\) => import\('\.\/components\/chat\/ChatPanel'\)/);
    assert.match(editor, /useExternalAgentBridge\(agentCtx, project\.id\);/);
    assert.match(editor, /\{!isCodexHost && \([\s\S]*?<ChatPanel\b/);
    assert.match(editor, /\{!isCodexHost && !chatCollapsed && <Divider[\s\S]*?setChatW/);
    assert.match(editor, /gridTemplateColumns:\s*`\$\{isCodexHost \? 0 : chatCollapsed \? 46 : chatW\}px/);

    for (const retainedRegion of ["LibraryPanel", "PreviewPanel", "InspectorPanel", "Timeline"]) {
      assert.match(editor, new RegExp(`<${retainedRegion}\\b`), `${retainedRegion} must stay mounted`);
    }

    assert.match(editor, /onUseTemplateAI=\{isCodexHost \? undefined : useTemplateAI\}/);
    assert.match(editor, /onSeedChat=\{isCodexHost \? undefined : \(text\) => setChatSeed/);
    assert.match(editor, /showLayoutToggle=\{!isCodexHost\}/);
    assert.match(editor, /\.\.\.\(!isCodexHost \? \{/);
    assert.match(actions, /toggleLayout\?: \(\) => void;/);
    assert.match(actions, /focusAgent\?: \(\) => void;/);
    assert.match(actions, /\.\.\.\(deps\.toggleLayout \? \{ 'toggle-layout'/);
    assert.match(actions, /\.\.\.\(deps\.focusAgent \? \{ 'ask-ai'/);
    assert.match(topBar, /showLayoutToggle\?: boolean;/);
    assert.match(topBar, /showLayoutToggle && \(/);
    assert.match(library, /onUseTemplateAI\?: \(tpl: Tpl\) => void;/);
    assert.match(templates, /onUseAI\?: \(tpl: Tpl\) => void;/);
    assert.match(templates, /\{onUseAI && \(\s*<button/s);

    // Host Mode is structural, not a CSS disguise. Standalone remains the default.
    assert.doesNotMatch(await git(["diff", "--name-only"], checkout), /\.css$/m);
    assert.match(topBar, /showLayoutToggle = true/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
