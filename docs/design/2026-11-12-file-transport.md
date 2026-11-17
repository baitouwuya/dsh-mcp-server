# 文件传输：预签名上传 + 图片读取（设计）

> 2026-11-12 · 对应 issue #4 · 状态：**已批准（v3）**
>
> **实现期修订（v4，2026-11-12）**：① `_meta` 的命名空间键用 `dsh-mcp-server`（`SERVER_NAME` 常量，
> `lib/protocol.js:44`），不是本文早先写的 `dsh-mcp-btwy`；② `trustedProxies`（IP 名单）改为
> `trustProxyHeaders`（布尔开关）——插件里 `peer` 只有 `'token'`/`'connection'` 两个符号值，
> 拿不到对端地址，见 §5.7；③ 槽位限流按**槽位数**计（一次铸造 N 个算 N 次），不是按调用次数；
> ④ `dsh_read_attachment` 增加可选 `index`——`seq` 只定位事件，而一个事件可能带多张图。
> ⑤ `dsh_status.upload` 的字段叫 `supported`（与 `_meta.fileUpload.supported` 一致），§7 写的 `enabled` 作废。
> ⑥ `name` 会随 `saveImages` 成为附件的显示名，不再只是回显。
> ⑦ 上传端点的状态码以 **`structuredContent.httpStatus`** 随失败结果返回（400/404/409/410/413/415/429）；工具失败在 MCP 里是 `isError` 结果而非 JSON-RPC error，所以它只能走 `structuredContent`，不能走 `error.data`。`dsh_read_attachment` 不走这条映射，没有该字段。
> ⑧ `restrictToOwner` 打开时，`fileId` 绑定铸造它的调用方；别人的 id 一律按「unknown fileId」处理。
> ⑨ 上传路由对非 PUT 回 405；`maxEdge` 夹在 [64,4096]，`readImageRequest` 的 `maxBytes` 固定 8 MiB。
> ⑩ `content-type` 不符也计入尝试预算（否则可无限探测）；过期与不存在的链接回同一句话，避免探测 nonce 是否存在。
> ⑪ 每次铸造的字节上限只统计**声明过**的 `expectedBytes`；未声明者按「单文件上限」占槽但不算进这笔账，否则默认配置下 4 张图就会被拒。
> ⑫ 只宣传 DSH 真收的四种类型（png/jpeg/webp/gif）；`avif` 去掉，否则 mint 通过、落盘被拒。
> ⑬ 回执里的 `storedBytes`/`mediaType` 取**存储后的 ref 值**，不是上传字节的原值（提供方可能重编码/缩放）。
> ⑭ 投递的 image part 带 `encodedBytes`：DSH 按它累加单条消息的图片字节上限，缺了会变成 `NaN` 而失效。
> ⑮ `index` 越界报错，不静默夹到边界；归属校验失败的消息里回显 `fileId`。
> ⑯ 存储提供方拒绝字节计一次尝试（3 次烧槽），不无限重试。

## 1. 问题

`dsh-mcp-btwy` 的 MCP 通道只能传文本。

- **读方向**：协议早就支持 `image` 内容块，客户端（Hermes）收到后会缓存成图片交给模型
  （`/opt/hermes/tools/mcp_tool_handlers.py:495-520`）。本插件从不产出这种块
  （`lib/protocol.js:285-302` 只投影 `text`/`structuredContent`）——能力有，没开。
- **写方向**：MCP 规范里工具入参就是 JSON，客户端没有「把本地文件交给服务器」的通道。
  让模型逐 token 生成 base64 也不现实（85 KiB 图 ≈ 113 KiB base64）。

调研结论（详见 Hermes 仓 `docs/research/2026-11-12-dsh-mcp-attachment-transport.md`）：

| 事实 | 证据 |
|---|---|
| Hermes 无「本地文件 → MCP server」能力，`call_tool` 纯 JSON 透传 | `mcp_tool_handlers.py:449` |
| Hermes 插件市场 763 个，无通用上传插件（全是厂商/平台绑定） | `/opt/hermes/plugin-catalog` |
| MCP 生态传文件三派：路径、base64 参数、**带外预签名上传** | playwright `browser_file_upload{paths}`；MCP Draft `experimental-ext-file-uploads` |

## 2. 目标与非目标

**目标**

1. 任何客户端（哪怕没有我们写的插件）都能把图片送进 DSH 会话，只要它有 shell 或 HTTP 能力。
2. 读方向能返回图片，模型直接看见。
3. 不引入第二套凭据、不要求客户端预装脚本。

**非目标**

- 不传非图片文件（PDF/zip 等）：DSH 的附件服务是图片向的（`saveImages()` 校验 mediaType、
  做尺寸归一化），文件类没有对等入口。
- 不做流式/断点续传。
- 不改 stdio 传输：插件需要进程内的 `sessionController`（`lib/dsh-delivery.js:77`）与 `agents`
  （`:87`）——现有的投递路径已在用；`attachments` 服务同样存在（`ctx.get("attachments")`，
  本插件目前没用到，本期新增）。stdio 拿不到这些服务。
- 不支持浏览器跨域直传（上传是服务间调用，不是网页表单）。

**反目标（即使能跑也算失败）**

- 把 bearer token 暴露给模型/命令行（日志泄露）。
- 让上传端点成为无限制的写盘入口（必须限额 + 过期 + 速率上限）。
- 客户端必须改代码才能用。

## 3. 考虑过的方案

| 方案 | 为什么不用 |
|---|---|
| A. 客户端侧插件（读文件→上传→投递） | 确定性最好，但要求每个客户端装代码；作为**后续可选**，不是第一版 |
| B. 在客户端容器放 `dsh-upload` 脚本 + 工具描述引导 | **不通用**：别人的部署里没有这个脚本 |
| C. 带鉴权的上传端点 + 模型 `curl` | 模型看不到 token（它在客户端配置里），vanilla 环境走不通 |
| **D. 预签名能力 URL（选定）** | URL 自带能力，无需凭据、无需预装，与 MCP Draft 同构 |
| E. 共享挂载路径 | 部署特定（要求两侧同卷），不进入通用实现 |

## 4. 选定方案

```
① dsh_prepare_upload({files:[{name?, mediaType, expectedBytes?}], clientBaseUrl?})
     → {uploads:[{fileId, uploadUrl, method:"PUT", expiresAt, maxBytes}]}

② 客户端 PUT 字节到 uploadUrl              ← 不需要鉴权头
     200 → {fileId, storedBytes, sha256, mediaType}

③ dsh_run_prompt(prompt, fileIds:[...])     ← 插件把图片挂进消息 parts
```

读侧：

```
dsh_read_attachment(sessionId, seq, maxEdge?) → content:[{type:"image", data, mimeType}]
```

### 4.1 为什么 URL 里放 nonce 而不是 token

模型/客户端只知道工具返回值。它拿不到 `DSH_MCP_TOKEN`（那是客户端配置里的 header），
所以任何要求 bearer 的上传端点都只能由**代码**调用。nonce 方案把凭据放进 URL：

- 32 字节随机（base64url），不可猜；
- 与铸造它的那次调用绑定：限定大小上限、允许的 mediaType、过期时间；
- 只在响应里出现一次，不进日志（服务端日志只记 hash 前缀）。

### 4.2 与早前「multipart 上传」结论的关系

第二轮讨论里定的是「一次 multipart 传多个文件」。预签名方案取代了它：**每个槽位只对应一个文件**，
所以 PUT 的 body 就是原始字节，不再需要 multipart 解析。多文件靠「一次铸造 N 个槽位」覆盖——
比 multipart 更好：每个文件独立进度、独立重试，一个坏了不用整批重传。

（`Response.formData()` 在 Node 24 可用这条结论仍然成立，只是本设计用不上。）

### 4.3 术语

| 词 | 含义 |
|---|---|
| **槽位 / slot** | 一次铸造为一个文件预留的位置：nonce + fileId + mediaType + maxBytes + 过期时间，**nonce 与 fileId 严格 1:1**（一个槽就是一个文件） |
| **nonce** | 槽位的密钥，只出现在 `uploadUrl` 路径里；32 字节随机，服务端只存它的 hash |
| **fileId** | 槽位的公开标识，铸造时即生成、随响应返回；存储成功后才可被 `dsh_run_prompt` 引用 |
| **uploadUrl** | `origin + /mcp-files/ + nonce` 组成的绝对地址，客户端直接 PUT |
| `expectedBytes` | **请求**里的「预计字节数」，只用来设 `maxBytes`，可省略 |
| `storedBytes` | **响应**里的「实际入库字节数」，以服务端为准 |
| `mediaType` | 图片的 MIME 类型；**不用** `mimeType` 这个词（避免与 MCP 内容块的字段名混淆） |

## 5. 契约

### 5.1 `dsh_prepare_upload`

入参：

```jsonc
{
  "files": [ { "name": "a.jpg", "mediaType": "image/jpeg", "expectedBytes": 85918,
               "sha256": "9f2c…" } ],              // sha256 可选，见 6.1
  "clientBaseUrl": "https://dsh.example.com:23000"   // 可选，见 5.7
}
```

- `files`：1 到 `uploadMaxFiles` 项；`name` 可选（只用于日志与返回体回显）。
- `mediaType`：**必填**，且必须同时满足两条：`image/*` 白名单
  （`image/jpeg`、`image/png`、`image/webp`、`image/gif`——与 DSH 附件服务实际接受的四种一致），
  以及 `attachments.imageLimits.mediaTypes` 允许（运行时从服务读，部署可能更窄）。
  任一不满足 → `415`，整批拒绝（不做部分成功）。
- `expectedBytes`：可选；缺省时该槽的 `maxBytes` 仍是 `uploadMaxFileBytes`，但**只有声明过的值**
  才计入每次铸造的 `uploadMaxBytes` 总额（否则默认 10 槽只能开 3 个）。
- `sha256`：可选；但 `uploadRequireSha256: true` 时**必填**（缺 → `400`）。给了就强校验，
  不符 `415`。
- `clientBaseUrl`：可选，见 5.7。

出参：

```jsonc
{ "uploads": [ {
  "fileId": "f_7Kd2…",
  "uploadUrl": "http://dsh:23022/mcp-files/v1.Kd8x…",
  "method": "PUT",
  "expiresAt": "2026-11-12T04:52:00.000Z",
  "maxBytes": 20971520
} ] }
```

### 5.2 `PUT <uploadUrl>`

- 请求体 = 原始字节。
- **`content-type` 规则**：可省略；`application/octet-stream` 视为「未声明」，以铸造时的
  `mediaType` 为准；若给出具体类型且与声明不符 → `415`（槽位不消耗）。这条是为了让
  `curl -T`（默认发 octet-stream）能直接用。
- **单槽上限** = `min(expectedBytes, uploadMaxFileBytes)`；实际字节超过 → `413`，
  槽位不消耗，可用更小的文件重试。
- **幂等重试**：首次成功之前，同一 URL 可重复 PUT（网络中断、超时都不消耗槽位）。
  首次成功后该 URL 立即失效，再 PUT → `409 already uploaded`。
- **并发**：同一 nonce 的两个 PUT 同时到达时，收体前先做一次状态 CAS（`minted → consuming`），
  只有抢到 CAS 的那次能收体；另一次立刻 `409 upload in progress`。收体结束再 CAS 到 `stored`。
  不允许「后写覆盖」。
- **内容校验**（顺序执行，任一失败 → `415`，计一次失败尝试）：
  1. `content-length` 与实际到达字节一致（防 chunked 抖动）；
  2. 魔数嗅探与声明 `mediaType` 一致（JPEG `FFD8FF`、PNG `89504E47`、GIF `GIF8`、WebP `RIFF….WEBP`、AVIF `ftypavif`）；
  3. 若铸造时给了 `sha256`，实到字节的摘要必须相等；
  4. 解码前读图片头拿到宽高，`width × height ≤ 100 MP`（像素炸弹防线：20 MiB 的 JPEG 可以解出几十亿像素）；
  5. 通过后才交给 `saveImages()`。
- **失败尝试次数**：每个槽位最多 3 次（`uploadMaxAttempts`）。到顶 → `410 slot burned`，
  防「拿垃圾字节无限重试」把解码当 CPU 放大器。网络中断（未收全）不计次数。
- **TTL**：PUT 开始时校验一次过期；上传过程中到期不打断，但**提交前再校验一次**，
  已过期则丢弃已收字节并返回 `410`（避免过期后仍写入）。

> **「单次」的含义**：单次指的是「单次**成功**」。失败重试不消耗槽位——这是对网络抖动、
> 代理超时、客户端中途退出的必要容忍，否则一次超时就得整套重铸。

### 5.3 `fileId` 的生命周期

```
minted ──PUT 成功──► stored ──fileIdTtlMs──► expired
   │                   │
   └─uploadTtlMs 到期──┴─► gone
```

| 状态 | `dsh_run_prompt` 引用时 | 说明 |
|---|---|---|
| `minted` | `409 not uploaded yet` | 铸了但还没 PUT 成功 |
| `stored` | 正常引用 | 可复用，见下 |
| `expired` / `gone` | `404 unknown fileId` | 映射已清理 |

- **两个 TTL 各管一段**：`uploadTtlMs`（铸造 → 首次成功上传，默认 5 min）；
  `fileIdTtlMs`（成功上传 → 引用失效，默认 1 h）。
- **`fileId` 可复用**：在有效期内可以多次引用（发到多个会话、同一会话发两次）。一次性的只有 nonce。
- **重启即失效**：nonce 与 fileId 映射都在内存里（无状态端点，不落盘）。进程重启后，
  所有未引用的 id 一律 `404`；已进入会话的图片不受影响（它们已是 attachment ref）。

### 5.4 `dsh_run_prompt(..., fileIds)`

- 新参数 `fileIds?: string[]`，长度上限同 `uploadMaxFiles`。
- 插件按 `fileId → attachment ref` 拼 parts：
  `[{type:"text",text}, {type:"image",attachment:ref}, …]`，顺序与 `fileIds` 一致。
- 状态不对或未知 → `409` / `404`（见 5.3），**不静默丢图**。

### 5.5 `dsh_read_attachment`

- 入参 `sessionId`、`seq`（会话事件的序号，与 `dsh_read_session` 返回的 `events[].seq` 同一套编号）、
  可选 `maxEdge`（默认 1568）。
- **`seq` 的域**：必须先按 `sessionId` 取出该会话的事件列表，再在其中按 `seq` 查找——
  不允许把 `seq` 当全局索引查（那会跨会话读到别人的图）。
- 实现：从会话事件里取 attachment ref → `attachments.readImageRequest(ref, target, signal)`。
  **`target` 是 `{width, height, maxBytes}`**，没有 `longEdge` 字段（`api-catalog.js:6609-6611`）。
  `maxEdge` 需要换算成宽高：已知原图宽高 `w/h`，长边压到 `maxEdge` ⇒
  `s = min(1, maxEdge / max(w, h))`，`target = {width: round(w*s), height: round(h*s), maxBytes}`。
  也可直接问 `LlmRuntime.imageRequestTarget(provider, model, ref)` 拿现成 target（`api-catalog.js:1944`），
  但那样就把「看图的是哪个模型」这个知识耦合进来了——本设计选前者。
  → 返回 `content:[{type:"image", data:<base64>, mimeType}]`（这里的 `mimeType` 是 MCP 内容块的
  协议字段名，与本设计的 `mediaType` 不是同一个词）。
- **权限**：进 handler 先走 `assertCallerMay(sessionId, caller)`（`lib/dsh-capabilities.js:220-232`）——
  `restrictToOwner` 打开时，调用方只能读自己创建的会话。
- `projectToolOutcome` 增加 `outcome.content` 透传（当前只认 `text`/`structuredContent`）。
- 单次最多 4 张原生附图是**客户端**的上限（Hermes `_MCP_NATIVE_IMAGE_MAX`），服务端不设限，
  但文档要写明「多张请分次读取」。

### 5.6 配置键

| 键 | 默认 | 夹值 | 说明 |
|---|---|---|---|
| `uploadTtlMs` | 300000（5 min） | 60 s – 24 h | 铸造 → 首次成功上传 |
| `fileIdTtlMs` | 3600000（1 h） | 60 s – 24 h | 成功上传 → 引用失效 |
| `uploadMaxFileBytes` | 20 MiB | 64 KiB – 256 MiB | 单文件 |
| `uploadMaxFiles` | 10 | 1 – 20 | 上界受 DSH 单条消息 20 张限制约束 |
| `uploadMaxBytes` | 64 MiB | 1 MiB – 512 MiB | 单次 `dsh_prepare_upload` 的总配额（铸造时按各槽 `maxBytes` 之和校验，超则 `400`） |
| `uploadMaxAttempts` | 3 | 1 – 10 | 单槽允许的失败尝试次数 |
| `uploadRequireSha256` | `false` | — | 为 `true` 时 `sha256` 必填（缺 → `400`），并强制校验 |
| `uploadGlobalBudgetBytes` | 512 MiB | 64 MiB – 4 GiB | 全局「已铸造未引用」的字节预算 |
| `trustProxyHeaders` | `false` | — | 是否采信 `X-Forwarded-*`（该路由已要求 token，见 §5.7） |

夹值在读取时做（照 `maxBodyBytes` 的既有写法，`index.js:547-549`），配置错也扩不出安全区。

### 5.7 上传地址怎么来

`uploadUrl` 的 origin 由**请求本身**推导，不由服务端自报监听地址：

```
origin = clientBaseUrl（若本次调用传了）
      ?? X-Forwarded-Proto + X-Forwarded-Host   ← 仅当 trustProxyHeaders: true
      ?? Host 头
```

**`X-Forwarded-*` 默认不信任**：任何客户端都能伪造这个头，把 `uploadUrl` 指到第三方。
要采信必须显式打开 `trustProxyHeaders`。

> 为什么是布尔开关而不是「可信代理 IP 列表」：这条路由的调用方在到达这段代码前**已经通过
> token 鉴权**，而 `peer` 在插件里只是一个符号值（`'token'`/`'connection'`，`index.js:516`），
> 拿不到真实对端地址。既然如此，把「是否采信转发头」做成部署级开关更诚实——它不是网络层
> 信任，而是「我知道前面有代理，且这条路由只有持 token 的调用方能进来」。

**路由形态**：`/mcp-files/<nonce>` 必须用 `kind: "prefix"` 注册（现有两个路由都是 `exact`，
重复的 `(kind, path)` 会抛错；`WebRouteKind = "exact" | "prefix"`，`api-catalog.js:9921-9922`），
在 handler 里再解析 nonce 后缀。路由的 `authorize`/`maxBodyBytes` 与 `/mcp` 一样由工厂闭包注入，
不经过 `register` 选项——上传路由自己夹 `uploadMaxFileBytes`（不共用 `/mcp` 的 8 MiB）。

请求上下文已经一路传到工具 handler（`lib/http-route.js:197` 构造 `context` →
`lib/protocol.js:242` `callTool(name, args, context)`），只需给 `context` 加 `origin` 字段。

`clientBaseUrl` 只覆盖**本次调用**，不落库；`origin` 同样只在响应里回声，不参与鉴权。

**兜底按 `http://`**：没有 `X-Forwarded-Proto` 时，`Host` 之外的协议信息不存在，只能假定明文。
TLS 终止在反代且不设转发头的部署，要么打开 `trustProxyHeaders` 并让反代补头，要么用
`clientBaseUrl` 显式指定——这两种情况都有明确出口，所以这里不猜 `https`。
（它存在的唯一理由：反代改写了 `Host` 又没设 `X-Forwarded-*` 时，服务端无从得知外部地址。）

### 5.8 `initialize._meta` 与 `dsh_status`

```jsonc
{ "_meta": { "dsh-mcp-server": { "fileUpload": {
  "supported": true, "prepareTool": "dsh_prepare_upload", "method": "PUT",
  "maxFileBytes": 20971520, "maxFiles": 10, "uploadTtlMs": 300000, "fileIdTtlMs": 3600000,
  "requireSha256": false
} } } }
```

`dsh_status` 返回同一份摘要（不含地址）。**不暴露固定上传端点**——地址每次铸造时现给。

**兼容**：这是一组新增工具与新增 `_meta` 键，老客户端忽略即可；版本走 **1.3.0**（minor）。
不存在破坏性改动，无需迁移。

### 5.9 错误

**上传端点（HTTP 状态码）**

| 码 | 场景 | 槽位 |
|---|---|---|
| `200` | 成功 | 消耗 |
| `410` | nonce 过期（含提交前二次校验发现已过期） | 作废 |
| `413` | 超过单槽上限 | **不消耗** |
| `415` | `content-type` 与声明不符 | **不消耗** |
| `409` | 该 nonce 已成功上传过 | 已消耗 |
| `429` | 该 nonce 的 PUT 频率超限 | 不消耗 |

**工具错误（`result.isError=true`）**

| 码 | 场景 |
|---|---|
| `400` | `files` 缺失/为空/超过 `uploadMaxFiles`/字段类型不对 |
| `404` | `fileId` 未知或已过期 |
| `409` | `fileId` 尚未上传成功 |
| `415` | `mediaType` 不在白名单 |
| `429` | 铸造频率超限（默认全局 60 次/分钟） |

## 6. 安全

- **nonce**：32 字节随机、单次成功、`uploadTtlMs` 过期、绑定 `mediaType` 与 `maxBytes`；
  服务端只存 `sha256(nonce)` 的前 16 字节做索引，原文不落任何日志。
- **并发**：每槽一把锁，先完成者胜，后到者 `409`；不存在「后写覆盖先写」。
- **重启**：nonce 与 fileId 全在内存，重启即失效——这是有意的：不引入持久化状态，
  也就不需要为它做一致性。
- **速率**：铸造全局 60 次/分钟；单 nonce 的 PUT 30 次/分钟（挡住「无限重试」被当作
  CPU 放大手段）。
- **存储**：字节直接进 DSH 的 content-addressed 附件存储（`saveImages` 前先校验 mediaType 与
  尺寸），插件不落第二份；已存储但从未被引用的对象交给 DSH 的保留策略，插件不删。
- **origin 伪造**：`origin` 只用于拼返回给调用方的 URL。调用方伪造它只会让自己拿到指向
  别处的地址——服务端不会因此向任何地方发起请求。
### 6.1 上传通道的两类攻击及处置

| 攻击 | 怎么做 | 处置 |
|---|---|---|
| **内容替换**（抢注） | 攻击者拿到 `uploadUrl` 后抢先 PUT 自己的图；受害者再传收 `409`，会话里出现攻击者的图（图像提示注入） | 铸造时可声明 `sha256`；声明后摘要不符直接 `415`（见 5.2 第 3 步）。**默认不强制**，靠 `uploadTtlMs` 缩短窗口；对「会读不可信网页」的 agent 建议开启 |
| **资源放大** | 反复 PUT 垃圾字节触发解码；或不停铸造囤积存储 | 单槽 3 次尝试上限；全局「已铸造未引用」字节预算 512 MiB；铸造 60 次/分钟 |

- **威胁模型**：能连到 MCP 端口的攻击者需要拿到 32 字节 nonce 才能上传；即使上传成功，
  字节也只在被 `dsh_run_prompt` 引用后才进会话。
- **老实说**：`sha256` 不开启时，「谁先 PUT 谁赢」这个洞是存在的。它的前提是攻击者能读到
  工具返回的 `uploadUrl`（例如通过提示注入让模型把 URL 外带）。**默认不强制**：强制会让最常见的
`curl -T` 变成「先 `sha256sum` 再传」两步；判据是——这个洞的前提是攻击者已经读到 URL，
而能读到 URL 的攻击者通常也能直接调用工具。要收紧就打开 `uploadRequireSha256`。

## 7. 运维与观测

- **日志**：每次铸造与上传记 `noncePrefix(8) + fileId + mediaType + bytes + 结果`，不记 nonce 原文。
- **`dsh_status.upload`**：`{enabled, minted, stored, failed, expired, pendingSlots}` 计数，
  便于排查「客户端说传了但没进来」。
- **孤儿**：`minted` 状态的槽位到期自动清理（定时 60 s 扫一次）；`stored` 但从未被引用的
  attachment 由 DSH 侧策略处理。
- **磁盘**：插件不写盘，配额由 DSH 的 attachment 存储决定；`uploadMaxBytes` 只限制单次铸造。
- **CORS**：不做。上传是服务间调用；浏览器场景不在本期范围。

## 8. 测试面

| 层 | 用例 |
|---|---|
| 单元 | nonce 生命周期；CAS 并发（第二个 PUT 立刻 409）；失败 3 次烧槽；魔数不符 / sha256 不符 / 像素超限的拒绝；`fileId` 两段 TTL；origin 三种来源、`clientBaseUrl` 覆盖、`X-Forwarded-*` 在非可信 peer 下被忽略 |
| 集成 | 假客户端 `curl -T` 全流程（含省略 content-type）；`dsh_run_prompt` 带 1/3/4 张图；`409 not uploaded yet` 与 `404` |
| 协议 | 工具数 26 → 28；`initialize._meta` 含 `fileUpload`；`tools/list` schema 校验；老客户端不带新参数照常工作 |
| 文档 | `docs/{zh,en}/tools.md` 新增两节，`check:docs` 通过 |

## 9. 票

| 票 | 内容 | 依赖 |
|---|---|---|
| T1 | `PUT /mcp-files/<nonce>` + 槽位状态机 + `saveImages` + 配置键 | — |
| T2 | `dsh_prepare_upload` + `dsh_run_prompt(fileIds)` + `context.origin` + `_meta` | T1 |
| T3 | `dsh_read_attachment` + `projectToolOutcome` 透传 `content` | — |
| T4 | 文档（zh/en）+ 1.3.0 + 发布说明 | T1–T3 |

T3 与 T1 可并行。

## 10. 留给实现者的判断

- nonce 的编码格式（不透明串 vs `v1.` 前缀）——只要保证不可猜，不影响契约。
- 上传字节先在内存聚合还是流式落临时文件——20 MiB 上限下内存聚合更简单。
- 每槽锁的实现形态（Promise map / 互斥队列）。
- 定时清理用 `setInterval` 还是惰性检查（惰性检查在低流量部署里更省事）。
