---
name: rednote-steward
description: Manage Xiaohongshu publishing and existing-post maintenance with RedNote Steward. Use for prepared image or video packages, account inventory, publication queues, platform readback, and interrupted tasks.
---

# RedNote Steward

Use the installed `xhs-ops` CLI or `rednote-steward` MCP tools as the publication manager. They share account bindings and one task database. Account preferences, source media, and existing authorization stay in the user's content workspace.

## Choose the account and resume point

Read the requested workspace's guidance and current release records. Use `accounts_list` / `xhs-ops account list` and verify the intended binding with `doctor`. `account_probe` reads the stable platform user ID from a selected Chrome profile. Bind each account separately; nickname alone is insufficient identity evidence.

When the workspace already uses another active ledger or an uploaded browser draft, continue from that record until ownership is deliberately transferred. Installing this tool does not create a new publication queue for already-running work.

## Publish prepared content

1. Inspect the package, then ingest it. Use absolute paths with MCP. An image package contains `images`; a video package contains `video` and optionally `cover`. `subtitle` records provenance; the finished video must already contain the desired subtitles.
2. Record the user's applicable authorization with `task_authorize` or `approve --authorization`. Existing single-post, batch, or standing instructions may cover the action; do not ask again when the scope is already clear. Configuration and inspection requests authorize their corresponding work only.
3. Execute the task. MCP `task_execute` returns a task ID after starting its worker; use `task_get` for the result. Keep the frozen content and media unchanged during execution.
4. Read the result for the same platform note ID. Distinguish submitted, matching fields, platform review/visibility, and audience response.

Use native topic names in `topics`. The adapter selects candidate nodes; plain text `#tags` is not evidence of an activated topic. Prefer the packaged OpenCLI path for supported operations. Use browser or computer interaction only for a demonstrated gap, preserving any current composer and attempt record.

## Recover an interrupted task

Read `task_get` / `show` first. Use `task_reconcile` / `reconcile` to inspect the platform result. An uncertain submission is never a reason to send the same item again. Use the absence path only after the account inventory and saved attempt establish that the item was not submitted. A verified task is complete for its recorded fields.

## Maintain existing posts

Start with the requested scope and account preferences. Inventory and metrics identify candidates; they do not decide editorial quality. Before changing a post, understand what the author intended to share and what the edit improves.

For personal travel and everyday photos, preserve concrete discoveries, the author's voice, and supported cultural or historical analysis. A short observation may already work. Avoid expanding every post into a lesson or adding invented experience. When photo improvement is requested, preserve originals and use separate derivatives; exposure, white balance, contrast, and light sharpening should keep people, objects, text, and the scene faithful.

For prepared medical or educational videos, use the approved media, cover, copy, and relevant source records. Keep publication management separate from new clinical claims or content production. A revised episode may need linking to an older note before choosing edit or new publication.

Run inspections on request. Configure recurring work only when the user asks for a schedule. Keep technical checks and task records out of public captions.
