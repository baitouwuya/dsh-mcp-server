#!/usr/bin/env node
/**
 * Upload slot lifetime and attempt accounting.
 *
 * These cases need control over time, which the HTTP seam cannot offer, so they
 * drive the store directly. Everything observable through HTTP is covered in
 * `test/file-upload-test.mjs`.
 *
 * Run: node test/file-upload-store-test.mjs
 */
import assert from 'node:assert/strict'

import { createUploadStore } from '../lib/file-upload.js'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const checks = []
async function check(name, fn) {
  await fn()
  checks.push(name)
}

function makeStore(overrides = {}) {
  let clock = 1_000_000
  const saved = []
  const store = createUploadStore({
    attachments: {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImages(inputs) {
        return inputs.map((input) => {
          const ref = { id: 'att_' + (saved.length + 1), mediaType: input.mediaType }
          saved.push(ref)
          return ref
        })
      },
    },
    config: overrides,
    now: () => clock,
  })
  return { store, saved, advance: (ms) => { clock += ms } }
}

await check('a link stops accepting bytes once its window closes', async () => {
  const { store, advance } = makeStore({ uploadTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }], { origin: 'http://x' })
  advance(60_001)
  await assert.rejects(async () => store.begin(slot.uploadUrl.split('/').at(-1)), /expired/)
})

await check('three failed attempts burn the link', async () => {
  const { store } = makeStore({ uploadMaxAttempts: 3 })
  const [slot] = store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  const garbage = Buffer.from('not a png')
  const upload = async (bytes) => store.commit(store.begin(nonce), bytes)
  await assert.rejects(() => upload(garbage), /not image\/png/)
  await assert.rejects(() => upload(garbage), /not image\/png/)
  await assert.rejects(() => upload(garbage), /too many failed attempts/)
  await assert.rejects(async () => store.begin(nonce), /unknown or expired/, 'even a good upload cannot revive it')
})

await check('a declared digest that does not match is refused', async () => {
  const { store } = makeStore({ uploadRequireSha256: true })
  assert.throws(
    () => store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' }),
    /sha256 is required/,
  )
  const [slot] = store.mint([{ mediaType: 'image/png', sha256: 'a'.repeat(64) }], { origin: 'http://x' })
  await assert.rejects(
    async () => store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), PNG_1PX),
    /do not match the declared sha256/,
  )
})

await check('the stored reference stays usable until its own ttl, then reports unknown', async () => {
  const { store, advance } = makeStore({ fileIdTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }], { origin: 'http://x' })
  await store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), PNG_1PX)
  assert.equal(store.resolve(slot.fileId).state, 'stored')
  advance(60_001)
  assert.throws(() => store.resolve(slot.fileId), /unknown fileId/)
})

await check('an image whose declared dimensions exceed the ceiling is refused', async () => {
  const { store } = makeStore()
  const [slot] = store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' })
  const bomb = Buffer.from(PNG_1PX)
  bomb.writeUInt32BE(20_000, 16) // width
  bomb.writeUInt32BE(20_000, 20) // height
  await assert.rejects(
    async () => store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), bomb),
    /100 MP/,
  )
})


await check('minting is rate limited instead of unbounded', async () => {
  const { store } = makeStore({ uploadMaxFiles: 10 })
  for (let round = 0; round < 6; round += 1) {
    store.mint(Array.from({ length: 10 }, () => ({ mediaType: 'image/png', expectedBytes: 1024 })), { origin: 'http://x' })
  }
  assert.throws(
    () => store.mint([{ mediaType: 'image/png', expectedBytes: 1024 }], { origin: 'http://x' }),
    /too many upload sessions/,
    'the seventh mint inside a minute is refused',
  )
})

await check('repeated attempts on one link are rate limited', async () => {
  const { store } = makeStore({ uploadMaxAttempts: 10 })
  const [slot] = store.mint([{ mediaType: 'image/png' }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const claimed = store.begin(nonce)
    store.release(claimed)
  }
  assert.throws(() => store.begin(nonce), /too many upload attempts/)
})

await check('a claimed slot is reclaimed if the upload never finishes', async () => {
  const { store, advance } = makeStore({ uploadTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: 1024 }], { origin: 'http://x' })
  const claimed = store.begin(slot.uploadUrl.split('/').at(-1))
  assert.equal(claimed.state, 'consuming')
  advance(60_001 + 60_001) // past the deadline and past the grace period
  store.release(claimed)
  assert.throws(() => store.begin(slot.uploadUrl.split('/').at(-1)), /unknown or expired/)
})

await check('declared length that disagrees with the bytes counts as a failed attempt', async () => {
  const { store } = makeStore({ uploadMaxAttempts: 3 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: 1024 }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => store.commit(store.begin(nonce), PNG_1PX, { declaredBytes: PNG_1PX.length + 50 }),
      /content-length does not match/,
      'the refusal is attributed to the body, not the link',
    )
  }
  await assert.rejects(
    () => store.commit(store.begin(nonce), PNG_1PX, { declaredBytes: PNG_1PX.length + 50 }),
    /too many failed attempts/,
    'the third refusal burns the link',
  )
  await assert.rejects(async () => store.begin(nonce), /unknown or expired/, 'the budget ran out')
})

await check('a content-type probe burns the same attempt budget', async () => {
  const { store } = makeStore({ uploadMaxAttempts: 2 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: 1024 }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  assert.throws(() => store.begin(nonce, 'text/plain'), /minted for image\/png/)
  assert.throws(
    () => store.begin(nonce, 'text/plain'),
    /too many failed attempts/,
    'guessing types is not free',
  )
})

await check('an expired link answers exactly like a missing one', async () => {
  const { store, advance } = makeStore({ uploadTtlMs: 60_000 })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: 1024 }], { origin: 'http://x' })
  const nonce = slot.uploadUrl.split('/').at(-1)
  advance(61_000)
  const expired = (() => { try { store.begin(nonce) } catch (error) { return error.message } })()
  const missing = (() => { try { store.begin('not-a-real-nonce') } catch (error) { return error.message } })()
  assert.equal(expired, missing, 'the two cases are indistinguishable')
})

await check('file ids stay with the caller that minted them when restrictToOwner is on', async () => {
  const { store } = makeStore({ restrictToOwner: true })
  const [slot] = store.mint([{ mediaType: 'image/png', expectedBytes: PNG_1PX.length }], { origin: 'http://x', owner: 'client-a' })
  await store.commit(store.begin(slot.uploadUrl.split('/').at(-1)), PNG_1PX)
  assert.ok(store.resolve(slot.fileId, { owner: 'client-a' }))
  assert.throws(() => store.resolve(slot.fileId, { owner: 'client-b' }), /unknown fileId/)
  assert.throws(() => store.resolve(slot.fileId, {}), /unknown fileId/, 'an anonymous caller cannot reach a named upload')
})

await check('a full batch of undeclared images still mints', async () => {
  const { store } = makeStore({ uploadMaxFiles: 10 })
  const minted = store.mint(Array.from({ length: 10 }, () => ({ mediaType: 'image/png' })), { origin: 'http://x' })
  assert.equal(minted.length, 10, 'the per-mint cap counts declared sizes, not the default ceiling')
  assert.equal(minted[0].maxBytes, 20 * 1024 * 1024, 'each slot still allows the full per-file ceiling')
})

for (const name of checks) process.stdout.write('ok - ' + name + '\n')
process.stdout.write('\n' + checks.length + ' upload-store checks passed\n')
