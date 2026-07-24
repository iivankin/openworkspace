import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
