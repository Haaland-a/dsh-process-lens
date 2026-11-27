/** 补丁 15：修掉 harness 里 saved 变量重名。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'harness.mjs'
let text = readFileSync(file, 'utf8')

if (text.includes('const savedPrompt =')) {
  console.log('skip already')
} else {
  text = text.replace(
    "const saved = await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '给老板看', text: '一句话说完，别讲细节。' })",
    "const savedPrompt = await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '给老板看', text: '一句话说完，别讲细节。' })",
  )
  text = text.replaceAll('saved.json?.prompts', 'savedPrompt.json?.prompts')
  text = text.replaceAll('saved.json?.settings', 'savedPrompt.json?.settings')
  writeFileSync(file, text)
  console.log('ok renamed')
}
