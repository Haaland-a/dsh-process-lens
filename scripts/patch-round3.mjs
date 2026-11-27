/**
 * 补丁 3：参数也留全文，前端原文块里能看到真正的调用参数。
 * 幂等：目标字符串已存在时跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  let applied = 0
  for (const [name, from, to] of pairs) {
    if (from && text.includes(to)) {
      console.log(`skip ${file} ${name}`)
      continue
    }
    if (from && !text.includes(from)) {
      console.log(`MISS ${file} ${name}`)
      continue
    }
    text = from ? text.split(from).join(to) : text.replace(to.anchor, to.replacement)
    applied += 1
    console.log(`ok   ${file} ${name}`)
  }
  writeFileSync(file, text)
  console.log(`${file}: ${applied} 处`)
}

patch('index.js', [
  [
    'tool/call 存全文参数',
    "          detail: argsSummary(data.arguments),\n          result: '',",
    "          detail: argsSummary(data.arguments),\n          args: clip(typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? ''), FULL_CHARS),\n          result: '',",
  ],
  [
    'raw.actions 带上参数',
    "          label: toolLabel(tool.name),\n          detail: tool.detail ? clip(tool.detail, 2000) : '',",
    "          label: toolLabel(tool.name),\n          detail: tool.detail ? clip(tool.detail, 2000) : '',\n          args: tool.args ? clip(tool.args, FULL_CHARS) : '',",
  ],
])

patch('client.js', [
  [
    '原文块渲染参数',
    "            action.detail ? h('div', { className: 'pl-raw-code' }, action.detail) : null,",
    "            action.detail ? h('div', { className: 'pl-raw-code' }, action.detail) : null,\n            action.args && action.args !== action.detail\n              ? h('div', { className: 'pl-raw-code is-args' }, action.args)\n              : null,",
  ],
])
