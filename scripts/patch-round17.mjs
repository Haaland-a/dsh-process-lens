/** 补丁 17：README 增加 风格 / 提示词存档 / 省 token 三节，并更新自测与实现要点。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'README.md'
let text = readFileSync(file, 'utf8')
const missed = []

function rep(name, from, to) {
  if (text.includes(to.slice(0, 40).replace(/\n/g, ' '))) {
    console.log(`skip ${name}`)
    return
  }
  if (!text.includes(from)) {
    missed.push(name)
    console.log(`MISS ${name}`)
    return
  }
  text = text.replace(from, to)
  console.log(`ok   ${name}`)
}

// 1) 新增第 5 节
const anchor5 = `### 4. 面板尺寸

右下角浮动，**620 宽 × 面板高度的 74%（上限 780px）**，避开窗口右上角的 − □ ×；正文 13px，原文块可以滚动，长内容不再挤成一条。`
rep(
  '新增第五节',
  anchor5,
  `${anchor5}

### 5. 讲解风格 / 自己的提示词 / 省 token

这三样都在面板设置区的「讲解口味」里：

**总结风格**：四档预设，只换说法不换格式（永远是「标题 / 在做什么 / 结果」三行）：

| 档位 | 讲出来是什么味 |
| --- | --- |
| 通俗（默认） | 像同事给你顺一遍：它想干嘛、动了哪里、成没成 |
| 专业 | 面向技术负责人，点出机制和判断依据 |
| 一句话 | 只给结论，一行说完 |
| 给新手 | 解释每个名词，假设你不熟这套工具 |

**自己的提示词**：

- 「看当前提示词」→ 预览**真正发出去的两段文本**（系统提示 + 这一步的实际内容）和字数；
- 「新建存档」→ 写要求、起个名字（比如「给老板看」「只要结论」），存成存档；名字随便起，改删都行；
- 存档会出现在风格下拉的「我的存档」里，随时切回内置档；
- 存自己的提示词也不会破格式——插件会把三行格式要求追加在末尾。

**省 token 模式**：

- 打开后只把**最近 N 步压成要点**再发给模型（N 默认 5，可 1–50，旁边有 5 / 10 快捷按钮）；
- 提示里会明写「省 token 模式：信息已压缩」，模型知道自己在看摘要，不会瞎编细节；
- 关掉就是原来的完整内容。长会话想省钱就开它。`,
)

// 2) 问题表补三行
rep(
  '问题表补三行',
  `| 讲解很慢 | DeepSeek 思考档位高，插件已自动降到最低档；换更小的模型更快 |`,
  `| 讲解很慢 | DeepSeek 思考档位高，插件已自动降到最低档；换更小的模型更快 |
| 风格改了但没变 | 卡片是之前讲好的，点「再讲一次」才会用新风格重讲 |
| 提示词预览是空的 | 这个会话还没有步骤记录，预览给的是样例文本（会标「样例」） |
| 开了省 token 细节变少 | 正常，它就是拿细节换额度；关掉即恢复 |`,
)

// 3) 实现要点补三条
rep(
  '实现要点补三条',
  `- **鉴权**：路由统一过 \`ctx.get('connection').requestRejection(req)\`。`,
  `- **风格 / 提示词**：风格决定了 system prompt 的人设段（\`STYLE_PRESETS\`），
  内置格式要求单独放 \`OUTPUT_RULES\`，无论选哪档、用谁的自定义提示词，
  最后都会把这一段拼上去，所以三行格式不会被玩坏。
  自定义存档存进 settings.prompts（id 用 \`p + base36 时间\`，name ≤ 40 字，text ≤ 4000 字），
  \`activePrompt\` 指向哪条就用哪条；删掉当前项会自动回到内置风格。
- **预览**：\`GET /process-lens/api/prompt?session=\` 直接用 \`buildPrompt()\` 生成真实内容，
  不是拼一份假的给你看；会话还没步骤时给样例并标 \`sample: true\`。
- **省 token**：\`buildPrompt()\` 里 \`compact === true\` 走压缩分支——
  诉求截 120 字、每步压成一句 \`briefOfStep\`、思考 240 / 回答 200 / 工具 detail 80 / result 100 且最多 6 个，
  末尾补一句「看清楚的就讲，看不清的别猜」。
- **鉴权**：路由统一过 \`ctx.get('connection').requestRejection(req)\`。`,
)

// 4) 自测段更新
rep(
  '自测段更新',
  `用假 ctx 跑 30 条断言：历史补账、messageId→轮次定位、工具人话标签、原文（含参数/返回）随卡返回、失败标红、
「只连流不点 = 0 次模型调用」、显式点讲才 1 次且用插件自己选的模型、讲失败会标 \`failed\` 并推流、
「全部讲一遍」跳过讲过的、\`recent\` 默认值与上下限、\`autoSummarize\` 开关与 1–20 上限。不联网、不花额度。`,
  `用假 ctx 跑 **43 条**断言：历史补账、messageId→轮次定位、工具人话标签、原文（含参数/返回）随卡返回、失败标红、
「只连流不点 = 0 次模型调用」、显式点讲才 1 次且用插件自己选的模型、讲失败会标 \`failed\` 并推流、
「全部讲一遍」跳过讲过的、\`recent\` 默认值与上下限、\`autoSummarize\` 开关与 1–20 上限、
四种讲解风格、系统提示里确实带三行格式要求、预览里是这一步的真实内容、
省 token 模式带「最近 N 条概要」且没丢用户诉求、自定义提示词的存 / 切 / 删。不联网、不花额度。`,
)

writeFileSync(file, text)
console.log(`\nREADME: ${missed.length} missed${missed.length ? ' -> ' + missed.join(', ') : ''}`)
if (missed.length) process.exitCode = 2
