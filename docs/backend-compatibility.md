# Backend Qualification

RedNote Steward keeps OpenCLI/Chrome as its primary publishing backend. A qualification run checks the bound account identity and creator inventory using a bounded number of read-only requests. It records local build and browser health alongside per-request timings, successes and failures.

```bash
xhs-ops qualify --account personal --backend-label bundled --repeats 3 --limit 30
xhs-ops compare-qualifications /absolute/path/to/bundled-receipt.json /absolute/path/to/candidate-receipt.json
```

Receipts live under `$XHS_OPS_HOME/qualification/` with private file permissions. They retain account/profile hashes, versions, timings, counts and statuses. They exclude titles, bodies, raw inventory, cookies, media and raw error messages. If the current identity does not match the binding, the inventory probe is skipped.

A comparison displays account, source revision, runtime, profile, limit and repeat-count differences. It marks latency as comparable only when those dimensions match and the read probes succeeded. Different observed CLI/daemon/Bridge versions remain visible as the backend variable being examined. Intervention count, recovery time and duplicate submissions stay `unknown` until separately measured. Read success leaves image/video publishing, custom covers, old-post editing, native topics and declarations `unknown`.

| Backend combination | Current evidence | Qualification needed before adopting |
| --- | --- | --- |
| Bundled OpenCLI 1.8.5 + Browser Bridge 1.0.26 | Pinned runtime and local adapter tests; new-machine and account results are recorded separately | Identity/inventory roundtrip on the intended profile; separate authorized media/edit/cover readback |
| OpenCLI 2.0.3 + Browser Bridge 1.0.27 | Source review, including daemon-version coexistence repair | Bundled/global coexistence, reconnect/restart and each required publishing operation |
| xiaohongshu-mcp 2.7.3 | Candidate source review; different login and capability surface | Fresh identity, native topics, video/cover/editing and same-note readback for each required capability |

The comparison command does not install or upgrade a backend. An alternate binary can be selected explicitly with `XHS_OPS_OPENCLI_BIN`; the caller is responsible for selecting a read-compatible executable and recording its version. No failure during an unresolved write triggers a backend switch or another submission. The installed Browser Bridge version in a build manifest describes a configured dependency; an absent observed version remains unknown.

For platform writes, use an already authorized fixture or prepared release and record the result through the existing task/receipt owner. Submission, saved fields, moderation and audience results remain separate observations.
