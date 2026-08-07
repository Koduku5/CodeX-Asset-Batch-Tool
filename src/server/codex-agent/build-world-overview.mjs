import { skillRoutedPrompt } from './common-prompt.mjs';

export const worldOverviewPrompt = (pipelineSkillPath) => `${skillRoutedPrompt(pipelineSkillPath)}

本次唯一动作：完成全剧世界观分页总览并正式 finalize。
- 只有全部 discoveredEpisodes 已完成并通过规范前置检查时才可继续，否则立即失败。
- 严格从 offset=0 开始，每批 40 条，按脚本返回的 nextOffset 逐页处理；不得一次性读取完整事实库。
- 每页在当前上下文中把事实归并进紧凑草稿，全部分页完成后按软件级 ka-script-pipeline Skill 的依赖关系重组并执行质量门。
- 不得直接修改世界观总览文件，不得运行正式 finalize 脚本；把最终正文原样填入结构化回执的 worldOverview 字段，固定 worker 会负责原子提交与 finalize。
- 不得构建 Excel、出图队列或图片。
- processedCount 填本次成功合并的分页批次数；已存在且指纹一致的正式完成结果可填 0。`;
