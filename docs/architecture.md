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

The first release focuses on macOS and one backend. Optional backends can later implement the same task semantics after their media, cover, native-topic, editing, and readback behavior has been verified. A standard MCP App can present the existing queue without introducing another source of task state.

## Verification

The repository tests package validation, stable fingerprints, account binding, concurrent task handling, interruption behavior, adapter control flow, installer isolation, and the MCP protocol. Live account reads provide separate evidence for browser connection and identity. Actual publishing, platform review, and audience outcomes each require their own observation.
