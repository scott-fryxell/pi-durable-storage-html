# pi-durable-storage-html

A `Storage` backend for Pi Durable that keeps sessions as **HTML microdata rows in one
appendable `.html.gz` file**. One format everywhere: harness (`html.gz` sessions), Explorer
(browser), and halo/VM.

## What it is

Durable lets you hand it any object that implements its `Storage` interface. This module is
one such backend:

- **Reads** are answered by upstream's `MemoryStorage`, rebuilt by replaying the file on open.
- **Writes** append one gzip member per commit. The file is readable with `zcat`.
- **Reference ids** (`conversationId`, `byTaskId`, `head`, `owner.*`, `parent.*`, ...) are
  written as `<link>`, so the file reads as linked pages, not bare numbers.

Two backends:

| | Filesystem | Guard |
| --- | --- | --- |
| `HtmlStorage` (Node, `src/storage.ts`) | `node:fs` + `node:zlib` | `fsync` option, off by default |
| `BrowserHtmlStorage` (browser, `src/browser-storage.ts`) | OPFS via a dedicated Worker | one sync access handle = one writer |

## How it sits with the fork

This module depends on `@earendil-works/pi-coding-agent/session-rows` for the row codec and
the gzip member walk. **That subpath exists only in our pi fork**, not upstream, so this
module is coupled to the fork. This is deliberate: the format is defined once, in the fork;
storage (here) never invents an encoding. Keep that coupling bounded to `session-rows`.

Layout decision: **minimise fork changes.** All storage logic lives in this repo. The two
genuine pi bugs this work found (lone-UTF-16-surrogate escaping; rows without `parentId` made
tree roots) should be contributed upstream so the fork converges.

## Design rules (from the checks)

- **One store = one file = one gzip member per commit.** No multi-file recovery.
- **Storage never interprets records.** Row `<itemtype>` is only an encoding choice; leave
  entries as `/sessions/message` only when lossless, else `/sessions/entry`.
- **Browsers cannot decode concatenated gzip members.** `DecompressionStream` fails on
  appended files, so reads walk members with **pako**: check the header, raw-inflate, use
  `avail_in` for the boundary, then the member's CRC.
- **Torn tail vs corruption, via pako:** pako reports a cut-off tail as `Z_BUF_ERROR`
  (`err: -5`, "buffer error"); corruption in the middle finishes the stream and fails its
  CRC. Node's zlib gives the same pair (`Z_BUF_ERROR` = short). That is what tells an
  unfinished tail from damage.
- **Browser writes go through a Worker holding a sync-access handle.** `createWritable`
  copies the whole file on each close (56 ms at 4 MB). A sync handle appends in place
  (~0.4 ms), and its exclusivity enforces one writer: a second holder throws
  `NoModificationAllowedError`, which Explorer maps to its `TakenError`.
- **`createWritable` abandoned or left open across a reload leaves the file unchanged**;
  writes land only on `close()`.
- **Lineage (each conversation's last entry) is updated only after a durable append.** A
  failed append must not poison the next row's `parentId`.

## Tested

- Upstream Durable `registerStorageConformance` passes (65/65), plain and reopening after
  every commit.
- Real harness turns over the module: answers, streamed progress, tool calls, forks,
  subagents, compaction, abort.
- Crash recovery at every truncated-tail byte; torn sync-handle write recovers to the last
  whole member.
- Browser e2e against the built bundle: write through the worker, replay on reopen, and a
  second tab refused with `OwnershipLostError`.
- 300 turns: 4.1 KB gzip / 9.5 commits per turn; `HtmlStorage.open` ~110 ms; pi reader is
  the slow side (~1.3 s) — that is a pi profiling target, not this module.

Bundle: `apps/realness` `durable.config.js` aliases this package's `src`, `pako`, and the
fork; `durable.lock.json` pins the fork and module commits. Read-only follower tabs use
`BrowserHtmlStorage.readOnly` (no sync handle).

## Future work and flags (do not lose)

**Multi-tenant (FLAG, not yet decided).** We may serve multiple clients and businesses:

- One store per client fits this design (one file per client, per-client locks). A shared
  store with owner scoping, or Chord's owner claims, would not.
- **Owner ids are phone-only today** (`+<phone>`). Businesses are not phone numbers; the
  `+`-only owner shape must widen before multi-tenant.
- In multi-tenant, stores and files live outside the browser — on a host. Decide a
  filesystem backend for that before re-scoping. Revisit when the need is real.
- **Chord v2 `StoreStorage`** is the fork's direction (owner names/claims, one id allocator,
  rewindable docs, jobs). It earns its place only if one install serves many tenants. Today
  the module is a plain `Storage`, which is fine for a single box.

**Open questions:**

- Fsync every commit, or per device? (Node defaults off; browsers set their own flush rule.)
- When does compaction earn its cost? The file only grows; 300 turns is ~1.2 MB.
- Firefox and Safari: sync access handles (and pako member walking) are untested; only
  Chrome is verified.
- Upstream's next release changes `Storage.commit` to take an `adopt(seq)` callback and
  adds deferred `persistWithinMs` commits. Both are small here (one line; Next-side
  batching) but are the next migration when that release lands. Re-check `session-rows` and
  the `Storage` interface then.