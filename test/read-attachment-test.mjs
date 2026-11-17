#!/usr/bin/env node
/**
 * Reading an image back out of a transcript as an MCP image block.
 *
 * Run: node test/read-attachment-test.mjs
 */
import assert from 'node:assert/strict'

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

const h = await createPluginHarness({ label: 'read-attachment', withAttachments: true })

try {
  const minted = await h.call('dsh_prepare_upload', { files: [{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }] })
  const [slot] = minted.uploads
  assert.equal((await fetch(slot.uploadUrl, { method: 'PUT', body: PNG_1PX })).status, 200)
  const prompt = await h.call('dsh_run_prompt', { prompt: 'what is this', fileIds: [slot.fileId], wait: false })
  const sessionId = prompt.sessionId

  const transcript = await h.call('dsh_read_session', { sessionId, mode: 'events', limit: 20, maxChars: 0 })
  const imageEvent = transcript.events.find((event) => JSON.stringify(event).includes('image'))
  assert.ok(imageEvent, 'the prompt recorded an image part')

  await check('one recorded image comes back as an MCP image block', async () => {
    const body = await h.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'dsh_read_attachment', arguments: { sessionId, seq: imageEvent.seq } },
    })
    const block = body.result.content.find((part) => part.type === 'image')
    assert.ok(block, 'the tool answered with an image block')
    assert.equal(block.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(block.data, 'base64'), PNG_1PX, 'the bytes round-trip unchanged')
  })

  await check('an event with no image says so instead of returning an empty block', async () => {
    const textEvent = transcript.events.find((event) => !JSON.stringify(event).includes('image'))
    await assert.rejects(
      () => h.call('dsh_read_attachment', { sessionId, seq: textEvent.seq }),
      /carries no image/,
    )
  })

  await check('an unknown sequence number is a caller error', async () => {
    let error
    try {
      await h.call('dsh_read_attachment', { sessionId, seq: 999_999 })
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, 'the call must not resolve')
    assert.match(error.message, /no event with seq/)
  })

  await check('another session\'s sequence number cannot reach this image', async () => {
    const other = await h.call('dsh_run_prompt', { prompt: 'unrelated', wait: false })
    // Sequence numbers restart at 1 per session, so this id exists in the other
    // session too — a reader that ignored the session id would hand back the
    // wrong image instead of refusing.
    let error
    try {
      await h.call('dsh_read_attachment', { sessionId: other.sessionId, seq: imageEvent.seq })
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, 'the call must not resolve')
    assert.match(error.message, /no event with seq|carries no image/, 'it refuses rather than answering from another session')
  })

  await check('an index past the last image is refused, not silently clamped', async () => {
    await assert.rejects(
      () => h.call('dsh_read_attachment', { sessionId, seq: imageEvent.seq, index: 5 }),
      /carries 1 image/,
    )
  })
} finally {
  await h.close()
}

for (const name of checks) process.stdout.write('ok - ' + name + '\n')
process.stdout.write('\n' + checks.length + ' read-attachment checks passed\n')
