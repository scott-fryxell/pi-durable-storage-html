# Validation checks

Spike code: `src/rows.ts` and `src/storage.ts`. Tests: `test/`. The tests run against
the v1.4.0 worktree (`node_modules` links to `artifacts/pi/update-v1.4.0/node_modules`):

```
node node_modules/vitest/dist/cli.js --run --root .
```

## Status

- Checks 1, 2, 4, 5, 6 and 8 pass.
- Checks 3 and 7 are measured.
- Check 9 is read.
- Check 8 needed one runtime change: writes go through a worker. The browser reads
  members with pako, which the app already uses, so the format is unchanged.
- h14 (browser, `browser/index.html`) passes: pako recovers every cut point in OPFS,
  and a torn sync-handle write recovers to the last whole member.
- Two fork fixes are on `realness-update-v1.4.0` (`fde68d37`), with tests:
  - `session-html.ts`: lone surrogates are written as character references.
  - `session-manager.ts` and the export template: rows without `parentId` are not tree
    entries and can't be the leaf.
- Session tests pass in both formats: 198 passed, 10 skipped.
- The export tests pass.

## 1. Lossless round trip: passes, with one codec bug (fixed)

Every commit the conformance suite makes is decoded back from the file and compared
with the writes as `MemoryStorage.prepareCommit` returned them.

- `__proto__` keys: the spike's own helper dropped them at first. It now uses
  `defineProperty`, as the fork codec already does.
- A record field named `type` collides with the row's `type`, which becomes the
  itemtype. Submissions have `type: "input" | "write"`, so the submission row now nests
  the record under `record`. The same rule must hold for any record with its own `type`
  or `id`.
- **Codec bug, also present in the fork's sessions:** lone UTF-16 surrogates such as
  `"\uD800"` become U+FFFD when written as UTF-8. JSONL keeps them, because
  `JSON.stringify` escapes them. Fix it in the codec by writing lone surrogates as
  character references. Reproduce with `entryToHtmlLine({..., text: "x\uD800y"})`.
- `document.copy` never reaches the file. `prepareCommit` resolves it to
  `document.create`, so the copy row type can be dropped.

## 2. Upstream storage conformance: 50 of 50 pass after the fix

`registerStorageConformance` runs plain and with a reopen after every commit, which
rebuilds state from the file each time. The two failures are both the surrogate bug
("keeps indexed string identities lossless").

## 4. Pi reads Durable-only rows: they decode, but the leaf breaks

- `pi-session-read` decodes every row.
- `SessionManager.open` loads every row.
- `buildSessionContext(entries, "8")` gives `user, assistant`.
- **Pi treats every row as a tree node.** Commit, conversation, task, submission and
  document rows have no `parentId`, so each one becomes a root.
- **The leaf is the last row of any type.** Here that is a document row, so the default
  context and the HTML export's default view are empty.
- Needed in pi's reader: rows without a `parentId` key are not tree entries and can't
  be the leaf. The leaf is the newest entry that has a `parentId`.
- **Ids must be unique across the file.** Commit rows first used the seq as their id,
  which collided with Durable ids; pi's `byId` then lost entry 7. Commit rows now use
  `seq-<n>`. Durable's other ids come from one allocator, so they don't collide.

## 5. Several roots: work once the leaf is chosen

- `buildSessionContext(entries, "7")` gives the subagent's `user, assistant`.
- `buildSessionContext(entries, "8")` gives the main conversation.
- `getTree()` returns both entry roots. It returns the Durable-only rows too, until the
  check 4 fix lands.

## 3. What Durable writes: `test/turns.test.ts`, faux model

The session covered:

- a plain answer
- a thinking step and a tool call
- a long streamed answer
- a manual compaction
- a fork with an answer

| | Commits | Gzip bytes |
| --- | --- | --- |
| open + first answer | 6 | 2,973 |
| tool call + long answer | 14 | 6,257 |
| compaction | 3 | 1,046 |
| fork + answer | 6 | 2,684 |
| whole session | 29 | 12,960; 50,241 uncompressed, 102 rows |

- Each commit adds 240 to 890 bytes, about 440 on average.
- **Every entry encodes as `/sessions/message`: 9 of 9.** The kinds were `pi.user`,
  `pi.system`, `pi.assistant` and `pi.tool-result`, so the message-row rule loses nothing.
- **Most rows aren't entries.**
  - Tasks are rewritten as they change: 25 rows.
  - Document changes: 20 rows. Most go to `pi.live`, which holds streaming progress.
    Partial answers go there, not into entries.
  - Each conversation creates five documents: `pi.live`, `pi.inbox`, `pi.usage`,
    `pi.provider` and `pi.agent`.
- This compaction wrote no entry; the conversation was too short to compact.
- Pi opens the real file:
  - The leaf is the fork's answer.
  - There is one root, because the fork hangs off its fork point.
  - The context is `user, system, user, assistant`.
  - `pi.system` comes through as a `system` message, which pi doesn't normally store.
    Check how pi's views render it.
- Gzip per commit compresses only 3.9x, because each member starts without a dictionary.
  Compaction into a single stream would do much better. It isn't needed yet: a turn
  costs about 3 to 6 KB.
- Upstream's unreleased deferred progress commits (`persistWithinMs`) should cut the
  `pi.live` and task commits per turn.

## 6. Crash recovery: passes, `test/recovery.test.ts`

`HtmlStorage.open` reads the file with the fork's `read_session_gzip`. A cut-off last
member is truncated away before anything is read or appended, and `recovered.dropped`
reports how many bytes went.

- **Every cut point inside the last commit's member** (307 cuts of a 308-byte member):
  the open keeps the state from before that commit, the file is back at the previous
  boundary, a new commit appends, and a second open drops nothing.
- A cut-off header starts the file again.
- A flipped byte inside a middle member fails the open and leaves the bytes untouched.
- A damaged gzip header in the middle fails with `Invalid session gzip header`, and the
  file is untouched.
- A whole member whose commit has fewer rows than it promises counts as corruption, not
  as a tail to drop.

Spike gap: lineage (`tails`) is updated before the append. If the append fails, the next
entry's `parentId` would be wrong. Update it after a successful append.

## 7. Growth and open time: `test/scale.test.ts`, 300 turns, tool call every other turn

| | |
| --- | --- |
| file | 1,224 KB gz, 4,429 KB raw (3.6x), 9,159 rows |
| per turn | 4.1 KB gz, 9.5 commits |
| growth | linear: 203 KB at turn 50, 1,224 KB at turn 300 |
| write | 9.9 ms per commit, almost all of it the fsync per commit |
| `HtmlStorage.open` | 110 ms for 2,851 commits |
| pi `SessionManager.open` + context | 1,316 ms for 901 messages |

- Durable's open time is fine. 1,000 turns would be about 4 MB and roughly 0.4 s.
- **Pi's open is the slow side.** It takes 12 times as long as `HtmlStorage.open` on the
  same file. Profile it (row decode, tree build, or the context walk); pi's own long
  `html.gz` sessions would get the same win.
- **fsync per commit** costs about 10 ms on this Mac, so 95 ms per turn. Upstream's
  `JsonlStorage` defaults `fsync` to false. Decide per device; in the browser, OPFS sets
  its own flush rules.
- Compaction isn't needed for a long time. 300 turns is 1.2 MB.

## 9. Upstream's next release: the format fits as is

Read from `origin/main` (2026-10-29):

- `Storage.commit(writes, adopt, context)`: call `adopt(seq)` once the batch is durable.
  `JsonlStorage` on main does `memory.prepareCommit` → append → `adopt(seq)`, which is
  exactly HtmlStorage's order. The change is one line.
- `MemoryStorage.prepareCommit` and its export are unchanged, so the plug-in point holds.
- The `StorageWrite` types are unchanged.
- A new submission type, `"continue"`, goes through the generic codec, nested under
  `record`, so the format doesn't change.
- `mintId` must exceed every id stored, also across a reopen. Replay already does this,
  because `MemoryStorage` raises `nextId` past every applied id.
- Deferred commits (`persistWithinMs`, default 1 s) batch `pi.live` progress. That means
  fewer commits per turn, so smaller files and fewer fsyncs.
- `StoreStorage` puts Durable on Chord v2's store. That's an option for later, not a
  requirement. Our format is a `Storage`, and it can also back a store persistence layer
  because it stays generic.

## 8. Browser: passes with two changes, `browser/index.html`

Tested in headless Chrome 150 with agent-browser. Serve the page with
`node browser/serve.mjs 4399`, then call `run('<check>')`.

| Check | Result |
| --- | --- |
| `DecompressionStream` on concatenated gzip members | **fails** ("junk after end"); also fails on a cut tail |
| members walked with pako (see below) | every one of 54 cut points recovers; damage throws |
| OPFS append and truncate with `createWritable` | works |
| `createWritable` aborted, or left open across a reload | the file is unchanged; writes land only on `close()` |
| Web Locks | tab 2 sees "held elsewhere" while tab 1 lives, and gets the lock once tab 1 closes |
| `createSyncAccessHandle`, in a worker only | in-place write, flush and truncate work; a second handle or a writable gets `NoModificationAllowedError` |

Append cost, 450-byte member:

| File size | `createWritable` | sync handle + flush |
| --- | --- | --- |
| 0.1 MB | 9.1 ms | 0.55 ms |
| 1 MB | 18.3 ms | 0.42 ms |
| 4 MB | 56.1 ms | 0.40 ms |
| 16 MB | 196.9 ms | 0.43 ms |

- **Reading: walk members with pako, not `DecompressionStream`.** Browsers decode only
  the first member of an appended gzip file, a known limit; `compressor.js` already
  reads with pako 3.0.1 in a worker. Reading a whole file isn't enough on its own. A cut
  tail makes pako fail the entire file, so recovery walks member by member, the same
  way the fork's `read_session_gzip` does:
  1. Check the 10-byte header.
  2. Raw-inflate with pako.
  3. `strm.avail_in` gives where the deflate data ended. Add the 8-byte trailer.
  4. `Z_BUF_ERROR`, or not reaching the end, means an unfinished tail. Any other error is
     damage.

  Plain members, so no format change. A member's CRC can be checked by decoding it on
  its own with `DecompressionStream`, which handles a single member.
- Rejected: a length field in each member's `FEXTRA` header. It works (43 of 43 cuts),
  but it changes the format and the fork's reader, and pako already finds the
  boundaries.
- **Writing: browser writes go through a dedicated worker.** `createWritable` copies the
  whole file on every close: about 56 ms per commit at 4 MB. A sync access handle in a
  worker appends in place in about 0.4 ms, whatever the file size. It is also exclusive
  per file, so a second writer can't open it.
- Web Locks still decide which tab owns the worker, so a takeover is handled cleanly
  instead of failing on the handle.
- In-place writes can tear on a crash. The pako member walk recovers a torn tail, as
  the cut test shows. A real crash partway through a write hasn't been simulated in the browser.
- Only Chrome was tested. Firefox and Safari support for sync access handles and Web
  Locks is unchecked.

## Incident

During the checks, every package `dist/` and nested `node_modules` in
`artifacts/pi/update-v1.4.0` disappeared. The cause was most likely a workspace
`npm run clean` from another process. It was fixed with `npm ci --ignore-scripts`,
`hydrate:model-data` and `build:offline`. The worktree has no uncommitted changes.

## Not yet done

- Reference fields as `<link>`: the spike writes them as plain numbers.
- Firefox and Safari: sync access handle and Web Locks.
- h7 is done: `session-rows` extracted, member walk shared, fork commits `e35516eb`,
  `b08a97f2`, `08620a3b`.
- h8 is done: the module (`src/rows.ts`, `src/storage.ts`) now uses the extracted
  codec, writes references as `<link>` and reads them back by numeric key paths, and
  updates lineage only after a durable append, with an `fsync` option (default off).
  65 of 65 tests pass, including the full upstream storage conformance and a reopen
  after every commit. The `adopt` callback is the next upstream release, noted in
  `storage.ts`.
- How pi's UI renders a `system` message from `pi.system`.
- Profile pi's `SessionManager.open` on long files.
- How pi's UI renders a `system` message from `pi.system`.
