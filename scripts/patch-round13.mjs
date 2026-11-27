/** 补丁 13：补说明三条 + 修正 styles 取值来源。 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'client.js'
let text = readFileSync(file, 'utf8')
const missed = []

// 1) 说明三条
const anchor = `              h('p', null, '· 自动弹出：出现新一轮就把面板摊出来（只显示原文）；关着就等你点「看过程」。'),`
const extra = `${anchor}
              h('p', null, '· 总结风格：决定讲解员怎么说话——通俗、专业、一句话、给新手；只换说法，不换三行格式。'),
              h('p', null, '· 提示词：「看当前提示词」能看到真正发出去的两段文本；「新建存档」可以写自己的要求并起名，之后在风格下拉里随时切回。'),
              h('p', null, '· 省 token：开了以后只把最近 N 条压成概要再发给模型，额度省很多，代价是细节没那么全。'),`
if (text.includes('· 总结风格：决定讲解员怎么说话')) {
  console.log('skip 说明三条')
} else if (!text.includes(anchor)) {
  missed.push('说明三条')
  console.log('MISS 说明三条')
} else {
  text = text.replace(anchor, extra)
  console.log('ok   说明三条')
}

// 2) styles 从 config 里取（publicSettings 会把它塞进 settings）
const from = `      const styles = lens.styles?.length
        ? lens.styles`
const to = `      const styles = lens.config.styles?.length
        ? lens.config.styles`
if (text.includes(to)) {
  console.log('skip styles 取值')
} else if (!text.includes(from)) {
  missed.push('styles 取值')
  console.log('MISS styles 取值')
} else {
  text = text.replace(from, to)
  console.log('ok   styles 取值')
}

writeFileSync(file, text)
if (missed.length) process.exitCode = 2
