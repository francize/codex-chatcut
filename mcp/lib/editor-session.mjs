// @ts-check

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

const STATE_DIRECTORY = ".codex-chatcut";
const PROJECT_FILE = "project.json";
const SELECTION_FILE = "selection.json";

export const TimelineItemSchema = z
  .object({
    id: z.string().trim().min(1),
    trackId: z.string().trim().min(1),
    kind: z.enum(["video", "audio", "image", "text"]),
    name: z.string(),
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const ProjectDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    timeline: z
      .object({
        id: z.string().trim().min(1),
        fps: z.number().int().positive(),
        items: z.array(TimelineItemSchema),
      })
      .strict(),
  })
  .strict();

const RangeSchema = z
  .object({
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.endFrame >= value.startFrame, {
    message: "Selection range endFrame must be greater than or equal to startFrame.",
  });

export const SelectionContextSchema = z
  .object({
    timelineId: z.string().trim().min(1),
    selectedItemIds: z.array(z.string().trim().min(1)),
    playheadFrame: z.number().int().nonnegative(),
    range: RangeSchema.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild === "" || (!pathToChild.startsWith("..") && !isAbsolute(pathToChild));
}

/** @param {unknown} error */
function isMissing(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** @param {string} filePath @param {unknown} value */
async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** @param {string} filePath @param {z.ZodTypeAny} schema */
async function readJson(filePath, schema) {
  const raw = await readFile(filePath, "utf8");
  return schema.parse(JSON.parse(raw));
}

/** @param {string} projectId */
function createProjectDocument(projectId) {
  return ProjectDocumentSchema.parse({
    schemaVersion: 1,
    projectId,
    revision: 0,
    timeline: { id: "main", fps: 30, items: [] },
  });
}

/** @param {z.infer<typeof ProjectDocumentSchema>} document */
function createSelection(document) {
  return SelectionContextSchema.parse({
    timelineId: document.timeline.id,
    selectedItemIds: [],
    playheadFrame: 0,
    range: null,
    revision: document.revision,
  });
}

/**
 * Authoritative in-process owner of project-bound editing state.
 * The Widget and model-facing tools only receive opaque session IDs after open().
 */
export class EditorSessionManager {
  /** @param {{allowedWorkspaceRoot?: string}} [options] */
  constructor(options = {}) {
    this.allowedWorkspaceRoot = options.allowedWorkspaceRoot || null;
    /** @type {Map<string, {sessionId: string, projectRoot: string, stateDir: string, document: z.infer<typeof ProjectDocumentSchema>, selection: z.infer<typeof SelectionContextSchema>}>} */
    this.sessions = new Map();
  }

  /** @param {string} requestedRoot */
  async open(requestedRoot) {
    const projectRoot = await realpath(requestedRoot);
    const projectStat = await stat(projectRoot);
    if (!projectStat.isDirectory()) throw new Error("Project Root must be an existing directory.");

    if (this.allowedWorkspaceRoot) {
      const allowedRoot = await realpath(this.allowedWorkspaceRoot);
      if (!isInside(allowedRoot, projectRoot)) {
        throw new Error("Project Root is outside CODEX_CHATCUT_WORKSPACE_ROOT.");
      }
    }

    const stateDir = join(projectRoot, STATE_DIRECTORY);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const documentPath = join(stateDir, PROJECT_FILE);
    const selectionPath = join(stateDir, SELECTION_FILE);

    /** @type {z.infer<typeof ProjectDocumentSchema>} */
    let document;
    try {
      document = /** @type {z.infer<typeof ProjectDocumentSchema>} */ (
        await readJson(documentPath, ProjectDocumentSchema)
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      document = createProjectDocument(`project_${randomUUID()}`);
      await writeJsonAtomic(documentPath, document);
    }

    /** @type {z.infer<typeof SelectionContextSchema>} */
    let selection;
    try {
      selection = /** @type {z.infer<typeof SelectionContextSchema>} */ (
        await readJson(selectionPath, SelectionContextSchema)
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      selection = createSelection(document);
      await writeJsonAtomic(selectionPath, selection);
    }
    this.assertSelection(document, selection);

    const sessionId = `session_${randomUUID()}`;
    const session = { sessionId, projectRoot, stateDir, document, selection };
    this.sessions.set(sessionId, session);
    return this.snapshot(session);
  }

  /** @param {string} sessionId */
  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown or expired Editor Session.");
    return session;
  }

  /** @param {string} sessionId */
  inspect(sessionId) {
    return this.snapshot(this.get(sessionId));
  }

  /** @param {string} sessionId @param {unknown} input */
  async saveSelection(sessionId, input) {
    const session = this.get(sessionId);
    const selection = SelectionContextSchema.parse(input);
    this.assertSelection(session.document, selection);
    await writeJsonAtomic(join(session.stateDir, SELECTION_FILE), selection);
    session.selection = selection;
    return { ok: true, sessionId, selection };
  }

  /** @param {string} sessionId */
  context(sessionId) {
    const session = this.get(sessionId);
    return {
      sessionId,
      projectId: session.document.projectId,
      document: structuredClone(session.document),
      selection: structuredClone(session.selection),
    };
  }

  /**
   * @param {z.infer<typeof ProjectDocumentSchema>} document
   * @param {z.infer<typeof SelectionContextSchema>} selection
   */
  assertSelection(document, selection) {
    if (selection.timelineId !== document.timeline.id) {
      throw new Error("Selection timelineId does not match the Project Document.");
    }
    if (selection.revision !== document.revision) {
      throw new Error("Selection Revision is stale.");
    }
    if (new Set(selection.selectedItemIds).size !== selection.selectedItemIds.length) {
      throw new Error("Selection contains duplicate Item IDs.");
    }
    const itemIds = new Set(document.timeline.items.map((item) => item.id));
    for (const itemId of selection.selectedItemIds) {
      if (!itemIds.has(itemId)) throw new Error(`Selection references unknown Item ID: ${itemId}`);
    }
  }

  /** @param {ReturnType<EditorSessionManager["get"]>} session */
  snapshot(session) {
    return {
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      document: structuredClone(session.document),
      selection: structuredClone(session.selection),
      workspaceEnforced: Boolean(this.allowedWorkspaceRoot),
    };
  }
}
