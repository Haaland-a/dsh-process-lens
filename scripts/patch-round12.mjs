/** 补丁 12（Client 半）：风格下拉 / 提示词工作台 / 预览 / 省 token 开关。 */
import { readFileSync, writeFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')
const file = 'client.js'
let text = read(file)
let applied = 0
const missed = []

function once(name, from, to) {
  if (text.includes(to.slice(0, 48))) {
    console.log(`skip ${name}`)
    return
  }
  if (!text.includes(from)) {
    missed.push(name)
    console.log(`MISS ${name}`)
    return
  }
  text = text.replace(from, to)
  applied += 1
  console.log(`ok   ${name}`)
}

// 1) 状态默认值
once(
  'state.config 增加字段',
  `      config: { provider: '', model: '', mode: 'onDemand', autoOpen: false, recent: 8, autoSummarize: false, autoSummarizeCount: 3 },`,
  `      config: {
        provider: '',
        model: '',
        mode: 'onDemand',
        autoOpen: false,
        recent: 8,
        autoSummarize: false,
        autoSummarizeCount: 3,
        style: 'plain',
        activePrompt: '',
        prompts: [],
        styles: [],
        compact: false,
        compactCount: 5,
      },`,
)

// 2) 插入 PromptStudio 组件
once(
  '插入 PromptStudio 组件',
  `    // ── 设置区：模型 / 模式 / 自动弹出 ────────────────────────────────────────`,
  `${read('scripts/snips/client-studio.txt').trimEnd()}
    // ── 设置区：模型 / 模式 / 自动弹出 ────────────────────────────────────────`,
)

// 3) 在设置区渲染 PromptStudio
once(
  '设置区渲染 PromptStudio',
  `        h(
          'button',
          {
            type: 'button',
            className: 'pl-more',`,
  `        h(PromptStudio, { lens }),
        h(
          'button',
          {
            type: 'button',
            className: 'pl-more',`,
)

// 4) 说明补三条
once(
  '说明补三条',
  `              h('p', null, '· 自动弹出：出现新一轮就把面板摊出来（只显示原文）；关着就等你点「看过程」。'),`,
  `              h('p', null, '· 自动弹出：出现新一轮就把面板摊出来（只显示原文）；关着就等你点「看过程」。'),
              h('p', null, '· 总结风格：决定讲解员怎么说话——通俗、专业、一句话、给新手；只换说法，不换格式。'),
              h('p', null, '· 提示词：「看当前提示词」能看到真正发出去的两段文本；「新建存档」可以写自己的要求并起名，之后在风格下拉里随时切回。'),
              h('p', null, '· 省 token：开了以后只把最近 N 条压成概要再发给模型，额度省很多，代价是细节没那么全。'),`,
)

// 5) CSS
once(
  '样式追加',
  `.pl-hint { font-size: 11.5px; opacity: .72;`,
  `${read('scripts/snips/client-studio.css').trimEnd()}
.pl-hint { font-size: 11.5px; opacity: .72;`,
)

writeFileSync(file, text)
console.log(`\nclient.js: ${applied} applied, ${missed.length} missed${missed.length ? ` -> ${missed.join(', ')}` : ''}`)
if (missed.length) process.exitCode = 2
