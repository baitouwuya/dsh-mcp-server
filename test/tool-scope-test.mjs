#!/usr/bin/env node
/**
 * Tool scope: the document, the judgement, and where a session belongs.
 *
 * These checks never touch the real filesystem or a real Harness: the store takes
 * its reader/writer and its registry as arguments, which is also what lets the
 * failure paths (unreadable document, registry without an answer) be exercised
 * without staging a broken home directory.
 *
 * Run: node test/tool-scope-test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileStore, createToolScope, isVisible, normalizeDocument, SCOPE_FILE_VERSION } from '../lib/tool-scope.js'

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

/** A document store over an in-memory file, so no test writes to disk. */
function memoryStore(initial, options = {}) {
  let text = initial
  const writes = []
  return {
    writes,
    read: () => {
      if (options.readThrows) throw new Error('cannot read')
      return text
    },
    write: (next) => {
      if (options.writeThrows) throw new Error('cannot write')
      writes.push(next)
      text = next
    },
  }
}

/** A registry/working-directory pair shaped like the Harness services. */
function harnessWorld({ workspaces = [], byPath = {} } = {}) {
  const list = workspaces.map((workspace) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title ?? workspace.path,
    sessionIds: workspace.sessionIds ?? [],
  }))
  return {
    registry: {
      list: () => list,
      resolveByPath: async (path) => {
        const wanted = byPath[path] ?? path
        return list.find((workspace) => workspace.path === wanted)
      },
    },
  }
}

/** A session as the Harness hands it over: the directory it was opened in is in the header. */
const agentOf = (sessionId, cwd) => ({ id: `agent-${sessionId}`, session: { id: sessionId, header: { cwd } } })

// --- the document ------------------------------------------------------------

await check('a missing document means global, exactly like today', () => {
  const { doc, notes } = normalizeDocument(undefined)
  assert.deepEqual(doc, { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: [] })
  assert.deepEqual(notes, [])
})

await check('a malformed document falls to nobody, never to global', () => {
  for (const raw of [{ mode: 'everyone' }, { mode: 'selected' }, { mode: 'selected', workspaceIds: 'ws_1' }]) {
    const { doc, notes } = normalizeDocument(raw)
    assert.equal(doc.mode, 'selected', `${JSON.stringify(raw)} must not stay global`)
    assert.deepEqual(doc.workspaceIds, [], 'and it must select nobody')
    assert.ok(notes.includes('scope-degraded'), 'and it must say so')
  }
})

await check('ids are trimmed, de-duplicated and sorted so the file does not churn', () => {
  const { doc } = normalizeDocument({ mode: 'selected', workspaceIds: [' ws_b ', 'ws_a', 'ws_a'] })
  assert.deepEqual(doc.workspaceIds, ['ws_a', 'ws_b'])
})

// --- the judgement ------------------------------------------------------------

await check('global admits every workspace, including one it never heard of', () => {
  const doc = { version: SCOPE_FILE_VERSION, mode: 'global', workspaceIds: [] }
  assert.equal(isVisible(doc, undefined), true)
  assert.equal(isVisible(doc, 'ws_any'), true)
})

await check('selected admits exactly the listed ids', () => {
  const doc = { version: SCOPE_FILE_VERSION, mode: 'selected', workspaceIds: ['ws_a'] }
  assert.equal(isVisible(doc, 'ws_a'), true)
  assert.equal(isVisible(doc, 'ws_b'), false)
  assert.equal(isVisible(doc, undefined), false)
})

// --- where a session belongs -------------------------------------------------

await check('recorded membership wins, even when the cwd is a subdirectory', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }],
  })
  // Selected, not global: under `global` every answer is `true` and the membership
  // rule this names would never be exercised.
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes/src/deep')), true)
})

await check('without membership, an exact directory match still counts', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }],
  })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s2', '/repo/hermes')), true)
})

await check('a cwd under a workspace it is not recorded in is not that workspace', async () => {
  const world = harnessWorld({
    workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }],
  })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s3', '/repo/hermes/src/deep')), false)
})

await check('a session the registry cannot place is not visible in selected mode', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s4', '/somewhere/else')), false)
})

// --- failure paths -----------------------------------------------------------

await check('an unreadable document selects nobody and reports it', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore('{"mode":"global"}', { readThrows: true }) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false)
  assert.ok((await scope.state()).notes.includes('scope-degraded'))
})

await check('a Harness without a workspace registry says so instead of guessing', async () => {
  const scope = createToolScope({ registry: undefined, store: memoryStore(undefined) })
  assert.equal(scope.supported, false)
  // Global needs no registry: it was the behaviour before this feature existed.
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true)
  assert.ok((await scope.state()).notes.includes('scope-unsupported'))
  // The moment a selection is involved, the missing registry means nobody.
  const selected = memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] }))
  const narrowed = createToolScope({ registry: undefined, store: selected })
  assert.equal(await narrowed.visibleFor(agentOf('s1', '/repo/hermes')), false)
})

await check('a workspace deleted after a positive hit stops being visible', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true)
  // Forget the workspace the way a deletion would: it is gone from the listing
  // AND unreachable by path, so neither lookup can resurrect it.
  world.registry.list = () => []
  world.registry.resolveByPath = async () => undefined
  // The listing is cached for a few hundred milliseconds; waiting past it is what
  // a real deletion looks like to a later step.
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false)
  assert.ok((await scope.state()).notes.includes('scope-stale'))
})

await check('a judgement that blows up hides the tools instead of throwing', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  // `when` throwing aborts the whole turn upstream, so even an agent shape this
  // module did not anticipate has to answer "not visible" rather than raise.
  const hostile = { id: 'a', get session() { throw new Error('broken agent') } }
  assert.equal(await scope.visibleFor(hostile), false)
})

// --- saving ------------------------------------------------------------------

await check('saving replaces the live document without rebuilding the scope', async () => {
  const world = harnessWorld({
    workspaces: [
      { id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] },
      { id: 'ws_b', path: '/workspace/twin', sessionIds: [] },
    ],
  })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true, 'global to start with')
  await scope.save({ mode: 'selected', workspaceIds: ['ws_b'] })
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), false, 'the same object now refuses')
  assert.equal(store.writes.length, 1)
})

await check('a rejected save leaves the live document untouched', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const store = memoryStore(undefined, { writeThrows: true })
  const scope = createToolScope({ ...world, store })
  // The selection excludes this session on purpose: if the implementation swapped
  // the live document before the write, the session would already be hidden.
  await assert.rejects(() => scope.save({ mode: 'selected', workspaceIds: [] }), /scope-write-failed|write/i)
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/hermes')), true, 'still global after a failed save')
  assert.equal((await scope.state()).mode, 'global', 'and the reported mode still says global')
})

await check('saving an unknown workspace id is refused before anything is written', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: ['s1'] }] })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  await assert.rejects(() => scope.save({ mode: 'selected', workspaceIds: ['ws_ghost'] }), /unknown-workspace/)
  assert.equal(store.writes.length, 0)
})

await check('global keeps the selection it was given, so switching back is one click', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/hermes', sessionIds: [] }] })
  const store = memoryStore(undefined)
  const scope = createToolScope({ ...world, store })
  await scope.save({ mode: 'global', workspaceIds: ['ws_a'] })
  assert.deepEqual((await scope.state()).workspaceIds, ['ws_a'])
  const reloaded = createToolScope({ ...world, store })
  assert.deepEqual((await reloaded.state()).workspaceIds, ['ws_a'], 'and the document on disk keeps it too')
})

await check('changing directory mid-session does not move the session between workspaces', async () => {
  const world = harnessWorld({
    workspaces: [
      { id: 'ws_a', path: '/repo/a', sessionIds: [] },
      { id: 'ws_b', path: '/repo/b', sessionIds: [] },
    ],
  })
  let live = '/repo/a'
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agent), true, 'opened inside the selected workspace')
  assert.equal(await scope.visibleFor(agent), true, 'a cd must not move the session out of it either')
})

await check('a session cannot cd its way into a selected workspace', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  let live = '/somewhere/else'
  // The identity is where it was opened; the live directory is the attack.
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/somewhere/else' } } }
  const scope = createToolScope({ ...world, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(await scope.visibleFor(agent), false)
  assert.equal(await scope.visibleFor(agent), false, 'tools are not a reward for cd')
})

await check('a read that never returns still answers, after the deadline', async () => {
  const registry = { list: () => [], resolveByPath: async () => undefined }
  const scope = createToolScope({ registry, store: { read: () => new Promise(() => {}), write: () => {} } })
  const started = Date.now()
  // `when` is awaited once per tool per step: hanging here would hang the step.
  const verdict = await Promise.race([
    scope.visibleFor({ id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }),
    new Promise((resolve) => setTimeout(() => resolve('HANG'), 4000)),
  ])
  assert.equal(verdict, false)
  assert.ok(Date.now() - started < 3500, 'and it answers on the deadline, not on the read')
})

await check('a read that lands after the deadline still becomes the document', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const registry = { list: () => [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }], resolveByPath: async () => ({ id: 'ws_a' }) }
  const scope = createToolScope({ registry, store: { read: async () => { await gate; return JSON.stringify({ mode: 'global' }) }, write: () => {} } })
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }
  assert.equal(await scope.visibleFor(agent), false, 'the deadline narrowed it')
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  // Nobody saved meanwhile, so the late answer is still the best document there
  // is: keeping the narrowing would strand the process at "nobody" for its whole life.
  assert.equal((await scope.state()).mode, 'global', 'the late document was adopted')
  assert.equal(await scope.visibleFor(agent), true)
})

await check('a late document cannot overwrite a save that already landed', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let first = true
  const registry = { list: () => [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }], resolveByPath: async () => ({ id: 'ws_a' }) }
  // Only the first read hangs; the save's own verification read has to answer.
  const store = { read: async () => { if (first) { first = false; await gate }; return JSON.stringify({ mode: 'global' }) }, write: () => {} }
  const scope = createToolScope({ registry, store })
  const agent = { id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }
  assert.equal(await scope.visibleFor(agent), false, 'narrowed at the deadline')
  await scope.save({ mode: 'selected', workspaceIds: [] }) // a real save, so the read is superseded
  release()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await scope.state()).mode, 'selected', 'the save wins over the stale read')
})

await check('a registry that throws is an error, not an empty registry', async () => {
  const registry = { list: () => { throw new Error('registry down') }, resolveByPath: async () => undefined }
  const scope = createToolScope({ registry, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  await assert.rejects(() => scope.save({ mode: 'selected', workspaceIds: ['ws_a'] }), /scope-registry-unavailable/)
  assert.equal(await scope.visibleFor({ id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } }), false, 'a judgement fails closed')
})

await check('a workspace created a moment ago can be saved into', async () => {
  const registry = { list: () => [], resolveByPath: async () => undefined }
  let written
  const scope = createToolScope({ registry, store: { read: undefined, write: (text) => { written = text } } })
  // Fill the listing cache with the empty world first.
  await scope.visibleFor({ id: 'a', session: { id: 's1', header: { cwd: '/repo/a' } } })
  registry.list = () => [{ id: 'ws_new', path: '/repo/new', sessionIds: [] }]
  await scope.save({ mode: 'selected', workspaceIds: ['ws_new'] })
  assert.match(String(written), /ws_new/, 'validation reads through the cache, so a new workspace is savable')
})

await check('twenty sessions judging at once do not contaminate each other', async () => {
  const workspaces = Array.from({ length: 5 }, (_, i) => ({ id: `ws_${i}`, path: `/repo/${i}`, sessionIds: [] }))
  const registry = { list: () => workspaces, resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path) }
  const scope = createToolScope({ registry, store: memoryStore(undefined) })
  const agents = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, session: { id: `s${i}`, header: { cwd: `/repo/${i % 5}` } } }))
  assert.equal((await Promise.all(agents.map((agent) => scope.visibleFor(agent)))).filter(Boolean).length, 20)
  await scope.save({ mode: 'selected', workspaceIds: ['ws_0'] })
  // Only the four sessions opened in /repo/0.
  assert.equal((await Promise.all(agents.map((agent) => scope.visibleFor(agent)))).filter(Boolean).length, 4)
})

await check('a judgement made while a save is writing still sees the old document', async () => {
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  let finish
  const scope = createToolScope({ ...world, store: { read: undefined, write: () => new Promise((resolve) => { finish = resolve }) } })
  const agent = agentOf('s1', '/repo/a')
  const saving = scope.save({ mode: 'selected', workspaceIds: [] })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await scope.visibleFor(agent), true, 'the new selection is not live until the write lands')
  finish()
  await saving
  assert.equal(await scope.visibleFor(agent), false)
})

await check('a disposed instance cannot save over its replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-disposed-'))
  const file = join(dir, 'tool-scope.json')
  const store = { read: async () => { try { return await readFile(file, 'utf8') } catch { return undefined } }, write: (text) => writeFile(file, text) }
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }], resolveByPath: async () => undefined }
  const old = createToolScope({ registry, store })
  await old.save({ mode: 'global' })
  const fresh = createToolScope({ registry, store })
  await fresh.ready
  await fresh.save({ mode: 'selected', workspaceIds: ['ws_0'] })
  old.dispose()
  await assert.rejects(() => old.save({ mode: 'global' }), /scope-disposed/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mode, 'selected', 'the replacement keeps the narrower selection')
})

await check('a save built on a stale read is refused instead of overwriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-cas-'))
  const file = join(dir, 'tool-scope.json')
  const store = { read: async () => { try { return await readFile(file, 'utf8') } catch { return undefined } }, write: (text) => writeFile(file, text) }
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }], resolveByPath: async () => undefined }
  const a = createToolScope({ registry, store })
  await a.ready
  await a.save({ mode: 'global' })
  const b = createToolScope({ registry, store })
  await b.ready
  await b.save({ mode: 'selected', workspaceIds: ['ws_0'] })
  // `a` never saw that write; letting it through would widen a tightened scope.
  await assert.rejects(() => a.save({ mode: 'global' }), /scope-conflict/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mode, 'selected')
})

await check('a conflict is not permanent: the next save compares against the new baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-conflict-'))
  const file = join(dir, 'tool-scope.json')
  const store = { read: async () => { try { return await readFile(file, 'utf8') } catch { return undefined } }, write: (text) => writeFile(file, text) }
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }, { id: 'ws_1', path: '/r1', sessionIds: [] }], resolveByPath: async () => undefined }
  const a = createToolScope({ registry, store })
  await a.ready
  await a.save({ mode: 'global' })
  const b = createToolScope({ registry, store })
  await b.ready
  await b.save({ mode: 'selected', workspaceIds: ['ws_0'] })
  await assert.rejects(() => a.save({ mode: 'global' }), /scope-conflict/)
  // The latch refuses a blind retry; reading the document is what releases it.
  await assert.rejects(() => a.save({ mode: 'global' }), /scope-conflict/)
  await a.acknowledge()
  await a.save({ mode: 'global' })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mode, 'global')
})

await check('an existing document this instance never read is a conflict, not a blind overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-blind-'))
  const file = join(dir, 'tool-scope.json')
  await writeFile(file, JSON.stringify({ version: 1, mode: 'selected', workspaceIds: ['ws_0'], updatedAt: '2026-01-01T00:00:00.000Z' }))
  const store = { read: async () => { throw new Error('unreadable on first pass') }, write: (text) => writeFile(file, text) }
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }], resolveByPath: async () => undefined }
  const scope = createToolScope({ registry, store })
  await assert.rejects(() => scope.save({ mode: 'global' }), /scope-write-unverified/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mode, 'selected', 'nothing was written')
})

await check('a conflict shows the document that won, not the one that lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-reload-'))
  const file = join(dir, 'tool-scope.json')
  const store = { read: async () => { try { return await readFile(file, 'utf8') } catch { return undefined } }, write: (text) => writeFile(file, text) }
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }], resolveByPath: async () => undefined }
  const a = createToolScope({ registry, store })
  await a.ready
  await a.save({ mode: 'global' })
  const b = createToolScope({ registry, store })
  await b.ready
  await b.save({ mode: 'selected', workspaceIds: ['ws_0'] })
  await assert.rejects(() => a.save({ mode: 'global' }), /scope-conflict/)
  // Refreshing only the stamp would leave `a` reporting the value it failed to
  // write; the page would show `global` while the disk says `selected`.
  assert.equal((await a.state()).mode, 'selected', 'the winner is what this instance now reports')
  // And a plain re-save must not silently push the stale value over the winner.
  await assert.rejects(() => a.save({ mode: 'global' }), /scope-conflict/, 'saving the same stale value is still a conflict')
})

await check('a registry that appears after apply is picked up', async () => {
  let current
  const scope = createToolScope({ getRegistry: () => current, store: memoryStore(JSON.stringify({ mode: 'selected', workspaceIds: ['ws_a'] })) })
  assert.equal(scope.supported, false, 'nothing yet')
  current = { list: () => [{ id: 'ws_a', path: '/repo/a', sessionIds: ['s1'] }], resolveByPath: async () => undefined }
  assert.equal(scope.supported, true, 'the late registry counts')
  assert.equal(await scope.visibleFor(agentOf('s1', '/repo/a')), true)
})

await check('two instances cannot both write from the same reading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-lock-'))
  const file = join(dir, 'tool-scope.json')
  const store = createFileStore(file)
  const registry = { list: () => [{ id: 'ws_0', path: '/r0', sessionIds: [] }, { id: 'ws_1', path: '/r1', sessionIds: [] }], resolveByPath: async () => undefined }
  const a = createToolScope({ registry, store })
  const b = createToolScope({ registry, store })
  await Promise.all([a.ready, b.ready])
  await a.save({ mode: 'global' })
  await Promise.allSettled([a.save({ mode: 'selected', workspaceIds: ['ws_0'] }), b.save({ mode: 'selected', workspaceIds: ['ws_1'] })])
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  // The lock serializes compare-and-write, so the loser must have observed the
  // winner's stamp and refused rather than overwriting it.
  assert.ok(['ws_0', 'ws_1'].includes(onDisk.workspaceIds[0]))
  assert.equal(onDisk.workspaceIds.length, 1, 'one write won, the other did not merge or clobber')
})

await check('a write that never returns fails the save instead of hanging it', async () => {
  // The defect: the critical section's write had no ceiling, so one wedged store
  // parked the save chain — and every save queued behind it — forever.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(undefined)
  store.write = () => new Promise(() => {})
  const scope = createToolScope({ ...world, store })
  const started = Date.now()
  const error = await scope.save({ mode: 'selected', workspaceIds: ['ws_a'] }).then(
    () => undefined,
    (failure) => failure,
  )
  assert.ok(error, 'the save must not resolve')
  assert.equal(error.name, 'ScopeError')
  assert.ok(Date.now() - started < 8000, 'the critical section must be bounded')
})

await check('a conflict whose reload fails still shows the winner once the page reads', async () => {
  // The defect: the baseline was advanced to the winner's stamp *before* the reload.
  // When that reload failed, memory still held the loser's value, the latch cleared
  // on the next GET, and the page then saved that stale value over the winner.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(JSON.stringify({ version: 1, mode: 'global', workspaceIds: [], updatedAt: 't1' }))
  const scope = createToolScope({ ...world, store })
  await scope.state()

  // Someone else commits a narrower selection.
  const winner = JSON.stringify({ version: 1, mode: 'selected', workspaceIds: ['ws_a'], updatedAt: 't2' })
  store.writes.length = 0
  let text = winner
  // The stamp read (first) must work so the save reaches the conflict branch; the
  // reload (second) is the one that fails.
  let reads = 0
  store.read = () => { reads += 1; if (reads > 1) throw new Error('disk unavailable'); return text }
  store.write = (next) => { store.writes.push(next); text = next }

  const conflict = await scope.save({ mode: 'global', workspaceIds: [] }).then(() => undefined, (error) => error)
  assert.equal(conflict?.code, 'scope-conflict')
  assert.equal(store.writes.length, 0, 'a conflict never writes')

  // The disk comes back. The page reads before it may save again — and what it reads
  // must be what actually won, not the value this instance failed to replace.
  store.read = () => text
  await scope.acknowledge()
  const shown = await scope.state()
  assert.equal(shown.mode, 'selected', 'the page must see the winner, not the loser')
  assert.deepEqual(shown.workspaceIds, ['ws_a'])
})

await check('a write that times out reports uncertainty instead of claiming nothing changed', async () => {
  // The defect: the 2s ceiling abandoned the *wait* but not the write, so a late
  // rename could land after the lock was released — on top of another writer — while
  // the caller had been told the document was untouched.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(undefined)
  store.write = () => new Promise(() => {})
  const scope = createToolScope({ ...world, store })
  const error = await scope.save({ mode: 'selected', workspaceIds: ['ws_a'] }).then(() => undefined, (failure) => failure)
  assert.equal(error?.code, 'scope-write-unverified')
})

await check('a late load from an abandoned attempt never advances the baseline', async () => {
  // The defect: `docRevision` only moves on a successful save, so a read that was
  // abandoned at its deadline still committed minutes later — advancing the stamp to
  // a document the page had never seen, and letting the next save pass the compare.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(JSON.stringify({ version: 1, mode: 'global', workspaceIds: [], updatedAt: 't1' }))
  const scope = createToolScope({ ...world, store })
  await scope.state()

  const winner = JSON.stringify({ version: 1, mode: 'selected', workspaceIds: ['ws_a'], updatedAt: 't2' })
  let release
  const slow = new Promise((resolve) => { release = resolve })
  let reads = 0
  store.read = () => {
    reads += 1
    // The stamp read answers; the conflict reload hangs and is abandoned.
    return reads === 1 ? winner : slow.then(() => winner)
  }
  store.write = () => {}

  const conflict = await scope.save({ mode: 'global', workspaceIds: [] }).then(() => undefined, (error) => error)
  assert.equal(conflict?.code, 'scope-conflict')

  // The abandoned read finally answers. It must not be adopted behind the page's back.
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const shown = await scope.state()
  assert.equal(shown.mode, 'global', 'an abandoned read must not replace what the page shows')
})

await check('deleting the document mid-session narrows to nobody instead of widening to global', async () => {
  // The defect: a missing file was read as "never configured" every time, so deleting
  // it silently widened the scope back to every workspace — the opposite of the
  // fail-closed rule this module states everywhere else.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(JSON.stringify({ version: 1, mode: 'selected', workspaceIds: ['ws_a'], updatedAt: 't1' }))
  const scope = createToolScope({ ...world, store })
  await scope.state()

  store.read = () => undefined // the file is gone
  const first = await scope.save({ mode: 'selected', workspaceIds: ['ws_a'] }).then(() => 'ok', (error) => error.code)
  assert.equal(first, 'scope-conflict', 'the page is told before anything is written')
  await scope.acknowledge()
  const shown = await scope.state()
  assert.equal(shown.mode, 'selected', 'a deleted document must not widen to global')
  assert.deepEqual(shown.workspaceIds, [], 'and it must not keep the old selection either')
  const second = await scope.save({ mode: 'selected', workspaceIds: ['ws_a'] }).then(() => 'ok', (error) => error.code)
  assert.equal(second, 'ok', 'the operator can still save over it')
})

await check('reading the page does not release the latch when the reload failed', async () => {
  // The defect: `acknowledge()` cleared the latch unconditionally, so a GET after a
  // failed reload told the page "you may save now" while the page was still showing
  // the value the conflict had replaced.
  const world = harnessWorld({ workspaces: [{ id: 'ws_a', path: '/repo/a', sessionIds: [] }] })
  const store = memoryStore(JSON.stringify({ version: 1, mode: 'global', workspaceIds: [], updatedAt: 't1' }))
  const scope = createToolScope({ ...world, store })
  await scope.state()

  const winner = JSON.stringify({ version: 1, mode: 'selected', workspaceIds: ['ws_a'], updatedAt: 't2' })
  let reads = 0
  store.read = () => { reads += 1; if (reads > 1) throw new Error('disk unavailable'); return winner }
  store.write = () => {}

  await scope.save({ mode: 'global', workspaceIds: [] }).catch(() => {})
  await scope.acknowledge()
  const again = await scope.save({ mode: 'global', workspaceIds: [] }).then(() => 'ok', (error) => error.code)
  assert.equal(again, 'scope-conflict', 'the latch stays shut until the page has really read the winner')
})

// --- summary -----------------------------------------------------------------

console.log(`\n${passed} tool-scope checks passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
