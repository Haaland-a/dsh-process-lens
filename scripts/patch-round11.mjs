/** 补丁 11：把风格/提示词辅助函数挪进 apply() 作用域（它们要读 settings）。 */
import { readFileSync, writeFileSync } from 'node:fs'

const helpers = readFileSync('scripts/snips/helpers.txt', 'utf8').trimEnd()
const file = 'index.js'
let text = readFileSync(file, 'utf8')

// 1) 从模块顶层移除
const moduleAnchor = `${helpers}

// ── 状态 ──────────────────────────────────────────────────────────────────────`
const cleaned = `${'// ── 状态 ──────────────────────────────────────────────────────────────────────'}`
if (text.includes(moduleAnchor)) {
  text = text.replace(moduleAnchor, cleaned)
  console.log('ok 模块顶层已移除')
} else {
  console.log('skip 模块顶层（没找到待移除块）')
}

// 2) 插进 apply() 内部：放在 saveSettingsSoon 之前
const insideAnchor = `  function saveSettingsSoon() {`
if (text.includes('function promptList()')) {
  console.log('skip 已存在 promptList')
} else if (!text.includes(insideAnchor)) {
  throw new Error('apply 内锚点缺失')
} else {
  text = text.replace(insideAnchor, `${helpers}

${insideAnchor}`)
  console.log('ok 已插入 apply()')
}

writeFileSync(file, text)
