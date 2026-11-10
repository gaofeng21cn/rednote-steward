---
name: rednote-steward
description: Manage Xiaohongshu prepared image/video publication, queues, account assets, existing-post maintenance and interrupted-task recovery through RedNote Steward. Keep content production and account preferences in the user's workspace.
---

# RedNote Steward

Use the installed `xhs-ops` CLI or `rednote-steward` MCP tools as the publication manager. They share account bindings, task state and recovery rules. Prefer the packaged OpenCLI/Chrome path for supported operations. Use browser or computer interaction for a demonstrated gap, preserving the current attempt.

When installed as an OPL/Codex plugin, use its `rednote-steward` MCP server or
`node <plugin-root>/scripts/run-plugin.mjs cli <arguments>`. The plugin prepares
its locked Node dependencies in its own directory and runs the same controller;
it does not require a separate native application install. The native
`xhs-ops installation status --json` command inspects only the separate native
installation, so its `not_installed` result does not mean the plugin is absent.

Read the installed `xhs-ops help` and project docs for the actual command surface. This generic Skill owns tool routing; the user's project guidance supplies account voice, media sources and permitted work. Keep private account IDs, content, receipts and records in the private state root or content workspace.

## Choose the account and resume point

Read the requested workspace's guidance and current release records. Use `accounts_list` / `xhs-ops account list` and verify the intended binding with `doctor --account ALIAS --json`. Check package/source versions, actual OpenCLI/Bridge connection, stable account ID and profile. An unqualified capability remains `unknown`; an installed command or running MCP process does not establish login or publishing readiness.

`account_probe` reads the stable platform user ID from a selected Chrome profile. Bind each account separately. Follow the single local owner for the UID and profile; use the existing state root when another binding or unresolved task owns it.

When the workspace already uses another active ledger or uploaded browser composer, continue from that record until ownership is deliberately transferred. Installing this tool does not create a new publication queue for already-running work. Backup/restore or an old ledger migration starts with a preview and retains note IDs, authorizations, attempts and media hashes; it does not publish anything.

## Publish prepared content

1. Inspect the package, then ingest it. Use absolute paths with MCP. An image package contains `images`; a video package contains `video` and optionally `cover`. `subtitle` records provenance; the finished video must already contain the desired subtitles.
2. Record the user's applicable authorization with `task_authorize` or `approve --authorization`. Existing single-post, batch, or standing instructions may cover the action; do not ask again when the scope is already clear. Configuration and inspection requests authorize their corresponding work only.
3. Execute the task or bounded batch. MCP `task_execute` starts a worker; `worker_started` is launch evidence, not proof the task was claimed or published. Read `task_get` for launch status, phase, errors and result. Keep the frozen content and media unchanged during execution.
4. Read the result for the same platform note ID. Distinguish submitted, matching fields, platform review/visibility, and audience response.

Use native topic names in `topics` and verify their associated platform nodes. Plain text `#tags` is not evidence of an activated topic. Use declared covers and content facts for original/reposted or AI-related platform fields; do not silently replace a requested cover, select an unrelated topic or enable a declaration by default.

Each batch item keeps its own result. Pause prevents future claims; it does not stop an in-flight browser operation. Cancel only unstarted work. Keep successful items and continue eligible items rather than rerunning an entire partially completed batch.

## Recover an interrupted task

Ordinary adapter calls close their own tab; `prepare-only`, explicit `--keep-tab true`
and persistent sessions retain it for handoff. Keep tab cleanup separate from task
reconciliation. Inspect the retained page before assuming that uploaded media remain.

Read `task_get` / `show` first. Use `handoff` to obtain the exact frozen content, media order, topics, last phase and next action. Use `task_reconcile` / `reconcile` to inspect the platform result. An uncertain submission is never a reason to send the same item again. Use the absence path only after the account inventory, saved attempt and composer inspection establish that the item was not submitted.

Phase records explain observed work; they do not guarantee the platform retained uploaded media after a tab or process closed. Reuse an uploaded composer only when its exact account, content/media and unsubmitted state have been observed. A person's manual click should be associated with the original task using `link-existing`; preserve the manual statement separately from same-note platform readback. Reconciliation, linking and missing receipt/metrics recovery never re-submit the post.

For a historical task missing cover-selection events, use `cover_evidence` / `cover-evidence` with the saved current platform cover, then pass the receipt to `task_link_existing` / `link-existing`. The controller recomputes image content and binds it to the frozen task, stable account, exact note and fresh browser readback. Preserve the missing events as history; unavailable or low-confidence evidence remains unresolved. Use `task_supersede` / `supersede` when a verified replacement task owns the same account, profile and note. A fresh readback must still match the replacement; the old task retains its verification gap and replacement link while releasing its obsolete write block. An unknown publication without an exact note ID still needs reconciliation.

## Maintain existing posts

Start with the requested scope and account preferences. The catalog organizes platform note IDs, series/episodes, local sources, media versions and maintenance decisions without creating publication tasks. Series are content organization; batches are execution groups. Platform collections or ordering require separately verified platform support.

Read inventory coverage alongside the notes: `total`, `returned`, `complete`, `truncated` and `requestedLimit`. Choose an explicit limit up to 1,000 for an account-wide read, and treat it as complete only when `complete` is true. An unavailable platform total keeps coverage unknown even if scrolling stops. Candidate lookup or absence checks need the relevant range covered before drawing a conclusion.

Use an inspection cursor for authorized incremental maintenance. Inventory and metrics identify candidates; they do not decide editorial quality. Before changing a post, understand what the author intended to share and what the edit improves. Keep mature series by default and address known material problems locally.

When duplicate notes are proven to contain the same approved content, choose the canonical note using the platform history that should be retained, then use `catalog_consolidate` / `catalog consolidate` to move the local series, episode, content type and source mapping atomically. The operation preserves both note IDs and inventory evidence, marks the superseded note as `superseded`, stores a private receipt and removes it from series episode counts and inspection candidates. Conflicting canonical and superseded series or episode mappings require explicit values. This is a local catalog operation; it does not hide or edit either platform note.

For personal travel and everyday photos, preserve concrete discoveries, the author's voice, and existing cultural, historical or commercial reasoning. Add depth where evidence supports a human or cultural observation; technical notes may need only clear sharing. A short observation may already work. Avoid expanding every post into a lesson, inventing experience or exposing internal edit logic in the caption.

When photo improvement is requested, preserve originals and use separate derivatives; exposure, white balance, contrast and light sharpening should keep people, objects, food, signs, buildings, weather and the scene faithful. Record source/derivative/upload lineage when available. Select explicit sharing-safe map/document variants, not merely the newest file.

For prepared medical or educational videos, use the approved media, cover, copy, and relevant source records. Keep publication management separate from new clinical claims or content production. A revised episode may need linking to an older note before choosing edit or new publication.

When the existing video editor supports replacement, use an `edit` package with the same
`sourceNoteId`, `video`, and optional `cover`. Read the video editor with `noteType: "video"`
or `--note-type video`. Record the saved resource change separately from content agreement.
Use `media_compare` / `media-compare` with the frozen local video and the downloaded same-note
readback when checking the saved version: it compares SHA-256, duration, full-duration
2 fps image samples and normalized audio. Review low-score frame evidence and keep
`review_required` results unresolved. Preserve the active composer and reconcile an
interrupted attempt before uploading again.

When replacing both video and cover, the creator editor uses two saves: video and
copy first, then the custom cover after reopening the same note. Each stage submits
once. Read the saved stage evidence before recovery; an already-saved video must
not be uploaded again to finish its cover. `prepare-only` leaves the cover stage
pending. Ordinary cover verification uses the recorded selection and a saved resource
change from before that stage. Historical tasks can use the independent cover-content
evidence path above. Platform transformation may change its path; resource equality
and image content comparison are recorded separately.
If only the cover needs repair, use an edit package with `cover` and no `video`.
The controller reads the existing video first and the adapter changes only the
cover and copy, so recovery never uploads an already-saved video again. The
cover preview wait defaults to 120 seconds and accepts `XHS_OPS_COVER_TIMEOUT`
from 10 to 600 seconds.

Metrics collection appends observations. Keep capture time, account, note and content version visible, and distinguish missing values from zero. Window changes are observations, not causal proof or instructions to rewrite.

Run inspections within the user's requested scope. Configure recurring work only when the user asks for a schedule; on-demand medical publication remains on-demand. Keep technical checks and task records out of public captions. Operational command examples are in the project's `docs/operations.md`; do not copy private account records into the public repository or diagnostics.
