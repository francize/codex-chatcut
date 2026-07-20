import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";

type TimelineItem = {
  id: string;
  trackId: string;
  kind: "video" | "audio" | "image" | "text";
  name: string;
  startFrame: number;
  durationInFrames: number;
  props: Record<string, unknown>;
};

type ProjectDocument = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  timeline: { id: string; fps: number; items: TimelineItem[] };
};

type SelectionContext = {
  timelineId: string;
  selectedItemIds: string[];
  playheadFrame: number;
  range: { startFrame: number; endFrame: number } | null;
  revision: number;
};

type SessionState = {
  sessionId: string;
  document: ProjectDocument;
  selection: SelectionContext;
};

type WidgetPayload = {
  widget?: string;
  displayMode?: "inline" | "fullscreen";
  sessionId?: string;
};

declare global {
  interface Window {
    openai?: { toolOutput?: unknown };
    chatcutApp?: App;
  }
}

const app = new App(
  { name: "codex-chatcut-widget", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: true, strict: true },
);
window.chatcutApp = app;

const statusElement = document.querySelector<HTMLElement>("#host-status");
const revisionElement = document.querySelector<HTMLElement>("#revision-badge");
const timecodeElement = document.querySelector<HTMLElement>("#timecode");
const tracksElement = document.querySelector<HTMLElement>("#tracks");
const inspectorElement = document.querySelector<HTMLElement>("#inspector-content");

let sessionId: string | null = null;
let state: SessionState | null = null;
let connected = false;

function structuredContent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.structuredContent;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  return record;
}

function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(1, fps);
  const totalSeconds = Math.floor(frame / safeFps);
  const frames = frame % safeFps;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames].map((value) => String(value).padStart(2, "0")).join(":");
}

function renderSession(next: SessionState) {
  state = next;
  if (statusElement) statusElement.textContent = `Project ${next.document.projectId}`;
  if (revisionElement) revisionElement.textContent = `Revision ${next.document.revision}`;
  if (timecodeElement) {
    timecodeElement.textContent = formatTimecode(
      next.selection.playheadFrame,
      next.document.timeline.fps,
    );
  }
  if (!tracksElement) return;

  const items = next.document.timeline.items;
  const trackIds = Array.from(new Set(["V1", "A1", ...items.map((item) => item.trackId)]));
  const endFrame = Math.max(
    next.document.timeline.fps * 10,
    ...items.map((item) => item.startFrame + item.durationInFrames),
  );

  tracksElement.replaceChildren(
    ...trackIds.map((trackId) => {
      const row = document.createElement("div");
      row.className = "track";
      const label = document.createElement("span");
      label.className = "track-label";
      label.textContent = trackId;
      const lane = document.createElement("div");
      lane.className = "track-lane";

      const trackItems = items.filter((item) => item.trackId === trackId);
      if (trackItems.length) lane.classList.add("has-items");
      for (const item of trackItems) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "timeline-item";
        button.textContent = item.name;
        button.style.left = `${(item.startFrame / endFrame) * 100}%`;
        button.style.width = `${Math.max(4, (item.durationInFrames / endFrame) * 100)}%`;
        button.setAttribute("aria-pressed", String(next.selection.selectedItemIds.includes(item.id)));
        button.addEventListener("click", () => void toggleItem(item.id));
        lane.append(button);
      }
      row.append(label, lane);
      return row;
    }),
  );

  if (inspectorElement) {
    const selected = items.filter((item) => next.selection.selectedItemIds.includes(item.id));
    inspectorElement.textContent = selected.length
      ? selected.map((item) => `${item.name} · ${item.startFrame}–${item.startFrame + item.durationInFrames}`).join("\n")
      : "Select a timeline item to inspect its timing and properties.";
  }
}

async function toggleItem(itemId: string) {
  if (!state || !sessionId) return;
  const selected = new Set(state.selection.selectedItemIds);
  if (selected.has(itemId)) selected.delete(itemId);
  else selected.add(itemId);
  const selection = { ...state.selection, selectedItemIds: Array.from(selected) };
  const result = await app.callServerTool({
    name: "save_chatcut_selection",
    arguments: { sessionId, selection },
  });
  if (result.isError) throw new Error("Could not save ChatCut selection.");
  renderSession({ ...state, selection });
}

async function loadSession(nextSessionId: string) {
  if (!connected) return;
  sessionId = nextSessionId;
  const result = await app.callServerTool({
    name: "get_chatcut_session",
    arguments: { sessionId },
  });
  if (result.isError || !result.structuredContent) {
    throw new Error("Could not load the ChatCut Editor Session.");
  }
  renderSession(result.structuredContent as SessionState);
}

function handlePayload(value: unknown) {
  const payload = structuredContent(value) as WidgetPayload | null;
  if (!payload) return;
  if (payload.displayMode) document.documentElement.dataset.displayMode = payload.displayMode;
  if (payload.sessionId) void loadSession(payload.sessionId);
}

app.addEventListener("toolresult", handlePayload);
app.addEventListener("hostcontextchanged", (context) => {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
});

async function connectToHost() {
  await app.connect();
  connected = true;
  const hostContext = app.getHostContext();
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  handlePayload(window.openai?.toolOutput);
}

void connectToHost().catch((error: unknown) => {
  if (statusElement) {
    statusElement.textContent = error instanceof Error ? error.message : "Host bridge unavailable";
  }
});
