import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "./",
    build: {
        outDir: "dist",
        // Build as a library in IIFE format so geotab.addin is accessible
        // on the global scope (MyGeotab injects `geotab` before scripts run)
        lib: {
            entry: "src/app.jsx",
            formats: ["iife"],
            name: "BulkExceptionDismissAddin",
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
