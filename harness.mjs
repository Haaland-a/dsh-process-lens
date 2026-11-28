/**
 * 一次性自测：用假 ctx 验收「历史补账」逻辑，不碰真实模型。
 * 跑法：node harness.mjs
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_PROFILE_DIR = join(import.meta.dirname, '.tmp-profile')
rmSync(process.env.DSH_PROFILE_DIR, { recursive: true, force: true })

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
      if (llmOverride) return llmOverride
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

var llmOverride = null
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

// 默认开着「工具步骤不找模型」和「每 5 步合并讲一次」；下面的用例要数「调了几次模型」，
// 先把两项都关掉，它们各自在 13b / 24 里单独验。
await hit('/process-lens/api/config', 'POST', { skipTools: false, batchEvery: 0 })

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

// 13) 省 token 模式：内容肥的时候必须真的更短
await hit('/process-lens/api/config', 'POST', { compact: false })
// 造一轮很肥的记录：一段 3000 字的回答 + 12 个工具，压缩才有意义
events.push({ type: 'turn/start', time: 4000, data: { turn: 5 } })
events.push({
  type: 'user/message',
  time: 4001,
  data: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '把这一轮日志全看一遍',
          '<system-reminder>内部提醒不该出现在面板里</system-reminder>',
          'Time sampled while preparing turn 5, step 1: 2026-11-27T20:01:22+08:00[Asia/Shanghai]',
          'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.',
        ].join('\n'),
      },
    ],
  },
})
// 先来 9 步：同一个长路径反复读（逼出实体折叠），前 3 步结果一模一样（逼出连续重复折叠）
for (let index = 1; index <= 9; index += 1) {
  events.push({ type: 'step/start', time: 4010 + index * 5, data: { turn: 5, step: index } })
  events.push({
    type: 'tool/call',
    time: 4011 + index * 5,
    data: { turn: 5, step: index, callId: `e${index}`, name: 'read', arguments: JSON.stringify({ file_path: 'E:/logs/same.log' }) },
  })
  events.push({
    type: 'tool/result',
    time: 4012 + index * 5,
    data: {
      turn: 5,
      step: index,
      message: {
        toolCallId: `e${index}`,
        content: [{ type: 'text', text: index <= 3 ? '前三步的结果一模一样。' : `第 ${index} 步结果：${'这一行是日志正文。'.repeat(6)}` }],
      },
    },
  })
  events.push({ type: 'step/end', time: 4013 + index * 5, data: { turn: 5, step: index } })
}
// 第 10 步最肥：一段 3000 字回答 + 12 次读同一个路径，完整版才会大到能看出差别
events.push({ type: 'step/start', time: 4090, data: { turn: 5, step: 10 } })
events.push({
  type: 'assistant/message',
  time: 4091,
  data: { turn: 5, step: 10, message: { id: 'MSG-FAT', content: [{ type: 'text', text: '我把日志一条条看过了。'.repeat(220) }] }, stream: [] },
})
for (let index = 1; index <= 12; index += 1) {
  events.push({
    type: 'tool/call',
    time: 4100 + index,
    data: { turn: 5, step: 10, callId: `f${index}`, name: 'read', arguments: JSON.stringify({ file_path: 'E:/logs/same.log' }) },
  })
  events.push({
    type: 'tool/result',
    time: 4120 + index,
    data: { turn: 5, step: 10, message: { toolCallId: `f${index}`, content: [{ type: 'text', text: '日志内容很多行。'.repeat(40) }] } },
  })
}
events.push({ type: 'step/end', time: 4150, data: { turn: 5, step: 10 } })
events.push({ type: 'turn/end', time: 4099, data: { turn: 5, reason: { kind: 'completed' } } })
await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=5`)
const bigPrompt = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
await hit('/process-lens/api/config', 'POST', { compact: true, compactCount: 10 })
const smallPrompt = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check(
  '省 token 真的更短',
  Number(smallPrompt.json?.chars) < Number(bigPrompt.json?.chars) * 0.6,
  `省后 ${smallPrompt.json?.chars} 字 / 不省 ${bigPrompt.json?.chars} 字`,
)
check(
  '精炼版会说明：只给最近几步的精炼骨架',
  String(smallPrompt.json?.user ?? '').includes('省 token 模式：最近') && /这是这一轮的第 \d+ 步/.test(String(smallPrompt.json?.user ?? '')),
  String(smallPrompt.json?.user ?? '').slice(0, 80),
)
check(
  '精炼版没把用户诉求丢掉',
  String(smallPrompt.json?.user ?? '').includes('把这一轮日志全看一遍'),
  String(smallPrompt.json?.user ?? '').slice(0, 40),
)
check(
  '用户消息里注入的时间/时区行会被洗掉',
  !String(smallPrompt.json?.user ?? '').includes('Time sampled') &&
    !String(smallPrompt.json?.user ?? '').includes('Asia/Shanghai') &&
    !String(smallPrompt.json?.user ?? '').includes('技能目录更新了'),
  String(smallPrompt.json?.user ?? '').slice(0, 60),
)
check(
  '重复出现的长路径折成 #编号并附图例',
  String(smallPrompt.json?.user ?? '').includes('#1') && String(smallPrompt.json?.user ?? '').includes('图例：'),
  String(smallPrompt.json?.user ?? '').includes('图例：') ? 'has legend' : 'no legend',
)
check(
  '连续同样的事会折成一条（第 i~j 步）',
  /第\d+~\d+步（同样的事做了 \d+ 次）/.test(String(smallPrompt.json?.user ?? '')),
  /第\d+~\d+步/.exec(String(smallPrompt.json?.user ?? ''))?.[0] ?? 'no fold',
)
check('省 token 模式会说明是压缩过的', String(smallPrompt.json?.user ?? '').includes('省 token'), String(smallPrompt.json?.user ?? '').slice(0, 40))
check('预览会说明这次真的用了压缩版', smallPrompt.json?.compactUsed === true, smallPrompt.json?.compactUsed)

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
// 17) 省 token 到底省了多少：同一份数据按两种模式各算一遍字数
const savings = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check(
  '预览里能算出不省 token 时的字数',
  Number(savings.json?.fullChars) > Number(savings.json?.chars),
  `省后 ${savings.json?.chars} / 不省 ${savings.json?.fullChars}`,
)

// 18) 老会话：点开某一轮要把整轮都补回来（末尾 4000 条事件之外的部分也要）
for (let index = 0; index < 4100; index += 1) {
  events.push({ type: 'code/event', time: 3000 + index, data: {} })
}
events.push({ type: 'turn/start', time: 9000, data: { turn: 3 } })
events.push({ type: 'user/message', time: 9001, data: { role: 'user', content: [{ type: 'text', text: '把老会话补全' }] } })
for (let step = 1; step <= 6; step += 1) {
  events.push({ type: 'step/start', time: 9100 + step, data: { turn: 3, step } })
  const args = JSON.stringify({ file_path: `E:/x${step}.js` })
  events.push({ type: 'tool/call', time: 9100 + step, data: { turn: 3, step, callId: `d${step}`, name: 'read', arguments: args } })
  events.push({ type: 'tool/result', time: 9140 + step, data: { turn: 3, step, message: { toolCallId: `d${step}`, content: [{ type: 'text', text: `读完 ${step}` }] } } })
  events.push({ type: 'step/end', time: 9150 + step, data: { turn: 3, step } })
}
events.push({ type: 'turn/end', time: 9200, data: { turn: 3, reason: { kind: 'completed' } } })
const deep = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=3`)
check(
  '老会话点开某一轮能看到全部 6 步',
  deep.json?.data?.steps?.length === 6,
  `拿到 ${deep.json?.data?.steps?.length} 步`,
)
check('补回来的步骤带工具行', Boolean(deep.json?.data?.steps?.[0]?.tools?.[0]?.label), deep.json?.data?.steps?.[0]?.tools?.[0]?.label)

// 19) 过程页「最近 N 步 / 全部」这个选项存得住
const allStepsOn = await hit('/process-lens/api/config', 'POST', { allSteps: true })
check('能选「全部步骤」', allStepsOn.json?.settings?.allSteps === true, allStepsOn.json?.settings?.allSteps)
const allStepsBack = await hit('/process-lens/api/config', 'POST', { allSteps: false })
check('能切回最近 N 步', allStepsBack.json?.settings?.allSteps === false, allStepsBack.json?.settings?.allSteps)

// 20) 阅读保护：读的时候不能因为新步骤进来就被顶掉 / 拽走
const clientSrc = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8')
const hostSrc = readFileSync(join(import.meta.dirname, 'index.js'), 'utf8')
check(
  '新步骤不会把正在读的卡片挤掉（窗口按钉子切）',
  clientSrc.includes('const pool = frozen ? steps.filter((card) => card.step <= pinnedStep) : steps'),
  'frozen 窗口',
)
check(
  '钉住的时候不跟着滚到底',
  clientSrc.includes('if (!node || !pinnedRef.current || pinnedAt) return'),
  'pinnedAt 守卫',
)
check(
  '往上翻就会钉住',
  clientSrc.includes('else pinHere()') && clientSrc.includes('const [pinnedAt, setPinnedAt] = useState(null)'),
  'pinHere',
)
check(
  '点开「展开原文」也会钉住',
  clientSrc.includes('if (next) onPin?.()') && clientSrc.includes('onPin: pinHere'),
  'onPin',
)
check(
  '吸顶条和「回到最新」都去掉了（改成静默钉住）',
  !clientSrc.includes('pl-frozen') && !clientSrc.includes('后面又做了'),
  '不再有吸顶条',
)
check(
  '新步骤不再弹提示，直接静默排队',
  !clientSrc.includes('frozen && queued > 0') && !clientSrc.includes('后面又做了'),
  '静默排队',
)
check(
  '自动弹出默认关（界面上不再写推荐语）',
  clientSrc.includes('新一轮出现时自动打开面板') &&
    !clientSrc.includes('关着（推荐）') &&
    readFileSync(join(import.meta.dirname, 'index.js'), 'utf8').includes('autoOpen: false'),
  'autoOpen 默认关',
)
check(
  '「开着就自动讲」开关进了设置和 Host',
  clientSrc.includes('开着就自动讲') &&
    clientSrc.includes('liveExplain: event.target.checked') &&
    hostSrc.includes('liveExplain: false,') &&
    hostSrc.includes('liveExplain: settings.liveExplain === true') &&
    hostSrc.includes('settings.liveExplain = body.liveExplain'),
  '设置行 + 默认关 + 落到 settings',
)
check(
  '打开着才自动讲：关面板/切设置页就停',
  clientSrc.includes("!lens.open || lens.tab === 'settings' || lens.config.liveExplain !== true") &&
    clientSrc.includes('liveSeenRef.current = null'),
  '三重闸门',
)
check(
  '刚打开不补讲历史，只讲之后的新步',
  clientSrc.includes("cards.filter((card) => card.status === 'done').map((card) => card.step)") &&
    clientSrc.includes('fresh.slice(-2).map((card) => card.step)'),
  '基线只记做完的步 + 每次最多 2 步',
)
check(
  '「省 token++」是「每 N 步发一次」，客户端有开关和步数',
  clientSrc.includes('省 token++') && clientSrc.includes('saveConfig({ batchEvery:') && clientSrc.includes('后台跑'),
  '设置行',
)
check(
  '批量开着时不一步一步单讲，两个自动讲解都短路',
  clientSrc.includes('if (Number(lens.config.batchEvery) >= 2) return') &&
    clientSrc.includes('Number(lens.config.batchEvery) >= 2 || !lens.open'),
  '两个 effect 的闸门',
)
check(
  '省 token++ 开着时两个自动讲直接让路（不再用黄框提醒）',
  !clientSrc.includes('const batchClash') && !clientSrc.includes('pl-warn') && clientSrc.includes('if (Number(lens.config.batchEvery) >= 2) return'),
  '靠短路让路',
)
check(
  '被合并的步会写清楚「并进第 k 步」',
  clientSrc.includes('已并进第 ${card.batchTo} 步的总结') && clientSrc.includes('单独生成'),
  '合并标记有文案，也还能单独讲',
)
check(
   'Host：批量只调一次模型，并记住批到第几步',
  hostSrc.includes('batchEvery: 5,') &&
    hostSrc.includes('function maybeBatch') &&
    hostSrc.includes('record.batchedTo = target.step') &&
    hostSrc.includes("entry.explain = 'batched'") &&
    hostSrc.includes('kind: \'batch\''),
  'maybeBatch + 合并标记',
)
check(
  'Host：自动讲有总闸，三个开关都关就一步不发',
  hostSrc.includes('function autoAllowed()') &&
    hostSrc.includes('if (!autoAllowed()) return false') &&
    hostSrc.includes('viewers += 1') &&
    hostSrc.includes('viewers = Math.max(0, viewers - 1)'),
  'autoAllowed + viewers 计数',
)
check(
  'Host：一轮结束时把剩下的顺手讲掉',
  hostSrc.includes('const flush = upto === undefined || upto === null'),
  'turn/end 补最后一批',
)
check(
  '换一轮会重新跟随最新',
  clientSrc.includes('}, [lens.sessionId, lens.turn])'),
  'reset',
)

// 14) 省 token++：攒够 N 步才找一次模型，一次讲好几步
await hit('/process-lens/api/config', 'POST', {
  batchEvery: 3,
  batchBackground: true,
  autoSummarize: false,
  liveExplain: false,
})
const batchCfg = await hit('/process-lens/api/config')
check(
  '「省 token++」步数和后台跑都存得住',
  batchCfg.json?.settings?.batchEvery === 3 && batchCfg.json?.settings?.batchBackground === true,
  batchCfg.json?.settings,
)
await hit('/process-lens/api/config', 'POST', { batchEvery: 999 })
const batchClamp = await hit('/process-lens/api/config')
check('批量步数上限 50', batchClamp.json?.settings?.batchEvery === 50, batchClamp.json?.settings?.batchEvery)
await hit('/process-lens/api/config', 'POST', { batchEvery: 3 })

const pushEvent = (event) => listeners.get('session/event')?.({ id: SESSION_ID }, event)
function playTurn(turn, steps) {
  pushEvent({ type: 'turn/start', time: turn * 10000, data: { turn } })
  for (let index = 1; index <= steps; index += 1) {
    pushEvent({ type: 'step/start', time: turn * 10000 + index * 10, data: { turn, step: index } })
    pushEvent({
      type: 'tool/call',
      time: turn * 10000 + index * 10 + 1,
      data: { turn, step: index, callId: `t${turn}-${index}`, name: 'read', arguments: '{"file_path":"E:/logs/x.log"}' },
    })
    pushEvent({
      type: 'tool/result',
      time: turn * 10000 + index * 10 + 2,
      data: {
        turn,
        step: index,
        message: { toolCallId: `t${turn}-${index}`, content: [{ type: 'text', text: `第 ${index} 步读完了` }] },
      },
    })
    pushEvent({ type: 'step/end', time: turn * 10000 + index * 10 + 3, data: { turn, step: index } })
  }
}

const callsBeforeBatch = llmCalls.length
playTurn(9, 3)
await new Promise((resolve) => setTimeout(resolve, 350))
check('三步只找一次模型，不是三步三次', llmCalls.length === callsBeforeBatch + 1, {
  calls: llmCalls.length - callsBeforeBatch,
})
const batchPrompt = JSON.stringify(llmCalls[llmCalls.length - 1] ?? {})
check(
  '批量提示词要求「合起来讲一次」',
  batchPrompt.includes('省 token：') && batchPrompt.includes('第 1~3 步'),
  batchPrompt.slice(0, 60),
)
const batchSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=9`)
const batchSteps = batchSnap.json?.data?.steps ?? []
check(
  '这一批没讲成就把合并标记退回单步，不留半截',
  batchSteps[2]?.explain === 'failed' && batchSteps[0]?.explain === 'idle',
  batchSteps.map((item) => item.explain),
)

// 15) 后台跑关着 + 没人看 → 攒着也不花额度
await hit('/process-lens/api/config', 'POST', { batchEvery: 2, batchBackground: false })
const callsQuiet = llmCalls.length
playTurn(10, 4)
await new Promise((resolve) => setTimeout(resolve, 300))
check('没人看又没开后台跑：一步都不调', llmCalls.length === callsQuiet, {
  calls: llmCalls.length - callsQuiet,
})
await hit('/process-lens/api/config', 'POST', { batchEvery: 0, batchBackground: false })
// 16) 重新讲一遍：讲过的也能再讲，还能临时换一份预设提示词（只这一次）
const cfgBeforeReplay = await hit('/process-lens/api/config')
const styleBeforeReplay = cfgBeforeReplay.json?.settings?.style
const callsReplay = llmCalls.length
const replayRes = await hit('/process-lens/api/explain', 'POST', {
  session: SESSION_ID,
  turn: 10,
  step: 2,
  replay: true,
  preset: 's::brief',
})
check('重新讲一遍会接单', replayRes.json?.steps?.[0] === 2, replayRes.json)
const replayCall = llmCalls[llmCalls.length - 1] ?? {}
check('重新讲一遍真的又调了一次模型', llmCalls.length === callsReplay + 1, {
  calls: llmCalls.length - callsReplay,
})
check(
  '临时换的预设进了这一次的 system，不是设置里的',
  String(replayCall.system ?? '').includes('标题控制在 6–10 个字'),
  String(replayCall.system ?? '').slice(0, 40),
)
const cfgAfterReplay = await hit('/process-lens/api/config')
check(
  '换预设只这一次生效，存档里的风格没被改',
  cfgAfterReplay.json?.settings?.style === styleBeforeReplay,
  { before: styleBeforeReplay, after: cfgAfterReplay.json?.settings?.style },
)
check('客户端有「重新讲一遍」按钮和预设菜单',
  clientSrc.includes('重新讲一遍') && clientSrc.includes('pl-menu-item') && clientSrc.includes('replay: true'),
  null,
)
check('Host 认 replay 和一次性预设',
  hostSrc.includes('body.replay === true') && hostSrc.includes('systemPromptWith(job.preset)') && hostSrc.includes('const redo = again === true'),
  null,
)

// 17) 省 token 的抽句/挑行质量：别把 profile.id 劈开，也别让样板行压过结论行
await hit('/process-lens/api/config', 'POST', { compact: true })
const QUALITY_THINK =
  '先看日志，大部分行都是样板。问题是 handler 里直接取了 profile.id，而上游可能返回 undefined，所以要先加空值判断。结论是：先修空值，再跑一遍测试。'
const QUALITY_NOISE = Array.from(
  { length: 10 },
  (_, n) => `[info] 21:0${n}:00 reading E:/logs/very-long-project-name/src/a/b/user-profile-handler.ts (pass ${n + 1})`,
).join('\n')
pushEvent({ type: 'turn/start', time: 99000, data: { turn: 12 } })
pushEvent({ type: 'step/start', time: 99010, data: { turn: 12, step: 1 } })
pushEvent({
  type: 'tool/call',
  time: 99011,
  data: { turn: 12, step: 1, callId: 'q1', name: 'bash', arguments: '{"command":"npm test"}' },
})
pushEvent({
  type: 'tool/result',
  time: 99012,
  data: {
    turn: 12,
    step: 1,
    message: { toolCallId: 'q1', content: [{ type: 'text', text: `${QUALITY_NOISE}\ntests: 42 passed, 0 failed` }] },
  },
})
pushEvent({
  type: 'assistant/message',
  time: 99013,
  data: { turn: 12, step: 1, text: '第 1 步完了。', stream: [{ type: 'reasoning-chunks', texts: [QUALITY_THINK] }] },
})
pushEvent({ type: 'step/end', time: 99014, data: { turn: 12, step: 1 } })
const quality = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
const qualityPrompt = String(quality.json?.user ?? '')
check('抽句不把 profile.id 劈成两半', qualityPrompt.includes('profile.id，而上游'), qualityPrompt.slice(0, 160))
check('样板日志行不压过「42 passed」这种结论行', qualityPrompt.includes('42 passed'), qualityPrompt.slice(0, 160))

// 18) 重放/深扫不会把一次工具调用记成两次（否则卡片上会冒出「共 2 次」「还在进行」）
await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=12`)
const dedupeSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=12`)
const dedupeStep = dedupeSnap.json?.data?.steps?.[0] ?? {}
const dedupeTools = dedupeStep.tools ?? []
check('重放不会把一次工具调用记成两次', dedupeTools.length === 1, dedupeTools.map((item) => item.callId))
check('重放不会留下一条假的「还在进行」', dedupeTools.every((item) => item.state !== 'running'), dedupeTools.map((item) => item.state))

// 19) v0.4.0：主页花销声明、删掉的两块声明、浅色模式底色、提示词准确性
const v040Client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const v040Host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
check('主页写着会花 token', v040Client.includes('讲解会调用模型、消耗 token'))
check('吸顶条「后面又做了 N 步」已删掉', !v040Client.includes('后面又做了'))
check('黄色冲突框已删掉', !v040Client.includes('pl-warn') && !v040Client.includes('和省 token++ 冲突'))
check('浅色模式真的换底色', v040Client.includes('background: #f7f8fb !important') && v040Client.includes('color-scheme: light'))
check('没开自动讲时不再常驻一句声明', !v040Client.includes('默认只显示原文'))
    check('外观不再写「只改这个面板」这类声明', !v040Client.includes('只换这个面板的底色和字色') && !v040Client.includes('跟桌面深浅色和壁纸插件同步'))
    check('跟随档按周围底色切换（读宿主底色 + 内联 important）', v040Client.includes('lum > 0.55') && v040Client.includes("el.style.setProperty('background'"))
    check('界面上不再有「翻译成人话」「讲这步」这类口语', !v040Client.includes('翻译成人话') && !v040Client.includes('讲这步'))
check('提示词要求名词照抄原文', v040Host.includes('名词照抄原文'))
check('默认就跳过工具步骤（省钱不用自己找开关）', v040Host.includes('skipTools: true,'))
check('设置行说人话：工具步骤不找模型', v040Client.includes('工具步骤不找模型') && !v040Client.includes('工具内容不外发'))
check('卡片挂「本机」小签，看得出没找模型', v040Client.includes('pl-localtag') && v040Host.includes('local: true'))
check(
  '「全部生成」不把本机写的步算成待生成',
  v040Client.includes("card.explain !== 'done' && card.explain !== 'skipped'"),
)
check('工具步骤的卡片是本机规则写的，不用提示词', !v040Host.includes('内容不外发，只有工具名和成败'))
check('parseCard 能认「1. 标题：…」这种写法', v040Host.includes('(?:\\d+[.、)]\\s*)?'))

// 20) 流式传输：生成中就把已经吐出来的字推给界面
const waits = []
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* (options) {
    llmCalls.push(options)
    yield { type: 'text-delta', text: '标题：正在读日志\n' }
    await new Promise((resolve, reject) => {
      waits.push(resolve)
      options.signal?.addEventListener?.('abort', () => reject(new Error('已取消')))
    })
    yield { type: 'text-delta', text: '在做什么：逐行看日志\n结果：找到线索\n' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const liveStream = openStream(`/process-lens/stream?session=${SESSION_ID}&turn=5`)
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 5, step: 1 })
await new Promise((resolve) => setTimeout(resolve, 100))
check(
  '生成中就把半截文字推给界面',
  liveStream.writes.some((chunk) => chunk.includes('标题：正在读日志')),
  liveStream.writes.length,
)
check(
  '半截文字走 draft 字段',
  liveStream.writes.some((chunk) => chunk.includes('"draft":"标题')),
  liveStream.writes.filter((chunk) => chunk.includes('draft')).length,
)

// 21) 优先：排在后面的那一步可以被提到最前面，还能抢占槽位
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 5, step: 2 })
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 5, step: 3 })
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 5, step: 4 })
await new Promise((resolve) => setTimeout(resolve, 80))
const byStep = (json, number) => (json?.data?.steps ?? []).find((item) => item.step === number) ?? {}
const queuedSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=5`)
check(
  '排队时能看到自己排第几',
  byStep(queuedSnap.json, 3).queuePos === 1 && byStep(queuedSnap.json, 4).queuePos === 2,
  [byStep(queuedSnap.json, 3).queuePos, byStep(queuedSnap.json, 4).queuePos],
)
check(
  '两个槽位占满时后来者的状态是排队中',
  byStep(queuedSnap.json, 3).explain === 'queued' && byStep(queuedSnap.json, 4).explain === 'queued',
  [byStep(queuedSnap.json, 3).explain, byStep(queuedSnap.json, 4).explain],
)
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 5, step: 4, priority: true })
await new Promise((resolve) => setTimeout(resolve, 180))
const prioritySnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=5`)
check(
  '点了优先就抢到槽位开始跑',
  byStep(prioritySnap.json, 4).explain === 'running',
  byStep(prioritySnap.json, 4).explain,
)
check(
  '被让位的那一步回到队列，不算失败',
  byStep(prioritySnap.json, 1).explain === 'queued' && byStep(prioritySnap.json, 1).explainError === null,
  [byStep(prioritySnap.json, 1).explain, byStep(prioritySnap.json, 1).explainError],
)

// 放开所有等待中的流，收尾：排队里的任务会陆续接上来，多放几轮
for (let round = 0; round < 8; round += 1) {
  while (waits.length) {
    const release = waits.shift()
    try {
      release()
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 70))
}
const settledSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=5`)
check(
  '放开后优先那一步先跑完',
  byStep(settledSnap.json, 4).explain === 'done',
  byStep(settledSnap.json, 4).explain,
)
check(
  '让位又重跑的那一步也没失败',
  byStep(settledSnap.json, 1).explain === 'done',
  byStep(settledSnap.json, 1).explain,
)
check(
  '流式结束后草稿清空',
  !byStep(settledSnap.json, 4).draft,
  byStep(settledSnap.json, 4).draft,
)
llmOverride = null
liveStream.close()

function cardOfDraftCheck(text) {
  // 卡片里的流式草稿用 pl-live；顺序反了就说明又撞回 .pl-draft 了
  const live = text.indexOf("className: 'pl-live'")
  const oldBlock = text.indexOf('.pl-draft {\n  margin-top')
  return live > 0 && oldBlock < 0
}

// 23) 存储：看得见占用，也能只清掉不要的那部分
const storeBase = await hit('/process-lens/api/storage')
check(
  '存储页能看到设置文件路径',
  typeof storeBase.json?.data?.file === 'string' && storeBase.json.data.file.includes('process-lens.json'),
  storeBase.json?.data?.file,
)
check(
  '存储页能算出内存里有多少步',
  Number(storeBase.json?.data?.memory?.steps) > 0,
  storeBase.json?.data?.memory,
)
await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '临时存档', text: '这是我的提示词' })
const withPrompt = await hit('/process-lens/api/storage')
check('提示词存档也算进占用', withPrompt.json?.data?.prompts?.length === 1, withPrompt.json?.data?.prompts)
await hit('/process-lens/api/storage', 'POST', { action: 'delete-prompt', id: withPrompt.json.data.prompts[0].id })
const afterPromptDelete = await hit('/process-lens/api/storage')
check('能单条删掉提示词存档', afterPromptDelete.json?.data?.prompts?.length === 0)
await hit('/process-lens/api/storage', 'POST', { action: 'clear-memory' })
const afterMemoryClear = await hit('/process-lens/api/storage')
check(
  '能一键清空内存缓存',
  Number(afterMemoryClear.json?.data?.memory?.sessions) === 0 && Number(afterMemoryClear.json?.data?.memory?.steps) === 0,
  afterMemoryClear.json?.data?.memory,
)
await hit('/process-lens/api/config', 'POST', { provider: 'somewhere', model: 'something' })
await hit('/process-lens/api/storage', 'POST', { action: 'reset-settings' })
const afterReset = await hit('/process-lens/api/config')
check(
  '恢复默认设置会退回默认值',
  afterReset.json?.settings?.provider === '' && afterReset.json?.settings?.model === '',
  afterReset.json?.settings?.provider,
)

// 22) 界面上确实有这两样东西
const streamClientSrc = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
check('卡片上有「优先」按钮', streamClientSrc.includes('排到队列最前面生成') && streamClientSrc.includes('onPriority'))
check('生成中有流式草稿块', streamClientSrc.includes('pl-live') && streamClientSrc.includes('card.draft'))
check(
  '流式草稿块没和设置页的表单撞名',
  cardOfDraftCheck(streamClientSrc),
)
check('排队时显示第几位', streamClientSrc.includes('排队中…（第'))
check(
  '设置页能展开存储明细',
  streamClientSrc.includes('查看占用') && streamClientSrc.includes("apiGet('/storage')"),
)
check(
  '设置行尾的推荐标签还在',
  (streamClientSrc.match(/h\(Rec, \{ text:/g) ?? []).length >= 9 &&
    streamClientSrc.includes('推荐开') &&
    streamClientSrc.includes('推荐关'),
  (streamClientSrc.match(/h\(Rec, \{ text:/g) ?? []).length,
)
check('推荐标签有样式', streamClientSrc.includes('.pl-rec {') && streamClientSrc.includes('.pl-rec.is-off'))
check(
  '清理按钮都在存储块里',
  streamClientSrc.includes("action: 'clear-memory'") &&
    streamClientSrc.includes("action: 'reset-settings'") &&
    streamClientSrc.includes("action: 'delete-prompt'"),
)

// 13b) 工具步骤不找模型：这一步只调了工具，本机写一句就够，一次调用都不花
await hit('/process-lens/api/config', 'POST', { compact: false, skipTools: true })
events.push({ type: 'turn/start', time: 5000, data: { turn: 6 } })
events.push({
  type: 'user/message',
  time: 5001,
  data: { role: 'user', content: [{ type: 'text', text: '把这份日志看一下' }] },
})
events.push({ type: 'step/start', time: 5010, data: { turn: 6, step: 1 } })
events.push({
  type: 'tool/call',
  time: 5011,
  data: { turn: 6, step: 1, callId: 'g1', name: 'read', arguments: JSON.stringify({ file_path: 'E:/logs/a.log' }) },
})
events.push({
  type: 'tool/result',
  time: 5012,
  data: { turn: 6, step: 1, message: { toolCallId: 'g1', content: [{ type: 'text', text: '日志很短。' }] } },
})
events.push({ type: 'step/end', time: 5013, data: { turn: 6, step: 1 } })
events.push({ type: 'turn/end', time: 5014, data: { turn: 6, reason: { kind: 'completed' } } })
const callsBeforeSkip = llmCalls.length
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 6 })
await new Promise((resolve) => setTimeout(resolve, 150))
const skipSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=6`)
const skipCard = (skipSnap.json?.data?.steps ?? []).find((item) => item.step === 1) ?? {}
check('工具步骤不找模型：状态记成「本机写的」', skipCard.explain === 'skipped', skipCard.explain)
check('工具步骤一次模型调用都不花', llmCalls.length === callsBeforeSkip, `${llmCalls.length} / ${callsBeforeSkip}`)
check('卡片直接写着调用了什么', String(skipCard.title ?? '').includes('调用了'), skipCard.title)
check(
  '卡片说得出在做什么',
  String(skipCard.doing ?? '').includes('读文件') && String(skipCard.doing ?? '').includes('a.log'),
  skipCard.doing,
)
check('卡片说得出成没成', String(skipCard.result ?? '').includes('成功'), skipCard.result)
check('卡片标了「本机」，界面认得出', skipCard.local === true, skipCard.local)
// 想看这一步照样能手点：手动点某一步不该被跳过
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* (options) {
    llmCalls.push(options)
    yield { type: 'text-delta', text: '标题：看了一眼日志\n在做什么：读了 a.log\n结果：内容很短\n' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const callsBeforeManual = llmCalls.length
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 6, step: 1 })
await new Promise((resolve) => setTimeout(resolve, 150))
const manualSnap = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=6`)
const manualCard = (manualSnap.json?.data?.steps ?? []).find((item) => item.step === 1) ?? {}
check(
  '手动点那一步还是让模型讲',
  llmCalls.length > callsBeforeManual && manualCard.explain === 'done',
  [llmCalls.length, manualCard.explain],
)
check('讲完就不再挂「本机」小签', manualCard.local !== true, manualCard.local)
llmOverride = null

// 24) 每 N 步只发一次请求：选 5 = 第 1~5 步合一次、第 6~10 步合一次，不是每步都发
await hit('/process-lens/api/config', 'POST', {
  skipTools: false,
  compact: false,
  batchEvery: 5,
  batchBackground: true,
})
const BT = 7
const bPrompts = []
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* (options) {
    llmCalls.push(options)
    const prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
    bPrompts.push(prompt)
    yield { type: 'text-delta', text: '标题：改了几行代码\n在做什么：看了两处、改了一处\n结果：跑通了\n' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
pushEvent({ type: 'turn/start', time: 7000, data: { turn: BT } })
pushEvent({
  type: 'user/message',
  time: 7001,
  data: { role: 'user', content: [{ type: 'text', text: '把这七步都过一遍' }] },
})
for (let index = 1; index <= 7; index += 1) {
  pushEvent({ type: 'step/start', time: 7010 + index * 10, data: { turn: BT, step: index } })
  pushEvent({
    type: 'assistant/message',
    time: 7011 + index * 10,
    data: {
      turn: BT,
      step: index,
      message: { id: 'MSG-B' + index, content: [{ type: 'text', text: '第 ' + index + ' 步的结论' }] },
      stream: [],
    },
  })
  pushEvent({ type: 'step/end', time: 7019 + index * 10, data: { turn: BT, step: index } })
}
pushEvent({ type: 'turn/end', time: 7200, data: { turn: BT, reason: { kind: 'completed' } } })
for (let round = 0; round < 8; round += 1) {
  await new Promise((resolve) => setTimeout(resolve, 70))
}
const bSnap24 = await hit('/process-lens/api/snapshot?session=' + SESSION_ID + '&turn=' + BT)
check(
  '七步只发两次请求（5 步一次 + 剩下的一起收尾）',
  bPrompts.length === 2,
  { calls: bPrompts.length, chars: bPrompts.map((text) => text.length) },
)
check(
  '第一批只说第 1~5 步',
  String(bPrompts[0] ?? '').includes('第 1~5 步') && !String(bPrompts[0] ?? '').includes('- 第6步'),
  String(bPrompts[0] ?? '').slice(0, 120),
)
check(
  '第一批把这 5 步都写进去了',
  ['- 第1步', '- 第2步', '- 第3步', '- 第4步', '- 第5步'].every((mark) =>
    String(bPrompts[0] ?? '').includes(mark),
  ),
  String(bPrompts[0] ?? '').slice(0, 200),
)
check(
  '收尾那批只说第 6~7 步',
  String(bPrompts[1] ?? '').includes('第 6~7 步') && !String(bPrompts[1] ?? '').includes('- 第5步'),
  String(bPrompts[1] ?? '').slice(0, 120),
)
check(
  '没并进总结的前几步看得懂去哪了',
  byStep(bSnap24.json, 1).explain === 'batched' && byStep(bSnap24.json, 1).batchTo === 5,
  [byStep(bSnap24.json, 1).explain, byStep(bSnap24.json, 1).batchTo],
)
check(
  '并进去的那几步能看到那份总结叫什么',
  String(byStep(bSnap24.json, 1).batchGist ?? '').length > 0 &&
    byStep(bSnap24.json, 1).batchGist === byStep(bSnap24.json, 5).title,
  [byStep(bSnap24.json, 1).batchGist, byStep(bSnap24.json, 5).title],
)
check(
  '总结卡标着「第 1~5 步合并讲的」',
  Array.isArray(byStep(bSnap24.json, 5).batchRange) &&
    byStep(bSnap24.json, 5).batchRange[0] === 1 &&
    byStep(bSnap24.json, 5).batchRange[1] === 5,
  byStep(bSnap24.json, 5).batchRange,
)
llmOverride = null
await hit('/process-lens/api/config', 'POST', { batchEvery: 0, skipTools: false })

const lensIndexSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
check(
  '批次正文只遍历自己那 N 步，不再取「最近 N 步」',
  lensIndexSrc.includes('function buildBatchBody(record, from, to)') &&
    !lensIndexSrc.includes('const body = buildPromptCompact(record, entry)'),
)
check(
  '默认就是每 5 步合并一次',
  lensIndexSrc.includes('batchEvery: 5,') && streamClientSrc.includes('batchEvery: 5,'),
)
check(
  '界面上把两件事分开了',
  streamClientSrc.includes('每 N 步合并讲一次') &&
    streamClientSrc.includes('不会每步都发') &&
    streamClientSrc.includes('精炼提示词') &&
    streamClientSrc.includes('调用次数不变'),
)

// 25) 自动讲的总闸：三个开关都关就一步都不发；关掉设置立刻撤掉排队任务
const gatePrompts = []
const gateWaits = []
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* (options) {
    llmCalls.push(options)
    gatePrompts.push(options.messages?.[0]?.content?.[0]?.text ?? '')
    yield { type: 'text-delta', text: '标题：这几步一起看\n在做什么：把步骤过一遍\n结果：没发现问题\n' }
    await new Promise((resolve, reject) => {
      gateWaits.push(resolve)
      options.signal?.addEventListener?.('abort', () => reject(new Error('已取消')))
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const gateStream = openStream('/process-lens/stream?session=' + SESSION_ID + '&turn=8')
const pushPlainTurn = (turn, count) => {
  pushEvent({ type: 'turn/start', time: 8000 + turn * 100, data: { turn } })
  pushEvent({
    type: 'user/message',
    time: 8001 + turn * 100,
    data: { role: 'user', content: [{ type: 'text', text: '把第 ' + turn + ' 轮过一遍' }] },
  })
  for (let index = 1; index <= count; index += 1) {
    pushEvent({ type: 'step/start', time: 8010 + turn * 100 + index * 10, data: { turn, step: index } })
    pushEvent({
      type: 'assistant/message',
      time: 8011 + turn * 100 + index * 10,
      data: {
        turn,
        step: index,
        message: { id: 'MSG-G' + turn + '-' + index, content: [{ type: 'text', text: '第 ' + index + ' 步结论' }] },
        stream: [],
      },
    })
    pushEvent({ type: 'step/end', time: 8019 + turn * 100 + index * 10, data: { turn, step: index } })
  }
  pushEvent({ type: 'turn/end', time: 8099 + turn * 100, data: { turn, reason: { kind: 'completed' } } })
}
const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 70))
}

// 25a) 三个自动开关全关：面板开着也不发请求
await hit('/process-lens/api/config', 'POST', {
  batchEvery: 2,
  liveExplain: false,
  autoSummarize: false,
  batchBackground: false,
  skipTools: false,
  compact: false,
})
const gateBeforeA = gatePrompts.length
pushPlainTurn(8, 3)
await settle()
const gateSnap8 = await hit('/process-lens/api/snapshot?session=' + SESSION_ID + '&turn=8')
check('三个自动开关都关：一步都不发请求', gatePrompts.length === gateBeforeA, { added: gatePrompts.length - gateBeforeA })
check(
  '没生成就老实停在「待生成」',
  byStep(gateSnap8.json, 1).explain === 'idle' && byStep(gateSnap8.json, 3).explain === 'idle',
  [byStep(gateSnap8.json, 1).explain, byStep(gateSnap8.json, 3).explain],
)

// 25b) 只打开「开着时逐步生成」→ 每 2 步合并的那次请求立刻开跑
await hit('/process-lens/api/config', 'POST', { liveExplain: true })
const gateBeforeB = gatePrompts.length
pushPlainTurn(9, 2)
await settle(3)
const liveLatest = await hit('/process-lens/api/latest?session=' + SESSION_ID)
check(
  '打开「开着时逐步生成」才发请求（每 2 步一次）',
  gatePrompts.length === gateBeforeB + 1,
  gatePrompts.length - gateBeforeB,
)
check('/latest 报出「正在写」的步数', Number(liveLatest.json.working) >= 1, liveLatest.json.working)

// 25c) 槽位占满时新批次排队；一取消勾选立刻撤掉
pushPlainTurn(10, 2)
await settle(3)
pushPlainTurn(11, 2)
await settle(3)
const beforeOff = await hit('/process-lens/api/latest?session=' + SESSION_ID)
check('槽位占满时新批次在排队', Number(beforeOff.json.pending) >= 1, beforeOff.json.pending)
await hit('/process-lens/api/config', 'POST', { liveExplain: false, autoSummarize: false })
const afterOff = await hit('/process-lens/api/latest?session=' + SESSION_ID)
check('一取消勾选，排队的自动任务立刻撤掉', Number(afterOff.json.pending) === 0, afterOff.json.pending)
await settle(2)
const stoppedLatest = await hit('/process-lens/api/latest?session=' + SESSION_ID)
check('正在写的那两个也立刻停手', Number(stoppedLatest.json.working) === 0, stoppedLatest.json.working)
const snap9 = await hit('/process-lens/api/snapshot?session=' + SESSION_ID + '&turn=9')
check(
  '被打断的不算失败，卡片退回待生成',
  byStep(snap9.json, 1).explain === 'idle' && byStep(snap9.json, 1).explainError === null,
  [byStep(snap9.json, 1).explain, byStep(snap9.json, 1).explainError],
)
const gateSnap11 = await hit('/process-lens/api/snapshot?session=' + SESSION_ID + '&turn=11')
check(
  '被撤掉的那几步回到「待生成」，不算失败',
  byStep(gateSnap11.json, 1).explain === 'idle' && byStep(gateSnap11.json, 1).explainError === null,
  [byStep(gateSnap11.json, 1).explain, byStep(gateSnap11.json, 1).explainError],
)

for (let round = 0; round < 8; round += 1) {
  while (gateWaits.length) {
    const release = gateWaits.shift()
    try {
      release()
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 70))
}
gateStream.close()
llmOverride = null
await hit('/process-lens/api/config', 'POST', {
  batchEvery: 0,
  liveExplain: false,
  autoSummarize: false,
  batchBackground: false,
  skipTools: false,
})

const lensSrcGate = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
check(
  'Host：关设置立刻撤掉排队任务',
  lensSrcGate.includes('function dropAutoJobs') &&
    lensSrcGate.includes("dropAutoJobs('设置已关')") &&
    lensSrcGate.includes("dropAutoJobs('面板已关')"),
  'dropAutoJobs 两个入口',
)
check(
  '界面：输入框那条会显示「生成中」',
  streamClientSrc.includes("'生成中'") &&
    streamClientSrc.includes('setInterval(tick, 2000)') &&
    streamClientSrc.includes('pl-dock-dot'),
  '生成中 + 2 秒轮询',
)

// 26) 全量功能验收：设置项逐个往返（含越界夹取与非法值忽略）
const configCases = [
  [{ mode: 'onDemand' }, (s) => s.mode === 'onDemand', '讲解模式：按需'],
  [{ mode: '乱传' }, (s) => s.mode === 'onDemand', '讲解模式：非法值忽略'],
  [{ autoOpen: true }, (s) => s.autoOpen === true, '自动弹出：开'],
  [{ autoOpen: false }, (s) => s.autoOpen === false, '自动弹出：关'],
  [{ batchEvery: 999 }, (s) => s.batchEvery === 50, '合并步数：上限 50'],
  [{ batchEvery: -3 }, (s) => s.batchEvery === 0, '合并步数：负数夹到 0'],
  [{ batchEvery: 5 }, (s) => s.batchEvery === 5, '合并步数：存得住'],
  [{ maxTokens: 99999 }, (s) => s.maxTokens === 4000, '输出上限：夹到 4000'],
  [{ maxTokens: 10 }, (s) => s.maxTokens === 400, '输出上限：下限 400'],
  [{ style: 'pro' }, (s) => s.style === 'pro', '总结风格：存得住'],
  [{ style: 'nope' }, (s) => s.style === 'pro', '总结风格：非法值忽略'],
  [{ theme: 'dark' }, (s) => s.theme === 'dark', '外观：存得住'],
  [{ theme: 'rainbow' }, (s) => s.theme === 'dark', '外观：非法值忽略'],
  [{ thinking: true }, (s) => s.thinking === true, '模型思考：开'],
  [{ allSteps: false }, (s) => s.allSteps === false, '全部步骤：关'],
  [{ skipTools: false }, (s) => s.skipTools === false, '工具步骤找模型：开'],
  [{ batchBackground: true }, (s) => s.batchBackground === true, '后台跑：开'],
  [{ activePrompt: '根本没这个' }, (s) => s.activePrompt === '', '不存在的提示词不会被选中'],
]
for (const [body, pick, name] of configCases) {
  const result = await hit('/process-lens/api/config', 'POST', body)
  check(`设置项：${name}`, pick(result.json?.settings ?? {}), result.json?.settings)
}
await hit('/process-lens/api/config', 'POST', { compact: true, compactCount: 0 })
const compactLow = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('精炼行数：下限 1', compactLow.json?.compactCount === 1, compactLow.json?.compactCount)
await hit('/process-lens/api/config', 'POST', { compactCount: 99 })
const compactHigh = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('精炼行数：上限 50', compactHigh.json?.compactCount === 50, compactHigh.json?.compactCount)
await hit('/process-lens/api/config', 'POST', {
  thinking: false,
  allSteps: true,
  skipTools: true,
  batchBackground: false,
  style: 'gentle',
  theme: 'auto',
  maxTokens: 1600,
  batchEvery: 0,
})

// 27) 提示词工作台：预览、新建、改名、切回、删掉
const promptBase = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('提示词预览：算得出这次发多少字', typeof promptBase.json?.chars === 'number' && promptBase.json.chars > 100, promptBase.json?.chars)
check(
  '提示词预览：给出「不省 token 时」的字数对照',
  typeof promptBase.json?.fullChars === 'number' && promptBase.json.fullChars >= promptBase.json.chars - 1,
  [promptBase.json?.chars, promptBase.json?.fullChars],
)
check('提示词预览：三行格式写在正文里', String(promptBase.json?.user ?? '').includes('第 1 步') || String(promptBase.json?.user ?? '').includes('三行'), String(promptBase.json?.user ?? '').slice(0, 60))
const builtPrompt = await hit('/process-lens/api/prompts', 'POST', {
  action: 'save',
  name: '三行测试',
  text: '第一行说重点\n第二行说做法\n第三行说结果',
})
const savedPromptId = String(builtPrompt.json?.settings?.prompts?.at(-1)?.id ?? '')
check('提示词存档：能新建', Boolean(savedPromptId), builtPrompt.json?.prompts)
check('提示词存档：新建后自动选中', builtPrompt.json?.settings?.activePrompt === savedPromptId, builtPrompt.json?.settings?.activePrompt)
const promptApplied = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
check('提示词存档：选中后真的用上', String(promptApplied.json?.system ?? '').includes('第一行说重点'), String(promptApplied.json?.system ?? '').slice(0, 60))
const renamedPrompt = await hit('/process-lens/api/prompts', 'POST', {
  action: 'save',
  id: savedPromptId,
  name: '改过名',
  text: '第一行说重点\n第二行说做法\n第三行说结果（改）',
})
check(
  '提示词存档：能改名改正文',
  renamedPrompt.json?.prompts?.some((item) => item.id === savedPromptId && item.name === '改过名'),
  renamedPrompt.json?.prompts,
)
const emptyPrompt = await hit('/process-lens/api/prompts', 'POST', { action: 'save', name: '空的', text: '   ' })
check('提示词存档：空的存不进去', emptyPrompt.status === 400 && String(emptyPrompt.json?.error ?? '').includes('不能是空'), emptyPrompt.json)
const selectPrompt = await hit('/process-lens/api/prompts', 'POST', { action: 'select', id: savedPromptId })
check('提示词存档：能切回去', selectPrompt.json?.settings?.activePrompt === savedPromptId, selectPrompt.json?.settings?.activePrompt)
const selectMissing = await hit('/process-lens/api/prompts', 'POST', { action: 'select', id: 'p不存在' })
check('提示词存档：选了不存在的就退回内置', selectMissing.json?.settings?.activePrompt === '', selectMissing.json?.settings?.activePrompt)
const deletePrompt = await hit('/process-lens/api/prompts', 'POST', { action: 'delete', id: savedPromptId })
check('提示词存档：能删掉', deletePrompt.json?.prompts?.every((item) => item.id !== savedPromptId), deletePrompt.json?.prompts)
const badAction = await hit('/process-lens/api/prompts', 'POST', { action: '不存在' })
check('提示词存档：乱操作被拒', badAction.status === 400, badAction.json)

// 28) 边界与失败：不存在的会话、报错的模型、重试
const emptySnap = await hit('/process-lens/api/snapshot?session=没有这个会话&turn=1')
check('不存在的会话给空快照，不报错', Array.isArray(emptySnap.json?.data?.steps) && emptySnap.json.data.steps.length === 0, emptySnap.json?.data)
const unknownMessage = await hit(`/process-lens/api/turn?session=${SESSION_ID}&messageId=MSG-不存在`)
check('不认识的 messageId 不炸，退回最新一轮', typeof unknownMessage.json?.turn === 'number', unknownMessage.json)
pushPlainTurn(12, 1)
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* () {
    throw new Error('模型炸了')
  },
}
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 12, step: 1 })
await settle(3)
const failedCard = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=12`)
check(
  '模型报错：卡片标失败并写出原因',
  byStep(failedCard.json, 1).explain === 'failed' && String(byStep(failedCard.json, 1).explainError ?? '').includes('模型炸了'),
  [byStep(failedCard.json, 1).explain, byStep(failedCard.json, 1).explainError],
)
llmOverride = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ provider: 'deepseek', id: 'chat', name: 'DeepSeek Chat' }],
  resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: '低' }] } }),
  stream: async function* (options) {
    llmCalls.push(options)
    yield { type: 'text-delta', text: '标题：重试成功\n在做什么：又讲了一遍\n结果：这次通了\n' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 12, step: 1 })
await settle(3)
const retriedCard = await hit(`/process-lens/api/snapshot?session=${SESSION_ID}&turn=12`)
check(
  '失败后再点一次能重试成功',
  byStep(retriedCard.json, 1).explain === 'done' && String(byStep(retriedCard.json, 1).title ?? '').includes('重试成功'),
  [byStep(retriedCard.json, 1).explain, byStep(retriedCard.json, 1).title],
)
const callsBeforeIdle = llmCalls.length
await hit('/process-lens/api/explain', 'POST', { session: SESSION_ID, turn: 12 })
await settle(2)
check('整轮「全部生成」不会重讲已经讲好的', llmCalls.length === callsBeforeIdle, llmCalls.length - callsBeforeIdle)

// 29) 事件流：连上先给快照，一轮结束推 turn
const eventStream = openStream(`/process-lens/stream?session=${SESSION_ID}&turn=13`)
check('连上就先推一份快照（snap）', eventStream.writes.some((chunk) => chunk.includes('event: snap')), eventStream.writes.length)
pushPlainTurn(13, 1)
await settle(2)
check('一轮结束会推 turn 事件', eventStream.writes.some((chunk) => chunk.includes('event: turn')), eventStream.writes.length)
eventStream.close()
llmOverride = null

// 30) 界面上这些入口和文案都得在
const uiWords = [
  '打开时自动生成',
  '开着时逐步生成',
  '后台跑',
  '每 N 步合并讲一次',
  '精炼提示词',
  '工具步骤不找模型',
  '总结风格',
  '打开时显示',
]
const missingWords = uiWords.filter((word) => !streamClientSrc.includes(word))
check('设置页每个开关都在', missingWords.length === 0, missingWords)
check(
  '三个入口都在（回答下 / 输入框下 / 浮层）',
  streamClientSrc.includes('conversation.chat.assistant-actions') &&
    streamClientSrc.includes('conversation.composer.dock') &&
    streamClientSrc.includes('shell.overlay'),
  'slots',
)
check('面板里有「过程 / 设置」两页', streamClientSrc.includes('过程') && streamClientSrc.includes('设置'))
check('面板顶部能自己挑讲解模型', streamClientSrc.includes('/models') && streamClientSrc.includes('讲解模型'))
check(
  '输入框那条三种状态文案都在',
  streamClientSrc.includes('生成中') && streamClientSrc.includes('排队') && streamClientSrc.includes('过程'),
)
check('卡片上有「优先 / 重新生成」', streamClientSrc.includes('优先') && streamClientSrc.includes('重新生成'))
check('卡片会说明「已并进第 N 步」', streamClientSrc.includes('已并进第'))

// 31) 发行清单：exports / files / 语言包 / 图
const readText = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/^\uFEFF/, '')
const pkg = JSON.parse(readText('./package.json'))
const exportTargets = Object.values(pkg.exports ?? {}).filter((item) => typeof item === 'string' && !item.includes('*'))
const missingExports = exportTargets.filter((rel) => {
  try {
    readFileSync(new URL(rel, import.meta.url))
    return false
  } catch {
    return true
  }
})
check('包清单：exports 指的都是真文件', missingExports.length === 0, missingExports)
check(
  '包清单：files 覆盖运行文件与文档',
  ['index.js', 'client.js', 'cordis.patch.yml', 'locale', 'docs', 'icon.svg', 'README.md', 'LICENSE'].every((word) =>
    (pkg.files ?? []).some((item) => String(item).startsWith(word)),
  ),
  pkg.files,
)
const zhLocale = JSON.parse(readText('./locale/zh.json'))
const enLocale = JSON.parse(readText('./locale/en.json'))
check(
  '语言包：中英文都能解析且带标题说明',
  Boolean(zhLocale.meta?.title && zhLocale.meta?.description && enLocale.meta?.title && enLocale.meta?.description),
)
check(
  '详情页与功能图都在',
  readFileSync(new URL('./docs/DETAIL.zh.md', import.meta.url), 'utf8').includes('preview.svg') &&
    readFileSync(new URL('./docs/preview.svg', import.meta.url), 'utf8').includes('<svg'),
)
check('插件图标是合法 svg', readFileSync(new URL('./icon.svg', import.meta.url), 'utf8').includes('<svg'))

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exitCode = 1
try {
  rmSync(process.env.DSH_PROFILE_DIR, { recursive: true, force: true })
} catch {}
