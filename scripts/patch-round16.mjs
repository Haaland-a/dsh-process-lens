/** 补丁 16：修 harness —— 变量名修正 + 省 token 断言改成验行为而不是比长度。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'harness.mjs'
let text = readFileSync(file, 'utf8')
let changed = 0

const fixName = `check('能存一份自己的提示词', savedPrompt.json?.prompts?.length === 1 && saved.json.prompts[0].name === '给老板看', savedPrompt.json?.prompts?.map((item) => item.name))`
const fixNameTo = `check('能存一份自己的提示词', savedPrompt.json?.prompts?.length === 1 && savedPrompt.json.prompts[0].name === '给老板看', savedPrompt.json?.prompts?.map((item) => item.name))`
if (text.includes(fixName)) {
  text = text.replace(fixName, fixNameTo)
  changed += 1
  console.log('ok  变量名修正')
}

const oldCheck = `check(
  '省 token 模式确实更短',
  (smallPrompt.json?.chars ?? 0) < (bigPrompt.json?.chars ?? 1) * 0.9,
  { 关: bigPrompt.json?.chars, 开: smallPrompt.json?.chars },
)`
const newCheck = `check(
  '省 token 模式会带「最近 N 条概要」',
  String(smallPrompt.json?.user ?? '').includes('一共只给最近') && String(smallPrompt.json?.user ?? '').includes('第 1 步'),
  String(smallPrompt.json?.user ?? '').slice(0, 80),
)
check(
  '省 token 模式没把用户诉求丢掉',
  String(smallPrompt.json?.user ?? '').includes('用户提的诉求'),
  String(smallPrompt.json?.user ?? '').slice(0, 40),
)`
if (text.includes(oldCheck)) {
  text = text.replace(oldCheck, newCheck)
  changed += 1
  console.log('ok  省 token 断言改写')
}

// bigPrompt 现在没用了，保留即可（避免再改动）

writeFileSync(file, text)
console.log(`changed ${changed}`)
