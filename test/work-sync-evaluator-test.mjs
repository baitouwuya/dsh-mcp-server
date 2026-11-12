import assert from 'node:assert/strict'
import { evaluateWorkSync } from '../lib/work-sync-evaluator.js'

const peer = {
  snapshotEvents: () => [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Edit src/a.js' }] } },
    { type: 'user/message', data: { source: { kind: 'dsh-work-sync' }, content: [{ type: 'text', text: 'sync notice' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on src/a.js' }] } } },
  ],
}
const calls = []
let answer = '{"peers":["peer-a","outside","peer-a"]}'
const ctx = {
  get: (name) => name === 'sessions' ? { get: () => peer } : {
    prepareCall: async (config, _signal, configure) => {
      const controls = configure({ maxTokens: config.maxTokens }, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
      return { config: { ...config, ...controls }, stream: async function* (options) {
        calls.push(options)
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
  },
}
const request = {
  ctx,
  session: { id: 'asker', snapshotEvents: () => [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The current task is editing src/a.js' }] } } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] } },
  ] },
  route: { provider: 'provider', model: 'model' },
  task: 'Edit src/a.js',
  peers: ['peer-a', 'peer-b'],
  signal: new AbortController().signal,
}
assert.deepEqual(await evaluateWorkSync(request), ['peer-a'], 'only distinct candidate IDs are accepted')
assert.equal(calls[0].provider, 'provider')
assert.equal(calls[0].model, 'model')
assert.equal(calls[0].reasoningEffort, 'off', 'the evaluator uses the route\'s lowest supported effort')
assert.equal(calls[0].tools, undefined, 'the separate evaluator receives no tools')
const input = JSON.parse(calls[0].messages[0].content[0].text)
assert.equal(input.task, request.task)
assert.equal(input.recent[0].text, 'The current task is editing src/a.js', 'the evaluator can interpret short follow-up tasks')
assert.deepEqual(input.peers[0].recent.map((item) => item.text), ['Edit src/a.js', 'Working on src/a.js'])
answer = '{"peers":[]}'
assert.deepEqual(await evaluateWorkSync(request), [], 'the model can decline coordination')
answer = 'not JSON'
await assert.rejects(evaluateWorkSync(request), SyntaxError)
console.log('4 work-sync evaluator checks passed')
