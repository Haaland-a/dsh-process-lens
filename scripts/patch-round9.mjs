/** 补丁 9：README 增加「打开时自动讲 N 步」。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'README.md'
let text = readFileSync(file, 'utf8')

const anchorAfter =
  "「自动弹出」开关（默认关）：开了以后只要出现新一轮就把面板摊出来——**摊出来也只是给你看原文，不会自动讲**。"
const insert = `${anchorAfter}

**打开时自动讲 N 步**（设置区第五行，默认关）：开了以后，每次你打开面板，插件会自动把**最近 N 步**（默认 3，可填 1–20）翻成人话概要摆出来，你点开就有东西看，不用一步步点 `讲这步`。代价是每次打开都花 N 次模型调用；已经讲过的步会被跳过，不会重复收钱。

- 关着（默认）：一打开只显示原文，一分不花，想看哪步点哪步。
- 开着：打开即有概要；同一轮里已经讲过的不会再讲，重新打开时只补没讲过的。
- 想临时只讲一步：不管这个开关，直接点那张卡的 `讲这步`。`

if (text.includes('**打开时自动讲 N 步**')) {
  console.log('skip already')
} else if (!text.includes(anchorAfter)) {
  throw new Error('anchor missing')
} else {
  text = text.replace(anchorAfter, insert)
  if (text.includes('用假 ctx 跑 28 条断言')) {
    text = text.replace('用假 ctx 跑 28 条断言', '用假 ctx 跑 30 条断言')
  }
  if (text.includes('`recent` 默认值与上下限。不联网、不花额度。')) {
    text = text.replace(
      '`recent` 默认值与上下限。不联网、不花额度。',
      '`recent` 默认值与上下限、`autoSummarize` 开关与 1–20 上限。不联网、不花额度。',
    )
  }
  writeFileSync(file, text)
  console.log('ok README')
}
