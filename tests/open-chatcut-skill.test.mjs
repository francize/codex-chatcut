import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("open-chatcut skill drives the sole Codex task into the real editor", async () => {
  const skill = await readFile(
    new URL("../skills/open-chatcut/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /name: open-chatcut/);
  assert.match(skill, /start_chatcut/);
  assert.match(skill, /Codex.+built-in Browser/i);
  assert.match(skill, /list_projects/);
  assert.match(skill, /create_project/);
  assert.match(skill, /target_project/);
  assert.match(skill, /get_editor_url/);
  assert.match(skill, /refresh_chatcut_tools/);
  assert.match(skill, /keep.+editor.+mounted/i);
  assert.match(skill, /never.+ChatPanel/i);
  assert.match(skill, /proposal/i);
  assert.doesNotMatch(skill, /TODO/);
  assert.doesNotMatch(skill, /API key|LLM_API_KEY|ANTHROPIC/i);
});
