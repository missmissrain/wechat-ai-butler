/**
 * Agent 控制台 · Electron 桌面壳。
 *
 * 行为约定（按用户要求）：
 * - **右上角的叉叉 = 最小化到任务栏**（托盘），不退出程序；
 * - **右击托盘图标 → 菜单里有"退出"**，那才是真正关闭；
 * - 左击托盘图标 → 重新显示窗口。
 *
 * 本地服务（server.mjs）由本进程按需拉起：它只用 Node 内置模块，
 * 所以桌面壳里不需要任何额外依赖，也不会和外部服务抢端口。
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { deflateSync } = require('node:zlib')

/** 把启动与异常写进 console/electron.log，方便事后排查（GUI 的报错在终端里看不到）。 */
const LOG = join(__dirname, 'electron.log')
function log(...parts) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`, 'utf8')
  } catch { /* 日志写不进去也不该影响启动 */ }
}
process.on('uncaughtException', error => log('uncaughtException:', error?.stack ?? String(error)))
process.on('unhandledRejection', reason => log('unhandledRejection:', String(reason)))

const PORT = Number(process.env.CONSOLE_PORT ?? 3082)
const URL = `http://127.0.0.1:${PORT}`
const HERE = __dirname
/**
 * 开机自启用 `--hidden` 启动：只驻留托盘，不弹窗口。
 * 手动双击 start-console-gui.cmd 时不带这个参数，会正常显示窗口。
 */
const START_HIDDEN = process.argv.includes('--hidden')

/** 应用是否正在退出（用它区分"叉叉"与"真退出"）。 */
let quitting = false
let mainWindow = null
let tray = null
let serverProcess = null

// ── 生成托盘/窗口图标（避免额外带一个二进制资源文件）──────────────────────

/** CRC32（PNG 分块要用）。 */
function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** 拼一个 PNG 分块。 */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 画一个图标：深色圆角底 + 亮蓝同心环（像"正在运行"的状态灯）。
 * 纯代码生成，省掉一个二进制资源。
 */
function make_icon(size) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  const center = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0 // 过滤器：none
    for (let x = 0; x < size; x += 1) {
      const at = y * stride + 1 + x * 4
      const distance = Math.hypot(x - center, y - center) / center
      // 圆外透明；圆内深色底；靠近中心画亮环
      const alpha = distance > 1 ? 0 : 255
      const ring = Math.abs(distance - 0.55) < 0.14
      raw[at] = ring ? 0x5a : 0x17
      raw[at + 1] = ring ? 0xa9 : 0x1c
      raw[at + 2] = ring ? 0xff : 0x22
      raw[at + 3] = alpha
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // 位深
  ihdr[9] = 6      // 颜色类型：RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const icon = nativeImage.createFromBuffer(make_icon(64))

// ── 本地服务 ───────────────────────────────────────────────────────────────

/** 端口是否已经在监听（已经手动起过服务时就不重复拉）。 */
async function server_alive() {
  return new Promise(resolve => {
    const net = require('node:net')
    const socket = new net.Socket()
    socket.setTimeout(600)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.connect(PORT, '127.0.0.1')
  })
}

/**
 * 找一个**真正的 Node** 来跑本地服务。
 *
 * 为什么不能用 Electron 自己（`process.execPath` + `ELECTRON_RUN_AS_NODE`）：
 * 本地服务用了 `node:sqlite`（Node 22.5 才有），而 Electron 33 内置的是 Node 20
 * —— 拿它当 Node 跑，`import 'node:sqlite'` 直接抛错、服务秒退、端口永远起不来。
 * 这正是"开机自启报『控制台服务启动失败』"的根因（而手动用真 node 起过服务时，
 * 它只是检测到端口已占用就显示成功，所以看起来时好时坏）。
 *
 * 顺序：环境变量 → 启动器写在 console.env 里的 NODE= → PATH 里的 node。
 */
function resolve_node() {
  const from_env = process.env.CONSOLE_NODE
  if (from_env && existsSync(from_env)) return from_env
  try {
    const env_file = join(HERE, '..', 'config', 'console.env')
    if (existsSync(env_file)) {
      for (const line of readFileSync(env_file, 'utf8').split('\n')) {
        const match = /^\s*CONSOLE_NODE\s*=\s*(.+?)\s*$/.exec(line)
        if (match && existsSync(match[1])) return match[1]
      }
    }
  } catch { /* 读不到就继续往下找 */ }
  try {
    const found = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    const first = String(found.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)[0]
    if (first && existsSync(first)) return first
  } catch { /* 忽略 */ }
  return undefined
}

/** 确保本地服务在跑；返回 `{ok, detail}`（detail 带原因，便于报错时直接给用户看）。 */
async function ensure_server() {
  if (await server_alive()) return { ok: true, detail: '端口已在监听（复用已有服务）' }
  const server = join(HERE, 'server.mjs')
  if (!existsSync(server)) return { ok: false, detail: `找不到服务脚本：${server}` }

  const node = resolve_node()
  // 找不到真 node 时退回 Electron 自带 Node（可能在 node:sqlite 处失败，但至少留下原因）
  const command = node ?? process.execPath
  const env = node === undefined ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
  log('starting server with', node === undefined ? 'electron-as-node（未找到真 node）' : node)

  let stderr = ''
  serverProcess = spawn(command, [server, String(PORT)], {
    cwd: HERE,
    windowsHide: true,
    // **必须捕获**：以前用 stdio:'ignore'，子进程的错误被丢掉，
    // 日志里只剩“server ready = false”，根本查不出为什么（这次就吃了这个亏）。
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const collect = chunk => {
    stderr = (stderr + String(chunk)).slice(-4000)
  }
  serverProcess.stdout?.on('data', collect)
  serverProcess.stderr?.on('data', collect)
  serverProcess.on('error', error => { stderr = `${stderr}\nspawn 失败：${error.message}` })
  serverProcess.unref()

  for (let i = 0; i < 60; i += 1) {          // 最多等 18 秒（机器忙时也别急着报错）
    await new Promise(resolve => setTimeout(resolve, 300))
    if (await server_alive()) return { ok: true, detail: `已启动（${command}）` }
    if (serverProcess.exitCode !== null) break   // 进程已退出，不用再等
  }
  if (stderr.trim() !== '') log('server stderr:', stderr.trim().slice(0, 1500))
  return { ok: false, detail: stderr.trim() === '' ? '服务没有在端口上监听起来' : stderr.trim() }
}

// ── 窗口 ───────────────────────────────────────────────────────────────────

function create_window() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent 控制台',
    backgroundColor: '#0f1216',
    icon,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadURL(URL)

  // 外链走系统浏览器，别在壳里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 关键：叉叉 = 最小化到托盘，不退出
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
    if (tray) tray.displayBalloon?.({
      title: 'Agent 控制台仍在后台运行',
      content: '已最小化到托盘；右击托盘图标可以退出。',
      icon,
    })
  })
  mainWindow.on('closed', () => { mainWindow = null })
  // 页面/渲染进程出问题要留痕（否则窗口白屏也查不到原因）
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) =>
    log('did-fail-load', code, description, url))
  mainWindow.webContents.on('render-process-gone', (_event, details) =>
    log('render-process-gone', JSON.stringify(details)))
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) log('renderer console:', message)
  })
  // 关闭 = 隐藏到托盘（见上面 close 处理）；这里只记录，便于确认行为生效
  mainWindow.on('hide', () => log('window hidden (minimized to tray)'))
}

/** 显示窗口（没有就重建）。 */
function show_window() {
  if (mainWindow === null) create_window()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

// ── 托盘 ───────────────────────────────────────────────────────────────────

function create_tray() {
  tray = new Tray(icon)
  tray.setToolTip('Agent 控制台')
  // 右击托盘图标 → 这个菜单（里面有"退出"）
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示控制台', click: show_window },
    { type: 'separator' },
    {
      label: '重启后端服务（harness）',
      click: async () => {
        const ok = await ensure_server()
        if (!ok) return
        try {
          await fetch(`${URL}/api/service`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restart' }),
          })
        } catch { /* 服务没起来就算了，用户可以在界面里重试 */ }
        show_window()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit() },
    },
  ]))
  // 左击：显示窗口
  tray.on('click', show_window)
}

// ── 生命周期 ───────────────────────────────────────────────────────────────

// 只允许一个实例：重复启动时把已有窗口叫出来
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', show_window)

  app.whenReady().then(async () => {
    log('app ready; electron', process.versions.electron, 'port', PORT)
    create_tray()
    const result = await ensure_server()
    log('server ready =', result.ok, '|', result.detail.slice(0, 200))
    if (!result.ok) {
      // 报错里**带上真实原因**（子进程 stderr），否则用户和我都只能看到"启动失败"四个字
      dialog.showErrorBox('控制台服务启动失败',
        `无法在 127.0.0.1:${PORT} 启动本地服务。\n\n原因：\n${result.detail.slice(0, 600)}`
        + `\n\n可以手动运行：\n"${resolve_node() ?? 'node'}" "${join(HERE, 'server.mjs')}" ${PORT}`)
      quitting = true
      app.quit()
      return
    }
    create_window()
    if (START_HIDDEN) {
      // 开机自启：静默驻留托盘（用户点托盘图标即可唤出）
      mainWindow.hide()
      log('started hidden (autostart)')
    }
  })

  app.on('window-all-closed', () => {
    // 有托盘，不随窗口关闭而退出（这正是"叉叉只是最小化"的效果）
  })

  app.on('before-quit', () => { quitting = true })
}
