#!/usr/bin/env node
/**
 * The lock is the only thing standing between two writers and a lost update, and
 * three separate rounds of review found it broken in a different way each time:
 *
 * 1. it reclaimed "stale" locks by age alone, so a slow-but-alive holder was
 *    robbed, and the victim's release then deleted the thief's lock — a third
 *    writer walked straight in while the second was still working;
 * 2. it waited less than the slowest legitimate hold, so ordinary concurrency
 *    turned into a 500;
 * 3. a failed unlink of a stale lock looped without ever re-checking the
 *    deadline, so one wedged lock hung every later save.
 *
 * Run: node test/tool-scope-lock-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

import { createFileStore } from '../lib/tool-scope.js'

let passed = 0
const failures = []
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL - ${name}\n  ${error.message}`)
  }
}

const base = `/tmp/scope-lock-test-${randomUUID()}`
await mkdir(base, { recursive: true })
let seq = 0
function freshStore() {
  seq += 1
  return createFileStore(`${base}/doc-${seq}.json`)
}
const lockOf = (store) => `${store.path}.lock`

await check('two writers never overlap', async () => {
  const store = freshStore()
  const events = []
  const slow = store.withLock(async () => {
    events.push('A in')
    await new Promise((resolve) => setTimeout(resolve, 120))
    events.push('A out')
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const quick = store.withLock(async () => {
    events.push('B in')
    events.push('B out')
  })
  await Promise.all([slow, quick])
  assert.deepEqual(events, ['A in', 'A out', 'B in', 'B out'])
})

await check('a lock left behind by a dead process is reclaimed', async () => {
  const store = freshStore()
  await mkdir(base, { recursive: true })
  await writeFile(lockOf(store), JSON.stringify({ token: 'dead', pid: 1 }), { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(lockOf(store), old, old)

  let entered = false
  await store.withLock(async () => { entered = true })
  assert.equal(entered, true)
})

await check('a slow but living holder keeps its lock', async () => {
  // The defect: reclaiming by age alone robs a holder that is merely slow, and the
  // robbed holder's release then deletes the thief's lock.
  const store = freshStore()
  const events = []
  const holder = store.withLock(async () => {
    events.push('holder in')
    await new Promise((resolve) => setTimeout(resolve, 300))
    events.push('holder out')
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const waiter = store.withLock(async () => { events.push('waiter in') })
  await Promise.all([holder, waiter])
  assert.deepEqual(events, ['holder in', 'holder out', 'waiter in'])
})

await check('releasing never deletes a lock this writer does not own', async () => {
  // The defect: `finally` unlinked the path unconditionally. Once anyone steals the
  // lock, the original holder's release removes the *thief's* lock, letting a third
  // writer in while the thief is still inside.
  const store = freshStore()
  let release
  const held = new Promise((resolve) => { release = resolve })
  const first = store.withLock(async () => { await held })
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Someone else takes the path over, exactly as a steal would.
  await writeFile(lockOf(store), JSON.stringify({ token: 'someone-else', pid: 2 }), { mode: 0o600 })

  release()
  await first

  const stillThere = await stat(lockOf(store)).then(() => true, () => false)
  assert.equal(stillThere, true, 'the other writer still owns the lock')
  const owner = JSON.parse(await readFile(lockOf(store), 'utf8'))
  assert.equal(owner.token, 'someone-else')
})

await check('waiting outlasts the slowest legitimate hold', async () => {
  // The defect: a 2s wait against a critical section that can legally run ~4s, so a
  // perfectly normal concurrent save failed with a 500.
  const store = freshStore()
  const holder = store.withLock(async () => { await new Promise((resolve) => setTimeout(resolve, 2600)) })
  await new Promise((resolve) => setTimeout(resolve, 20))
  let entered = false
  const waiter = store.withLock(async () => { entered = true })
  await Promise.all([holder, waiter])
  assert.equal(entered, true)
})

await check('a lock that cannot be reclaimed gives up instead of spinning', async () => {
  // The defect: when the stale lock could not be removed the loop `continue`d before
  // ever re-checking the deadline, so one wedged lock hung every later save forever.
  const store = freshStore()
  // A live owner: this process. Nothing but the deadline can end the wait.
  await writeFile(lockOf(store), JSON.stringify({ token: 'wedged', pid: process.pid }), { mode: 0o600 })
  const started = Date.now()
  const error = await store.withLock(async () => 'entered').then(
    () => undefined,
    (failure) => failure,
  )
  assert.ok(error, 'it must not enter while another writer holds the lock')
  assert.equal(error.name, 'ScopeError')
  assert.equal(error.code, 'scope-lock-timeout')
  assert.ok(Date.now() - started < 12_000, 'it must respect the wait budget')
})

await check('a lock whose owner is gone is reclaimed at once, not after the stale window', async () => {
  // Waiting out a 30s stale window for a process that is already dead costs every
  // save in between a failure, for nothing.
  const store = freshStore()
  const dead = 999_999
  await writeFile(lockOf(store), JSON.stringify({ token: 'dead', pid: dead, host: os.hostname() }), { mode: 0o600 })
  // Past the probe floor, but far below the 30s stale window.
  const recent = new Date(Date.now() - 1500)
  await utimes(lockOf(store), recent, recent)
  const started = Date.now()
  let entered = false
  await store.withLock(async () => { entered = true })
  assert.equal(entered, true)
  assert.ok(Date.now() - started < 1000, 'a dead owner is not waited out')
})

await check('a lock written by another machine is never reclaimed on pid evidence', async () => {
  // A pid only means something on the machine that wrote it: another host's live
  // lock would answer ESRCH here, and reclaiming it would break mutual exclusion.
  const store = freshStore()
  await writeFile(lockOf(store), JSON.stringify({ token: 'other', pid: 999_999, host: 'some-other-host' }), { mode: 0o600 })
  const recent = new Date(Date.now() - 1500)
  await utimes(lockOf(store), recent, recent)
  const started = Date.now()
  const error = await store.withLock(async () => 'entered').then(() => undefined, (failure) => failure)
  assert.equal(error?.code, 'scope-lock-timeout', 'it must wait, not steal')
  assert.ok(Date.now() - started > 1000)
})

await check('a lock from a process that died just now is reclaimed without the full window', async () => {
  // The most common crash is dying the instant after taking the lock. Waiting out the
  // 30s stale window for that turns a one-line crash into half a minute of failures.
  const store = freshStore()
  await writeFile(lockOf(store), JSON.stringify({ token: 'just-died', pid: 999_999, host: os.hostname() }), { mode: 0o600 })
  const started = Date.now()
  let entered = false
  await store.withLock(async () => { entered = true })
  assert.equal(entered, true)
  assert.ok(Date.now() - started < 3000, 'a dead local owner is found within a probe or two')
})

console.log(`\n${passed} lock checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
