import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, "vendor/openchatcut");
const revision = "850c238b894c2b0138ffc7944e8c7e2c30156fcd";
const patches = [
  "0001-editor-only-codex-host.patch",
  "0002-windowless-sidecar.patch",
  "0003-secure-external-bridge.patch",
  "0004-reuse-native-proposals.patch",
].map((name) => resolve(root, "patches/openchatcut", name));

/** @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

test("standalone external tools keep the pinned immediate execute-and-save contract", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-standalone-contract-"));
  const checkout = join(temporaryRoot, "openchatcut");
  const bundle = join(temporaryRoot, "external-tool-executor.mjs");

  try {
    await git(["clone", "--shared", "--no-checkout", upstream, checkout], root);
    await git(["checkout", "--detach", revision], checkout);
    for (const patch of patches) await git(["apply", patch], checkout);

    await build({
      entryPoints: [resolve(checkout, "src/agent/externalToolExecutor.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const { executeExternalTool } = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);

    /** @type {{value: number}} */
    let live = { value: 0 };
    /** @type {string[]} */
    const order = [];
    /** @type {unknown[]} */
    const saves = [];
    const context = {
      commands: {
        applyDoc(/** @type {any} */ next) {
          live = next;
        },
      },
      getDoc: () => live,
      getState: () => live,
    };
    const proposalController = {
      async executeNative() {
        throw new Error("standalone must not enter Codex proposal mode");
      },
    };
    const result = await executeExternalTool({
      name: "move_item",
      args: { value: 7 },
      context,
      projectId: "project-1",
      codexHost: false,
      nativeToolNames: new Set(["move_item"]),
      proposalController,
      dependencies: {
        async executeTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) {
          order.push(`execute:${name}`);
          ctx.commands.applyDoc({ value: args.value });
          return { editedBy: name };
        },
        async afterCommit() {
          order.push("paint");
        },
        async saveProject(/** @type {string} */ projectId, /** @type {unknown} */ doc) {
          order.push(`save:${projectId}`);
          saves.push(doc);
        },
      },
    });

    assert.deepEqual(result, { editedBy: "move_item" });
    assert.deepEqual(live, { value: 7 });
    assert.deepEqual(order, ["execute:move_item", "paint", "save:project-1"]);
    assert.deepEqual(saves, [{ value: 7 }]);

    /** @type {string[]} */
    const codexOrder = [];
    const codexController = {
      async hydrate() {
        codexOrder.push("hydrate");
      },
      refreshStale() {
        codexOrder.push("refresh");
      },
      getState() {
        codexOrder.push("state");
        return { proposal: null, stale: false, hydrated: true };
      },
    };
    const proposalState = await executeExternalTool({
      name: "get_chatcut_proposal",
      args: {},
      context,
      projectId: "project-1",
      codexHost: true,
      nativeToolNames: new Set(["move_item"]),
      proposalController: codexController,
      dependencies: {
        async executeTool() {
          throw new Error("read control must not execute an editor tool");
        },
        async afterCommit() {},
        async saveProject() {},
      },
    });
    assert.deepEqual(codexOrder, ["hydrate", "refresh", "state"]);
    assert.deepEqual(proposalState, {
      projectId: "project-1",
      proposal: null,
      stale: false,
      hydrated: true,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("ChatPanel and Codex bridge share one persistent upstream proposal controller", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codex-chatcut-shared-proposal-"));
  const checkout = join(temporaryRoot, "openchatcut");
  const controllerBundle = join(temporaryRoot, "proposal-controller.mjs");

  try {
    await git(["clone", "--shared", "--no-checkout", upstream, checkout], root);
    await git(["checkout", "--detach", revision], checkout);
    for (const patch of patches) {
      await git(["apply", "--check", patch], checkout);
      await git(["apply", patch], checkout);
    }
    await git(["diff", "--check"], checkout);

    const controllerSource = await readFile(resolve(checkout, "src/agent/proposalController.ts"), "utf8");
    const runtimeSource = await readFile(resolve(checkout, "src/agent/proposalControllerRuntime.ts"), "utf8");
    const executorSource = await readFile(resolve(checkout, "src/agent/externalToolExecutor.ts"), "utf8");
    const bridgeSource = await readFile(resolve(checkout, "src/agent/useExternalAgentBridge.ts"), "utf8");
    const useAgentSource = await readFile(resolve(checkout, "src/agent/useAgent.ts"), "utf8");
    const editorSource = await readFile(resolve(checkout, "src/Editor.tsx"), "utf8");
    const chatPanelSource = await readFile(resolve(checkout, "src/components/chat/ChatPanel.tsx"), "utf8");

    assert.equal(await exists(resolve(checkout, "src/agent/externalProposalSession.ts")), false);
    for (const primitive of [
      "makeDraft",
      "executeTool",
      "buildOperation",
      "buildProposal",
      "isProposalStale",
      "partitionProposalActions",
      "replayActions",
      "saveProject",
      "loadProposal",
      "saveProposal",
      "clearProposal",
    ]) {
      assert.match(runtimeSource, new RegExp(`\\b${primitive}\\b`), `${primitive} must be wired directly`);
      assert.match(controllerSource, new RegExp(`dependencies\\.${primitive}\\b`), `${primitive} must drive the shared controller`);
    }
    assert.doesNotMatch(`${controllerSource}\n${runtimeSource}\n${executorSource}`, /TimelinePatch|\brevision\b/);
    assert.match(useAgentSource, /proposalController\.beginDraft\(\)/);
    assert.match(useAgentSource, /proposalRun\.recordTool\(/);
    assert.match(useAgentSource, /await proposalController\.hydrate\(\);[\s\S]*?proposalController\.getState\(\)\.proposal/);
    assert.match(useAgentSource, /const runGateRef = useRef\(false\)/);
    assert.match(
      useAgentSource,
      /runGateRef\.current = true;[\s\S]*?await proposalController\.hydrate\(\)/,
      "standalone send must acquire its turn gate before asynchronous proposal hydration",
    );
    assert.match(
      useAgentSource,
      /proposalController\.apply\(selected, \{[\s\S]*?onApplied:[\s\S]*?llmRef\.current\.push/,
      "apply acknowledgement must be recorded before the proposal state boundary is cleared",
    );
    assert.match(
      useAgentSource,
      /proposalController\.apply\(selected, \{[\s\S]*?force: true,[\s\S]*?onApplied:[\s\S]*?llmRef\.current\.push/,
      "force-apply acknowledgement must use the same pre-boundary persistence ordering",
    );
    assert.match(bridgeSource, /executeExternalTool\(/);
    assert.match(bridgeSource, /codexHost \? \[\.\.\.TOOL_SCHEMAS, \.\.\.CODEX_PROPOSAL_TOOL_SCHEMAS\] : TOOL_SCHEMAS/);
    assert.match(editorSource, /createProposalController\(/);
    assert.match(editorSource, /useExternalAgentBridge\(agentCtx, project\.id, proposalController, isCodexHost\)/);
    assert.match(chatPanelSource, /useAgent\(ctx, projectId, proposalController\)/);
    assert.match(editorSource, /<ProposalCard\b/);
    assert.match(editorSource, /\{isCodexHost && externalBridge\.proposal/);
    assert.match(editorSource, /\{!isCodexHost && \([\s\S]*?<ChatPanel\b/);

    await build({
      entryPoints: [resolve(checkout, "src/agent/proposalController.ts")],
      outfile: controllerBundle,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const { ProposalController } = await import(
      `${pathToFileURL(controllerBundle).href}?test=${Date.now()}`
    );

    /** @type {{value: number, assets: unknown[]}} */
    const initial = { value: 0, assets: [] };
    /** @type {{value: number, assets: unknown[]}} */
    let live = initial;
    /** @type {Array<{value: number, assets: unknown[]}>} */
    const history = [];
    let applyCount = 0;
    let undoCount = 0;
    /** @type {any} */
    let storedProposal = null;
    /** @type {Array<{projectId: string, doc: unknown}>} */
    const saves = [];

    /** @type {any} */
    const context = {
      commands: {
        applyDoc(/** @type {any} */ next) {
          history.push(live);
          live = next;
          applyCount += 1;
        },
        undo() {
          const previous = history.pop();
          if (previous) live = previous;
          undoCount += 1;
        },
      },
      getDoc: () => live,
      getState: () => live,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    };

    /** @type {any} */
    const dependencies = {
      makeDraft(/** @type {any} */ base) {
        let draftDoc = base;
        /** @type {any[]} */
        let actions = [];
        return {
          commands: {
            applyDoc(/** @type {any} */ next) {
              const action = { type: "setValue", value: next.value };
              draftDoc = dependencies.replayActions(draftDoc, [action]);
              actions.push(action);
            },
            addAsset(/** @type {any} */ asset) {
              const action = { type: "addAsset", asset };
              draftDoc = dependencies.replayActions(draftDoc, [action]);
              actions.push(action);
            },
          },
          getDoc: () => draftDoc,
          getState: () => draftDoc,
          takeActions() {
            const taken = actions;
            actions = [];
            return taken;
          },
        };
      },
      async executeTool(
        /** @type {string} */ name,
        /** @type {any} */ args,
        /** @type {any} */ draftContext,
      ) {
        if (name === "read_timeline") return { value: draftContext.getDoc().value };
        if (name === "persist_asset") {
          draftContext.commands.addAsset(args.asset);
          return { assetId: args.asset.id };
        }
        if (name === "race_move") {
          live = { ...live, value: 77 };
          draftContext.commands.applyDoc({ ...draftContext.getDoc(), value: args.value });
          return { editedBy: name, value: args.value };
        }
        draftContext.commands.applyDoc({ ...draftContext.getDoc(), value: args.value });
        return { editedBy: name, value: args.value };
      },
      buildOperation(
        /** @type {string} */ tool,
        /** @type {any} */ args,
        /** @type {any[]} */ actions,
      ) {
        return { tool, args, actions, action: tool, target: "timeline", impact: `${actions.length}` };
      },
      buildProposal(
        /** @type {any[]} */ operations,
        /** @type {string} */ summary,
        /** @type {any} */ baseDoc,
        /** @type {any} */ resultState,
      ) {
        return {
          title: "Agent edit proposal",
          summary,
          totalImpact: `${operations.length}`,
          options: [{ id: "opt-1", label: "all", recommended: true, summary, totalImpact: `${operations.length}`, operations }],
          baseDoc,
          resultState,
        };
      },
      isProposalStale(/** @type {any} */ proposal, /** @type {any} */ current) {
        return JSON.stringify(proposal.baseDoc) !== JSON.stringify(current);
      },
      partitionProposalActions(/** @type {any[]} */ actions) {
        return {
          persistent: actions.filter((action) => action.type === "addAsset"),
          proposed: actions.filter((action) => action.type !== "addAsset"),
        };
      },
      replayActions(/** @type {any} */ base, /** @type {any[]} */ actions) {
        return actions.reduce(
          (doc, action) => {
            if (action.type === "setValue") return { ...doc, value: action.value };
            if (action.type === "addAsset") return { ...doc, assets: [...doc.assets, action.asset] };
            return doc;
          },
          base,
        );
      },
      async loadProposal() {
        return storedProposal;
      },
      async saveProposal(/** @type {string} */ _projectId, /** @type {any} */ proposal) {
        storedProposal = structuredClone(proposal);
      },
      async clearProposal() {
        storedProposal = null;
      },
      async saveProject(/** @type {string} */ projectId, /** @type {unknown} */ doc) {
        saves.push({ projectId, doc });
      },
      async afterCommit() {},
    };

    const createController = () => new ProposalController({
      projectId: "project-1",
      getContext: () => context,
      dependencies,
    });
    const controller = createController();
    await controller.hydrate();

    assert.deepEqual(await controller.executeNative("read_timeline", {}), { value: 0 });
    assert.equal(live, initial, "read-only native tools must not replace the live doc");

    const proposed = await controller.executeNative("move_item", { value: 1 });
    assert.equal(proposed.status, "proposal_pending");
    assert.equal(live, initial, "propose must leave the live ProjectDoc unchanged");
    assert.equal(applyCount, 0);
    assert.ok(storedProposal, "the upstream proposal store must be written before returning");

    // Simulate a full editor reload: a new controller must hydrate the exact
    // pending proposal from the shared upstream proposalStore seam before a
    // control call, even if the React hydration effect has not finished yet.
    const reloaded = createController();
    const applied = await reloaded.apply();
    assert.equal(applied.status, "applied");
    assert.equal(live.value, 1);
    assert.equal(applyCount, 1, "apply must be one native applyDoc step");
    assert.equal(storedProposal, null, "apply must clear the persisted proposal");

    await reloaded.undo();
    assert.equal(undoCount, 1);
    assert.equal(live.value, 0, "native undo must restore the previous ProjectDoc");

    await reloaded.executeNative("move_item", { value: 2 });
    const pendingBeforeClear = structuredClone(storedProposal);
    /** @type {(proposal: any) => void} */
    let resolveRacedLoad = () => {};
    const racedDependencies = {
      ...dependencies,
      loadProposal: () => new Promise((resolve) => {
        resolveRacedLoad = resolve;
      }),
    };
    const clearDuringHydration = new ProposalController({
      projectId: "project-1",
      getContext: () => context,
      dependencies: racedDependencies,
    });
    const racedHydration = clearDuringHydration.hydrate();
    await Promise.resolve();
    await clearDuringHydration.clear();
    resolveRacedLoad(pendingBeforeClear);
    await racedHydration;
    assert.equal(
      clearDuringHydration.getState().proposal,
      null,
      "a late storage read must not resurrect a proposal cleared during hydration",
    );

    await reloaded.reject();
    await reloaded.executeNative("move_item", { value: 2 });
    await reloaded.reject();
    assert.equal(storedProposal, null, "reject must clear the persisted proposal");
    const afterRejectReload = createController();
    await afterRejectReload.hydrate();
    assert.equal(afterRejectReload.getState().proposal, null);

    await afterRejectReload.executeNative("move_item", { value: 3 });
    live = { ...live, value: 99 };
    const staleLive = live;
    const stale = await afterRejectReload.apply();
    assert.equal(stale.status, "stale");
    assert.equal(live, staleLive, "stale apply must not mutate the live ProjectDoc");
    assert.equal(afterRejectReload.getState().stale, true);

    await afterRejectReload.reject();
    const asset = { id: "asset-1", kind: "image", src: "/media/asset-1.png" };
    assert.deepEqual(
      await afterRejectReload.executeNative("persist_asset", { asset }),
      { assetId: "asset-1" },
    );
    assert.deepEqual(live.assets, [asset], "upstream persistent actions must land immediately");
    assert.equal(afterRejectReload.getState().proposal, null);

    await assert.rejects(
      afterRejectReload.executeNative("race_move", { value: 88 }),
      /project changed while the native tool was running/i,
    );
    assert.equal(live.value, 77, "an in-flight proposal must not overwrite a newer live edit");
    assert.equal(afterRejectReload.getState().proposal, null);

    // Multiple persistent tool actions are allowed in one ChatPanel agent run.
    // Their project snapshots must be written in invocation order: Promise.all
    // alone only waits and lets a slower old snapshot overwrite the final one.
    /** @type {any} */
    let orderedPersisted = null;
    const orderedDependencies = {
      ...dependencies,
      async saveProject(/** @type {string} */ _projectId, /** @type {any} */ doc) {
        if (doc.assets.length === 2) await new Promise((resolve) => setTimeout(resolve, 40));
        orderedPersisted = structuredClone(doc);
      },
    };
    const orderedController = new ProposalController({
      projectId: "project-1",
      getContext: () => context,
      dependencies: orderedDependencies,
    });
    await orderedController.hydrate();
    const persistentRun = orderedController.beginDraft();
    persistentRun.context.commands.addAsset({ id: "asset-2" });
    persistentRun.recordTool("persist_asset", { asset: { id: "asset-2" } });
    persistentRun.context.commands.addAsset({ id: "asset-3" });
    persistentRun.recordTool("persist_asset", { asset: { id: "asset-3" } });
    await persistentRun.finish("persistent assets");
    assert.deepEqual(
      orderedPersisted.assets.map((/** @type {{id: string}} */ item) => item.id),
      ["asset-1", "asset-2", "asset-3"],
      "the final persistent snapshot must be the last project write even when an earlier write is slower",
    );

    // The standalone ChatPanel persists chat on proposal state boundaries. The
    // synthetic apply acknowledgement therefore has to be appended before the
    // controller notifies subscribers that the proposal became null.
    await orderedController.executeNative("move_item", { value: 101 });
    /** @type {string[]} */
    const acknowledgements = [];
    let acknowledgementVisibleAtBoundary = false;
    const unsubscribe = orderedController.subscribe((/** @type {{proposal: unknown, hydrated: boolean}} */ state) => {
      if (!state.proposal && state.hydrated) {
        acknowledgementVisibleAtBoundary = acknowledgements.length > 0;
      }
    });
    const acknowledgedApply = await orderedController.apply(undefined, {
      onApplied(/** @type {{operations: number}} */ result) {
        acknowledgements.push(`applied:${result.operations}`);
      },
    });
    unsubscribe();
    assert.equal(acknowledgedApply.status, "applied");
    assert.deepEqual(acknowledgements, ["applied:1"]);
    assert.equal(
      acknowledgementVisibleAtBoundary,
      true,
      "proposal subscribers must observe the LLM acknowledgement at the null-proposal persistence boundary",
    );
    assert.ok(saves.length >= 3);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
