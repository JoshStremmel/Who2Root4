import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const g3Root = resolve(__dirname, "../g3-toolkit/packages");

export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: [
      // CSS and the controls→interaction naming mismatch must be before the @g3t/react catch-all
      { find: "@g3t/react/style.css", replacement: resolve(g3Root, "react/src/theme/g3t-base.css") },
      { find: "@g3t/react/controls",  replacement: resolve(g3Root, "react/src/interaction/index.ts") },
      // Catch-alls: @g3t/core, @g3t/react, @g3t/charts → package source roots.
      // Vite alias prefix-matches, so @g3t/core/pipeline → core/src/pipeline → core/src/pipeline/index.ts, etc.
      { find: "@g3t/core",   replacement: resolve(g3Root, "core/src") },
      { find: "@g3t/react",  replacement: resolve(g3Root, "react/src") },
      { find: "@g3t/charts", replacement: resolve(g3Root, "charts/src") },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
