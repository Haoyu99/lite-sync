import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    globalIgnores([
        "**/node_modules/**", "**/dist/**", ".npm-cache/**", ".artifacts/**",
        "packages/server/**", "packages/admin/**", "**/test/**", "scripts/**",
        "**/esbuild.config.mjs", "eslint.config.mjs",
    ]),
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: { parserOptions: { projectService: true } },
    },
]);
