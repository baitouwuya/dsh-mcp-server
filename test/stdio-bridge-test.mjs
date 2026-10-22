#!/usr/bin/env node
/**
 * Drives bin/dsh-mcp-stdio.mjs exactly as a stdio-only MCP harness would, against
 * a RUNNING Harness (it discovers the endpoint through
 * $DSH_HOME/mcp/dsh-mcp-endpoint.json, so the plugin must be active).
 *
 * It performs one real delegated turn at the end. Run:
 *   node test/stdio-bridge-test.mjs
 */
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { join } from 'node:path'

const bridge = join(import.meta.dirname, '..', 'bin', 'dsh-mcp-stdio.mjs')
const child = spawn(process.execPath, [bridge], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }, // discovery through $DSH_HOME/mcp/dsh-mcp-endpoint.json
})

const responses = new Map()
const pending = []
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { throw new Error(`stdout was not JSON: ${line.slice(0, 200)}`) }
    responses.set(message.id, message)
    for (const resolve of pending.splice(0)) resolve()
  }
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}
async function waitFor(id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!responses.has(id)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for response ${id}; stderr=${stderr}`)
    await new Promise((resolve) => { pending.push(resolve); setTimeout(resolve, 500) })
  }
  return responses.get(id)
}

const checks = []
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } })
  const init = await waitFor(1)
  assert.equal(init.result.serverInfo.name, 'dsh-mcp-server')
  assert.equal(init.result.protocolVersion, '2024-11-05')
  checks.push('initialize over stdio, negotiating the legacy 2024-11-05 revision')

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const list = await waitFor(2)
  assert.equal(list.result.tools.length, 21)
  checks.push('tools/list over stdio')

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } })
  const status = await waitFor(3)
  assert.equal(status.result.structuredContent.server, 'dsh-mcp-server')
  checks.push('tools/call over stdio reaches the live Harness')

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_run_prompt', arguments: { prompt: 'Reply with exactly: STDIO-OK. Do not use any tools.', cwd: '/tmp' } } })
  const run = await waitFor(4, 240_000)
  assert.equal(run.result.structuredContent.status, 'completed')
  assert.match(run.result.structuredContent.text, /STDIO-OK/)
  checks.push('dsh_run_prompt over stdio drives a real DSH turn')

  for (const check of checks) console.log(`ok - ${check}`)
  console.log(`\n${checks.length} stdio bridge checks passed`)
} finally {
  child.stdin.end()
  setTimeout(() => child.kill('SIGKILL'), 1000)
}