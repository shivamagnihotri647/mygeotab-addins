import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: "dist",
        rollupOptions: {
            input: "src/app.jsx",
            output: {
                // Single JS bundle for MyGeotab to load
                entryFileNames: "scripts/main.js",
                assetFileNames: "styles/[name][extname]",
                format: "iife",
            },
        },
    },
});
