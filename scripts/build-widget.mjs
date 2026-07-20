// @ts-check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "src/widget/editor.html");
const outputPath = resolve(root, "dist/widget/editor.html");
let html = await readFile(sourcePath, "utf8");

const bundle = await build({
  entryPoints: [resolve(root, "src/widget/app.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  sourcemap: false,
  minify: true,
});
const javascript = bundle.outputFiles[0]?.text;
if (!javascript) throw new Error("Widget build emitted no JavaScript.");
html = html.replace(
  "/* __CHATCUT_WIDGET_JS__ */",
  javascript.replaceAll("</script", "<\\/script"),
);

/** @type {Array<[RegExp, string]>} */
const forbidden = [
  [/<script\b[^>]+src=/i, "external script"],
  [/<link\b[^>]+href=/i, "external stylesheet"],
];

for (const [pattern, label] of forbidden) {
  if (pattern.test(html)) throw new Error(`Widget build rejected ${label}.`);
}

const shellMarkup = html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
if (/ChatPanel|chat history|Anthropic|api[-_ ]?key/i.test(shellMarkup)) {
  throw new Error("Widget build rejected a second-agent UI surface.");
}

for (const landmark of ["media-library", "preview", "inspector", "timeline"]) {
  if (!html.includes(`data-chatcut-region="${landmark}"`)) {
    throw new Error(`Widget build is missing the ${landmark} landmark.`);
  }
}

html = html.replace(/[ \t]+$/gm, "");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(`Built ${outputPath}`);
