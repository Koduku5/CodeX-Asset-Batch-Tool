# 图片生成批量任务 API 使用指南

> 本 Skill 有两套互不覆盖的正式任务状态：普通 API 资产出图使用 `cache/出图队列.json` 和 `cache/出图进度.json`；用户自行选择目录的 API 批量重绘使用 `cache/批量重绘/队列.json` 和 `cache/批量重绘/进度.json`。两种模式共用 API 执行能力和流水线锁，但不得混写队列或进度。

本文面向需要通过 HTTP 批量执行图片生成任务的程序或 AI Agent，覆盖以下完整流程：

1. 登录并取得访问令牌。
2. 准备项目与图片生成模型。
3. 上传一张或多张参考图。
4. 使用参考图 URL 和 Prompt 提交异步生图任务。
5. 轮询任务结果。
6. 下载生成图片。
7. 普通资产批次按需把参考图、生成结果和引用连线保存进画布项目。

本文只描述 `IntinifyCanvas` 对外暴露的 `/api/v1` 接口，不要直接调用后端使用的 AI 平台内部接口。

## 目录

- [1. 最小流程](#1-最小流程)
- [2. 通用约定](#2-通用约定)
- [3. 准备工作](#3-准备工作)
- [4. 上传参考图](#4-上传参考图)
- [5. 提交图片生成任务](#5-提交图片生成任务)
- [6. 获取状态和结果](#6-获取状态和结果)
- [7. 下载生成图片](#7-下载生成图片)
- [8. 将任务保存为画布节点](#8-将任务保存为画布节点)
- [9. 错误处理](#9-错误处理)
- [10. 批量任务建议](#10-批量任务建议)
- [11. 本 Skill 中的批量执行](#11-本-skill-中的批量执行)
- [12. 实现依据](#12-实现依据)

## 1. 最小流程

```text
POST /api/v1/auth/login
  -> token

POST /api/v1/images/upload
  -> reference_url

POST /api/v1/ai/image-gen
  body.images = [reference_url]
  body.async = true
  -> task_id

GET /api/v1/ai/task-result/{task_id}
  -> HTTP 202：继续等待
  -> HTTP 200 + status=completed：取得 images[]

GET {images[n]}
  -> 图片文件

GET /api/v1/projects/{project_id}
  -> 当前画布 data

PUT /api/v1/projects/{project_id}
  body.data = 合并后的 elements + edges
  -> 用户可在 /canvas/{project_id} 回看
```

批量客户端推荐轮询 `task-result`，不必为每个任务维持 SSE 长连接。

## 2. 通用约定

假设服务地址为：

```bash
export BASE_URL='https://canvas.dopamine.video'
```

需要认证的接口使用登录返回的 JWT：

```http
Authorization: Bearer <token>
```

本文中的图片 URL 通常是相对路径，例如：

```text
/api/v1/images/PROJECT_ID/IMAGE_ID.png
```

请求和下载时需要拼接部署域名：

```text
https://canvas.example.com/api/v1/images/PROJECT_ID/IMAGE_ID.png
```

核心接口的认证要求如下：

| 接口 | 是否需要 JWT |
| --- | --- |
| `POST /api/v1/auth/login` | 否 |
| `GET /api/v1/models` | 否 |
| `GET/POST /api/v1/projects...` | 是 |
| `POST /api/v1/images/upload` | 是 |
| `POST /api/v1/ai/image-gen` | 是 |
| `GET /api/v1/ai/task-result/{task_id}` | 是 |
| `GET /api/v1/ai/queue-status` | 是 |
| `GET /api/v1/images/{projectId}/{imageId}` | 当前后端路由不要求 JWT |
| `GET/PUT /api/v1/projects/{id}` | 是 |

## 3. 准备工作

### 3.1 登录

```http
POST /api/v1/auth/login
Content-Type: application/json
```

请求体：

```json
{
  "username": "batch-user",
  "password": "your-password"
}
```

成功响应：

```json
{
  "token": "<JWT>",
  "user": {
    "id": "USER_ID",
    "username": "batch-user",
    "name": "批量任务用户",
    "role": "user",
    "status": "approved"
  }
}
```

`curl` 示例：

```bash
AUTH_JSON="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$BASE_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"batch-user","password":"your-password"}'
)"

TOKEN="$(printf '%s' "$AUTH_JSON" | jq -r '.token')"
```

账号必须已经通过管理员审批。令牌过期后，接口返回 `401`，客户端应重新登录。

### 3.2 取得项目 ID

上传参考图和保存生成结果都使用 `project_id`。优先复用已有项目：

```bash
curl --fail-with-body --silent --show-error \
  "$BASE_URL/api/v1/projects?owner=me" \
  -H "Authorization: Bearer $TOKEN"
```

如果需要创建项目，先查询当前账号可用的项目组：

```http
GET /api/v1/project-groups/available
```

选择同时满足以下条件的项目组：

```json
{
  "allow_project_creation": true,
  "allow_image_generation": true
}
```

然后创建项目：

```http
POST /api/v1/projects
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "name": "AI 批量生图",
  "project_group_id": "PROJECT_GROUP_ID",
  "data": {}
}
```

响应中的 `id` 就是后续使用的 `project_id`。

保存画布 `data` 只允许项目所有者操作，因此登录账号应当与项目创建账号一致。项目组管理员可以查看部分项目，但不能代替项目所有者写入画布内容。

### 3.3 取得生图模型 ID

```http
GET /api/v1/models
```

响应示例：

```json
{
  "providers": [],
  "models": [
    {
      "id": "IMAGE_MODEL_ID",
      "display_name": "Image Model",
      "capability": "image_generation",
      "provider_id": "provider-id"
    }
  ]
}
```

选择 `capability` 以逗号分隔后包含 `image_generation` 的模型，并把它的 `id` 作为生图请求的 `model_id`。不要把 `display_name` 当作模型 ID。

## 4. 上传参考图

### 4.1 推荐方式：multipart 文件上传

```http
POST /api/v1/images/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `project_id` | string | 是 | 图片所属项目 ID |
| `file` | file | 是 | 图片文件 |

`curl` 示例：

```bash
UPLOAD_JSON="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$BASE_URL/api/v1/images/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "project_id=$PROJECT_ID" \
    -F 'file=@./reference.png'
)"

REFERENCE_URL="$(printf '%s' "$UPLOAD_JSON" | jq -r '.url')"
```

成功响应：

```json
{
  "url": "/api/v1/images/PROJECT_ID/IMAGE_ID.png"
}
```

服务会识别 `.jpg`、`.jpeg`、`.png`、`.gif`、`.webp` 扩展名。考虑到后续模型服务的限制，参考图必须控制在 20 MiB 以内。

不要手工设置 multipart 的 `Content-Type` 边界；让 HTTP 客户端自动生成。

### 4.2 兼容方式：JSON Base64 上传

```http
POST /api/v1/images/upload
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "project_id": "PROJECT_ID",
  "base64": "data:image/png;base64,iVBORw0KGgo..."
}
```

此方式会增加约三分之一的传输体积和额外内存占用，批量任务优先使用 multipart。

### 4.3 参考图 URL 约束

提交生图请求时，`images` 应直接使用上传接口返回的内部 URL：

```json
{
  "images": [
    "/api/v1/images/PROJECT_ID/IMAGE_ID.png"
  ]
}
```

注意：

- 不要向 `images` 传 `blob:` URL。
- 批量客户端不要直接传 Base64；先上传，再引用返回的 URL。
- 当前生图处理不支持直接读取外部 `http://` 或 `https://` 图片。外部图片需要先下载到客户端，再调用上传接口。
- 同一张参考图可上传一次后在多个任务中复用。
- 多图请求会保留数组顺序；第一张图会作为主要参考图，其余图片作为附加参考图。

## 5. 提交图片生成任务

### 5.1 请求

```http
POST /api/v1/ai/image-gen
Authorization: Bearer <token>
Content-Type: application/json
```

图生图最小请求：

```json
{
  "model_id": "IMAGE_MODEL_ID",
  "prompt": "保留参考图的主体构图，改成雨夜霓虹电影风格",
  "images": [
    "/api/v1/images/PROJECT_ID/IMAGE_ID.png"
  ],
  "aspect_ratio": "16:9",
  "image_size": "1K",
  "project_id": "PROJECT_ID",
  "request_id": "batch-20260724-000001",
  "async": true
}
```

纯文生图时省略 `images`：

```json
{
  "model_id": "IMAGE_MODEL_ID",
  "prompt": "一座漂浮在云海上的未来城市，日出，电影级光影",
  "aspect_ratio": "16:9",
  "image_size": "1K",
  "project_id": "PROJECT_ID",
  "request_id": "batch-20260724-000002",
  "async": true
}
```

### 5.2 核心字段

| 字段 | 类型 | 批量流程要求 | 说明 |
| --- | --- | --- | --- |
| `model_id` | string | 必填 | 从 `/models` 返回值中选择 |
| `prompt` | string | 必填 | 普通文生图或图生图提示词 |
| `images` | string[] | 图生图必填 | 上传接口返回的内部图片 URL，可传多张 |
| `aspect_ratio` | string | 建议必填 | 输出比例，普通请求建议显式传递 |
| `image_size` | string | 建议必填 | `512`、`1K`、`2K`、`4K`；省略时后端默认为 `1K` |
| `project_id` | string | 必填 | 用于项目组生图能力检查、输入审计和结果存储 |
| `request_id` | string | 强烈建议 | 客户端生成的唯一任务 ID；提供后会直接作为 `task_id` |
| `async` | boolean | 必须为 `true` | 批量任务应立即返回 `task_id` |

当前界面提供的常规比例为：

```text
21:9, 16:9, 5:4, 4:3, 3:2, 1:1, 2:3, 3:4, 4:5, 9:16
```

部分模型还支持 `2:1`。后端能够解析正整数格式的 `W:H`，但模型服务未必接受任意比例，因此批量任务应使用模型界面已经提供的比例。

`512`、`1K`、`2K`、`4K` 是后端可接受值，不代表每个模型都支持全部尺寸。名称包含 `nano-banana-2-lite` 或 `flash-lite-image` 的模型会被后端强制使用 `1K`。

### 5.3 其他可选字段

| 字段 | 说明 |
| --- | --- |
| `prompt_input` | 保存用户原始输入，主要用于审计和界面回显 |
| `quick_action_key` | 使用后台配置的图片快捷操作；会影响 Prompt、比例或尺寸 |
| `template_id` | 使用生图模板 |
| `style_id` | 使用模板时必填，且必须属于该模板 |
| `theme` | 模板模式题材 |
| `character_prompt` | 模板模式角色设定 |
| `original_image` | 图片编辑/扩图的主图 URL |
| `mask` | 扩图蒙版 URL |
| `preserve_dimensions` | 扩图时从主图推导尺寸 |

模板模式不能同时传 `images` 或 `original_image`。普通“上传参考图并生图”的批量流程不需要这些高级字段。

### 5.4 提交响应

异步提交成功返回 HTTP `202 Accepted`：

```json
{
  "task_id": "batch-20260724-000001",
  "status": "queued"
}
```

`request_id` 必须全局唯一。它用于跟踪任务，但当前接口不是通用幂等提交接口；重复提交同一个 `request_id` 可能失败。

如果提交请求因网络中断而结果未知，先使用原 `request_id` 查询任务结果，再决定是否重试，不要立即生成新 ID 重复提交。

## 6. 获取状态和结果

### 6.1 推荐方式：轮询任务结果

```http
GET /api/v1/ai/task-result/{task_id}
Authorization: Bearer <token>
```

任务未结束时返回 HTTP `202`：

```json
{
  "status": "processing",
  "queue_position": 0
}
```

可能的非终态包括：

```text
queued, processing, retrying
```

任务完成时返回 HTTP `200`：

```json
{
  "status": "completed",
  "images": [
    "/api/v1/images/PROJECT_ID/GENERATED_IMAGE_ID.png"
  ],
  "aspect_ratio": "16:9",
  "image_size": "1K"
}
```

推荐每 `2～5` 秒查询一次，并设置约 `16` 分钟的客户端总超时。不要毫秒级高频轮询。

`curl` 单次查询：

```bash
curl --fail-with-body --silent --show-error \
  "$BASE_URL/api/v1/ai/task-result/$TASK_ID" \
  -H "Authorization: Bearer $TOKEN"
```

### 6.2 可选方式：SSE 队列状态

```http
GET /api/v1/ai/queue-status?task_id=TASK_ID
Accept: text/event-stream
Authorization: Bearer <token>
```

SSE 数据示例：

```text
data: {"queue_position":1,"status":"queued"}

data: {"queue_position":0,"status":"processing"}

data: {"queue_position":0,"status":"completed"}
```

SSE 只报告状态。收到 `completed` 后，仍需调用 `task-result` 取得图片 URL。

浏览器原生 `EventSource` 无法设置 `Authorization` 请求头时，可使用：

```text
/api/v1/ai/queue-status?task_id=TASK_ID&token=<JWT>
```

服务端支持该兼容方式，但非浏览器批量客户端应优先使用请求头，避免令牌出现在 URL 和代理日志中。

## 7. 下载生成图片

结果中的 `images[]` 是图片 URL。逐个下载即可：

```bash
IMAGE_URL='/api/v1/images/PROJECT_ID/GENERATED_IMAGE_ID.png'

curl --fail-with-body --location \
  "$BASE_URL$IMAGE_URL" \
  --output './generated.png'
```

下载接口返回实际图片内容和对应的 `Content-Type`。批量客户端应使用唯一文件名，避免不同任务相互覆盖。

生成结果已经持久化到项目图片目录，不需要再调用上传接口。

## 8. 将任务保存为画布节点

本节用于普通 API 资产出图或其他明确要求回写画布的调用。目录批量重绘只把结果保存到用户指定的本地目录，不执行画布合并。

为了让用户在画布中直接回看“哪些参考图生成了哪些结果”，每批任务结束后应保存：

- 每张参考图对应一个 `image` 节点。
- 每张生成结果对应一个 `imageGenerator` 节点。
- 每个引用关系对应一条从参考图节点指向结果节点的 `edge`。

画布地址为：

```text
{BASE_URL}/canvas/{project_id}
```

### 8.1 先读取再合并

先读取项目当前数据：

```http
GET /api/v1/projects/{project_id}
Authorization: Bearer <token>
```

响应中的 `data` 是完整画布状态：

```json
{
  "elements": [],
  "rootOrder": [],
  "groupMeta": {},
  "edges": [],
  "migrationVersion": 4,
  "analysisResults": {}
}
```

随后在客户端合并新节点和连线，再整体更新：

```http
PUT /api/v1/projects/{project_id}
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "data": {
    "elements": [
      {
        "id": "batch-ref-a1",
        "type": "image",
        "name": "Batch 引用 1",
        "position": {
          "x": 0,
          "y": 0
        },
        "width": 300,
        "height": 300,
        "rotation": 0,
        "zIndex": 1,
        "src": "/api/v1/images/PROJECT_ID/REFERENCE_IMAGE_ID.png"
      },
      {
        "id": "batch-result-b1",
        "type": "imageGenerator",
        "name": "Batch 结果 001-01",
        "position": {
          "x": 520,
          "y": 0
        },
        "width": 320,
        "height": 180,
        "rotation": 0,
        "zIndex": 2,
        "prompt": "保留参考图的主体构图，改成雨夜霓虹电影风格",
        "generatedImageSrc": "/api/v1/images/PROJECT_ID/GENERATED_IMAGE_ID.png",
        "aspectRatio": "16:9",
        "imageSize": "1K",
        "modelId": "IMAGE_MODEL_ID",
        "isGenerating": false,
        "generatedImageSettings": {
          "aspectRatio": "16:9",
          "imageSize": "1K",
          "modelId": "IMAGE_MODEL_ID"
        }
      }
    ],
    "rootOrder": [
      "batch-result-b1",
      "batch-ref-a1"
    ],
    "groupMeta": {},
    "edges": [
      {
        "id": "batch-edge-c1",
        "sourceNodeId": "batch-ref-a1",
        "targetNodeId": "batch-result-b1",
        "sourcePortKey": "output",
        "targetPortKey": "input_0",
        "sourceImageSnapshotUrl": "/api/v1/images/PROJECT_ID/REFERENCE_IMAGE_ID.png"
      }
    ],
    "migrationVersion": 4,
    "analysisResults": {}
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `elements` | 画布全部节点，不只是本批新增节点 |
| `rootOrder` | 根节点顺序；新增节点 ID 也必须加入 |
| `groupMeta` | 分组数据；没有分组时为 `{}` |
| `edges` | 全部连线；引用输入端口固定使用 `input_0` |
| `migrationVersion` | 当前节点工作流版本为 `4` |
| `analysisResults` | 现有分析结果，合并时原样保留 |

`PUT /projects/{id}` 会替换整个 `data`。对于已有项目，绝不能只提交本批节点；必须保留原有 `elements`、`rootOrder`、`groupMeta`、`edges`、`analysisResults` 以及未知的顶层字段。

推荐的批量保存策略：

1. 所有生图任务结束后再保存，避免每个任务各写一次项目。
2. 紧邻 `PUT` 前执行一次 `GET`，基于最新 `data` 合并。
3. 如果参考图 URL 已经存在于画布图片节点中，复用该节点，不重复创建。
4. 为每个生成结果创建独立的 `imageGenerator` 节点。
5. 从每个参考图节点向对应的结果节点添加一条 `edge`。
6. 批量程序写画布时，不要同时让用户在同一项目中编辑；当前项目 API 没有版本号或条件更新，双方同时保存可能互相覆盖。

下文 Python 示例会在下载结束后执行一次上述合并更新。

## 9. 错误处理

任务执行失败时，`task-result` 会返回非 `2xx` 状态码和结构化错误：

```json
{
  "error_code": "image.upload_timeout",
  "message": "参考图上传超时，请稍后重试",
  "status": "failed",
  "failure_code": "image.upload_timeout",
  "failure_category": "timeout"
}
```

客户端应优先根据 `error_code` 或 `failure_code` 分支，不要匹配 `message` 文本。

常见状态码：

| HTTP 状态 | 常见含义 |
| --- | --- |
| `400` | 请求体、比例、尺寸、模板或参考图无效 |
| `401` | JWT 缺失、无效或过期 |
| `403` | 项目组禁止生图 |
| `404` | 模型或任务不存在 |
| `429` | 用户并发任务过多或模型服务限流 |
| `504` | 图片生成或参考图上传超时 |
| `500` | 内部错误或模型服务错误 |

常见任务错误码：

| 错误码 | 含义 | 建议 |
| --- | --- | --- |
| `validation.inline_image_not_allowed` | 生图请求直接传了内联图片 | 先调用上传接口 |
| `image.prohibited_content` | Prompt 或参考图未通过安全审核 | 修改输入，不自动重试 |
| `image.upload_too_large` | 参考图超过下游限制 | 压缩到 20 MiB 以内 |
| `image.upload_timeout` | 参考图传给模型服务时超时 | 延迟后有限次重试 |
| `image.timeout` | 生图超时 | 延迟后有限次重试 |
| `image.rate_limited` | 模型服务繁忙 | 指数退避后重试 |
| `image.provider_error` | 模型服务异常 | 延迟后有限次重试 |
| `image.network_error` | 网络异常 | 延迟后有限次重试 |
| `image.no_result` | 模型未返回图片 | 检查 Prompt 后重试 |
| `task.user_limit` | 当前账号进行中的任务过多 | 等待已有任务完成后再提交 |
| `task.interrupted_restart` | 服务重启打断了任务 | 重新提交 |
| `task.internal_error` | 未分类内部错误 | 保留 `task_id` 并排查服务日志 |
| `project_group_image_generation_disabled` | 项目组关闭生图能力 | 更换项目组或联系管理员 |

部分较早的参数校验和认证错误仍是 `text/plain`。通用客户端应同时支持：

1. `Content-Type: application/json` 时读取 `error_code`、`message`。
2. 其他响应读取纯文本正文。

上传接口的 multipart 业务错误码包括：

```text
image_upload_invalid_multipart
image_upload_missing_project_id
image_upload_invalid_project_id
image_upload_missing_file
image_upload_save_failed
```

## 10. 批量任务建议

- 同一参考图只上传一次，缓存并复用返回的 URL。
- 每个任务生成唯一 `request_id`，同时保存“业务记录 ID -> request_id -> task_id”的映射。
- 从 `2` 个并发任务开始，不要假设服务端并发上限。收到 `429` 或 `task.user_limit` 后暂停提交。
- 限制的是进行中的任务，不只是 HTTP 提交请求；应在某个任务结束后再补充新任务。
- 对限流、网络和超时错误使用指数退避并设置最大次数。
- 对内容安全和输入校验错误不要自动重试。
- 下载成功后校验 HTTP 状态、文件大小和 `Content-Type`。
- 所有成功任务汇总后只更新一次项目 `data`。
- 不要在日志中输出密码、JWT、完整 Base64 或图片二进制。

## 11. 本 Skill 中的批量执行

普通用户不需要设置环境变量。统一从 Skill 根目录的以下入口进入：

```text
提示词设置.cmd
```

第一层只显示“内置 image_gen”和“API 批量出图”。选择 API 后直接打开同一个 API 配置窗口，不再增加第二层模式窗口。窗口中的“使用文件夹中的图片批量重绘”复选框只负责在普通资产出图与目录批量重绘之间切换。

### 11.1 普通 API 资产出图

不勾选批量重绘时，现有普通 API 出图逻辑保持不变：

1. API 窗口显示角色、生物、群演、场景、道具五类模板，生物固定放在角色后。
2. [`scripts/pipeline/build_image_queue.mjs`](../scripts/pipeline/build_image_queue.mjs) 读取 `输出/剧本资产制表.xlsx`，按“对应模板 + 空行 + Excel 制作说明”生成每项最终 Prompt。
3. 任务写入 `cache/出图队列.json`，远端与下载状态写入 `cache/出图进度.json`。
4. [`scripts/pipeline/batch_generate_images.py`](../scripts/pipeline/batch_generate_images.py) 登录、有限并发提交、轮询、校验并原子保存 PNG；整批完成后按现有协议合并画布节点。

普通出图与旧 `reference_redraw` 恢复任务都禁止覆盖未被当前状态绑定的目标文件。新远端提交要求目标不存在并保存缺失基线；下载完成后先持久化候选文件的大小和 SHA-256，再以“不替换已有路径”的方式发布。进程若在发布与状态提交之间中断，只有目标内容与该候选指纹完全一致时才能自动认领；旧状态缺少候选证据或用户在期间放入了文件时停止恢复，不猜测文件归属。

普通模式继续校验 Excel、待确认记录、窗口模板快照和输出路由指纹，不读取外部提示词前缀或风格锚点文件。明确的单资产测试仍可由 Agent 调用 `start_api_batch.ps1 -OnlyQueueKey "<队列 key>"`；该参数只属于普通资产队列。

### 11.2 用户目录批量重绘

勾选批量重绘后，同一个 API 窗口改为让用户完成三项输入：

- 选择原图文件夹。
- 选择重绘结果保存文件夹。
- 输入一条本批次统一重绘提示词。

三项均由用户决定。目录重绘完全不读取 Excel、制作说明、资产 ID、角色/生物/群演/场景/道具五类模板、待确认记录、出图路由或 Skill 的 `输出/资产图`。它不会为不同图片附加资产描述、分类前缀或隐藏提示词。每个远端任务严格只提交：

```text
当前原图 -> images[0]
用户输入的本批次统一重绘提示词 -> prompt
```

目录建队由 [`scripts/pipeline/build_directory_redraw_queue.mjs`](../scripts/pipeline/build_directory_redraw_queue.mjs) 完成。原图、结果目录与 Skill 项目必须完全分离，三者不能相同、互相嵌套或包含彼此；这样重置 Skill 输出时不会误处理用户的外部目录。脚本递归扫描并支持 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`，不跟随符号链接或目录联接；空文件、结构与扩展名不符、声明画布超过 24 Mi 像素、无法稳定读取或超过 20 MiB 的图片写入 `skipped`。扫描硬上限为 100,000 个目录条目、10,000 张有效图片、50 GiB 有效源图总量；超过即要求拆分批次。有效任务达到 100 张时，窗口必须在启动远端 API 前二次确认费用和时长。没有有效图片时停止且不建立空队列。

原图目录和结果目录必须是已存在的绝对目录，不能是盘符根、UNC 共享根，不能相同或互为上下级。队列保存每张原图的相对路径、大小、SHA-256、对应相对输出路径、统一 Prompt 和输入指纹。输出保留原图的相对子目录结构并统一保存为 PNG；不同扩展名转换后产生同名目标时停止。新批次发现结果目录中已存在同名目标时停止，禁止覆盖用户文件。该模式不会自动读取或写入 Skill 的 `输出/`；生成结果只写到用户明确选择的结果目录。

目录模式使用独立状态：

```text
cache/批量重绘/队列.json
cache/批量重绘/进度.json
```

队列的 `operation` 固定为 `directory_redraw`。Python 执行器以 `--directory-redraw` 读取这组文件，逐项上传一张原图并把返回 URL 作为 `images` 提交；远端任务、下载和失败状态只写入专用进度，不得改写普通 `cache/出图队列.json` 或 `cache/出图进度.json`。目录批量重绘不进行画布合并。

相同未完成批次再次启动时，原图目录、结果目录、统一 Prompt 和 API 非密钥配置必须保持一致；匹配的 `request_id`、`task_id` 和逐项进度继续使用。输入发生变化时，不得覆盖可恢复状态或为状态不明的任务重复提交。过去由 `operation=reference_redraw` 表示的资产 ID 绑定重绘只保留为已有未完成任务的隐藏恢复兼容，用户界面不再建立这种队列。

### 11.3 两种 API 模式的共同约束

所有 JSON 响应都从原始字节按严格 UTF-8 解码，不依赖服务器是否在 `Content-Type` 中声明字符集。成功 JSON 响应最多读取 8 MiB，错误响应最多读取 1 MiB，结果图片最多下载 64 MiB；即使服务端缺少或伪造 `Content-Length`，客户端也会按实际读取字节执行硬上限。选择 API 后直接显示配置窗口；用户点击开始按钮后才显示任务终端并执行环境检查，检查通过前不得建队、写 Cache 或提交生图，取消则直接退出。

连接时按服务域名的实际解析结果选择代理：全部地址均为私网、本机或链路本地地址时自动直连；只要存在公网地址就保留系统代理。配置窗口和 Python 执行器必须采用相同判断。

`KA_API_BASE_URL`、`KA_API_USERNAME`、`KA_API_PASSWORD`、`KA_API_PROJECT_ID`、`KA_API_MODEL_ID`、`KA_API_MAX_WORKERS`、`KA_API_ASPECT_RATIO` 和 `KA_API_IMAGE_SIZE` 是启动器内部使用的进程级传值接口。普通模式另用 `KA_API_PROMPT_TEMPLATES_B64` 传递五类模板；目录重绘另用 `KA_REDRAW_CONFIG_B64` 传递用户选择的两个目录和统一 Prompt。它们都不是普通用户需要手工设置的配置步骤。密码和 JWT 不得写入队列或进度。

API 服务地址必须是完整的 `http://` 或 `https://` 地址，可以包含服务部署子路径，但不得在 URL 中夹带用户名、密码、查询参数或片段；账号与密码只填写在各自输入框中。域名一律强制使用 HTTPS；只有 URL 主机直接填写 RFC1918 私网、本机或链路本地 IP 字面量时才允许 HTTP，避免“校验时解析为私网、连接时解析为公网”的 DNS 重绑定窗口。带 `%接口` zone identifier 的 scoped IPv6 URL 会被明确拒绝，防止 Windows PowerShell 5.1 标准化时静默丢失作用域；这类服务请改用私网 IPv4、可路由的无作用域地址或 HTTPS 域名。并发数由配置窗口和 Python 执行器共同限制为 1–16。

连接中断或客户端超时不等于远端失败。脚本保留原 `request_id`、`task_id` 和 `generating` 状态，下次优先继续查询；提交结果不确定、查询中断或服务端限流时停止补充新任务。远端明确失败或结果未通过文件校验时才写入 `failed`。可重试失败最多消耗两次正式生成尝试；明确未创建任务的限流响应不消耗该次数。

普通资产进度中的 `attemptLedger` 分别保存 `builtin` 与 `api` 的 `inputFingerprint`、`attempts`、`lastError` 和 `updatedAt`。切换出图后端时必须保留另一后端账本；重新切回 API 仍沿用此前 API 已消耗的次数，不能借切换绕过两次上限。只有 API 输入指纹变化时才重置 API 项，内置提示词指纹变化时只重置内置项。旧版只有顶层 `backend`、`attempts` 的状态在首次读取时按当前后端懒迁移；目录批量重绘只有 API 后端，继续使用原单账本结构。

结果图只允许从 `BASE_URL` 同源地址下载，下载请求不携带 JWT。Python 执行器的 API 与图片请求只允许同源重定向，跨主机、端口、协议或 HTTPS 降级均拒绝；配置窗口中的连接、项目和模型探测更严格，任何 30x 都拒绝。两种 API 模式共用 `.pipeline.lock` 和隐藏 API 独占锁，因此普通资产出图、目录批量重绘及各自恢复任务不能并发运行。不要手工删除锁文件。

清空 Cache 时只把 `cache/批量重绘/队列.json` 和 `cache/批量重绘/进度.json` 恢复为空状态。原图目录和结果目录位于用户指定位置，不属于 Skill Cache 或交付输出；清空 Cache 不得压缩备份、删除、移动或修改这些外部目录中的任何文件。

普通模式的画布更新失败仍只记录在 `cache/出图进度.json` 的 `apiBatch` 中，不改变已经下载并校验通过的图片。目录批量重绘没有画布同步阶段，其进度窗口直接依据专用队列和进度显示完成、运行、重试、失败及跳过项。

## 12. 实现依据

接口行为以以下实现为准：

- 路由：`backend/main.go`
- JWT：`backend/internal/auth/handler.go`、`backend/internal/middleware/auth.go`
- 图片上传与下载：`backend/internal/storage/handler.go`
- 生图请求与队列状态：`backend/internal/api/ai.go`
- 任务结果持久化与响应：`backend/internal/api/task_persistence.go`
- 项目读写：`backend/internal/project/handler.go`、`frontend/src/services/projectService.ts`
- 画布节点与引用连线：`frontend/src/types.ts`、`frontend/src/utils/referenceEdgeSync.ts`
- 前端实际生图流程：`frontend/src/services/aiService.ts`、`frontend/src/services/imageService.ts`
