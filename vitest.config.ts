import path from "node:path";
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
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(path.resolve("drizzle")),
            ALLOW_MOCK_AUTH: "true",
            OIDC_ISSUER: "http://example.test",
            OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(
              await exportJWK(privateKey),
            ),
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
