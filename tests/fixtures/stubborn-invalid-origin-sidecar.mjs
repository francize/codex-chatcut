import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dataRoot = process.env.OPENCHATCUT_DATA_ROOT;
if (!dataRoot) throw new Error("stubborn invalid-origin fixture requires OPENCHATCUT_DATA_ROOT");

// Publish only after graceful-signal refusal is active. The invalid readiness
// record then drives the runtime's failure cleanup without a scheduler-sensitive
// sub-second timeout.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
await writeFile(resolve(dataRoot, "stubborn-sidecar.pid"), String(process.pid));
process.send?.({ type: "openchatcut-ready", origin: "http://0.0.0.0:5199" });
setInterval(() => {}, 60_000);
