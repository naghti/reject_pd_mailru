import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist/extension", { recursive: true });
for (const file of ["manifest.json", "popup.html", "popup.css"])
  copyFileSync("extension/" + file, "dist/extension/" + file);
await build({
  entryPoints: ["extension/popup.ts"],
  outfile: "dist/extension/popup.js",
  bundle: true,
  format: "iife",
  target: "chrome110",
});

await build({
  entryPoints: ["extension/background.js"],
  outfile: "dist/extension/background.js",
  bundle: true,
  format: "iife",
  target: "chrome110",
});
