/**
 * dsh-process-lens · Client half（浏览器端）
 *
 * 三个挂载点：
 *  1. conversation.chat.assistant-actions —— 每条回答下面一个「过程」按钮
 *  2. conversation.composer.dock          —— 输入框上方一个小开关（决定"打开才讲/自动讲"）
 *  3. shell.overlay                       —— 右侧抽屉，流式显示人话版过程
 *
 * 不打包：React 由宿主模块表提供；其余全部手写 DOM/CSS。
 */

window.__ModuleLoader__.load({
  id: 'dsh-process-lens',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/process-lens/api'
    const STREAM = '/process-lens/stream'

    // ── 全局小 store（三个槽位共享一份状态） ──────────────────────────────────

    const state = {
      open: false,
      dismissedTurn: null,
      /** 'process' = 看过程；'settings' = 改设置 */
      tab: 'process',
      sessionId: null,
      turn: null,
      notice: null,
      config: {
        provider: '',
        model: '',
        mode: 'onDemand',
        autoOpen: false,
        recent: 8,
        allSteps: false,
        autoSummarize: false,
        autoSummarizeCount: 3,
        style: 'plain',
        activePrompt: '',
        prompts: [],
        styles: [],
        compact: false,
        compactCount: 5,
        theme: 'auto',
        thinking: false,
      },
      configLoaded: false,
      providers: null,
      modelsError: null,
      currentRoute: null,
      snapshot: null,
      snapshotKey: null,
    }
    const listeners = new Set()

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function setState(patch) {
      Object.assign(state, patch)
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {}
      }
    }

    function useLens() {
      const [, bump] = useState(0)
      useEffect(() => subscribe(() => bump((n) => n + 1)), [])
      return state
    }

    // ── 接口 ──────────────────────────────────────────────────────────────────

    /** 把 HTTP 状态码翻成人话，别让用户看到 403 这种字眼。 */
    function friendlyStatus(status) {
      if (status === 401 || status === 403) return '这个页面还没认出新插件，刷新一次页面（Ctrl+R）就好'
      if (status === 404) return '插件后端没在跑，重启一次 DSH 就好'
      if (status >= 500) return '插件后端出了点状况，重启一次 DSH 试试'
      return `接口返回 ${status}`
    }

    async function apiGet(path) {
      const response = await fetch(API + path, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(friendlyStatus(response.status))
      return response.json()
    }

    async function apiPost(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(friendlyStatus(response.status))
      return response.json()
    }

    let configPromise = null
    function loadConfig(force) {
      if (configPromise && !force) return configPromise
      configPromise = apiGet('/config')
        .then((payload) => {
          if (payload?.settings) setState({ config: { ...state.config, ...payload.settings }, configLoaded: true })
          return payload
        })
        .catch(() => {
          setState({ configLoaded: true })
          return null
        })
      return configPromise
    }

    let modelsPromise = null
    function loadModels(force) {
      if (modelsPromise && !force) return modelsPromise
      const query = state.sessionId ? `?session=${encodeURIComponent(String(state.sessionId))}` : ''
      modelsPromise = apiGet(`/models${query}`)
        .then((payload) => {
          setState({
            providers: payload?.providers ?? [],
            modelsError: payload?.error ?? null,
            currentRoute: payload?.current ?? null,
          })
          return payload
        })
        .catch((error) => {
          setState({ providers: [], modelsError: error?.message ?? String(error) })
          return null
        })
      return modelsPromise
    }

    /** 只在用户明确点了才花 token：讲指定的几步（不传就是这一轮全部）。 */
    async function explainSteps(sessionId, turn, steps) {
      if (!sessionId || turn === null || turn === undefined) return
      const list = Array.isArray(steps) ? steps.filter((item) => item !== null && item !== undefined) : []
      try {
        if (list.length === 0) {
          await apiPost('/explain', { session: sessionId, turn })
        } else {
          for (const one of list) await apiPost('/explain', { session: sessionId, turn, step: one })
        }
        setState({ notice: null })
      } catch (error) {
        setState({ notice: `讲不了：${error?.message ?? error}` })
      }
    }

    async function saveConfig(patch) {
      const next = { ...state.config, ...patch }
      setState({ config: next })
      try {
        const payload = await apiPost('/config', patch)
        if (payload?.settings) setState({ config: { ...state.config, ...payload.settings } })
      } catch (error) {
        setState({ notice: `设置没保存上：${error?.message ?? error}` })
      }
    }

    async function openFor(sessionId, messageId) {
      setState({ open: true, tab: 'process', dismissedTurn: null, sessionId, turn: null, snapshot: null, snapshotKey: null, notice: null })
      void loadConfig()
      try {
        const query = new URLSearchParams({ session: String(sessionId ?? '') })
        if (messageId !== undefined && messageId !== null) query.set('messageId', String(messageId))
        const payload = await apiGet(`/turn?${query.toString()}`)
        setState({ turn: payload?.turn ?? null })
        if (payload?.turn === null || payload?.turn === undefined) {
          setState({ notice: '这一轮还没留下过程记录，等它跑一会儿再点' })
        }
      } catch (error) {
        setState({ notice: `没读到过程记录：${error?.message ?? error}` })
      }
    }

    async function openLatest(sessionId) {
      setState({ open: true, tab: 'process', dismissedTurn: null, sessionId, turn: null, snapshot: null, snapshotKey: null, notice: null })
      void loadConfig()
      try {
        const payload = await apiGet(`/latest?session=${encodeURIComponent(String(sessionId ?? ''))}`)
        if (payload?.turn === null || payload?.turn === undefined) {
          setState({ notice: '这个会话还没有跑过一轮' })
          return
        }
        setState({ turn: payload.turn })
      } catch (error) {
        setState({ notice: `没读到过程记录：${error?.message ?? error}` })
      }
    }

    // ── 展示用的小工具 ────────────────────────────────────────────────────────

    function formatDuration(ms) {
      const value = Number(ms) || 0
      if (value < 1000) return `${Math.max(0, Math.round(value))} 毫秒`
      if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
      const minutes = Math.floor(value / 60_000)
      const seconds = Math.round((value % 60_000) / 1000)
      return `${minutes} 分 ${seconds} 秒`
    }

    function turnTitle(snapshot) {
      if (!snapshot) return ''
      if (snapshot.request) return snapshot.request
      return '这一轮你让它做的事'
    }

    function explainStateText(card) {
      if (card.explain === 'queued') return '排队中，马上就讲…'
      if (card.explain === 'running') return '正在翻译成人话…'
      if (card.explain === 'failed') return card.explainError || '这次没翻译出来，可以再点一次'
      return ''
    }

    // ── 图标 ──────────────────────────────────────────────────────────────────

    function IconBulb(props) {
      return h(
        'svg',
        {
          width: props?.size ?? 14,
          height: props?.size ?? 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M9 18h6' }),
        h('path', { d: 'M10 22h4' }),
        h('path', { d: 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z' }),
      )
    }

    // ── 槽位 1：回答下方的「过程」按钮 ────────────────────────────────────────

    function EntryButton(props) {
      const [busy, setBusy] = useState(false)
      const lens = useLens()
      const sessionId = props?.sessionId ?? null
      const messageId = props?.messageId ?? null
      const active = lens.open && lens.sessionId === sessionId

      const onClick = useCallback(() => {
        // 已经开着就再点一次关掉，省得去找 ×
        if (state.open && state.sessionId === sessionId) {
          setState({ open: false, dismissedTurn: state.turn ?? null })
          return
        }
        setBusy(true)
        void openFor(sessionId, messageId).finally(() => setBusy(false))
      }, [sessionId, messageId, lens.open])

      return h(
        'button',
        {
          type: 'button',
          className: `pl-action${active ? ' is-active' : ''}`,
          onClick,
          disabled: busy,
          title: '把这条回答的处理过程翻译成大白话',
        },
        h(IconBulb, { size: 13 }),
        h('span', null, busy ? '读取中…' : '过程'),
      )
    }

    // ── 槽位 2：输入框上方的小开关 ────────────────────────────────────────────

    function DockChip(props) {
      const lens = useLens()
      const sessionId = props?.sessionId ?? null
      useEffect(() => {
        void loadConfig()
      }, [])

      // 「自动弹出」：轻量轮询（刻意不连 SSE，免得被算成"有人在看"而多花额度）。
      // 新一轮出现、或页面刚打开时就有正在跑的一轮，就把进度抽屉拉出来。
      // 关键：seen 必须活在 ref 里。写在 effect 内部的话，用户一关面板 → open 变 false
      // → effect 重跑 → seen 归零 → 又把面板弹回来，表现就是「关不掉」。
      const seenRef = useRef(null)
      useEffect(() => {
        if (!lens.config.autoOpen || !sessionId) return
        let stopped = false
        const tick = async () => {
          try {
            const data = await apiGet(`/latest?session=${encodeURIComponent(String(sessionId))}`)
            if (stopped) return
            const turn = typeof data?.turn === 'number' ? data.turn : null
            if (turn === null) return
            const first = seenRef.current === null
            if (!first && turn <= seenRef.current) return
            seenRef.current = turn
            // 用户刚把这轮关掉，就别再自作聪明地弹回来
            if (state.dismissedTurn === turn) return
            if (state.open) return
            // 页面刚打开时只有正在跑的那一轮才弹，别把上一轮的旧账摊出来
            if (first && data?.status !== 'running') return
            void openLatest(sessionId)
          } catch {}
        }
        void tick()
        const timer = setInterval(tick, 4000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [lens.config.autoOpen, sessionId])

      return h(
        'div',
        { className: 'pl-dock' },
        h(
          'button',
          {
            type: 'button',
            className: 'pl-dock-btn',
            onClick: () => void openLatest(sessionId),
            title: '看看 AI 刚才每一步在干什么（默认只看原文，不花额度）',
          },
          h(IconBulb, { size: 12 }),
          h('span', null, '看过程'),
        ),
      )
    }

    // ── 提示词工作台：风格 / 存档 / 预览 / 省 token ──────────────────────────────

    function PromptStudio({ lens }) {
      const [panel, setPanel] = useState('') // '' | 'preview' | 'new'
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [draftName, setDraftName] = useState('')
      const [draftText, setDraftText] = useState('')
      const [editingId, setEditingId] = useState('')

      const styles = lens.config.styles?.length
        ? lens.config.styles
        : [
            { id: 'plain', name: '通俗', hint: '大白话' },
            { id: 'pro', name: '专业', hint: '术语准确' },
            { id: 'brief', name: '一句话', hint: '极简' },
            { id: 'gentle', name: '给新手', hint: '第一次用' },
          ]
      const prompts = Array.isArray(lens.config.prompts) ? lens.config.prompts : []
      const activeId = lens.config.activePrompt || ''
      const styleValue = activeId ? `p::${activeId}` : `s::${lens.config.style || 'plain'}`
      const compactValue = Number.isFinite(Number(lens.config.compactCount)) ? Number(lens.config.compactCount) : 5

      const query = () => (lens.sessionId ? `?session=${encodeURIComponent(String(lens.sessionId))}` : '')

      const loadPreview = async () => {
        setBusy(true)
        try {
          const data = await apiGet(`/prompt${query()}`)
          setPreview(data)
          setPanel('preview')
        } catch (error) {
          setState({ notice: `读不到提示词：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const act = async (action, payload) => {
        setBusy(true)
        try {
          const data = await apiPost('/prompts', { action, ...payload })
          if (data?.settings) setState({ config: { ...state.config, ...data.settings } })
          if (panel === 'preview') await loadPreview()
        } catch (error) {
          setState({ notice: `没存上：${error?.message ?? error}` })
        } finally {
          setBusy(false)
        }
      }

      const saveDraft = async () => {
        if (!draftText.trim()) {
          setState({ notice: '提示词是空的，写两句再存' })
          return
        }
        await act('save', { id: editingId, name: draftName.trim() || '我的提示词', text: draftText })
        setDraftName('')
        setDraftText('')
        setEditingId('')
        setPanel('')
      }

      const openDraft = (item) => {
        if (item) {
          setEditingId(item.id)
          setDraftName(item.name)
          setDraftText(item.text)
          setPanel('new')
          return
        }
        setEditingId('')
        setDraftName('')
        setDraftText('')
        setPanel(panel === 'new' ? '' : 'new')
      }

      return h(
        'div',
        { className: 'pl-studio' },
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '总结风格'),
          h(
            'select',
            {
              className: 'pl-select',
              value: styleValue,
              onChange: (event) => {
                const raw = String(event.target.value ?? '')
                if (raw.startsWith('p::')) void saveConfig({ activePrompt: raw.slice(3) })
                else void saveConfig({ activePrompt: '', style: raw.slice(3) })
              },
              title: '只换"怎么说"，三行格式不变，拆卡片不会坏',
            },
            h(
              'optgroup',
              { label: '内置' },
              ...styles.map((item) => h('option', { key: item.id, value: `s::${item.id}` }, `${item.name} · ${item.hint}`)),
            ),
            prompts.length
              ? h(
                  'optgroup',
                  { label: '我的存档' },
                  ...prompts.map((item) => h('option', { key: item.id, value: `p::${item.id}` }, item.name)),
                )
              : null,
          ),
          h(Note, { text: '只换讲解员怎么说，三行格式不变。新手选「给新手」，赶时间选「一句话」。', recommend: '推荐「通俗」' }),
        ),
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '省 token'),
          h(
            'label',
            { className: 'pl-switch', title: '开了：把最近 N 步压成骨架再发（本地规则，不调模型、不花额度）；关着：给尽量完整的原文' },
            h('input', {
              type: 'checkbox',
              checked: lens.config.compact === true,
              onChange: (event) => void saveConfig({ compact: event.target.checked }),
            }),
            h('span', { className: 'pl-switch-box' }),
            h('span', { className: 'pl-switch-text' }, lens.config.compact ? '开' : '关'),
          ),
          h('input', {
            key: `compact-${compactValue}`,
            type: 'number',
            className: 'pl-num',
            min: 1,
            max: 50,
            step: 1,
            defaultValue: compactValue,
            onBlur: (event) => {
              const next = Math.min(50, Math.max(1, Math.round(Number(event.target.value) || 5)))
              event.target.value = String(next)
              void saveConfig({ compactCount: next })
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.target.blur()
            },
            title: '精炼最近这么多步再发（1~50）',
          }),
          h('span', { className: 'pl-unit' }, '步 · 只精炼最近这些步'),
          ...[3, 5, 10, 20].map((n) =>
            h(
              'button',
              { key: `quick-${n}`, type: 'button', className: 'pl-mini', onClick: () => void saveConfig({ compactCount: n }) },
              String(n),
            ),
          ),
          h(Note, {
            text: '省 token 打开过程：最近 N 步先本地精炼再发——同一件事合并成一行、长路径折成 #1、重复的路径只写一次图例。不调模型，不花额度。',
            recommend: true,
          }),
        ),
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '提示词'),
          h('button', { type: 'button', className: 'pl-mini', onClick: () => void loadPreview(), disabled: busy }, busy ? '读取中…' : '看当前提示词'),
          h('button', { type: 'button', className: 'pl-mini', onClick: () => openDraft(null) }, panel === 'new' ? '取消' : '新建存档'),
          h(Note, { text: '点「看当前提示词」能看到真正发出去的两段文本；想改口吻就新建一份存档。三行格式会自动补上。' }),
        ),
        panel === 'preview' && preview
          ? h(
              'div',
              { className: 'pl-pre-wrap' },
              h(
                'div',
                { className: 'pl-pre-head' },
                `发给模型的提示词 · 共 ${preview.chars} 字 · 风格：${preview.styleName}` +
                  (preview.compact ? ` · 省 token 已开（精炼最近 ${preview.compactCount} 步）` : '') +
                  (preview.compact && preview.fullChars > preview.chars
                    ? ` · 不省是 ${preview.fullChars} 字，实际省了 ${Math.round((1 - preview.chars / preview.fullChars) * 100)}%`
                    : '') +
                  (preview.compact && preview.compactUsed === false
                    ? ' · 这步内容本来就短，压缩反而更长，这次按原文发的'
                    : ''),
              ),
              h('div', { className: 'pl-pre-label' }, '一、系统提示（角色 + 三行格式）'),
              h('pre', { className: 'pl-pre' }, preview.system),
              h('div', { className: 'pl-pre-label' }, preview.sample ? '二、用户消息（示例：还没记录到这一步）' : '二、用户消息（当前这一步的真实内容）'),
              h('pre', { className: 'pl-pre' }, preview.user),
              h('button', { type: 'button', className: 'pl-mini', onClick: () => setPanel('') }, '收起'),
            )
          : null,
        panel === 'new'
          ? h(
              'div',
              { className: 'pl-draft' },
              h('input', {
                className: 'pl-input',
                placeholder: '起个名，例如：给老板看 / 只讲结论',
                value: draftName,
                onInput: (event) => setDraftName(event.target.value),
              }),
              h('textarea', {
                className: 'pl-area',
                rows: 5,
                placeholder: '写你想让讲解员怎么说话。三行格式（标题 / 在做什么 / 结果）是硬要求，插件会自动补在后面。',
                value: draftText,
                onInput: (event) => setDraftText(event.target.value),
              }),
              h(
                'div',
                { className: 'pl-draft-foot' },
                h('button', { type: 'button', className: 'pl-mini is-primary', onClick: () => void saveDraft(), disabled: busy }, editingId ? '存这份改动' : '存成存档'),
                h('span', { className: 'pl-unit' }, '存下后自动切到这份'),
              ),
            )
          : null,
        prompts.length
          ? h(
              'div',
              { className: 'pl-archive' },
              ...prompts.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'pl-archive-row' },
                  h('span', { className: 'pl-archive-name', title: item.text }, item.name),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pl-mini',
                      onClick: () => void act('select', { id: item.id }),
                      disabled: busy || item.id === activeId,
                    },
                    item.id === activeId ? '在用' : '用这个',
                  ),
                  h('button', { type: 'button', className: 'pl-mini', onClick: () => openDraft(item) }, '改'),
                  h(
                    'button',
                    { type: 'button', className: 'pl-mini is-danger', onClick: () => void act('delete', { id: item.id }), disabled: busy },
                    '删',
                  ),
                ),
              ),
            )
          : null,
      )
    }
    // ── 设置区：模型 / 模式 / 自动弹出 ────────────────────────────────────────

    /**
     * 每个设置后面那句人话：说清它管什么，再顺手标一下「推荐开 / 推荐关」。
     * 推荐值直接写成小标签，省得人自己去猜哪个开关该动。
     */
    function Note({ text, recommend }) {
      const label = recommend === true ? '推荐开' : recommend === false ? '推荐关' : String(recommend ?? '')
      return h(
        'div',
        { className: 'pl-why' },
        h('span', null, text),
        label ? h('span', { className: `pl-rec${recommend === false ? ' is-off' : ''}` }, label) : null,
      )
    }

    function Settings({ lens }) {
      const [expanded, setExpanded] = useState(false)
      useEffect(() => {
        void loadModels()
      }, [])
      const providers = lens.providers ?? []
      const value = lens.config.provider && lens.config.model ? `${lens.config.provider}::${lens.config.model}` : ''
      const chosen = value
        ? providers
            .flatMap((provider) => provider.models.map((model) => ({ ...model, provider })))
            .find((item) => `${item.provider.provider}::${item.id}` === value)
        : null
      const current = lens.currentRoute
      const followLabel = current?.provider && current?.model ? `跟随会话（${current.provider} / ${current.model}）` : '跟随会话（默认）'
      const modelIssue =
        providers.length === 0
          ? lens.modelsError || (lens.providers ? '没读到可用模型，点一下右侧刷新' : '正在读取模型列表…')
          : null
      const recentValue = Number.isFinite(Number(lens.config.recent)) ? Number(lens.config.recent) : 8
      const autoCountValue = Number.isFinite(Number(lens.config.autoSummarizeCount)) ? Number(lens.config.autoSummarizeCount) : 3

      return h(
        'div',
        { className: 'pl-settings' },
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '讲解模型'),
          h(
            'select',
            {
              className: 'pl-select',
              value,
              onChange: (event) => {
                const raw = event.target.value
                if (!raw) {
                  void saveConfig({ provider: '', model: '' })
                  return
                }
                const split = raw.indexOf('::')
                void saveConfig({ provider: raw.slice(0, split), model: raw.slice(split + 2) })
              },
              title: '只影响讲解，不影响会话本身用的模型',
            },
            h('option', { value: '' }, followLabel),
            ...providers.map((provider) =>
              h(
                'optgroup',
                { key: provider.provider, label: provider.name },
                ...provider.models.map((model) =>
                  h('option', { key: `${provider.provider}::${model.id}`, value: `${provider.provider}::${model.id}` }, model.name),
                ),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pl-mini',
              onClick: () => {
                modelsPromise = null
                void loadModels(true)
              },
              title: '重新读一遍模型列表',
            },
            '刷新',
          ),
          h(Note, {
            text: '决定谁把过程翻成人话。默认跟会话用同一个；单独挑个小模型更省钱，讲得也够用。',
            recommend: '推荐跟随会话',
          }),
        ),
        modelIssue
          ? h('div', { className: 'pl-alert' }, `模型列表：${modelIssue}`)
          : null,
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '让它思考'),
          h(
            'label',
            {
              className: 'pl-switch',
              title: '关着（默认）：模型直接给三行结论，快、省额度；开着：先自己想一遍再回答，讲得更细，但慢一些、更费额度',
            },
            h('input', {
              type: 'checkbox',
              checked: lens.config.thinking === true,
              onChange: (event) => void saveConfig({ thinking: event.target.checked }),
            }),
            h('span', { className: 'pl-switch-box' }),
            h('span', { className: 'pl-switch-text' }, lens.config.thinking === true ? '开' : '关'),
          ),
          h(
            'span',
            { className: 'pl-unit' },
            lens.config.thinking === true ? '先思考再回答 · 慢一点但更细' : '直接回答 · 快、省额度',
          ),
          h(Note, { text: '先自己想一遍再回答，讲得更细；代价是慢一点、更费额度。平时关着就够用。', recommend: false }),
        ),
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '自动弹出'),
          h(
            'label',
            { className: 'pl-switch', title: '开了：出现新一轮就把进度面板摊出来（只显示原文，不花额度）；关着：只在你点「看过程」时出现' },
            h('input', {
              type: 'checkbox',
              checked: lens.config.autoOpen === true,
              onChange: (event) => void saveConfig({ autoOpen: event.target.checked }),
            }),
            h('span', { className: 'pl-switch-box' }),
            h('span', { className: 'pl-switch-text' }, lens.config.autoOpen ? '开' : '关'),
          ),
          h(Note, { text: '一有新一轮就自己把面板摊开，只显示原文、一分额度都不花。', recommend: true }),
        ),
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '打开时显示'),
          h('input', {
            type: 'number',
            className: 'pl-num',
            min: 1,
            max: 100,
            step: 1,
            defaultValue: recentValue,
            onBlur: (event) => {
              const next = Math.min(100, Math.max(1, Math.round(Number(event.target.value) || 8)))
              event.target.value = String(next)
              void saveConfig({ recent: next })
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.target.blur()
            },
            title: '打开面板时先摆最近这么多步；想看更多随时可以点「展开全部」',
          }),
          h('span', { className: 'pl-unit' }, '步 · 只摆最新的这些，想看全随时展开'),
          h(Note, { text: '一进来先摆最近这么多步；想看全这一轮，上面点一下「展开」就行。', recommend: '推荐 8' }),
        ),
        h(
          'div',
          { className: 'pl-row' },
          h('span', { className: 'pl-key' }, '打开时自动讲'),
          h(
            'label',
            {
              className: 'pl-switch',
              title: '开了：每次你打开面板，自动把最近 N 步翻译成人话（花额度）；关着：一打开只看原文，一分不花',
            },
            h('input', {
              type: 'checkbox',
              checked: lens.config.autoSummarize === true,
              onChange: (event) => void saveConfig({ autoSummarize: event.target.checked }),
            }),
            h('span', { className: 'pl-switch-box' }),
            h('span', { className: 'pl-switch-text' }, lens.config.autoSummarize ? '开' : '关'),
          ),
          h('input', {
            type: 'number',
            className: 'pl-num',
            min: 1,
            max: 20,
            step: 1,
            defaultValue: autoCountValue,
            onBlur: (event) => {
              const next = Math.min(20, Math.max(1, Math.round(Number(event.target.value) || 3)))
              event.target.value = String(next)
              void saveConfig({ autoSummarizeCount: next })
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.target.blur()
            },
            title: '打开面板时自动讲最近这么多步',
          }),
          h('span', { className: 'pl-unit' }, '步 · 一打开就自动讲这些的概要'),
          h(Note, { text: '一打开面板就自动把最近几步翻成人话，会花额度；想一分不花就关着，手动点「讲这步」。', recommend: false }),
        ),
        h(PromptStudio, { lens }),
        h(
          'button',
          {
            type: 'button',
            className: 'pl-more',
            onClick: () => setExpanded((value) => !value),
          },
          expanded ? '收起说明' : '这些开关是干嘛的？',
        ),
        expanded
          ? h(
              'div',
              { className: 'pl-hint' },
              h('p', null, '· 讲解模型：专门用来把过程翻译成人话。默认跟会话用同一个；换一个小模型可以更省钱。'),
              h('p', null, '· 原文：每张卡上面有个「展开原文」，点开能看到它这一步的完整思考、完整参数、完整返回和它说的话，一分额度都不花。'),
              h('p', null, '· 打开时显示 N 步：面板一进来先摆最近 N 步（默认 8），上面有按钮「展开这一轮全部」，不会漏步也不至于一屏刷不完。'),
              h('p', null, '· 讲这步 / 全部讲一遍：点哪个讲哪个，点一次算一次模型调用，讲到过的会标「讲完了」。'),
              h('p', null, '· 打开时自动讲：开了以后每次打开面板，自动把最近 N 步（默认 3）翻成人话概要；不想要就关掉，一打开只看原文。'),
              h('p', null, '· 自动弹出：出现新一轮就把面板摊出来（只显示原文）；关着就等你点「看过程」。'),
              h('p', null, '· 总结风格：决定讲解员怎么说话——通俗、专业、一句话、给新手；只换说法，不换三行格式。'),
              h('p', null, '· 提示词：「看当前提示词」能看到真正发出去的两段文本；「新建存档」可以写自己的要求并起名，之后在风格下拉里随时切回。'),
              h('p', null, '· 省 token：开了以后，最近 N 步先在你本机精炼成骨架（同一件事合并、长路径折成 #1）再发给模型，额度省很多，全程不调模型、不花额度。'),
              chosen ? h('p', null, `· 现在用的是：${chosen.provider.name} / ${chosen.name}`) : null,
            )
          : null,
      )
    }

    // ── 单张卡片 ──────────────────────────────────────────────────────────────

    /** 原文有多长——只用来在折叠时告诉用户「展开能看多少字」。 */
    function rawSize(raw) {
      let size = (raw.thinking?.length ?? 0) + (raw.answer?.length ?? 0)
      for (const action of raw.actions ?? []) size += (action.detail?.length ?? 0) + (action.output?.length ?? 0)
      return size
    }

    function RawBlock({ card }) {
      const raw = card.raw ?? { actions: [], answer: '', thinking: '' }
      const [open, setOpen] = useState(false)
      const size = rawSize(raw)
      const body = []
      if (raw.thinking) {
        body.push(
          h(
            'div',
            { key: 'think', className: 'pl-raw-row' },
            h('span', { className: 'pl-raw-op' }, '它在想'),
            h('div', { className: 'pl-raw-think' }, raw.thinking),
          ),
        )
      }
      for (const action of raw.actions ?? []) {
        body.push(
          h(
            'div',
            { key: `a-${body.length}`, className: 'pl-raw-row' },
            h('span', { className: `pl-raw-op${action.state === 'error' ? ' is-error' : ''}` }, action.label),
            action.detail ? h('div', { className: 'pl-raw-code' }, action.detail) : null,
            action.args && action.args !== action.detail
              ? h('div', { className: 'pl-raw-code is-args' }, action.args)
              : null,
            action.output ? h('div', { className: 'pl-raw-out' }, action.output) : null,
          ),
        )
      }
      if (raw.answer) {
        body.push(
          h(
            'div',
            { key: 'answer', className: 'pl-raw-row' },
            h('span', { className: 'pl-raw-op' }, '它说'),
            h('div', { className: 'pl-raw-out' }, raw.answer),
          ),
        )
      }
      if (body.length === 0) {
        body.push(h('div', { key: 'none', className: 'pl-raw-row is-dim' }, '这一步没有调用工具，只是模型自己在想/在写。'))
      }
      return h(
        'div',
        { className: 'pl-raw' },
        h(
          'button',
          {
            type: 'button',
            className: 'pl-raw-toggle',
            onClick: () => setOpen((value) => !value),
            title: '看它这一步到底做了什么（不花额度）',
          },
          h('span', { className: 'pl-raw-caret' }, open ? '▾' : '▸'),
          h('span', null, open ? '收起原文' : '展开原文'),
          size > 0 ? h('span', { className: 'pl-raw-count' }, `${size} 字`) : null,
          card.chars > 0
            ? h('span', { className: 'pl-raw-count', title: '这一步讲给模型时实际发了多少字' }, `提示词 ${card.chars} 字`)
            : null,
        ),
        open ? h('div', { className: 'pl-raw-body' }, ...body) : null,
      )
    }

    function Card({ card, onExplain }) {
      const pending = card.status === 'running'
      const busy = card.explain === 'queued' || card.explain === 'running'
      const done = card.explain === 'done'
      const lines = []
      if (card.doing) lines.push({ key: '在做什么', text: card.doing })
      if (card.result) lines.push({ key: '结果', text: card.result })
      const note = explainStateText(card)
      return h(
        'div',
        { className: `pl-card${pending ? ' is-pending' : ''}` },
        h(
          'div',
          { className: 'pl-card-head' },
          h('span', { className: 'pl-step-no' }, `第 ${card.step} 步`),
          h('span', { className: 'pl-card-title' }, card.title),
          pending ? h('span', { className: 'pl-spinner', 'aria-hidden': true }) : null,
        ),
        // 原文在上：不花额度也能看清这一步到底做了什么
        h(RawBlock, { card }),
        lines.length
          ? h(
              'div',
              { className: 'pl-plain' },
              ...lines.map((line) =>
                h(
                  'div',
                  { key: line.key, className: 'pl-line' },
                  h('span', { className: 'pl-tag' }, line.key),
                  h('span', { className: 'pl-text' }, line.text),
                ),
              ),
            )
          : null,
        card.tools?.length
          ? h(
              'div',
              { className: 'pl-tools' },
              ...card.tools.slice(-8).map((tool, index) =>
                h(
                  'span',
                  {
                    key: `${tool.name}-${index}`,
                    className: `pl-chip${tool.state === 'error' ? ' is-error' : ''}`,
                    title: tool.detail || '',
                  },
                  tool.label,
                ),
              ),
            )
          : null,
        note ? h('div', { className: 'pl-note' }, note) : null,
        h(
          'div',
          { className: 'pl-card-foot' },
          h('span', { className: 'pl-meta' }, pending ? '还在进行' : `用了 ${formatDuration(card.durationMs)}`),
          h(
            'button',
            {
              type: 'button',
              className: `pl-mini${done ? ' is-done' : ''}`,
              onClick: () => onExplain?.(card.step),
              disabled: busy || done,
              title: done ? '这一步已经讲过了' : '只讲这一步（点一次 = 一次模型调用）',
            },
            busy ? '正在讲…' : done ? '讲完了' : card.explain === 'failed' ? '再讲一次' : '讲这步',
          ),
        ),
      )
    }

    // ── 槽位 3：右侧抽屉 ──────────────────────────────────────────────────────

    // ── 外观：主题切换（照抄宿主风格 + 壁纸插件的玻璃变量） ──────────────────

    const THEME_CHOICES = [
      { id: 'auto', label: '跟随壁纸', hint: '跟桌面深浅色和壁纸插件同步，壁纸换色这里一起换' },
      { id: 'light', label: '浅色', hint: '固定白底，不看系统也不看壁纸' },
      { id: 'dark', label: '深色', hint: '固定深底，夜里看着不刺眼' },
    ]

    function themeMode(value) {
      return value === 'light' || value === 'dark' ? value : 'auto'
    }

    function ThemePicker({ lens }) {
      const active = themeMode(lens.config.theme)
      const current = THEME_CHOICES.find((item) => item.id === active) ?? THEME_CHOICES[0]
      return h(
        'div',
        { className: 'pl-theme' },
        h(
          'div',
          { className: 'pl-theme-head' },
          h('span', null, '外观'),
          h('span', { className: 'pl-theme-now' }, current.label),
        ),
        h(
          'div',
          { className: 'pl-seg pl-seg-wide' },
          THEME_CHOICES.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: active === item.id ? 'is-on' : '',
                title: item.hint,
                onClick: () => void saveConfig({ theme: item.id }),
              },
              item.label,
            ),
          ),
        ),
        h('div', { className: 'pl-theme-hint' }, current.hint),
      )
    }

    function Drawer() {
      const lens = useLens()
      const [retrying, setRetrying] = useState(false)
      const showAllSteps = lens.config.allSteps === true
      const bodyRef = useRef(null)
      const paneRef = useRef(null)
      const pinnedRef = useRef(true)
      /** 同一轮只自动讲一次，避免快照每刷新一遍就再烧一次额度 */
      const autoDoneRef = useRef('')

      useEffect(() => {
        void loadConfig()
      }, [])

      // 流：连上就算"有人在看"，host 会开始逐条翻译
      useEffect(() => {
        if (!lens.open || !lens.sessionId || lens.turn === null || lens.turn === undefined) return
        const key = `${lens.sessionId}:${lens.turn}`
        const query = new URLSearchParams({ session: String(lens.sessionId), turn: String(lens.turn) })
        const source = new EventSource(`${STREAM}?${query.toString()}`)
        let alive = true

        const applySnapshot = (data) => {
          if (!alive || !data) return
          setState({ snapshot: data, snapshotKey: key, notice: null })
        }
        const mergeCard = (data) => {
          if (!alive || !data || state.snapshotKey !== key || !state.snapshot) return
          const steps = [...(state.snapshot.steps ?? [])]
          const index = steps.findIndex((item) => item.step === data.step)
          if (index >= 0) steps[index] = data
          else steps.push(data)
          steps.sort((a, b) => a.step - b.step)
          setState({ snapshot: { ...state.snapshot, steps } })
        }
        const mergeTurn = (data) => {
          if (!alive || !data || state.snapshotKey !== key || !state.snapshot) return
          setState({
            snapshot: {
              ...state.snapshot,
              status: data.status ?? state.snapshot.status,
              request: data.request || state.snapshot.request,
            },
          })
        }
        const onSnap = (event) => {
          try {
            applySnapshot(JSON.parse(event.data))
          } catch {}
        }
        const onCard = (event) => {
          try {
            mergeCard(JSON.parse(event.data))
          } catch {}
        }
        const onTurn = (event) => {
          try {
            mergeTurn(JSON.parse(event.data))
          } catch {}
        }

        source.addEventListener('snap', onSnap)
        source.addEventListener('card', onCard)
        source.addEventListener('turn', onTurn)
        source.onerror = () => {
          if (!alive) return
          setState({ notice: '连接断了一下，正在自动重连…' })
        }
        return () => {
          alive = false
          source.removeEventListener('snap', onSnap)
          source.removeEventListener('card', onCard)
          source.removeEventListener('turn', onTurn)
          source.close()
        }
      }, [lens.open, lens.sessionId, lens.turn])

      // 新卡片进来时，如果用户没往上翻，就贴着底部
      useEffect(() => {
        const node = bodyRef.current
        if (!node || !pinnedRef.current) return
        node.scrollTop = node.scrollHeight
      }, [lens.snapshot])

      // 「打开时自动讲最近 N 步」：只有用户真的打开面板才触发，同一轮只触发一次
      useEffect(() => {
        if (!lens.open) {
          autoDoneRef.current = ''
          return
        }
        if (!lens.sessionId || lens.turn === null || lens.turn === undefined) return
        if (lens.config.autoSummarize !== true) return
        const snapshot = lens.snapshotKey === `${lens.sessionId}:${lens.turn}` ? lens.snapshot : null
        const cards = snapshot?.steps ?? []
        if (cards.length === 0) return
        const key = `${lens.sessionId}:${lens.turn}`
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

      const onScroll = () => {
        const node = bodyRef.current
        if (!node) return
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
      }

      const close = () => setState({ open: false, dismissedTurn: state.turn ?? null })

      // 切到设置页时把右栏滚回顶部，别让人一进去就落在半截
      useEffect(() => {
        if (lens.tab !== 'settings') return
        const node = paneRef.current
        if (node) node.scrollTop = 0
      }, [lens.tab])

      // 键盘也能关：Esc
      useEffect(() => {
        if (!lens.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [lens.open, lens.turn])

      const explainAll = async () => {
        if (!lens.sessionId || lens.turn === null) return
        setRetrying(true)
        try {
          await apiPost('/explain', { session: lens.sessionId, turn: lens.turn })
        } catch (error) {
          setState({ notice: `没能开始：${error?.message ?? error}` })
        } finally {
          setRetrying(false)
        }
      }

      if (!lens.open) return null

      const snapshot = lens.snapshotKey === `${lens.sessionId}:${lens.turn}` ? lens.snapshot : null
      const steps = snapshot?.steps ?? []
      const finished = snapshot?.status === 'done'
      const pendingCount = steps.filter((card) => card.explain !== 'done').length
      // 「打开时显示最近 N 步」：N 从设置里来，0 表示一进来就全给
      const recent = Number.isFinite(Number(lens.config.recent)) ? Number(lens.config.recent) : 8
      const canCollapse = !showAllSteps && recent > 0 && steps.length > recent
      const visible = canCollapse ? steps.slice(-recent) : steps
      const hiddenCount = steps.length - visible.length

      return h(
        'div',
        { className: 'pl-layer' },
        h(
          'aside',
          {
            className: 'pl-drawer',
            role: 'dialog',
            'aria-label': '过程讲解',
            'data-pl-theme': themeMode(lens.config.theme),
          },
          h(
            'header',
            { className: 'pl-head' },
            h(IconBulb, { size: 15 }),
            h(
              'span',
              { className: 'pl-head-title' },
              lens.tab === 'settings' ? '过程面板设置' : '这一步是怎么来的',
            ),
            h(
              'button',
              { type: 'button', className: 'pl-close', onClick: close, title: '关掉' },
              '×',
            ),
          ),
          h(
            'div',
            { className: 'pl-tabs', role: 'tablist' },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: `pl-tab${lens.tab === 'settings' ? '' : ' is-on'}`,
                'aria-selected': lens.tab === 'settings' ? 'false' : 'true',
                onClick: () => setState({ tab: 'process' }),
              },
              steps.length ? `过程 · ${steps.length} 步` : '过程',
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: `pl-tab${lens.tab === 'settings' ? ' is-on' : ''}`,
                'aria-selected': lens.tab === 'settings' ? 'true' : 'false',
                onClick: () => setState({ tab: 'settings' }),
                title: '模型、开关、外观、提示词都在这儿',
              },
              '设置',
            ),
          ),
          lens.tab === 'settings'
            ? h(
                'div',
                { className: 'pl-pane', ref: paneRef },
                h(ThemePicker, { lens }),
                h(Settings, { lens }),
              )
            : h(
                'div',
                { className: 'pl-frag' },
          h(
            'div',
            { className: 'pl-sub' },
            snapshot?.request
              ? h('span', { className: 'pl-request' }, `你让它做的：${snapshot.request}`)
              : h('span', { className: 'pl-request is-dim' }, '这一轮你让它做的事'),
          ),
          h(
            'div',
            { className: 'pl-bar' },
            h(
              'span',
              { className: 'pl-bar-text' },
              lens.config.autoSummarize === true
                ? `已开「打开时自动讲最近 ${Math.min(20, Math.max(1, Math.round(Number(lens.config.autoSummarizeCount) || 3)))} 步」：每次打开面板都会自动生成这些概要（花额度）`
                : '默认只显示原文。点一次才花一次额度，讲过的会标「讲完了」',
            ),
            steps.length > 1
              ? h(
                  'div',
                  { className: 'pl-modeseg', role: 'group', 'aria-label': '过程页显示多少步' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `pl-modebtn${showAllSteps ? '' : ' is-on'}`,
                      onClick: () => void saveConfig({ allSteps: false }),
                      title: `只摆最近 ${recent} 步（设置 -> 打开时显示 里能改 N）`,
                    },
                    `最近 ${Math.min(recent || steps.length, steps.length)} 步`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `pl-modebtn${showAllSteps ? ' is-on' : ''}`,
                      onClick: () => void saveConfig({ allSteps: true }),
                      title: '这一轮的每一步都摆出来',
                    },
                    `全部 ${steps.length} 步`,
                  ),
                )
              : null,
            steps.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: `pl-mini${pendingCount === 0 ? ' is-done' : ''}`,
                    onClick: explainAll,
                    disabled: retrying || lens.turn === null || pendingCount === 0,
                    title:
                      pendingCount === 0
                        ? '这一轮的每一步都讲过了'
                        : `把还没讲过的 ${pendingCount} 步挨个讲一遍，每步算一次模型调用`,
                  },
                  retrying ? '排队讲…' : pendingCount === 0 ? '这一轮都讲完了' : `全部讲一遍（${pendingCount} 步）`,
                )
              : null,
          ),
          h(
            'div',
            { className: 'pl-body', ref: bodyRef, onScroll },
            lens.notice ? h('div', { className: 'pl-alert' }, lens.notice) : null,
            !snapshot && !lens.notice
              ? h('div', { className: 'pl-empty' }, '正在读取过程记录…')
              : null,
            snapshot && steps.length === 0
              ? h('div', { className: 'pl-empty' }, '它才刚开始，暂时还没有能讲的东西。')
              : null,
            hiddenCount > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'pl-more-steps',
                    onClick: () => void saveConfig({ allSteps: true }),
                    title: `默认只摆最近 ${recent} 步，想全看可以展开`,
                  },
                  `上面还有 ${hiddenCount} 步没摆出来 · 展开这一轮全部 ${steps.length} 步`,
                )
              : null,
            ...visible.map((card) =>
              h(Card, {
                key: card.step,
                card,
                onExplain: (step) => void explainSteps(lens.sessionId, lens.turn, [step]),
              }),
            ),
            showAllSteps && recent > 0 && steps.length > recent
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'pl-more-steps is-collapse',
                    onClick: () => void saveConfig({ allSteps: false }),
                  },
                  `收起，只显示最近 ${recent} 步`,
                )
              : null,
            snapshot && !finished && steps.length > 0
              ? h('div', { className: 'pl-running' }, '它还在往下做，这里会接着更新…')
              : null,
            snapshot && finished && steps.length > 0
              ? h('div', { className: 'pl-done' }, '这一轮做完了。')
              : null,
          ),
          h(
            'footer',
            { className: 'pl-foot' },
            h(
              'button',
              {
                type: 'button',
                className: 'pl-foot-btn',
                onClick: () => void openLatest(lens.sessionId),
                title: '直接看最新一轮',
              },
              '看最新一轮',
            ),
            h(
              'button',
              { type: 'button', className: 'pl-foot-btn', onClick: close },
              '关掉',
            ),
          ),
              ),
        ),
      )
    }

    // ── 样式 ──────────────────────────────────────────────────────────────────

    const CSS = `
.pl-layer { position: fixed; inset: 0; z-index: 70; pointer-events: none; }
.pl-drawer {
  pointer-events: auto;
  position: fixed; right: 20px; bottom: 64px; left: auto; top: auto;
  width: min(620px, calc(100vw - 40px)); max-width: calc(100vw - 40px);
  height: min(74vh, 780px); max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  border-radius: 16px; overflow: hidden;
  background: var(--dsw-alias-bg-overlay, Canvas); color: var(--dsw-alias-label-primary, CanvasText);
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  box-shadow: 0 18px 48px rgba(0,0,0,.24);
  font-size: 13px; line-height: 1.55;
  font-family: inherit;
}
.pl-head { display: flex; align-items: center; gap: 7px; padding: 9px 12px 6px; }
.pl-head-title { font-weight: 600; font-size: 13px; }
.pl-close { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 0; border-radius: 8px; background: transparent; color: inherit; opacity: .55; font-size: 17px; line-height: 1; cursor: pointer; padding: 0; }
.pl-close:hover { opacity: 1; background: rgba(127,127,127,.18); }
.pl-close:hover { opacity: .9; }
.pl-sub { padding: 0 12px 7px; }
.pl-request { display: block; font-size: 11.5px; padding: 6px 9px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.10)); max-height: 54px; overflow: auto; }
.pl-request.is-dim { opacity: .5; }
.pl-settings { padding: 0 12px 7px; display: flex; flex-direction: column; gap: 6px; }
.pl-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.pl-key { flex: 0 0 62px; font-size: 11px; opacity: .6; }
.pl-select { flex: 1 1 auto; min-width: 0; font: inherit; font-size: 11.5px; padding: 3px 5px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); background: var(--dsw-alias-bg-layer-1, Canvas); color: var(--dsw-alias-label-primary, CanvasText); }
.pl-bar { display: flex; align-items: center; gap: 8px; padding: 0 12px 7px; }
.pl-bar-text { flex: 1 1 auto; font-size: 11px; opacity: .55; }
.pl-mini { flex: 0 0 auto; font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; opacity: .8; cursor: pointer; white-space: nowrap; }
.pl-mini:hover { background: rgba(127,127,127,.12); opacity: 1; }
.pl-mini:disabled { opacity: .4; cursor: default; }
.pl-mini.is-done { color: var(--dsw-alias-state-success-primary, #2f9e5f); border-color: transparent; }
.pl-seg { display: inline-flex; border: 1px solid rgba(127,127,127,.32); border-radius: 9px; overflow: hidden; }
.pl-seg button { font: inherit; font-size: 11.5px; padding: 3px 10px; border: 0; background: transparent; color: inherit; opacity: .65; cursor: pointer; }
.pl-seg button.is-on { background: var(--dsw-alias-brand-primary, #4f7cff); color: #fff; opacity: 1; }
.pl-switch { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.pl-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.pl-switch-box { width: 30px; height: 17px; border-radius: 999px; background: rgba(127,127,127,.35); position: relative; transition: background .15s; }
.pl-switch-box::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: transform .15s; }
.pl-switch input:checked + .pl-switch-box { background: var(--dsw-alias-brand-primary, #4f7cff); }
.pl-switch input:checked + .pl-switch-box::after { transform: translateX(13px); }
.pl-switch-text { font-size: 11.5px; opacity: .65; }
.pl-more { align-self: flex-start; border: 0; background: transparent; color: var(--dsw-alias-brand-primary, #4f7cff); font: inherit; font-size: 11.5px; cursor: pointer; padding: 0; }
.pl-studio { display: flex; flex-direction: column; gap: 6px; padding-top: 2px; }
.pl-pre-wrap { display: flex; flex-direction: column; gap: 6px; padding: 8px 9px; border-radius: 10px; border: 1px solid rgba(127,127,127,.25); background: rgba(127,127,127,.06); }
.pl-pre-head { font-size: 11.5px; opacity: .68; }
.pl-pre-label { font-size: 11px; opacity: .55; }
.pl-pre { margin: 0; padding: 6px 8px; border-radius: 8px; background: rgba(127,127,127,.10); font-family: ui-monospace, Consolas, 'Courier New', monospace; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
.pl-draft { display: flex; flex-direction: column; gap: 6px; }
.pl-input { font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; }
.pl-area { font: inherit; font-size: 12px; line-height: 1.55; padding: 7px 9px; border-radius: 9px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; resize: vertical; min-height: 86px; }
.pl-draft-foot { display: flex; align-items: center; gap: 8px; }
.pl-archive { display: flex; flex-direction: column; gap: 4px; }
.pl-archive-row { display: flex; align-items: center; gap: 6px; }
.pl-archive-name { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
.pl-mini.is-primary { background: var(--dsw-alias-brand-primary, #4f7cff); color: #fff; border-color: transparent; }
.pl-mini.is-danger:hover { color: #e5484d; }
.pl-hint { font-size: 11.5px; opacity: .72; display: flex; flex-direction: column; gap: 3px; }
.pl-hint p { margin: 0; }
.pl-body { flex: 1 1 auto; overflow: auto; padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 9px; }
.pl-body::-webkit-scrollbar { width: 8px; }
.pl-body::-webkit-scrollbar-thumb { background: rgba(127,127,127,.3); border-radius: 999px; }
.pl-card { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); border-radius: 12px; padding: 9px 11px; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05)); }
.pl-card.is-pending { border-style: dashed; }
.pl-card-head { display: flex; align-items: center; gap: 7px; }
.pl-step-no { font-size: 10.5px; opacity: .5; flex: 0 0 auto; }
.pl-card-title { font-weight: 600; font-size: 12.5px; flex: 1 1 auto; min-width: 0; }
.pl-spinner { width: 11px; height: 11px; border-radius: 50%; border: 2px solid rgba(127,127,127,.3); border-top-color: var(--dsw-alias-brand-primary, #4f7cff); animation: pl-spin .8s linear infinite; flex: 0 0 auto; }
@keyframes pl-spin { to { transform: rotate(360deg); } }
.pl-line { display: flex; gap: 7px; margin-top: 5px; }
.pl-tag { flex: 0 0 44px; font-size: 11px; opacity: .5; }
.pl-text { flex: 1 1 auto; }
.pl-tools { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.pl-chip { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.14); white-space: nowrap; }
.pl-chip.is-error { background: rgba(214,69,69,.16); color: var(--dsw-alias-state-error-primary, #d64545); }
.pl-note { margin-top: 6px; font-size: 11px; opacity: .6; font-style: italic; }
.pl-card-foot { margin-top: 7px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10.5px; }
.pl-card-foot .pl-meta { opacity: .45; }
.pl-plain { margin-top: 7px; padding-top: 6px; border-top: 1px dashed rgba(127,127,127,.22); }
.pl-raw { margin-top: 6px; }
.pl-raw-toggle { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: 8px; border: 1px dashed rgba(127,127,127,.34); background: transparent; color: inherit; opacity: .8; cursor: pointer; }
.pl-raw-toggle:hover { background: rgba(127,127,127,.1); opacity: 1; }
.pl-raw-caret { font-size: 10px; opacity: .7; }
.pl-raw-count { font-size: 10.5px; opacity: .55; }
.pl-raw-body { margin-top: 6px; display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow: auto; padding-right: 2px; }
.pl-raw-think { flex: 1 1 100%; font-size: 11.5px; opacity: .66; font-style: italic; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
.pl-raw-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 4px 8px; border-radius: 8px; background: rgba(127,127,127,.07); }
.pl-raw-row.is-dim { opacity: .5; background: transparent; padding-left: 0; }
.pl-raw-op { flex: 0 0 auto; font-size: 10.5px; padding: 0 6px; border-radius: 999px; background: rgba(127,127,127,.16); white-space: nowrap; }
.pl-raw-op.is-error { background: rgba(214,69,69,.16); color: var(--dsw-alias-state-error-primary, #d64545); }
.pl-raw-code { flex: 1 1 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: .74; word-break: break-all; white-space: pre-wrap; max-height: 200px; overflow: auto; }
.pl-raw-code.is-args { opacity: .6; background: rgba(127,127,127,.06); border-radius: 6px; padding: 4px 6px; }\n.pl-raw-out { flex: 1 1 100%; font-size: 11.5px; opacity: .72; word-break: break-word; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.pl-num { width: 66px; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 7px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; }
.pl-unit { font-size: 11px; opacity: .6; }
.pl-why { flex-basis: 100%; display: flex; align-items: center; gap: 6px; margin-top: 1px; font-size: 11px; line-height: 1.5; opacity: .72; }
.pl-rec { flex: none; padding: 0 5px; border-radius: 999px; font-size: 10px; line-height: 15px; background: rgba(64,160,110,.16); color: #2f8a5b; }
.pl-rec.is-off { background: rgba(120,130,150,.16); color: #6b7280; }
.pl-more-steps { align-self: stretch; font: inherit; font-size: 11.5px; padding: 6px 10px; border-radius: 9px; border: 1px dashed rgba(127,127,127,.34); background: transparent; color: inherit; opacity: .75; cursor: pointer; }
.pl-more-steps:hover { background: rgba(127,127,127,.1); opacity: 1; }
.pl-more-steps.is-collapse { border-style: solid; }
.pl-modeseg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 9px; border: 1px solid rgba(127,127,127,.28); background: rgba(127,127,127,.06); }
.pl-modebtn { font: inherit; font-size: 11.5px; padding: 3px 9px; border: 0; border-radius: 7px; background: transparent; color: inherit; opacity: .7; cursor: pointer; }
.pl-modebtn:hover { background: rgba(127,127,127,.14); opacity: 1; }
.pl-modebtn.is-on { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.22)); opacity: 1; font-weight: 600; }
.pl-empty, .pl-running, .pl-done { font-size: 12px; opacity: .55; padding: 6px 2px; }
.pl-running::after { content: '…'; animation: pl-blink 1.2s steps(4) infinite; }
@keyframes pl-blink { 0%,100% { opacity: .2 } 50% { opacity: 1 } }
.pl-alert { font-size: 11.5px; padding: 7px 10px; border-radius: 9px; background: rgba(214,150,50,.14); color: #b57b12; }
.pl-foot { display: flex; gap: 8px; padding: 9px 14px 12px; border-top: 1px solid rgba(127,127,127,.18); }
.pl-foot-btn { flex: 1 1 0; font: inherit; font-size: 12px; padding: 6px 10px; border-radius: 9px; border: 1px solid rgba(127,127,127,.32); background: transparent; color: inherit; cursor: pointer; }
.pl-foot-btn:hover { background: rgba(127,127,127,.10); }
.pl-foot-btn:disabled { opacity: .45; cursor: default; }
.pl-foot-btn.is-primary { background: var(--dsw-alias-brand-primary, #4f7cff); border-color: var(--dsw-alias-brand-primary, #4f7cff); color: #fff; }
.pl-action { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; line-height: 1; padding: 4px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; opacity: .72; cursor: pointer; }
.pl-action:hover { opacity: 1; background: rgba(127,127,127,.10); }
.pl-action.is-active { opacity: 1; border-color: var(--dsw-alias-brand-primary, #4f7cff); color: var(--dsw-alias-brand-primary, #4f7cff); }
.pl-action:disabled { opacity: .45; cursor: default; }
.pl-dock { display: inline-flex; align-items: center; gap: 6px; }
.pl-dock-btn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; opacity: .75; cursor: pointer; }
.pl-dock-btn:hover { opacity: 1; }
.pl-dock-mode { display: none; }
.pl-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(127,127,127,.7); }
@media (prefers-color-scheme: dark) {
  .pl-drawer { box-shadow: 0 24px 64px rgba(0,0,0,.6); }
}

/* ── 标签页：过程 / 设置 ───────────────────────────────────────────────── */
.pl-tabs { display: flex; gap: 4px; padding: 0 12px 8px; }
.pl-tab { font: inherit; font-size: 12px; line-height: 1.5; padding: 3px 11px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: inherit; opacity: .58; cursor: pointer; white-space: nowrap; }
.pl-tab:hover { opacity: .92; background: rgba(127,127,127,.14); }
.pl-tab.is-on { opacity: 1; font-weight: 600; background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12)); border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.pl-frag { display: contents; }

/* 设置页自己滚，别把提示词那块裁掉 */
.pl-pane { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 10px 14px 18px; display: flex; flex-direction: column; gap: 14px; }
.pl-pane::-webkit-scrollbar { width: 8px; }
.pl-pane::-webkit-scrollbar-thumb { background: rgba(127,127,127,.3); border-radius: 999px; }
.pl-pane .pl-settings { padding: 0; gap: 8px; }
.pl-pane .pl-studio { padding-top: 0; gap: 8px; }
.pl-pane .pl-pre, .pl-pane .pl-pre-wrap { max-height: none; }
.pl-pane .pl-pre { overflow: visible; }
.pl-pane .pl-area { min-height: 96px; }

/* 外观：三档主题 */
.pl-theme { display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid rgba(127,127,127,.16); }
.pl-theme-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; font-weight: 600; }
.pl-theme-now { margin-left: auto; font-size: 11px; font-weight: 400; opacity: .55; }
.pl-seg-wide { display: flex; width: 100%; }
.pl-seg-wide button { flex: 1 1 0; text-align: center; padding: 4px 8px; }
.pl-theme-hint { font-size: 11px; opacity: .6; }

/* ── 跟壁纸插件一起呼吸：有 --we-* 就用，没有就退回宿主令牌 ─────────────── */
.pl-drawer {
  --pl-skin: var(--we-panel-color, var(--dsw-alias-bg-overlay, Canvas));
  background: color-mix(in srgb, var(--pl-skin) 93%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-border-l2, rgba(127,127,127,.28)) 100%, transparent);
  -webkit-backdrop-filter: blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.2));
  backdrop-filter: blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.2));
}
/* 固定浅色：就地覆盖宿主令牌，里面所有控件一起变 */
.pl-drawer[data-pl-theme="light"] {
  --pl-skin: #fcfcfe;
  --dsw-alias-bg-overlay: #fcfcfe;
  --dsw-alias-bg-layer-1: rgba(18,20,26,.045);
  --dsw-alias-bg-layer-2: rgba(18,20,26,.075);
  --dsw-alias-bg-layer-3: rgba(18,20,26,.11);
  --dsw-alias-label-primary: #1b1c21;
  --dsw-alias-label-secondary: rgba(27,28,33,.62);
  --dsw-alias-border-l1: rgba(18,20,26,.12);
  --dsw-alias-border-l2: rgba(18,20,26,.20);
  --dsw-alias-brand-primary: #3b6fe0;
  --dsw-alias-state-success-primary: #1f8a4c;
  --dsw-alias-state-error-primary: #c6303a;
  --we-blur: 0px;
  box-shadow: 0 20px 52px rgba(20,22,30,.18);
}
/* 固定深色 */
.pl-drawer[data-pl-theme="dark"] {
  --pl-skin: #15161b;
  --dsw-alias-bg-overlay: #15161b;
  --dsw-alias-bg-layer-1: rgba(255,255,255,.065);
  --dsw-alias-bg-layer-2: rgba(255,255,255,.10);
  --dsw-alias-bg-layer-3: rgba(255,255,255,.14);
  --dsw-alias-label-primary: #e8e9ef;
  --dsw-alias-label-secondary: rgba(232,233,239,.66);
  --dsw-alias-border-l1: rgba(255,255,255,.10);
  --dsw-alias-border-l2: rgba(255,255,255,.18);
  --dsw-alias-brand-primary: #7aa2ff;
  --dsw-alias-state-success-primary: #4ec17f;
  --dsw-alias-state-error-primary: #ff6b6b;
  --we-blur: 0px;
  box-shadow: 0 24px 64px rgba(0,0,0,.55);
}
/* 固定主题时别让壁纸色调透进来，字才看得清 */
.pl-drawer[data-pl-theme="light"], .pl-drawer[data-pl-theme="dark"] {
  background: var(--pl-skin);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
`

    // ── 模块导出 ──────────────────────────────────────────────────────────────

    return {
      name: 'dsh-process-lens',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-process-lens'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-process-lens: styles')

        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'process-lens-entry', order: 15 },
            EntryButton,
          ),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'process-lens-dock', order: 2 }, DockChip),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'process-lens-drawer', order: 70 }, Drawer),
        )
      },
    }
  },
})
