/**
 * dsh-process-lens · Host half
 *
 * 做什么：把一条回答背后的「处理过程」翻译成大白话，供右侧抽屉展示。
 *
 * 三个和参考插件不同的地方：
 *  1. 讲解模型可以单独选（settings.provider / settings.model），不跟随会话模型；
 *     没选时才回落到「会话模型 → 请求头 → 全局默认」。
 *  2. 是否立刻生成讲解由用户决定（settings.mode）：
 *       'onDemand'（默认）—— 没人打开抽屉就不调用模型，只记账；
 *       'eager'          —— 步骤一结束就在后台讲，打开即见成品。
 *  3. 讲解文案走固定三行协议（标题 / 在做什么 / 结果），不给用户看术语。
 *
 * @module dsh-process-lens
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-process-lens'
export const inject = ['llm', 'webServer']

const PLUGIN = 'dsh-process-lens'
const API = '/process-lens/api'
const STREAM = '/process-lens/stream'

const MAX_SESSIONS = 24
const MAX_TURNS = 120
/** 补账时最多回放多少条会话事件 */
const MAX_REPLAY = 4000
const MAX_TOOLS = 40
const REASONING_CHARS = 1600
const ANSWER_CHARS = 700
const REQUEST_CHARS = 300
const RESULT_CHARS = 240
const JOB_TIMEOUT_MS = 60_000
const MAX_PARALLEL = 2

/** 默认设置。 */
const DEFAULTS = Object.freeze({
  provider: '',
  model: '',
  /** 'onDemand' = 打开才讲；'eager' = 一结束就讲 */
  mode: 'onDemand',
  /** 一轮回答结束后自动弹出抽屉 */
  autoOpen: false,
  maxTokens: 1600,
  /** 打开面板时先显示最近几步（0 = 全部） */
  recent: 8,
  /** 打开面板时自动讲最近几步（花额度，默认关） */
  autoSummarize: false,
  autoSummarizeCount: 3,
  /** 内置讲解风格：plain / pro / brief / gentle */
  style: 'plain',
  /** 选中的自定义提示词 id（空 = 用内置风格） */
  activePrompt: '',
  /** 自定义提示词存档：[{ id, name, text }] */
  prompts: [],
  /** 省 token 模式：整轮只给压缩概要 */
  compact: false,
  /** 省 token 模式带最近几步 */
  compactCount: 5,
  /** 面板外观：auto = 跟随 DSH / 壁纸插件；light / dark = 固定 */
  theme: 'auto',
})

/** 原文存多少：够看全文，又不至于把内存吃穿 */
const FULL_CHARS = 20000

/** 工具名 → 大白话。给「还没讲解」的即时反馈用。 */
const TOOL_LABELS = {
  read: '读文件',
  write: '写文件',
  edit: '改代码',
  bash: '跑命令',
  pwsh: '跑命令',
  grep: '搜代码',
  glob: '找文件',
  web_search: '上网搜',
  web_fetch: '打开网页',
  subagent: '派子任务',
  subagent_fork: '派子任务',
  skill: '查资料',
  todo_write: '列清单',
  present: '交付文件',
  cordis_inspect_query: '查接口',
  cordis_inspect_list: '查接口',
  acp_status: '看上下文',
  compress: '压缩记忆',
  decompress: '翻回记录',
  browser_nav: '开浏览器',
  browser_read: '看网页',
  browser_click: '点网页',
  ask_user_question: '问你问题',
  create_goal: '立目标',
  update_goal: '改目标',
  team_task_create: '建任务',
  list_agents: '看队友',
  send_message: '发消息',
}

/** 讲解提示词：给完全不懂技术的人讲。 */
// ── 讲解风格 / 提示词 ─────────────────────────────────────────────────────────

/** 不管用哪种风格，最后都得是三行——不然前端没法拆。 */
const OUTPUT_RULES = [
  '输出格式（硬性要求，一个字都不能改）：',
  '只输出三行，顺序固定：',
  '标题：不超过 14 个字，说清这一步在干什么',
  '在做什么：不超过 100 个字，说清为什么要做这一步',
  '结果：不超过 100 个字，说清得到了什么、顺不顺利、有没有卡住',
  '不写 markdown、不写列表、不写开场白、不写客套话。',
].join('\n')

/** 内置风格：只换"怎么说"，不换"必须说三行"。 */
const STYLE_PRESETS = {
  plain: {
    name: '通俗',
    hint: '大白话，谁都能懂',
    persona: [
      '你是「过程讲解员」，负责把 AI 助手刚才做的事，用中文大白话讲给完全不懂技术的人听。',
      '不出现代码、文件路径原文、英文缩写、工具名；必须提到时用「文件」「命令」「搜索」这类日常说法。',
    ].join('\n'),
  },
  pro: {
    name: '专业',
    hint: '工程师视角，术语准确',
    persona: [
      '你是「过程讲解员」，读者是有经验的技术负责人。用专业但克制的中文讲清这一步的技术动作。',
      '可以用准确术语（接口、注入、迁移、重试、并发、幂等），但不贴大段代码，不做评价式夸奖。',
      '信息不足时直说"从这一步看不出来"，不要编。',
    ].join('\n'),
  },
  brief: {
    name: '一句话',
    hint: '极简，每行都很短',
    persona: [
      '你是「过程讲解员」，读者只想快速扫一眼。',
      '标题控制在 6–10 个字，另外两行各不超过 30 个字，只留最关键的信息，多余细节一律不写。',
    ].join('\n'),
  },
  gentle: {
    name: '给新手',
    hint: '当对方第一次用这类工具',
    persona: [
      '你是「过程讲解员」，读者第一次接触这类工具。用生活化的比喻解释，必要时说明"为什么要这么做"。',
      '不出现任何英文、代码、路径、工具名。语气耐心，但不要卖萌、不要客套、不要鼓励式废话。',
    ].join('\n'),
  },
}

const STYLE_IDS = Object.keys(STYLE_PRESETS)

// ── 小工具 ────────────────────────────────────────────────────────────────────

const clip = (value, limit) => {
  const text = String(value ?? '')
    .replace(/\r/g, '')
    .trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

const oneLine = (value, limit) => clip(String(value ?? '').replace(/\s+/g, ' '), limit)

/** 从消息里取出人话部分（text 块）。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 从 assistant 流记录里拼出思考过程。 */
function reasoningOf(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record?.type === 'reasoning-chunks' && Array.isArray(record.texts)) parts.push(...record.texts)
    else if (record?.type === 'chunk' && record.chunk?.type === 'reasoning-delta') parts.push(record.chunk.text)
  }
  return parts.join('')
}

const toolLabel = (toolName) => TOOL_LABELS[toolName] ?? `用了 ${toolName} 这个工具`

/** 从工具参数里挑一段能看的摘要。 */
function argsSummary(raw) {
  if (!raw) return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return oneLine(raw, 100)
  }
  if (parsed === null || typeof parsed !== 'object') return oneLine(raw, 100)
  const preferred = ['file_path', 'path', 'command', 'description', 'query', 'pattern', 'url', 'subject', 'prompt']
  const picked = []
  for (const key of preferred) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) picked.push(oneLine(value, 90))
    if (picked.length >= 2) break
  }
  if (picked.length) return picked.join(' · ')
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim()) return oneLine(value, 90)
  }
  return ''
}

/** 解析讲解员的三行回复；解析不出就整段兜底。 */
function parseCard(text) {
  const card = { title: '', doing: '', result: '' }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const matched = line.match(/^\s*[*#>\-—•\s]*\s*(标题|在做什么|做什么|这一步在做什么|结果|结论)\s*[:：]\s*(.+)$/)
    if (!matched) continue
    const label = matched[1]
    const value = matched[2].replace(/\*\*/g, '').trim()
    if (label === '标题') card.title = oneLine(value, 40)
    else if (label === '结果' || label === '结论') card.result = oneLine(value, 200)
    else if (!card.doing) card.doing = oneLine(value, 200)
  }
  if (!card.title && !card.doing && !card.result) {
    const whole = oneLine(text, 220)
    card.title = '这一步的情况'
    card.doing = whole || '模型这次没给出内容'
  }
  if (!card.title) card.title = '这一步的情况'
  return card
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

/** settings 落在 profile 目录，重启后仍在。 */
function settingsFile() {
  const dir =
    process.env.DSH_PROFILE_DIR ??
    process.env.DSH_HOME ??
    join(homedir(), '.dsh', 'profiles', 'desktop')
  return join(dir, 'process-lens.json')
}

export function apply(ctx) {
  const settings = { ...DEFAULTS }
  /** sessionId -> { id, turns: Map<number, Turn>, order } */
  const sessions = new Map()
  /** sessionId -> Map<messageId, turn> */
  const messageTurns = new Map()
  /** `${session}:${turn}` -> Set<{ send, close }> */
  const subscribers = new Map()
  /** 正在讲解的 `${session}:${turn}:${step}` */
  const inflight = new Set()
  /** 待讲解队列 */
  const queue = []
  let running = 0
  /** 正在回放会话历史时为 true：只记账，不触发讲解，避免补账时批量调模型 */
  let replaying = false
  let saveTimer = null
  let disposed = false

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`${PLUGIN}: ${message}`)
    } catch {}
  }

  // ── 设置持久化 ──────────────────────────────────────────────────────────────

  void (async () => {
    try {
      const raw = await readFile(settingsFile(), 'utf8')
      const parsed = JSON.parse(raw)
      for (const key of Object.keys(DEFAULTS)) {
        if (parsed?.[key] !== undefined) settings[key] = parsed[key]
      }
    } catch {}
  })()

  // ── 风格与提示词 ────────────────────────────────────────────────────────────

  function promptList() {
    return Array.isArray(settings.prompts) ? settings.prompts.filter((item) => item && item.id) : []
  }

  function activeCustom() {
    const id = String(settings.activePrompt ?? '')
    if (!id) return null
    return promptList().find((item) => item.id === id) ?? null
  }

  function currentStyle() {
    return STYLE_PRESETS[settings.style] ?? STYLE_PRESETS.plain
  }

  /** 真正发给模型的 system：选了自己存的提示词就用它，否则用内置风格。 */
  function systemPromptNow() {
    const custom = activeCustom()
    const persona = custom?.text?.trim() ? custom.text.trim() : currentStyle().persona
    return `${persona}\n\n${OUTPUT_RULES}`
  }

  function styleView() {
    const custom = activeCustom()
    const preset = currentStyle()
    return {
      style: STYLE_PRESETS[settings.style] ? settings.style : 'plain',
      styleName: custom ? custom.name : preset.name,
      styleHint: custom ? '你自己存的那份' : preset.hint,
      activePrompt: custom?.id ?? '',
      activePromptName: custom?.name ?? '',
      custom: custom ? { id: custom.id, name: custom.name, text: custom.text } : null,
    }
  }

  function stylesView() {
    return STYLE_IDS.map((id) => ({ id, name: STYLE_PRESETS[id].name, hint: STYLE_PRESETS[id].hint }))
  }

  /** 省 token 模式用：把一步压成一句话。 */
  function briefOfStep(step) {
    const last = step.tools.at(-1)
    if (!last) return step.card?.title ? `${step.card.title}·自己在想` : '自己在想'
    const state = last.state === 'error' ? '失败' : last.state === 'running' ? '进行中' : '成功'
    const title = step.card?.title ? `${step.card.title}·` : ''
    return `${title}${toolLabel(last.name)}（${state}）`
  }

  function saveSettingsSoon() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void (async () => {
        try {
          const file = settingsFile()
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
        } catch (error) {
          log(`保存设置失败：${error?.message ?? error}`)
        }
      })()
    }, 300)
  }

  // ── 记账 ────────────────────────────────────────────────────────────────────

  function sessionBucket(sessionId) {
    const key = String(sessionId)
    let bucket = sessions.get(key)
    if (bucket) return bucket
    bucket = { id: key, turns: new Map() }
    sessions.set(key, bucket)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next()
      if (oldest.done) break
      if (oldest.value === key) break
      sessions.delete(oldest.value)
    }
    return bucket
  }

  function turnRecord(sessionId, turn) {
    const bucket = sessionBucket(sessionId)
    let record = bucket.turns.get(turn)
    if (record) return record
    record = {
      turn,
      status: 'running',
      reason: null,
      request: '',
      startedAt: Date.now(),
      endedAt: null,
      steps: new Map(),
    }
    bucket.turns.set(turn, record)
    while (bucket.turns.size > MAX_TURNS) {
      const oldest = bucket.turns.keys().next()
      if (oldest.done || oldest.value === turn) break
      bucket.turns.delete(oldest.value)
    }
    return record
  }

  function stepRecord(sessionId, turn, step) {
    const record = turnRecord(sessionId, turn)
    let entry = record.steps.get(step)
    if (entry) return entry
    entry = {
      step,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      reasoning: '',
      answer: '',
      tools: [],
      card: null,
      explain: 'idle',
      error: null,
    }
    record.steps.set(step, entry)
    return entry
  }

  function rememberMessage(sessionId, messageId, turn) {
    if (!messageId) return
    const key = String(sessionId)
    let index = messageTurns.get(key)
    if (!index) {
      index = new Map()
      messageTurns.set(key, index)
    }
    index.set(String(messageId), turn)
    if (index.size > 2000) {
      const oldest = index.keys().next()
      if (!oldest.done) index.delete(oldest.value)
    }
  }

  // ── 卡片投影 ────────────────────────────────────────────────────────────────

  function toolsView(step) {
    return step.tools.slice(-MAX_TOOLS).map((tool) => ({
      name: tool.name,
      label: toolLabel(tool.name),
      detail: tool.detail,
      state: tool.state,
      error: tool.error,
    }))
  }

  function cardOf(turn, step) {
    const settled = step.status !== 'running'
    const duration = (step.endedAt ?? Date.now()) - step.startedAt
    return {
      step: step.step,
      status: settled ? step.status : 'running',
      title: step.card?.title ?? (settled ? `第 ${step.step} 步` : `第 ${step.step} 步 · 正在做`),
      doing: step.card?.doing ?? '',
      result: step.card?.result ?? '',
      explain: step.explain,
      explainError: step.error,
      tools: toolsView(step),
      // 原文：不花 token 也能看的东西
      raw: {
        thinking: step.reasoning ? clip(step.reasoning, FULL_CHARS) : '',
        answer: step.answer ? clip(step.answer, FULL_CHARS) : '',
        actions: step.tools.slice(-MAX_TOOLS).map((tool) => ({
          name: tool.name,
          label: toolLabel(tool.name),
          detail: tool.detail ? clip(tool.detail, 2000) : '',
          args: tool.args ? clip(tool.args, FULL_CHARS) : '',
          state: tool.state,
          output: tool.state === 'error' ? clip(tool.error || '出错了', 600) : clip(tool.result || '', FULL_CHARS),
        })),
      },
      durationMs: Math.max(0, duration),
      waiting: !settled,
      at: step.startedAt,
    }
  }

  function snapshotOf(sessionId, turn) {
    const bucket = sessions.get(String(sessionId))
    const record = bucket?.turns.get(turn)
    if (!record) {
      return {
        session: String(sessionId),
        turn,
        status: 'unknown',
        reason: null,
        request: '',
        steps: [],
        settings: publicSettings(),
      }
    }
    const steps = [...record.steps.values()].sort((a, b) => a.step - b.step).map((step) => cardOf(record, step))
    return {
      session: String(sessionId),
      turn,
      status: record.status,
      reason: record.reason,
      request: record.request,
      steps,
      settings: publicSettings(),
    }
  }

  /** 外观取值只认三档，别的都当跟随宿主 */
  function themeOf(value) {
    return value === 'light' || value === 'dark' ? value : 'auto'
  }

  function publicSettings() {
    return {
      provider: settings.provider,
      model: settings.model,
      mode: settings.mode,
      autoOpen: settings.autoOpen === true,
      maxTokens: settings.maxTokens,
      recent: settings.recent,
      autoSummarize: settings.autoSummarize === true,
      autoSummarizeCount: settings.autoSummarizeCount,
      ...styleView(),
      styles: stylesView(),
      prompts: promptList(),
      compact: settings.compact === true,
      compactCount: settings.compactCount,
      theme: themeOf(settings.theme),
    }
  }

  // ── 推送 ────────────────────────────────────────────────────────────────────

  function keyOf(sessionId, turn) {
    return `${String(sessionId)}:${turn}`
  }

  function broadcast(sessionId, turn, event, data) {
    const set = subscribers.get(keyOf(sessionId, turn))
    if (!set || set.size === 0) return
    for (const client of [...set]) {
      try {
        client.send(event, data)
      } catch {}
    }
  }

  function pushCard(sessionId, turn, step) {
    const record = sessions.get(String(sessionId))?.turns.get(turn)
    if (!record) return
    const entry = record.steps.get(step)
    if (!entry) return
    broadcast(sessionId, turn, 'card', cardOf(record, entry))
  }

  function pushTurn(sessionId, turn) {
    const record = sessions.get(String(sessionId))?.turns.get(turn)
    if (!record) return
    broadcast(sessionId, turn, 'turn', {
      turn,
      status: record.status,
      reason: record.reason,
      request: record.request,
    })
  }

  // ── 讲解 ────────────────────────────────────────────────────────────────────

  /** 讲解用哪条模型路由：自选优先，其次会话模型，其次请求头，最后全局默认。 */
  function resolveRoute(sessionId) {
    if (settings.provider && settings.model) return { provider: settings.provider, model: settings.model }
    const agents = ctx.get('agents')
    const options = agents?.get?.(sessionId)?.options
    if (options?.provider && options?.model) return { provider: options.provider, model: options.model }
    const session = ctx.get('sessions')?.get?.(sessionId)
    const events = session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const config = events[index]?.data?.header?.config ?? events[index]?.data?.config
      if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (fallback?.provider && fallback?.model) return { provider: fallback.provider, model: fallback.model }
    return null
  }

  /** 推理档位挑最低一档；挑不出来就不传，交给模型默认。 */
  async function lowestEffort(llm, route) {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const efforts = info?.reasoning?.efforts
      if (!Array.isArray(efforts) || efforts.length === 0) return undefined
      const rank = (id) => {
        const text = String(id ?? '').toLowerCase()
        if (/none|off|minimal/.test(text)) return 0
        if (/low/.test(text)) return 1
        if (/medium|med/.test(text)) return 2
        if (/high/.test(text)) return 3
        return 4
      }
      let best = efforts[0]
      for (const effort of efforts) if (rank(effort?.id) < rank(best?.id)) best = effort
      return best?.id
    } catch {
      return undefined
    }
  }

  async function callOnce(route, prompt, system) {
    const llm = ctx.get('llm')
    if (!llm?.stream) throw new Error('讲解服务不可用')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS)
    const effort = await lowestEffort(llm, route)
    let text = ''
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system: system ?? systemPromptNow(),
        maxTokens: Number(settings.maxTokens) || DEFAULTS.maxTokens,
        temperature: 0.3,
        signal: controller.signal,
      }
      if (effort !== undefined) options.reasoningEffort = effort
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta') text += chunk.text
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
        }
      }
    } finally {
      clearTimeout(timer)
    }
    return text.trim()
  }

  /**
   * 花 token 的唯一入口：用户明确点了「讲这步」或「全部讲一遍」。
   * 打开抽屉、连上推送、轮次跑完，统统不算 —— 光看不点，一分钱不花。
   */
  function buildPrompt(record, step) {
    const compact = settings.compact === true
    const lines = []
    if (record.request) lines.push(`用户提的诉求：${clip(record.request, compact ? 120 : REQUEST_CHARS)}`)
    lines.push(`这是这一轮里的第 ${step.step} 步。`)

    if (compact) {
      // 省 token 模式：整轮只给一句话概要 + 当前步的压缩信息
      const keep = Math.min(50, Math.max(1, Math.round(Number(settings.compactCount) || 5)))
      const recent = [...record.steps.values()].slice(-keep)
      lines.push(`省 token 模式：信息已压缩，一共只给最近 ${recent.length} 步的要点。`)
      for (const item of recent) {
        const mark = item.step === step.step ? '（就是这步）' : ''
        lines.push(`- 第 ${item.step} 步${mark}：${briefOfStep(item)}`)
      }
      if (step.reasoning) lines.push(`它在想（压缩）：${oneLine(step.reasoning, 240)}`)
      if (step.answer) lines.push(`它在写（压缩）：${oneLine(step.answer, 200)}`)
      if (step.tools.length > 0) {
        lines.push('这一步的操作（压缩）：')
        for (const tool of step.tools.slice(-6)) {
          const detail = tool.detail ? `（${clip(tool.detail, 80)}）` : ''
          const outcome =
            tool.state === 'error'
              ? `失败：${oneLine(tool.error || '出错了', 100)}`
              : tool.state === 'running'
                ? '还在进行'
                : `返回：${oneLine(tool.result, 100) || '没有内容'}`
          lines.push(`- ${toolLabel(tool.name)}${detail} → ${outcome}`)
        }
      }
      lines.push('看清楚的就讲，看不清的别猜。请按三行格式讲给用户听。')
      return lines.join('\n')
    }

    if (step.reasoning) lines.push(`助手在这一步的内部思考（节选）：${clip(step.reasoning, REASONING_CHARS)}`)
    if (step.answer) lines.push(`助手在这一步写下的话（节选）：${clip(step.answer, ANSWER_CHARS)}`)
    if (step.tools.length === 0) {
      lines.push('这一步没有调用任何工具，只是模型自己在想/在写。')
    } else {
      lines.push('这一步调用过的操作：')
      for (const tool of step.tools.slice(-MAX_TOOLS)) {
        const detail = tool.detail ? `（${tool.detail}）` : ''
        const outcome =
          tool.state === 'error'
            ? `失败：${clip(tool.error || '出错了', RESULT_CHARS)}`
            : tool.state === 'running'
              ? '还在进行'
              : `返回：${oneLine(tool.result, RESULT_CHARS) || '没有内容'}`
        lines.push(`- ${toolLabel(tool.name)}${detail} → ${outcome}`)
      }
    }
    lines.push('')
    lines.push('请按三行格式讲给用户听。')
    return lines.join('\n')
  }

  function enqueue(sessionId, turn, step, force) {
    if (replaying) return
    const record = sessions.get(String(sessionId))?.turns.get(turn)
    const entry = record?.steps.get(step)
    if (!entry) return
    if (entry.explain === 'done' || entry.explain === 'running') return
    if (force !== true) {
      if (entry.explain !== 'idle') {
        entry.explain = 'idle'
        pushCard(sessionId, turn, step)
      }
      return
    }
    const key = `${String(sessionId)}:${turn}:${step}`
    if (inflight.has(key)) return
    if (queue.some((job) => job.key === key)) return
    entry.explain = 'queued'
    pushCard(sessionId, turn, step)
    queue.push({ key, sessionId: String(sessionId), turn, step })
    void drain()
  }

  async function drain() {
    while (!disposed && running < MAX_PARALLEL && queue.length > 0) {
      const job = queue.shift()
      if (!job || inflight.has(job.key)) continue
      inflight.add(job.key)
      running += 1
      void runJob(job).finally(() => {
        running -= 1
        inflight.delete(job.key)
        void drain()
      })
    }
  }

  async function runJob(job) {
    const record = sessions.get(job.sessionId)?.turns.get(job.turn)
    const entry = record?.steps.get(job.step)
    if (!record || !entry) return
    entry.explain = 'running'
    pushCard(job.sessionId, job.turn, job.step)
    try {
      const route = resolveRoute(job.sessionId)
      if (!route) throw new Error('还没选好讲解模型，请在抽屉顶部挑一个')
      const text = await callOnce(route, buildPrompt(record, entry), systemPromptNow())
      if (!text) throw new Error('模型这次没有返回内容')
      const card = parseCard(text)
      entry.card = card
      entry.error = null
      entry.explain = 'done'
    } catch (error) {
      entry.error = oneLine(error?.message ?? error, 160)
      entry.explain = 'failed'
      log(`讲解失败：${entry.error}`)
    } finally {
      if (!disposed) pushCard(job.sessionId, job.turn, job.step)
    }
  }

  // ── 历史补账 ────────────────────────────────────────────────────────────────

  /**
   * 插件装好之前的轮次没有实时事件可听，但会话自己还留着事件流：
   * 第一次问到某个会话时，把末尾一段事件按顺序回放一遍，把账补上。
   * 回放期间不触发讲解——谁真的点开看，再由 SSE 连接去排讲解。
   */
  function hydrate(sessionId) {
    const key = String(sessionId)
    if (!key) return
    const existing = sessions.get(key)
    if (existing && (existing.hydrated || existing.turns.size > 0)) return
    let session = null
    try {
      session = ctx.get('sessions')?.get?.(key) ?? null
    } catch {
      session = null
    }
    if (!session || typeof session.snapshotEvents !== 'function') return
    let events = []
    try {
      events = session.snapshotEvents() ?? []
    } catch {
      events = []
    }
    if (events.length === 0) {
      sessionBucket(key).hydrated = true
      return
    }
    replaying = true
    try {
      const start = Math.max(0, events.length - MAX_REPLAY)
      for (let index = start; index < events.length; index += 1) {
        const event = events[index]
        if (event?.type) onSessionEvent(session, event)
      }
    } finally {
      replaying = false
    }
    sessionBucket(key).hydrated = true
  }

  // ── 事件接线 ────────────────────────────────────────────────────────────────

  function onSessionEvent(session, event) {
    try {
      const sessionId = String(session?.id ?? '')
      if (!sessionId || !event) return
      const data = event.data ?? {}
      const type = event.type
      if (type === 'turn/start') {
        const record = turnRecord(sessionId, data.turn)
        record.status = 'running'
        record.startedAt = event.time ?? Date.now()
        pushTurn(sessionId, data.turn)
        return
      }
      if (type === 'user/message') {
        const bucket = sessionBucket(sessionId)
        const last = [...bucket.turns.values()].at(-1)
        if (last) {
          last.request = oneLine(textOf(data), REQUEST_CHARS)
          pushTurn(sessionId, last.turn)
        }
        return
      }
      if (type === 'step/start') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        entry.status = 'running'
        entry.startedAt = event.time ?? Date.now()
        pushCard(sessionId, data.turn, data.step)
        return
      }
      if (type === 'tool/call') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        entry.tools.push({
          callId: String(data.callId ?? ''),
          name: String(data.name ?? 'tool'),
          detail: argsSummary(data.arguments),
          /** 原始参数（不压缩），展开原文时给用户看全文 */
          args: clip(String(data.arguments ?? ''), FULL_CHARS),
          result: '',
          error: null,
          state: 'running',
        })
        pushCard(sessionId, data.turn, data.step)
        return
      }
      if (type === 'tool/result') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        const callId = String(data.message?.toolCallId ?? '')
        const tool = entry.tools.find((item) => item.callId === callId) ?? entry.tools.at(-1)
        if (tool) {
          const failed = Boolean(data.error) || data.message?.isError === true
          tool.state = failed ? 'error' : 'done'
          tool.result = clip(textOf(data.message), FULL_CHARS)
          tool.error = failed ? oneLine(data.error?.reason ?? data.error?.name ?? textOf(data.message), 160) : null
        }
        pushCard(sessionId, data.turn, data.step)
        return
      }
      if (type === 'assistant/message') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        const answer = textOf(data.message)
        if (answer) entry.answer = answer
        const reasoning = reasoningOf(data.stream)
        if (reasoning) entry.reasoning = reasoning
        rememberMessage(sessionId, data.message?.id, data.turn)
        return
      }
      if (type === 'assistant/attempt') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        const reasoning = reasoningOf(data.stream)
        if (reasoning) entry.reasoning = reasoning
        return
      }
      if (type === 'step/end') {
        const entry = stepRecord(sessionId, data.turn, data.step)
        entry.status = 'done'
        entry.endedAt = event.time ?? Date.now()
        pushCard(sessionId, data.turn, data.step)
        enqueue(sessionId, data.turn, data.step, false)
        return
      }
      if (type === 'turn/end') {
        const record = turnRecord(sessionId, data.turn)
        record.status = 'done'
        record.reason = data.reason?.kind ?? null
        record.endedAt = event.time ?? Date.now()
        for (const entry of record.steps.values()) {
          if (entry.status === 'running') {
            entry.status = 'done'
            entry.endedAt = entry.endedAt ?? Date.now()
          }
          enqueue(sessionId, data.turn, entry.step, false)
        }
        pushTurn(sessionId, data.turn)
      }
    } catch (error) {
      log(`处理会话事件失败：${error?.message ?? error}`)
    }
  }

  ctx.effect(
    () => {
      const offEvent = ctx.on('session/event', (session, event) => onSessionEvent(session, event))
      const offDisposed = ctx.on('session/disposed', (session) => {
        const key = String(session?.id ?? '')
        if (key) {
          sessions.delete(key)
          messageTurns.delete(key)
        }
      })
      return () => {
        offEvent?.()
        offDisposed?.()
      }
    },
    `${PLUGIN}: 会话事件`,
  )

  // ── HTTP ────────────────────────────────────────────────────────────────────

  function blocked(req) {
    try {
      const connection = ctx.get('connection')
      if (connection?.requestRejection) return connection.requestRejection(req) !== undefined
    } catch {}
    return false
  }

  function writeJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  async function modelCatalog() {
    const llm = ctx.get('llm')
    if (!llm?.listProviders) return { providers: [], error: '模型服务还没就绪，重启一次 DSH 就好' }
    let providers = []
    try {
      providers = (await llm.listProviders()) ?? []
    } catch (error) {
      return { providers: [], error: `读不到模型列表：${error?.message ?? error}` }
    }
    if (!Array.isArray(providers)) providers = []
    const out = []
    for (const provider of providers) {
      const id = provider?.id ?? provider?.provider
      if (!id) continue
      let models = []
      try {
        models = (await llm.listModels(id)) ?? []
      } catch {
        models = []
      }
      if (!Array.isArray(models)) models = []
      out.push({
        provider: id,
        name: provider?.name ?? id,
        models: models.map((model) => ({ id: model?.id ?? String(model), name: model?.name ?? model?.id ?? String(model) })),
      })
    }
    return { providers: out, error: null }
  }

  async function apiHandler(req, res) {
    if (blocked(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const route = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : ''
    const method = req.method ?? 'GET'
    try {
      if (route === '/config' && method === 'GET') {
        writeJson(res, 200, { ok: true, settings: publicSettings() })
        return
      }
      if (route === '/models' && method === 'GET') {
        const catalog = await modelCatalog()
        let current = null
        try {
          current = resolveRoute(url.searchParams.get('session') ?? '')
        } catch {
          current = null
        }
        writeJson(res, 200, { ok: true, providers: catalog.providers, error: catalog.error, current })
        return
      }
      if (route === '/config' && method === 'POST') {
        const body = await readBody(req)
        if (typeof body.provider === 'string') settings.provider = body.provider
        if (typeof body.model === 'string') settings.model = body.model
        if (body.mode === 'eager' || body.mode === 'onDemand') settings.mode = body.mode
        if (typeof body.autoOpen === 'boolean') settings.autoOpen = body.autoOpen
        if (Number.isFinite(Number(body.recent))) settings.recent = Math.min(100, Math.max(0, Math.round(Number(body.recent))))
        if (typeof body.autoSummarize === 'boolean') settings.autoSummarize = body.autoSummarize
        if (Number.isFinite(Number(body.autoSummarizeCount)))
          settings.autoSummarizeCount = Math.min(20, Math.max(1, Math.round(Number(body.autoSummarizeCount))))
        if (STYLE_PRESETS[body.style]) settings.style = body.style
        if (typeof body.activePrompt === 'string')
          settings.activePrompt = promptList().some((item) => item.id === body.activePrompt) ? body.activePrompt : ''
        if (typeof body.compact === 'boolean') settings.compact = body.compact
        if (Number.isFinite(Number(body.compactCount)))
          settings.compactCount = Math.min(50, Math.max(1, Math.round(Number(body.compactCount))))
        if (body.theme === 'auto' || body.theme === 'light' || body.theme === 'dark') settings.theme = body.theme
        if (Number.isFinite(Number(body.maxTokens))) settings.maxTokens = Math.min(4000, Math.max(400, Number(body.maxTokens)))
        saveSettingsSoon()
        writeJson(res, 200, { ok: true, settings: publicSettings() })
        return
      }
      if (route === '/turn' && method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const messageId = url.searchParams.get('messageId') ?? ''
        hydrate(sessionId)
        const bucket = sessions.get(sessionId)
        let turn = messageTurns.get(sessionId)?.get(messageId)
        if (turn === undefined && bucket) turn = [...bucket.turns.keys()].at(-1)
        writeJson(res, 200, { ok: true, session: sessionId, turn: turn ?? null })
        return
      }
      if (route === '/latest' && method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        hydrate(sessionId)
        const bucket = sessions.get(sessionId)
        const last = bucket ? [...bucket.turns.values()].at(-1) : null
        writeJson(res, 200, {
          ok: true,
          session: sessionId,
          turn: last?.turn ?? null,
          status: last?.status ?? null,
        })
        return
      }
      if (route === '/snapshot' && method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const turn = Number(url.searchParams.get('turn'))
        hydrate(sessionId)
        writeJson(res, 200, { ok: true, data: snapshotOf(sessionId, turn) })
        return
      }
      if (route === '/explain' && method === 'POST') {
        const body = await readBody(req)
        const sessionId = String(body.session ?? '')
        const turn = Number(body.turn)
        hydrate(sessionId)
        const record = sessions.get(sessionId)?.turns.get(turn)
        if (!record) {
          writeJson(res, 404, { ok: false, error: '这一轮还没记录' })
          return
        }
        // 不传 step = 「这一轮还没讲过的都讲一遍」；已经讲好的不重讲，免得白烧额度。
        const only = body.step === undefined ? null : Number(body.step)
        const targets =
          only === null
            ? [...record.steps.values()]
                .filter((entry) => entry.explain !== 'done' && entry.explain !== 'running' && entry.explain !== 'queued')
                .map((entry) => entry.step)
            : [only]
        for (const step of targets) {
          const entry = record.steps.get(step)
          if (!entry) continue
          entry.explain = 'idle'
          entry.error = null
        }
        for (const step of targets) enqueue(sessionId, turn, step, true)
        writeJson(res, 200, { ok: true, steps: targets })
        return
      }
      if (route === '/prompt' && method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        hydrate(sessionId)
        const bucket = sessions.get(sessionId)
        const lastTurn = bucket ? [...bucket.turns.values()].at(-1) : null
        const lastStep = lastTurn ? [...lastTurn.steps.values()].at(-1) : null
        const user = lastTurn && lastStep
          ? buildPrompt(lastTurn, lastStep)
          : '（还没记录到这一步，先看个格式样例）\n这是这一轮里的第 1 步。\n这一步没有调用任何工具，只是模型自己在想/在写。\n请按三行格式讲给用户听。'
        const system = systemPromptNow()
        writeJson(res, 200, {
          ok: true,
          ...styleView(),
          styles: stylesView(),
          prompts: promptList(),
          compact: settings.compact === true,
          compactCount: settings.compactCount,
          sample: Boolean(lastStep) === false,
          system,
          user,
          chars: system.length + user.length,
        })
        return
      }
      if (route === '/prompts' && method === 'POST') {
        const body = await readBody(req)
        const action = String(body.action ?? '')
        if (action === 'save') {
          const text = clip(String(body.text ?? '').trim(), 4000)
          if (!text) {
            writeJson(res, 400, { ok: false, error: '提示词内容不能是空的' })
            return
          }
          const name = oneLine(body.name, 40) || '没起名字的提示词'
          const list = promptList().slice()
          const id = String(body.id ?? '')
          const existing = list.find((item) => item.id === id)
          if (existing) {
            existing.name = name
            existing.text = text
          } else {
            const fresh = { id: `p${Date.now().toString(36)}`, name, text }
            list.push(fresh)
            settings.activePrompt = fresh.id
          }
          settings.prompts = list
        } else if (action === 'delete') {
          const id = String(body.id ?? '')
          settings.prompts = promptList().filter((item) => item.id !== id)
          if (String(settings.activePrompt ?? '') === id) settings.activePrompt = ''
        } else if (action === 'select') {
          const id = String(body.id ?? '')
          settings.activePrompt = promptList().some((item) => item.id === id) ? id : ''
        } else {
          writeJson(res, 400, { ok: false, error: '不认识的操作' })
          return
        }
        saveSettingsSoon()
        writeJson(res, 200, { ok: true, prompts: promptList(), settings: publicSettings() })
        return
      }
      writeJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      writeJson(res, 500, { ok: false, error: oneLine(error?.message ?? error, 200) })
    }
  }

  function streamHandler(req, res) {
    if (blocked(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('session') ?? ''
    const turn = Number(url.searchParams.get('turn'))
    if (!sessionId || !Number.isFinite(turn)) {
      writeJson(res, 400, { ok: false, error: '需要 session 和 turn' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    hydrate(sessionId)
    const key = keyOf(sessionId, turn)
    let closed = false
    const send = (event, data) => {
      if (closed) return
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {}
    }
    const client = { send, close: () => {} }
    let set = subscribers.get(key)
    if (!set) {
      set = new Set()
      subscribers.set(key, set)
    }
    set.add(client)
    send('snap', snapshotOf(sessionId, turn))
    // 连上只是"看"。要讲哪一步，用户点按钮显式请求——所以这里只标注状态，不排队。
    const record = sessions.get(sessionId)?.turns.get(turn)
    if (record) {
      for (const entry of record.steps.values()) {
        if (entry.explain === 'done' || entry.explain === 'running' || entry.explain === 'queued') continue
        entry.explain = 'idle'
      }
    }
    const heartbeat = setInterval(() => send('ping', { t: Date.now() }), 15_000)
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      set.delete(client)
      if (set.size === 0) subscribers.delete(key)
      try {
        res.end()
      } catch {}
    }
    client.close = cleanup
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: apiHandler }),
    `${PLUGIN}: ${API}`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: STREAM, handler: streamHandler }),
    `${PLUGIN}: ${STREAM}`,
  )

  ctx.effect(
    () => () => {
      disposed = true
      queue.length = 0
      for (const set of subscribers.values()) {
        for (const client of set) {
          try {
            client.close()
          } catch {}
        }
      }
      subscribers.clear()
      if (saveTimer) clearTimeout(saveTimer)
    },
    `${PLUGIN}: 收尾`,
  )
}
