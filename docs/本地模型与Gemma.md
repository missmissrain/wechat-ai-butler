# 本地模型与 Gemma 4 E4B

本地模型不是必需项：**不用它也能跑对话**，只是长期记忆（摘要 / 图谱抽取）和图片描述会缺一个"不花钱、不联网"的执行者。
本项目用它承担"时间不敏感、量大、反复调用"的脏活，把云端额度省给对话本身。

## 1. Hugging Face 连接

| 项目 | 值 |
|---|---|
| 仓库 | `unsloth/gemma-4-E4B-it-GGUF` |
| 页面 | https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF |
| 国内镜像 | https://hf-mirror.com/unsloth/gemma-4-E4B-it-GGUF |

下载文件（`gemma/downloadGemmaModel.py` 会从镜像按 HTTP Range 分块并行下载并校验 SHA-256）：

| 文件 | 大小（字节） | 说明 |
|---|---|---|
| `gemma-4-E4B-it-Q4_K_M.gguf` | 4 977 171 584 | 量化权重 |
| `mmproj-BF16.gguf` | 991 552 320 | 视觉投影器（图片描述用） |

下载脚本要点：

- 8 线程、64MB 分片，`curl.exe --range` 逐片下载，失败重试 4 次；
- 分片长度校验 → 合并 → 全文件 SHA-256 → 写 `下载校验.json`；
- 控制台输出 `[dqtm] 已下载/总字节` 进度（前台可见）。

## 2. 硬件与显存策略

- **8GB 显存可跑**（Q4_K_M 权重 + 视觉投影器约占 5GB）；
- `--sleep-idle-seconds 120`：空闲自动卸显存，服务常驻但显存可以让给别的程序；
- 链路侧有**显存闸门**：启动 Gemma 前要求至少 **5200MB 空闲显存**
  （`DSH_GEMMA_MIN_FREE_VRAM_MB`），最多等 **300 秒**（`DSH_GEMMA_VRAM_WAIT_S`）；
  等不到就**放弃本轮、稍后自动重试**——后台任务不急，不跟正在进行的对话抢。

## 3. 启动（llama.cpp / llama-server）

```powershell
llama-server.exe `
  -m gemma-4-E4B-it-Q4_K_M.gguf `
  --mmproj mmproj-BF16.gguf `
  --host 127.0.0.1 --port 8080 `
  -c 32768 `
  -ngl 99 `
  --jinja `
  --reasoning off `
  --sleep-idle-seconds 120 `
  -np 1 `
  --alias gemma-4-E4B-it-Q4_K_M
```

| 参数 | 为什么这么配 |
|---|---|
| `--host 127.0.0.1` | 只绑回环。**不要** `0.0.0.0`，除非另加认证/防火墙/CORS |
| `-c 32768` | 上下文；本项目按 ~2.5k 字符分块调用，32k 足够且省显存 |
| `-ngl 99` | 全部层放 GPU |
| `--jinja` | 用模型自带对话模板，工具调用格式才正确 |
| `--reasoning off` | 隐藏推理会把 `max_tokens` 吃光，工具循环不稳 |
| `--sleep-idle-seconds 120` | 空闲卸显存，唤醒约十几秒 |
| `-np 1` | 单并发，避免显存翻倍 |

**健康检查**：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health'
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/models'
```

## 4. 接进 Harness

适配器走 `openai-responses`（本项目的默认协议），也可用 `chat-completions`：

```yaml
protocol: openai-responses
baseURL: http://127.0.0.1:8080/v1
apiKeyEnv: LOCAL_LLM_API_KEY      # llama-server 不校验 key，但凭据层要非空
models:
  - id: gemma-4-E4B-it-Q4_K_M
    name: Gemma4 E4B 本地
    contextWindow: 32768
    maxTokens: 1024
```

`apiKeyEnv` 指向的变量在 `config/secrets.json` 里给一个占位值即可（例：`local-only`）。

实测链路：

```text
llm-pi-ai → openai-responses → http://127.0.0.1:8080/v1/responses → Gemma4
```

## 5. 调用示例

非流式 Chat Completions：

```powershell
$body = @{
  model = 'gemma-4-E4B-it-Q4_K_M'
  messages = @(@{ role = 'user'; content = '请用一句话介绍你自己。' })
  max_tokens = 128; temperature = 0.2; stream = $false
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/chat/completions' -Method Post -ContentType 'application/json' -Body $body
```

Responses：

```powershell
$body = @{
  model = 'gemma-4-E4B-it-Q4_K_M'
  input = '请返回字符串：Gemma4 OK'
  max_output_tokens = 128; stream = $false
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/responses' -Method Post -ContentType 'application/json' -Body $body
```

流式：请求里 `stream = $true`，响应是 SSE，逐行读 `data:`，遇到 `[DONE]` 结束。

## 6. 工具调用（function call）

- 请求带 `tools`（OpenAI 风格 function 定义），模型返回 `tool_calls`；
- **工具注册、权限、审批、执行、结果回传全部由 Harness 负责**，本地模型只负责"决定调哪个、参数是什么"；
- `--reasoning off` 下工具循环明显更稳；
- 冒烟测试口径：`tools` + `tool_choice: auto` + `max_tokens: 512`，验证能否稳定返回 `tool_calls` 并按结果给最终文本。

## 7. 用途与边界

| 用途 | 说明 |
|---|---|
| 时间线摘要 | 空闲时按天生成 |
| 图谱抽取 | 分块小调用 + 候选名单消解指代 |
| 图片描述 | 走 `mmproj` 视觉投影器 |

边界：

- `previous_response_id` **不要**当本地会话持久化依据——Harness 保存完整历史；
- 本机实例不校验 API key，但**不要**因此把它暴露到网络上；
- 多实例部署时，一个实例一个端口、一个显存预算。
