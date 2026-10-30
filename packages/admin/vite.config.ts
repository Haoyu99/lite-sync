import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
    base: "/admin/",
    plugins: [svelte()],
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
    server: { proxy: { "/admin/api": "http://localhost:28470", "/v1": "http://localhost:28470" } },
});
