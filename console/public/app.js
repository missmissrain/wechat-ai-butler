/* Agent 控制台 · 前端逻辑（原生 JS，无构建步骤） */

const $ = id => document.getElementById(id)

async function get(path) {
  const response = await fetch(path, { cache: 'no-store' })
  const data = await response.json()
  if (data.error) throw new Error(data.error)
  return data
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await response.json()
  if (data.error) throw new Error(data.error)
  return data
}

const num = value => (value ?? 0).toLocaleString('zh-CN')
const money = value => `¥${(value ?? 0).toFixed(4)}`

// ── 标签页 ─────────────────────────────────────────────────────────────────

for (const button of document.querySelectorAll('#tabs button')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('#tabs button')) item.classList.toggle('active', item === button)
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`)
    }
    // 每个面板在切换到它时才去取数据（避免开页面就并发打一堆请求）
    if (button.dataset.tab === 'logs') refresh_log()
    if (button.dataset.tab === 'usage') refresh_usage()
    if (button.dataset.tab === 'memory') load_memory(false)
    if (button.dataset.tab === 'toggles') refresh_compaction().catch(() => {})
    if (button.dataset.tab === 'models') refresh_failover().catch(() => {})
    if (button.dataset.tab === 'agent') {
      refresh_persona().catch(() => {})
      refresh_tools().catch(error => { $('tools-hint').textContent = `读取工具列表失败：${error.message}` })
    }
  })
}

// ── 服务状态 ───────────────────────────────────────────────────────────────

async function refresh_overview() {
  const data = await get('/api/overview')
  $('service-cards').innerHTML = data.services.map(service => `
    <div class="service">
      <div class="name">${service.name}</div>
      <div class="value ${service.up ? 'up' : 'down'}">${service.up ? '运行中' : '未启动'}</div>
      <div class="hint">端口 ${service.port}　${service.detail ?? ''}</div>
    </div>`).join('')

  const up = data.services.filter(service => service.up).length
  $('status-strip').textContent =
    `${up}/${data.services.length} 个服务在线 · 累计投递 ${num(data.deliveries)} 条 · 时间线 ${data.memory.timeline_days} 天`

  $('outbox').innerHTML = data.outbox.length === 0
    ? '<span class="hint">队列为空</span>'
    : `<table><tr><th>状态</th><th>类型</th><th class="num">数量</th></tr>${data.outbox.map(row => `
        <tr><td>${row.status}</td><td>${row.kind}</td><td class="num">${row.n}</td></tr>`).join('')}</table>`

  $('memory').innerHTML = `
    <table>
      <tr><td>时间线</td><td class="num">${data.memory.timeline_days} 天（最近 ${data.memory.last_day ?? '—'}）</td></tr>
      <tr><td>知识图谱人物</td><td class="num">${data.memory.graph} 人</td></tr>
    </table>`
}

/**
 * 重启后**真实等待**服务起来：每 3 秒探一次，直到全部在线或超时。
 *
 * 以前是 `setTimeout(refresh, 60000)` 盲等——时间到了服务可能还没起（或者压根起失败了），
 * 面板上就一直是旧的/错的连通性，看着像摆设。现在用真实探测收敛。
 */
async function wait_until_up(timeout_ms = 240_000) {
  const started = Date.now()
  for (;;) {
    const seconds = Math.round((Date.now() - started) / 1000)
    try {
      const data = await get('/api/overview')
      const down = data.services.filter(service => !service.up)
      if (down.length === 0) {
        $('service-hint').textContent = `重启完成，全部服务在线（用时 ${seconds} 秒）`
        return
      }
      $('service-hint').textContent = `重启中…已 ${seconds} 秒，等待：${down.map(item => item.name).join('、')}`
    } catch (error) {
      $('service-hint').textContent = `重启中…已 ${seconds} 秒（${error.message}）`
    }
    if (Date.now() - started > timeout_ms) {
      $('service-hint').textContent = `等了 ${seconds} 秒仍未全部在线，请查看「日志」里的 harness 运行日志`
      return
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

$('btn-restart').addEventListener('click', async () => {
  $('service-hint').textContent = '正在重启…'
  try {
    await post('/api/service', { action: 'restart' })
  } catch (error) {
    $('service-hint').textContent = `重启请求失败：${error.message}`
    return
  }
  await wait_until_up()
  await refresh_overview()
})
$('btn-stop').addEventListener('click', async () => {
  if (!confirm('确定停止后端服务？微信将不再回复。')) return
  await post('/api/service', { action: 'stop' })
  $('service-hint').textContent = '已请求停止'
  setTimeout(refresh_overview, 6000)
})

// ── 模型 ───────────────────────────────────────────────────────────────────

let models_cache = null

/** 故障转移状态：候选顺序 + 正在冷却的模型。 */
async function refresh_failover() {
  try {
    const data = await get('/api/failover')
    const current = data.current
      ? `${data.current.provider ?? ''}/${data.current.model ?? ''}`
      : '（未设置）'
    const dead = (data.dead ?? []).length === 0
      ? '无'
      : data.dead.map(item => `${item.provider}/${item.model}（${item.reason}，到 ${new Date(item.until).toLocaleTimeString()} 前不再尝试）`).join('；')
    $('failover-status').textContent = data.enabled
      ? `当前：${current}\n候选顺序：${(data.order ?? []).join(' → ') || '（未配置）'}\n正在冷却：${dead}`
      : '已关闭（failover.enabled = false）'
  } catch (error) {
    $('failover-status').textContent = `读取失败：${error.message}`
  }
}

async function refresh_models() {
  const data = await get('/api/models')
  models_cache = data
  $('current-model').textContent = data.default?.provider
    ? `${data.default.provider} / ${data.default.model}`
    : '（未设置）'

  $('provider-select').innerHTML = data.providers
    .map(provider => `<option value="${provider.id}">${provider.id}</option>`).join('')
  fill_models(data.default?.provider)
  $('provider-select').addEventListener('change', event => fill_models(event.target.value))

  $('model-table').innerHTML = `<table>
    <tr><th>provider</th><th>模型</th><th>能力</th><th>定价（元/M）</th></tr>
    ${data.providers.map(provider => provider.models.map(model => `
      <tr>
        <td>${provider.id}</td>
        <td>${model.name}</td>
        <td>${(model.input ?? []).join('+') || '—'}</td>
        <td>${price_text(model.pricing)}</td>
      </tr>`).join('')).join('')}
  </table>`
}

/** 定价的可读文案：免费 / 分档 / 单一价 / 无定价。 */
function price_text(pricing) {
  if (!pricing) return '—'
  if (pricing.free) return '<span class="up">免费</span>'
  if (Array.isArray(pricing.tiers)) {
    return pricing.tiers
      .map(tier => `≤${Math.round((tier.maxInputTokens ?? 0) / 1000)}k：入 ${tier.input} / 缓 ${tier.cacheRead} / 出 ${tier.output}`)
      .join('<br>')
  }
  return `入 ${pricing.input ?? '—'} / 缓 ${pricing.cacheRead ?? '—'} / 出 ${pricing.output ?? '—'}`
}

function fill_models(provider_id) {
  const provider = models_cache?.providers.find(item => item.id === provider_id)
  $('model-select').innerHTML = (provider?.models ?? [])
    .map(model => `<option value="${model.id}">${model.name}</option>`).join('')
}

$('btn-add-model').addEventListener('click', async () => {
  const payload = {
    provider: $('add-provider').value.trim(),
    baseURL: $('add-baseurl').value.trim(),
    apiKey: $('add-apikey').value.trim(),
    model: $('add-model').value.trim(),
    name: $('add-name').value.trim(),
    vision: $('add-vision').checked,
  }
  if (payload.provider === '' || payload.model === '') {
    $('add-hint').textContent = 'provider 名和模型 id 是必填的'
    return
  }
  try {
    const result = await post('/api/models/add', payload)
    $('add-hint').textContent = `${result.provider} / ${result.model} 已添加 —— ${result.note}`
    for (const id of ['add-apikey', 'add-model', 'add-name']) $(id).value = ''
    $('add-vision').checked = false
    refresh_models()
  } catch (error) {
    $('add-hint').textContent = `失败：${error.message}`
  }
})

$('btn-save-model').addEventListener('click', async () => {
  try {
    const result = await post('/api/models/default', {
      provider: $('provider-select').value,
      model: $('model-select').value,
    })
    $('model-hint').textContent = result.note
    refresh_models()
  } catch (error) {
    $('model-hint').textContent = `失败：${error.message}`
  }
})

// ── 开关 ───────────────────────────────────────────────────────────────────

async function refresh_toggles() {
  const data = await get('/api/toggles')
  $('toggles-immediate').innerHTML = data.immediate.map(item => `
    <div class="toggle">
      <label class="label">
        ${item.label}
        <div class="help">${item.help}</div>
      </label>
      <input type="checkbox" data-immediate="${item.key}" ${item.value ? 'checked' : ''} />
    </div>`).join('')

  $('toggles-restart').innerHTML = data.restart.map(item => {
    // 下拉型开关（如"记忆更新引擎"）：用 select，选项由服务端给出
    const control = item.kind === 'select'
      ? `<select class="setting-input" data-restart="${item.key}">${(item.options ?? []).map(option =>
          `<option value="${option.value}" ${String(item.value) === option.value ? 'selected' : ''}>${option.label}</option>`
        ).join('')}</select>`
      : `<input class="setting-input" ${item.kind === 'number' ? 'type="number"' : 'type="text"'} data-restart="${item.key}" value="${item.value}" />`
    return `
    <div class="toggle">
      <label class="label">
        ${item.label}
        <div class="help">${item.help}</div>
      </label>
      ${control}
    </div>`
  }).join('')

  for (const input of document.querySelectorAll('[data-immediate]')) {
    input.addEventListener('change', async () => {
      const result = await post('/api/toggles', {
        key: input.dataset.immediate, value: input.checked ? '1' : '0',
      })
      $('toggle-hint').textContent = result.note
    })
  }
  for (const input of document.querySelectorAll('[data-restart]')) {
    input.addEventListener('change', async () => {
      const result = await post('/api/toggles', { key: input.dataset.restart, value: input.value })
      $('toggle-hint').textContent = result.note
    })
  }
}

$('btn-restart-2').addEventListener('click', async () => {
  $('toggle-hint').textContent = '正在重启…'
  try {
    await post('/api/service', { action: 'restart' })
  } catch (error) {
    $('toggle-hint').textContent = `重启请求失败：${error.message}`
    return
  }
  await wait_until_up()
  $('toggle-hint').textContent = '重启完成，全部服务在线'
})

// ── 上下文长度与压缩 ───────────────────────────────────────────────────────

async function refresh_compaction() {
  let data
  try {
    data = await get('/api/compaction')
  } catch (error) {
    $('compaction-hint').textContent = `读取失败：${error.message}`
    return
  }
  const provider = data.model?.provider ?? ''
  const model = data.model?.model ?? ''
  $('ctx-model').textContent = model === '' ? '（未设置默认模型）' : `${model}（${provider}）`
  const models = await get('/api/models')
  const entry = (models.providers.find(item => item.id === provider)?.models ?? [])
    .find(item => item.id === model)
  $('ctx-window').value = entry?.contextWindow ?? 0
  $('ctx-budget').value = data.compressionBudget ?? 0
  $('ctx-retain').value = data.retainTokens ?? 0
  $('compaction-hint').textContent =
    `当前模型窗口 ${entry?.contextWindow ? num(entry.contextWindow) : '未设置（默认 262144）'} tokens`
}

$('btn-failover-refresh').addEventListener('click', () => refresh_failover())

$('btn-ctx-save').addEventListener('click', async () => {
  const models = await get('/api/models')
  const provider = models.default?.provider
  const model = models.default?.model
  try {
    const result = await post('/api/models/context-window', {
      provider, model, tokens: Number($('ctx-window').value),
    })
    $('compaction-hint').textContent = result.note
  } catch (error) {
    $('compaction-hint').textContent = `失败：${error.message}`
  }
})

$('btn-compaction-save').addEventListener('click', async () => {
  try {
    const result = await post('/api/compaction', {
      compressionBudget: Number($('ctx-budget').value),
      retainTokens: Number($('ctx-retain').value),
    })
    $('compaction-hint').textContent = result.note
    await post('/api/preset/reload', {}).catch(() => {})
    $('compaction-hint').textContent = `${result.note}；preset 已重载`
  } catch (error) {
    $('compaction-hint').textContent = `失败：${error.message}`
  }
})

// ── 人格与工具 ─────────────────────────────────────────────────────────────

async function refresh_persona() {
  const data = await get('/api/persona')
  $('persona-path').textContent = data.path
  $('persona-text').value = data.text
}

$('btn-reload-persona').addEventListener('click', () => { refresh_persona().catch(() => {}) })
$('btn-save-persona').addEventListener('click', async () => {
  try {
    const result = await post('/api/persona', { text: $('persona-text').value })
    $('persona-hint').textContent = result.note
    refresh_persona()
  } catch (error) {
    $('persona-hint').textContent = `失败：${error.message}`
  }
})

/** 一个工具条目：大白话在上，官方说明在下（小字）。 */
function tool_item(tool) {
  const plain = tool.plain
    ? `<span class="tool-plain">${tool.plain}</span>`
    : ''
  const official = tool.official
    ? `<span class="tool-official">${tool.official.slice(0, 220)}</span>`
    : (plain === '' ? '<span class="tool-official">（没有简介）</span>' : '')
  return `<li><code>${tool.name}</code>${plain}${official}</li>`
}

/** 一个插件包条目。 */
function tool_row(row) {
  const badge = row.mounted
    ? (row.disabled_reason ? `<span class="tag">${row.disabled_reason}</span>` : '<span class="tag ok">已挂载</span>')
    : '<span class="tag">未挂载</span>'
  const tools = (row.tools ?? []).length === 0
    ? '<div class="help">这个插件不提供工具：它只做提示词/上下文的事（上面那句就是它的作用）。</div>'
    : `<ul class="tool-list">${row.tools.map(tool_item).join('')}</ul>`
  const summary = row.summary ? `<div class="help">${row.summary}</div>` : ''
  // 分组里的子插件（例如 compaction 组里的 compaction-basic）
  const children = (row.children ?? []).length === 0 ? '' : `
    <ul class="tool-children">${row.children.map(item => `
      <li><code>${item.id}</code><span class="hint">${item.name}</span>
        ${item.disabled ? '<span class="tag">已禁用</span>' : ''}
        ${item.summary ? `<span class="tool-plain">${item.summary}</span>` : ''}
      </li>`).join('')}</ul>`
  // 未挂载的：给出可直接粘贴的 preset 行（不直接替他改 preset——有些插件还要写配置）
  const mountable = row.mount_kind === 'ready'
  const companions = (row.companions ?? []).length === 0
    ? ''
    : `<div class="help">会一并挂上：${row.companions.map(item => item.id).join('、')}（它们提供底层服务）</div>`
  const preset_row = row.mounted === true || !row.preset_row ? '' : mountable
    ? `<div class="preset-row">
        <span class="hint">勾选「挂载」就会把它写进 preset 并立即重载；写不进去或组装失败会自动回滚。也就是往 preset 里加这几行：</span>
        <code>${row.preset_row.replace(/\n/g, '<br>')}</code>
      </div>`
    : `<div class="preset-row">
        <span class="hint">不能一键挂载：${row.mount_reason ?? '原因未知'}</span>
      </div>`
  // 已挂载：勾选框切换"启用/禁用"；可挂的：勾选即挂载；其余：禁用并说明原因
  const toggle = row.mounted === true
    ? `<label class="checkbox"><input type="checkbox" data-tool="${row.id}" ${row.disabled ? '' : 'checked'} /> 启用</label>`
    : mountable
      ? `<label class="checkbox"><input type="checkbox" data-tool="${row.id}" data-mount="1" data-name="${row.name}" /> 挂载</label>`
      : '<span class="tag">不可一键挂载</span>'
  return `
    <div class="toggle tool-row${row.mounted === true ? '' : ' unmounted'}">
      <div class="label">
        <div class="tool-head">
          <strong>${row.id}</strong>
          <span class="hint">${row.name || '（无 name）'}</span>
          ${badge}
        </div>
        ${summary}
        ${children}
        ${companions}
        ${tools}
        ${preset_row}
      </div>
      ${toggle}
    </div>`
}

async function refresh_tools() {
  const data = await get('/api/tools')
  $('tools-path').textContent = `${data.preset} · ${data.path}`
  if (data.rows.length === 0) {
    $('tools-list').innerHTML = '<span class="hint">没读到 preset 行</span>'
    return
  }
  const rows = data.rows
  const mounted = rows.filter(row => row.mounted === true && row.kind !== 'runtime')
  const runtime = rows.filter(row => row.kind === 'runtime')
  const available = rows.filter(row => row.mounted !== true)
  // 已挂载的排前面，然后运行期注册的，最后是"能挂但没挂"的
  const ordered = [...mounted, ...runtime, ...available]

  $('tools-hint').textContent = `已挂载 ${mounted.length} 个插件包`
    + `（${rows.filter(row => row.mounted === true).reduce((sum, row) => sum + row.tools.length, 0)} 个工具）；`
    + `另有 ${available.length} 个可挂载但未启用；共收录 ${data.counts?.tools ?? 0} 个工具简介`

  $('tools-list').innerHTML = ordered.map(tool_row).join('')
  for (const input of document.querySelectorAll('[data-tool]')) {
    input.addEventListener('change', async () => {
      const mounting = input.dataset.mount === '1'
      $('tools-hint').textContent = mounting
        ? `正在挂载 ${input.dataset.tool} 并验证 preset…（几秒）`
        : '正在写入 preset…'
      try {
        const result = mounting
          ? await post('/api/tools', { id: input.dataset.tool, name: input.dataset.name, mounted: true })
          : await post('/api/tools', { id: input.dataset.tool, disabled: !input.checked })
        $('tools-hint').textContent = result.note
        if (mounting) await refresh_tools()        // 挂载后重新渲染（变成"已挂载"那一组）
      } catch (error) {
        $('tools-hint').textContent = `失败：${error.message}`
        input.checked = !input.checked             // 失败时把开关拨回去，别骗用户
      }
    })
  }
}

// ── 微信绑定（扫码）─────────────────────────────────────────────────────────

const qr_state = { qrcode: null, refreshes: 0, timer: null }

function qr_stop(message) {
  if (qr_state.timer !== null) { clearTimeout(qr_state.timer); qr_state.timer = null }
  if (message !== undefined) $('qr-status').textContent = message
}

/** 取一张新二维码并开始轮询。 */
async function qr_start() {
  qr_stop('正在获取二维码…')
  try {
    const data = await post('/api/weixin/qr', {})
    qr_state.qrcode = data.qrcode
    qr_state.refreshes += 1
    $('qr-area').innerHTML = data.image
      ? `<img class="qr-img" src="${data.image}" alt="微信二维码" />`
      : `<p class="hint">二维码图片渲染失败（可能是当前 Python 缺少 qrcode 库）。可点下面的链接在手机上打开：</p>
         <p><a href="${data.content}" target="_blank" rel="noreferrer">${data.content}</a></p>`
    $('qr-status').textContent = `等待扫码…（第 ${qr_state.refreshes} 张）`
    qr_poll()
  } catch (error) {
    qr_stop(`获取二维码失败：${error.message}`)
  }
}

/** 轮询一次状态，按结果决定继续 / 停止 / 刷新二维码 / 提示去手机上确认。 */
function qr_poll() {
  qr_stop()
  qr_state.timer = setTimeout(async () => {
    if (qr_state.qrcode === null) return
    const query = `qrcode=${encodeURIComponent(qr_state.qrcode)}`
    let data
    try {
      data = await get(`/api/weixin/qr/status?${query}`)
    } catch (error) {
      qr_stop(`查询状态失败：${error.message}`)
      return
    }
    switch (data.status) {
      case 'wait':
        $('qr-status').textContent = `等待扫码…（第 ${qr_state.refreshes} 张）`
        qr_poll()
        return
      case 'scaned':
        $('qr-status').textContent = '已扫描，正在手机上验证…'
        qr_poll()
        return
      case 'need_verifycode':
        // 平台偶尔会要求"在手机上再确认一次"：不在界面里收数字（那个输入框实际没用上），
        // 只提示按手机提示完成，并继续轮询等待后续状态。
        $('qr-status').textContent = '按手机微信上的提示完成验证，界面会继续自动检测…'
        qr_poll()
        return
      case 'scaned_but_redirect':
        $('qr-status').textContent = `服务端要求切换接入点：${data.base ?? ''}`
        qr_poll()
        return
      case 'expired':
        if (qr_state.refreshes >= 3) { qr_stop('二维码多次失效，请点「获取二维码」重试'); return }
        $('qr-status').textContent = '二维码已过期，正在自动刷新…'
        qr_start()
        return
      case 'binded_redirect':
        qr_stop('这个微信号已经绑定过了，现有凭据仍然有效（无需重复连接）')
        return
      case 'verify_code_blocked':
        qr_stop('平台拒绝了这次验证，请稍后再试')
        return
      case 'confirmed':
        qr_stop(`绑定成功 ✅（bot_id ${data.bot_id}）${data.note ?? ''}`)
        // 新凭据要重启才生效，这里直接把"重启"按钮亮出来，省得用户再去翻服务状态页
        $('btn-qr-restart').disabled = false
        return
      default:
        $('qr-status').textContent = `状态：${data.status ?? '未知'}`
        qr_poll()
    }
  }, 2000)
}

$('btn-qr-start').addEventListener('click', () => {
  qr_state.refreshes = 0
  $('btn-qr-restart').disabled = true
  qr_start()
})
$('btn-qr-stop').addEventListener('click', () => qr_stop('已停止轮询'))
$('btn-qr-restart').addEventListener('click', async () => {
  $('qr-status').textContent = '正在重启后端服务…（约需 1~2 分钟）'
  try {
    const result = await post('/api/service', { action: 'restart' })
    $('qr-status').textContent = `已提交重启：${result.message ?? JSON.stringify(result)}`
  } catch (error) {
    $('qr-status').textContent = `重启失败：${error.message}`
  }
})
// ── 记忆维护（清空时间记忆库 / 上下文 / 知识图谱）───────────────────────────

/** 人类可读的字节数。 */
function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 相对时间（几分钟前）。 */
function ago(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 危险操作按钮：点一次变成"确认清空"，再点一次才真执行。
 * 没有用浏览器 confirm()：它会被误触，而且样式骗不了人。
 */
function danger_button(label, target, hint) {
  const button = document.createElement('button')
  button.className = 'danger'
  button.textContent = label
  let armed = false
  const disarm = () => {
    armed = false
    button.classList.remove('armed')
    button.textContent = label
  }
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      button.classList.add('armed')
      button.textContent = '真的要清空？再点一次确认'
      setTimeout(disarm, 6000)
      return
    }
    disarm()
    button.disabled = true
    $('memory-status').textContent = `正在清空${hint}…`
    try {
      const result = await post('/api/memory/clear', { target })
      $('memory-status').textContent = `已清空${hint}${result.note ? `（${result.note}）` : ''}`
    } catch (error) {
      $('memory-status').textContent = `清空${hint}失败：${error.message}`
    }
    button.disabled = false
    await load_memory(true)
  })
  return button
}

/** 渲染一张记忆卡片：标题 + 体量/内容 + 二次确认的清空按钮。 */
function memory_card({ title, detail, target, multiline }) {
  const card = document.createElement('div')
  card.className = 'memory-card'
  const head = document.createElement('div')
  head.className = 'name'
  head.textContent = title
  const text = document.createElement('div')
  text.className = 'hint'
  text.textContent = detail
  if (multiline === true) text.style.whiteSpace = 'pre-line'
  card.append(head, text, danger_button(`清空${title}`, target, title))
  return card
}

async function load_memory(quiet) {
  if (!quiet) $('memory-status').textContent = '正在读取…'
  let data
  try {
    data = await get('/api/memory/stats')
  } catch (error) {
    $('memory-status').textContent = `读取失败：${error.message}`
    $('memory-cards').innerHTML = ''
    return
  }
  $('memory-status').textContent = `读取于 ${new Date().toLocaleTimeString()}`

  // 队列体量在 overview 里（按状态分组），顺手拿一下
  let outbox_rows = []
  try {
    outbox_rows = (await get('/api/overview')).outbox ?? []
  } catch { /* 后端没起来时只显示"读取失败" */ }
  const queue_total = outbox_rows
    .filter(row => row.status !== 'sent' && row.status !== 'failed_terminal')
    .reduce((sum, row) => sum + row.n, 0)

  const timeline = data.timeline ?? {}
  const graph = data.graph ?? {}
  const users = data.context?.users ?? []
  const cards = [
    {
      title: '时间记忆库',
      target: 'timeline',
      detail: timeline.error ?? `${timeline.days ?? 0} 天 · ${timeline.entries ?? 0} 条记录 · ${human(timeline.bytes)}`,
    },
    {
      title: '对话上下文',
      target: 'context',
      multiline: true,
      detail: users.length === 0
        ? '还没有任何用户的会话（用户发过消息后才会有）'
        : users.map(user => `${user.user_id}\n　第 ${user.epoch + 1} 段会话 · ${human(user.bytes)} · ${ago(user.modified_at)}${user.online ? ' · 在线' : ''}`).join('\n'),
    },
    {
      title: '出站队列',
      target: 'queue',
      detail: queue_total === 0
        ? '队列为空'
        : `待发/停放 ${queue_total} 条　`
          + outbox_rows.filter(row => row.status !== 'sent' && row.status !== 'failed_terminal')
            .map(row => `${row.status}(${row.kind}) ${row.n}`).join('　'),
    },
    {
      title: '知识图谱',
      target: 'graph',
      detail: graph.error ?? `${graph.people ?? 0} 个人物 · ${graph.relations ?? 0} 条称呼 · ${human(graph.bytes)}`,
    },
  ]
  $('memory-cards').innerHTML = ''
  for (const item of cards) $('memory-cards').append(memory_card(item))
}

$('btn-memory-refresh').addEventListener('click', () => load_memory(false))

// ── Token 用量 ─────────────────────────────────────────────────────────────

async function refresh_usage() {
  const data = await get(`/api/usage?days=${$('usage-days').value}`)
  const total = data.total ?? {}
  $('usage-cards').innerHTML = `
    <div class="service"><div class="name">调用次数</div><div class="value">${num(total.calls)}</div></div>
    <div class="service"><div class="name">输入 token</div><div class="value">${num(total.input)}</div></div>
    <div class="service"><div class="name">缓存命中</div><div class="value">${num(total.cacheRead)}</div></div>
    <div class="service"><div class="name">输出 token</div><div class="value">${num(total.output)}</div></div>
    <div class="service"><div class="name">合计 token</div><div class="value">${num(total.totalTokens)}</div></div>
    <div class="service"><div class="name">估算成本</div><div class="value">${money(total.cost)}</div></div>`

  const table = (rows, first) => `<table>
    <tr><th>${first}</th><th class="num">调用</th><th class="num">输入</th><th class="num">缓存</th>
    <th class="num">输出</th><th class="num">合计</th><th class="num">成本</th></tr>
    ${rows.map(row => `<tr>
      <td>${row.date ?? row.model}${row.priced === false ? '（无定价）' : ''}</td>
      <td class="num">${num(row.calls)}</td><td class="num">${num(row.input)}</td>
      <td class="num">${num(row.cacheRead)}</td><td class="num">${num(row.output)}</td>
      <td class="num">${num(row.totalTokens)}</td><td class="num">${money(row.cost)}</td></tr>`).join('')}
  </table>`

  $('usage-days-table').innerHTML = data.days.length === 0 ? '<span class="hint">这段时间没有调用记录</span>' : table(data.days, '日期')
  $('usage-model-table').innerHTML = data.by_model.length === 0 ? '<span class="hint">—</span>' : table(data.by_model, '模型')
}

$('btn-refresh-usage').addEventListener('click', refresh_usage)
$('usage-days').addEventListener('change', refresh_usage)

// ── 日志 ───────────────────────────────────────────────────────────────────

let log_timer = null

async function refresh_log() {
  const name = $('log-select').value || 'probe'
  const data = await get(`/api/logs?name=${name}&lines=400`)
  const filter = $('log-filter').value.trim()
  let lines = data.text.split('\n')
  if (filter) lines = lines.filter(line => line.includes(filter))
  $('log-hint').textContent = `${data.name} · ${data.exists ? '' : '文件不存在 · '}显示 ${lines.length} 行`
  $('log-view').innerHTML = lines
    .map(line => line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/error/gi, '<span class="err">error</span>')
      .replace(/warn/gi, '<span class="warn">warn</span>'))
    .join('\n')
  $('log-view').scrollTop = $('log-view').scrollHeight
}

function setup_log_select() {
  $('log-select').innerHTML = [
    ['probe', '微信链路探针'], ['llm', '模型请求（含 token 用量）'],
    ['harness', 'harness 运行日志'], ['opencode', 'opencode server'],
  ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('')
}

$('btn-refresh-log').addEventListener('click', refresh_log)
$('log-select').addEventListener('change', refresh_log)
$('log-filter').addEventListener('input', refresh_log)
setInterval(() => { if ($('log-follow').checked) refresh_log() }, 3000)

// ── 启动 ───────────────────────────────────────────────────────────────────

setup_log_select()
refresh_overview().catch(error => { $('status-strip').textContent = `读取失败：${error.message}` })
refresh_models().catch(() => {})
refresh_toggles().catch(() => {})
setInterval(refresh_overview, 15000)
