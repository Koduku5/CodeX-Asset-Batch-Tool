# 内置 image_gen 字段契约

## 权威来源

`assets/图片生成/prompts/` 是提示词注册表的权威来源：片段文件保存提示词文字，基础路由只声明匹配条件与组合顺序，条件修饰器只声明满足额外条件后允许执行的受限追加操作。`scripts/lib/prompt_catalog.mjs` 统一校验并解析注册表；同一输入必须且只能命中一条基础路由，缺少路由或多条路由同时命中都必须停止。

`assets/图片生成/内置imagegen字段.json` 是由注册表保持兼容的基础字段编译产物，不再单独承载另一套路由判断。三种制作风格、五个 Excel Sheet 的活动字段上限骨架为：

`Use case` → `Input images` → `Asset type` → `Primary request` → `Scene/backdrop` → `Style/medium` → `Composition/framing` → `Lighting/mood` → `Color/tonality` → `Materials/textures` → `Constraints` → `Avoid`

基础路由按参考图状态固定结构：无参考图时使用不含 `Input images` 的 11 字段普通骨架；存在参考图时才使用上述 12 字段骨架。每种活动模式的字段名、数量和顺序固定，批次配置只允许修改冒号后的字段值，不能删除、改名、新增、重复或重排字段。条件修饰器只能在基础路由编译完成后运行，且只能修改自身声明的字段白名单。

## 路由规则

- 没有有效参考图时，`Use case` 固定为 `stylized-concept`，活动路由不显示也不保存 `Input images`，`Primary request` 使用当前制作风格与资产类别的固定模板，参考用途上拉框禁用。
- 存在有效参考图时，参考用途上拉框启用，并显式选择以下三种模式。三种模式只覆盖各自声明的 `Use case`、`Input images` 和 `Primary request`；其余九个字段继续使用当前制作风格与资产类别路由。
- `风格参考`：`Use case=style-transfer`。`Input images` 只按实际数量声明图片角色，固定写成 `Image 1 is a style-only reference.` 或 `Images 1–N are style-only references.`，不得在该字段写入分析、迁移、保留或禁止复制等任务要求。`Primary request` 先保留资产路由模板，再追加“分析参考图并仅迁移其风格”以及“不得复制参考图具体内容”的完整任务要求。`Use case`、`Input images` 和 `Primary request` 均属于该参考模式的受管字段，领取任务时必须从当前定义和实际图片数量重新规范化，不能沿用缺少上述要求的旧批次文本。调用前由 Agent 查看全部参考图，把 `【由 Agent 分析参考图并填写共同风格】` 替换为共同风格描述。
- `视觉风格统一`：至少需要两张图片，列表第一张为图像 1 主风格基准，图像 2～N 为待统一素材。`Use case` 固定为 `style-transfer/cross-asset-style-unification`；`Input images` 固定说明图像顺序；`Primary request` 固定要求把图像 2～N 统一为图像 1 的视觉语言，迁移配色、对比度、纹理、边缘、细节密度和渲染方式，同时保留每张素材的主体、构图、文字和功能。少于两张图片时状态为 `insufficient_reference_images`，不得领取任务。
- `自定义`：`Use case` 显示“根据 Primary request 的内容由 ImageGen 自行判断填入”；`Input images` 按实际图片数量载入可编辑的 `图像 1：`、`图像 2：` 模板，`Primary request` 载入独立待填写提示。用户必须填写这两个字段并删除中文提示；任一字段为空或仍含提示时状态为 `custom_fields_required`，不得领取任务。调用前由执行 Agent 根据用户填写的 `Primary request` 判断并替换 `Use case` 的指令值。
- `Asset type` 输出专业资产类型；`Primary request`、`Scene/backdrop` 和 `Composition/framing` 使用同一次内部资产类别判断联动生成。角色使用人形单体路线，生物使用非人解剖单体或物种标准路线，群演使用不分物种或材料的 `background character concept design` 群体候选路线；具体映射见 `references/asset-type-rules.md`。
- 生物构图固定展示同一生物资产的五个不同可选外观变体，供用户从中选型；群演构图固定展示同一群体体系中五个可共存、可互换的成员变体。两者都使用单行五列，但候选语义不得混淆。
- `Style/medium` 按二次元、CG、真人三种制作风格映射。真人当前保留待填写占位，未填写前对应路由不得领取任务。
- `Lighting/mood`、`Color/tonality`、`Materials/textures`、`Constraints`、`Avoid` 由 Agent 逐项读取当前资产的 Excel“制作说明”后填写；没有原文依据时留空，不得把模板占位文字发送给 image_gen。
- 场景的 `Scene/backdrop` 同样由 Agent 根据制作说明填写地点、环境、时代、时间和天气。

## 统一的基础路由与条件分支

二次元、CG、真人的角色、生物、群演、场景和道具全部使用同一条解析链：先按制作风格、资产类别和参考图方式命中唯一基础路由，再由 Agent 根据当前资产的完整“制作说明”，从正式条件分支注册表中选择零个或多个适用分支，最后按注册表声明的操作修改对应基础字段。

CG 场景没有专属卡片、专属环境枚举、专属增强器或独立预览协议。树林、山体、高速公路等场景细分和科技、复古等其他资产细分，都必须作为普通可编辑条件分支注册；其匹配条件、适用风格、资产类别、参考图方式、字段操作和测试样例与其他分支使用相同 schema、校验、指纹和队列字段。

Agent 只能从当前资产上下文允许的候选分支中选择，并遵守同一分组冲突规则；没有充分依据时不选。最终 Prompt 始终只包含当前参考图模式对应的 11 或 12 个基础字段，不包含分支内部编号、判断理由或文件名。

## 当前状态

| 风格 | 角色 | 生物 | 群演 | 场景 | 道具 |
|---|---|---|---|---|---|
| 二次元 | 已配置 | 已配置 | 已配置 | 已配置 | 已配置 |
| CG | 已配置 | 已配置 | 已配置 | 已配置 | 已配置 |
| 真人 | 待填写 `Style/medium` | 待填写 `Style/medium` | 待填写 `Style/medium` | 待填写 `Style/medium` | 待填写 `Style/medium` |

真人路由同样按无图 11 字段、有图 12 字段切换；`placeholder` 只表示真人 `Style/medium` 尚未填写，不表示该路由没有字段契约。用户在当前批次填写有效真人风格内容并移除占位文字后，该路由可按自定义配置执行。

## 变更协议

修改固定字段或默认模板时，必须同时更新提示词注册表、编译兼容产物、窗口校验、运行时校验、本文档、`SKILL.md` 和 `tests/builtin-prompt-field-contract.test.mjs`，并通过注册表校验、Node 回归测试和 UI 冒烟测试。命中基础路由或实际使用片段的语义指纹变化后，对应批次必须重新确认，不能静默沿用旧模板。新增或修改细分逻辑时只允许使用普通条件分支，不得为某一风格或资产类别另建旁路协议。
