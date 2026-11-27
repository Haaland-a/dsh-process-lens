/**
 * 补丁 5：打开面板时自动讲最近 N 步（autoSummarize）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'client.js'
let text = readFileSync(file, 'utf8')

const refAnchor = `      const bodyRef = useRef(null)
      const pinnedRef = useRef(true)`
const refNext = `      const bodyRef = useRef(null)
      const pinnedRef = useRef(true)
      /** 同一轮只自动讲一次，避免快照每刷新一遍就再烧一次额度 */
      const autoDoneRef = useRef('')`

const effectAnchor = `      const onScroll = () => {`
const effectNext = `      // 「打开时自动讲最近 N 步」：只有用户真的打开面板才触发，同一轮只触发一次
      useEffect(() => {
        if (!lens.open || !lens.sessionId || lens.turn === null || lens.turn === undefined) return
        if (lens.config.autoSummarize !== true) return
        const snapshot = lens.snapshotKey === \`\${lens.sessionId}:\${lens.turn}\` ? lens.snapshot : null
        const cards = snapshot?.steps ?? []
        if (cards.length === 0) return
        const key = \`\${lens.sessionId}:\${lens.turn}\`
        if (autoDoneRef.current === key) return
        const count = Math.min(20, Math.max(1, Math.round(Number(lens.config.autoSummarizeCount) || 3)))
        const targets = cards
          .filter((card) => card.explain !== 'done' && card.explain !== 'queued' && card.explain !== 'running')
          .slice(-count)
          .map((card) => card.step)
        if (targets.length === 0) return
        autoDoneRef.current = key
        void explainSteps(lens.sessionId, lens.turn, targets)
      }, [lens.open, lens.sessionId, lens.turn, lens.snapshot, lens.snapshotKey, lens.config.autoSummarize, lens.config.autoSummarizeCount])

      const onScroll = () => {`

if (!text.includes(refNext)) {
  if (!text.includes(refAnchor)) throw new Error('ref anchor missing')
  text = text.replace(refAnchor, refNext)
  console.log('ok  autoDoneRef')
} else console.log('skip autoDoneRef')

if (!text.includes('autoDoneRef.current === key')) {
  if (!text.includes(effectAnchor)) throw new Error('effect anchor missing')
  text = text.replace(effectAnchor, effectNext)
  console.log('ok  auto effect')
} else console.log('skip auto effect')

writeFileSync(file, text)
