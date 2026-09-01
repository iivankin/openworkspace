import { spawnSync } from "node:child_process";

const result = spawnSync(
  "bun",
  ["x", "wrangler", "d1", "migrations", "list", "DB", "--local"],
  {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

// Wrangler has no JSON output for this command, so migration filenames are
// extracted from its stable table output instead of depending on box drawing.
const pending = result.stdout.match(/\b\d{4}_[^\s│]+\.sql\b/gu) ?? [];
if (pending.length > 0) {
  console.error(
    `Local database migrations are pending: ${pending.join(", ")}\n`
      + "Run `bun run db:migrate:local`, then start the dev server again.",
  );
  process.exit(1);
}
