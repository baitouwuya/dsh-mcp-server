#!/usr/bin/env node
/**
 * `withDeadline` is the one place this plugin bounds a wait.
 *
 * It exists because the same twenty lines were wrong three times in a row: a
 * timeout that fires but does not settle the promise (hangs every caller), a
 * timer that keeps running after the work landed (narrows a healthy deployment),
 * and a late answer that overwrites whatever replaced it. Each of those is a
 * behaviour this file pins.
 *
 * Run: node test/deadline-test.mjs
 */

import assert from 'node:assert/strict'

import { withDeadline } from '../lib/deadline.js'

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

await check('a promise that lands first settles, and reports that it did', async () => {
  const result = await withDeadline(Promise.resolve('done'), 50)
  assert.equal(result.timedOut, false)
  assert.equal(result.value, 'done')
})

await check('a promise that never lands is settled by the deadline', async () => {
  // The defect this pins: a timeout that only flips a flag leaves every `await`
  // on the promise hanging forever.
  const started = Date.now()
  const result = await withDeadline(new Promise(() => {}), 30)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 500, 'the deadline is what settles it')
})

await check('the deadline timer is cleared once the promise lands', async () => {
  // The defect this pins: a timer left armed fires against a healthy deployment
  // and re-narrows it after the work has long finished.
  let fired = false
  const result = await withDeadline(Promise.resolve('done'), 20, { onTimeout: () => { fired = true } })
  assert.equal(result.timedOut, false)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(fired, false, 'a settled wait must not fire its deadline later')
})

await check('an answer that arrives after the deadline is reported as late, not adopted', async () => {
  let release
  const slow = new Promise((resolve) => { release = resolve })
  const result = await withDeadline(slow, 20)
  assert.equal(result.timedOut, true)
  release('too late')
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The caller decides what a late value means; the helper must not change its mind.
  assert.equal(result.value, undefined)
})

await check('a rejection before the deadline surfaces as a rejection', async () => {
  await assert.rejects(() => withDeadline(Promise.reject(new Error('boom')), 50), /boom/)
})

await check('a rejection after the deadline does not become an unhandled rejection', async () => {
  let fail
  const slow = new Promise((resolve, reject) => { fail = reject })
  const result = await withDeadline(slow, 20)
  assert.equal(result.timedOut, true)
  fail(new Error('late boom'))
  // Without a catch on the loser this would surface as an unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

console.log(`\n${passed} deadline checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
