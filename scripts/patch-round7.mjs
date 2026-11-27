/** 补丁 7：每次重新打开面板都允许再评估一次（已讲过的仍会被过滤，不会重复花钱）。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'client.js'
let text = readFileSync(file, 'utf8')

const from = `        if (!lens.open || !lens.sessionId || lens.turn === null || lens.turn === undefined) return
        if (lens.config.autoSummarize !== true) return`
const to = `        if (!lens.open) {
          autoDoneRef.current = ''
          return
        }
        if (!lens.sessionId || lens.turn === null || lens.turn === undefined) return
        if (lens.config.autoSummarize !== true) return`

if (text.includes('autoDoneRef.current = \'\'\n          return')) {
  console.log('skip already')
} else if (!text.includes(from)) {
  throw new Error('anchor missing')
} else {
  writeFileSync(file, text.replace(from, to))
  console.log('ok reopen resets auto guard')
}
