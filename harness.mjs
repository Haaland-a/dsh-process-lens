/**
 * 一次性自测：用假 ctx 验收「历史补账」逻辑，不碰真实模型。
 * 跑法：node harness.mjs
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_PROFILE_DIR = join(import.meta.dirname, '.tmp-profile')

const { apply } = await import('./index.js')

const llmCalls = []
const routes = []
const listeners = new Map()

// 一段"插件装好之前就已经跑完"的会话历史
const SESSION_ID = 'S1'
const events = [
  { type: 'turn/start', time: 1000, data: { turn: 1 } },
  { type: 'user/message', time: 1001, data: { role: 'user', content: [{ type: 'text', text: '帮我看下 dsh-process-lens 这个插件还能不能救' }] } },
  { type: 'step/start', time: 1010, data: { turn: 1, step: 1 } },
  { type: 'tool/call', time: 1011, data: { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"process-lens","path":"E:\\\\x"}' } },
  { type: 'tool/result', time: 1020, data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '3 matches' }] } } },
  { type: 'assistant/message', time: 1030, data: { turn: 1, step: 1, message: { id: 'MSG-A', content: [{ type: 'text', text: '找到了入口' }] }, stream: [] } },
  { type: 'step/end', time: 1040, data: { turn: 1, step: 1 } },
  { type: 'turn/end', time: 1050, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', time: 2000, data: { turn: 2 } },
  { type: 'user/message', time: 2001, data: { role: 'user', content: [{ type: 'text', text: '那再顺手加个开关' }] } },
  { type: 'step/start', time: 2010, data: { turn: 2, step: 1 } },
  { type: 'tool/call', time: 2011, data: { turn: 2, step: 1, callId: 'c2', name: 'write', arguments: '{"file_path":"E:\\\\a\\\\b.js"}' } },
  { type: 'tool/result', time: 2012, data: { turn: 2, step: 1, message: { toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }] }, error: { name: 'EACCES', reason: 'permission denied' } } },
]

const ctx = {
  logger: { warn: () => {}, info: () => {}, debug: () => {} },
  effect: (fn) => {
    try {
      fn()
    } catch (error) {
      console.error('effect 抛错', error)
    }
  },
  on: (name, handler) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  },
  get: (name) => {
    if (name === 'sessions') {
      return {
        get: (id) =>
          id === SESSION_ID
            ? { id, snapshotEvents: () => events }
            : undefined,
      }
    }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
        stream: (options) => {
          llmCalls.push(options)
          throw new Error('测试里不该调模型')
        },
      }
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) }
    if (name === 'agents') return { get: () => undefined }
    return undefined
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)

function fakeRes() {
  return {
    status: 0,
    body: '',
    head: null,
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

async function hit(path, method = 'GET', body) {
  const handler = routes.find((route) => path.startsWith(route.path))?.handler
  if (!handler) throw new Error(`没有匹配的路由：${path}`)
  const res = fakeRes()
  const req = { method, url: path, headers: {}, on: () => {}, [Symbol.asyncIterator]: async function* () {} }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body))
    }
  }
  await handler(req, res)
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = res.body
  }
  return { status: res.status, json: parsed }
}

const checks = []
const check = (name, ok, extra) => {
  checks.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${JSON.stringify(extra)}` : ''}`)
}

// 1) 首次访问：靠 /turn 触发补账，把 messageId 映射回轮次
const turnHit = await hit(`/process-lens/api/turn?session=${SESSION_ID}&messageId=MSG-A`)
check('旧轮次能按 messageId 找回 turn', turnHit.json?.turn === 1, turnHit.json)

// 2) 最新一轮
const latest = await hit(`/process-lens/api/latest?session=${SESSION_ID}`)
check('latest 指向第 2 轮', latest.json?.turn === 2 && latest.json?.status === 'running', latest.json)

// 3) 快照：卡片 + 工具 + 大白的字段都在
const snap1 = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=1`)
const card1 = snap1.json?.data?.steps?.[0]
check('第 1 轮有 1 张卡', snap1.json?.data?.steps?.length === 1 && card1?.step === 1)
check('卡里有步骤标题', typeof card1?.title === 'string' && card1.title.includes('第 1 步'), card1?.title)
check('工具被翻译成人话标签', card1?.tools?.[0]?.label?.length > 1, card1?.tools?.[0])
check('原文也一起带着（不花额度就能看）', card1?.raw?.actions?.[0]?.name === 'grep' && String(card1?.raw?.actions?.[0]?.detail ?? '').includes('process-lens'), card1?.raw?.actions?.[0])
check('原文里有它自己说的话', String(card1?.raw?.answer ?? '').includes('找到了入口'), card1?.raw?.answer)
check('请求被摘成一句话', snap1.json?.data?.request?.includes('dsh-process-lens'), snap1.json?.data?.request)
check('回放只记账，没人看就不花 token', card1?.explain === 'idle', card1?.explain)
check('整轮状态是 done', snap1.json?.data?.status === 'done', snap1.json?.data?.status)

// 4) 失败的工具要标红
const snap2 = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=2`)
const tool2 = snap2.json?.data?.steps?.[0]?.tools?.[0]
check('失败的工具标成 error', tool2?.state === 'error', tool2)

// 5) 补账期间一次模型调用都不许发生
check('补账没有调用模型', llmCalls.length === 0, { calls: llmCalls.length })

// 6) 设置读写
const saved = await hit('/process-lens/api/config', 'POST', { provider: 'deepseek', model: 'chat', mode: 'eager', autoOpen: true })
check('设置能存下', saved.json?.settings?.mode === 'eager' && saved.json?.settings?.autoOpen === true, saved.json?.settings)

// 7) 设置项都能存、都能读回
await hit('/process-lens/api/config', 'POST', { provider: 'deepseek', model: 'chat', autoOpen: false })
const again = await hit('/process-lens/api/config')
check('模型选择存得住', again.json?.settings?.provider === 'deepseek' && again.json?.settings?.model === 'chat', again.json?.settings)
check('「打开时显示几步」默认 8', again.json?.settings?.recent === 8, again.json?.settings?.recent)
await hit('/process-lens/api/config', 'POST', { recent: 20 })
const recentCfg = await hit('/process-lens/api/config')
check('「打开时显示几步」存得住', recentCfg.json?.settings?.recent === 20, recentCfg.json?.settings?.recent)
await hit('/process-lens/api/config', 'POST', { recent: 999 })
const clampedCfg = await hit('/process-lens/api/config')
check('步数超过 100 会被夹住', clampedCfg.json?.settings?.recent === 100, clampedCfg.json?.settings?.recent)
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
await hit('/process-lens/api/config', 'POST', { autoSummarize: false, autoSummarizeCount: 3 })
const models = await hit('/process-lens/api/models')
check('模型目录能列出来', models.json?.providers?.[0]?.models?.[0]?.id === 'chat', models.json?.providers)
check('会告诉前端会话现在用的哪个模型', models.json?.current?.model === 'chat', models.json?.current)

function openStream(path) {
  const handler = routes.find((route) => path.startsWith(route.path))?.handler
  const writes = []
  let onClose = () => {}
  const res = {
    headers: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    flushHeaders() {},
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    end() {},
    on() {},
  }
  const req = {
    method: 'GET',
    url: path,
    headers: {},
    on(name, fn) {
      if (name === 'close') onClose = fn
    },
  }
  handler(req, res)
  return { writes, close: () => onClose() }
}

// 8) 只连流（= 用户打开面板看原文）绝不能花钱
const stream = openStream(`/process-lens/stream?session=${SESSION_ID}&turn=1`)
await new Promise((resolve) => setTimeout(resolve, 120))
check('连上先推一份快照', stream.writes.some((chunk) => chunk.includes('event: snap')), stream.writes.length)
check('只看不点：一次模型都没调', llmCalls.length === 0, { calls: llmCalls.length })

// 9) 用户点「讲这步」才花一次钱，并且用的是插件自己选的模型
const explained = await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 1, step: 1 })
check('点讲这步会接单', explained.json?.steps?.[0] === 1, explained.json)
await new Promise((resolve) => setTimeout(resolve, 200))
check('点了才调模型（正好一次）', llmCalls.length === 1, { calls: llmCalls.length })
check('讲解用的是插件自己选的模型', llmCalls[0]?.provider === 'deepseek' && llmCalls[0]?.model === 'chat', {
  provider: llmCalls[0]?.provider,
  model: llmCalls[0]?.model,
})
const afterFail = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=1`)
check('讲失败了会明说，不静默', afterFail.json?.data?.steps?.[0]?.explain === 'failed', afterFail.json?.data?.steps?.[0]?.explain)
check('失败也让流里收到更新', stream.writes.some((chunk) => chunk.includes('event: card')), stream.writes.length)
stream.close()

// 10) 「全部讲一遍」不该重复讲已经讲好的
const all = await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 1 })
check('全部讲一遍会跳过讲过的', Array.isArray(all.json?.steps) && all.json.steps.length === 1, all.json?.steps)
check('跳过就没再调模型', llmCalls.length === 2, { calls: llmCalls.length })

// 11) 讲解风格
await hit('/process-lens/api/config', 'POST', { style: 'pro' })
const styleCfg = await hit('/process-lens/api/config')
check('总结风格存得住', styleCfg.json?.settings?.style === 'pro', styleCfg.json?.settings?.style)
check('风格列表有四种', styleCfg.json?.settings?.styles?.length === 4, styleCfg.json?.settings?.styles?.map((item) => item.id))

// 12) 预览当前提示词
const prompt1 = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('能看到系统提示词', String(prompt1.json?.system ?? '').includes('标题：'), String(prompt1.json?.system ?? '').slice(0, 40))
check('能看到这一步的真实内容', String(prompt1.json?.user ?? '').includes('第 1 步'), String(prompt1.json?.user ?? '').slice(0, 60))

// 13) 省 token 模式确实更短
await hit('/process-lens/api/config', 'POST', { compact: false })
const bigPrompt = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
await hit('/process-lens/api/config', 'POST', { compact: true, compactCount: 5 })
const smallPrompt = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check(
  '省 token 模式会带「最近 N 条概要」',
  String(smallPrompt.json?.user ?? '').includes('一共只给最近') && String(smallPrompt.json?.user ?? '').includes('第 1 步'),
  String(smallPrompt.json?.user ?? '').slice(0, 80),
)
check(
  '省 token 模式没把用户诉求丢掉',
  String(smallPrompt.json?.user ?? '').includes('用户提的诉求'),
  String(smallPrompt.json?.user ?? '').slice(0, 40),
)
check('省 token 模式会说明是压缩过的', String(smallPrompt.json?.user ?? '').includes('省 token'), String(smallPrompt.json?.user ?? '').slice(0, 40))

// 14) 自定义提示词存档
const savedPrompt = await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '给老板看', text: '一句话说完，别讲细节。' })
check('能存一份自己的提示词', savedPrompt.json?.prompts?.length === 1 && savedPrompt.json.prompts[0].name === '给老板看', savedPrompt.json?.prompts?.map((item) => item.name))
const savedId = savedPrompt.json?.prompts?.[0]?.id
check('存完自动切过去', savedPrompt.json?.settings?.activePrompt === savedId, savedPrompt.json?.settings?.activePrompt)
const customPrompt = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('预览里用的是自己的提示词', String(customPrompt.json?.system ?? '').includes('一句话说完'), String(customPrompt.json?.system ?? '').slice(0, 30))
check('三行格式仍然被强制补上', String(customPrompt.json?.system ?? '').includes('标题：'), String(customPrompt.json?.system ?? '').slice(-40))
const backToPreset = await hit('/process-lens/api/prompts', 'POST', { action: 'select', id: '' })
check('可以切回内置风格', backToPreset.json?.settings?.activePrompt === '', backToPreset.json?.settings?.activePrompt)
const removed = await hit('/process-lens/api/prompts', 'POST', { action: 'delete', id: savedId })
check('可以删掉存档', Array.isArray(removed.json?.prompts) && removed.json.prompts.length === 0, removed.json?.prompts)

// 15) 外观主题三档
const themeDefault = await hit('/process-lens/api/config')
check('外观默认跟随宿主', themeDefault.json?.settings?.theme === 'auto', themeDefault.json?.settings?.theme)
const themeDark = await hit('/process-lens/api/config', 'POST', { theme: 'dark' })
check('能选固定深色', themeDark.json?.settings?.theme === 'dark', themeDark.json?.settings?.theme)
const themeBad = await hit('/process-lens/api/config', 'POST', { theme: 'neon' })
check('乱七八糟的值会被忽略', themeBad.json?.settings?.theme === 'dark', themeBad.json?.settings?.theme)
const themeLight = await hit('/process-lens/api/config', 'POST', { theme: 'light' })
check('能选固定浅色', themeLight.json?.settings?.theme === 'light', themeLight.json?.settings?.theme)
await hit('/process-lens/api/config', 'POST', { theme: 'auto' })
// 16) 讲解时是否思考（默认关）
const thinkDefault = await hit('/process-lens/api/config')
check('思考默认是关的', thinkDefault.json?.settings?.thinking === false, thinkDefault.json?.settings?.thinking)
const thinkOn = await hit('/process-lens/api/config', 'POST', { thinking: true })
check('可以打开思考', thinkOn.json?.settings?.thinking === true, thinkOn.json?.settings?.thinking)
const thinkBad = await hit('/process-lens/api/config', 'POST', { thinking: 'yes' })
check('思考开关只认真假', thinkBad.json?.settings?.thinking === true, thinkBad.json?.settings?.thinking)
const thinkOff = await hit('/process-lens/api/config', 'POST', { thinking: false })
check('可以再关掉', thinkOff.json?.settings?.thinking === false, thinkOff.json?.settings?.thinking)
const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exitCode = 1
try {
  rmSync(process.env.DSH_PROFILE_DIR, { recursive: true, force: true })
} catch {}
