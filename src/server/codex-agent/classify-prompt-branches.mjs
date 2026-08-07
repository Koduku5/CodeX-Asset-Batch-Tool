import { skillRoutedPrompt } from './common-prompt.mjs';

export const classificationPrompt = (pipelineSkillPath) => `${skillRoutedPrompt(pipelineSkillPath)}

本次唯一动作：根据当前累计资产的正式 productionNotes 和已注册 conditionModules 完成提示词分支语义分类。
- 禁止调用 image_gen，禁止领取内置任务，禁止修改出图进度、输出图片、Prompt Catalog、分支注册表或任何项目文件。
- 固定 worker 会先运行正式建队脚本生成基础候选，再把每页只读分类请求放入它指定的项目内相对路径；你只能读取该请求并返回结构化选择。
- 每个 queue key 必须返回一次。只能从该项 candidates 中选择；同一 family 最多选择一个，按 definition、controlDimensions 与 tieBreak 基于 productionNotes 判断。
- noDefault=true 时，没有充分依据必须不选；不得按分支名关键词、资产名猜测或任意兜底。
- 固定 worker 会校验候选 ID、scope、family 冲突、Catalog/注册表指纹与 queue key 一一对应关系，再原子写入 cache/提示词分支匹配.json，并通过正式建队脚本重建最终队列。`;

export const classificationPagePrompt = (page, pipelineSkillPath) => `${classificationPrompt(pipelineSkillPath)}

当前只读分类请求：./${page.relativeRequestPath}
- 完整读取这个 JSON，但不要读取其他页，不要把制作说明或候选内容复制到最终 summary。
- assignments 必须与请求 items 一一对应且 key 不重不漏；selectedConditionModuleIds 只能来自该项 candidates。
- 只返回 output schema 要求的 JSON；本页 completed 表示分类判断已完整返回，不表示你写入了任何文件。`;
