#!/usr/bin/env node
/**
 * The stdio bridge against a stub endpoint: both reply forms, and the endpoint
 * file being re-read between calls.
 *
 * The bridge is what a stdio-only harness (Claude Code, Codex, Cursor) launches,
 * so it has to understand the event-stream the route now uses for a slow call —
 * a harness that only forwarded `application/json` would fail every long
 * `dsh_wait_session` with a parse error instead. It also has to re-read the
 * endpoint file: the Harness picks its port at boot, so a cached URL points at
 * the previous instance after a restart.
 *
 * No Harness is needed here: a local stub server stands in for the endpoint.
 */
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridge = join(import.meta.dirname, '..', 'bin', 'dsh-mcp-stdio.mjs')
const checks = []

/**
 * Start one stub endpoint.
 *
 * @param marker - value echoed back in `result.marker`, identifying this stub.
 * @param form - `json` for a plain body, `sse` for the streaming reply form.
 */
async function stub(marker, form) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const message = JSON.parse(body)
      const payload = { jsonrpc: '2.0', id: message.id ?? null, result: { marker, method: message.method } }
      if (form === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
        res.write(': open\n\n')
        setTimeout(() => {
          res.write(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`)
          res.end()
        }, 40)
        return
      }
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(encoded.length) })
      res.end(encoded)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-'))
const endpointFile = join(dir, 'endpoint.json')
const jsonA = await stub('A', 'json')
const jsonB = await stub('B', 'json')
const sse = await stub('SSE', 'sse')

const env = { ...process.env }
delete env.DSH_MCP_URL
delete env.DSH_MCP_TOKEN
delete env.DSH_MCP_TIMEOUT_MS

const child = spawn(process.execPath, [bridge, '--endpoint-file', endpointFile], { stdio: ['pipe', 'pipe', 'pipe'], env })
const responses = new Map()
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

/** Write the endpoint the bridge should dial. */
async function pointAt(url) {
  await writeFile(endpointFile, JSON.stringify({ url, token: 'stub-token', version: '0.0.0' }), 'utf8')
}

/** Request one id and wait for the bridge to print its response line. */
async function request(id) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) + '\n')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === id) return message
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for response ${id}; stderr=${stderr}`)
}

try {
  await pointAt(jsonA.url)
  const first = await request(1)
  assert.equal(first.result.marker, 'A')
  checks.push('the bridge forwards a plain application/json reply')

  await pointAt(jsonB.url)
  const second = await request(2)
  assert.equal(second.result.marker, 'B')
  checks.push('a rewritten endpoint file is re-read on the next request')

  await pointAt(sse.url)
  const third = await request(3)
  assert.equal(third.result.marker, 'SSE')
  checks.push('an event-stream reply is parsed and forwarded as one message')
} finally {
  child.stdin.end()
  child.kill('SIGKILL')
  for (const { server } of [jsonA, jsonB, sse]) server.close()
  await rm(dir, { recursive: true, force: true })
}

for (const check of checks) console.log(`ok - ${check}`)
console.log(`\n${checks.length} stdio stream checks passed`)
