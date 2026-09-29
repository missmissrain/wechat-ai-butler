# 微信电控AI管家

把**一个真实微信账号**接成一个能记事、能跑代码、能控设备的私人 AI 管家。

- **微信接入层**：抽取自 **OpenClaw 微信插件的 iLink 协议**（协议层不依赖 OpenClaw Runtime）
- **对话后端**：**DeepSeek Harness**（会话、工具、审批、上下文压缩全在 Harness 侧）
- **长期记忆**：时间数据库（按天的对话时间线）+ 知识图谱（人物/关系/属性/事件事实）
- **本地模型**：Gemma 4 E4B（GGUF，llama.cpp），负责摘要、图谱抽取、图片描述
- **外部 agent 桥**：把 codex / opencode 当成"手下"派活，结果按需取回
- **控制台**：本地 Web + Electron 托盘，管模型、工具、记忆、微信绑定

> 本仓库**只包含代码、配置模板与文档**。密钥、人格提示词正文、聊天记录、时间线/图谱数据、账号标识**一律不在仓库内**，详见《隐私与安全》。

---

## 1. 数据流总览

```
微信 App
  │  （iLink 协议，基于 OpenClaw 微信插件）
  ▼
微信接入层  webhook-weixin
  ├─ 单消费者 lease + OpenClaw 隔离 preflight（fail-closed）
  ├─ 入站合并窗口（默认 6s，把连续几条合成一条）
  ├─ 会话宿主：Harness Agent / Session 复用与销毁
  ├─ 工具：时间线、图谱、桥接、通知
  └─ 出站队列：限速、批限、停放（用户窗口约束）
  │  （Harness 原生 Agent / Session / Cordis 生命周期）
  ▼
DeepSeek Harness 后端
  ├─ llm-pi-ai 适配器 → openai-responses（默认）/ chat-completions
  ├─ 对话模型：云端（豆包 / 千问，可配置故障转移）
  ├─ 记忆模型：本地 Gemma4（摘要 / 图谱抽取 / 图片描述）
  └─ 上下文压缩：compressionBudget 与模型上下文窗口绑定
  │
  ▼
微信接入层 出站
  └─ 通知类永不阻塞队列、永不熔断；长任务结果停放，由工具按需取回
```

## 2. 接口层：基于 OpenClaw 的 iLink 协议

微信侧协议**不是**我们发明的：`webhook-weixin` 抽取了 **OpenClaw 微信插件**（官方插件包 `@tencent-weixin/openclaw-weixin`）的 iLink 协议与媒体处理，然后把它接到 Harness 的 Agent/Session 生命周期上。

抽取后保留的协议事实（见 `harness_overlay/` 内的 `src/api/ilinkClient.ts`）：

| 项目 | 说明 |
|---|---|
| 请求头 | 每个请求带 `iLink-App-Id`、`iLink-App-ClientVersion`（官方插件的行为） |
| 鉴权 | bot token；登录接口可能返回重定向基址，需要跟随 |
| 媒体 | 图片/语音等走 iLink 媒体接口，媒体内容用 **AES-128-ECB** 加解密 |
| 会话来源 | 登录后本地保存的 token 列表（`local_token_list`） |

**协议层不依赖 OpenClaw Runtime**：我们只用它的协议与媒体约定，会话/工具/记忆全部走 Harness。

### 单消费者约束（重要）

同一个微信账号**只能有一个消费者**。启动前做隔离 preflight（只读检查，fail-closed）：

1. `~/.openclaw/openclaw.json` 里 `plugins.entries.openclaw-weixin.enabled` 必须为 `false`；
2. 不能有正在运行的 OpenClaw 微信 gateway 进程（进程扫描失败也按"有问题"处理）。

通过后再抢一个原子 lease 文件，防止两个 harness 同时消费同一账号。

### 发送窗口：本链路最硬的一条平台约束

**平台只在"用户刚发过消息"的窗口内允许机器人发送消息。** 我们用四组对照实验验证过：

| 条件 | 结果 |
|---|---|
| 带（新鲜）token 发送 | 70 / 70 成功 |
| 不带 token 发送 | 0 / 13 成功（`ret=-2`） |
| 先 `notifystart` 再发 | 失败 |
| 用很旧的 token 发送 | 失败（385 分钟前的 token） |

结论：**不要把"主动推送"当成可靠通道**。工程上的应对（已实现）：

- 长任务（codex / opencode）**只推最终总结**；推不出去就把结果**停放**（默认 6 小时）；
- 停放的结果由工具 `bridge_results`（"codex/opencode 处理结果日志"）在用户下次说话时按需取回；
- 通知类消息永不阻塞队列、永不熔断（推不出去就算了，不影响对话）；
- 出站做限速（默认 2200ms 间隔）与批量上限，避免触发平台风控。

细节见 `docs/接口与微信平台约束.md`。

## 3. 后端：基于 DeepSeek Harness

后端是 **DeepSeek Harness**，我们以"插件/包"的方式接进去，而不是另起一套：

| 包 | 作用 |
|---|---|
| `packages/webhook/webhook-weixin` | 微信连接器：协议、会话宿主、入站/出站协调、记忆、桥接工具 |
| `packages/webhook/tool-codex` | 把 codex 包装成 Harness 工具（会话管理 + 执行） |
| `packages/webhook/tool-opencode` | 把 opencode 包装成 Harness 工具（带会话 id 预校验防呆） |
| `packages/llm/llm-pi-ai` | LLM 适配器；默认走 `openai-responses` |

- 模型调用默认协议：**`openai-responses`**（也支持 `chat-completions`）；
- 会话：一个微信联系人 → 一个 Harness Agent/Session；上下文清空 = 换 epoch + 删会话文件，而不是继续携带历史；
- 权限：本项目为了自动跑工具用了 `danger-full-access`。**这是危险配置**，请只在你能承受后果的机器上用，或改用审批模式；
- 模型故障转移：按 `quota / rate_limit / auth / model_missing` 分类，切换到下一个可用模型并重做刚才那条消息（额度类冷却 1 小时，鉴权类 24 小时）。

`harness_overlay/` 目录是本项目对 Harness 的改动（补丁 + 新增文件）与落位说明。

## 4. token 用量优化

做过的事，都有明确的取舍理由：

1. **压缩预算与模型窗口绑定**。压缩预算必须 ≤ 模型上下文窗口，否则"永不压缩"。
   实测踩坑：把 `compressionBudget` 设成 400000，而豆包窗口只有 256k → 历史永远压不动，越聊越贵。
   现在预设是 `compressionBudget: 180000 / retainTokens: 6000`（保留最近 6000 tokens 的近期状态与工具边界）。
2. **关掉无关的注入**。Harness 默认会往系统提示词里塞一段"你在 Web GUI 里…HMR…"的方位说明，
   对本场景全是浪费；`surfaceContext: false` 关掉后系统提示词从 8387 → **7153 字符**。
3. **工具结果落盘（spill）**。长输出只把摘要 + 文件路径回给模型，正文不反复进上下文。
4. **记忆不塞上下文，按需查**。时间线（`timeline_days/timeline_search/timeline_read`）、图谱（`relation_query`）、
   桥接结果（`bridge_results`）都是**工具**：需要时才读，读到的是窄结果。
5. **本地模型分块小调用**。图谱抽取按 ~2.5k 字符切块、每块单独调用，并带一份很小的"候选名单"把指代变成选择题——
   既省 token 也省显存（8GB 显存下"长上下文"是最贵的资源）。
6. **入站消息合并**。同一人连续发 3 条 → 攒 6 秒静默 → 合并成 1 次模型调用、1 条回复。
7. **重量任务只在空闲跑**。摘要与图谱更新都在"距最后一条对话 ≥3 小时"后才触发，不和聊天抢模型与显存。
8. **上下文清空走 epoch**，避免"清空后旧历史又被带回来"的隐性开销。

细节与数字见 `docs/token用量优化.md`。

## 5. 本地模型：Gemma 4 E4B（可选，想用就按下面来）

### Hugging Face 连接

| 项目 | 值 |
|---|---|
| HF 仓库 | `unsloth/gemma-4-E4B-it-GGUF` |
| HF 页面 | https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF |
| 国内镜像 | https://hf-mirror.com/unsloth/gemma-4-E4B-it-GGUF |

两个文件（`gemma/` 目录里有分块并行下载 + SHA-256 校验的脚本）：

| 文件 | 大小（字节） |
|---|---|
| `gemma-4-E4B-it-Q4_K_M.gguf` | 4 977 171 584 |
| `mmproj-BF16.gguf`（视觉投影器） | 991 552 320 |

### 配置方法（llama.cpp / llama-server）

```powershell
llama-server.exe `
  -m gemma-4-E4B-it-Q4_K_M.gguf `
  --mmproj mmproj-BF16.gguf `
  --host 127.0.0.1 --port 8080 `
  -c 32768 -ngl 99 `
  --jinja --reasoning off `
  --sleep-idle-seconds 120 `
  --alias gemma-4-E4B-it-Q4_K_M
```

要点：

- **只绑回环地址**，不要 `0.0.0.0`；
- `--reasoning off`：本地模型带隐藏推理容易把 `max_tokens` 吃光，工具循环会不稳；
- `--sleep-idle-seconds`：空闲自动卸显存，唤醒约十几秒（后台任务不急，值得）；
- **8GB 显存实测可用**（模型 + 视觉投影器约占 5GB）。链路里有"至少 5200MB 空闲显存才启动"的闸门，
  等不到就跳过本轮、稍后重试，不会硬上把对话挤 OOM。

### 接进 Harness

```yaml
protocol: openai-responses
baseURL: http://127.0.0.1:8080/v1
apiKeyEnv: LOCAL_LLM_API_KEY      # llama-server 不校验，但凭据层要非空，填 local-only
models:
  - id: gemma-4-E4B-it-Q4_K_M
    contextWindow: 32768
    maxTokens: 1024
```

用途：时间线摘要、知识图谱抽取、图片描述。它与云端对话模型**分工**，互不抢资源。

更多（下载校验、健康检查、Chat Completions / Responses 调用示例）见 `docs/本地模型与Gemma.md`。

## 6. 长期记忆①：时间数据库（时间线）

**作用域**：以**日期**为索引，**24 小时 = 一个 node**；每个 node 记录"这一天用户与管家的对话摘要"+"切实聊天记录"。
它跨会话永久保存，**不受上下文窗口清空影响**。

```
<记忆目录>/
  index.json                  # 日期索引：node 元数据（快速查询/统计）
  days/
    2026-09-20.jsonl          # 权威记录（append-only，一行一条）
    2026-09-20.summary.md     # 权威摘要（可人工编辑）
    2026-09-20.md             # 人类可读视图（由上面两者生成，勿手改）
```

**为什么 jsonl 与 md 分开**：jsonl 解析稳定、追加安全，是程序读写的权威；md 是给人（也给 agent）读的视图，
随时可从权威数据重建；摘要单独放一个文件，所以"重建视图"不会覆盖人工编辑过的摘要。

**更新规定**：

- 触发条件是**空闲**，不是整点：某天最后一条记录距现在 ≥ **3 小时**（`DSH_TIMELINE_IDLE_HOURS`）才生成/刷新摘要；
  调度器每 **5 分钟**看一次；
- 所有写操作都是"临时文件 + 原子替换"，并加文件锁（Windows 上并发 rename 会偶发 `EPERM`，需要重试）；
- 索引损坏会**自动重建**（数据不会"存在但不可发现"）；跨进程并发写不丢记录；
- 读取工具：`timeline_days`（有哪几天）、`timeline_search`（全库搜关键词）、`timeline_read`（按天/按条读原文）。

## 7. 长期记忆②：知识图谱

**作用**：存"人和事"的**事实**——谁是谁、什么关系、什么属性、哪天发生了什么事；
让管家能回答"之前说的那个人"这类指代，也能做"从 A 到 B 的关系链路"查询。
它是**只读工具**（`relation_query`）暴露给对话模型，写入不在模型手里。

**更新规定**（全部在空闲批量做，避免"边聊边改图"）：

1. 触发条件与时间线一致：距最后一条对话 **≥3 小时**；
2. 用**本地 Gemma** 从当天记录里抽取，按 **~2.5k 字符切块**，每块单独调用（输入永远很短）；
3. **滚动指代候选名单**：每次调用带上"最近提到过的人 + 图谱已有的人"，把"那个人是谁"变成选择题，
   而不是让模型自由回忆；上一块末尾与未解开的指代片段带入下一块（有界续接）；
4. **先抽取、后落库**：模型只输出"中文短协议事实"（一行一条），由**代码**解析并写库——
   模型不直接改图，格式错一行只丢一行；
5. **代码级别名归一**：说话人标签（我/主人/助手…）统一归到规范名，防止模型把"用户""助手"当成人名建节点
   （这是实际踩到的坑，还顺手编出过"职业=技术支持"这种属性）；
6. **逐节点审核**：只对"这批记录里被提到的人"各再调一次，且只喂与这个人有关的事实（几十到几百 token），
   相当于"递归遍历节点"，但代价不随图谱规模线性膨胀；
7. **id 永久不复用**：删掉节点也不重置计数器，避免历史引用错位；水位用 `(时间戳, id)`，
   同一毫秒的多条记录不会丢；
8. **可清空重消化**：清空图谱后下次空闲更新会把时间线里的历史重新消化一遍，并从时间线重建中心节点。

## 8. 外部 agent 桥（codex / opencode）

- 把 codex / opencode 包装成工具：派活、看会话列表、看聊天记录（`bridge_sessions`）；
- **只推最终总结**，不推中间过程；推不出去就停放（默认 6 小时），由 `bridge_results` 取回；
- 进度消息**只推中文**（避免把英文思维链漏给用户）；
- 会话 id 必须**整串照抄**且与工作区匹配——工具在 `run` 前会先 `session list` 核对，
  不存在就直接返回候选会话（防"猜 id"浪费一轮）；
- 能真正取消：取消时杀外部进程树（`taskkill /T /F`），并**如实**回报"已中断 N 个外部任务"。

## 9. 目录结构

```
微信电控AI管家/
├─ start_stack.py              # 一键启动：读配置 → 注入凭据 → 起 Harness → 起本地模型
├─ weixin_login.py             # 扫码登录，token 写入 config/secrets.json
├─ switch_model.py             # 命令行换默认模型
├─ console/                    # 控制台（Web 服务 + Electron 托盘壳）
│   ├─ server.mjs              #   本地 HTTP API（模型/工具/记忆/绑定/日志）
│   ├─ electron-main.js        #   托盘、单实例、自动重启后端
│   └─ public/                 #   前端页面
├─ tools/                      # 运维脚本（停止/注入/体检/追踪/重置/基准/备份/自启）
├─ config/                     # 配置模板与后端启动脚本（**没有任何密钥**）
│   ├─ modelConfig.example.json
│   ├─ secrets.example.json
│   └─ weixinProfile.patch.example.yml
├─ docs/                       # 设计文档（接口/记忆/Gemma/token/部署）
├─ gemma/                      # Gemma 下载与校验脚本 + 文件清单
└─ harness_overlay/            # 对 DeepSeek Harness 的改动（补丁 + 新增源码）
```

## 10. 快速开始

1. 装环境：Windows + Python 3.9（本项目用 `D:\py39`）+ Node 20+ + pnpm；本地模型需要 llama.cpp 与 8GB 显存（可选）。
2. 拷一个 `config/modelConfig.example.json` → `config/modelConfig.json`，`config/secrets.example.json` → `config/secrets.json`，
   把 API Key 填进 **`secrets.json`**（`modelConfig.json` 永远不写密钥）。
3. 把 `harness_overlay/` 里的改动应用到一份 DeepSeek Harness 检出（见该目录 README）。
4. 拷一个 `config/weixinProfile.patch.example.yml` → `config/weixinProfile.patch.yml`，**填你自己的人格提示词**。
5. `python start_stack.py` 起后端；`python weixin_login.py` 扫码绑定微信。
6. 需要图形界面就起 `console/`（`start-console.cmd`），需要开机自启用 `tools/install-autostart.ps1`。

## 11. 隐私与安全

**保证不进仓库**（`.gitignore` 已挡）：

| 内容 | 为什么 |
|---|---|
| `config/secrets.json` | 所有 API Key、微信 token、语音凭据 |
| `config/modelConfig.json` | 含账号标识与部署细节 |
| `config/weixinProfile.patch.yml` | 含**人格提示词正文**（本项目的性格资产） |
| `runtime/`、`*.log` | 日志里有聊天内容与账号指纹 |
| 时间线 / 图谱 / 状态库 | 真实聊天记录与人物关系，位于用户目录（不在项目内） |
| `备份/`、`审计产物/` | 历史快照，可能含旧配置 |

工程上的其他措施：

- 日志里**不写明文账号**，只写 `sha256(token)` 的短指纹；
- 密钥集中一个文件，模型定义与凭据分离，启动时合并注入，控制台也只在内存里合并；
- 人格提示词、密钥、数据库三者都不随备份走（备份只备代码与输出）。

> 建议本仓库保持 **private**。公开前请再次检查你自己新增的文件。

## 12. 许可与致谢

- 后端基于 **DeepSeek Harness**（`harness_overlay/` 内是我们对它做的改动）。
- 微信 iLink 协议与媒体处理抽取自 **OpenClaw 微信插件**（`@tencent-weixin/openclaw-weixin`），仅使用其协议约定，不依赖其运行时。
- 本地推理使用 **llama.cpp**；模型来自 **unsloth/gemma-4-E4B-it-GGUF**。
