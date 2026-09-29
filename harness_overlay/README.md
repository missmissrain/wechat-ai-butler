# harness_overlay：对 DeepSeek Harness 的改动

后端是 **DeepSeek Harness**。本目录是我们对它的改动，分两部分：

```
harness_overlay/
├─ changes.patch     # 已跟踪文件的改动（git diff）
└─ new_files/        # 新增文件（按 Harness 仓库内路径镜像存放）
```

## 1. 怎么应用

假设你有一份 DeepSeek Harness 的检出（`<harness>`）：

```powershell
# ① 已跟踪文件的改动
git -C <harness> apply --3way harness_overlay\changes.patch

# ② 新增文件：按路径原样覆盖进检出
robocopy harness_overlay\new_files <harness> /E
```

两个部分**都必要**：补丁里只有"对已有文件的修改"，而像 `modelFailover.ts`、
`externalRuns.ts`、`sessionFiles.ts`、`bridgeSessionTools.ts` 这些是**新增文件**，不在补丁里。

`changes.patch` 里包含的改动范围（25 个文件，约 +1772 / -594 行）覆盖：

| 位置 | 改动要点 |
|---|---|
| `packages/webhook/webhook-weixin/**` | 微信连接器：会话宿主、入站/出站协调、记忆、工具、诊断注入口 |
| `packages/webhook/tool-codex`、`tool-opencode` | 外部 agent 工具（会话预校验防呆、取消时杀进程树） |
| `packages/llm/llm-pi-ai` | LLM 适配器与探测 |
| `packages/compaction/compaction-basic` | 压缩预算相关 |
| `packages/bundle/base` | 预设接线 |

## 2. 上位机（本项目）侧另有一份代码

本仓库根目录（`start_stack.py` / `console/` / `tools/`）是**部署与运维层**，
它不属于 Harness，而是"把 Harness 跑起来 + 管起来"的那一层。两边通过配置文件与本地端口对接：

- Harness 侧：读 `config/modelConfig.json` + `config/secrets.json`（合并后注入凭据）；
- 运维侧：起进程、写日志、控制台调本地管理口（注入/清空/重载预设等）。

## 3. 注意

- 本目录**不含**任何密钥、真实聊天数据、人格提示词正文；
- `new_files/` 里包含我们写的测试（`tests/*.spec.ts`），可用于回归；
- 应用补丁后请先跑一遍 Harness 的测试，再启动链路。
