# Content package examples

These examples use a local alias named `demo` and synthetic content. Bind your own account and copy the package into your own workspace before using it.

- [Image post](image-post/post.json): includes an original sample illustration, local series metadata, and [media lineage](image-post/media-lineage.json) linking its SVG source to the PNG upload. `xhs-ops inspect examples/image-post` can run immediately.
- [Video post](video-post/post.json): a template for your own `final.mp4`, `cover.png`, and `captions.srt`. Add those files before inspection; video media is not included.

Topic arrays are intentionally empty. Select topic names relevant to your content and confirm their availability through the platform's candidates.

`seriesId`, `episode` and `contentType` are local organization fields. `mediaLineage` can be a sidecar path or an inline entry array; each source and derivative is hashed, and the chain must lead to a selected upload file. The example is synthetic. Keep real account bindings, source photographs, medical videos and publication records in your own private workspace.
