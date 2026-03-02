import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "./",
    build: {
        outDir: "dist",
        rollupOptions: {
            input: "index.html",
            output: {
                entryFileNames: "scripts/main.js",
                assetFileNames: "styles/[name][extname]",
            },
        },
    },
});
