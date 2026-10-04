import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { version as pdfjsVersion } from "pdfjs-dist/package.json";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...viteStaticCopy({
      // PDF.js requests these resources by filename (CJK fonts, JPEG 2000, etc.).
      targets: ["cmaps", "standard_fonts", "wasm", "iccs"].map((directory) => ({
        src: `node_modules/pdfjs-dist/${directory}/*`,
        dest: `pdfjs/${pdfjsVersion}/${directory}`,
        rename: { stripBase: true },
      })),
    }).map((plugin) => ({ ...plugin, applyToEnvironment: (environment: { name: string }) => environment.name === "client" })),
    cloudflare({
      persistState: process.env.E2E_PERSIST_PATH
        ? { path: process.env.E2E_PERSIST_PATH }
        : true,
    }),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@worker": new URL("./worker", import.meta.url).pathname,
    },
  },
});
