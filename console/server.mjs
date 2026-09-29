/**
 * Agent 控制台 · 本地服务。
 *
 * 只绑 127.0.0.1，不对外网开放；零第三方依赖（Node 内置模块）。
 * 提供 5 个面板的数据：服务状态 / 模型选择 / 功能开关 / 日志 / token 用量。
 *
 * 所有写操作都只改"我们自己的配置文件"：
 * - 模型默认值 → config/modelConfig.json 的 defaultModel
 * - **密钥**（apiKey / 微信 token / TTS 凭据）→ config/secrets.json（与模型定义分开存放）
 * - 需要重启才生效的开关 → config/console.env（start_stack.py 会读它注入环境）
 * - 即时生效的开关（通知开关）→ 状态库 meta 表
 *
 * 用法：node console/server.mjs [端口]，默认 3082。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const HARNESS = resolve(PROJECT, '..', 'deepseek-harness')
const RUNTIME = join(PROJECT, 'runtime')
const CONFIG = join(PROJECT, 'config')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
const PORT = Number(process.argv[2] ?? process.env.CONSOLE_PORT ?? '3082')

/** 面板里展示的端口 → 说明 + **真实探活用的 URL**。 */
const PORTS = [
  { port: 3080, name: 'harness（Agent 本体）', probe: 'http://127.0.0.1:3080/' },
  { port: 3081, name: '调试注入口', probe: 'http://127.0.0.1:3081/' },
  { port: 8080, name: '本地 Gemma', probe: 'http://127.0.0.1:8080/v1/models' },
  { port: 4096, name: 'opencode server', probe: 'http://127.0.0.1:4096/' },
]

/**
 * 真实探活：发一个 HTTP 请求。
 *
 * 为什么不再只看端口：端口被**别的进程**占用时，端口探测会显示"在线"——
 * 那正是"连通性是个摆设"的来源。改成真发请求后：
 * - 只有"连不上 / 超时"才算掉线；
 * - **任何 HTTP 响应都算在线**（401/404 也说明服务在跑），并把状态码显示出来，
 *   这样"在线"是可核对的（例如 harness 返回 200/401、注入口返回 404 是正常的）。
 */
async function probe_http(url, timeout_ms = 2500) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout_ms) })
    return { up: true, detail: `HTTP ${response.status}` }
  } catch (error) {
    const reason = error?.cause?.code ?? error?.name ?? String(error)
    return { up: false, detail: String(reason).slice(0, 40) }
  }
}

/** 可展示的日志。 */
const LOGS = {
  probe: { name: '微信链路探针', path: join(RUNTIME, 'weixin-probe.log') },
  llm: { name: '模型请求（含 token 用量）', path: join(RUNTIME, 'llm-probe.log') },
  harness: { name: 'harness 运行日志', path: join(RUNTIME, 'harness-run.log') },
  opencode: { name: 'opencode server', path: join(RUNTIME, 'opencode-server.log') },
}

/** 需要重启才生效、由控制台管理的开关（写进 config/console.env）。 */
const ENV_TOGGLES = [
  {
    key: 'DSH_TIMELINE_ENABLED', label: '长期记忆（时间线）', kind: 'bool', default: '1',
    help: '按天记录对话与摘要，供检索旧事。关掉后不再写入。',
  },
  {
    key: 'DSH_TIMELINE_PERSIST_REASONING', label: '保存模型推理', kind: 'bool', default: '0',
    help: '把模型的思考过程也写进时间线。默认关（体积大、价值有限）。',
  },
  {
    key: 'DSH_TIMELINE_IDLE_HOURS', label: '空闲多久后更新摘要（小时）', kind: 'number', default: '3',
    help: '对话停下这么久才生成/更新当天摘要，避免边聊边改。',
  },
  {
    key: 'DSH_WIRE_ZH', label: '模型侧中文工具协议（zh-wire）', kind: 'select', default: '0',
    options: [
      { value: '0', label: '关闭：工具名/说明用英文原名（当前默认）' },
      { value: '1', label: '开启：内置工具显示中文短名与中文说明' },
    ],
    help: '开启后内置工具会变成中文短名（read→读、grep→搜、create_goal→建标），'
      + '描述也变中文；但我们自己的工具（opencode/codex/时间线/图谱）不在映射表里，仍是英文名，'
      + '而且人格提示词里提到的英文工具名会与中文短名不一致。要点开务必同步改人格提示词。',
  },
  {
    key: 'DSH_MEMORY_ENGINE', label: '记忆更新引擎', kind: 'select', default: 'gemma',
    options: [
      { value: 'gemma', label: '本地 Gemma（免费；显存被占用时等待空闲再拉起）' },
      { value: 'cloud', label: '云端模型（不占显存，直接调用；花额度）' },
    ],
    help: '时间线摘要 / 图谱抽取 / 图片描述都按这个引擎跑。跑游戏或训练时选云端可避免抢显存。',
  },
  {
    key: 'DSH_MEMORY_CLOUD_MODEL', label: '云端模型（provider/模型名）', kind: 'text',
    default: 'volcengine/doubao-seed-2-0-lite-260215',
    help: '仅当引擎选"云端"时生效；取值来自 config/modelConfig.json 的 provider 与模型 id（密钥在 secrets.json）。',
  },
  {
    key: 'DSH_GEMMA_MIN_FREE_VRAM_MB', label: '本地 Gemma 启动所需空闲显存（MB）', kind: 'number', default: '5200',
    help: '本地 Gemma 醒来约占 5.3GB；显存低于这个值就等，等不到就跳过本轮（不硬抢）。',
  },
  {
    key: 'DSH_GRAPH_CHUNK_CHARS', label: '图谱分块大小（字符）', kind: 'number', default: '8000',
    help: '每块越大调用越少，但实测越大越容易漏事实。',
  },
  {
    key: 'DSH_WEIXIN_HEARTBEAT_IDLE_MS', label: '心跳间隔（毫秒）', kind: 'number', default: '300000',
    help: '长任务中距上次输出超过这么久才补一条"还在处理"。',
  },
  {
    key: 'DSH_WEIXIN_SEND_MIN_GAP_MS', label: '发送最小间隔（毫秒）', kind: 'number', default: '2200',
    help: '同一会话两条消息之间至少间隔这么久，太快会触发平台限流。',
  },
  {
    key: 'DSH_OPENCODE_TIMEOUT_MS', label: 'opencode 任务超时（毫秒）', kind: 'number', default: '1800000',
    help: '单个 opencode 任务的硬超时，默认 30 分钟。',
  },
  {
    key: 'DSH_CODEX_TIMEOUT_MS', label: 'codex 任务超时（毫秒）', kind: 'number', default: '1800000',
    help: '单个 codex 任务的硬超时，默认 30 分钟。',
  },
]

const console_env_path = join(CONFIG, 'console.env')

// ── 工具 ────────────────────────────────────────────────────────────────────

function read_json(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function read_console_env() {
  const out = {}
  if (!existsSync(console_env_path)) return out
  for (const line of readFileSync(console_env_path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at > 0) out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

function write_console_env(values) {
  const lines = [
    '# 由控制台（console/server.mjs）写入；start_stack.py 启动时会读取并注入环境。',
    '# 需要重启后端服务才生效。手工编辑也可以。',
    '',
  ]
  for (const key of Object.keys(values).sort()) lines.push(`${key}=${values[key]}`)
  writeFileSync(console_env_path, `${lines.join('\n')}\n`, 'utf8')
}

/** 端口是否在监听（直接连一下，避免依赖外部命令）。 */
function port_listening(port) {
  return new Promise(resolve_promise => {
    import('node:net').then(({ Socket }) => {
      const socket = new Socket()
      socket.setTimeout(600)
      socket.once('connect', () => { socket.destroy(); resolve_promise(true) })
      socket.once('timeout', () => { socket.destroy(); resolve_promise(false) })
      socket.once('error', () => { socket.destroy(); resolve_promise(false) })
      socket.connect(port, '127.0.0.1')
    })
  })
}

/** 打开状态库（只读用；写 meta 才需要可写）。 */
function open_state_db() {
  const path = join(DSH_HOME, 'weixin-state.db')
  if (!existsSync(path)) return undefined
  return new DatabaseSync(path)
}

/** 读日志尾部若干行。 */
function tail_file(path, lines) {
  if (!existsSync(path)) return { exists: false, text: '' }
  const size = statSync(path).size
  // 只读尾部最多 512KB，避免大日志把内存吃满
  const read_bytes = Math.min(size, 512 * 1024)
  const fd = readFileSync(path)
  const slice = fd.subarray(Math.max(0, fd.length - read_bytes)).toString('utf8')
  const all = slice.split('\n')
  return { exists: true, text: all.slice(Math.max(0, all.length - lines - 1)).join('\n') }
}

/**
 * 大白话简介：工具名 → 一句话。
 *
 * 为什么不直接用 harness 目录里的官方说明：那是**给模型看的规格**——精确，但术语多
 * （"通过 seam 注入"、"schema 稳定"这种）。界面是给**人**看的，两份都展示：
 * 大白话在上、官方说明在下。没收录的工具直接显示官方说明，不会空着。
 */
const PLAIN_TOOLS = {
  // 文件
  read: '读文件内容（也能把图片读进来看）',
  read_image: '把一张图片读进来（需要能识图的模型）',
  write: '新建一个文件，或者把整个文件覆盖写成新内容',
  edit: '改文件里指定的那几行（精确替换，不会动别处）',
  str_replace_editor: '查看并替换文件内容（只能替换，不能整段重写）',
  glob: '按文件名找文件，比如"找出所有 .ts 文件"',
  grep: '按文件内容搜索，比如"哪些文件里提到过某个词"',
  // 命令行
  bash: '在电脑上跑命令（标准 Unix 风格；Windows 上一般是关掉的）',
  pwsh: '在 Windows 上跑 PowerShell 命令',
  run_code: '写一段小代码直接跑，用来把多个工具串起来一次性做完',
  terminal_open: '开一个终端，可以来回交互',
  terminal_send: '往终端里输入内容（相当于敲键盘）',
  terminal_read: '看终端里输出了什么',
  terminal_list: '看现在开着了哪些终端',
  terminal_signal: '给终端发个信号，比如强行中断（Ctrl+C）',
  terminal_close: '把终端关掉',
  job_list: '看还有哪些后台任务在跑',
  job_output: '看某个后台任务的输出',
  job_kill: '把某个后台任务停掉',
  // 待办与规划
  todo_write: '把要做的事写成一张待办清单（给自己排步骤）',
  exit_plan_mode: '退出"先出方案、等你点头再动手"的模式',
  create_goal: '立一个跨多轮的长期目标',
  get_goal: '看看当前的目标是什么',
  update_goal: '更新目标的进度或状态',
  present: '把做好的文件/成果正式交付给用户',
  // 联网与浏览器
  web_search: '上网搜一搜',
  web_fetch: '打开一个网址，把内容读回来',
  stagehand_navigate: '让浏览器打开某个网址',
  stagehand_observe: '看当前网页上有哪些能点的东西',
  stagehand_act: '让浏览器做一个动作（点击、输入等）',
  stagehand_extract: '从网页里把信息提取出来',
  stagehand_screenshot: '给网页截个图',
  stagehand_tabs: '管理浏览器的标签页',
  // 子任务 / 多代理
  subagent: '把一件事派给另一个代理去做（可以换模型）',
  list_subagent_models: '看有哪些模型可以派给子任务',
  list_agents: '看现在有哪些子任务/子代理在跑',
  interrupt_agent: '打断一个正在跑的子任务',
  send_message: '给正在跑的子任务捎句话',
  wait_agent: '等某个子任务结束',
  spawn_teammate: '拉一个"队友"代理来分工（实验功能）',
  team_task_create: '给团队建一个任务',
  team_task_list: '看团队里有哪些任务',
  team_task_get: '看某个团队任务的详情',
  team_task_update: '更新团队任务的状态',
  ralph: '同一件事反复做很多轮，每轮换一个全新的子代理',
  workflow: '跑一段多步骤的流程脚本',
  // 会话与代码信息
  session_search: '在过去的历史会话里搜内容',
  session_trace: '追查某一次调用从头到尾发生了什么',
  session_event_read: '读某个会话的事件记录',
  session_event_search: '在会话事件里搜关键字',
  session_event_trace: '追某个事件的来龙去脉',
  lsp: '问代码工具要类型、定义、引用这类信息',
  skill: '调用一份专门的技能说明（比如钉钉、Office 文档怎么操作）',
  ask_user_question: '有不确定的地方，先问用户再继续',
  // 定时 / 外部资源 / 高级
  schedule_create: '定一个定时任务（过一会儿或每隔一段时间做件事）',
  schedule_list: '看定了哪些定时任务',
  schedule_delete: '删掉一个定时任务',
  list_mcp_resources: '看有哪些外部资源（MCP）可用',
  list_mcp_resource_templates: '看有哪些外部资源模板可用',
  read_mcp_resource: '读一个外部资源的内容',
  cordis_define: '临时写一个小插件装进来用（高级）',
  cordis_run: '启动一个临时插件',
  cordis_stop: '停掉一个临时插件',
  cordis_undefine: '卸载一个临时插件',
  cordis_inspect_list: '看装了哪些临时插件',
  cordis_inspect_query: '查某个临时插件的运行状态',
  cordis_inspect_self: '看自己（这个代理）的内部状态',
  // 微信链路自己的
  codex: '把任务交给本机的 Codex 去做（独立编程助手）',
  opencode: '把任务交给本机的 opencode 去做（独立编程助手）',
  bridge_results: '查看"任务已经做完、但当时没能发给你"的处理结果',
  relation_query: '查家人朋友关系（知识图谱）：谁是谁、谁怎么称呼谁',
  timeline_days: '看长期记忆里记了哪些天、每天聊了多少',
  timeline_read: '读某一天聊天记录的原文',
  timeline_search: '在长期记忆里按关键词搜索',
  notify_control: '开关（或查看）任务完成汇报是否推到微信',
}

/** profile 里实际安装的包名集合（决定"能不能挂"——没装的包再怎么配也挂不上）。 */
function installed_packages() {
  const root = join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai')
  if (!existsSync(root)) return new Set()
  try {
    return new Set(readdirSync(root))
  } catch {
    return new Set()
  }
}

/**
 * 算出"这个包能不能一键挂、挂了要写哪几行"。
 *
 * @returns `{kind, reason, companions, rows}`；`kind='ready'` 才是可挂的。
 */
function mount_plan(name, installed, default_model, existing_ids = new Set()) {
  const id = name.replace('@deepseek-ai/dsh-', '')
  const short = name.replace('@deepseek-ai/', '')
  if (MOUNT_HOST_PROVIDED[name] !== undefined) {
    return { kind: 'host_provided', reason: MOUNT_HOST_PROVIDED[name], companions: [], rows: [] }
  }
  if (MOUNT_NEEDS_HOST_SERVICE[name] !== undefined) {
    return { kind: 'needs_host_service', reason: MOUNT_NEEDS_HOST_SERVICE[name], companions: [], rows: [] }
  }
  if (MOUNT_NEEDS_MANUAL[name] !== undefined) {
    return { kind: 'needs_manual', reason: MOUNT_NEEDS_MANUAL[name], companions: [], rows: [] }
  }
  if (!installed.has(short)) {
    return {
      kind: 'installed_missing',
      reason: `profile 里没装这个包（需要 dsh plugin add ${name}），配置改不动它`,
      companions: [],
      rows: [],
    }
  }
  const companions = []
  const rows = [`- id: ${id}`, `  name: '${name}'`]
  // 需要 provider 的（subagent）用当前默认模型自动补，省得用户自己填
  if (name === '@deepseek-ai/dsh-tool-subagent') {
    const provider = String(default_model.provider ?? '')
    const model = String(default_model.model ?? '')
    if (provider === '') {
      return { kind: 'needs_manual', reason: '需要 config.provider，但还没设置默认模型', companions, rows: [] }
    }
    rows.push('  config:', `    provider: ${provider}`)
    if (model !== '') rows.push(`    model: ${model}`)
  }
  // 同伴包**已经在 preset 里就不要再加**：两个包都要 `terminal` 时会出现重复的 `- id: terminal`，
  // 那份 preset 直接组装失败（YAML 里同一 id 出现两次）。实测会踩，所以这里必须去重。
  const needed = companions.filter(item => !existing_ids.has(item.id))
  return {
    kind: 'ready',
    reason: '',
    companions: needed,
    rows: [...rows, ...needed.flatMap(item => [`- id: ${item.id}`, `  name: '${item.name}'`])],
  }
}

/** 从 preset 文本里取所有已挂载的 id（含分组里的子插件）。 */
function preset_ids(text) {
  const ids = new Set()
  for (const match of text.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)) ids.add(match[1])
  return ids
}

/**
 * 挂载可行性：这三类包**挂了也没用**，界面直接说明原因，不让人白点。
 *
 * 这些结论是 2026-09-22 逐个实测出来的（20 个未挂载包里 14 个失败，原因分五类）：
 * - `host_provided`：宿主/基础组合已经注册了同名服务或工具，再加一行会报"已注册"；
 * - `installed_missing`：profile 里根本没装这个包（`dsh plugin add` 才能装，不是配置问题）；
 * - `needs_manual`：缺的是**内容型配置**（一段提示词），自动补等于替用户编人格，不做。
 */
const MOUNT_HOST_PROVIDED = {
  '@deepseek-ai/dsh-mcp-resources': '宿主已自带（再挂会报"服务已注册"）',
  '@deepseek-ai/dsh-tools': '宿主已自带 run_code 所在的 tools 服务',
  '@deepseek-ai/dsh-schedule': '基础组合已提供定时任务工具',
}
const MOUNT_NEEDS_MANUAL = {
  '@deepseek-ai/dsh-plan-mode': '需要 config.section（计划模式的政策文本），请手工写进 preset',
}

/**
 * 依赖**进程级服务**、因此挂不上的包。
 *
 * 实测（2026-09-22）：给它们补上提供服务的同伴包（`terminal` / `workflow`）也不行——
 * harness 明确拒绝："row(s) published process-global service(s) [terminals];
 * a preset service must sit …"。进程级服务只能由宿主整个进程提供，preset（agent 作用域）提供不了。
 * 想用它们得改**宿主层**（profile/base patch），不是这里加一行的事。
 */
const MOUNT_NEEDS_HOST_SERVICE = {
  '@deepseek-ai/dsh-tool-bash-persistent': '依赖进程级服务 terminals（preset 提供不了这种服务）',
  '@deepseek-ai/dsh-tool-pwsh-persistent': '依赖进程级服务 terminals（preset 提供不了这种服务）',
  '@deepseek-ai/dsh-tool-ralph': '依赖进程级服务 workflowEngine（preset 提供不了这种服务）',
  '@deepseek-ai/dsh-tool-workflow': '依赖进程级服务 workflowEngine（preset 提供不了这种服务）',
}

/**
 * 大白话简介：**插件包** → 一句话。
 *
 * 有些包根本不注册工具（人格、指令注入、上下文压缩），以前界面只能显示
 * "这个包里没有模型可见工具，或目录里查不到"——那句话既难懂又没用。
 */
const PLAIN_PACKAGES = {
  '@deepseek-ai/dsh-persona': '人格插件：把"她是谁、怎么说话"写进系统提示词（不注册工具）',
  '@deepseek-ai/dsh-agent-instructions': '指令插件：把项目里的说明文件（AGENTS.md 等）读进系统提示词（不注册工具）',
  '@deepseek-ai/dsh-compaction-basic': '上下文压缩：聊久了自动把旧内容摘要化，腾出上下文空间（不注册工具）',
  '@deepseek-ai/dsh-tool-fs': '读写文件：read / write / edit',
  '@deepseek-ai/dsh-tool-fs-search': '找文件：按名字找（glob）、按内容找（grep）',
  '@deepseek-ai/dsh-tool-jobs': '后台任务：看列表、看输出、终止',
  '@deepseek-ai/dsh-tool-todo': '待办清单：让她把要做的事列出来、标进度',
  '@deepseek-ai/dsh-tool-bash': '跑 Unix 命令（Windows 上默认关掉，用 pwsh 那个）',
  '@deepseek-ai/dsh-tool-pwsh': '跑 Windows PowerShell 命令',
  '@deepseek-ai/dsh-tool-bash-persistent': '常驻的 Unix 终端（同一个 shell 里连续敲命令）',
  '@deepseek-ai/dsh-tool-pwsh-persistent': '常驻的 PowerShell 终端（同一个 shell 里连续敲命令）',
  '@deepseek-ai/dsh-tool-terminal': '可反复交互的终端（开/读/写/中断/关闭）',
  '@deepseek-ai/dsh-tool-str-replace-editor': '另一种文件编辑器：只能替换指定文本',
  '@deepseek-ai/dsh-tool-web': '上网：搜索（web_search）和抓网页（web_fetch）',
  '@deepseek-ai/dsh-tool-skill': '技能说明书：按需加载一份专门的操作指南',
  '@deepseek-ai/dsh-tool-subagent': '派子任务给另外的代理去做（可以换模型）',
  '@deepseek-ai/dsh-tool-subagent-control': '管理子任务：列表、捎话、打断',
  '@deepseek-ai/dsh-tool-workflow': '多步流程脚本',
  '@deepseek-ai/dsh-tool-ralph': '反复重跑：每轮换一个全新子代理',
  '@deepseek-ai/dsh-tool-goal': '长期目标：立目标、看进度、更新状态',
  '@deepseek-ai/dsh-schedule': '定时任务：过一会儿/每隔一段时间做件事',
  '@deepseek-ai/dsh-tool-present': '交付成果：把文件正式呈现给用户',
  '@deepseek-ai/dsh-tool-session-query': '查历史会话：搜索、读事件、追调用链',
  '@deepseek-ai/dsh-tool-ask-user': '反问用户：有不确定的先问清楚',
  '@deepseek-ai/dsh-plan-mode': '计划模式：先出方案，等用户点头再动手',
  '@deepseek-ai/dsh-tool-lsp': '代码信息：类型、定义、引用（需要语言服务）',
  '@deepseek-ai/dsh-tool-cordis': '临时插件：自己写个小插件装上用（高级玩法）',
  '@deepseek-ai/dsh-tools': '工具编排：用一段代码把多个工具串起来跑（run_code）',
  '@deepseek-ai/dsh-mcp-resources': '外部资源（MCP）：列出并读取外接服务提供的内容',
  '@deepseek-ai/dsh-experimental-tool-agent-team': '多人协作（实验）：队友代理 + 团队任务板',
  '@deepseek-ai/dsh-experimental-browser-use-stagehand-native': '浏览器自动化（实验）：让 AI 自己开网页操作',
  '@deepseek-ai/dsh-tool-codex': '把任务交给本机的 Codex（独立编程助手）',
  '@deepseek-ai/dsh-tool-opencode': '把任务交给本机的 opencode（独立编程助手）',
  '@deepseek-ai/dsh-webhook-weixin': '微信链路自己的工具：长期记忆、关系查询、通知开关、桥结果',
}

/**
 * 读 harness 自带的**中文工具目录**，拿到"每个工具是干嘛的"。
 *
 * 为什么读文档而不是源码：源码里 description 分散在几十个包里，还要处理动态拼接；
 * 而 `docs/tool-catalog.zh.md` 是 harness 自己维护、和源码同步校验过的中文说明
 * （官方命令 `verify-tool-catalog` 会保证它不漂移），是现成的权威来源。
 *
 * @returns `{ packages: {包名: {tools: [], summary}}, tools: {工具名: 简介} }`
 */
function read_tool_catalog() {
  const path = join(HARNESS, 'docs', 'tool-catalog.zh.md')
  const packages = {}
  const tools = {}
  if (!existsSync(path)) return { packages, tools, path }
  const lines = readFileSync(path, 'utf8').split('\n')

  // ① 工具包映射表：| `@deepseek-ai/dsh-x` | `工具A`、`工具B` | … | … | … | 中文说明 |
  for (const line of lines) {
    const row = /^\|\s*`(@deepseek-ai\/[A-Za-z0-9-]+)`\s*\|(.+)$/.exec(line)
    if (row === null) continue
    const cells = row[2].split('|').map(cell => cell.trim())
    const names = [...(cells[0] ?? '').matchAll(/`([A-Za-z0-9_]+)`/g)].map(match => match[1])
    // 最后一格是"附加说明"（中文）；为空或是占位符时留空
    const summary = (cells[cells.length - 1] ?? '').trim()
    packages[row[1]] = {
      tools: names,
      summary: summary === '-' || summary === '' ? '' : summary,
    }
  }

  // ② 每个工具的独立小节：`### \`工具名\`` 后面第一段就是它的说明
  let current
  for (const line of lines) {
    const heading = /^###\s+`?([A-Za-z0-9_]+)`?\s*$/.exec(line)
    if (heading !== null) {
      current = heading[1]
      continue
    }
    if (current === undefined) continue
    const text = line.trim()
    if (text === '') continue
    if (text.startsWith('#') || text.startsWith('|') || text.startsWith('```') || text.startsWith('<')) {
      current = undefined
      continue
    }
    tools[current] = text
    current = undefined
  }
  return { packages, tools, path }
}

/**
 * iLink 客户端身份头。**缺了这两个头，重新扫码会另发一只新 bot、作废旧 token**
 * （官方插件 @tencent-weixin/openclaw-weixin 每个请求都带，必须照抄）。
 */
const ILINK_IDENTITY_HEADERS = {
  'iLink-App-Id': process.env.WEIXIN_ILINK_APP_ID ?? 'bot',
  'iLink-App-ClientVersion': process.env.WEIXIN_ILINK_APP_VERSION ?? '132105',
}

/** 扫码登录当前使用的接入点（服务端可能要求切换，如 scaned_but_redirect）。 */
let login_base = 'https://ilinkai.weixin.qq.com'

/**
 * 把二维码内容渲染成 PNG（data URL）。
 *
 * 为什么借 Python：`qrcode` 库本机已有（登录脚本本来就依赖它），而控制台刻意保持零依赖，
 * 前端也没有二维码库。用一次 python 子进程换取"不引入任何新依赖"是划算的。
 */
function render_qr_png(content) {
  const script = [
    'import base64, io, sys',
    'import qrcode',
    'code = qrcode.QRCode(border=2, box_size=8)',
    'code.add_data(sys.argv[1])',
    'code.make(fit=True)',
    'buffer = io.BytesIO()',
    "code.make_image().save(buffer, 'PNG')",
    "sys.stdout.write(base64.b64encode(buffer.getvalue()).decode())",
  ].join('\n')
  try {
    const output = execFileSync(resolve_python(), ['-c', script, content], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    return 'data:image/png;base64,' + output.trim()
  } catch (error) {
    // 渲染失败不该让整个绑定流程挂掉：前端会退回显示可点击的链接
    return ''
  }
}

/**
 * 把扫码得到的新 token 写回配置（备份 + 清失效标记），与 weixin_login.py 一致。
 *
 * **token 写进 config/secrets.json**（密钥的唯一存放处）；botId/botUserId/baseURL
 * 不是密钥，仍写在 modelConfig.json（它们是"这个 bot 是谁"的描述）。
 */
function write_weixin_token(token, bot_id, user_id, base_url) {
  write_secrets(secrets => {
    secrets.weixin = { ...secrets.weixin, token }
    return secrets
  })
  const path = join(CONFIG, 'modelConfig.json')
  const original = readFileSync(path, 'utf8')
  const config = JSON.parse(original)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(`${path}.bak-${stamp}`, original)
  const weixin = config.weixin ?? (config.weixin = {})
  if (base_url !== undefined) weixin.baseURL = base_url
  weixin.botId = bot_id
  weixin.botUserId = user_id
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  // 新凭据可用：**删除**运行期留下的"失效"标记。
  // 注意必须删掉而不是清空内容——启动器是按"文件是否存在"判断的。
  try {
    const flag = join(DSH_HOME, 'weixin-token-invalid.flag')
    if (existsSync(flag)) unlinkSync(flag)
  } catch { /* 标记删不掉不影响绑定 */ }
}

/**
 * 密钥文件（`config/secrets.json`）：**唯一**存放 apiKey / 微信 token / TTS 凭据的地方。
 *
 * 为什么与 modelConfig.json 分开：那个文件描述"用哪些模型"，经常要被分享、比对、
 * 拷进备份或贴给别人看；密钥混在里面等于随时可能泄出去。拆开之后：
 * - `modelConfig.json` 只有模型定义（可安全分享）
 * - `secrets.json` 只有密钥（不提交、不随备份走）
 */
const SECRETS = join(CONFIG, 'secrets.json')

/** 读 secrets.json（不存在就返回空骨架，方便首次填写）。 */
function read_secrets() {
  const data = read_json(SECRETS, {})
  return { providers: {}, weixin: {}, tts: {}, ...data }
}

/**
 * 改 secrets.json：传一个 `mutate` 函数，返回新对象；写前自动备份。
 *
 * 用回调而不是直接传对象，是为了"读-改-写"在一个地方完成，避免调用方漏读旧值把
 * 别的密钥覆盖掉（比如只改微信 token 时把 qwen 的 key 抹了）。
 */
function write_secrets(mutate) {
  const next = mutate(read_secrets())
  if (existsSync(SECRETS)) backup_file(SECRETS)
  writeFileSync(SECRETS, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 模型配置的**合并视图**：modelConfig.json + secrets.json 的密钥。
 *
 * 调用方（比如扫码登录要拿本地 token 列表）不需要关心密钥放在哪个文件里。
 */
function merged_model_config(fallback = { providers: {} }) {
  const config = read_json(join(CONFIG, 'modelConfig.json'), fallback)
  const secrets = read_json(SECRETS, {})
  for (const [name, block] of Object.entries(secrets.providers ?? {})) {
    if (config.providers?.[name] !== undefined && block?.apiKey) config.providers[name].apiKey = block.apiKey
  }
  if (secrets.weixin?.token) config.weixin = { ...config.weixin, token: secrets.weixin.token }
  if (secrets.tts !== undefined) config.tts = { ...config.tts, ...secrets.tts }
  return config
}

/**
 * 管理动作转发：清空记忆、看记忆体量。
 *
 * **必须由 harness 进程执行**，所以这里只是转发：
 * 时间线/图谱有内存缓存（外部删文件会留下脏缓存），会话上下文还被 agent 句柄持有
 * （删文件前必须先 dispose，否则会写出没有 header 的坏会话文件）。
 * 这些动作挂在 harness 的本机管理口上（默认 3081，只绑 127.0.0.1）。
 */
async function admin_call(action, body = {}) {
  const port = Number(process.env.DSH_WEIXIN_INJECT_PORT ?? '3081')
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}/admin/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    throw new Error(`连不上后端管理口（127.0.0.1:${port}）：${error.message}。后端没在运行？`)
  }
  const data = await response.json().catch(() => ({}))
  if (data.ok !== true) throw new Error(data.error ?? `管理动作 ${action} 失败（HTTP ${response.status}）`)
  return data
}

/**
 * 写文件前留一份带时间戳的备份，并**只保留最近 5 份**。
 *
 * 挂载/卸载工具、改压缩设置都会备份；不清理的话 preset 目录很快就会堆满
 * `.bak-*`（实测点几次就有四五个），翻起来比配置本身还长。
 */
function backup_file(path, keep = 5) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${path}.bak-${stamp}`
  try {
    copyFileSync(path, backup)
  } catch {
    return undefined
  }
  try {
    const dir = dirname(path)
    const base = `${basename(path)}.bak-`
    const olds = readdirSync(dir).filter(name => name.startsWith(base)).sort()
    for (const name of olds.slice(0, Math.max(0, olds.length - keep))) {
      try { unlinkSync(join(dir, name)) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 清理失败不影响主流程 */ }
  return backup
}

/** 当前使用的 agent preset 名（与 patch 里的 agent_preset 一致）。 */
const PRESET_NAME = process.env.DSH_AGENT_PRESET ?? 'weixin-lite'

/** preset 文件路径（在 DSH_HOME 下，不在项目里）。 */
function preset_path() {
  return join(DSH_HOME, '.agent-presets', PRESET_NAME, 'agent.cordis.yml')
}

/**
 * 读取 YAML 里某个"块标量"（`key: |` 后面缩进的那整段文本）。
 *
 * 不引 YAML 库：这里只需要读/写一个块，行处理足够且不引入依赖。
 */
function read_block_scalar(text, key) {
  const lines = text.split('\n')
  const head = new RegExp(`^(\\s*)${key}:\\s*[|>]-?\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = head.exec(lines[index] ?? '')
    if (match === null) continue
    const indent = (match[1] ?? '').length
    const collected = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? ''
      if (line.trim() !== '' && line.search(/\S/) <= indent) break
      collected.push(line.slice(Math.min(indent + 2, line.length)))
    }
    return collected.join('\n').replace(/\s+$/, '')
  }
  return ''
}

/** 把 `key: |` 的块标量整段替换为新内容；找不到该键时返回 undefined。 */
function write_block_scalar(text, key, content) {
  const lines = text.split('\n')
  const head = new RegExp(`^(\\s*)${key}:\\s*[|>]-?\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = head.exec(lines[index] ?? '')
    if (match === null) continue
    const indent = (match[1] ?? '').length + 2
    const pad = ' '.repeat(indent)
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end] ?? ''
      if (line.trim() !== '' && line.search(/\S/) <= indent - 1) break
      end += 1
    }
    const replacement = content.replace(/\s+$/, '').split('\n').map(line => line === '' ? '' : pad + line)
    return [...lines.slice(0, index + 1), ...replacement, ...lines.slice(end)].join('\n')
  }
  return undefined
}

/**
 * 求值 preset 里的 `!!js` 平台条件。
 *
 * 只认 `process.platform ===/!== 'xxx'` 这一种形态（preset 里实际只用这一种），
 * 不引入通用表达式求值——那是注入风险，而我们并不需要那么灵活。
 *
 * @returns true=条件成立、false=不成立、undefined=看不懂（界面照原样显示表达式）
 */
function eval_platform_condition(expression) {
  const match = /^process\.platform\s*(===|!==|==|!=)\s*['"]([a-z0-9]+)['"]$/.exec(expression)
  if (match === null) return undefined
  const equal = match[1] === '===' || match[1] === '=='
  const same = process.platform === match[2]
  return equal ? same : !same
}

/**
 * 扫描**我们自己的工具包**，提取"工具名 → 中文简介"。
 *
 * 为什么扫源码而不是维护一张映射表：新增工具时映射表必然忘记更新（然后就显示不出来）。
 * 我们的工具 `description` 本来就是中文，且规范是"第一个字符串就是一句话简介"，
 * 所以直接从源码取第一行即可——**以后加工具，GUI 自动就有简介**，零维护。
 *
 * 识别形态（本项目所有工具都是这个写法）：
 * ```
 * defineTool({
 *   name: 'timeline_search',
 *   description: [
 *     '在长期记忆里按关键词搜索…',
 *     …
 *   ].join('\n'),
 * ```
 */
function scan_own_tools() {
  const packages = {}
  const tools = {}
  const roots = [
    join(HARNESS, 'packages', 'webhook', 'webhook-weixin', 'src'),
    join(HARNESS, 'packages', 'webhook', 'tool-codex', 'src'),
    join(HARNESS, 'packages', 'webhook', 'tool-opencode', 'src'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const file of walk_ts_files(root)) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // 文件 → 它注册了哪些工具（用于把 preset 行与工具对应起来）
      const registered = []
      for (const match of text.matchAll(/name:\s*'([a-z][a-z0-9_]*)',\s*\n\s*description:\s*\[?\s*\n?\s*'([^']+)'/g)) {
        const [, name, summary] = match
        registered.push(name)
        if (tools[name] === undefined) tools[name] = summary.trim()
      }
      if (registered.length > 0) {
        // 按**包目录**建索引（不是文件路径）——调用方拿到的是"哪个包"，不是"哪个文件"
        const key = dirname(file).replace(HARNESS, '').replace(/\\/g, '/')
        const bucket = packages[key] ?? { tools: [], summary: '' }
        bucket.tools.push(...registered.filter(name => !bucket.tools.includes(name)))
        packages[key] = bucket
      }
    }
  }
  return { packages, tools }
}

/** 递归列出目录下的 .ts 文件（跳过 node_modules / lib）。 */
function walk_ts_files(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib') stack.push(join(dir, entry.name))
      } else if (entry.name.endsWith('.ts')) {
        out.push(join(dir, entry.name))
      }
    }
  }
  return out
}

/**
 * 解析 preset 的顶层插件行：`- id: xxx` / `name: '...'` / 可选 `disabled: ...`。
 *
 * 用手写行解析而不是 YAML 库：preset 里含 `!!js` 表达式与深层 config，
 * 我们只想拿到"有哪些插件行、是否被禁用"，行处理最稳且零依赖。
 */
function parse_preset_rows(text) {
  const rows = []
  let current = null
  // 缩进的 `- id:` 是**分组里的子插件**（例如 compaction 组里的 compaction-basic）。
  // 以前只认顶格行，于是子插件在界面上完全看不到。
  let child = null
  for (const line of text.split('\n')) {
    const id_match = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id_match !== null) {
      const indent = id_match[1].length
      const id = id_match[2]
      if (indent === 0) {
        if (current !== null) rows.push(current)
        current = { id, name: '', disabled: false, children: [] }
        child = null
      } else if (current !== null) {
        child = { id, name: '', disabled: false }
        current.children.push(child)
      }
      continue
    }
    const target = child ?? current
    if (target === null) continue
    const name_match = /^\s+name:\s*(.+?)\s*$/.exec(line)
    if (name_match !== null && target.name === '') {
      target.name = name_match[1].replace(/^['"]|['"]$/g, '')
      continue
    }
    const disabled_match = /^\s+disabled:\s*(.+?)\s*$/.exec(line)
    if (disabled_match !== null) {
      const value = disabled_match[1].trim()
      if (value === 'true') {
        target.disabled = true
        target.disabled_reason = '显式禁用'
      } else if (value.startsWith('!!js')) {
        // 平台条件（例如 bash 只在非 Windows 启用）：**要按本机实际平台求值**，
        // 不能一律当成"已禁用"（那样界面上会显示错的挂载状态）。
        const evaluated = eval_platform_condition(value.slice(4).trim())
        target.disabled = evaluated === true
        target.disabled_reason = evaluated === undefined
          ? `平台条件：${value.slice(4).trim()}`
          : evaluated ? `平台条件不满足（${process.platform}）` : '平台条件满足'
      }
    }
  }
  if (current !== null) rows.push(current)
  return rows
}

/**
 * 从 preset 里**整块删掉**一个插件行（含它下面缩进的 config）。
 *
 * 顶格 `- id: x` 开头，直到下一个顶格 `- id:` 或文件结束；中间的空行也一起带走，
 * 免得反复挂载/卸载后留下一堆空行。找不到该行返回 undefined。
 */
function remove_preset_row(text, id) {
  const lines = text.split('\n')
  const pattern = new RegExp(`^-\\s+id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? '')) { start = index; break }
  }
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && !/^-\s+id:/.test(lines[end] ?? '')) end += 1
  // 把它前面紧邻的空行也一起删掉
  let head = start
  while (head > 0 && (lines[head - 1] ?? '').trim() === '') head -= 1
  return [...lines.slice(0, head), ...lines.slice(end)].join('\n')
}

/**
 * 设置某个插件行的禁用状态。
 *
 * - 要禁用且该行没有 `disabled:` → 在 `name:` 之后插一行 `disabled: true`；
 * - 要禁用但已有（可能是 `!!js` 表达式）→ 覆盖为 `disabled: true`；
 * - 要启用且当前是硬编码 `true` → 删掉那一行；若是 `!!js` 表达式 → 保留（那是平台条件，不该动）。
 */
function set_preset_row_disabled(text, id, disabled) {
  const lines = text.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (new RegExp(`^-\\s+id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(lines[index] ?? '')) {
      start = index
      break
    }
    if (/^-\s+id:/.test(lines[index] ?? '') && start >= 0) break
  }
  if (start < 0) return undefined

  // 找到本行的范围（下一个顶层 `- id:` 之前）
  let end = start + 1
  while (end < lines.length && !/^-\s+id:/.test(lines[end] ?? '')) end += 1

  let disabled_at = -1
  let name_at = -1
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s+disabled:/.test(lines[index] ?? '')) disabled_at = index
    if (/^\s+name:/.test(lines[index] ?? '')) name_at = index
  }

  if (disabled) {
    if (disabled_at >= 0) lines[disabled_at] = '  disabled: true'
    else lines.splice((name_at >= 0 ? name_at : start) + 1, 0, '  disabled: true')
    return lines.join('\n')
  }
  // 启用：只删掉硬编码的 true；`!!js` 是平台条件，保留
  if (disabled_at >= 0 && /^\s+disabled:\s*true\s*$/.test(lines[disabled_at] ?? '')) {
    lines.splice(disabled_at, 1)
  }
  return lines.join('\n')
}

/** 模型 id → 定价（从 providers 里找）。 */
function pricing_index(cfg) {
  const index = {}
  for (const provider of Object.values(cfg.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (model.pricing) index[model.id] = model.pricing
    }
  }
  return index
}

/** 聚合 llm-probe.log 的 token 用量。 */
function usage_summary(days) {
  const path = LOGS.llm.path
  if (!existsSync(path)) return { days: [], total: {}, by_model: [] }
  const cfg = read_json(join(CONFIG, 'modelConfig.json'), { providers: {} })
  const prices = pricing_index(cfg)
  const since = Date.now() - days * 24 * 3600_000

  const by_day = {}
  const by_model = {}
  const total = { input: 0, output: 0, cacheRead: 0, totalTokens: 0, calls: 0, cost: 0 }

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '' || !line.includes('"usage"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.kind !== 'event' || d.type !== 'done' || d.usage === undefined) continue
    const at = Date.parse(d.at)
    if (Number.isFinite(at) && at < since) continue
    const date = (d.at ?? '').slice(0, 10)
    const usage = d.usage
    const price = prices[d.model]
    // 成本按定价表估算（元/M token）；没有定价就不算，避免编造。
    // 豆包是**按总输入长度分档**计价，所以支持 tiers：取"输入 token 落在哪一档"。
    let cost = 0
    if (price) {
      const tiers = Array.isArray(price.tiers) ? price.tiers : []
      const tier = tiers.find(item => (usage.input ?? 0) <= (item.maxInputTokens ?? Infinity)) ?? tiers.at(-1)
      const rate = tier ?? price
      cost = ((usage.input ?? 0) * (rate.input ?? 0)
        + (usage.cacheRead ?? 0) * (rate.cacheRead ?? rate.input ?? 0)
        + (usage.output ?? 0) * (rate.output ?? 0)) / 1_000_000
    }
    const day = by_day[date] ??= { date, input: 0, output: 0, cacheRead: 0, totalTokens: 0, calls: 0, cost: 0 }
    const model = by_model[d.model] ??= { model: d.model, input: 0, output: 0, cacheRead: 0, totalTokens: 0, calls: 0, cost: 0, priced: Boolean(price) }
    for (const target of [day, model, total]) {
      target.input += usage.input ?? 0
      target.output += usage.output ?? 0
      target.cacheRead += usage.cacheRead ?? 0
      target.totalTokens += usage.totalTokens ?? 0
      target.calls += 1
      target.cost += cost
    }
  }

  return {
    days: Object.values(by_day).sort((a, b) => a.date.localeCompare(b.date)),
    by_model: Object.values(by_model).sort((a, b) => b.totalTokens - a.totalTokens),
    total,
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

const api = {
  async overview() {
    // 真实探活（并发，避免串行等待拖慢面板）
    const services = await Promise.all(PORTS.map(async item => {
      const probe = await probe_http(item.probe)
      return { port: item.port, name: item.name, up: probe.up, detail: probe.detail }
    }))
    const state = open_state_db()
    let outbox = []
    let deliveries = 0
    if (state) {
      try {
        outbox = state.prepare('SELECT status, kind, COUNT(*) AS n FROM outbox GROUP BY status, kind').all()
        deliveries = state.prepare('SELECT COUNT(*) AS n FROM delivery').get()?.n ?? 0
      } catch { /* 库可能还没建表 */ }
      state.close()
    }
    const timeline_index = read_json(join(DSH_HOME, 'timeline', 'index.json'), { days: {} })
    const days = Object.keys(timeline_index.days ?? {})
    return {
      services,
      harness_root: HARNESS,
      project_root: PROJECT,
      outbox,
      deliveries,
      memory: {
        timeline_days: days.length,
        last_day: days.sort().at(-1) ?? null,
        graph: read_json(join(DSH_HOME, 'graph', 'index.json'), {}).last_person_seq ?? 0,
      },
    }
  },

  /** 故障转移状态：当前模型、候选顺序、以及哪些模型正在冷却。 */
  async failover() {
    const cfg = read_json(join(CONFIG, 'modelConfig.json'), {})
    let runtime = { current: null, dead: [] }
    try {
      runtime = await admin_call('failover-status', {})
    } catch { /* 后端没起来就只显示配置里的顺序 */ }
    return {
      enabled: cfg.failover?.enabled !== false,
      order: (cfg.failover?.order ?? []).map(item => `${item.provider}/${item.model}`),
      current: runtime.current ?? cfg.defaultModel ?? null,
      dead: runtime.dead ?? [],
    }
  },

  models() {
    const cfg = read_json(join(CONFIG, 'modelConfig.json'), { providers: {}, defaultModel: {} })
    return {
      default: cfg.defaultModel ?? {},
      chain: (process.env.DSH_OPENCODE_MODEL_CHAIN ?? '').split(',').filter(Boolean),
      providers: Object.entries(cfg.providers ?? {}).map(([id, value]) => ({
        id,
        baseURL: value.baseURL,
        models: (value.models ?? []).map(model => ({
          id: model.id, name: model.name ?? model.id,
          input: model.input ?? [], pricing: model.pricing ?? null,
          contextWindow: model.contextWindow ?? null,
        })),
      })),
    }
  },

  set_default_model(body) {
    const provider = String(body.provider ?? '').trim()
    const model = String(body.model ?? '').trim()
    const path = join(CONFIG, 'modelConfig.json')
    const cfg = read_json(path, undefined)
    if (cfg === undefined) throw new Error('读不到 modelConfig.json')
    if (cfg.providers?.[provider] === undefined) throw new Error(`没有 provider：${provider}`)
    if (!(cfg.providers[provider].models ?? []).some(item => item.id === model)) {
      throw new Error(`provider ${provider} 下没有模型：${model}`)
    }
    cfg.defaultModel = { provider, model }
    cfg.updatedAt = new Date().toISOString()
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
    return { ok: true, default: cfg.defaultModel, note: '已写入 modelConfig.json，重启后端服务后生效' }
  },

  /**
   * 设置某个模型的**上下文窗口**（tokens）。
   *
   * 这个值决定 harness 的"模型容量"：压缩阈值如果不显式给，就是它的 80%。
   * 写进 modelConfig.json 的模型条目，启动器会同步进 settings.yaml 的
   * `models[].contextWindow`（provider 级还有 `defaultContextWindow` 兜底）。
   */
  set_context_window(body) {
    const provider = String(body.provider ?? '').trim()
    const model = String(body.model ?? '').trim()
    const tokens = Math.floor(Number(body.tokens))
    if (!Number.isFinite(tokens) || tokens < 4_000 || tokens > 4_000_000) {
      throw new Error('上下文窗口需要是 4000 ~ 4000000 之间的整数')
    }
    const path = join(CONFIG, 'modelConfig.json')
    const cfg = read_json(path, undefined)
    if (cfg === undefined) throw new Error('读不到 modelConfig.json')
    const entry = (cfg.providers?.[provider]?.models ?? []).find(item => item.id === model)
    if (entry === undefined) throw new Error(`provider ${provider} 下没有模型：${model}`)
    entry.contextWindow = tokens
    cfg.updatedAt = new Date().toISOString()
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
    return {
      ok: true, provider, model, contextWindow: tokens,
      note: `已把 ${model} 的上下文窗口设为 ${tokens.toLocaleString('zh-CN')} tokens，重启后端服务后生效`,
    }
  },

  /**
   * 读/写**压缩设置**（preset 里 compaction-basic 的两个数）。
   *
   * - `compressionBudget`：攒到多少 token 就开始压缩（显式值优先于按比例算）；
   * - `retainTokens`：压缩后保留最近多少 token 的原文。
   */
  compaction() {
    const text = existsSync(preset_path()) ? readFileSync(preset_path(), 'utf8') : ''
    const read = key => {
      const match = new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, 'm').exec(text)
      return match === null ? null : Number(match[1])
    }
    const model = read_json(join(CONFIG, 'modelConfig.json'), { defaultModel: {} }).defaultModel ?? {}
    return {
      compressionBudget: read('compressionBudget'),
      retainTokens: read('retainTokens'),
      maxTokens: read('maxTokens'),
      preset: PRESET_NAME,
      model,
    }
  },

  set_compaction(body) {
    const path = preset_path()
    if (!existsSync(path)) throw new Error('找不到 preset：' + path)
    const budget = Math.floor(Number(body.compressionBudget))
    const retain = Math.floor(Number(body.retainTokens))
    if (!Number.isFinite(budget) || budget < 4_000 || budget > 4_000_000) {
      throw new Error('压缩阈值需要是 4000 ~ 4000000 之间的整数')
    }
    if (!Number.isFinite(retain) || retain < 1_000 || retain > 200_000) {
      throw new Error('保留量需要是 1000 ~ 200000 之间的整数')
    }
    const original = readFileSync(path, 'utf8')
    const updated = original
      .replace(/^(\s*compressionBudget:\s*)\d+\s*$/m, `$1${budget}`)
      .replace(/^(\s*retainTokens:\s*)\d+\s*$/m, `$1${retain}`)
    if (updated === original) throw new Error('preset 里没找到 compressionBudget / retainTokens，未做修改')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup_file(path)
    writeFileSync(path, updated, 'utf8')
    return {
      ok: true, compressionBudget: budget, retainTokens: retain,
      note: '已写入 preset（含备份）。点「重载 preset」即可对下一个新会话生效',
    }
  },

  /** 重新解析 preset（挂载工具或改压缩设置后调用），失败会自动回滚。 */
  async reload_preset() {
    const result = await admin_call('reload-preset', {})
    return { ok: true, ...result, note: 'preset 已重新解析并验证通过（新会话生效）' }
  },

  /**
   * 微信绑定的第一步：取二维码。
   *
   * 关键点（照抄 weixin_login.py，踩过的坑）：
   * - 必须带 `iLink-App-Id` / `iLink-App-ClientVersion` 两个身份头，并把**本地已有 token**
   *   放进 `local_token_list`。否则服务端会把它当成陌生客户端，**重新扫码会另发一只新 bot**，
   *   旧 token 立刻失效（表现为"token 老是过期、每次都要手机解绑"）。
   * - 返回的 `qrcode_img_content` 是一个**链接**，要自己渲染成二维码图片。
   */
  async weixin_qr() {
    // 用**合并视图**：token 在 secrets.json，baseURL 在 modelConfig.json，这里都拿得到
    const config = merged_model_config()
    const weixin = config.weixin ?? {}
    const base = String(weixin.baseURL ?? 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')
    const local_tokens = weixin.token ? [String(weixin.token)] : []
    const response = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: 'POST',
      headers: { ...ILINK_IDENTITY_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_token_list: local_tokens }),
    })
    const data = await response.json()
    if (data.qrcode === undefined || data.qrcode_img_content === undefined) {
      throw new Error('服务端未返回二维码：' + JSON.stringify(data).slice(0, 200))
    }
    login_base = base
    return {
      qrcode: data.qrcode,
      content: data.qrcode_img_content,
      image: render_qr_png(String(data.qrcode_img_content)),
      base,
    }
  },

  /**
   * 轮询扫码状态；确认后把新 token 写回配置（含备份 + 清失效标记）。
   *
   * 与 weixin_login.py 的行为一致，这样"在界面上扫码"和"命令行扫码"结果相同。
   */
  async weixin_qr_status(qrcode) {
    const url = `${login_base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    let data
    try {
      const response = await fetch(url, { headers: ILINK_IDENTITY_HEADERS, signal: AbortSignal.timeout(40_000) })
      data = await response.json()
    } catch {
      // 网络抖动 / 网关超时视为 wait，继续轮询（与官方插件一致）
      return { status: 'wait' }
    }
    if (data.status === 'scaned_but_redirect' && data.redirect_host) {
      login_base = 'https://' + String(data.redirect_host)
      return { status: 'scaned_but_redirect', base: login_base }
    }
    if (data.status === 'confirmed') {
      const token = data.bot_token
      const bot_id = data.ilink_bot_id
      if (token === undefined || bot_id === undefined) {
        throw new Error('服务端未返回 ilink_bot_id / bot_token')
      }
      write_weixin_token(String(token), String(bot_id), String(data.ilink_user_id ?? ''),
        data.baseurl === undefined ? undefined : String(data.baseurl))
      return { status: 'confirmed', bot_id, note: '新凭据已写入，重启后端服务后生效' }
    }
    return { status: data.status ?? 'wait', ...data.redirect_host === undefined ? {} : { base: data.redirect_host } }
  },

  /** 读人格提示词（在宿主 patch 的 system-prompt.personaPrefix 里）。 */
  persona() {
    const path = join(CONFIG, 'weixinDoubaoProfile.patch.yml')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    return { path, text: read_block_scalar(text, 'personaPrefix') }
  },

  /** 写回人格提示词（写入前自动备份）。 */
  set_persona(body) {
    const next = String(body.text ?? '')
    if (next.trim() === '') throw new Error('人格提示词不能为空')
    const path = join(CONFIG, 'weixinDoubaoProfile.patch.yml')
    if (!existsSync(path)) throw new Error('找不到 patch 文件：' + path)
    const original = readFileSync(path, 'utf8')
    const updated = write_block_scalar(original, 'personaPrefix', next)
    if (updated === undefined) throw new Error('patch 里没找到 personaPrefix 块，未做修改')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backup_file(path)
    writeFileSync(path, updated, 'utf8')
    return { ok: true, note: '已写入人格提示词（含备份），重启后端服务后生效' }
  },

  /**
   * 列出 preset 里挂载的工具插件：**带"这个工具是干嘛的"中文说明**。
   *
   * 说明来自 harness 的中文工具目录（与源码同步校验过），所以界面展示的是权威简介，
   * 而不是我们另写一份容易过期的解释。
   */
  tools() {
    const path = preset_path()
    const catalog = read_tool_catalog()
    const own = scan_own_tools()
    const rows = existsSync(path) ? parse_preset_rows(readFileSync(path, 'utf8')) : []

    // 扫描结果按"文件所在目录"记录，而工具文件会散落在子目录里（src/memory、src/coordination…），
    // 所以按**包前缀**收集，而不是精确匹配某个目录。
    const collect = prefix => Object.entries(own.packages)
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, value]) => value.tools)
      .filter((name, index, all) => all.indexOf(name) === index)

    const own_by_package = {
      '@deepseek-ai/dsh-tool-codex': collect('/packages/webhook/tool-codex/src'),
      '@deepseek-ai/dsh-tool-opencode': collect('/packages/webhook/tool-opencode/src'),
    }
    // webhook-weixin 的工具是**运行期动态注册**的（不是 preset 行），单独成一组
    const runtime_tools = collect('/packages/webhook/webhook-weixin/src')

    // 两份简介都带上：大白话给人看、官方说明给考据用
    const describe = names => names.map(name => ({
      name,
      plain: PLAIN_TOOLS[name] ?? '',
      official: catalog.tools[name] ?? own.tools[name] ?? '',
    }))

    const mounted_names = new Set(rows.map(row => row.name))
    const described = rows.map(row => {
      const entry = catalog.packages[row.name]
      const names = (entry?.tools ?? []).concat(own_by_package[row.name] ?? [])
      return {
        ...row,
        mounted: true,
        kind: names.length > 0 ? 'tool' : 'plugin',
        tools: describe(names),
        // 分组行（cordis:group）不是插件，单独说清楚
        summary: PLAIN_PACKAGES[row.name]
          ?? entry?.summary
          ?? (row.name === 'cordis:group' ? '分组：把几个插件打包在一起，可以共享/隔离它们的状态（本身不是插件）' : ''),
        official_summary: entry?.summary ?? '',
        // 分组里的子插件也带上简介，否则界面上只能看到一个 id
        children: (row.children ?? []).map(item => ({
          ...item,
          summary: PLAIN_PACKAGES[item.name] ?? '',
        })),
      }
    })

    // **目录里有、但 preset 没挂的工具包**：全部列出来。
    // 之前只列 preset 行，所以"能挂但没挂"的工具在界面上根本看不到。
    const installed = installed_packages()
    for (const [name, entry] of Object.entries(catalog.packages)) {
      if (mounted_names.has(name)) continue
      const names = (entry.tools ?? []).concat(own_by_package[name] ?? [])
      if (names.length === 0) continue
      const id = name.replace('@deepseek-ai/dsh-', '')
      const mount = mount_plan(
        name, installed, read_json(join(CONFIG, 'modelConfig.json'), {}).defaultModel ?? {},
        preset_ids(existsSync(path) ? readFileSync(path, 'utf8') : ''),
      )
      described.push({
        id,
        name,
        mounted: false,
        disabled: false,
        disabled_reason: '',
        kind: 'tool',
        tools: describe(names),
        summary: PLAIN_PACKAGES[name] ?? entry.summary ?? '',
        official_summary: entry.summary ?? '',
        // 能不能一键挂、不能的话为什么
        mount_kind: mount.kind,
        mount_reason: mount.reason,
        companions: mount.companions,
        preset_row: mount.rows.map(row => row.trimEnd()).join('\n'),
      })
    }

    if (runtime_tools.length > 0) {
      described.push({
        id: 'webhook-weixin（运行期注册）',
        name: '@deepseek-ai/dsh-webhook-weixin',
        mounted: true,
        disabled: false,
        disabled_reason: '随微信链路自动挂载',
        kind: 'runtime',
        summary: PLAIN_PACKAGES['@deepseek-ai/dsh-webhook-weixin'],
        official_summary: '',
        tools: describe(runtime_tools),
      })
    }

    return {
      path,
      preset: PRESET_NAME,
      catalog_path: catalog.path,
      platform: process.platform,
      counts: {
        mounted: described.filter(row => row.mounted).length,
        available: described.filter(row => row.mounted !== true).length,
        tools: described.reduce((sum, row) => sum + row.tools.length, 0),
      },
      rows: described,
    }
  },

  /**
   * 工具插件的挂载开关（**GUI 可控**）。
   *
   * 三种情况：
   * - 已挂载的行：切换 `disabled`（禁用/启用，不动挂载本身）；
   * - 未挂载的包：`mounted: true` → 在 preset 末尾**追加两行**把它挂上；
   * - 取消挂载：`mounted: false` → 把那一行整块删掉。
   *
   * 改完立刻调 harness 的 `reload-preset`：它会重置 preset 记忆并**真创建一个探针会话**验证
   * （挂了个缺依赖的插件会当场失败）。**失败就回滚文件**——绝不留一个让 bot 不回话的 preset。
   */
  async set_tool(body) {
    const id = String(body.id ?? '').trim()
    if (id === '') throw new Error('缺少 id')
    const path = preset_path()
    if (!existsSync(path)) throw new Error('找不到 preset：' + path)
    const original = readFileSync(path, 'utf8')

    // 未挂载的包：勾选即挂载
    if (body.mounted === true) {
      const name = String(body.name ?? '').trim()
      if (name === '') throw new Error('挂载新插件需要 name（包名）')
      // 行由**服务端**按同一个判定算出来（含同伴包与自动补的配置），
      // 不接受调用方塞进来的任意行——那是往 preset 里注配置的口子。
      const plan = mount_plan(
        name, installed_packages(), read_json(join(CONFIG, 'modelConfig.json'), {}).defaultModel ?? {},
        preset_ids(original),
      )
      if (plan.kind !== 'ready') throw new Error(`这个包不能一键挂载：${plan.reason}`)
      const addition = plan.rows.map(row => `${row}\n`).join('')
      const updated = `${original.trimEnd()}\n${addition}`
      backup_file(path)
      writeFileSync(path, updated, 'utf8')
      try {
        await admin_call('reload-preset', {})
      } catch (error) {
        writeFileSync(path, original, 'utf8')          // 回滚，别让 bot 因为挂错插件而不回话
        throw new Error(`挂载 ${name} 失败，已回滚 preset：${error.message}`)
      }
      const extra = plan.companions.length > 0
        ? `（一并挂上 ${plan.companions.map(item => item.id).join('、')}）`
        : ''
      return { ok: true, note: `已挂载 ${id}${extra}（含备份），新会话生效` }
    }

    // 已挂载的行：启用/禁用
    if (body.mounted === undefined) {
      const disabled = body.disabled === true
      const updated = set_preset_row_disabled(original, id, disabled)
      if (updated === undefined) throw new Error(`preset 里没有这一行：${id}`)
      backup_file(path)
      writeFileSync(path, updated, 'utf8')
      return {
        ok: true,
        note: `已${disabled ? '禁用' : '启用'} ${id}（含备份），点「重载 preset」或重启后端后生效。`,
      }
    }

    // 取消挂载：整块删掉（连同它下面缩进的 config）
    const removed = remove_preset_row(original, id)
    if (removed === undefined) throw new Error(`preset 里没有这一行：${id}`)
    backup_file(path)
    writeFileSync(path, removed, 'utf8')
    try {
      await admin_call('reload-preset', {})
    } catch (error) {
      writeFileSync(path, original, 'utf8')
      throw new Error(`卸载 ${id} 后 preset 校验失败，已回滚：${error.message}`)
    }
    return { ok: true, note: `已取消挂载 ${id}（含备份），新会话生效` }
  },

  /**
   * 添加（或补充）一个模型配置。
   *
   * provider 已存在就往它下面加模型；不存在就连 provider 一起建。
   * **密钥写 config/secrets.json，模型定义写 config/modelConfig.json**——两个文件分开落盘。
   * 写入前自动留一份 `.bak-<时间戳>`，改坏了可以直接换回来。
   */
  add_model(body) {
    const provider_id = String(body.provider ?? '').trim()
    const model_id = String(body.model ?? '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider_id)) {
      throw new Error('provider 名只能用字母、数字、点、下划线、减号，且以字母或数字开头')
    }
    if (model_id === '') throw new Error('模型 id 不能为空')

    const path = join(CONFIG, 'modelConfig.json')
    const cfg = read_json(path, undefined)
    if (cfg === undefined) throw new Error('读不到 modelConfig.json')

    const existing = cfg.providers?.[provider_id]
    const base_url = String(body.baseURL ?? '').trim().replace(/\/$/, '')
    const api_key = String(body.apiKey ?? '').trim()

    if (existing === undefined) {
      if (!/^https?:\/\//.test(base_url)) throw new Error('新建 provider 时 baseURL 必填，且必须以 http:// 或 https:// 开头')
      cfg.providers = cfg.providers ?? {}
      cfg.providers[provider_id] = {
        displayName: String(body.displayName ?? provider_id).trim() || provider_id,
        api: String(body.api ?? 'openai-completions'),
        baseURL: base_url,
        // 密钥的键名：启动器按这个名字把它同步进 ~/.dsh/.credentials.yaml
        apiKeyEnv: provider_id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY',
        models: [],
      }
    } else {
      // 已存在的 provider：只更新显式给出的字段，别覆盖人家原来的配置。
      // **注意 apiKey 不写这里**（它是密钥，写 config/secrets.json，见下方 write_secrets）。
      if (base_url !== '') existing.baseURL = base_url
      existing.models = existing.models ?? []
    }

    const target = cfg.providers[provider_id]
    if (target.models.some(item => item.id === model_id)) {
      throw new Error(`provider ${provider_id} 下已经有模型 ${model_id} 了`)
    }
    target.models.push({
      id: model_id,
      name: String(body.name ?? '').trim() || model_id,
      input: body.vision === true ? ['text', 'image'] : ['text'],
    })
    cfg.updatedAt = new Date().toISOString()

    // 模型定义写 modelConfig.json（留备份，改坏了可以换回来）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(`${path}.bak-${stamp}`, readFileSync(path))
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
    // **密钥单独写 secrets.json**：这个文件不含模型定义，只装密钥，便于单独保管/不提交/不进备份。
    if (api_key !== '') {
      write_secrets(secrets => {
        secrets.providers = secrets.providers ?? {}
        secrets.providers[provider_id] = { ...secrets.providers[provider_id], apiKey: api_key }
        return secrets
      })
    }
    return {
      ok: true,
      provider: provider_id,
      model: model_id,
      note: '模型定义已写入 modelConfig.json' + (api_key === '' ? '' : '，密钥单独写入 secrets.json')
        + '（含备份），重启后端服务后生效',
    }
  },

  toggles() {
    const env = read_console_env()
    const state = open_state_db()
    let notify = { codex: true, opencode: true }
    if (state) {
      try {
        const get = key => state.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
        notify = { codex: get('notify.codex') !== '0', opencode: get('notify.opencode') !== '0' }
      } catch { /* 表可能不存在 */ }
      state.close()
    }
    return {
      immediate: [
        { key: 'notify.codex', label: 'codex 完成汇报', kind: 'bool', value: notify.codex, help: '即时生效' },
        { key: 'notify.opencode', label: 'opencode 完成汇报', kind: 'bool', value: notify.opencode, help: '即时生效' },
      ],
      restart: ENV_TOGGLES.map(item => ({
        ...item,
        value: env[item.key] ?? process.env[item.key] ?? item.default,
      })),
    }
  },

  set_toggle(body) {
    const key = String(body.key ?? '').trim()
    const value = String(body.value ?? '').trim()
    if (key.startsWith('notify.')) {
      const target = key.slice('notify.'.length)
      if (!['codex', 'opencode'].includes(target)) throw new Error('未知通知开关')
      const state = open_state_db()
      if (state === undefined) throw new Error('状态库不存在')
      state.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value === '1' || value === 'true' ? '1' : '0')
      state.close()
      return { ok: true, note: '已即时生效' }
    }
    if (!ENV_TOGGLES.some(item => item.key === key)) throw new Error(`未知开关：${key}`)
    const env = read_console_env()
    env[key] = value
    write_console_env(env)
    return { ok: true, note: '已保存，重启后端服务后生效' }
  },

  logs(name, lines) {
    const entry = LOGS[name]
    if (entry === undefined) throw new Error(`未知日志：${name}`)
    const result = tail_file(entry.path, lines)
    return { name: entry.name, path: entry.path, ...result }
  },

  usage(days) {
    return usage_summary(days)
  },
}

/**
 * 解析用哪个 Python 跑 start_stack.py。
 *
 * 顺序：环境变量 → config/console.env 里的 PYTHON（由启动器自己记录，最可靠）
 * → PATH 上的 python / py。都不写死本机绝对路径。
 */
function resolve_python() {
  if (process.env.PYTHON) return process.env.PYTHON
  const from_env_file = read_console_env().PYTHON
  if (from_env_file) return from_env_file
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 启停后端服务：复用项目里已有的启动器与清理脚本。 */
function run_service(action) {
  const python = resolve_python()
  const start = spawn(python, ['start_stack.py'], { cwd: PROJECT, detached: true, stdio: 'ignore', windowsHide: true })
  start.unref()
  return { ok: true, note: `已请求 ${action}（启动器会在后台完成；状态栏几秒后刷新）` }
}

function stop_service() {
  // 统一走项目内的 tools/stop_stack.py（停止逻辑只保留一处，避免多处实现漂移）
  const stop_script = join(PROJECT, 'tools', 'stop_stack.py')
  if (existsSync(stop_script)) {
    const child = spawn(resolve_python(), [stop_script],
      { cwd: PROJECT, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { ok: true, note: '已请求停止后端服务（3080/3081 会随之关闭）' }
  }
  // 兜底：tools 缺失时也能停
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'apps/cli/src/bin\\.ts|startHarnessBackend' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "Get-NetTCPConnection -LocalPort 3080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }",
  ].join('; ')
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script],
    { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return { ok: true, note: '已请求停止后端服务（3080/3081 会随之关闭）' }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  // 静态页面
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = join(HERE, 'public', rel)
    if (!file.startsWith(join(HERE, 'public'))) return json(res, 403, { error: 'forbidden' })
    if (!existsSync(file)) return json(res, 404, { error: 'not found' })
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
    return
  }

  const send = payload => json(res, 200, payload)
  const fail = error => json(res, 400, { error: error instanceof Error ? error.message : String(error) })

  try {
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/api/overview': return void api.overview().then(send, fail)
        case '/api/models': return void send(api.models())
        case '/api/toggles': return void send(api.toggles())
        case '/api/memory/stats': return void admin_call('memory-stats').then(send, fail)
        case '/api/compaction': return void send(api.compaction())
        case '/api/failover': return void api.failover().then(send, fail)
        case '/api/weixin/qr/status':
          return void api.weixin_qr_status(url.searchParams.get('qrcode') ?? '').then(send, fail)
        case '/api/persona': return void send(api.persona())
        case '/api/tools': return void send(api.tools())
        case '/api/logs': return void send(api.logs(url.searchParams.get('name') ?? 'probe', Number(url.searchParams.get('lines') ?? 200)))
        case '/api/usage': return void send(api.usage(Number(url.searchParams.get('days') ?? 7)))
        default: return json(res, 404, { error: 'unknown api' })
      }
    }
    if (req.method === 'POST') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 空体 */ }
        try {
          switch (url.pathname) {
            case '/api/models/default': return void send(api.set_default_model(body))
            case '/api/models/add': return void send(api.add_model(body))
            case '/api/memory/clear': {
              const target = String(body.target ?? '')
              const user_id = typeof body.user_id === 'string' && body.user_id !== '' ? body.user_id : undefined
              const call = target === 'context'
                ? admin_call('clear-context', user_id === undefined ? {} : { user_id })
                : target === 'timeline' || target === 'graph'
                  ? admin_call('clear-memory', { target })
                  : target === 'queue'
                    ? admin_call('clear-queue', {})
                    : undefined
              if (call === undefined) {
                return json(res, 400, { error: `target 只能是 timeline/context/graph/queue，收到：${target}` })
              }
              return void call.then(send, fail)
            }
            case '/api/weixin/qr': return void api.weixin_qr().then(send, fail)
            case '/api/persona': return void send(api.set_persona(body))
            case '/api/tools': return void api.set_tool(body).then(send, fail)
            case '/api/models/context-window': return void send(api.set_context_window(body))
            case '/api/compaction': return void send(api.set_compaction(body))
            case '/api/preset/reload': return void api.reload_preset().then(send, fail)
            case '/api/toggles': return void send(api.set_toggle(body))
            case '/api/service':
              if (body.action === 'stop') return void send(stop_service())
              return void send(run_service(String(body.action ?? 'restart')))
            default: return json(res, 404, { error: 'unknown api' })
          }
        } catch (error) {
          fail(error)
        }
      })
      return
    }
    json(res, 405, { error: 'method not allowed' })
  } catch (error) {
    fail(error)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent 控制台已启动: http://127.0.0.1:${PORT}`)
  console.log(`项目目录: ${PROJECT}`)
})
