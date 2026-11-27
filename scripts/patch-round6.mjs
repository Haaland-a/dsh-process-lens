/** 补丁 6：harness 增加 autoSummarize 断言。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'harness.mjs'
let text = readFileSync(file, 'utf8')

const anchor = `check('步数超过 100 会被夹住', clamped.json?.settings?.recent === 100, clamped.json?.settings?.recent)`
const added = `${anchor}
await hit('/process-lens/api/config', 'POST', { autoSummarize: true, autoSummarizeCount: 5 })
const autoCfg = await hit('/process-lens/api/config')
check(
  '「打开时自动讲最近 N 步」存得住',
  autoCfg.json?.settings?.autoSummarize === true && autoCfg.json?.settings?.autoSummarizeCount === 5,
  autoCfg.json?.settings,
)
await hit('/process-lens/api/config', 'POST', { autoSummarizeCount: 99 })
const clampAuto = await hit('/process-lens/api/config')
check('自动讲步数上限 20', clampAuto.json?.settings?.autoSummarizeCount === 20, clampAuto.json?.settings?.autoSummarizeCount)
await hit('/process-lens/api/config', 'POST', { autoSummarize: false, autoSummarizeCount: 3 })`

if (text.includes('「打开时自动讲最近 N 步」存得住')) {
  console.log('skip already')
} else if (!text.includes(anchor)) {
  throw new Error('anchor missing')
} else {
  text = text.replace(anchor, added)
  writeFileSync(file, text)
  console.log('ok harness autoSummarize checks')
}
