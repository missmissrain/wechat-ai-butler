# 微信 Harness 统一后台启动脚本。
# 凭据**只**来自环境变量（由 start_stack.py 从 config/secrets.json 合并进模型配置后注入）。
# 刻意不做任何本地文件回退：回退曾在两条启动路径间引入不同的 token/密钥，
# 造成"有时正常、有时失效"的假象（见 ChatGPT 诊断与重构设计文档）。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$harnessRoot = Join-Path $workspaceRoot 'deepseek-harness'
$patchFile = Join-Path $PSScriptRoot 'weixinDoubaoProfile.patch.yml'
$disabledToolsPatchFile = Join-Path $workspaceRoot '废弃工具\disabledTools.patch.yml'
if (-not (Test-Path -LiteralPath $patchFile)) { throw "Harness patch not found: $patchFile" }
if (-not (Test-Path -LiteralPath $disabledToolsPatchFile)) { throw "Disabled-tools patch not found: $disabledToolsPatchFile" }

# 微信 iLink token：**只**来自环境变量（由 start_stack.py 从 config/secrets.json 合并注入）。
# 旧实现会回退去读 ~/.openclaw 的账号文件，那可能是另一枚过期 token，
# 导致"有时正常、有时不可用"的混乱（见重构设计文档与 ChatGPT 诊断）。
# 这里刻意不回退：缺失就直接失败，让问题暴露在启动阶段。
if ([string]::IsNullOrWhiteSpace($env:WEIXIN_ILINK_BOT_TOKEN)) {
  throw 'WEIXIN_ILINK_BOT_TOKEN 未注入：请用 start_stack.py 启动（token 唯一来源是 config/secrets.json）'
}

# 模型密钥不再强制走环境变量：start_stack.py 会把 config/secrets.json 的密钥合并后写进
# Harness 托管凭据文件 ~/.dsh/.credentials.yaml，由 harness 自己解析（环境变量只是可选覆盖）。
# 缺环境变量时这里只提示，不再终止启动。
if ([string]::IsNullOrWhiteSpace($env:ARK_API_KEY)) { Write-Host '[info] ARK_API_KEY 未设环境变量，将使用 ~/.dsh/.credentials.yaml' }
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { Write-Host '[info] OPENAI_API_KEY 未设环境变量，将使用 ~/.dsh/.credentials.yaml' }


# 非密钥默认值：单独运行时补齐，保证 patch 的 !!js 表达式不落空。
if ([string]::IsNullOrWhiteSpace($env:WEIXIN_ILINK_BASE_URL)) { $env:WEIXIN_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com' }
if ([string]::IsNullOrWhiteSpace($env:WEIXIN_ILINK_CDN_BASE_URL)) { $env:WEIXIN_ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c' }
if ([string]::IsNullOrWhiteSpace($env:DSH_DEFAULT_PROVIDER)) { $env:DSH_DEFAULT_PROVIDER = 'volcengine' }
if ([string]::IsNullOrWhiteSpace($env:DSH_DEFAULT_MODEL)) { $env:DSH_DEFAULT_MODEL = 'doubao-seed-2-1-pro-260628' }

# 中文短协议必须在**两条启动路径上一致**：统一启动器会设成 0，直接跑本脚本时
# 若留空则 harness 默认开启，导致同一系统的模型工具字段不一致（见重构设计文档诊断 11）。
if ([string]::IsNullOrWhiteSpace($env:DSH_WIRE_ZH)) { $env:DSH_WIRE_ZH = '0' }

# 诊断探针默认落地（与 start_stack.py 保持一致），便于事后排查。
if ([string]::IsNullOrWhiteSpace($env:DSH_WEIXIN_DEBUG_LOG)) { $env:DSH_WEIXIN_DEBUG_LOG = Join-Path $projectRoot 'runtime\weixin-debug.log' }
if ([string]::IsNullOrWhiteSpace($env:DSH_WEIXIN_PROBE_LOG)) { $env:DSH_WEIXIN_PROBE_LOG = Join-Path $projectRoot 'runtime\weixin-probe.log' }

$env:DSH_WEIXIN_WORKSPACE = $projectRoot
$env:DSH_WEIXIN_STATE_FILE = Join-Path $projectRoot 'runtime\weixin-route-state.json'
# 本机调试注入口（只绑 127.0.0.1）：POST 一条文本即走完整入站管线，
# 方便开发/回归测试时不必每次用真手机发微信。设 0 或留空即完全关闭。
if ([string]::IsNullOrWhiteSpace($env:DSH_WEIXIN_INJECT_PORT)) { $env:DSH_WEIXIN_INJECT_PORT = '3081' }
New-Item -ItemType Directory -Path (Split-Path -Parent $env:DSH_WEIXIN_STATE_FILE) -Force | Out-Null
Set-Location -LiteralPath $harnessRoot
pnpm dsh --patch $patchFile --patch $disabledToolsPatchFile --profile web --no-open
