# Architecture

RedNote Steward has one local controller behind its CLI and MCP Server. Both use the same account bindings, task database, execution rules, and platform adapters.

```mermaid
flowchart LR
    CLI[xhs-ops CLI] --> Core[Local controller]
    MCP[STDIO MCP Server] --> Core
    Core --> State[(Private task state)]
    Media[User media workspace] --> Core
    Core --> Adapter[Packaged OpenCLI adapters]
    Adapter --> Chrome[Logged-in Chrome profile]
    Chrome --> XHS[Xiaohongshu]
    XHS --> Readback[Same-note readback]
    Readback --> Core
```

## The main objects

| Object | Purpose |
| --- | --- |
| Account binding | Maps a local alias to a stable platform user ID and browser profile |
| Content package | Defines the intended title, body, topics, media, and existing-note relationship |
| Task | Stores the frozen package, authorization, due time, attempts, and current state |
| Platform note | Identifies the published or edited post by its platform ID |
| Readback and receipt | Records the adapter result and which platform fields were checked |

The source package and prepared media stay in the user's workspace. Ingestion hashes the selected media and stores its paths with the task. Execution checks that the files still match before using them. A revised package is a distinct version; it does not silently replace a queued task's input.

## Execution and recovery

Task claims and account write locks are shared across processes. A CLI invocation and an MCP worker therefore cannot execute the same queued task twice. Account identity is checked in the selected browser profile before a write.

A successful browser submission and a matching platform readback are recorded separately. When the outcome is uncertain, the task preserves that uncertainty and the account remains held for reconciliation. Recovery first reads the current platform state, links the matching note when available, and records the evidence. Retrying is a later action based on the resolved result and the applicable user authorization.

MCP execution launches a separate worker and returns a task ID. Clients query that task for progress and completion. This keeps a long upload independent of a single tool response window.

## Data and installation

Public source and installation packages contain code, adapters, a generic Skill, documentation, and synthetic fixtures. Personal account settings, platform note IDs, content, metrics, receipts, and browser sessions belong to user storage.

The default private data root is `~/.local/share/rednote-steward`, selected with `XHS_OPS_HOME`. Installed application releases occupy its separate `app/` subtree; private state is kept outside those release directories. A user can choose a completely separate installation root with `XHS_OPS_INSTALL_ROOT`. Media is referenced at its original workspace path.

OpenCLI is bundled at a tested version. The packaged adapter runner loads Steward's commands without replacing an independently installed OpenCLI or modifying the user's `~/.opencli` adapter directory. Chrome retains its own login state.

## Adapter responsibility

OpenCLI performs browser operations through Browser Bridge. The controller owns task identity, package version, account serialization, authorization records, and recovery. Adapters own the actual page interaction and expose what the platform returned.

The first release focuses on macOS and one backend. Optional backends can later implement the same task semantics after their media, cover, native-topic, editing, and readback behavior has been verified. The OPL shared MCP App reads the existing queue through `src/app-contribution.mjs`; it owns no task state. Task, content and media views use the existing Package descriptor and contribution ABI. `review` opens SQLite read-only and never initializes a database, starts a worker, or reads the platform. Review data includes the frozen content fingerprint, the stored task revision, source drift, same-note field verification and separate publication evidence. Media drift disables the artifact link rather than presenting changed bytes as the frozen asset.

## Verification

The repository tests package validation, stable fingerprints, account binding, concurrent task handling, interruption behavior, adapter control flow, installer isolation, and the MCP protocol. Live account reads provide separate evidence for browser connection and identity. Actual publishing, platform review, and audience outcomes each require their own observation.

## Exact review handoff

`xhs-ops review [TASK_ID]` and MCP `task_review` return the same owner projection as the shared contribution. Select `rednote.steward.review` or `rednote.steward.media` with `task_id`, and optionally the returned `fingerprint` and `revision`, through `open_opl_apps`. Missing identity opens an input form; a mismatched identity or revision fails. The task list supports the same `task_id` filter and an optional account alias.

A human can inspect the content and ask the Agent to continue under the existing publication authorization. `approve` / `task_authorize` accept the reviewed `fingerprint` and `revision` so a changed task cannot silently inherit a stale handoff. Execution still rechecks the frozen package and account in the existing Controller. The shared views expose no publishing actions. Reopening unresolved attempts only observes the original task; the existing `reconcile` command resolves its outcome before a retry.

The `opl-package.json` contribution is development-only, with no publication reference. Native plugin metadata and the npm package include the same descriptor, adapter and owner source; this is source packaging, not an installed-host or live-account acceptance claim. Node 24 or newer is required. `npm run lock:package` updates the standard Package content lock after source edits, and `npm run check:package` verifies the lock and packaged files.
