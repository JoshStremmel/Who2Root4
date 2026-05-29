import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const g3Root = resolve(__dirname, "../g3-toolkit/packages");

export default defineConfig({
  plugins: [react()],
  base: "/graph/",
  resolve: {
    alias: [
      // ROOT4 — shared NFL calculation engine, single source of truth
      { find: "@root4", replacement: resolve(__dirname, "../ROOT4/root4.js") },
      // CSS and the controls→interaction naming mismatch must be before the @g3t/react catch-all
      { find: "@g3t/react/style.css", replacement: resolve(g3Root, "react/src/theme/g3t-base.css") },
      { find: "@g3t/react/controls",  replacement: resolve(g3Root, "react/src/interaction/index.ts") },
      // Catch-alls: @g3t/core, @g3t/react, @g3t/charts → package source roots.
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
    outDir: "../dist/graph",
  },
});
