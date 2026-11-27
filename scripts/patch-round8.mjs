/** 补丁 8：顶部提示反映「打开时自动讲」开关。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'client.js'
let text = readFileSync(file, 'utf8')

const from = `            h('span', { className: 'pl-bar-text' }, '默认只显示原文。点一次才花一次额度，讲过的会标「讲完了」'),`
const to = `            h(
              'span',
              { className: 'pl-bar-text' },
              lens.config.autoSummarize === true
                ? \`已开「打开时自动讲最近 \${Math.min(20, Math.max(1, Math.round(Number(lens.config.autoSummarizeCount) || 3)))} 步」：每次打开面板都会自动生成这些概要（花额度）\`
                : '默认只显示原文。点一次才花一次额度，讲过的会标「讲完了」',
            ),`

if (text.includes('已开「打开时自动讲最近')) {
  console.log('skip already')
} else if (!text.includes(from)) {
  throw new Error('anchor missing')
} else {
  writeFileSync(file, text.replace(from, to))
  console.log('ok bar text')
}
