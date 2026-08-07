# Prompt Catalog 架构

## 统一执行模型

三种制作风格、五类资产全部使用同一条链路：

`风格 + 资产类型 + 参考图方式 → 唯一基础路由 → 普通条件分支 → 字段绑定 → 最终 Prompt`

任何风格或资产类别都不得拥有独立的卡片、枚举、增强器、Agent 回执或队列旁路。树林、山体、高速公路、科技、复古等细分需求统一注册为条件分支。

## 唯一事实源

`assets/图片生成/prompts/` 是正式提示词注册表：

| 内容 | 路径 | 职责 |
|---|---|---|
| Catalog | `catalog.json` | 枚举、字段 schema、编译阶段和子文件路径 |
| 公共/风格/资产片段 | `fragments/` | 组成基础字段文字 |
| 基础路由 | `routes/builtin.json` | 3 种风格 × 5 类资产的 15 条唯一基础路由 |
| 参考图修饰器 | `modifiers/reference-mode.json` | 切换无图 11 字段与有图 12 字段 |
| 条件分支注册表 | `modifiers/condition-modules-v1.json` | 保存全部可维护的细分路由及字段操作 |
| API 默认模板 | `fragments/api/default-templates.json` | 普通 API 出图模板 |

`assets/图片生成/内置imagegen字段.json` 只是由注册表编译的兼容产物，不得承载第二套判断逻辑。

## 解析入口

代码入口：

```js
const loaded = await loadPromptCatalog(catalogPath);
const result = resolvePromptTemplate(loaded, {
  style,
  asset,
  referenceMode,
  referenceCount,
  productionNotes,
  selectedConditionModuleIds
});
```

CLI 入口：

```text
prompt_catalog_cli.mjs validate
prompt_catalog_cli.mjs compile-legacy --check
prompt_catalog_cli.mjs resolve-template --style <style> --asset <asset> [--reference-mode <mode>] [--reference-count <n>] [--production-notes <text>]
prompt_catalog_cli.mjs route-fingerprint --style <style> --asset <asset> [--reference-mode <mode>] [--reference-count <n>]
prompt_catalog_cli.mjs api-defaults
```

服务端 `/api/prompt/resolve` 只接受基础解析输入；分支的实际选择由正式分类流程写入队列，再由执行层把 `selectedConditionModuleIds` 交给同一解析器。

## 条件分支 schema

每个条件分支至少包含：

- 稳定 `id`、中文名称、分组 `family` 和修订号；
- 适用风格、资产类别和参考图方式；
- 供 Agent 判断的定义、控制维度、并列规则和“不默认命中”规则；
- 对基础字段执行的 `replaceWith`、`prepend`、`set` 或 `append` 操作；
- 可选测试样例和来源信息。

同一个 `family` 在同一资产上最多命中一个分支。不同分组可以共同生效；解析器按稳定分组与分支 ID 排序，保证同一输入得到同一结果。分支不得修改未在注册表白名单中的字段。

## 固定解析顺序

1. 归一化风格、资产类别和参考图方式。
2. 唯一命中一条基础路由；缺失或多条命中立即失败。
3. 应用唯一参考图修饰器，确定 11/12 字段 schema。
4. 校验所选普通条件分支的 scope、稳定 ID 和分组冲突。
5. 按 `replaceWith → prepend → set → append` 应用字段操作。
6. 用当前资产的 `productionNotes` 绑定动态字段。
7. 计算解析指纹并按固定顺序输出 Prompt 字段。

二次元场景和 CG 场景在第 1～7 步没有结构差异；区别只来自各自基础片段和实际命中的普通分支。

## Agent 分类与队列

正式建队先生成每个资产的基础候选。Agent 只根据完整“制作说明”从该资产可用的候选分支中选择 `selectedConditionModuleIds`，不得创造未注册 ID，不得跨 scope 选择，也不得按分支名称做关键词兜底。

分类结果写入 `cache/提示词分支匹配.json`：

```json
{
  "version": 1,
  "catalogFingerprint": "...",
  "conditionRegistryFingerprint": "...",
  "items": {
    "场景:SCENE-001": {
      "selectedConditionModuleIds": ["forest-route"]
    }
  }
}
```

最终队列项目只携带 `selectedConditionModuleIds`。注册表或基础路由指纹变化时，旧匹配和旧队列必须判定为过期并重新分类、建队，不能静默沿用。

## 指纹

- `catalogFingerprint` 覆盖 Catalog 中实际注册的全部源文件。
- `conditionRegistryFingerprint` 只覆盖条件分支注册表。
- `baseRouteFingerprint` 覆盖当前基础路由及其片段。
- `modifierFingerprints` 覆盖参考图修饰器和实际选择的普通条件分支。
- `resolvedFingerprint` 覆盖上述指纹、参考图模式/数量和当前资产绑定。

分支修改只让依赖该分支的解析结果变化；注册表集合变化会让分类缓存过期。旧数据不得通过保留废弃字段继续参与解析。

## 维护约束

- 新增细分判断只增加条件分支，不新增专属执行层。
- UI 中的预设、导入导出和测试都使用同一个分支交换 schema。
- 源注册表、共享资产快照和项目运行时副本由软件工作区的原子同步流程更新。
- 每次改动必须通过 Catalog 校验、队列/分类测试、全量 Node 测试和桌面发布验证。
