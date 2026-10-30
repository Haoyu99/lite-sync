import { build } from "esbuild";

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
});
