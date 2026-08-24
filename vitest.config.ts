import path from "node:path";
import { generateVapidKeys } from "@mmmike/web-push/vapid";
import { exportJWK, generateKeyPair } from "jose";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const { privateKey } = await generateKeyPair("RS256", {
        extractable: true,
      });
      const vapid = await generateVapidKeys();
      return {
        // Tests intentionally omit the always-remote Workers AI binding. The
        // classifier itself receives an injected runner in focused unit tests.
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(path.resolve("drizzle")),
            ALLOW_MOCK_AUTH: "true",
            OIDC_ISSUER: "http://example.test",
            OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(
              await exportJWK(privateKey),
            ),
            VAPID_PUBLIC_KEY: vapid.publicKey,
            VAPID_PRIVATE_KEY: vapid.privateKey,
            VAPID_SUBJECT: "mailto:test@example.test",
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // A single Workers pool is faster and avoids workerd startup contention on
    // machines with many logical cores.
    maxWorkers: 1,
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
