import { and, desc, eq, isNull, like, lt, or } from "drizzle-orm";
import { z } from "zod";

import { workspaceConfig } from "../config";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { backupRuns } from "../db/schema";
import { workspaceModules } from "../modules";
import type { BackupSnapshot } from "../modules";
import { coreBackup } from "./core-data";

/**
 * Scheduled backups to BACKUP_STORAGE (`OpenWorkspace({ backups })`). Each
 * day the hourly cron starts one snapshot and writes it a batch at a time:
 *
 * - `backups/<id>/core.json`: people, teams, addresses, SSO apps, webhooks
 *   and branding, never secrets (core-data.ts).
 * - `backups/<id>/<module>/<folder>/<part>.jsonl`: each module's lines.
 * - `backups/objects/<sha256>.<extension>`: what lines name, stored once.
 * - `backups/<id>/complete.json`: written last; a snapshot without it is
 *   incomplete (still running, or failed) and isn't restored.
 *
 * `bunx @open-workspace/create import backup <folder>` restores one.
 */

export const BACKUP_PREFIX = "backups";

/** A tick stops starting batches after this long; the cron gives it 15 minutes. */
const CRON_BUDGET_MS = 8 * 60 * 1000;

/**
 * Batches a tick runs at most: each module keeps a batch to about 300
 * subrequests (mail: 100 new messages), so 25 stay well under the
 * 10,000 an invocation may make.
 */
const MAX_BATCHES = 25;
const LEASE_MS = 15 * 60 * 1000;
const MAX_RECORDED_ERRORS = 20;
const SWEEP_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A run still running this long after it started has failed: it stops,
 * its incomplete snapshot is deleted like an expired one, and the next
 * day's snapshot can start. A day's snapshot normally takes hours.
 */
const MAX_RUN_MS = 36 * 60 * 60 * 1000;

/** Snapshot files the sweep reads a step, about one subrequest each. */
const SWEEP_FILES_PER_STEP = 200;

/** The sweep's hash shards, one a step: the first hex digit. */
const SWEEP_SHARDS = "0123456789abcdef";

type BackupRun = typeof backupRuns.$inferSelect;

/** A snapshot's id from when it started, e.g. 2026-03-10T041700.000Z. */
export function backupId(now: Date) {
  const iso = now.toISOString();

  return `${iso.slice(0, 10)}T${iso.slice(11, 23).replaceAll(":", "")}Z`;
}

const DAY_MS = 86_400_000;

/**
 * The snapshots to keep: the newest of each day in the `keepDays` days up
 * to the newest snapshot, and of each ISO week in the `keepWeeks` weeks up
 * to it.
 */
export function retainedBackupIds(
  ids: string[],
  retention: { keepDays: number; keepWeeks: number }
) {
  const keep = new Set<string>();
  const seen = new Set<string>();
  const day = (id: string) => Date.parse(`${id.slice(0, 10)}T00:00:00Z`);

  const monday = (time: number) =>
    time - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS;

  const newestFirst = ids.toSorted().toReversed();
  const [newest] = newestFirst;

  if (!newest) return keep;

  for (const id of newestFirst) {
    const days = (day(newest) - day(id)) / DAY_MS;
    const weeks = (monday(day(newest)) - monday(day(id))) / (7 * DAY_MS);

    if (days < retention.keepDays && !seen.has(`d${day(id)}`)) keep.add(id);

    if (weeks < retention.keepWeeks && !seen.has(`w${monday(day(id))}`)) {
      keep.add(id);
    }

    seen.add(`d${day(id)}`);
    seen.add(`w${monday(day(id))}`);
  }

  return keep;
}

export function backupObjectKey(name: string) {
  return `${BACKUP_PREFIX}/objects/${name}`;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** The installed modules that back up, in install order. */
function backupModules() {
  return workspaceModules().filter((module) => module.backup);
}

/** The module after `name` that backs up, or null after the last. */
function nextModule(name: string | null) {
  const names = backupModules().map((module) => module.name);

  return (name === null ? names[0] : names[names.indexOf(name) + 1]) ?? null;
}

/** Starts a snapshot, unless one is running or, with `daily`, one started today. */
export async function startBackupRun(
  env: Env,
  now = new Date(),
  { daily = false } = {}
) {
  const bucket = env.BACKUP_STORAGE;

  if (!bucket) return null;
  const db = createDb(env.DB);
  const id = backupId(now);

  const [running] = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(
      daily
        ? or(
            eq(backupRuns.status, "running"),
            like(backupRuns.id, `${id.slice(0, 10)}%`)
          )
        : eq(backupRuns.status, "running")
    )
    .limit(1);

  if (running) return null;

  await bucket.put(
    `${BACKUP_PREFIX}/${id}/core.json`,
    JSON.stringify(await coreBackup(env, db), null, 2),
    { httpMetadata: { contentType: "application/json" } }
  );

  const [started] = await db
    .insert(backupRuns)
    .values({ id, status: "running", module: nextModule(null), startedAt: now })
    .onConflictDoNothing()
    .returning({ id: backupRuns.id });

  return started?.id ?? null;
}

/** One batch of the current module's part. */
async function moduleStep(
  env: Env,
  bucket: R2Bucket,
  db: Database,
  run: BackupRun,
  name: string
) {
  const module = backupModules().find((candidate) => candidate.name === name);
  const files = new Map<string, string>();
  const errors: string[] = [];
  let items = 0;
  let newObjects = 0;
  let newBytes = 0;

  const snapshot: BackupSnapshot = {
    id: run.id,
    cursor: run.cursor,
    async putObject(bytes, type) {
      const sha256 = await sha256Hex(bytes);
      const key = backupObjectKey(`${sha256}.${type.extension}`);

      if (!(await bucket.head(key))) {
        await bucket.put(key, bytes, {
          httpMetadata: { contentType: type.contentType },
          sha256,
        });
        newObjects += 1;
        newBytes += bytes.byteLength;
      }

      return sha256;
    },
    writeLines(folder, lines) {
      if (!/^[^/\\]+(?:\/[^/\\]+)*$/u.test(folder) || folder.includes("..")) {
        throw new Error(`Backup folder ${folder} is not a relative path`);
      }

      // A folder with nothing in it gets no file: the sweep reads them all.
      if (!lines.length) return;
      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      files.set(folder, (files.get(folder) ?? "") + text);
      items += lines.length;
    },
    error: (message) => errors.push(message),
  };

  // A module no longer installed has nothing more to write.
  const cursor = module?.backup
    ? await module.backup.export(env, snapshot)
    : null;

  const part = String(run.part).padStart(6, "0");

  await Promise.all(
    [...files].map(([folder, text]) =>
      bucket.put(
        `${BACKUP_PREFIX}/${run.id}/${name}/${folder}/${part}.jsonl`,
        text,
        {
          httpMetadata: { contentType: "application/x-ndjson" },
        }
      )
    )
  );

  const [updated] = await db
    .update(backupRuns)
    .set({
      module: cursor === null ? nextModule(name) : name,
      cursor,
      part: run.part + 1,
      itemCount: run.itemCount + items,
      newObjectCount: run.newObjectCount + newObjects,
      newObjectBytes: run.newObjectBytes + newBytes,
      errors: [...run.errors, ...errors].slice(-MAX_RECORDED_ERRORS),
    })
    .where(eq(backupRuns.id, run.id))
    .returning();

  return updated ?? run;
}

/** Every key under `prefix`, a page of R2's listing at a time. */
async function listKeys(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- R2 lists one page at a time
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return keys;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]) {
  const deletes = [];

  // R2 deletes at most 1,000 keys a call.
  for (let index = 0; index < keys.length; index += 1000) {
    deletes.push(bucket.delete(keys.slice(index, index + 1000)));
  }

  await Promise.all(deletes);
}

const sweepCursorSchema = z.discriminatedUnion("stage", [
  /** Reading kept snapshots' files after `after`, into `backups/sweep/<run>/<seq>.txt`. */
  z.object({
    stage: z.literal("read"),
    after: z.string().nullable(),
    seq: z.number(),
  }),
  /** Deleting unnamed objects whose hash starts with SWEEP_SHARDS[shard]. */
  z.object({ stage: z.literal("delete"), shard: z.number() }),
  z.object({ stage: z.literal("done") }),
]);

type SweepCursor = z.infer<typeof sweepCursorSchema>;

const sweepPrefix = (runId: string) => `${BACKUP_PREFIX}/sweep/${runId}/`;

/**
 * Up to `limit` snapshot files (`.jsonl`) of the `kept` snapshots after the
 * key `after`, in key order, and whether there are more.
 */
async function nextSnapshotFiles(
  bucket: R2Bucket,
  kept: string[],
  after: string | null,
  limit: number
) {
  const afterId = after?.split("/")[1] ?? null;
  const keys: string[] = [];

  for (const id of kept.toSorted()) {
    if (afterId && id < afterId) continue;
    let cursor: string | undefined;

    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- R2 lists one page at a time
      const page = await bucket.list({
        prefix: `${BACKUP_PREFIX}/${id}/`,
        cursor,
        startAfter:
          !cursor && id === afterId ? (after ?? undefined) : undefined,
      });

      for (const object of page.objects) {
        if (!object.key.endsWith(".jsonl")) continue;
        keys.push(object.key);

        if (keys.length === limit) return { keys, more: true };
      }

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  return { keys, more: false };
}

/**
 * One step of the weekly sweep, which deletes the objects no kept snapshot
 * names. It runs in steps, so it fits an invocation whatever the size:
 * first it reads the kept snapshots' files a few hundred at a time and
 * writes the object names they hold to `backups/sweep/<run>/`, then it
 * deletes unnamed objects one hash shard at a time. Nothing else writes
 * meanwhile (only one run runs, and this is its last part), so no object
 * a line names is deleted.
 */
async function sweepStep(
  bucket: R2Bucket,
  run: BackupRun,
  kept: string[],
  cursor: SweepCursor
): Promise<SweepCursor> {
  if (cursor.stage === "read") {
    const { keys, more } = await nextSnapshotFiles(
      bucket,
      kept,
      cursor.after,
      SWEEP_FILES_PER_STEP
    );

    const named = new Set<string>();

    await Promise.all(
      keys.map(async (key) => {
        const text = (await (await bucket.get(key))?.text()) ?? "";

        for (const match of text.matchAll(/"object":"([^"]+)"/gu)) {
          if (match[1]) named.add(match[1]);
        }
      })
    );

    if (named.size) {
      await bucket.put(
        `${sweepPrefix(run.id)}${String(cursor.seq).padStart(6, "0")}.txt`,
        [...named].join("\n")
      );
    }

    return more
      ? { stage: "read", after: keys.at(-1) ?? null, seq: cursor.seq + 1 }
      : { stage: "delete", shard: 0 };
  }

  if (cursor.stage === "delete") {
    const shard = SWEEP_SHARDS[cursor.shard] ?? "";
    const lists = await listKeys(bucket, sweepPrefix(run.id));
    const named = new Set<string>();

    // ponytail: a shard's names are held in memory (~80 B each), so about
    // a million objects a shard fit a Worker; past that, shard by two digits.
    for (const key of lists) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one list in memory at a time
      const text = (await (await bucket.get(key))?.text()) ?? "";

      for (const name of text.split("\n")) {
        if (name.startsWith(shard)) named.add(backupObjectKey(name));
      }
    }

    const objects = await listKeys(bucket, backupObjectKey(shard));

    await deleteKeys(
      bucket,
      objects.filter((key) => !named.has(key))
    );

    if (cursor.shard + 1 < SWEEP_SHARDS.length) {
      return { stage: "delete", shard: cursor.shard + 1 };
    }

    await deleteKeys(bucket, lists);
  }

  return { stage: "done" };
}

/**
 * After every module, a step at a time: deletes one snapshot outside
 * retention (and any failed one), then once a week sweeps objects, then
 * marks the snapshot complete in the bucket and completes the run.
 */
async function finishStep(
  bucket: R2Bucket,
  db: Database,
  run: BackupRun,
  retention: { keepDays: number; keepWeeks: number }
) {
  const runs = await db
    .select({
      id: backupRuns.id,
      status: backupRuns.status,
      swept: backupRuns.swept,
      startedAt: backupRuns.startedAt,
    })
    .from(backupRuns);

  // Completed snapshots, and this one about to be: a failed one is kept by none.
  const keep = retainedBackupIds(
    runs.flatMap((row) =>
      row.status === "completed" || row.id === run.id ? [row.id] : []
    ),
    retention
  );

  const [expired] = runs
    .filter((row) => !keep.has(row.id) && row.status !== "running")
    .map((row) => row.id)
    .toSorted();

  if (expired) {
    await deleteKeys(
      bucket,
      await listKeys(bucket, `${BACKUP_PREFIX}/${expired}/`)
    );
    await deleteKeys(bucket, await listKeys(bucket, sweepPrefix(expired)));
    await db.delete(backupRuns).where(eq(backupRuns.id, expired));

    return run;
  }

  const sweepDue = !runs.some(
    (row) =>
      row.id !== run.id &&
      row.swept &&
      run.startedAt.getTime() - row.startedAt.getTime() < SWEEP_EVERY_MS
  );

  const sweep: SweepCursor = run.cursor
    ? sweepCursorSchema.parse(JSON.parse(run.cursor))
    : { stage: "read", after: null, seq: 0 };

  if (sweepDue && sweep.stage !== "done") {
    const next = await sweepStep(bucket, run, [...keep], sweep);

    const [updated] = await db
      .update(backupRuns)
      .set({ cursor: JSON.stringify(next) })
      .where(eq(backupRuns.id, run.id))
      .returning();

    return updated ?? run;
  }

  const finishedAt = new Date();

  // Last: only a snapshot with this file is whole, for `import backup` and
  // for a copy made with rclone while a run was going.
  await bucket.put(
    `${BACKUP_PREFIX}/${run.id}/complete.json`,
    JSON.stringify(
      {
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        items: run.itemCount,
        errors: run.errors.length,
      },
      null,
      2
    ),
    { httpMetadata: { contentType: "application/json" } }
  );

  const [completed] = await db
    .update(backupRuns)
    .set({
      status: "completed",
      cursor: null,
      finishedAt,
      swept: sweepDue,
    })
    .where(eq(backupRuns.id, run.id))
    .returning();

  return completed ?? run;
}

/**
 * Fails runs still running `MAX_RUN_MS` after they started: a step that
 * fails every time (a bug, a limit) would otherwise hold every later
 * snapshot back. Their incomplete snapshots go with the next expiry.
 */
async function failStaleRuns(db: Database, now: Date) {
  await db
    .update(backupRuns)
    .set({ status: "failed", leaseUntil: null, finishedAt: now })
    .where(
      and(
        eq(backupRuns.status, "running"),
        lt(backupRuns.startedAt, new Date(now.getTime() - MAX_RUN_MS))
      )
    );
}

/**
 * The hourly cron (and Run now): starts today's snapshot when there is
 * none, then continues the running one for `budgetMs`. A lease keeps two
 * ticks off the same run; an interrupted one is picked up once it lapses.
 */
export async function runBackupTick(
  env: Env,
  now = new Date(),
  budgetMs = CRON_BUDGET_MS
) {
  const bucket = env.BACKUP_STORAGE;
  const retention = workspaceConfig().backups;

  if (!bucket || !retention) return;
  const started = Date.now();
  const db = createDb(env.DB);
  await failStaleRuns(db, now);
  await startBackupRun(env, now, { daily: true });

  const [leased] = await db
    .update(backupRuns)
    .set({ leaseUntil: new Date(started + LEASE_MS) })
    .where(
      and(
        eq(backupRuns.status, "running"),
        or(
          isNull(backupRuns.leaseUntil),
          lt(backupRuns.leaseUntil, new Date(started))
        )
      )
    )
    .returning();

  if (!leased) return;
  let run = leased;
  let failure: string | null = null;

  try {
    for (
      let batch = 0;
      batch < MAX_BATCHES &&
      run.status === "running" &&
      Date.now() - started < budgetMs;
      batch += 1
    ) {
      const step = run.module
        ? moduleStep(env, bucket, db, run, run.module)
        : finishStep(bucket, db, run, retention);

      // oxlint-disable-next-line eslint/no-await-in-loop -- each batch continues from the cursor the last one saved
      run = await step;
    }
  } catch (error) {
    console.error("Backup batch failed", error);
    failure = error instanceof Error ? error.message : String(error);
  }

  await db
    .update(backupRuns)
    .set({
      leaseUntil: null,
      errors: failure
        ? [...run.errors, failure].slice(-MAX_RECORDED_ERRORS)
        : run.errors,
    })
    .where(eq(backupRuns.id, run.id));
}

/** Administration → Backups: the settings and the latest snapshot. */
export async function backupStatus(env: Env) {
  const [latest] = await createDb(env.DB)
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.id))
    .limit(1);

  const settings = workspaceConfig().backups ?? null;

  return {
    enabled: Boolean(env.BACKUP_STORAGE && settings),
    keepDays: settings?.keepDays ?? null,
    keepWeeks: settings?.keepWeeks ?? null,
    latest: latest
      ? {
          id: latest.id,
          status: latest.status,
          startedAt: latest.startedAt.getTime(),
          finishedAt: latest.finishedAt?.getTime() ?? null,
          module: latest.module,
          itemCount: latest.itemCount,
          newObjectCount: latest.newObjectCount,
          newObjectBytes: latest.newObjectBytes,
          errors: latest.errors,
        }
      : null,
  };
}
