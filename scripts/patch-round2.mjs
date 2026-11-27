/**
 * 一次性补丁：把原文从「节选」改成「全文」，并给设置加上 recent（打开时显示最近 N 步）。
 * 幂等：已经改过的字符串会被跳过。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const HOST = 'index.js'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8')
  let changed = 0
  for (const [from, to] of pairs) {
    if (text.includes(to) && !text.includes(from)) {
      console.log(`skip (already) ${file}: ${from.slice(0, 40)}…`)
      continue
    }
    if (!text.includes(from)) {
      console.log(`MISS ${file}: ${from.slice(0, 60)}…`)
      continue
    }
    text = text.split(from).join(to)
    changed += 1
  }
  writeFileSync(file, text)
  console.log(`${file}: applied ${changed}/${pairs.length}`)
}

patch(HOST, [
  ["clip(step.reasoning, 700)", 'clip(step.reasoning, FULL_CHARS)'],
  ["clip(step.answer, 1400)", 'clip(step.answer, FULL_CHARS)'],
  ["clip(tool.detail, 300)", 'clip(tool.detail, 2000)'],
  [
    "output: tool.state === 'error' ? clip(tool.error || '出错了', 320) : clip(tool.result || '', 320),",
    "output: tool.state === 'error' ? clip(tool.error || '出错了', 600) : clip(tool.result || '', FULL_CHARS),",
  ],
  [
    'tool.result = oneLine(textOf(data.message), RESULT_CHARS)',
    'tool.result = clip(textOf(data.message), FULL_CHARS)',
  ],
  [
    "`返回：${clip(tool.result || '没有内容', RESULT_CHARS)}`",
    "`返回：${oneLine(tool.result, RESULT_CHARS) || '没有内容'}`",
  ],
  [
    "        if (typeof body.autoOpen === 'boolean') settings.autoOpen = body.autoOpen\n",
    "        if (typeof body.autoOpen === 'boolean') settings.autoOpen = body.autoOpen\n        if (Number.isFinite(Number(body.recent))) settings.recent = Math.min(100, Math.max(0, Math.round(Number(body.recent))))\n",
  ],
])
