import { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import { defaultSystemFolderOrder } from "./folder-model";
/**
 * JMAP views over a mailbox's SQLite store (RFC 8621). A JMAP Mailbox is a
 * system folder or a custom folder; an email sits in exactly one, derived
 * from its conversation's state and its own direction.
 */

/** Which JMAP Mailbox an email (alias e) of conversation (alias c) is in. */
export const EMAIL_MAILBOX_SQL = `case
  when c.mailbox_state = 'trash' then 'trash'
  when c.mailbox_state = 'spam' then 'spam'
  when c.mailbox_state = 'archive' then 'archive'
  when e.direction = 'outgoing' then 'sent'
  when c.folder_id is not null then c.folder_id
  else 'inbox'
end`;

/**
 * An id list bound as one JSON parameter: a statement binds at most 100
 * parameters, and JMAP asks for up to 500 ids at a time.
 */
const IDS = "(select cast(value as text) from json_each(?))";

const SYSTEM_MAILBOXES = [
  { id: "inbox", name: "Inbox", role: "inbox" },
  { id: "sent", name: "Sent", role: "sent" },
  { id: "archive", name: "Archive", role: "archive" },
  { id: "spam", name: "Spam", role: "junk" },
  { id: "trash", name: "Trash", role: "trash" },
] as const;

export type JmapMailboxRow = {
  id: string;
  name: string;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
};

export type JmapEmailFilter = {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: number;
  after?: number;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
};

/** The newest change's number in the change log (jmap_changes), or 0. */
export function currentSeq(sql: SqlStorage) {
  return (
    sql
      .exec<{ seq: number | null }>("select max(seq) as seq from jmap_changes")
      .one().seq ?? 0
  );
}

/**
 * The mailbox's JMAP state: the change log's newest entry, `c<seq>`. The
 * prefix tells it from the plain counters of before the log, which are
 * then answered with cannotCalculateChanges (one full resync).
 */
export function jmapState(storage: DurableObjectStorage) {
  return `c${currentSeq(storage.sql)}`;
}

/**
 * Moves the state on for a change no trigger records (the log's triggers
 * cover what JMAP shows), so streams and push see something happened.
 */
export function bumpJmapState(storage: DurableObjectStorage) {
  storage.sql.exec(
    "insert into jmap_changes (type, id, kind) values ('State', '', 'updated')"
  );
}

export type JmapChangeType = "Email" | "Thread" | "Mailbox";

export type JmapChanges = {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
  /** Mailbox only: an email changed, so mailbox counts may have too. */
  emailsChanged: boolean;
};

/**
 * Foo/changes from the change log: the objects of `type` created, updated
 * or destroyed since `sinceState`, as `userId` sees them (rows for another
 * person's drafts or read state are left out), at most `maxChanges` ids.
 * Null when `sinceState` can't be answered: not a state of this log, newer
 * than it, or older than its oldest kept entry.
 */
/**
 * The change log position a JMAP state names, if this log can answer from
 * it: a `c<seq>` state, not newer than the log, not older than its oldest
 * kept entry.
 */
function stateSeq(sql: SqlStorage, state: string) {
  const match = /^c(\d+)$/u.exec(state);

  if (!match) return null;
  const since = Number(match[1]);
  const current = currentSeq(sql);

  const oldest =
    sql
      .exec<{ seq: number | null }>("select min(seq) as seq from jmap_changes")
      .one().seq ?? current + 1;

  return since > current || since < oldest - 1 ? null : since;
}

/**
 * The ids of `type` that changed in any way since `state`, as `userId` sees
 * them; null when the state can't be answered from.
 */
export function changedSince(
  sql: SqlStorage,
  type: JmapChangeType,
  state: string,
  userId: string
) {
  const since = stateSeq(sql, state);

  if (since === null) return null;

  return new Set(
    sql
      .exec<{ id: string }>(
        `select distinct id from jmap_changes
         where type = ? and seq > ? and (user_id is null or user_id = ?)`,
        type,
        since,
        userId
      )
      .toArray()
      .map((row) => row.id)
  );
}

export function jmapChanges(
  sql: SqlStorage,
  input: {
    type: JmapChangeType;
    sinceState: string;
    userId: string;
    maxChanges: number | null;
  }
): JmapChanges | null {
  const since = stateSeq(sql, input.sinceState);

  if (since === null) return null;
  const current = currentSeq(sql);

  const rows = sql
    .exec<{ seq: number; id: string; kind: string }>(
      `select seq, id, kind from jmap_changes
       where type = ? and seq > ? and (user_id is null or user_id = ?)
       order by seq`,
      input.type,
      since,
      input.userId
    )
    .toArray();

  // Each id's first creation or destruction in range, and its last change:
  // whether it existed before and exists now decide created, updated or
  // destroyed. (Updates don't say: a conversation can be noted as updated
  // by its first email just before its own row is written.)
  const seen = new Map<string, { lifecycle: string | null; last: string }>();
  let newState = current;
  let hasMoreChanges = false;

  for (const row of rows) {
    const known = seen.get(row.id);

    if (!known && input.maxChanges !== null && seen.size >= input.maxChanges) {
      // Stop before this id; the next call goes on from here.
      newState = row.seq - 1;
      hasMoreChanges = true;
      break;
    }

    seen.set(row.id, {
      lifecycle: known?.lifecycle ?? (row.kind === "updated" ? null : row.kind),
      last: row.kind,
    });
  }

  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];

  for (const [id, { lifecycle, last }] of seen) {
    const existedBefore = lifecycle !== "created";
    const existsNow = last !== "destroyed";

    if (existedBefore && existsNow) updated.push(id);
    else if (existsNow) created.push(id);
    else if (existedBefore) destroyed.push(id);
  }

  const emailsChanged =
    input.type === "Mailbox" &&
    sql
      .exec<{ found: number }>(
        `select exists (
           select 1 from jmap_changes
           where type = 'Email' and seq > ? and seq <= ?
             and (user_id is null or user_id = ?)
         ) as found`,
        since,
        newState,
        input.userId
      )
      .one().found === 1;

  return {
    oldState: `c${since}`,
    newState: `c${newState}`,
    hasMoreChanges,
    created,
    updated,
    destroyed,
    emailsChanged,
  };
}

const unread = (userId: string) => ({
  sql: "not exists (select 1 from email_read_states r where r.email_id = e.id and r.user_id = ?)",
  params: [userId],
});

export function mailboxes(sql: SqlStorage, userId: string): JmapMailboxRow[] {
  const isUnread = unread(userId);

  const counts = new Map(
    sql
      .exec<{
        mailbox: string;
        total: number;
        unread: number;
        threads: number;
        unread_threads: number;
      }>(
        `
      select mailbox,
        count(*) as total,
        sum(is_unread) as unread,
        count(distinct conversation_id) as threads,
        count(distinct case when is_unread then conversation_id end) as unread_threads
      from (
        select ${EMAIL_MAILBOX_SQL} as mailbox, e.conversation_id, ${isUnread.sql} as is_unread
        from emails e join conversations c on c.id = e.conversation_id
      )
      group by mailbox`,
        ...isUnread.params
      )
      .toArray()
      .map((row) => [row.mailbox, row])
  );

  const custom = sql
    .exec<{ id: string; name: string; sort_order: number }>(
      "select id, name, sort_order from folders order by sort_order, name"
    )
    .toArray();

  // Mailbox order is the mail app's folder order, system folders where they were moved.
  const systemOrder = new Map(
    sql
      .exec<{ folder_id: string; sort_order: number }>(
        "select folder_id, sort_order from system_folder_order"
      )
      .toArray()
      .map((row) => [row.folder_id, row.sort_order])
  );

  // The person's drafts (the drafts table), right after Sent.
  const drafts = sql
    .exec<{ total: number }>(
      "select count(*) as total from drafts where user_id = ?",
      userId
    )
    .one().total;

  const sentOrder = systemOrder.get("sent") ?? defaultSystemFolderOrder("sent");

  const rows = [
    ...SYSTEM_MAILBOXES.map((mailbox) => ({
      ...mailbox,
      sortOrder:
        mailbox.id === "inbox"
          ? 0
          : (systemOrder.get(mailbox.id) ??
            defaultSystemFolderOrder(mailbox.id)),
    })),
    ...custom.map((folder) => ({
      id: folder.id,
      name: folder.name,
      role: null,
      sortOrder: folder.sort_order,
    })),
  ];

  const draftsMailbox = {
    id: DRAFTS_FOLDER_ID,
    name: "Drafts",
    role: "drafts",
    sortOrder: sentOrder + 1,
    totalEmails: drafts,
    unreadEmails: 0,
    totalThreads: drafts,
    unreadThreads: 0,
  };

  return [
    ...rows.map((mailbox) => {
      const count = counts.get(mailbox.id);

      return {
        ...mailbox,
        totalEmails: count?.total ?? 0,
        unreadEmails: count?.unread ?? 0,
        totalThreads: count?.threads ?? 0,
        unreadThreads: count?.unread_threads ?? 0,
      };
    }),
    draftsMailbox,
  ];
}

function ftsQuery(text: string) {
  // Each word must appear; quoting keeps FTS syntax out of user input.
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");
}

/**
 * The emails an Email/query filter matches, ranked within their thread
 * (newest first), as SQL and its parameters.
 */
function filteredEmails(input: { userId: string; filter: JmapEmailFilter }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const { filter } = input;

  if (filter.inMailbox) {
    where.push(`${EMAIL_MAILBOX_SQL} = ?`);
    params.push(filter.inMailbox);
  }

  if (filter.inMailboxOtherThan?.length) {
    where.push(`${EMAIL_MAILBOX_SQL} not in ${IDS}`);
    params.push(JSON.stringify(filter.inMailboxOtherThan));
  }

  if (filter.before !== undefined) {
    where.push("e.timeline_at < ?");
    params.push(filter.before);
  }

  if (filter.after !== undefined) {
    where.push("e.timeline_at >= ?");
    params.push(filter.after);
  }

  if (filter.text?.trim()) {
    where.push(
      "e.id in (select email_id from email_search where email_search match ?)"
    );
    params.push(ftsQuery(filter.text));
  }

  for (const [field, column] of [
    ["from", "e.from_json"],
    ["subject", "e.subject"],
  ] as const) {
    const value = filter[field];

    if (value) {
      where.push(`lower(${column}) like ?`);
      params.push(`%${value.toLowerCase()}%`);
    }
  }

  if (filter.to) {
    where.push("(lower(e.to_json) like ? or lower(e.cc_json) like ?)");
    params.push(`%${filter.to.toLowerCase()}%`, `%${filter.to.toLowerCase()}%`);
  }

  const isUnread = unread(input.userId);

  if (filter.hasKeyword === "$seen") {
    where.push(`not ${isUnread.sql}`);
    params.push(...isUnread.params);
  }

  if (filter.notKeyword === "$seen") {
    where.push(isUnread.sql);
    params.push(...isUnread.params);
  }

  if (filter.hasAttachment !== undefined) {
    where.push(
      filter.hasAttachment
        ? "json_array_length(e.attachments_json) > 0"
        : "json_array_length(e.attachments_json) = 0"
    );
  }

  return {
    sql: `
    select e.id, e.conversation_id, e.timeline_at,
      row_number() over (partition by e.conversation_id order by e.timeline_at desc, e.id desc) as thread_rank
    from emails e join conversations c on c.id = e.conversation_id
    ${where.length ? `where ${where.join(" and ")}` : ""}`,
    params,
  };
}

type EmailQueryInput = {
  userId: string;
  filter: JmapEmailFilter;
  ascending: boolean;
  collapseThreads: boolean;
};

export function queryEmails(
  sql: SqlStorage,
  input: EmailQueryInput & { position: number; limit: number }
) {
  const { sql: filtered, params } = filteredEmails(input);
  const direction = input.ascending ? "asc" : "desc";

  const rows = sql
    .exec<{ id: string; total: number }>(
      `
    select id, count(*) over () as total from (${filtered})
    ${input.collapseThreads ? "where thread_rank = 1" : ""}
    order by timeline_at ${direction}, id ${direction}
    limit ? offset ?`,
      ...params,
      input.limit,
      input.position
    )
    .toArray();

  const total =
    rows[0]?.total ??
    sql
      .exec<{ total: number }>(
        `select count(*) as total from (${filtered}) ${input.collapseThreads ? "where thread_rank = 1" : ""}`,
        ...params
      )
      .one().total;

  return { ids: rows.map((row) => row.id), total };
}

/** Every email a query lists, in order, with its thread: for Email/queryChanges. */
export function queryAllEmails(sql: SqlStorage, input: EmailQueryInput) {
  const { sql: filtered, params } = filteredEmails(input);
  const direction = input.ascending ? "asc" : "desc";

  return sql
    .exec<{ id: string; conversation_id: string }>(
      `
    select id, conversation_id from (${filtered})
    ${input.collapseThreads ? "where thread_rank = 1" : ""}
    order by timeline_at ${direction}, id ${direction}`,
      ...params
    )
    .toArray();
}

/** For each email: its JMAP Mailbox, and whether this user has read it. */
export function emailPlacement(sql: SqlStorage, userId: string, ids: string[]) {
  if (!ids.length) {
    return new Map<string, { mailboxId: string; seen: boolean }>();
  }

  const isUnread = unread(userId);

  return new Map(
    sql
      .exec<{ id: string; mailbox: string; is_unread: number }>(
        `
      select e.id, ${EMAIL_MAILBOX_SQL} as mailbox, ${isUnread.sql} as is_unread
      from emails e join conversations c on c.id = e.conversation_id
      where e.id in ${IDS}`,
        ...isUnread.params,
        JSON.stringify(ids)
      )
      .toArray()
      .map((row) => [row.id, { mailboxId: row.mailbox, seen: !row.is_unread }])
  );
}

export function threadEmails(sql: SqlStorage, threadIds: string[]) {
  const threads = new Map<string, string[]>();

  if (!threadIds.length) return threads;

  for (const row of sql.exec<{ id: string; conversation_id: string }>(
    `select id, conversation_id from emails where conversation_id in ${IDS}
     order by timeline_at, id`,
    JSON.stringify(threadIds)
  )) {
    threads.set(row.conversation_id, [
      ...(threads.get(row.conversation_id) ?? []),
      row.id,
    ]);
  }

  return threads;
}

/**
 * Moves the conversations of `emailIds` into a JMAP Mailbox. Conversations
 * move as a whole, as they do in the app. Returns false for an unknown or
 * read-only target.
 */
export function moveEmails(
  sql: SqlStorage,
  emailIds: string[],
  target: string
) {
  if (!emailIds.length) return true;
  let state: string;
  let folderId: string | null = null;

  if (target === "inbox") state = "active";
  else if (target === "archive" || target === "spam" || target === "trash") {
    state = target;
  } else if (
    sql.exec("select 1 from folders where id = ?", target).toArray().length
  ) {
    state = "active";
    folderId = target;
  } else {
    return false;
  }

  // Retention counts from entering Trash or Spam, so only those moves stamp it.
  sql.exec(
    `update conversations set mailbox_state = ?, folder_id = ?,
       state_changed_at = case
         when ? in ('trash', 'spam') and mailbox_state <> ? then ?
         else state_changed_at
       end
     where id in (select conversation_id from emails where id in ${IDS})`,
    state,
    folderId,
    state,
    state,
    Date.now(),
    JSON.stringify(emailIds)
  );

  return true;
}
