import { defineConfig, devices } from "playwright/test";

const e2ePersistPath = `/tmp/openworkspace-e2e-${process.pid}`;
const e2ePort = Number(process.env.E2E_PORT ?? 5173);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: e2eBaseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: `E2E_PERSIST_PATH=${e2ePersistPath} bun run db:setup:e2e && E2E_PERSIST_PATH=${e2ePersistPath} bun run dev -- --host 127.0.0.1 --port ${e2ePort}`,
    url: `${e2eBaseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
