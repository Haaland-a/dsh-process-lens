/** 补丁 14：harness 增加 风格 / 提示词预览 / 存档 / 省 token 断言。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'harness.mjs'
let text = readFileSync(file, 'utf8')

const anchor = `const failed = checks.filter((item) => !item.ok)`
const block = `// 11) 讲解风格
await hit('/process-lens/api/config', 'POST', { style: 'pro' })
const styleCfg = await hit('/process-lens/api/config')
check('总结风格存得住', styleCfg.json?.settings?.style === 'pro', styleCfg.json?.settings?.style)
check('风格列表有四种', styleCfg.json?.settings?.styles?.length === 4, styleCfg.json?.settings?.styles?.map((item) => item.id))

// 12) 预览当前提示词
const prompt1 = await hit(\`/process-lens/api/prompt?session=\${SESSION_ID}\`)
check('能看到系统提示词', String(prompt1.json?.system ?? '').includes('标题：'), String(prompt1.json?.system ?? '').slice(0, 40))
check('能看到这一步的真实内容', String(prompt1.json?.user ?? '').includes('第 1 步'), String(prompt1.json?.user ?? '').slice(0, 60))

// 13) 省 token 模式确实更短
await hit('/process-lens/api/config', 'POST', { compact: false })
const bigPrompt = await hit(\`/process-lens/api/prompt?session=\${SESSION_ID}\`)
await hit('/process-lens/api/config', 'POST', { compact: true, compactCount: 5 })
const smallPrompt = await hit(\`/process-lens/api/prompt?session=\${SESSION_ID}\`)
check(
  '省 token 模式确实更短',
  (smallPrompt.json?.chars ?? 0) < (bigPrompt.json?.chars ?? 1) * 0.9,
  { 关: bigPrompt.json?.chars, 开: smallPrompt.json?.chars },
)
check('省 token 模式会说明是压缩过的', String(smallPrompt.json?.user ?? '').includes('省 token'), String(smallPrompt.json?.user ?? '').slice(0, 40))

// 14) 自定义提示词存档
const saved = await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '给老板看', text: '一句话说完，别讲细节。' })
check('能存一份自己的提示词', saved.json?.prompts?.length === 1 && saved.json.prompts[0].name === '给老板看', saved.json?.prompts?.map((item) => item.name))
const savedId = saved.json?.prompts?.[0]?.id
check('存完自动切过去', saved.json?.settings?.activePrompt === savedId, saved.json?.settings?.activePrompt)
const customPrompt = await hit(\`/process-lens/api/prompt?session=\${SESSION_ID}\`)
check('预览里用的是自己的提示词', String(customPrompt.json?.system ?? '').includes('一句话说完'), String(customPrompt.json?.system ?? '').slice(0, 30))
check('三行格式仍然被强制补上', String(customPrompt.json?.system ?? '').includes('标题：'), String(customPrompt.json?.system ?? '').slice(-40))
const backToPreset = await hit('/process-lens/api/prompts', 'POST', { action: 'select', id: '' })
check('可以切回内置风格', backToPreset.json?.settings?.activePrompt === '', backToPreset.json?.settings?.activePrompt)
const removed = await hit('/process-lens/api/prompts', 'POST', { action: 'delete', id: savedId })
check('可以删掉存档', Array.isArray(removed.json?.prompts) && removed.json.prompts.length === 0, removed.json?.prompts)

const failed = checks.filter((item) => !item.ok)`

if (text.includes('总结风格存得住')) {
  console.log('skip already')
} else if (!text.includes(anchor)) {
  throw new Error('anchor missing')
} else {
  writeFileSync(file, text.replace(anchor, block))
  console.log('ok harness 新增断言')
}
