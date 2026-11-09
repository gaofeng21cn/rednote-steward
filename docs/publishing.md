# Publishing and recovery

A content package describes the version to publish or edit. Ingestion stores its text, media fingerprints, intended account, and source note relationship. CLI and MCP execute that same task and keep the result with it.

## Image package

Place `post.json` next to the images, using paths relative to that file:

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "personal",
  "kind": "publish",
  "title": "A moment by the sea",
  "body": "Your own caption goes here.",
  "topics": [],
  "images": ["photos/01.jpg", "photos/02.jpg"]
}
```

Titles allow up to 20 Unicode code points; bodies allow up to 1,000. Image packages accept up to 18 images. `topics` contains up to 10 platform topic names; an empty array is valid. The adapter selects matching topic candidates. Typing a `#hashtag` into body text alone does not establish a topic association.

Use `xhs-ops inspect ./post.json` to check paths, required fields, and media fingerprints. Topic availability is checked against the platform during the browser operation. Keep source photos and any edited derivatives as separate files so the selected version remains clear.

## Finished video package

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "education",
  "kind": "publish",
  "title": "An introduction",
  "body": "Your approved description goes here.",
  "topics": [],
  "video": "final.mp4",
  "cover": "cover.png",
  "subtitle": "captions.srt"
}
```

`video` takes the place of `images`. `cover` is optional; when supplied, the publisher uses the custom cover path. `subtitle` is an optional provenance file: it is fingerprinted with the package, while the video itself must already contain the intended subtitles. Steward does not render video or apply subtitle overlays.

Video publishing and custom-cover handling are included in the browser adapter. Tests cover their control flow; a successful live account upload is additional evidence. When a platform control cannot be resolved, inspect the saved attempt and current composer before changing tools.

## Add, authorize, and execute

```bash
xhs-ops ingest ./post.json
xhs-ops approve TASK_ID --authorization "Publish this prepared package" --now
xhs-ops run TASK_ID
xhs-ops show TASK_ID
xhs-ops plan --account personal
```

`ingest` returns the task ID. `approve` records the applicable user instruction and places the task in the queue. Existing authorization may cover a single package, a batch, or an established workflow. An assistant should use that scope directly; the command is an operational record, not a request for repeated conversational approval.

The controller checks the account identity and frozen media before execution. Concurrent CLI and MCP calls share the same task claim and account lock. A task with an unresolved platform outcome keeps that account from starting another write until the result is reconciled.

To record a future due time:

```bash
xhs-ops approve TASK_ID \
  --authorization "Publish this package at the agreed time" \
  --at 2026-12-01T10:00:00+08:00
```

Calling `xhs-ops run` executes the next eligible due task. It skips accounts or profiles held by unresolved attempts; `--account ALIAS` narrows selection. Due times are stored locally; arrange invocation through your chosen scheduler if scheduled execution is wanted. Installation creates no recurring tasks. Batch authorization, execution, pause and cancellation are described in [account operations](operations.md).

## Organization and media provenance

Content packages may carry local organization fields such as `seriesId`, `episode` and `contentType`. They help connect a prepared package to the account catalog. They do not add platform hashtags or create a Xiaohongshu collection.

Record separate originals and derivatives with an optional `mediaLineage` sidecar:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "source": "original/01.jpg",
      "derived": "images/01.jpg",
      "purpose": "exposure-correction",
      "tool": "local-editor",
      "parameters": { "exposure": 0.2 }
    }
  ]
}
```

Set `mediaLineage: "media-lineage.json"` in `post.json`, or supply the entries inline. Source and derivative hashes record the relationship; the final derivative must be selected by `images`, `video` or `cover`. Steward records this lineage and verifies files; it does not alter the media. For sharing-safe maps and documents, select the explicit public derivative as the upload file.

Platform declarations can be supplied as explicit booleans in `declarations`, for example `{ "original": true, "aiGenerated": false }`. A declaration records an intended field; adapter capability and the field result determine whether it was actually applied. Use the facts of the selected content, not a tool default, to choose these values.

## Edit an existing post

Use `kind: "edit"` and the exact existing platform note ID:

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "personal",
  "kind": "edit",
  "sourceNoteId": "000000000000000000000001",
  "title": "Revised title",
  "body": "The revised caption.",
  "topics": [],
  "images": []
}
```

The note ID above is synthetic; replace it with the result of the account inventory. An empty `images` array preserves the current images. Providing images requests replacement with those files in order.

To replace the finished video in an existing video note, include `video` in an `edit` package. The package must name the existing video note in `sourceNoteId`; Steward uploads the new file through the video editor's native file input, applies the approved title/body/native topics, and reads the same note ID back after saving. The update keeps the original note ID; platform review and distribution continue to follow the platform's rules.

When the package also includes `cover`, the creator UI may keep its cover
confirmation disabled until the replacement video has itself been saved.
Steward therefore saves the video and approved copy first, reads the saved video
from the same note ID, then selects and saves the custom cover. Each stage invokes
submission once. The cover-preview check defaults to 120 seconds and can be
changed with `--cover-timeout` (10-600 seconds) when the platform's processing
time differs. Final readback checks that the cover matches the selected resource
and differs from the cover saved before the cover stage. CDN host or signature
changes alone do not count as a resource change; this comparison does not compare
transformed image bytes.

For recovery or maintenance, `cover` may be supplied without `video` on an
existing video note. That path changes the approved copy, native topics and
custom cover in one save while leaving the already-saved video untouched.
The package must be an `edit` for an existing video note and cannot combine a
cover-only change with replacement images. Set `XHS_OPS_COVER_TIMEOUT` to an
integer from 10 to 600 when a slower platform preview needs a longer wait;
the default is 120 seconds.

The attempt retains stage and cover-selection evidence for read-only recovery if
the final adapter response is lost. If a stage stops, inspect `show`, `handoff` and
the same platform note, then reconcile it. A saved video with an unfinished cover
remains unresolved; starting the whole package again would upload the video again.
Complete that remaining stage against the same note and reconcile the original
task. Automatic verification needs the recorded selected-cover resource. If the
attempt stopped before that selection, its readback remains marked for review.
`prepare-only` stops before the first save and reports that the cover stage is
still pending.

```json
{
  "schemaVersion": 1,
  "platform": "xiaohongshu",
  "account": "education",
  "kind": "edit",
  "sourceNoteId": "000000000000000000000001",
  "title": "Revised title",
  "body": "The approved description.",
  "topics": ["Health education"],
  "video": "final.mp4",
  "cover": "cover.png"
}
```

If the platform does not expose a video file input for that note, Steward stops before submission. If the upload result is ambiguous, it retains the attempt and blocks another write until the same note is reconciled. A successful update does not imply that platform review or public visibility has completed.

Read a video through its video editor with `xhs-ops note NOTE_ID --account education --note-type video`
or `note_get` with `noteType: "video"`. Replacement verification requires the saved video resource
to differ from the pre-edit resource. A refreshed CDN signature on the same URL path or a matching
duration alone leaves the replacement unconfirmed. The task records file selection, prepared
metadata and saved readback when available; transformed platform bytes remain outside this comparison.

For a new edition that relates to an earlier post, include `replacesNoteId` in a publish package. This records the relationship locally. It does not delete the earlier post.

Read the current post first:

```bash
xhs-ops inventory --account personal --limit 30
xhs-ops note NOTE_ID --account personal
```

After editing, inspect the task's readback of that same ID. Use field evidence to assess the update; visibility, platform review, and audience response are separate observations.

## Interrupted tasks

Ordinary adapter calls replace the unsaved document in their own browser tab,
then close that exact tab after returning or failing. This avoids an interactive
departure prompt without touching user tabs.
`prepare-only` and explicit `--keep-tab true` preserve the page for inspection.
Tab cleanup does not clear an uncertain task outcome; reconcile the same note
before another write. User tabs and other sessions are outside the cleanup scope.

Read the task before taking another action:

```bash
xhs-ops show TASK_ID
xhs-ops reconcile TASK_ID
```

If the matching platform note is already known:

```bash
xhs-ops reconcile TASK_ID --note-id NOTE_ID
```

Reconciliation reads platform state and updates the local record; it does not submit another post. If the platform search and manual inspection establish that no submission exists, record that conclusion with its reason:

```bash
xhs-ops reconcile TASK_ID --absent --reason "Checked the account inventory and the saved attempt; no submission exists."
```

Only use the absence path after checking. A timeout by itself says nothing about whether the platform accepted the post. Re-authorize a cleared task for a new attempt only when the original requested scope still applies.

For an edit, `--absent` means that the requested update was not applied. Steward reads the
same note and compares its fields, native topics and media with the saved pre-edit snapshot.
An unchanged target can be cleared for a new authorized attempt after the operator has
inspected its composer. A missing baseline or a partially changed note remains unresolved.

A `verified` task means the fields required by the verifier matched the available platform readback. A submission with incomplete readback retains its explicit evidence gap. Media counts and presence do not prove that transformed platform files have the same bytes as the local source.

The controller passes its time budget to OpenCLI's browser command timeout, leaving a small
interval for the subprocess to report its result before the outer deadline. Adapter progress
is stored with the task where observed. On a timeout, reconcile the saved attempt and current
composer before resuming; elapsed time and a saved phase do not establish whether the platform
accepted the update or retained an upload. Use `handoff` for the exact state and `link-existing`
when a person completed publication. Neither operation submits another post.

## Maintain an account

```bash
xhs-ops collect --account personal --limit 30
xhs-ops audit --account personal --limit 30
xhs-ops report
```

Metrics and inspection candidates help decide what deserves attention. Collection appends observations; `metrics-history` retains the account, note and capture time for comparison. Keep content judgment with the author and assistant: understand what a post was sharing, improve the concrete issue, and preserve a mature series when its content already works. For photographs, retain the original and make requested exposure, white-balance, contrast or light sharpening adjustments as separate derivatives. [Account operations](operations.md) covers the catalog, incremental inspection policy, media lineage, metric history and backups.
