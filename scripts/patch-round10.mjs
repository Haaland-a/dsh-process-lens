/**
 * 补丁 10（Host 半）：讲解风格 / 自定义提示词存档 / 提示词预览 / 省 token 模式。
 * 用 snippets 文件做替换，避免在补丁脚本里嵌套模板字符串。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')
const file = 'index.js'
let text = read(file)
let applied = 0
let missed = []

function replaceOnce(name, from, to) {
  if (!text.includes(from)) {
    if (text.includes(to.slice(0, 60))) {
      console.log(`skip ${name}`)
      return
    }
    missed.push(name)
    console.log(`MISS ${name}`)
    return
  }
  text = text.replace(from, to)
  applied += 1
  console.log(`ok   ${name}`)
}

// 1) SYSTEM_PROMPT -> 风格预设 + 输出规则
const oldSystem = `const SYSTEM_PROMPT = [
  '你是「过程讲解员」，负责把 AI 助手刚才做的事，用中文大白话讲给完全不懂技术的人听。',
  '硬性要求：',
  '1. 不出现代码、文件路径原文、英文缩写、工具名；必须提到时用"文件""命令""搜索"这类日常说法。',
  '2. 不用 markdown，不写列表，不写多余的客套话。',
  '3. 只输出三行，格式严格如下：',
  '标题：不超过 14 个字，说清这一步在干什么',
  '在做什么：不超过 100 个字，说清为什么要做这一步',
  '结果：不超过 100 个字，说清得到了什么、顺不顺利、有没有卡住',
].join('\\n')`

replaceOnce('风格预设替换 SYSTEM_PROMPT', oldSystem, read('scripts/snips/styles.txt').trimEnd())

// 2) DEFAULTS 增加字段
replaceOnce(
  'DEFAULTS 增加风格/提示词/省token',
  `  /** 打开面板时自动讲最近几步（花额度，默认关） */
  autoSummarize: false,
  autoSummarizeCount: 3,`,
  `  /** 打开面板时自动讲最近几步（花额度，默认关） */
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
  compactCount: 5,`,
)

// 3) publicSettings 增加字段
replaceOnce(
  'publicSettings 增加字段',
  `      autoSummarizeCount: settings.autoSummarizeCount,
    }
  }`,
  `      autoSummarizeCount: settings.autoSummarizeCount,
      ...styleView(),
      styles: stylesView(),
      prompts: promptList(),
      compact: settings.compact === true,
      compactCount: settings.compactCount,
    }
  }`,
)

// 4) 风格与提示词辅助函数，插到「状态」区之前
replaceOnce(
  '插入风格/提示词辅助函数',
  `// ── 状态 ──────────────────────────────────────────────────────────────────────`,
  `${read('scripts/snips/helpers.txt').trimEnd()}

// ── 状态 ──────────────────────────────────────────────────────────────────────`,
)

// 5) buildPrompt 整段替换
const oldBuildStart = '  function buildPrompt(record, step) {'
const oldBuildEnd = `    lines.push('请按三行格式讲给用户听。')
    return lines.join('\\n')
  }`
const startAt = text.indexOf(oldBuildStart)
if (startAt >= 0 && text.includes(oldBuildEnd)) {
  const endAt = text.indexOf(oldBuildEnd, startAt) + oldBuildEnd.length
  const current = text.slice(startAt, endAt)
  if (current.includes('省 token 模式：信息已压缩')) {
    console.log('skip buildPrompt')
  } else {
    text = text.slice(0, startAt) + read('scripts/snips/build-prompt.txt').trimEnd() + text.slice(endAt)
    applied += 1
    console.log('ok   buildPrompt 支持省 token 模式')
  }
} else {
  missed.push('buildPrompt')
  console.log('MISS buildPrompt')
}

// 6) callOnce 接收 system
replaceOnce('callOnce 签名', 'async function callOnce(route, prompt) {', 'async function callOnce(route, prompt, system) {')
replaceOnce('callOnce 用当前提示词', '        system: SYSTEM_PROMPT,', '        system: system ?? systemPromptNow(),')

// 7) runJob 传当前提示词
replaceOnce(
  'runJob 传 system',
  '      const text = await callOnce(route, buildPrompt(record, entry))',
  '      const text = await callOnce(route, buildPrompt(record, entry), systemPromptNow())',
)

// 8) /config POST 接受新字段
replaceOnce(
  'config POST 风格/省token',
  `        if (Number.isFinite(Number(body.autoSummarizeCount)))
          settings.autoSummarizeCount = Math.min(20, Math.max(1, Math.round(Number(body.autoSummarizeCount))))`,
  `        if (Number.isFinite(Number(body.autoSummarizeCount)))
          settings.autoSummarizeCount = Math.min(20, Math.max(1, Math.round(Number(body.autoSummarizeCount))))
        if (STYLE_PRESETS[body.style]) settings.style = body.style
        if (typeof body.activePrompt === 'string')
          settings.activePrompt = promptList().some((item) => item.id === body.activePrompt) ? body.activePrompt : ''
        if (typeof body.compact === 'boolean') settings.compact = body.compact
        if (Number.isFinite(Number(body.compactCount)))
          settings.compactCount = Math.min(50, Math.max(1, Math.round(Number(body.compactCount))))`,
)

// 9) 新增 /prompt 与 /prompts 路由
replaceOnce(
  '插入提示词路由',
  `      writeJson(res, 404, { ok: false, error: 'not-found' })`,
  `${read('scripts/snips/prompt-routes.txt').trimEnd()}
      writeJson(res, 404, { ok: false, error: 'not-found' })`,
)

writeFileSync(file, text)
console.log(`\nindex.js: ${applied} applied, ${missed.length} missed${missed.length ? ` -> ${missed.join(', ')}` : ''}`)
if (missed.length) process.exitCode = 2
