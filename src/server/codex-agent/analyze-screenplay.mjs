import { COMMON_PROMPT } from './common-prompt.mjs';

export const analysisPrompt = ({ episode, episodeFile, episodeSkillPath }) => `${COMMON_PROMPT}

在做任何事之前，先从头到尾完整读取软件级单集分析规范 ${episodeSkillPath}。该文件是本动作唯一允许读取的 Skill；不得读取 ka-script-pipeline、其他 Skill 或 reference。该 Skill 只读，绝对不得修改。

本次唯一动作：只完成第 ${episode} 集的语义分析。
- 第 ${episode} 集必须是 discoveredEpisodes 中首个未完成集；只读取当前单集原文 ./${episodeFile}，禁止读取、预分析或概括其他集原文。
- 固定 worker 已在启动本次 SDK turn 前完成 start 或显式 resume；你不得再次执行 update_analysis_progress.mjs，不得读取它或其他生产脚本的源码。
- 在 Windows restricted language 环境读取允许的 JSON 文件时，只使用基础文件读取能力或“Get-Content -Raw -Encoding UTF8 -LiteralPath <相对路径>”；禁止调用 [System.IO.File]、New-Object 或其他 .NET 方法读取文件。
- 只执行语义分析：读取当前单集、世界观事实，并仅用“powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/commands/python.ps1 scripts/pipeline/query_asset_records.py . query <候选名称...>”查询旧资产记录；禁止改用 --project-root，禁止省略 query，禁止用 --help 试探命令，禁止枚举完整 Cache 或读取五类累计资产全集。
- 禁止修改、创建或删除任何项目文件，禁止调用 apply_patch、sync_episode_analysis.py 或 complete；固定 worker 会校验 analysis 后原子写入、同步累计记录并标记完成。
- 按读取的单集分析 Skill 完成语义判断，并只返回本次调用提供的 output schema；禁止把嵌套对象编码成 JSON 字符串。
- 生成 analysis 后立即停止，不得开始下一集，不得生成世界观总览、Excel、出图队列或图片。
- processedCount 只能填 1；完成本集语义分析并生成合规 analysis 时 completed=true。`;
