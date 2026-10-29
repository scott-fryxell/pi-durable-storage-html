# Durable sessions in the session format

Status: draft 3. Draft 2 dropped the separate `/durable` vocabulary from draft 1. Draft 3
keeps storage ignorant of meaning and puts one store in one file.

## Rules

1. Storage does not interpret records. It encodes what the Session gives it and decodes
   it back exactly. Choosing a row type is only an encoding choice.
2. One Durable store is one session file, and one commit is one appended gzip member.
3. The file must pass upstream's storage conformance suite and a round trip of every
   write.

There is one session format. The harness (`SessionManager`) and Durable (`HtmlStorage`)
write the same `/sessions` rows to the same kind of file. `pi-session-read`, memory
search, sync, and HTML export all read both without knowing which one wrote a file.

## One codec

The row codec moves out of `packages/coding-agent/src/core/session-html.ts` into its own
package, `session-rows`, and both writers use it. It covers:

- Values: `<span>` or `<pre>`, `<data value>`, `<div itemscope>`, and `<ol><li>`.
- Escaping, so every row is exactly one line.
- Addresses: `/+<phone>/sessions/<session>/<entry>`.
- Gzip members: one plain member appended per write batch. Browsers decode only the
  first member of an appended file, so both runtimes use one shared walk
  (`session-rows/members.ts`): a raw inflate, then the member's CRC, with `Z_BUF_ERROR`
  meaning an unfinished tail and a CRC mismatch meaning damage. Node's zlib and the
  browser's pako both provide the raw inflate.
- Recovery: a cut-off last member is dropped and the file is truncated back to the last
  whole member. Damage anywhere else fails without changing the bytes.

The format can only change in `session-rows`. Its round-trip tests run in both the fork
and this package.

## File

One Durable store is one session file, `<session>.html.gz`, with header row `/sessions`
and `itemid` `/+phone/sessions/<session>`. Every conversation in the store lives in it.

| Durable | In the file |
| --- | --- |
| conversation | a `/sessions/conversation` row; its `itemid` is `…/conversations/<id>` |
| root conversation | its first entry has `parentId` null, which makes it the root of pi's tree |
| fork (`parent: { conversationId, at }`) | the fork's first entry's `parentId` links to the entry at `at`, which is how pi branches |
| owned conversation (`owner`, a subagent) | its first entry has `parentId` null, and its conversation row links `owner` to the conversation and task |

The header keeps pi's fields (`version`, `id`, `timestamp`, `cwd`, and `parentSession`)
and adds `<link itemprop="store">`, which names the Durable store.

Owned conversations make extra roots in the file. Pi's `getTree()` returns every
entry with `parentId` null as a root, but it calls a well-formed session one with
exactly one root. Check that pi's views, resume and export work with several roots.
If they don't, change pi's reader. Storage must not invent a parent.

Pi entry ids are strings. Durable ids are numbers and are written as decimal strings.

## Entries

Every Durable entry is a row with an `itemid` and a `parentId` link to the entry before
it in its conversation. That is the previous entry, or the fork point when the entry is
the first one in a fork. `timestamp` is the commit time.

| Durable entry | Row |
| --- | --- |
| exactly one model message and nothing that `/sessions/message` cannot hold | `/sessions/message`, with `message` and `kind` |
| anything else | `/sessions/entry` with `kind`, `model`, `data`, `head`, and `edits` as written |

There are only two row types, so the encoder never decides what an entry means. It uses
`/sessions/message` only when decoding the row gives back the identical `EntryRecord`,
and `kind` always travels with it. Everything else is `/sessions/entry`. Heads and edits
stay Durable fields; they are not mapped to pi's `compaction` or `context_edit`.

`byTaskId` is a `<link>` to the task row. A Durable reader decodes every row back into
the exact `EntryRecord`, and pi's reader shows the rows it knows.

A property test decodes every encoded write and compares it with the original. A
write that fails that comparison is an encoder bug.

## Durable-only rows

These rows sit in the same file, after the entries they relate to:

| Itemtype | Content |
| --- | --- |
| `/sessions/task` | the whole `TaskRecord`; the newest row for an id wins |
| `/sessions/submission` | the whole `SubmissionRecord`; the newest row wins |
| `/sessions/document/create`, `copy`, `change`, `retire` | the document write; storage stamps `createdAt` and `retiredAt` from the commit |
| `/sessions/commit` | starts each commit: `itemid` `…/commits/<seq>` and `writes`, the number of rows that follow |

Pi's reader must skip itemtypes it does not know instead of failing. Pi already has
`custom` entries, so this needs checking, and a test if it is not already covered.

## References

A field that names another record is a `<link href>` to that record's `itemid`:

- `parentId`
- `conversationId`
- `parent.conversationId` and `parent.at`
- `owner.conversationId` and `owner.taskId`
- `byTaskId`
- `head`
- `entry` and `answer`
- the task's `owner`
- `edits[].target`
- `scope.taskId`
- `source.id`

The decoder turns a link back into the number. All other fields go through the codec
unchanged. On each upstream update, review this list for new reference fields.

## Commits

1. Validate the writes and give them a `seq`.
2. Encode one `/sessions/commit` row and its write rows, then append them to the file
   as one gzip member.
3. Call `adopt(seq)` once the member is durable. This is the upcoming upstream
   `Storage.commit(writes, adopt, context)` contract.

On open, replay the members in order. A cut-off last member, or one with fewer rows than
its commit row promises, was never acknowledged. It is dropped and the file is truncated.

## Open questions

- Plug-in point: `Storage` (`HtmlStorage`) or under Chord v2's store (`StoreStorage`).
  Decide when upstream releases the `adopt` contract and `StoreStorage`.
- Moving under Chord's store: the format stays generic, so the same file can back a
  Chord store persistence layer if Durable storage moves there.
- Several roots: confirm pi's reader handles owned conversations as extra roots.
- Compaction and snapshots: not in this draft.
- Single writer in the browser: Web Locks pick the tab, and a dedicated worker holds a
  sync access handle (check 8).
