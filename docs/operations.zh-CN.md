# 账号运维

RedNote Steward 将任务执行、账号整理、结果恢复和本地观察保存在一个私有状态目录中。CLI 与 MCP Server 调用同一个 Controller，不各自创建队列。

## 队列与批次

自动运行器会选择计划时间已到、且账号与浏览器 profile 当前可写的任务。一个账号或 profile 有未解决的发布尝试时，只阻塞相关写入，不挡住其他可执行账号。多个账号共用一个本地队列时可以指定账号：

```bash
xhs-ops plan --account travel
xhs-ops run --account travel
```

为一组已准备好的内容指定批次，并限制一次执行数量：

```bash
xhs-ops ingest-batch ./posts/one/post.json ./posts/two/post.json --batch trip-2026-11
xhs-ops approve-batch trip-2026-11 --authorization "发布已确认的旅行批次" --now
xhs-ops run-batch trip-2026-11 --limit 4
xhs-ops plan --all
```

每篇内容仍有自己的冻结指纹、账号、尝试和结果。批次摘要不会隐藏失败或待核的单项。一次批次授权可覆盖其中已确认的内容；已有指令范围清楚时，不逐篇重复询问。

只取消尚未开始的任务。`running`、`submitted`、`needs_review` 应先核对结果，不能靠取消解除账号阻塞。暂停只阻止后续任务领取，不会终止正在运行的浏览器写入。

```bash
xhs-ops cancel TASK_ID --reason "内容在执行前撤回"
xhs-ops pause --account travel --reason "等待下一轮检查"
xhs-ops resume --account travel
```

## 进度与错误证据

任务事件会区分 Controller 选择、执行前检查、适配器活动、提交结果未知、平台接受和同笔记回读。适配器 phase 只表示观察到的浏览器步骤；它不能证明进程或标签页关闭后小红书仍保留已上传 composer。适配器退出码、错误码和错误消息会在可用时保存。

```bash
xhs-ops show TASK_ID
xhs-ops handoff TASK_ID
```

`handoff` 生成一份面向人工或另一个客户端的交接结果，包含冻结内容、媒体顺序、真实话题、最近阶段和下一步；它本身不授权再次写入。

若由人工完成了平台操作，可将原任务关联到现有笔记：

```bash
xhs-ops link-existing TASK_ID --note-id NOTE_ID --reason "已从准备好的编辑器中手动发布"
```

关联前会核对所选账号并读取指定笔记，再把平台 ID 和字段证据写回原任务；不会新建发布，也不会再次提交。结果不唯一或字段不符时会保留待核状态。人工说明和平台回读作为两类证据分别记录。

浏览器写入中断时，先读任务和账号状态：

```bash
xhs-ops reconcile TASK_ID
```

结果未知时，先回读再决定下一步。`prepared` 或 `uploading` 阶段记录本身不证明 composer 仍在浏览器中。只有观察到账号、内容指纹、媒体指纹相同且 composer 仍未提交，才能复用已上传内容；否则通过交接由操作者恢复，或在原尝试确认后重新准备。

## 账号目录与巡检

创作者笔记清单支持最高 1,000 条的有界读取；需要全量时显式传入足够大的 limit。`xhs-ops inventory` 返回 `total`、`returned`、`complete`、`truncated` 和 `requestedLimit`；`complete: false` 表示本次只读不完整，不能当作账号全量。底层适配器对未请求 metadata 的旧调用仍返回原始数组。

Catalog 是按稳定账号 ID 与平台 note ID 建立的本地投影。同步清单只更新平台观察字段，保留本地系列、来源和维护判断，也不会创建发布任务。

```bash
xhs-ops catalog sync --account travel --limit 100
xhs-ops catalog --account travel
xhs-ops catalog series --account travel --series city-notes --title "城市随记" --episodes 01,02,03
xhs-ops catalog set NOTE_ID --account travel --series city-notes --episode 01 \
  --content-type travel-photo --maintenance-status keep --reason "原来的现场发现已经成立"
```

可以将笔记关联到系列、集数、内容类型、素材路径或维护状态。系列用于组织连续内容，batch 用于组织一次操作，两者不同。Catalog 中的本地系列名不表示小红书平台有同名合集或排序能力。

巡检游标帮助按用户授权的时间范围做增量维护，但不会安排定期运行。每账号维护策略可以保存文风、话题和媒体偏好，不转换成自动质量分数或发布门禁。

```bash
xhs-ops catalog policy --account travel --file ./account-policy.json
xhs-ops catalog inspection --account travel --limit 6
xhs-ops catalog cursor --account travel --watermark 2026-11-01T00:00:00+08:00 --boundary NOTE_ID
```

策略 JSON 可以包含 `inspectionMode`（`off`、`manual`、`incremental`）、`preserveContentTypes` 与指向私有工作区指南的 `contextRefs`。游标只推进到实际检查过的范围；平台日期缺失时仍保留为未检查，不能补造日期。已经成立的短帖可以登记为 `keep`。

个人旅行账号从原帖发现了什么、分享了什么开始。短而成立的随手记可以原样保留；标题、正文或真实话题只在有具体收益时修改。已有文化、历史、商业分析应保留其证据和推理链。不要把每张照片扩成攻略或泛泛科普。成熟系列默认整理归类并保留；明确存在的重要问题再局部修正。

需要时再把照片处理成独立衍生件，保留原图并记录原片、衍生图和实际上传文件的关系。曝光、白平衡、对比和轻锐化应保持人物、地点、物品、食物、文字、天气与现场真实。地图或文档需要公开分享时，明确选择无个人信息的版本，不能只按修改时间挑最新文件。

医学视频使用已批准的成片和账号文案。归档、指标和发布管理不会授权增加临床结论或重做成片。医学账号保持按需发布；安装不会自动建立定时巡检。

## 指标历史

每次 `collect` 都追加一条观察，不覆盖之前的数据。记录绑定账号、笔记和采集时间；可以读取指定账号或笔记的历史：

```bash
xhs-ops collect --account travel --limit 30
xhs-ops metrics-history --account travel --note-id NOTE_ID --limit 10
```

缺失、不支持、采集失败与实际为 0 的值有区别。对比时结合对应的内容版本、发布时间和编辑时间。24–72 小时或 7 天变化只是观察，不能证明是某个标题、照片或编辑导致；指标不会自动改写帖子。

## 备份与恢复

备份应通过 SQLite 一致性备份机制生成；WAL 正在使用时只复制主数据库文件不是有效备份。恢复默认先预览，检查来源、目标、schema 及账号/任务计数后再用 `--apply`：

```bash
xhs-ops backup --out ./steward-backup
XHS_OPS_HOME="$HOME/.local/share/rednote-steward-restored" xhs-ops restore ./steward-backup
XHS_OPS_HOME="$HOME/.local/share/rednote-steward-restored" xhs-ops restore ./steward-backup --apply
```

恢复只写入空目标状态目录；预览和应用都要将 `XHS_OPS_HOME` 指向这个新目标。任务及已有证据会保留，但队列不会自动执行。迁移账号或素材到新机器时，先映射媒体路径并重新校验哈希。转移账号写入 owner，避免两个状态目录同时操作同一 UID 或 Chrome profile。

旧 xhs-ops SQLite 或 schema-3 JSON ledger 先预览再导入。多账号文件要明确选择 `source-account`；预览会校验媒体映射并返回 source digest。应用时必须使用该次预览的 digest 和明确的目标目录；历史任务保留历史状态，未决任务保留 `needs_review`，不会授权或发布：

```bash
xhs-ops import-legacy ./old-ledger.json --account travel
xhs-ops import-legacy ./old-ledger.json --account travel --target "$HOME/.local/share/rednote-steward-migrated" \
  --expected-digest SOURCE_DIGEST --apply
```

导入后先核对未决历史任务，再对当前 `post.json` 执行 inspect，不能直接把旧指纹或旧素材路径当成新的发布包。`xhs-ops media-info FILE --ffprobe` 可读取确定性媒体元数据；没有 ffprobe 时会明确报告 unavailable，不代表文件已经解码或平台接受。

## 新机器验收

`xhs-ops doctor --json` 显示可获得的安装包与源码版本、状态目录和 schema、OpenCLI/Browser Bridge 版本、Chrome profile、账号身份检查及逐项能力证据。`supported` 表示该环境实际测过该能力；`unknown` 表示尚未资格验证。命令存在或 MCP 进程运行都不能单独证明账号已登录或具备发布能力。需要分享诊断结果时使用 `doctor --redact`，它会去掉私有路径、UID、profile 和原始错误。

OpenCLI、Browser Bridge 和账号能力随 release manifest 记录。升级后先运行 doctor，并在第一次写入前完成相关只读账号检查。图文、视频、封面、原生话题和旧帖编辑的真实验收，应与单元测试和安装结果分别记录。

账号迁移使用精确的旧状态目录和理由。先用 `account status` 检查 owner，确认旧目录可读且没有未决任务或活动 lease，再使用 `account takeover`；不能从目录不存在或状态含糊推断可以接管。

升级固定浏览器运行时前，先对真实账号和后端做只读资格检查并比较结果。资格检查不会发布测试内容：

```bash
xhs-ops qualify --account travel --backend-label bundled --repeats 3
xhs-ops compare-qualifications ./qualification-a.json ./qualification-b.json
```


## 历史封面证据与任务替代

旧视频编辑缺少封面选择事件时，应保留“事件缺失”的事实。先下载同一笔记当前回读的封面，再生成绑定到任务的内容回执：

```bash
xhs-ops cover-evidence TASK_ID --note-id NOTE_ID --platform-cover ./saved-cover.jpg --output ./cover-evidence.json
xhs-ops link-existing TASK_ID --note-id NOTE_ID --reason "核实历史保存封面" --cover-evidence ./cover-evidence.json
```

两条命令均沿既有浏览器 profile 核对稳定账号。read-note 适配器在该浏览器上下文读取当前封面摘要，只接受平台 HTTPS 域，限制 20 MiB 和 30 秒；本地保存的平台封面必须与这些字节相同。工具重算冻结封面哈希、任务指纹、账号、笔记、当前 URL 和图像相似度。字节一致可直接通过；转码图片需宽高比兼容，固定归一化后 SSIM 至少为 0.995，并需本机具备 ffmpeg、ffprobe。工具缺失、下载失败、绑定过期或低分均保持未解决。回执保留在私有本地，不证明平台审核或公开可见，也不会伪造点击和提交历史。

对于确实由新记录取代的历史重复任务，可执行 `xhs-ops supersede OLD_TASK --replacement-task VERIFIED_TASK --reason "当前记录取代导入的旧任务"`。替代任务必须已核验通过，并指向同一稳定账号、浏览器 profile 与精确笔记；再次只读核对时，平台内容仍须与其已保存回读一致，两个任务均不能存在活跃写入者。superseded 保留原任务未通过的核验和替代关系，只解除这条历史责任，不把它改成 verified，也不授权重试。没有原始 note ID 的未知发布仍保持未解决。CLI 与 MCP 共用相同控制器和账号锁。
