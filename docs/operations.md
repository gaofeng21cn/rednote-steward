# Account operations

RedNote Steward keeps task execution, account organization, recovery, and local observation in one private state root. Its CLI and MCP Server call the same controller. They do not create separate queues.

## Queue and batch work

The automatic runner chooses a due task whose account and browser profile can be written. An unresolved attempt blocks another write to the same account or profile; it does not prevent another eligible account from progressing. Filter a run when several accounts share one local queue:

```bash
xhs-ops plan --account travel
xhs-ops run --account travel
```

Use a batch ID to inspect and execute a bounded group of prepared packages:

```bash
xhs-ops ingest-batch ./posts/one/post.json ./posts/two/post.json --batch trip-2026-11
xhs-ops approve-batch trip-2026-11 --authorization "Publish the approved trip batch" --now
xhs-ops run-batch trip-2026-11 --limit 4
xhs-ops plan --all
```

Each item keeps its own frozen fingerprint, account, attempt and result. Batch success does not hide an item that failed or needs reconciliation. A batch authorization applies to the selected items; do not request per-item confirmation when the user's existing instruction already covers them.

Cancel only work that has not started. A task in `running`, `submitted` or `needs_review` must be reconciled, not cancelled to free the account. Pause stops future claims for the selected account or batch; it does not kill an in-flight browser writer.

```bash
xhs-ops cancel TASK_ID --reason "Package withdrawn before execution"
xhs-ops pause --account travel --reason "Waiting for the next review window"
xhs-ops resume --account travel
```

## Progress and error evidence

Task events distinguish controller selection, preflight, adapter activity, uncertain submission, platform acceptance and same-note readback. Adapter phases describe observed browser events; they do not promise that Xiaohongshu retained an uploaded composer after a process or tab closed. Error codes, messages and adapter exit details are preserved where available.

```bash
xhs-ops show TASK_ID
xhs-ops handoff TASK_ID
```

Use `handoff` to prepare the exact frozen content, media order, native topics, last observed phase and next action for a person or another client. It does not authorize another write.

If a person completed the platform action, link the original task to the existing platform note:

```bash
xhs-ops link-existing TASK_ID --note-id NOTE_ID --reason "Published manually from the prepared composer"
```

Linking reads the selected account and the exact note, then stores the association and field evidence on the existing task. It does not create or submit a new publication. Ambiguous or mismatched results remain unresolved. A human statement and platform readback are stored as different evidence.

For an interrupted browser write, inspect the saved attempt and account state first:

```bash
xhs-ops reconcile TASK_ID
```

Unknown submission outcomes require readback before another write. A recorded `prepared` or `uploading` phase does not by itself establish that the browser composer remains available. Reuse an uploaded asset only after the exact account, content fingerprint, media and unsubmitted composer have been observed. Otherwise continue with the operator using the handoff or prepare the package again only after the prior attempt is resolved.

## Account catalog and inspection

Creator inventory supports bounded requests up to 1,000 notes. Request the
needed limit explicitly; CLI `xhs-ops inventory` responses include `total`,
`returned`, `complete`, `truncated` and `requestedLimit`. Treat a response with
`complete: false` as a partial read. The adapter keeps returning a bare row
array for callers that do not request metadata.

Without an advertised total, a stopped virtual list remains incomplete; a confirmed empty-state view returns the same metadata shape.

The catalog is a local projection keyed by stable account ID and platform note ID. Synchronizing platform inventory updates observed fields while preserving local organization and editorial decisions. It does not create publication tasks.

```bash
xhs-ops catalog sync --account travel --limit 100
xhs-ops catalog --account travel
xhs-ops catalog series --account travel --series city-notes --title "City notes" --episodes 01,02,03
xhs-ops catalog set NOTE_ID --account travel --series city-notes --episode 01 \
  --content-type travel-photo --maintenance-status keep --reason "The original observation already works"
```

Use the catalog to associate notes with a series and episode, content type, source path or maintenance status. Series and execution batches are separate concepts: a series groups related published content; a batch groups tasks operated together. Local series labels do not imply that Xiaohongshu supports a matching collection or ordering feature.

Inspection cursors support authorized, incremental review. They identify which range has been inspected; they do not schedule work. Per-account policy can retain account voice, topic and media preferences without turning those preferences into automatic quality scores or a publishing gate.

```bash
xhs-ops catalog policy --account travel --file ./account-policy.json
xhs-ops catalog inspection --account travel --limit 6
xhs-ops catalog cursor --account travel --watermark 2026-11-01T00:00:00+08:00 --boundary NOTE_ID
```

The policy JSON may include `inspectionMode` (`off`, `manual` or `incremental`), `preserveContentTypes` and `contextRefs` for private workspace guidance. Advance the cursor only to a range actually inspected; missing platform dates remain visible as uninspected. An already effective short post can be recorded as `keep`.

For a personal travel account, begin from what the original post noticed and shared. Preserve a strong short post as-is. Improve titles, copy or native topics when a concrete gain is clear; retain evidence and reasoning in established cultural, historical or commercial analysis. Do not expand every photo into a guide or a generic explanation. Mature educational series are organized and preserved by default; correct a known material error without reopening every lesson.

Photographs can be enhanced as separate derivatives when needed. Preserve the source and record the relationship between original, derivative and selected upload bytes. Exposure, white balance, contrast and light sharpening should keep the people, place, object, food, signs, weather and scene faithful. Select explicit sharing-safe variants of maps or documents; never assume the most recently modified file is the public version.

For prepared medical videos, use the approved final asset and account-specific copy. Cataloguing, metrics and release management do not authorize new clinical claims or regenerate a finished episode. The medical account remains on-demand; installation does not create a recurring inspection.

## Metrics history

`collect` records a new observation without deleting earlier values. Each observation is associated with account, note and capture time; metrics history can be read for one account or note:

```bash
xhs-ops collect --account travel --limit 30
xhs-ops metrics-history --account travel --note-id NOTE_ID --limit 10
```

Missing, unsupported and failed fields remain distinguishable from an actual zero. Compare observations with the relevant content revision and edit time. A 24-72-hour or seven-day change is an observation, not proof that one title, photograph or edit caused the change. Metrics do not automatically rewrite a post.

## Backup and restore

Back up the private state database with SQLite's consistent backup mechanism; copying only the database file while WAL is active is not a valid backup. Restore defaults to preview. Review the selected source, destination, schema and account/task counts before using `--apply`:

```bash
xhs-ops backup --out ./steward-backup
XHS_OPS_HOME="$HOME/.local/share/rednote-steward-restored" xhs-ops restore ./steward-backup
XHS_OPS_HOME="$HOME/.local/share/rednote-steward-restored" xhs-ops restore ./steward-backup --apply
```

Restore writes only to an empty destination state root; set `XHS_OPS_HOME` to that new destination for both preview and apply. It preserves recorded tasks and their evidence but does not execute queued items. When migrating accounts or media to another machine, map media paths and recheck hashes before resuming. Transfer the account's write owner deliberately so two state roots cannot operate the same UID or Chrome profile at once.

To import an old xhs-ops SQLite or schema-3 JSON ledger, preview it first. The preview selects one source account when the file contains several, verifies media mappings and returns a source digest. Apply requires that exact digest and an explicit target; historical tasks stay historical, unresolved attempts stay `needs_review`, and no task is authorized or submitted:

```bash
xhs-ops import-legacy ./old-ledger.json --account travel
xhs-ops import-legacy ./old-ledger.json --account travel --target "$HOME/.local/share/rednote-steward-migrated" \
  --expected-digest SOURCE_DIGEST --apply
```

After importing, reconcile an unresolved historical task and inspect a current `post.json` before creating any new publication task. An old fingerprint or media path is not a current package by itself.

Use `xhs-ops media-info FILE --ffprobe` for optional deterministic media metadata. Missing `ffprobe` is reported as unavailable; it does not mean the file was decoded or accepted by the platform.

Compare an approved local video with a downloaded platform readback before treating a resource-path change as a content update:

```bash
xhs-ops media-compare /absolute/local.mp4 /absolute/platform-readback.mp4 \
  --output ./platform-video-comparison.json
```

The command checks SHA-256, duration, full-duration visual SSIM sampled at two frames per second and normalized stereo audio PSNR. Platform transcoding can change bytes and resource paths, so byte identity is reported separately. A `match` covers content agreement only; it does not prove platform review or public visibility.

## New-machine check

`xhs-ops doctor --json` reports the installed package and source revision where available, state root and schema, OpenCLI/Browser Bridge versions, configured Chrome profile, account identity check and capability evidence. `supported` means that capability was exercised in the reported environment; `unknown` means it has not been qualified. A present executable or running MCP process alone does not prove login or publishing readiness. Use `doctor --redact` for a shareable result; it removes private paths, UIDs, profiles and raw errors.

OpenCLI, Browser Bridge and account capabilities are versioned together in the release manifest. After an upgrade, run doctor and perform the relevant read-only account check before the first write. Live image, video, cover, native-topic and edit acceptance remain separate from unit tests and package installation.

Use `account status` to inspect the state owner and `account takeover` only after the exact old home has been read and no unresolved attempt or active lease remains. A missing or ambiguous source is not a safe takeover.

Before changing the pinned browser runtime, qualify the actual account/backend combination and compare saved read-only results. Qualification does not publish a test post:

```bash
xhs-ops qualify --account travel --backend-label bundled --repeats 3
xhs-ops compare-qualifications ./qualification-a.json ./qualification-b.json
```
