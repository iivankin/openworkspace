/**
 * Pull OpenWorkspace template updates into a Deploy-button / fork clone.
 * Preserves Cloudflare-provisioned D1/R2 identifiers in wrangler.jsonc.
 *
 * Deploy-to-Cloudflare copies often share no git ancestry with the template,
 * so the first sync uses --allow-unrelated-histories.
 */

const UPSTREAM = "https://github.com/iivankin/openworkspace.git";
const UPSTREAM_ALIASES = [
  UPSTREAM,
  "git@github.com:iivankin/openworkspace.git",
  "ssh://git@github.com/iivankin/openworkspace.git",
  "https://github.com/iivankin/openworkspace.git/",
];
const WRANGLER = "wrangler.jsonc";

function run(cmd: string[], options: { allowFail?: boolean } = {}) {
  const result = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0 && !options.allowFail) {
    throw new Error(
      `${cmd.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`,
    );
  }
  return { exitCode: result.exitCode ?? 1, stdout, stderr };
}

function normalizeRemoteUrl(url: string) {
  return url
    .trim()
    .replace(/\.git\/?$/, ".git")
    .replace(/\/$/, "");
}

function isUpstreamUrl(url: string) {
  const normalized = normalizeRemoteUrl(url);
  return UPSTREAM_ALIASES.some(
    (alias) => normalizeRemoteUrl(alias) === normalized,
  );
}

function readBindings(text: string) {
  return {
    databaseId: text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1],
    databaseName: text.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1],
    bucketName: text.match(/"bucket_name"\s*:\s*"([^"]+)"/)?.[1],
  };
}

function restoreBindings(
  text: string,
  local: ReturnType<typeof readBindings>,
) {
  let next = text;

  if (local.databaseName) {
    next = next.replace(
      /"database_name"\s*:\s*"[^"]*"/,
      `"database_name": "${local.databaseName}"`,
    );
  }

  if (local.databaseId) {
    if (/"database_id"\s*:\s*"[^"]*"/.test(next)) {
      next = next.replace(
        /"database_id"\s*:\s*"[^"]*"/,
        `"database_id": "${local.databaseId}"`,
      );
    } else {
      next = next.replace(
        /("database_name"\s*:\s*"[^"]*")/,
        `$1,\n      "database_id": "${local.databaseId}"`,
      );
    }
  }

  if (local.bucketName) {
    next = next.replace(
      /"bucket_name"\s*:\s*"[^"]*"/,
      `"bucket_name": "${local.bucketName}"`,
    );
  }

  return next;
}

const status = run(["git", "status", "--porcelain"]);
if (status.stdout) {
  console.error("Working tree is dirty. Commit or stash first, then retry.");
  process.exit(1);
}

const remotes = run(["git", "remote", "-v"]).stdout.split("\n").filter(Boolean);
const originFetch = remotes.find((line) => line.startsWith("origin\t") && line.endsWith("(fetch)"));
const originUrl = originFetch?.split(/\s+/)[1];

if (originUrl && isUpstreamUrl(originUrl)) {
  console.error(
    "This clone's origin is already the OpenWorkspace template. Nothing to sync.",
  );
  process.exit(1);
}

const hasUpstream = remotes.some((line) => line.startsWith("upstream\t"));
if (!hasUpstream) {
  run(["git", "remote", "add", "upstream", UPSTREAM]);
  console.log(`Added upstream → ${UPSTREAM}`);
} else {
  const upstreamFetch = remotes.find(
    (line) => line.startsWith("upstream\t") && line.endsWith("(fetch)"),
  );
  const upstreamUrl = upstreamFetch?.split(/\s+/)[1];
  if (upstreamUrl && !isUpstreamUrl(upstreamUrl)) {
    console.error(
      `Remote "upstream" points to ${upstreamUrl}, expected ${UPSTREAM}.`,
    );
    process.exit(1);
  }
}

const wranglerBefore = await Bun.file(WRANGLER).text();
const localBindings = readBindings(wranglerBefore);

run(["git", "fetch", "upstream"]);

const branchCheck = run(["git", "rev-parse", "--verify", "upstream/main"], {
  allowFail: true,
});
const upstreamRef = branchCheck.exitCode === 0 ? "upstream/main" : "upstream/master";

const head = run(["git", "rev-parse", "HEAD"]).stdout;
const upstreamTip = run(["git", "rev-parse", upstreamRef]).stdout;
if (head === upstreamTip) {
  console.log("Already up to date with upstream.");
  process.exit(0);
}

const mergeBase = run(["git", "merge-base", head, upstreamTip], {
  allowFail: true,
});
const unrelated = mergeBase.exitCode !== 0;

if (!unrelated) {
  const alreadyContains = run(
    ["git", "merge-base", "--is-ancestor", upstreamTip, head],
    { allowFail: true },
  );
  if (alreadyContains.exitCode === 0) {
    console.log("Local branch already contains upstream. Nothing to merge.");
    process.exit(0);
  }
}

const mergeArgs = ["git", "merge", "--no-edit"];
if (unrelated) {
  console.log(
    `Deploy-button clone detected (no shared history). Merging ${upstreamRef} with --allow-unrelated-histories…`,
  );
  mergeArgs.push("--allow-unrelated-histories", "-X", "theirs", upstreamRef);
} else {
  console.log(`Merging ${upstreamRef}…`);
  mergeArgs.push(upstreamRef);
}

const merge = run(mergeArgs, { allowFail: true });
if (merge.exitCode !== 0) {
  const detail = merge.stderr || merge.stdout;
  console.error(detail);
  if (detail.includes("unrelated histories")) {
    console.error(`
Git refused unrelated histories. Retry after updating this script, or run:

  git merge --allow-unrelated-histories -X theirs --no-edit ${upstreamRef}
`);
  } else {
    console.error(`
Merge conflict. Resolve files, then:
  - In ${WRANGLER}, keep your local database_id / database_name / bucket_name
  - git add -A && git commit
  - git push
`);
  }
  process.exit(merge.exitCode);
}

const wranglerAfter = await Bun.file(WRANGLER).text();
const restored = restoreBindings(wranglerAfter, localBindings);
if (restored !== wranglerAfter) {
  await Bun.write(WRANGLER, restored);
  run(["git", "add", WRANGLER]);
  run([
    "git",
    "commit",
    "-m",
    "Preserve local Cloudflare resource IDs after upstream sync",
  ]);
  console.log(`Restored local Cloudflare resource IDs in ${WRANGLER}.`);
}

console.log(`
Synced with ${upstreamRef}.

Next:
  bun install
  git push

Workers Builds will redeploy on push. Run migrations if the release notes mention schema changes:
  bun run db:migrate:remote
`);
