// @ts-check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "src/widget/editor.html");
const outputPath = resolve(root, "dist/widget/editor.html");
const html = await readFile(sourcePath, "utf8");

/** @type {Array<[RegExp, string]>} */
const forbidden = [
  [/<script\b[^>]+src=/i, "external script"],
  [/<link\b[^>]+href=/i, "external stylesheet"],
  [/ChatPanel|messages\.stream|Anthropic|api[-_ ]?key/i, "second-agent surface"],
];

for (const [pattern, label] of forbidden) {
  if (pattern.test(html)) throw new Error(`Widget build rejected ${label}.`);
}

for (const landmark of ["media-library", "preview", "inspector", "timeline"]) {
  if (!html.includes(`data-chatcut-region="${landmark}"`)) {
    throw new Error(`Widget build is missing the ${landmark} landmark.`);
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(`Built ${outputPath}`);
