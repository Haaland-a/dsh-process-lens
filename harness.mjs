/**
 * 一次性自测：用假 ctx 验收「历史补账」逻辑，不碰真实模型。
 * 跑法：node harness.mjs
 */
import { readFileSync, rmSync } from 'node:fs'
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

// 13b) 工具内容不外发：只发工具名和成败，不发参数与返回
await hit('/process-lens/api/config', 'POST', { compact: false, hideTools: true })
const hiddenFull = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
const hiddenFullUser = String(hiddenFull.json?.user ?? '')
check('开了以后不带工具返回原文', !hiddenFullUser.includes('日志内容很多行'), hiddenFullUser.includes('日志内容很多行') ? '仍然带着原文' : 'ok')
check('开了以后不带工具参数', !hiddenFullUser.includes('same.log'), hiddenFullUser.includes('same.log') ? '仍然带着参数' : 'ok')
check('只留工具名和成败', hiddenFullUser.includes('读文件 → 成功'), hiddenFullUser.split('\n').find((line) => line.includes('读文件')) ?? 'no line')
check('会明说内容没发、不许猜', hiddenFullUser.includes('不得猜测'), hiddenFullUser.slice(-60))
await hit('/process-lens/api/config', 'POST', { compact: true, hideTools: true })
const hiddenSmall = await hit(`/process-lens/api/prompt?session=${SESSION_ID}`)
const hiddenSmallUser = String(hiddenSmall.json?.user ?? '')
check('精炼版也一样不外发', !hiddenSmallUser.includes('日志内容很多行') && !hiddenSmallUser.includes('same.log'), hiddenSmallUser.slice(0, 60))
check('精炼版也只留工具名和成败', hiddenSmallUser.includes('读文件 → 成功'), hiddenSmallUser.split('\n').find((line) => line.includes('读文件')) ?? 'no line')
await hit('/process-lens/api/config', 'POST', { hideTools: false })

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
  hostSrc.includes('batchEvery: 0,') &&
    hostSrc.includes('function maybeBatch') &&
    hostSrc.includes('record.batchedTo = target.step') &&
    hostSrc.includes("entry.explain = 'batched'") &&
    hostSrc.includes('kind: \'batch\''),
  'maybeBatch + 合并标记',
)
check(
  'Host：后台跑关着时没人看就不开工',
  hostSrc.includes('settings.batchBackground !== true && viewers === 0') &&
    hostSrc.includes('viewers += 1') &&
    hostSrc.includes('viewers = Math.max(0, viewers - 1)'),
  'viewers 计数 + 闸门',
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
  batchPrompt.includes('省 token++') && batchPrompt.includes('第 1~3 步'),
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
check('parseCard 能认「1. 标题：…」这种写法', v040Host.includes('(?:\\d+[.、)]\\s*)?'))

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) process.exitCode = 1
try {
  rmSync(process.env.DSH_PROFILE_DIR, { recursive: true, force: true })
} catch {}
