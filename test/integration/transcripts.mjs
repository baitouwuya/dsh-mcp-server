#!/usr/bin/env node
/**
 * Transcript and discovery integration checks: outline/tail/window reads,
 * truncation, forward paging, role filters, the compact session index, title and
 * message search, tool filtering, and the response budget.
 *
 * Run: node test/integration/transcripts.mjs
 */

import assert from 'node:assert/strict'

import { createPluginHarness, PROMPT } from '../helpers/plugin-harness.mjs'

const h = await createPluginHarness({ label: 'transcripts' })
const { seedMessages, addSyntheticSessions, currentId } = h
const { call, check } = h
const codex = { headers: { 'x-dsh-mcp-client': 'codex' } }

try {
  const created = await call('dsh_run_prompt', { prompt: PROMPT, cwd: '/tmp' }, codex)

  // --- progressive disclosure -------------------------------------------------
  seedMessages([
    { role: 'user', text: 'questions-1: start the survey' },
    { role: 'assistant', text: 'questions-2: reading the asset pipeline first' },
    { role: 'user', text: 'questions-3: also check the weapon mount' },
    { role: 'assistant', text: 'questions-4: ' + 'y'.repeat(3000) },
    { role: 'user', text: 'questions-5: needle-marker lives in this message' },
    { role: 'assistant', text: 'questions-6: needle-marker follow-up' },
    { role: 'user', text: 'questions-7: continue' },
    { role: 'assistant', text: 'questions-8: continuing' },
    { role: 'user', text: 'questions-9: continue' },
    { role: 'assistant', text: 'questions-10: continuing' },
    { role: 'user', text: 'questions-11: continue' },
    { role: 'assistant', text: 'questions-12: done' },
  ])

  const outline = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 50 }, codex)
  await check('an outline read is a compact table of contents, not a transcript dump', () => {
    assert.equal(outline.mode, 'outline')
    assert.equal(outline.messages.length, outline.matchedMessages)
    assert.ok(outline.messages.every((row) => row.text === undefined && typeof row.preview === 'string' && Number.isInteger(row.chars)))
    assert.ok(outline.messages.some((row) => row.chars > 2000))
  })

  const tail = await call('dsh_read_session', { sessionId: created.sessionId }, codex)
  await check('a default read is a bounded tail window that reports what it left out', () => {
    assert.equal(tail.mode, 'tail')
    assert.equal(tail.returned, 10)
    assert.ok(tail.totalMessages > tail.returned)
    assert.equal(tail.window.reachedEnd, true)
    assert.ok(tail.window.firstSeq > outline.messages[0].seq)
  })

  // `limit: 0` keeps the old "everything" meaning, so this window definitely holds the long turn.
  const cut = await call('dsh_read_session', { sessionId: created.sessionId, limit: 0, maxChars: 100 }, codex)
  const trimmed = cut.messages.find((row) => row.truncated === true)
  await check('long messages are cut at maxChars and report their real length', () => {
    assert.ok(trimmed, 'a long message must be flagged when it is cut')
    assert.equal(trimmed.text.length, 100)
    assert.ok(trimmed.chars > 100)
    assert.ok(cut.truncatedMessages >= 1)
  })

  const pageOne = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'head', limit: 4 }, codex)
  const pageTwo = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'head', limit: 4, afterSeq: pageOne.window.nextAfterSeq }, codex)
  await check('afterSeq pages forward through a transcript without re-reading it', () => {
    assert.ok(pageTwo.messages.length > 0)
    assert.ok(pageTwo.messages.every((row) => row.seq > pageOne.window.nextAfterSeq))
    assert.ok(pageOne.messages.every((row) => row.seq <= pageOne.window.nextAfterSeq))
  })

  const userOnly = await call('dsh_read_session', { sessionId: created.sessionId, mode: 'outline', limit: 50, roles: ['user'] }, codex)
  await check('roles narrows a read to the turns the caller cares about', () => {
    assert.ok(userOnly.messages.every((row) => row.role === 'user'))
  })

  addSyntheticSessions([
    { sessionId: 'session-index-1', title: 'asset pipeline survey', cwd: '/repo/alpha', updatedAt: Date.now() - 1000 },
    { sessionId: 'session-index-2', title: 'weapon mount check', cwd: '/repo/beta', updatedAt: Date.now() - 2000 },
  ])

  const indexPage = await call('dsh_list_sessions', { limit: 1, view: 'index' }, codex)
  const secondPage = await call('dsh_list_sessions', { limit: 1, cursor: indexPage.nextCursor, view: 'full' }, codex)
  await check('the session index is compact by default and pages with a cursor', () => {
    assert.equal(indexPage.view, 'index')
    assert.equal(indexPage.count, 1)
    assert.equal('cwd' in indexPage.sessions[0], false)
    assert.ok(indexPage.total >= 3)
    assert.equal(indexPage.nextCursor, 1)
    assert.notEqual(secondPage.sessions[0].sessionId, indexPage.sessions[0].sessionId)
    assert.equal(secondPage.view, 'full')
    assert.equal(typeof secondPage.sessions[0].cwd, 'string')
  })

  const byQuery = await call('dsh_list_sessions', { query: 'weapon', view: 'index' }, codex)
  const byCwd = await call('dsh_list_sessions', { query: 'alpha' }, codex)
  await check('query narrows the index server-side by title and cwd', () => {
    assert.deepEqual(byQuery.sessions.map((row) => row.sessionId), ['session-index-2'])
    assert.deepEqual(byCwd.sessions.map((row) => row.sessionId), ['session-index-1'])
  })

  const titleHit = await call('dsh_search_sessions', { query: 'weapon', scope: 'title' }, codex)
  await check('a search matches sessions by title and returns a snippet', () => {
    assert.equal(titleHit.matchCount, 1)
    assert.equal(titleHit.matches[0].where, 'title')
    assert.equal(titleHit.matches[0].sessionId, 'session-index-2')
  })

  const messageHit = await call('dsh_search_sessions', { query: 'needle-marker', scope: 'messages' }, codex)
  await check('a search finds message text and returns a bounded snippet, not the transcript', () => {
    assert.ok(messageHit.matches.length >= 1)
    assert.ok(messageHit.matches.every((match) => match.where === 'message'))
    assert.ok(messageHit.matches[0].snippet.includes('needle-marker'))
    assert.ok(messageHit.matches[0].snippet.length <= 260)
    assert.ok(messageHit.scanned >= 1)
  })

  const toolQuery = await call('dsh_list_tools', { query: 'read' })
  await check('dsh_list_tools narrows the catalog by query', () => {
    assert.equal(toolQuery.count, 1)
    assert.equal(toolQuery.tools[0].name, 'read_file')
  })

  // A transcript read is bounded by a total response budget even when the caller
  // asks for everything.
  seedMessages(Array.from({ length: 3 }, () => ({ role: 'assistant', text: 'x'.repeat(200_000) })))
  const budgeted = await call('dsh_read_session', { sessionId: currentId(), limit: 0, maxChars: 0 })
  await check('a transcript read is capped by a total response budget', () => {
    assert.equal(budgeted.truncatedByBudget, true, 'a huge read stops at the response budget')
    assert.ok(budgeted.returned < budgeted.totalMessages, 'and returns fewer messages than the log holds')
  })

  h.finish()
} finally {
  await h.close()
}
