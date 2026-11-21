import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";

const notices = await readFile(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");

await build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    outfile: "dist/main.js",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    minify: process.argv.includes("--minify"),
    sourcemap: false,
    logLevel: "info",
    banner: { js: `/*!\n${notices}\n*/` },
});

await copyFile("manifest.json", "dist/manifest.json");
await copyFile("styles.css", "dist/styles.css");
