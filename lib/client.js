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

    /** The row this page belongs to: `<package name>#<row id>`. */
    const ROW_KEY = '@local/dsh-mcp-server#dsh-mcp-server'
    /** Locale namespace for this plugin's copy. */
    const NS = 'dshMcpServer'
    /** Host route registered by the Host half. */
    const ROUTE = '/mcp-config'
    /** How long to wait before re-reading once a write has reloaded the row. */
    const RELOAD_SETTLE_MS = 1800
    /** The surface modes the Host accepts. */
    const MODES = ['lazy', 'full']

    const zh = {
      title: 'DSH 内部工具',
      sectionTitle: '让 DSH 自己使用这些工具',
      sectionHint: '开启后，本机 DSH 会话可以使用 MCP 端点发布的 17 个工具：默认只给 3 个入口（目录/打开/调用），需要时才把具体工具注册进该会话。',
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
      fullHint: '启动时把 17 个工具全部注册进每个会话，schema 常驻提示词（约 4 千 token）。',
      authority: '内部调用者最多只能获得它自己已有的权限：会话不能授予比自身更宽的沙箱模式，审批也只能由已处于最高权限的调用者代答。',
      endpoint: 'MCP 端点',
      registered: '已注册',
      published: '已发布',
      error: '读取或保存失败：',
      retry: '重试',
      hint: '这些开关写入 profile 的 cordis.patch.yml（exposeToDsh / exposeToDshMode），与手工编辑等价；保存后会重新加载这个插件。',
      summary: '决定 DSH agent 能否直接调用本插件发布的工具。',
    }

    const en = {
      title: 'DSH-local tools',
      sectionTitle: 'Let DSH use these tools itself',
      sectionHint: 'While on, local DSH sessions can use the endpoint\'s 17 tools: by default they get three front-door tools and open the real ones only when needed.',
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
      fullHint: 'Registers all 17 tools into every session at load, so their schemas are permanent prompt cost (~4k tokens).',
      authority: 'An internal caller can never hold more than it already does: a session may not be granted a wider sandbox mode, and an approval may only be settled by a caller already at the widest mode.',
      endpoint: 'MCP endpoint',
      registered: 'registered',
      published: 'published',
      error: 'Read or save failed: ',
      retry: 'Retry',
      hint: 'These settings write exposeToDsh / exposeToDshMode into the profile\'s cordis.patch.yml, exactly as a hand edit would, and reload this plugin.',
      summary: 'Decides whether DSH agents can call this plugin\'s tools directly.',
    }

    /** The page's stylesheet, inserted through whatever facility is available. */
    const CSS = [
      '.dsh-mcp-config { display: flex; flex-direction: column; gap: 10px; }',
      '.dsh-mcp-config h4 { margin: 0; font-size: 13px; font-weight: 600; }',
      '.dsh-mcp-config p { margin: 0; font-size: 12px; line-height: 1.55; opacity: 0.78; }',
      '.dsh-mcp-config .dsh-mcp-switch-row { display: flex; align-items: center; gap: 10px; }',
      '.dsh-mcp-config .dsh-mcp-switch { position: relative; width: 40px; height: 22px; flex: 0 0 auto; border: 0; padding: 0;',
      '  border-radius: 11px; background: rgba(127,127,127,0.35); cursor: pointer; transition: background 120ms ease; }',
      '.dsh-mcp-config .dsh-mcp-switch[aria-checked="true"] { background: #3b82f6; }',
      '.dsh-mcp-config .dsh-mcp-switch[disabled] { cursor: progress; opacity: 0.6; }',
      '.dsh-mcp-config .dsh-mcp-knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;',
      '  background: #fff; transition: transform 120ms ease; }',
      '.dsh-mcp-config .dsh-mcp-switch[aria-checked="true"] .dsh-mcp-knob { transform: translateX(18px); }',
      '.dsh-mcp-config .dsh-mcp-state { font-size: 12px; font-weight: 600; }',
      '.dsh-mcp-config .dsh-mcp-modes { display: flex; align-items: center; gap: 6px; }',
      '.dsh-mcp-config .dsh-mcp-modes button { border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit;',
      '  border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }',
      '.dsh-mcp-config .dsh-mcp-modes button[aria-pressed="true"] { border-color: #3b82f6; color: #3b82f6; font-weight: 600; }',
      '.dsh-mcp-config .dsh-mcp-modes button[disabled] { cursor: progress; opacity: 0.6; }',
      '.dsh-mcp-config .dsh-mcp-modes span { font-size: 12px; opacity: 0.78; }',
      '.dsh-mcp-config .dsh-mcp-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; opacity: 0.7; }',
      '.dsh-mcp-config code { font-size: 11px; }',
      '.dsh-mcp-config .dsh-mcp-note { border-left: 2px solid rgba(127,127,127,0.35); padding-left: 8px; font-size: 11px; opacity: 0.72; }',
      '.dsh-mcp-config .dsh-mcp-error { color: #dc2626; font-size: 12px; }',
      '.dsh-mcp-config button.dsh-mcp-retry { align-self: flex-start; border: 1px solid rgba(127,127,127,0.4); background: transparent;',
      '  color: inherit; border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; }',
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
     * The plugin row's configuration page: the switch over the local surface,
     * the mode that decides how much of it a session pays for, and what the
     * surface may grant.
     */
    function ConfigPanel(props) {
      const t = props.t || ((key) => key)
      const [phase, setPhase] = React.useState('loading')
      const [enabled, setEnabled] = React.useState(undefined)
      const [mode, setMode] = React.useState('lazy')
      const [snapshot, setSnapshot] = React.useState(undefined)
      const [failure, setFailure] = React.useState(undefined)

      const apply = (payload) => {
        if (typeof payload.exposeToDsh === 'boolean') setEnabled(payload.exposeToDsh)
        if (MODES.indexOf(payload.exposeToDshMode) >= 0) setMode(payload.exposeToDshMode)
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

      const busy = phase === 'saving' || phase === 'reloading'
      const on = enabled === true
      const state = phase === 'saving' ? t('saving') : phase === 'reloading' ? t('reloading') : (on ? t('on') : t('off'))
      const published = Array.isArray(snapshot && snapshot.published) ? snapshot.published.length : undefined
      const registered = Array.isArray(snapshot && snapshot.registered) ? snapshot.registered.length : undefined

      return React.createElement('div', { className: 'dsh-mcp-config', 'data-dsh-mcp-config': '1' },
        React.createElement('h4', null, t('title')),
        React.createElement('p', null, t('sectionHint')),
        React.createElement('div', { className: 'dsh-mcp-switch-row' },
          React.createElement('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-mcp-switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-label': on ? t('switchOff') : t('switchOn'),
            disabled: busy,
            onClick: () => { void save({ exposeToDsh: enabled !== true }) },
          }, React.createElement('span', { className: 'dsh-mcp-knob' })),
          React.createElement('span', { className: 'dsh-mcp-state' }, state)),
        on ? React.createElement('div', { className: 'dsh-mcp-modes' },
          React.createElement('span', null, t('modeLabel')),
          ...MODES.map((value) => React.createElement('button', {
            key: value,
            type: 'button',
            'aria-pressed': mode === value ? 'true' : 'false',
            disabled: busy,
            onClick: () => { if (mode !== value) void save({ exposeToDshMode: value }) },
          }, value === 'lazy' ? t('modeLazy') : t('modeFull')))) : null,
        on ? React.createElement('p', { className: 'dsh-mcp-note' }, mode === 'full' ? t('fullHint') : t('lazyHint')) : null,
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
    }

    exports.apply = apply
    exports.inject = inject
    // Exposed for this bundle's own test: the module loader ignores extra
    // exports, and they let the test drive the real route contract.
    exports.rowKey = ROW_KEY
    exports.hostRoute = ROUTE
    exports.readSetting = readSetting
    exports.writePatch = writePatch
    return module.exports
  },
})
