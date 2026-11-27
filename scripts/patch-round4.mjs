/**
 * 补丁 4：「打开面板时自动讲最近 N 步」开关（autoSummarize / autoSummarizeCount）。
 * 幂等：目标串已存在则跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  let applied = 0
  let missed = 0
  for (const [name, from, to] of pairs) {
    if (text.includes(to)) {
      console.log(`skip ${name}`)
      continue
    }
    if (!text.includes(from)) {
      console.log(`MISS ${name}`)
      missed += 1
      continue
    }
    text = text.split(from).join(to)
    applied += 1
    console.log(`ok   ${name}`)
  }
  writeFileSync(file, text)
  console.log(`${file}: ${applied} applied, ${missed} missed`)
}

patch('index.js', [
  [
    'host defaults',
    "  /** 打开面板时默认显示最近 N 步 */\n  recent: 8,",
    "  /** 打开面板时默认显示最近 N 步 */\n  recent: 8,\n  /** 打开面板时自动讲最近几步（花额度，默认关） */\n  autoSummarize: false,\n  autoSummarizeCount: 3,",
  ],
  [
    'publicSettings',
    "      recent: settings.recent,",
    "      recent: settings.recent,\n      autoSummarize: settings.autoSummarize === true,\n      autoSummarizeCount: settings.autoSummarizeCount,",
  ],
  [
    'POST config',
    "        if (Number.isFinite(Number(body.recent))) settings.recent = Math.min(100, Math.max(0, Math.round(Number(body.recent))))",
    "        if (Number.isFinite(Number(body.recent))) settings.recent = Math.min(100, Math.max(0, Math.round(Number(body.recent))))\n        if (typeof body.autoSummarize === 'boolean') settings.autoSummarize = body.autoSummarize\n        if (Number.isFinite(Number(body.autoSummarizeCount)))\n          settings.autoSummarizeCount = Math.min(20, Math.max(1, Math.round(Number(body.autoSummarizeCount))))",
  ],
])

patch('client.js', [
  [
    'state defaults',
    "      config: { provider: '', model: '', mode: 'onDemand', autoOpen: false, recent: 8 },",
    "      config: { provider: '', model: '', mode: 'onDemand', autoOpen: false, recent: 8, autoSummarize: false, autoSummarizeCount: 3 },",
  ],
  [
    'explainSteps 支持多步',
    `    async function explainSteps(sessionId, turn, steps) {
      if (!sessionId || turn === null || turn === undefined) return
      try {
        const body = { session: sessionId, turn }
        const list = Array.isArray(steps) ? steps : []
        if (list.length === 1) body.step = list[0]
        await apiPost('/explain', body)
        setState({ notice: null })`,
    `    async function explainSteps(sessionId, turn, steps) {
      if (!sessionId || turn === null || turn === undefined) return
      const list = Array.isArray(steps) ? steps.filter((item) => item !== null && item !== undefined) : []
      try {
        if (list.length === 0) {
          await apiPost('/explain', { session: sessionId, turn })
        } else {
          for (const one of list) await apiPost('/explain', { session: sessionId, turn, step: one })
        }
        setState({ notice: null })`,
  ],
  [
    'settings 常量',
    "      const recentValue = Number.isFinite(Number(lens.config.recent)) ? Number(lens.config.recent) : 8",
    "      const recentValue = Number.isFinite(Number(lens.config.recent)) ? Number(lens.config.recent) : 8\n      const autoCountValue = Number.isFinite(Number(lens.config.autoSummarizeCount)) ? Number(lens.config.autoSummarizeCount) : 3",
  ],
  [
    'settings 自动讲开关',
    `        h(
          'button',
          {
            type: 'button',
            className: 'pl-more',`,
    `        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '打开时自动讲'),
          h(
            'label',
            {
              className: 'pl-switch',
              title: '开了：每次你打开面板，自动把最近 N 步翻译成人话（花额度）；关着：一打开只看原文，一分不花',
            },
            h('input', {
              type: 'checkbox',
              checked: lens.config.autoSummarize === true,
              onChange: (event) => void saveConfig({ autoSummarize: event.target.checked }),
            }),
            h('span', { className: 'pl-switch-box' }),
            h('span', { className: 'pl-switch-text' }, lens.config.autoSummarize ? '开' : '关'),
          ),
          h('input', {
            type: 'number',
            className: 'pl-num',
            min: 1,
            max: 20,
            step: 1,
            defaultValue: autoCountValue,
            onBlur: (event) => {
              const next = Math.min(20, Math.max(1, Math.round(Number(event.target.value) || 3)))
              event.target.value = String(next)
              void saveConfig({ autoSummarizeCount: next })
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.target.blur()
            },
            title: '打开面板时自动讲最近这么多步',
          }),
          h('span', { className: 'pl-unit' }, '步 · 一打开就自动讲这些的概要'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'pl-more',`,
  ],
  [
    'hint 增加一条',
    "              h('p', null, '· 讲这步 / 全部讲一遍：点哪个讲哪个，点一次算一次模型调用，讲到过的会标「讲完了」。'),",
    "              h('p', null, '· 讲这步 / 全部讲一遍：点哪个讲哪个，点一次算一次模型调用，讲到过的会标「讲完了」。'),\n              h('p', null, '· 打开时自动讲：开了以后每次打开面板，自动把最近 N 步（默认 3）翻成人话概要；不想要就关掉，一打开只看原文。'),",
  ],
])
