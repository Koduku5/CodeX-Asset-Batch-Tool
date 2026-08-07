# 资产记录与合并协议

## 目录

- [来源与进度](#来源与进度)
- [单集分析](#单集分析)
- [累计资产记录](#累计资产记录)
- [世界观原子事实库](#世界观原子事实库)
- [全剧世界观总览](#全剧世界观总览)
- [待确认](#待确认)
- [锁、事务与校验凭证](#锁事务与校验凭证)
- [查询与合并](#查询与合并)

## 来源与进度

`阅读进度.json` 的 `sourceManifest` 保存每个剧本文件的 `name`、`size`、`sha256`；`episodeManifest` 保存每个 `单集原文/第NNN集.json` 的集数和 canonical JSON SHA-256。开始、同步、完成和最终校验都会复核两层指纹，防止源文件未变但切分 Cache 被误改。来源变化必须先重置，禁止把不同剧或同名改稿继续写入旧 Cache。`pipelineStartedAt` 由脚本记录本轮流水线的开始时间，供进度窗口计算总耗时；Agent 不手填。

阅读进度只能由脚本更新。Agent 不手动改写，也不得跳过 `start → 保存单集分析 → sync → complete`。`start` 把当前分析会话令牌写入 `currentSessionToken`；`sync` 与 `complete` 必须同时核对阅读进度和持久分析锁中的令牌。中断后只有显式 `start <集数> --resume` 才能轮换令牌；完成时 `currentSessionToken` 与 `currentResumedAt` 都恢复为 `null`。

旧 Cache 缺少 `episodeManifest` 时可重新运行切分脚本：只有现存原文与新切分逐集同指纹，且所有已完成分析都已经包含角色、生物、群演、场景、道具五类数组，脚本才保留完成进度并补齐指纹。旧四类分析不能安全推断“没有生物”，原文或结构不一致时必须先备份并重置后重新分析。

## 单集分析

每集只保存本集世界观增量、本集新增或修订后的完整资产记录，以及重要排除判断：

```json
{
  "source": "剧本.docx",
  "episode": 1,
  "scriptAnalysis": [
    {"item": "<原子设定名称>", "content": "<剧本明确且可跨情节复用的硬设定>"}
  ],
  "assets": {
    "characters": [],
    "creatures": [],
    "extras": [],
    "scenes": [],
    "props": []
  },
  "exclusions": [
    {"item": "未登记对象", "reason": "排除理由"}
  ]
}
```

`scriptAnalysis` 每项只允许 `item` 和 `content`，并完整遵守 [worldbuilding-analysis.md](worldbuilding-analysis.md)。新记录的 `item` 必须写成 `具体锚点｜规则维度`；为读取旧 Cache，校验器仍接受不含分隔符但本身是具体专名的旧 `item`，后续修订时应迁移到新格式。`content` 必须是可独立理解的完整命题，保留原文已有的条件、边界、代价、后果和阶段信息。只登记剧本明确、稳定且可跨情节复用的世界观硬设定，不写 `basis`、题材标签、剧情流水、主题评价、类型常识、短期信息或资产设计推演。五个 `assets` 数组中的每一项都使用下方累计记录的完整对象。新资产首次保存时不写 `assetId`，同步脚本会按类别和首次制作顺序自动编号并原子回写；更新旧资产时必须沿用查询结果中的 `assetId` 和规范 `assetName`。不得复制未变化的全部旧资产；`scriptAnalysis` 只写本集新增或修订项。

单集允许没有新增的稳定世界观事实，`scriptAnalysis` 可以是空数组；也允许没有新增或修订资产，五类 `assets` 数组可以同时为空。不得为了填满字段虚构事实或资产。该宽容只适用于单集增量：全项目交付仍必须至少包含一条稳定世界观事实和一项角色、生物、群演、场景或道具资产。

## 累计资产记录

角色、生物与群演：

```json
{
  "assetId": "CHAR-001-EP1",
  "assetName": "角色甲（初始造型）",
  "productionNotes": "脱离剧本上下文仍完整成立的资产专属视觉定义",
  "faction": "组织A｜部门B（身份）",
  "scriptSetting": "剧本明确事实。其余信息剧本未标明。",
  "inferenceBasis": "世界观、环境、功能和身份如何导向最终设计",
  "aliases": ["剧中称呼"],
  "firstRequiredEpisode": 1,
  "firstRequiredOrder": 1
}
```

场景与道具使用相同字段，但省略 `faction`。

- `assetName` 在所属类别内唯一；角色、生物与群演之间也不得重名。
- 五类数组表示制作路线：`characters` 保存以人形单体外表与穿搭为主的资产，`creatures` 保存以非人解剖单体或物种标准为主的资产，`extras` 保存不分物种或材料的可互换群体体系，`scenes` 保存空间环境，`props` 保存独立物件、服装、载具和机械主体。剧情身份、姓名或台词不直接决定数组；具体判断遵守 [asset-rules.md](asset-rules.md)。
- `assetId` 在全部资产中唯一，格式为“类别前缀-顺序号-首次实际制作集数”：角色 `CHAR`、生物 `CREATURE`、群演 `CROWD`、场景 `SCENE`、道具 `PROP`，例如 `CHAR-001-EP1`、`CREATURE-001-EP1`。
- 顺序号在五个类别内分别递增；`EP` 必须等于 `firstRequiredEpisode`。新资产由脚本编号，旧资产更新时禁止改号。
- `aliases` 只保存用于跨集归并的明确称呼，不输出 Excel。
- `firstRequiredEpisode` 是首次实际需要制作的集数。
- `firstRequiredOrder` 是该 Sheet 在该集内的首次实际需求顺序；同 Sheet、同集不得重号。
- 不使用优先级或出现位置字段；世界观不使用资产 ID。
- 后文补充该形态从一开始就存在的信息时更新原记录；剧情造成的新状态只要旧参考图无法稳定复现就建立新形态，不以持续时间长短为标准。跨制作路线的新形态使用不同的完整 `assetName`，不得把同一个完整名称复制到多个数组。

## 世界观原子事实库

`cache/累计记录/世界观记录.json` 保存逐集原子合并的事实：

```json
{
  "records": [
    {"item": "<具体锚点｜规则维度>", "content": "<包含适用边界与结构性后果的完整硬设定>"}
  ]
}
```

每项只允许 `item` 和 `content`，不使用 `basis`；五类资产仍以 `inferenceBasis` 保存各自的设计推演依据。一个 `item` 只代表一个稳定语义命题；同名更新必须提交全量整合版 `content`，保留旧记录中仍然有效的信息，阶段性变化必须保留时间边界。不同规则维度另建条目，字面不同但语义相同的事实归并到首次建立的规范 `item`。该文件是供跨集归并、校验和资产设计使用的精确事实库，不直接逐条导出 Excel。

## 全剧世界观总览

`cache/世界观总览.json` 是从完整原子事实库分页归纳出的派生草稿，重置后的固定结构为：

```json
{
  "content": ""
}
```

全部单集完成后，用 `page_world_records.py` 从偏移量 `0` 开始每批固定读取 40 条事实，并把当前批次持续归纳进这个紧凑 `content` 草稿；不得一次性加载完整事实库。`offset=0` 会建立或重开分页会话，后续调用的 `offset` 必须严格等于上次返回的 `nextOffset`。事实库在分页期间发生任何变化，旧会话立即失效，必须从 `offset=0` 重开。

每次成功分页都会原子更新 `cache/世界观分页进度.json`：

```json
{
  "factsFingerprint": "<64位小写 SHA-256>",
  "totalRecords": 87,
  "pageSize": 40,
  "coveredOffsets": [0, 40, 80],
  "nextOffset": null,
  "complete": true
}
```

`factsFingerprint` 是对当前完整对象 `{"records":[...]}` 做 UTF-8 canonical JSON 后计算的 SHA-256；canonical JSON 使用键名排序、无多余空白、保留 Unicode 字符。`coveredOffsets` 必须精确等于 `0, 40, 80...` 直到覆盖全部事实，不得缺页、重复或跳页。`coverageFingerprint` 使用相同算法对上述完整分页凭证对象计算。

所有批次处理完毕后，只读取小型草稿并统一润色，再运行 `finalize_world_overview.py`。提交脚本只接受与当前事实库完全一致且完整覆盖的分页凭证，并把总览原子升级为 version 2：

```json
{
  "version": 2,
  "content": "<完整、连贯、自洽的全剧世界观说明>",
  "factsFingerprint": "<当前事实库 SHA-256>",
  "coverageFingerprint": "<完整分页凭证 SHA-256>",
  "finalizedAt": "<带时区的 ISO 时间>"
}
```

缺少任何一页、事实数量或内容变化、分页凭证被改写、总览元数据与当前事实库不一致，均不得 finalize 或交付。

总览完整遵守 [worldbuilding-analysis.md](worldbuilding-analysis.md)。主题、顺序和段落结构由当前剧本的因果依赖动态决定，不预设必填栏目；正文可换段或列举规则，但必须是一篇完整、连贯、自洽的全剧世界说明。首句直接给出最具区分度的根事实，后续说明机制、边界与结构性后果；禁止题材套话、逐集剧情、设定清单、分析过程和制作术语，也不收录只在局部情节有效的短期状态、数值、资源或策略信息。

Excel `剧本解析` 只导出一行：`世界观总览｜<content>`，绝不展开原子事实库的 `records`。

## 待确认

名称或别名身份冲突由 `sync_episode_analysis.py` 自动写成完整暂存记录：

```json
[
  {
    "pendingId": "PENDING-CHAR-0123456789abcdef",
    "episode": 30,
    "observedEpisodes": [30],
    "candidate": "《那时的我们》项目赵总",
    "proposedCategory": "characters",
    "firstRequiredEpisode": 30,
    "firstRequiredOrder": 4,
    "draftAsset": {
      "assetName": "《那时的我们》项目赵总",
      "aliases": ["赵总"],
      "faction": "项目组｜管理层",
      "scriptSetting": "第30集主持项目会议，剧本未给出本名。",
      "firstRequiredEpisode": 30,
      "firstRequiredOrder": 4,
      "productionNotes": null,
      "inferenceBasis": null
    },
    "conflicts": [
      {
        "category": "characters",
        "assetId": "CHAR-001-EP1",
        "assetName": "赵媛",
        "sharedValue": "赵总"
      }
    ],
    "assetIds": [],
    "assetNames": [],
    "issue": "称呼与已有资产重合，无法自动判断是否同一人",
    "impact": "影响资产归并、独立建档与别名唯一性",
    "status": "pending"
  }
]
```

脚本生成稳定 `pendingId` 并保留完整 `draftAsset`、来源顺序和结构化 `conflicts`。冲突候选不会写入累计资产，但当前集的其他事实与资产仍正常同步，后续集也继续分析。

全部单集分析和世界观总览完成后，软件在视觉规格、Excel 与出图队列之前打开人工确认窗口。每项只能选择 `independent`、`merge` 或 `exclude`；前两者必须提交人工核定的完整最终事实记录，合并还必须绑定一个正式 `targetAssetId`。前 N-1 项决定只暂存，最后一项触发 `resolve_pending_asset.py` 一次性应用全部决定、更新单集结构化引用、按首次需求顺序紧凑整理资产 ID，并写入 `cache/资产编号沿革.json`。该过程完全由固定脚本执行，不重新调用模型。

旧协议兼容记录若已经绑定累计资产，其归并或拆分关系不明确时使用精确资产引用：

```json
[
  {
    "episode": 8,
    "candidate": "身份未明人物",
    "assetIds": ["CHAR-012-EP3"],
    "assetNames": ["身份未明人物（初始造型）"],
    "issue": "无法确认是否与已有角色为同一人",
    "impact": "影响归并与形态拆分",
    "status": "pending"
  }
]
```

绑定已有资产的 `pending` 以 `assetIds` 作为精确路由依据，`assetNames` 供人阅读；两者应指向同一批累计资产。兼容旧 Cache 时可以只有 `assetNames`，但名称必须存在且只能唯一命中一个资产；同名或多形态歧义必须补充 `assetIds`。除 candidate-only 使用两个空数组外，非空引用必须命中累计资产。`pending` 状态不要求 `resolution`。处理完成后必须把状态改为 `resolved`，并填写非空字符串 `resolution` 记录最终结论，例如：

```json
{
  "episode": 8,
  "candidate": "身份未明人物",
  "assetIds": ["CHAR-012-EP3"],
  "assetNames": ["身份未明人物（初始造型）"],
  "issue": "无法确认是否与已有角色为同一人",
  "impact": "影响归并与形态拆分",
  "status": "resolved",
  "resolution": "已确认与 CHAR-012-EP3 为同一角色，沿用原资产记录。"
}
```

`resolved` 而没有明确 `resolution` 属于未完成处理；含 `draftAsset` 但没有 `appliedAt` 的记录也仍是阻断项。所有决定正式应用前，不得生成视觉规格、Excel 或出图队列。

## 锁、事务与校验凭证

`.pipeline.lock` 使用协议版本 2，并记录 `leaseMode`、随机令牌、进程 ID、进程启动时间和主机名。短命令使用 `transient`：只有进程已经死亡或 PID 身份不符时才可自动隔离陈旧锁。跨命令的单集分析、内置出图和 API 批次使用 `durable`，必须走各自的显式恢复流程。`.pipeline.operation.lock` 只保护单次 `start`、`sync` 或 `complete` 写操作。不得手工删除或伪造这些锁。

切分或单集同步需要同时提交多个 Cache 文件时，脚本先在 `.pipeline-transactions/` 保存修改前后副本和 SHA-256，再以 `.pipeline.transaction.json` 记录提交阶段。进程异常结束后，下一次同类写操作只在确认旧进程已停止后自动完成清理或按修改前副本回滚；任何目标、暂存路径或链接越出 Cache 都必须拒绝。正常完成后这两个隐藏项不存在。

`validate_asset_records.py` 成功后原子写入 `.validation_receipt.json`，其中保存本次验证覆盖的剧本来源、单集原文、单集分析、累计记录、世界观凭证、总览和待确认记录的文件集合及指纹。`build_workbook.mjs` 只接受与当前文件集合完全一致的有效凭证，并在提交 Excel 前再次复核。任何输入变化都会使旧凭证失效，必须重新校验。

Excel 交付中的每个单元格最多 32,767 个字符。工作簿生成器对累计记录、世界观总览及从旧工作簿保留的人工协作值统一执行文本安全处理：疑似公式前缀不会作为公式写入，XML 1.0 禁止的控制字符会替换为安全字符。重建只按 `Sheet + assetId` 保留固定人工列；旧工作簿字段异常、额外列或重复 ID 时拒绝覆盖，替换前必须在 `备份/` 写入并校验原工作簿副本。

## 查询与合并

1. 先从本集提取候选名称，再调用 `query ...` 获取命中的完整旧记录。
2. 只有归并歧义时才调用 `index` 查看轻量名称与别名索引。
3. 保存单集分析。
4. 用 `sync_episode_analysis.py` 原子 upsert 世界观事实和五类资产；名称或别名发生身份冲突时，脚本自动暂存冲突候选并继续同步本集其他内容。
5. 用 `update_analysis_progress.mjs ... complete` 核验同步结果后完成本集。
6. 全剧完成后分页归纳并 finalize `世界观总览.json`。
7. 若存在待确认项，由软件窗口逐项提交决定；最后一项由固定脚本统一正式纳入并整理 ID。
8. 运行视觉规格回填、`validate_asset_records.py`，再构建 Excel。
