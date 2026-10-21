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
 * @module @local/dsh-mcp-server/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-server',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    /** This bundle's package name, as the profile's bundle list spells it. */
    const PACKAGE_NAME = '@local/dsh-mcp-server'
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
      sectionHint: '开启后，本机 DSH 会话可以使用 MCP 端点发布的 18 个工具：默认只给 3 个入口（目录/打开/调用），需要时才把具体工具注册进该会话。',
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
      fullHint: '启动时把 18 个工具全部注册进每个会话，schema 常驻提示词（约 4 千 token）。',
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
    }

    const en = {
      title: 'DSH-local tools',
      sectionTitle: 'Let DSH use these tools itself',
      sectionHint: 'While on, local DSH sessions can use the endpoint\'s 18 tools: by default they get three front-door tools and open the real ones only when needed.',
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
      fullHint: 'Registers all 18 tools into every session at load, so their schemas are permanent prompt cost (~4k tokens).',
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
    }

    /**
     * The page's stylesheet.
     *
     * It resolves DSH's own theme tokens (`--dsw-*`) first and falls back to
     * theme-neutral greys, so the panel follows light/dark and the Harness's
     * accent instead of shipping its own palette.
     */
    const CSS = [
      '.dsh-mcp-config { display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }',
      '.dsh-mcp-config h4 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .01em; }',
      '.dsh-mcp-config p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.92)); }',
      '.dsh-mcp-config .dsh-mcp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
      '.dsh-mcp-config .dsh-mcp-label { font-size: 13px; }',
      '.dsh-mcp-config .dsh-mcp-switch-row { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }',
      '.dsh-mcp-config .dsh-mcp-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; border: 0; padding: 0;',
      '  border-radius: 999px; background: var(--dsw-alias-border-l4, rgba(127,127,127,.45)); cursor: pointer;',
      '  transition: background 140ms ease; }',
      '.dsh-mcp-config .dsh-mcp-switch[aria-checked="true"] { background: var(--dsw-static-neutral-bluish-400, #3b82f6); }',
      '.dsh-mcp-config .dsh-mcp-switch[disabled] { cursor: progress; opacity: .6; }',
      '.dsh-mcp-config .dsh-mcp-knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;',
      '  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.28); transition: transform 140ms ease; }',
      '.dsh-mcp-config .dsh-mcp-switch[aria-checked="true"] .dsh-mcp-knob { transform: translateX(16px); }',
      '.dsh-mcp-config .dsh-mcp-state { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.92)); }',
      '.dsh-mcp-config .dsh-mcp-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.dsh-mcp-config .dsh-mcp-field > span { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(127,127,127,.92)); }',
      '.dsh-mcp-config .dsh-mcp-field button { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));',
      '  background: transparent; color: inherit; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer;',
      '  transition: background 120ms ease, border-color 120ms ease; }',
      '.dsh-mcp-config .dsh-mcp-field button:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }',
      '.dsh-mcp-config .dsh-mcp-field button[aria-pressed="true"] { border-color: var(--dsw-static-neutral-bluish-400, #3b82f6);',
      '  color: var(--dsw-static-neutral-bluish-400, #3b82f6); font-weight: 600; }',
      '.dsh-mcp-config .dsh-mcp-field button[disabled] { cursor: progress; opacity: .6; }',
      '.dsh-mcp-config .dsh-mcp-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11px;',
      '  color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.8)); }',
      '.dsh-mcp-config code { font-size: 11px; }',
      '.dsh-mcp-config .dsh-mcp-note { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.85));',
      '  padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); }',
      '.dsh-mcp-config .dsh-mcp-error { color: #dc2626; font-size: 12px; }',
      '.dsh-mcp-config button.dsh-mcp-retry { align-self: flex-start; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));',
      '  background: transparent; color: inherit; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }',
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
      /** One row of mutually exclusive buttons. */
      const choices = (values, current, group, onPick) => React.createElement('div', { className: 'dsh-mcp-field' },
        React.createElement('span', null, group === 'delivery' ? t('deliveryLabel') : t('modeLabel')),
        ...values.map((value) => React.createElement('button', {
          key: value,
          type: 'button',
          'aria-pressed': current === value ? 'true' : 'false',
          disabled: busyPhase,
          onClick: () => { if (current !== value) void onPick(value) },
        }, group === 'delivery'
          ? (value === 'setting' ? t('busySetting') : value === 'queue' ? t('busyQueue') : t('busySteer'))
          : (value === 'lazy' ? t('modeLazy') : t('modeFull')))))
      const published = Array.isArray(snapshot && snapshot.published) ? snapshot.published.length : undefined
      const registered = Array.isArray(snapshot && snapshot.registered) ? snapshot.registered.length : undefined

      return React.createElement('div', { className: 'dsh-mcp-config', 'data-dsh-mcp-config': '1' },
        React.createElement('h4', null, t('title')),
        React.createElement('p', null, t('sectionHint')),
        props.bundle ? React.createElement('p', { className: 'dsh-mcp-note' }, t('bundleIntro')) : null,
        React.createElement('div', { className: 'dsh-mcp-row' },
          React.createElement('span', { className: 'dsh-mcp-label' }, t('switchLabel')),
          React.createElement('div', { className: 'dsh-mcp-switch-row' },
            React.createElement('button', {
              type: 'button',
              role: 'switch',
              className: 'dsh-mcp-switch',
              'aria-checked': on ? 'true' : 'false',
              'aria-label': on ? t('switchOff') : t('switchOn'),
              disabled: busyPhase,
              onClick: () => { void save({ exposeToDsh: enabled !== true }) },
            }, React.createElement('span', { className: 'dsh-mcp-knob' })),
            React.createElement('span', { className: 'dsh-mcp-state' }, state))),
        on ? choices(MODES, mode, 'mode', (value) => save({ exposeToDshMode: value })) : null,
        on ? React.createElement('p', { className: 'dsh-mcp-note' }, mode === 'full' ? t('fullHint') : t('lazyHint')) : null,
        on ? React.createElement('div', { className: 'dsh-mcp-field' },
          React.createElement('span', null, t('groupingLabel')),
          React.createElement('button', {
            type: 'button',
            'aria-pressed': grouping.attach ? 'true' : 'false',
            disabled: busyPhase,
            onClick: () => { void save({ groupSessions: !grouping.attach }) },
          }, t('attach')),
          React.createElement('button', {
            type: 'button',
            'aria-pressed': grouping.create ? 'true' : 'false',
            disabled: busyPhase,
            onClick: () => { void save({ createGroups: !grouping.create }) },
          }, t('create'))) : null,
        on ? React.createElement('p', { className: 'dsh-mcp-note' }, (grouping.attach ? t('attachHint') : '') + (grouping.create ? ' ' + t('createHint') : '')) : null,
        on ? choices(BUSY_MODES, busy, 'delivery', (value) => save({ busyMode: value })) : null,
        on ? React.createElement('p', { className: 'dsh-mcp-note' }, t('busyHint')[busy] + (busy === 'setting' && snapshot ? ' (' + t('busyEffective') + ': ' + String(snapshot.busyEffective || '—') + ')' : '')) : null,
        on ? React.createElement('div', { className: 'dsh-mcp-switch-row' },
          React.createElement('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-mcp-switch',
            'aria-checked': sync ? 'true' : 'false',
            'aria-label': sync ? t('syncOff') : t('syncOn'),
            disabled: busyPhase,
            onClick: () => { void save({ syncOnStart: sync !== true }) },
          }, React.createElement('span', { className: 'dsh-mcp-knob' })),
          React.createElement('span', null, t('syncLabel'))) : null,
        on ? React.createElement('p', { className: 'dsh-mcp-note' }, t('syncHint')) : null,
        React.createElement('div', { className: 'dsh-mcp-meta' },
          snapshot && snapshot.url ? React.createElement('span', null, t('endpoint') + ': ', React.createElement('code', null, String(snapshot.url))) : null,
          published === undefined ? null : React.createElement('span', null, t('published') + ': ' + published),
          registered === undefined ? null : React.createElement('span', null, t('registered') + ': ' + registered),
          snapshot && snapshot.version ? React.createElement('span', null, 'v' + String(snapshot.version)) : null),
        React.createElement('p', { className: 'dsh-mcp-note' }, t('authority')),
        failure ? React.createElement('p', { className: 'dsh-mcp-error' }, t('error') + failure) : null,
        failure ? React.createElement('button', { type: 'button', className: 'dsh-mcp-retry', onClick: () => { void read() } }, t('retry')) : null,
        React.createElement('p', null, t('hint')))
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
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for this bundle's own test: the module loader ignores extra
    // exports, and they let the test drive the real route contract.
    exports.rowKey = ROW_KEY
    exports.hostRoute = ROUTE
    exports.pollMs = GUI_POLL_MS
    exports.readSetting = readSetting
    exports.writePatch = writePatch
    return module.exports
  },
})
