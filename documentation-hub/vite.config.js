import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "./",
    // Required: without this, `process.env` crashes the browser and the add-in never registers.
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
        // Fallback only; the add-in normally finds its content next to its own script. Set DH_CONTENT_BASE for another host.
        __DH_DEFAULT_CONTENT_BASE__: JSON.stringify(
            process.env.DH_CONTENT_BASE || "https://shivamagnihotri647.github.io/mygeotab-addins/documentation-hub/content/"
        ),
    },
    build: {
        outDir: "dist",
        lib: {
            entry: "src/app.jsx",
            formats: ["iife"],
            name: "DocumentationHubAddin",
            fileName: () => "scripts/main.js",
        },
        rollupOptions: {
            output: {
                assetFileNames: "styles/[name][extname]",
            },
        },
        cssCodeSplit: false,
    },
});
