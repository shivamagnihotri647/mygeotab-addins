import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "./",
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
        outDir: "dist",
        emptyOutDir: false,
        lib: {
            entry: "src/app.jsx",
            formats: ["iife"],
            name: "CameraHealthReportAddin",
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
