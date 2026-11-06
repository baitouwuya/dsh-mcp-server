/**
 * DSH MCP Server — Client half.
 *
 * Hand-written against DSH's client module loader, like the other local
 * bundles: the whole module is wrapped in `window.__ModuleLoader__.load({ id,
 * factory })` and the factory only `require`s `react`, so this half needs no
 * bundler, no TypeScript, and no third-party dependency.
 *
 * It renders one surface — the configuration page of this plugin's row on the
 * Web **Plugins** page — with the two settings that decide what DSH sessions
 * see: whether the surface is on at all, and whether it is the on-demand front
 * door or the whole toolset up front.
 *
 * @module dsh-mcp-btwy/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-btwy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    // The Harness's UI primitives are a platform seed in the client module
    // loader, so the panel reuses the real controls (Switch, SegmentedControl,
    // Pill, Button) instead of re-implementing their look.
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')

    /** This bundle's package name, as the profile's bundle list spells it. */
    const PACKAGE_NAME = 'dsh-mcp-btwy'
    /** The row this page belongs to: `<package name>#<row id>`. */
    const ROW_KEY = PACKAGE_NAME + '#dsh-mcp-server'
    /** Locale namespace for this plugin's copy. */
    const NS = 'dshMcpServer'
    /** Host route registered by the Host half. */
    const ROUTE = '/mcp-config'
    /** How long to wait before re-reading once a write has reloaded the row. */
    const RELOAD_SETTLE_MS = 1800
    /** How often the open page looks for a GUI command. */
    const GUI_POLL_MS = 1500
    /** The surface modes the Host accepts. */
    const MODES = ['lazy', 'full']
    /** The delivery policies the Host accepts. */
    const BUSY_MODES = ['setting', 'queue', 'steer']

    const zh = {
      title: 'DSH 内部工具',
      sectionTitle: '让 DSH 自己使用这些工具',
      sectionHint: '开启后，本机 DSH 会话可以使用 MCP 端点发布的 21 个工具：默认只给 3 个入口（目录/打开/调用），需要时才把具体工具注册进该会话。',
      on: '已开启',
      off: '已关闭',
      switchOn: '开启',
      switchOff: '关闭',
      saving: '正在保存…',
      loading: '正在读取当前设置…',
      reloading: '已保存，插件正在重新加载…',
      modeLabel: '呈现方式',
      modeLazy: '按需',
      modeFull: '全部',
      lazyHint: '只注册 3 个入口工具，agent 需要时才把具体工具注册进本会话（DSH 会在下一步把它们作为 tool addition 告知模型）——每个会话省下约 4 千 token 的 schema。',
      fullHint: '启动时把 21 个工具全部注册进每个会话，schema 常驻提示词（约 4 千 token）。',
      groupingLabel: '侧栏分组',
      attach: '加入已有项目',
      create: '允许新建项目',
      attachHint: '会话加入它所在目录已有的项目；目录没有项目就留在未分组。',
      createHint: '允许为没有项目的目录新建一个分组。',
      deliveryLabel: '忙碌时的消息投递',
      busySetting: '跟随设置',
      busyQueue: '排队',
      busySteer: '直接插入',
      busyHint: {
        setting: '跟随 DSH 自己的 busyEnter 设置（下方显示当前生效值），也就是你在输入框按回车的行为。',
        queue: '总是等当前回合结束，消息留到下一轮。',
        steer: '总是直接插入正在运行的回合。',
      },
      busyEffective: '当前生效',
      syncLabel: '任务开始时同步进度',
      syncOn: '开启任务开始时的进度同步',
      syncOff: '关闭任务开始时的进度同步',
      syncHint: '开启后，一个会话开始任务时会先问同工作区里正在工作的顶层代理一句：你在做什么、正在改哪些文件；发起方不等回复，收到后自行调整顺序，重复或冲突就先协商。子代理只问自己的顶层代理，绝不跨工作区。',
      answerLabel: '代答用户决策',
      approvalLabel: '批准请求',
      approvalHint: '本端点可代答审批（一次性授权或拒绝）。内部调用者只有在已持有 danger-full-access 时才能代答；GUI 卡片仍在竞争中，谁先决定谁生效。',
      questionLabel: '回答提问',
      questionHint: '本端点可回答 ask_user_question（选项或自定义答案），仅限本端点创建或接管的会话。',
      authority: '内部调用者最多只能获得它自己已有的权限：会话不能授予比自身更宽的沙箱模式，审批也只能由已处于最高权限的调用者代答。',
      endpoint: 'MCP 端点',
      registered: '已注册',
      published: '已发布',
      error: '读取或保存失败：',
      retry: '重试',
      hint: '这些开关写入 profile 的 cordis.patch.yml（exposeToDsh / exposeToDshMode），与手工编辑等价；保存后会重新加载这个插件。',
      summary: '决定 DSH agent 能否直接调用本插件发布的工具；默认在任务开始时先和同工作区正在工作的代理同步进度。',
      switchLabel: '在 DSH 中启用',
      bundleIntro: 'MCP 端点与 DSH 会话可见的工具表面。设置经 profile 配置编辑器写入，无需手改 YAML。',
      originSync: '进度同步',
      originMcp: 'MCP 消息',
      originAgent: '智能体消息',
      originTeam: '团队消息',
      originSubagent: '子智能体',
      originOther: '会话消息',
      originFrom: '来自「{name}」',
      originOpen: '打开来源会话',
      bubbleMore: '展开全部（{lines} 行）',
      bubbleLess: '收起',
      triggerExplanation: '这条通知触发了本轮回复。',
      triggerRequest: '收到执行请求',
      triggerGoal: '本轮由目标唤醒',
      triggerSchedule: '本轮由定时任务唤醒',
      triggerWebhook: '本轮由 webhook 唤醒',
      triggerJob: '本轮由后台任务唤醒',
      triggerPlugin: '本轮由插件唤醒',
    }

    const en = {
      title: 'DSH-local tools',
      sectionTitle: 'Let DSH use these tools itself',
      sectionHint: 'While on, local DSH sessions can use the endpoint\'s 21 tools: by default they get three front-door tools and open the real ones only when needed.',
      on: 'On',
      off: 'Off',
      switchOn: 'Turn on',
      switchOff: 'Turn off',
      saving: 'Saving…',
      loading: 'Reading the current setting…',
      reloading: 'Saved — the plugin is reloading…',
      modeLabel: 'Surface',
      modeLazy: 'On demand',
      modeFull: 'All at once',
      lazyHint: 'Registers three front-door tools; a session opens the real ones only when it needs them, and DSH announces them as tool additions on the next step — about 4k tokens of schema saved per session.',
      fullHint: 'Registers all 21 tools into every session at load, so their schemas are permanent prompt cost (~4k tokens).',
      groupingLabel: 'Sidebar projects',
      attach: 'Join an existing project',
      create: 'May create projects',
      attachHint: 'A session joins the project its directory already has; a directory with none keeps it in Ungrouped.',
      createHint: 'Lets this endpoint invent a project for a directory that has none.',
      deliveryLabel: 'Delivery while busy',
      busySetting: 'Follow the setting',
      busyQueue: 'Queue',
      busySteer: 'Steer',
      busyHint: {
        setting: "Follows DSH's own busyEnter setting (shown below) — what your Enter key does.",
        queue: 'Always waits for the current turn; the message is kept for the next one.',
        steer: 'Always injects into the running turn.',
      },
      busyEffective: 'effective',
      syncLabel: 'Sync progress when a task starts',
      syncOn: 'Turn task-start progress sync on',
      syncOff: 'Turn task-start progress sync off',
      syncHint: 'When on, a session starting a task first asks the other working top-level agents in its workspace what they are doing and which files they are touching. The asker does not wait; it adjusts its order when the answer arrives, and negotiates first if the work is duplicate or conflicting. A sub-agent only ever asks its own top-level agent, and another workspace is never contacted.',
      answerLabel: 'Answer user decisions',
      approvalLabel: 'Approvals',
      approvalHint: 'Settle approval requests (one-shot grant or deny). An internal caller may only do this while it already holds danger-full-access; the GUI card stays in the race, and whoever decides first wins.',
      questionLabel: 'Questions',
      questionHint: 'Answer ask_user_question calls for sessions this endpoint created or adopted.',
      authority: 'An internal caller can never hold more than it already does: a session may not be granted a wider sandbox mode, and an approval may only be settled by a caller already at the widest mode.',
      endpoint: 'MCP endpoint',
      registered: 'registered',
      published: 'published',
      error: 'Read or save failed: ',
      retry: 'Retry',
      hint: 'These settings write exposeToDsh / exposeToDshMode into the profile\'s cordis.patch.yml, exactly as a hand edit would, and reload this plugin.',
      summary: 'Decides whether DSH agents can call this plugin\'s tools directly; by default a starting task first syncs progress with the agents working in the same workspace.',
      switchLabel: 'Enable inside DSH',
      bundleIntro: 'The MCP endpoint and the tool surface DSH sessions see. Saved through the profile configuration editor, so no YAML edit is needed.',
      originSync: 'progress sync',
      originMcp: 'MCP message',
      originAgent: 'agent message',
      originTeam: 'team message',
      originSubagent: 'subagent',
      originOther: 'session message',
      originFrom: 'From "{name}"',
      originOpen: 'Open the sending session',
      bubbleMore: 'Show all ({lines} lines)',
      bubbleLess: 'Show less',
      triggerExplanation: 'This notification started the turn.',
      triggerRequest: 'A request started this turn',
      triggerGoal: 'A goal started this turn',
      triggerSchedule: 'A schedule started this turn',
      triggerWebhook: 'A webhook started this turn',
      triggerJob: 'A background job started this turn',
      triggerPlugin: 'A plugin started this turn',
    }

    /**
     * The panel stylesheet.
     *
     * Rows, separators and control sizing follow the Harness's own settings
     * rows: 14px titles over 12px descriptions on the left, the control on the
     * right, .5px separators and the --dsw-* theme tokens for every colour, so
     * the panel reads as part of the Plugins page in either theme.
     */
    const CSS = [
      ".dsh-mcp-config { display: flex; flex-direction: column; width: 100%; font-size: 14px; color: var(--dsw-alias-label-primary, inherit); }",
      ".dsh-mcp-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }",
      ".dsh-mcp-row:last-child { border-bottom: 0; }",
      ".dsh-mcp-copy { display: flex; flex-direction: column; min-width: 0; }",
      ".dsh-mcp-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary, inherit); }",
      ".dsh-mcp-desc { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); }",
      ".dsh-mcp-action { display: flex; flex: none; align-items: center; gap: 8px; }",
      ".dsh-mcp-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); }",
      ".dsh-mcp-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding-bottom: 6px; }",
      ".dsh-mcp-section-title { font-size: 14px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary, inherit); }",
      ".dsh-mcp-section-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.82)); }",
      ".dsh-mcp-rows { display: flex; flex-direction: column; }",
      ".dsh-mcp-footer { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; }",
      ".dsh-mcp-footer-text { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.82)); }",
      ".dsh-mcp-config code { font-size: 12px; }",
      ".dsh-mcp-error { color: var(--dsw-alias-state-error-primary, #dc2626); }",
      ".dsh-mcp-origin { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 0; border: 0; background: none; font: inherit; font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.82)); align-self: flex-end; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".dsh-mcp-origin-button { margin: 0 2px; padding: 0 2px; cursor: pointer; border-radius: var(--dsw-radius-sm, 4px); }",
      ".dsh-mcp-origin-button:hover { color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); text-decoration: underline; text-underline-offset: 2px; }",
      ".dsh-mcp-origin-button:focus-visible { outline: 1px solid var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); outline-offset: 1px; }",
      ".dsh-mcp-origin-icon { display: inline-flex; flex: none; width: 12px; height: 12px; opacity: .85; }",
      ".dsh-mcp-origin-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 32ch; }",
      ".dsh-mcp-origin-kind { flex: none; opacity: .75; }",
      ".dsh-mcp-origin-sep { flex: none; opacity: .5; }",
      ".dsh-mcp-wake { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; }",
      ".dsh-mcp-bubble { max-width: min(82%, calc(var(--dsh-chat-content-width, 748px) * .702)); padding: 10px 14px; border-radius: var(--dsw-radius-xl, 14px); background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, inherit); font-size: var(--dsh-content-font-size, 14px); line-height: 1.6; }",
      ".dsh-mcp-bubble-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }",
      ".dsh-mcp-bubble-folded { max-height: calc(1.6em * 12); overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%); mask-image: linear-gradient(to bottom, #000 72%, transparent 100%); }",
      ".dsh-mcp-bubble-more { align-self: flex-end; margin: 0 2px; padding: 0 2px; border: 0; background: none; font: inherit; font-size: var(--dsh-content-font-size-secondary, 12px); line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.82)); cursor: pointer; border-radius: var(--dsw-radius-sm, 4px); }",
      ".dsh-mcp-bubble-more:hover { color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); text-decoration: underline; text-underline-offset: 2px; }",
      ".dsh-mcp-bubble-more:focus-visible { outline: 1px solid var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); outline-offset: 1px; }",
      ".dsh-mcp-trigger { border: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); border-radius: var(--dsw-radius-xl, 12px); background: var(--dsw-alias-turn-trigger-bg, var(--dsw-alias-markdown-code-block, rgba(127,127,127,.08))); min-width: 0; }",
      ".dsh-mcp-trigger-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px; border: 0; background: none; font: inherit; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.82)); text-align: left; cursor: pointer; }",
      ".dsh-mcp-trigger-head:hover { color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); }",
      ".dsh-mcp-trigger-head:focus-visible { outline: 1px solid var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); outline-offset: -1px; border-radius: var(--dsw-radius-xl, 12px); }",
      ".dsh-mcp-trigger-icon { display: inline-flex; flex: none; }",
      ".dsh-mcp-trigger-title { flex: none; padding: 0; border: 0; background: none; font: inherit; font-size: var(--dsh-content-font-size, 14px); color: inherit; text-align: left; cursor: pointer; }",
      ".dsh-mcp-trigger-toggle { margin: 0; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; display: inline-flex; flex: none; }",
      ".dsh-mcp-trigger-link { text-decoration: underline; text-underline-offset: 2px; }",
      ".dsh-mcp-trigger-time { margin-left: auto; flex: none; font-size: 12px; font-variant-numeric: tabular-nums; }",
      ".dsh-mcp-trigger-chevron { flex: none; transition: transform .1s; }",
      ".dsh-mcp-trigger-chevron[data-open] { transform: rotate(180deg); }",
      ".dsh-mcp-trigger-body { padding: 0 16px 12px 40px; }",
      ".dsh-mcp-trigger-explain { margin: 8px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.9)); }",
      ".dsh-mcp-trigger-content { max-height: 240px; overflow: auto; font-size: 12px; line-height: 18px; }",
      ".dsh-mcp-trigger-text { margin: 0 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }",
    ].join('\n')

    /** Insert the stylesheet, or render unstyled rather than fail. */
    function insertStyles(ctx) {
      try {
        const styles = ctx.get ? ctx.get('styles') : undefined
        if (styles && typeof styles.insert === 'function') {
          styles.insert(CSS)
          return
        }
      } catch {
        // Fall through to a plain style tag rather than losing the styling.
      }
      try {
        const existing = document.querySelector('style[data-dsh-mcp-server="1"]')
        if (existing) {
          existing.textContent = CSS
          return
        }
        const element = document.createElement('style')
        element.dataset.dshMcpServer = '1'
        element.textContent = CSS
        document.head.appendChild(element)
      } catch {
        // No document available: render unstyled rather than fail.
      }
    }

    /** Resolve a translator, tolerating an absent locale service. */
    function makeTranslator(ctx) {
      const dictionaries = { zh, en }
      let bound = null
      const locale = ctx.get ? ctx.get('locale') : undefined
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        try {
          ctx.effect(() => locale.register(NS, dictionaries), NS + '.locale')
          bound = locale.bind(NS)
        } catch {
          bound = null
        }
      }
      return (key) => {
        const direct = bound ? bound(key) : undefined
        if (direct && direct !== key) return direct
        // LocaleSnapshot carries `active`, not `id`: read it, or every user
        // silently gets English.
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
        const table = active.indexOf('zh') === 0 ? zh : en
        return table[key] ?? en[key] ?? key
      }
    }

    /**
     * Read the Host half's current settings.
     *
     * `base` is empty in the browser, where the route is same-origin; the
     * bundle's own test passes an absolute base because Node's fetch cannot
     * resolve a relative URL.
     */
    async function readSetting(base = '') {
      const response = await fetch(base + ROUTE, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error((payload && payload.error) || ('HTTP ' + response.status))
      return payload || {}
    }

    /** Save a validated patch; the Host persists it and reloads this plugin's Host half. */
    async function writePatch(patch, base = '') {
      const response = await fetch(base + ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error((payload && payload.error) || ('HTTP ' + response.status))
      return payload || {}
    }

    /**
     * Watch for GUI commands and run them.
     *
     * DSH forwards only an allowlisted set of Host events to the browser — a list
     * fixed when DSH is built — so a plugin cannot notify the page. This polls
     * the plugin's own loopback route instead: one small request while the page
     * is visible, and a command is acknowledged once, after it ran.
     */
    function watchGuiCommands(ctx) {
      if (typeof ctx.effect !== 'function') return
      let running = false
      const tick = async () => {
        if (running) return
        if (typeof document !== 'undefined' && document.hidden) return
        running = true
        try {
          const snapshot = await readSetting()
          const command = snapshot && snapshot.command
          if (!command || command.kind !== 'open-session' || !command.sessionId) return
          const workspace = (ctx.get ? ctx.get('uiWorkspace') : undefined)
            || (ctx.get ? ctx.get('workspaceNavigation') : undefined)
          if (!workspace || typeof workspace.openSession !== 'function') return
          workspace.openSession(command.sessionId)
          await writePatch({ ackCommand: true }).catch(() => {})
        } catch {
          // A settings write reloads the Host half; the next tick retries.
        } finally {
          running = false
        }
      }
      ctx.effect(() => {
        const timer = setInterval(() => { void tick() }, GUI_POLL_MS)
        // Node hosts this file in the bundle's own test; an unref'd timer must
        // not hold that process open.
        timer.unref?.()
        void tick()
        return () => clearInterval(timer)
      }, 'dsh-mcp-server: gui commands')
    }

    /**
     * The plugin row's configuration page: the switch over the local surface,
     * the mode that decides how much of it a session pays for, and what the
     * surface may grant.
     */
    function ConfigPanel(props) {
      const t = props.t || ((key) => key)
      const [phase, setPhase] = React.useState('loading')
      const [enabled, setEnabled] = React.useState(undefined)
      const [mode, setMode] = React.useState('lazy')
      const [grouping, setGrouping] = React.useState({ attach: true, create: false })
      const [busy, setBusy] = React.useState('setting')
      const [sync, setSync] = React.useState(true)
      const [answering, setAnswering] = React.useState({ approvals: false, questions: false })
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [failure, setFailure] = React.useState(undefined)

      const apply = (payload) => {
        if (typeof payload.exposeToDsh === 'boolean') setEnabled(payload.exposeToDsh)
        if (MODES.indexOf(payload.exposeToDshMode) >= 0) setMode(payload.exposeToDshMode)
        if (typeof payload.groupSessions === 'boolean' || typeof payload.createGroups === 'boolean') {
          setGrouping({ attach: payload.groupSessions !== false, create: payload.createGroups === true })
        }
        if (BUSY_MODES.indexOf(payload.busyMode) >= 0) setBusy(payload.busyMode)
        if (typeof payload.syncOnStart === 'boolean') setSync(payload.syncOnStart)
        if (typeof payload.answerApprovals === 'boolean' || typeof payload.answerQuestions === 'boolean') {
          setAnswering({ approvals: payload.answerApprovals === true, questions: payload.answerQuestions === true })
        }
        setSnapshot(payload)
      }

      const read = React.useCallback(async () => {
        setPhase('loading')
        setFailure(undefined)
        try {
          apply(await readSetting())
          setPhase('ready')
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
          setPhase('error')
        }
      }, [])

      React.useEffect(() => {
        let live = true
        void (async () => {
          try {
            const payload = await readSetting()
            if (!live) return
            apply(payload)
            setPhase('ready')
          } catch (error) {
            if (!live) return
            setFailure(error && error.message ? error.message : String(error))
            setPhase('error')
          }
        })()
        return () => { live = false }
      }, [])

      const save = async (patch) => {
        setPhase('saving')
        setFailure(undefined)
        try {
          const payload = await writePatch(patch)
          apply(payload)
          setPhase('reloading')
          // The write reloads this plugin's Host half: re-read shortly, so the
          // page shows what the new activation actually registered.
          window.setTimeout(() => { void read() }, RELOAD_SETTLE_MS)
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
          setPhase('error')
        }
      }

      const busyPhase = phase === 'saving' || phase === 'reloading'
      const on = enabled === true
      const state = phase === 'saving' ? t('saving') : phase === 'reloading' ? t('reloading') : (on ? t('on') : t('off'))
      /** One segmented control, from the Harness's own primitives. */
      const segmented = (id, label, options, current, onPick) => React.createElement(ui.SegmentedControl, {
        id,
        label,
        value: current,
        disabled: busyPhase,
        options: options.map((option) => ({ value: option.value, label: option.label })),
        onChange: (value) => { if (value !== current) void onPick(value) },
      })
      /** One switch, from the Harness's own primitives. */
      const switchControl = (checked, label, onToggle) => React.createElement(ui.Switch, {
        checked,
        label,
        disabled: busyPhase,
        onChange: (next) => { void onToggle(next) },
      })
      const published = Array.isArray(snapshot && snapshot.published) ? snapshot.published.length : undefined
      const registered = Array.isArray(snapshot && snapshot.registered) ? snapshot.registered.length : undefined
      const groupHints = [grouping.attach ? t('attachHint') : '', grouping.create ? t('createHint') : ''].filter(Boolean).join(' ')
      const busyHint = t('busyHint')[busy] + (busy === 'setting' && snapshot ? ' (' + t('busyEffective') + ': ' + String(snapshot.busyEffective || '-') + ')' : '')
      /** The left column of one settings row: a title over an optional description. */
      const copy = (title, description) => React.createElement('div', { className: 'dsh-mcp-copy' },
        title ? React.createElement('div', { className: 'dsh-mcp-title' }, title) : null,
        description ? React.createElement('div', { className: 'dsh-mcp-desc' }, description) : null)
      /** One settings row: label and description on the left, control on the right. */
      const row = (title, description, action) => React.createElement('div', { className: 'dsh-mcp-row' },
        copy(title, description),
        action ? React.createElement('div', { className: 'dsh-mcp-action' }, ...(Array.isArray(action) ? action : [action])) : null)
      /** A switch row's action: the state read out, then the Harness switch. */
      const switchAction = (checked, label, onToggle) => [
        React.createElement('span', { className: 'dsh-mcp-state' }, checked ? t('on') : t('off')),
        switchControl(checked, label, onToggle),
      ]
      const intro = props.bundle ? t('bundleIntro') : t('sectionHint')
      // The section header DSH renders above its own lists: a bold title with a
      // short summary on the right, then the rows it belongs to.
      const summary = [
        snapshot && snapshot.version ? 'v' + String(snapshot.version) : '',
        published === undefined ? '' : published + ' ' + t('published'),
        registered === undefined ? '' : registered + ' ' + t('registered'),
      ].filter(Boolean).join(' \u00b7 ')

      return React.createElement('div', { className: 'dsh-mcp-config', 'data-dsh-mcp-config': '1' },
        React.createElement('div', { className: 'dsh-mcp-section-head' },
          React.createElement('span', { className: 'dsh-mcp-section-title' }, t('title')),
          summary ? React.createElement('span', { className: 'dsh-mcp-section-meta' }, summary) : null),
        React.createElement('div', { className: 'dsh-mcp-rows' },
          row(t('sectionTitle'), intro, switchAction(on, on ? t('switchOff') : t('switchOn'), (next) => save({ exposeToDsh: next }))),
          row(t('approvalLabel'), t('approvalHint'), switchAction(answering.approvals, answering.approvals ? t('switchOff') : t('switchOn'), (next) => save({ answerApprovals: next }))),
          row(t('questionLabel'), t('questionHint'), switchAction(answering.questions, answering.questions ? t('switchOff') : t('switchOn'), (next) => save({ answerQuestions: next }))),
          on ? row(t('modeLabel'), mode === 'full' ? t('fullHint') : t('lazyHint'), segmented('dsh-mcp-mode', t('modeLabel'), [
            { value: 'lazy', label: t('modeLazy') },
            { value: 'full', label: t('modeFull') },
          ], mode, (value) => save({ exposeToDshMode: value }))) : null,
          on ? row(t('groupingLabel'), groupHints, [
            React.createElement(ui.Pill, {
              key: 'attach',
              active: grouping.attach === true,
              onClick: () => { void save({ groupSessions: !grouping.attach }) },
            }, t('attach')),
            React.createElement(ui.Pill, {
              key: 'create',
              active: grouping.create === true,
              onClick: () => { void save({ createGroups: !grouping.create }) },
            }, t('create')),
          ]) : null,
          on ? row(t('deliveryLabel'), busyHint, segmented('dsh-mcp-delivery', t('deliveryLabel'), [
            { value: 'setting', label: t('busySetting') },
            { value: 'queue', label: t('busyQueue') },
            { value: 'steer', label: t('busySteer') },
          ], busy, (value) => save({ busyMode: value }))) : null,
          on ? row(t('syncLabel'), t('syncHint'), switchAction(sync, sync ? t('syncOff') : t('syncOn'), (next) => save({ syncOnStart: next }))) : null,
          snapshot && snapshot.url ? row(t('endpoint'), null, React.createElement('code', null, String(snapshot.url))) : null),
        React.createElement('div', { className: 'dsh-mcp-footer' },
          React.createElement('p', { className: 'dsh-mcp-footer-text' }, t('authority')),
          React.createElement('p', { className: 'dsh-mcp-footer-text' }, t('hint')),
          failure ? React.createElement('p', { className: 'dsh-mcp-footer-text dsh-mcp-error' }, t('error') + failure) : null,
          failure ? React.createElement(ui.Button, { variant: 'outline', size: 'sm', onClick: () => { void read() } }, t('retry')) : null))
    }

    /**
     * Delivery kinds whose recorded `source` names the Session that sent the
     * message, with the wording each one deserves.
     *
     * The first two are this bundle's own: a prompt handed to a session through
     * `dsh_continue_session`, and the work-sync notices and reports. Both stamp
     * the sending Session on `source.sessionId`. The other three are the
     * Harness's own relays, which name the same thing on
     * `source.senderSessionId` — the reader's question is identical, so one line
     * answers both.
     */
    const ORIGIN_KINDS = {
      'dsh-work-sync': 'originSync',
      'dsh-mcp-server': 'originMcp',
      'agent-message': 'originAgent',
      'team-message': 'originTeam',
      'subagent-settled': 'originSubagent',
    }

    /**
     * Read the sending Session out of one message source.
     *
     * An ordinary prompt has no sender to name; neither has a message this
     * endpoint delivered for an external MCP client, which carries no Session
     * id. Both return `null`, and the row renders untouched.
     *
     * @param {unknown} source - the durable `source` of a user row.
     * @returns {{ sessionId: string, kindKey: string } | null}
     */
    function originOf(source) {
      if (typeof source !== 'object' || source === null) return null
      const kind = typeof source.kind === 'string' ? source.kind : ''
      let sender = ''
      if (typeof source.senderSessionId === 'string' && source.senderSessionId !== '') sender = source.senderSessionId
      else if (typeof source.sessionId === 'string' && source.sessionId !== '') sender = source.sessionId
      if (sender === '') return null
      return { sessionId: sender, kindKey: ORIGIN_KINDS[kind] ?? 'originOther' }
    }

    /** Shorten an id for display while its Session row is still unknown. */
    function shortSessionId(id) {
      return id.length > 8 ? id.slice(0, 8) + '…' : id
    }

    /**
     * Resolve the sending Session's title from the live Session list.
     *
     * `displayTitle` is what the sidebar and the session header show; a row
     * without one falls back to its subagent label, then to the short id, so the
     * line never renders empty.
     *
     * @param {any} list - `sessions.list.getSnapshot()`, possibly null.
     * @param {string} id - the sending Session.
     * @returns {{ title: string, known: boolean }}
     */
    function sessionTitle(list, id) {
      const row = list && list.byId ? list.byId[id] : undefined
      if (row === undefined || row === null) return { title: shortSessionId(id), known: false }
      const subagent = row.projectionValues && row.projectionValues.subagent
      const label = subagent && typeof subagent.label === 'string' ? subagent.label : ''
      const display = typeof row.displayTitle === 'string' ? row.displayTitle.trim() : ''
      const title = display !== '' ? display : label !== '' ? label : shortSessionId(id)
      return { title, known: true }
    }

    /** Paper-plane glyph: the same shape the Harness uses for a delivered turn. */
    function originGlyph() {
      return React.createElement('svg', {
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      React.createElement('path', { d: 'M14 2 6.6 9.4' }),
      React.createElement('path', { d: 'M14 2 9.8 14l-2.2-5.2L2 6.6z' }))
    }

    /**
     * Render the origin line for one user row, or `null` when it names no sender.
     *
     * @param {any} props - slot props plus this entry's injected face.
     * @param {any} list - live Session list snapshot.
     * @returns {any} React element or null.
     */
    function buildOriginLine(props, list) {
      const origin = originOf(props && props.source)
      if (origin === null) return null
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const { title, known } = sessionTitle(list, origin.sessionId)
      const children = [
        React.createElement('span', { key: 'glyph', className: 'dsh-mcp-origin-icon' }, originGlyph()),
        React.createElement('span', { key: 'name', className: 'dsh-mcp-origin-name' }, t('originFrom').replace('{name}', title)),
        React.createElement('span', { key: 'sep', className: 'dsh-mcp-origin-sep', 'aria-hidden': 'true' }, '·'),
        React.createElement('span', { key: 'kind', className: 'dsh-mcp-origin-kind' }, t(origin.kindKey)),
      ]
      const shared = {
        className: known ? 'dsh-mcp-origin dsh-mcp-origin-button' : 'dsh-mcp-origin',
        'data-dsh-mcp-origin': origin.sessionId,
      }
      if (!known) return React.createElement('span', shared, children)
      return React.createElement('button', {
        ...shared,
        type: 'button',
        title: t('originOpen'),
        onClick: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          try {
            props.openSession(origin.sessionId)
          } catch {
            // A Session the client can no longer retain simply does not open.
          }
        },
      }, children)
    }

    /** `useSyncExternalStore`, when this React has it. */
    const useStoreHook = typeof React.useSyncExternalStore === 'function' ? React.useSyncExternalStore : null

    /** Live origin line: it follows Session titles as they are assigned. */
    function OriginLine(props) {
      const list = useStoreHook === null ? null : useStoreHook(props.subscribe, props.getList, props.getList)
      try {
        return buildOriginLine(props, list === null ? props.getList() : list)
      } catch {
        // A header must never take the bubble down with it.
        return null
      }
    }

    /**
     * The card DSH puts above a turn that no person started.
     *
     * The Harness renders one for every waking notification — a goal, a schedule,
     * a webhook, a background job, a relayed agent message — and names the source
     * family in its title. Its map has no entry for this endpoint's own kinds, so
     * a prompt this plugin delivered lands under the generic "a request started
     * this turn", which says nothing about who sent it. This renderer shadows the
     * shipped cell and keeps the card, its disclosure and its clock, while the
     * title names the sending Session when the source carries one.
     */
    const TRIGGER_KINDS = {
      goal: { icon: 'goal', key: 'triggerGoal' },
      schedule: { icon: 'schedule', key: 'triggerSchedule' },
      webhook: { icon: 'webhook', key: 'triggerWebhook' },
      github: { icon: 'webhook', key: 'triggerWebhook' },
      'tool-jobs': { icon: 'job', key: 'triggerJob' },
      'cordis-host-runner': { icon: 'plugin', key: 'triggerPlugin' },
      'agent-message': { icon: 'agent', key: 'triggerRequest' },
      'team-message': { icon: 'team', key: 'triggerRequest' },
      'subagent-settled': { icon: 'subagent', key: 'triggerRequest' },
      'dsh-mcp-server': { icon: 'agent', key: 'triggerRequest' },
      'dsh-work-sync': { icon: 'agent', key: 'triggerRequest' },
    }

    /** One icon per source family, from the Harness primitives when available. */
    function triggerIcon(name) {
      const icons = {
        goal: ui.IconGoalOutlineRegular,
        schedule: ui.IconClockOutlineRegular,
        webhook: ui.IconGlobeOutlineRegular,
        job: ui.IconQueueOutlineRegular,
        plugin: ui.IconCordisPluginOutlineRegular,
        team: ui.IconAgentPresetOutlineRegular,
        subagent: ui.IconAgentPresetOutlineRegular,
        agent: ui.IconPaperPlaneOutlineRegular,
      }
      const Icon = icons[name]
      if (Icon === undefined) return React.createElement('span', { className: 'dsh-mcp-origin-icon' }, originGlyph())
      return React.createElement(Icon, { size: 14 })
    }

    /** Local clock for the card's right-hand stamp. */
    function clockOf(time) {
      const date = new Date(typeof time === 'number' ? time : Date.now())
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /**
     * The kinds this endpoint sends `dsh_continue_session`-style prompts and
     * progress-sync notices under.
     *
     * A person reading the transcript does not distinguish "a card" from "a
     * message": these arrive in the conversation, so they render as one — a
     * bubble on the right, with the sending Session above it.
     */
    const BUBBLE_KINDS = new Set(['dsh-mcp-server', 'dsh-work-sync'])

    /** Lines a delivered bubble shows before it folds. */
    const BUBBLE_CLAMP_LINES = 12
    /** Characters a delivered bubble shows before it folds, single long lines included. */
    const BUBBLE_CLAMP_CHARS = 700

    /**
     * Whether one delivered message is long enough to fold.
     *
     * A long prompt this endpoint hands a session is not what the person is
     * reading for: it pushed every following turn off the screen. Folding is
     * counted in lines and in characters, so a single enormous line folds too.
     *
     * @param {Array<{ text?: string }>} parts - the message's text parts.
     * @returns {{ long: boolean, lines: number }}
     */
    function foldInfo(parts) {
      const list = Array.isArray(parts) ? parts : []
      const text = list.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n')
      const lines = text === '' ? 0 : text.split('\n').length
      const long = lines > BUBBLE_CLAMP_LINES || text.length > BUBBLE_CLAMP_CHARS
      return { long, lines }
    }

    /**
     * Render one delivered message as the bubble it is, with its sender above.
     *
     * @param {any} props - slot props.
     * @param {any} list - live Session list snapshot.
     * @param {{ sessionId: string, kindKey: string }} origin - the sender.
     * @param {any} data - the node's durable data.
     * @param {(key: string, vars?: Record<string, unknown>) => string} t - translator.
     * @returns {any} React element.
     */
    function buildBubble(props, list, origin, data, t) {
      const { title } = sessionTitle(list, origin.sessionId)
      const header = React.createElement('button', {
        type: 'button',
        className: 'dsh-mcp-origin dsh-mcp-origin-button',
        'data-dsh-mcp-origin': origin.sessionId,
        title: t('originOpen'),
        onClick: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (typeof props.openSession === 'function') props.openSession(origin.sessionId)
        },
      },
      React.createElement('span', { key: 'glyph', className: 'dsh-mcp-origin-icon' }, originGlyph()),
      React.createElement('span', { key: 'name', className: 'dsh-mcp-origin-name' }, t('originFrom').replace('{name}', title)),
      React.createElement('span', { key: 'sep', className: 'dsh-mcp-origin-sep', 'aria-hidden': 'true' }, '·'),
      React.createElement('span', { key: 'kind', className: 'dsh-mcp-origin-kind' }, t(origin.kindKey)))

      const parts = Array.isArray(data.content) ? data.content : []
      const { long, lines } = foldInfo(parts)
      const expanded = Boolean(props.expanded)
      const folded = long && !expanded
      const bubbles = parts
        .filter((part) => typeof part.text === 'string' && part.text !== '')
        .map((part, index) => React.createElement('div', {
          key: index,
          className: 'dsh-mcp-bubble' + (folded ? ' dsh-mcp-bubble-folded' : ''),
        }, React.createElement('p', { className: 'dsh-mcp-bubble-text' }, part.text)))

      const toggle = long
        ? React.createElement('button', {
          type: 'button',
          className: 'dsh-mcp-bubble-more',
          'aria-expanded': expanded,
          onClick: () => {
            if (typeof props.toggleExpanded === 'function') props.toggleExpanded()
          },
        }, expanded ? t('bubbleLess') : t('bubbleMore').replace('{lines}', String(lines)))
        : null

      return React.createElement('div', {
        className: 'dsh-mcp-wake',
        'data-dsh-mcp-bubble': origin.sessionId,
        'data-dsh-mcp-folded': folded ? 'true' : 'false',
      }, header, bubbles, toggle)
    }

    /**
     * Render the waking card, naming the sending Session when the source has one.
     *
     * @param {any} props - slot props: `node`, the entry's translator and face.
     * @returns {any} React element.
     */
    function buildTriggerCard(props, list) {
      const data = (props && props.node && props.node.data) || {}
      const source = data.source || {}
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const origin = originOf(source)
      const kind = typeof source.kind === 'string' ? source.kind : ''
      const family = TRIGGER_KINDS[kind] ?? { icon: 'request', key: 'triggerRequest' }
      // A message this endpoint sent is not a wake to explain away: it is a
      // delivered message, so it renders as a bubble like any other.
      if (origin !== null && BUBBLE_KINDS.has(kind)) return buildBubble(props, list, origin, data, t)
      let title
      if (origin !== null) {
        const { title: name } = sessionTitle(list, origin.sessionId)
        title = t('originFrom').replace('{name}', name) + ' · ' + t(origin.kindKey)
      } else {
        title = t(family.key)
      }
      const open = Boolean(props && props.open)
      const toggle = typeof props.toggle === 'function' ? props.toggle : () => {}
      const parts = Array.isArray(data.content) ? data.content : []
      // Two actions, two controls: the title names the sender and opens it, the
      // chevron discloses the card. A wake with no sender keeps the title as the
      // disclosure trigger, exactly like the shipped card.
      const title_ = React.createElement('button', {
        type: 'button',
        className: 'dsh-mcp-trigger-title' + (origin === null ? '' : ' dsh-mcp-trigger-link'),
        title: origin === null ? undefined : t('originOpen'),
        onClick: () => {
          if (origin === null) toggle()
          else if (typeof props.openSession === 'function') props.openSession(origin.sessionId)
        },
      }, title)
      const head = React.createElement('div', { className: 'dsh-mcp-trigger-head' },
        React.createElement('span', { className: 'dsh-mcp-trigger-icon' }, triggerIcon(family.icon)),
        title_,
        React.createElement('time', { className: 'dsh-mcp-trigger-time', dateTime: new Date(typeof data.time === 'number' ? data.time : 0).toISOString() }, clockOf(data.time)),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-mcp-trigger-toggle',
          'aria-expanded': open,
          'aria-label': t('triggerExplanation'),
          onClick: () => toggle(),
        }, React.createElement('svg', { className: 'dsh-mcp-trigger-chevron', 'data-open': open ? 'true' : undefined, viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': 'true' },
          React.createElement('path', { d: 'M2.5 4.5 6 8l3.5-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))))

      const body = React.createElement('div', { className: 'dsh-mcp-trigger-body' },
        React.createElement('p', { className: 'dsh-mcp-trigger-explain' }, t('triggerExplanation')),
        React.createElement('div', { className: 'dsh-mcp-trigger-content' },
          parts.map((part, index) => React.createElement('pre', { key: index, className: 'dsh-mcp-trigger-text' }, typeof part.text === 'string' ? part.text : ''))))

      return React.createElement('section', {
        className: 'dsh-mcp-trigger',
        'data-dsh-mcp-trigger': origin === null ? 'generic' : origin.sessionId,
      }, head, open ? body : null)
    }

    /** Stateful wrapper: the card opens and closes where it is rendered. */
    function TriggerCard(props) {
      const [open, setOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)
      const list = useStoreHook === null ? null : useStoreHook(props.subscribe, props.getList, props.getList)
      try {
        return buildTriggerCard(
          { ...props, open, toggle: () => setOpen(!open), expanded, toggleExpanded: () => setExpanded(!expanded) },
          list === null ? props.getList() : list,
        )
      } catch {
        return null
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = makeTranslator(ctx)
      insertStyles(ctx)
      watchGuiCommands(ctx)

      const slots = ctx.get ? ctx.get('slots') : undefined
      if (!slots || typeof slots.inject !== 'function') return

      // `key` names the row this page configures; the page renders it in place of
      // the row's description summary and behind the row's Configure control.
      ctx.effect(() => slots.inject('plugins.row.config', () => slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
        inject: () => ({ t }),
      }, (props) => (props && props.view === 'summary'
        ? t('summary')
        : React.createElement(ConfigPanel, { t: (props && props.t) || t })))), NS + '.rowConfig')

      // The bundle's own page: the configuration sits directly under the package
      // title, above the component rows, so no row drill-down is needed. The
      // page gates that section on whether the bundle registered a form here;
      // the entry is keyed by the package name the page renders with.
      ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: NS,
        inject: () => ({ t }),
      }, (props) => React.createElement(ConfigPanel, { t: (props && props.t) || t, bundle: true }))), NS + '.bundleConfig')

      // Above a user bubble: one line naming the Session that delivered the
      // message. The chain slot elects the first entry that accepts its props,
      // so the selector declines every row whose source names no sender — an
      // ordinary prompt keeps the shipped, empty chain.
      const liveSessionList = () => {
        const sessions = ctx.get ? ctx.get('sessions') : undefined
        const store = sessions && sessions.list
        if (!store || typeof store.getSnapshot !== 'function') return null
        try {
          return store.getSnapshot()
        } catch {
          return null
        }
      }
      const subscribeSessions = (notify) => {
        const sessions = ctx.get ? ctx.get('sessions') : undefined
        const store = sessions && sessions.list
        if (!store || typeof store.subscribe !== 'function') return () => {}
        const dispose = store.subscribe(() => notify())
        return typeof dispose === 'function' ? dispose : () => {}
      }
      const openSessionById = (sessionId) => {
        const workspace = ctx.get ? ctx.get('uiWorkspace') : undefined
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      }

      // The wake card above a turn no person started. A keyed cell is shadowed by
      // registering the same key at a lower priority, so this replaces the shipped
      // renderer rather than adding a second card.
      ctx.effect(() => slots.inject('conversation.chat.node', () => slots.register({
        name: 'conversation.chat.node',
        key: 'turn-trigger',
        priority: -1,
        locale: NS,
        inject: () => ({ t, getList: liveSessionList, subscribe: subscribeSessions, openSession: openSessionById }),
      }, (props) => React.createElement(TriggerCard, props))), NS + '.turnTrigger')

      ctx.effect(() => slots.inject('conversation.chat.user.before', () => slots.register({
        name: 'conversation.chat.user.before',
        locale: NS,
        select: (ownerProps) => (originOf(ownerProps && ownerProps.source) === null ? null : {}),
        inject: () => ({ t, getList: liveSessionList, subscribe: subscribeSessions, openSession: openSessionById }),
      }, (props) => React.createElement(OriginLine, props))), NS + '.messageOrigin')
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for this bundle's own test: the module loader ignores extra
    // exports, and they let the test drive the real route contract.
    exports.rowKey = ROW_KEY
    exports.hostRoute = ROUTE
    exports.pollMs = GUI_POLL_MS
    exports.originOf = originOf
    exports.buildTriggerCard = buildTriggerCard
    exports.foldInfo = foldInfo
    exports.BUBBLE_CLAMP_LINES = BUBBLE_CLAMP_LINES
    exports.BUBBLE_CLAMP_CHARS = BUBBLE_CLAMP_CHARS
    exports.clockOf = clockOf
    exports.sessionTitle = sessionTitle
    exports.buildOriginLine = buildOriginLine
    exports.originKinds = ORIGIN_KINDS
    exports.readSetting = readSetting
    exports.writePatch = writePatch
    return module.exports
  },
})