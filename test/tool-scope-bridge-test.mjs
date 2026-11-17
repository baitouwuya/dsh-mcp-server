#!/usr/bin/env node
/**
 * Tool scope at the registration points.
 *
 * These checks drive `registerDshTools` against a recording tools service, which
 * is the only way to see what a registration actually carries: the `when` option
 * is what DSH consults per step, so its absence is invisible until a workspace
 * that should be excluded gets the tools anyway.
 *
 * Run: node test/tool-scope-bridge-test.mjs
 */

import assert from 'node:assert/strict'

import { registerDshTools } from '../lib/dsh-tools-bridge.js'

let passed = 0
const failures = []
async function check(name, run) {
  try {
    await run()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL - ${name}\n  ${error && error.message ? error.message : String(error)}`)
  }
}

const CAPABILITIES = {
  tools: [
    { name: 'dsh_status', description: 'Report the endpoint state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ],
  callTool: async () => ({ text: '{}' }),
}

/** A tools service that records what it was asked to register. */
function recordingTools() {
  const rows = []
  return {
    rows,
    register(definition, options) {
      rows.push({ definition, options })
      return () => {}
    },
    get() {
      return undefined
    },
  }
}

/** A plugin context whose `tools` service is the recorder. */
function contextWith(tools) {
  return { get: (name) => (name === 'tools' ? tools : undefined) }
}

async function bridgeWith(scope, mode = 'full') {
  const tools = recordingTools()
  const registered = registerDshTools({ ctx: contextWith(tools), capabilities: CAPABILITIES, mode, scope })
  // The bridge asks `inject` when it exists; this fake context has none, so the
  // registration already happened synchronously by the time we look.
  assert.ok(registered.names.length > 0, 'the bridge must register something')
  return { tools, registered }
}

// --- the registration carries a predicate -----------------------------------

await check('every registration carries a when predicate', async () => {
  const scope = { visibleFor: async () => true }
  const { tools } = await bridgeWith(scope)
  assert.ok(tools.rows.length > 0)
  for (const row of tools.rows) {
    assert.equal(typeof row.options?.when, 'function', `${row.definition.name} must carry when`)
  }
})

await check('no scope means no predicate, so a deployment without it is untouched', async () => {
  const { tools } = await bridgeWith(undefined)
  for (const row of tools.rows) assert.equal(row.options, undefined, `${row.definition.name} must stay unconditional`)
})

await check('the predicate follows the scope for an admitted workspace', async () => {
  const scope = { visibleFor: async (agent) => agent?.id === 'ok' }
  const { tools } = await bridgeWith(scope)
  const row = tools.rows[0]
  assert.equal(await row.options.when({ agent: { id: 'ok' } }), true)
  assert.equal(await row.options.when({ agent: { id: 'nope' } }), false)
})

await check('a scope that throws hides the tool instead of aborting the turn', async () => {
  const scope = { visibleFor: async () => { throw new Error('registry exploded') } }
  const { tools } = await bridgeWith(scope)
  const row = tools.rows[0]
  assert.equal(await row.options.when({ agent: { id: 'ok' } }), false, 'a throwing predicate must answer false, never throw')
})

// --- dsh_mcp_open -----------------------------------------------------------

/** The meta definitions, so `dsh_mcp_open` itself can be driven. */
async function metaScopeWith(scope) {
  const tools = recordingTools()
  const registered = registerDshTools({ ctx: contextWith(tools), capabilities: CAPABILITIES, mode: 'lazy', scope })
  assert.ok(registered.names.includes('dsh_mcp_open'))
  const open = tools.rows.find((row) => row.definition.name === 'dsh_mcp_open')
  return { tools, open }
}

await check('opening tools in an excluded workspace is refused with a readable reason', async () => {
  const scope = { visibleFor: async () => false }
  const { open } = await metaScopeWith(scope)
  const agent = { id: 'a', ctx: { tools: recordingTools() } }
  await assert.rejects(() => open.definition.execute({ tools: ['dsh_status'] }, { agent }), /does not expose the DSH tools/)
})

await check('an admitted workspace still opens tools, and the scoped registration carries when', async () => {
  const scope = { visibleFor: async () => true }
  const { open } = await metaScopeWith(scope)
  const agentTools = recordingTools()
  const agent = { id: 'a', ctx: { tools: agentTools } }
  const result = await open.definition.execute({ tools: ['dsh_status'] }, { agent })
  assert.deepEqual(result.opened, ['dsh_status'])
  assert.equal(agentTools.rows.length, 1)
  assert.equal(typeof agentTools.rows[0].options?.when, 'function', 'an opened tool must carry the same predicate')
})

await check('a registration that throws is reported as opened-nothing, and retried next time', async () => {
  const scope = { visibleFor: async () => true }
  const { open } = await metaScopeWith(scope)
  let fail = true
  const broken = {
    rows: [],
    register(definition) {
      if (fail) throw new Error('registry refused')
      this.rows.push({ definition })
      return () => {}
    },
    get() {
      return undefined
    },
  }
  const agent = { id: 'a', ctx: { tools: broken } }
  const first = await open.definition.execute({ tools: ['dsh_status'] }, { agent })
  // Claiming success here would make `alreadyOpen` refuse to retry forever.
  assert.deepEqual(first.opened, [])
  fail = false
  const second = await open.definition.execute({ tools: ['dsh_status'] }, { agent })
  assert.deepEqual(second.opened, ['dsh_status'])
  assert.deepEqual(second.alreadyOpen, [])
})

await check('what the registry refused is not reported as registered', async () => {
  const tools = {
    rows: [],
    register(definition) {
      if (definition.name === 'dsh_status') throw new Error('name taken')
      this.rows.push({ definition })
      return () => {}
    },
    get() {
      return undefined
    },
  }
  const registered = registerDshTools({ ctx: contextWith(tools), capabilities: CAPABILITIES, mode: 'full', scope: { visibleFor: async () => true } })
  assert.ok(registered.requested.includes('dsh_status'), 'the request is reported separately')
  assert.ok(!registered.names.includes('dsh_status'), 'the refusal is not claimed as registered')
  assert.deepEqual(registered.names, registered.requested.filter((name) => name !== 'dsh_status'))
})

await check('an inject that never answers reports nothing registered', async () => {
  const context = {
    get: () => undefined,
    // A service that never appears: the callback is simply never called.
    inject: () => {},
  }
  const registered = registerDshTools({ ctx: context, capabilities: CAPABILITIES, mode: 'lazy', scope: { visibleFor: async () => true } })
  assert.deepEqual(registered.names, [])
  assert.ok(registered.requested.length > 0)
})

await check('a late inject still updates the names its caller already holds', async () => {
  const tools = { rows: [], register(definition) { this.rows.push(definition); return () => {} }, get() { return undefined } }
  let fire = null
  const context = { get: () => undefined, inject: (_names, callback) => { fire = () => callback({ tools, effect: () => {} }) } }
  const registered = registerDshTools({ ctx: context, capabilities: CAPABILITIES, mode: 'lazy', scope: { visibleFor: async () => true } })
  // The caller holds this array; replacing the property would strand it empty.
  const held = registered.names
  fire()
  assert.ok(held.length > 0, 'the same array must show what registered')
  assert.deepEqual(held, registered.names)
})

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} tool-scope-bridge checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
