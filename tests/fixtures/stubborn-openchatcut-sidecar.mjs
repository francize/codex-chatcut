import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = process.env.OPENCHATCUT_DATA_ROOT;
if (!dataRoot) throw new Error("stubborn fixture requires OPENCHATCUT_DATA_ROOT");

// Deliberately model a wedged sidecar: it never reports ready and refuses the
// graceful signal. Install the handlers before publishing the PID so the file
// is also a deterministic "the stubborn behavior is active" readiness marker.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
await writeFile(resolve(dataRoot, "stubborn-sidecar.pid"), String(process.pid));
setInterval(() => {}, 60_000);
