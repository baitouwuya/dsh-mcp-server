#!/usr/bin/env node
/**
 * File upload: minting a slot, PUTting bytes into it, and referencing the
 * result from a prompt.
 *
 * Run: node test/file-upload-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { createPluginHarness } from './helpers/plugin-harness.mjs'

const checks = []
async function check(name, fn) {
  await fn()
  checks.push(name)
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const h = await createPluginHarness({ label: 'file-upload', withAttachments: true })

/** Mint one slot through the public tool surface. */
async function mint(files) {
  return h.call('dsh_prepare_upload', { files })
}

try {
  await check('a minted slot returns an absolute url that accepts the bytes', async () => {
    const minted = await mint([{ name: 'dot.png', mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    assert.match(slot.uploadUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp-files\//, 'upload url must be absolute and on this server')
    assert.equal(slot.method, 'PUT')

    const put = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(put.status, 200, 'a declared image/png with matching bytes is accepted')
    const body = await put.json()
    assert.equal(body.fileId, slot.fileId)
    assert.equal(body.storedBytes, PNG_1PX.length)
    assert.equal(body.mediaType, 'image/png')
    assert.match(body.sha256, /^[0-9a-f]{64}$/)
  })

  await check('the content-type may be omitted and still store the declared type', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    const put = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX, headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(put.status, 200, 'octet-stream means "as declared", so curl -T works')
  })

  await check('a mismatched content-type is refused without burning the slot', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    const wrong = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX, headers: { 'content-type': 'image/jpeg' } })
    assert.equal(wrong.status, 415)
    const retry = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(retry.status, 200, 'the link survives a correctable mistake')
  })

  await check('bytes over the slot ceiling are refused and the link stays usable', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: 200 }])
    const [slot] = minted.uploads
    const big = await fetch(slot.uploadUrl, { method: 'PUT', body: Buffer.concat([PNG_1PX, Buffer.alloc(300)]) })
    assert.equal(big.status, 413)
    const retry = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(retry.status, 200)
  })

  await check('a link accepts exactly one successful upload', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    assert.equal((await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })).status, 200)
    const again = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(again.status, 409)
  })

  await check('two simultaneous uploads to one link: one wins, one is refused', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    const results = await Promise.all([
      fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX }),
      fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX }),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  })

  await check('an unknown media type is refused at mint time', async () => {
    await assert.rejects(
      () => mint([{ mediaType: 'application/pdf' }]),
      /returned a tool error|mediaType/,
      'only image types are accepted',
    )
  })

  await check('a prompt carries the uploaded image into the message', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    assert.equal((await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })).status, 200)
    await h.call('dsh_run_prompt', { prompt: 'look at this', fileIds: [slot.fileId], wait: false })
    const admitted = h.admittedRequests().filter((request) => (request.content ?? []).some((part) => part.type === 'image')).at(-1)
    assert.ok(admitted, 'the prompt reached the fake agent')
    const parts = admitted.content
    assert.equal(parts[0].type, 'text')
    assert.equal(parts[1].type, 'image')
    assert.match(parts[1].attachment.attachmentId, /^att_\d+$/)
    assert.equal(parts[1].attachment.mediaType, 'image/png')
  })

  await check('an unminted file id is refused instead of silently dropped', async () => {
    await assert.rejects(
      () => h.call('dsh_run_prompt', { prompt: 'x', fileIds: ['f_nope'], wait: false }),
      /unknown fileId/,
    )
  })

  await check('initialize advertises the upload shape without a second call', async () => {
    const init = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const meta = init.result._meta?.['dsh-mcp-server']?.fileUpload
    assert.ok(meta, 'the initialize result carries a fileUpload block')
    assert.equal(meta.supported, true)
    assert.equal(meta.prepareTool, 'dsh_prepare_upload')
    assert.equal(meta.method, 'PUT')
    assert.equal(meta.uploadTtlMs, 300000)
  })

  await check('dsh_status reports upload state without leaking addresses', async () => {
    const status = await h.call('dsh_status', {})
    assert.equal(status.upload.supported, true)
    assert.equal(status.upload.maxFiles, 10)
    assert.equal(typeof status.upload.storedFileIds, 'number')
    assert.ok(!JSON.stringify(status.upload).includes('/mcp-files/'), 'no address is published')
  })

  await check('the upload url echoes the Host the caller used, ignoring spoofed forwarding headers', async () => {
    const minted = await h.call('dsh_prepare_upload', { files: [{ mediaType: 'image/png' }] }, {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    })
    assert.match(minted.uploads[0].uploadUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp-files\//,
      'X-Forwarded-* is ignored unless the deployment opts in')
  })

  await check('clientBaseUrl overrides the derived origin', async () => {
    const minted = await h.call('dsh_prepare_upload', {
      files: [{ mediaType: 'image/png' }],
      clientBaseUrl: 'https://dsh.example.com:23000/some/path',
    })
    assert.equal(minted.uploads[0].uploadUrl, 'https://dsh.example.com:23000/mcp-files/' + minted.uploads[0].uploadUrl.split('/mcp-files/')[1])
  })

  await check('a body larger than the endpoint ceiling gets 413, not a reset connection', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: 64 }])
    const [slot] = minted.uploads
    const huge = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024)])
    const response = await fetch(slot.uploadUrl, { method: 'PUT', body: huge }).catch((error) => error)
    assert.equal(response.status, 413, 'the server answers before closing the socket')
  })

  await check('an unknown link is refused before any body is buffered', async () => {
    const response = await fetch(h.address.replace('/mcp', '/mcp-files/not-a-real-nonce'), {
      method: 'PUT',
      body: Buffer.alloc(1024),
    })
    assert.equal(response.status, 410)
  })

  await check('referencing a minted but unuploaded id says so instead of pretending', async () => {
    const minted = await mint([{ mediaType: 'image/png' }])
    await assert.rejects(
      () => h.call('dsh_run_prompt', { prompt: 'x', fileIds: [minted.uploads[0].fileId], wait: false }),
      /has not finished uploading/,
    )
  })

  await check('three images ride one prompt as three parts', async () => {
    const minted = await mint([
      { mediaType: 'image/png' },
      { mediaType: 'image/png' },
      { mediaType: 'image/png' },
    ])
    for (const slot of minted.uploads) {
      assert.equal((await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })).status, 200)
    }
    await h.call('dsh_run_prompt', { prompt: 'three', fileIds: minted.uploads.map((slot) => slot.fileId), wait: false })
    const admitted = h.admittedRequests().filter((request) => (request.content ?? []).some((part) => part.type === 'image')).at(-1)
    assert.equal(admitted.content.filter((part) => part.type === 'image').length, 3)
  })

  await check('a client that hangs up mid-body frees the slot', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: 4096 }])
    const [slot] = minted.uploads
    await new Promise((resolve) => {
      const url = new URL(slot.uploadUrl)
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': '4096' },
      })
      request.on('error', () => resolve())
      request.write(PNG_1PX.subarray(0, 10))
      setTimeout(() => { request.destroy(); resolve() }, 50)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const retry = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(retry.status, 200, 'the link is usable again after an aborted upload')
  })

  await check('a deployment without the attachment service explains itself', async () => {
    const bare = await createPluginHarness({ label: 'file-upload-bare', withAttachments: false })
    try {
      await assert.rejects(
        () => bare.call('dsh_prepare_upload', { files: [{ mediaType: 'image/png' }] }),
        /no attachment service/,
      )
      const init = await bare.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      const meta = init.result._meta?.['dsh-mcp-server'] ?? {}
      assert.equal(meta.fileUpload?.supported, false, 'initialize reports the capability as absent')
    } finally {
      await bare.close()
    }
  })

  await check('a tool failure carries the upload status machine-readably', async () => {
    const body = await h.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'dsh_run_prompt', arguments: { prompt: 'x', fileIds: ['f_never_minted'], wait: false } },
    })
    const failure = body?.error ?? body?.result
    assert.ok(failure, 'the call failed as expected')
    assert.equal(failure.structuredContent?.httpStatus, 404, 'the caller can tell a missing id from a bad argument without parsing prose')
  })

  await check('the delivered image part tells the Harness how many bytes it carries', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    await h.call('dsh_run_prompt', { prompt: 'sized', fileIds: [slot.fileId], wait: false })
    const admitted = h.admittedRequests().filter((request) => (request.content ?? []).some((part) => part.type === 'image')).at(-1)
    const part = admitted.content.find((entry) => entry.type === 'image')
    assert.equal(part.encodedBytes, PNG_1PX.length, 'without it the per-message byte ceiling sums to NaN')
  })

  await check('a provider that keeps refusing the bytes burns the link', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }])
    const [slot] = minted.uploads
    h.failSaves(3)
    const statuses = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })).status)
    }
    assert.deepEqual(statuses.slice(0, 2), [500, 500], 'the first two refusals are retryable server errors')
    assert.equal(statuses[2], 410, 'the third refusal spends the attempt budget')
    const after = await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })
    assert.equal(after.status, 410, 'a burned link stays burned')
  })

  await check('the slot is claimed before the body arrives, not after', async () => {
    const minted = await mint([{ mediaType: 'image/png', expectedBytes: 4096 }])
    const [slot] = minted.uploads
    const url = new URL(slot.uploadUrl)
    // A stalled upload: headers and a few bytes, then nothing. If the claim
    // happened only once the body was complete, the fast request below would win
    // the slot instead of being turned away.
    const stalled = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked' },
    })
    stalled.on('error', () => {})
    stalled.write(PNG_1PX.subarray(0, 10))
    await new Promise((resolve) => setTimeout(resolve, 150))
    try {
      const competitor = await fetch(slot.uploadUrl, {
        method: 'PUT',
        body: PNG_1PX,
        // A regression that claims only after the body would leave this request
        // waiting for its own body; fail the case instead of hanging the suite.
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(competitor.status, 409, 'a claim in progress must already be visible to a second caller')
    } finally {
      stalled.destroy()
    }
  })
} finally {
  await h.close()
}

for (const name of checks) process.stdout.write('ok - ' + name + '\n')
process.stdout.write('\n' + checks.length + ' file-upload checks passed\n')
