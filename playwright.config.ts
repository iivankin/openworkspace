import { defineConfig, devices } from "playwright/test";

const e2ePersistPath = ".wrangler/e2e-state-v2";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: `bun run db:setup:e2e && E2E_PERSIST_PATH=${e2ePersistPath} bun run dev -- --host 127.0.0.1`,
    url: "http://127.0.0.1:5173/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
