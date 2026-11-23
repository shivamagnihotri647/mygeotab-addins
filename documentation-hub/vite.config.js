import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "./",
    // Required: without this, `process.env` crashes the browser and the add-in never registers.
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
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
