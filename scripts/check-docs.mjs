#!/usr/bin/env node
/**
 * Documentation guard: checks that every relative link resolves and that the
 * Chinese docs stay structurally identical to their English originals.
 *
 *   node scripts/check-docs.mjs
 *
 * Exits non-zero on the first problem set, so CI fails instead of letting a
 * dead link or a dropped section ship.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const fail = (file, message) => problems.push(file + ': ' + message)

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file) => fs.existsSync(path.join(root, file))

const docFiles = ['README.md', 'README.en.md', 'docs/README.md']
for (const dir of ['docs/en', 'docs/zh']) {
  if (!exists(dir)) continue
  for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
    if (name.endsWith('.md')) docFiles.push(dir + '/' + name)
  }
}

const slug = (text) => text
  .replace(/\s+#+\s*$/, '')
  .trim()
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-')

const headings = (text) => [...text.matchAll(/^(#{1,6})\s+(.*)$/gm)]
  .map((m) => ({ level: m[1].length, slug: slug(m[2]) }))

const linkTargets = (text) => [...text.matchAll(/\]\(([^)]+)\)/g)]
  .map((m) => m[1].trim())
  .filter((target) => !/^(https?:|mailto:|#)/.test(target))

const tableShapes = (text) => {
  const shapes = []
  let block = null
  for (const line of text.split('\n')) {
    if (/^\|/.test(line)) {
      if (!block) { block = []; shapes.push(block) }
      block.push(line.split('|').length - 2)
    } else {
      block = null
    }
  }
  return shapes
}

const fenceCount = (text) => (text.match(/^```/gm) || []).length
const inlineCode = (text) => new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]))

// 1. Every relative link and every explicit anchor must resolve.
for (const file of docFiles) {
  const text = read(file)
  const dir = path.dirname(path.join(root, file))
  for (const target of linkTargets(text)) {
    const [rawPath, rawHash] = target.split('#')
    const targetPath = path.resolve(dir, decodeURI(rawPath))
    if (!fs.existsSync(targetPath)) {
      fail(file, 'broken link -> ' + target)
      continue
    }
    if (!rawHash || !targetPath.endsWith('.md')) continue
    const anchor = slug(decodeURIComponent(rawHash))
    const anchors = new Set(headings(fs.readFileSync(targetPath, 'utf8')).map((h) => h.slug))
    if (!anchors.has(anchor)) fail(file, 'missing anchor -> ' + target)
  }
}

// 2. The Chinese mirror must keep the English structure.
const enDir = 'docs/en'
const zhDir = 'docs/zh'
if (exists(enDir) && exists(zhDir)) {
  const enFiles = fs.readdirSync(path.join(root, enDir)).filter((f) => f.endsWith('.md')).sort()
  const zhFiles = fs.readdirSync(path.join(root, zhDir)).filter((f) => f.endsWith('.md')).sort()
  for (const name of enFiles) if (!zhFiles.includes(name)) fail(zhDir, 'missing ' + name)
  for (const name of zhFiles) if (!enFiles.includes(name)) fail(enDir, 'missing ' + name)
  for (const name of enFiles.filter((f) => zhFiles.includes(f))) {
    const en = read(enDir + '/' + name)
    const zh = read(zhDir + '/' + name)
    const enHeads = headings(en).map((h) => h.level).join(',')
    const zhHeads = headings(zh).map((h) => h.level).join(',')
    if (enHeads !== zhHeads) fail(zhDir + '/' + name, 'heading levels differ from en')
    if (fenceCount(en) !== fenceCount(zh)) fail(zhDir + '/' + name, 'code fences differ from en')
    const enTables = JSON.stringify(tableShapes(en))
    const zhTables = JSON.stringify(tableShapes(zh))
    if (enTables !== zhTables) fail(zhDir + '/' + name, 'table shapes differ from en')
    const zhCode = inlineCode(zh)
    const missing = [...inlineCode(en)].filter((span) => !zhCode.has(span) && !zh.includes(span))
    if (missing.length) fail(zhDir + '/' + name, 'inline code missing: ' + missing.join(', '))
    if (!/README\.md|README\.en\.md/.test(zh.split('\n').slice(0, 8).join(' '))) {
      fail(zhDir + '/' + name, 'missing breadcrumb in the first lines')
    }
  }
}

// 3. Both entry READMEs carry the switcher, the docs table and the version.
const pkg = JSON.parse(read('package.json'))
for (const [file, other] of [['README.md', 'README.en.md'], ['README.en.md', 'README.md']]) {
  if (!exists(file)) { fail(file, 'missing'); continue }
  const text = read(file)
  if (!text.includes(other)) fail(file, 'no language switcher to ' + other)
  for (const doc of docFiles.filter((f) => /^docs\/(en|zh)\//.test(f))) {
    const lang = file === 'README.md' ? 'docs/zh/' : 'docs/en/'
    if (doc.startsWith(lang) && !text.includes(doc)) fail(file, 'does not link ' + doc)
  }
  if (!text.includes(pkg.version)) fail(file, 'does not mention version ' + pkg.version)
}

if (problems.length) {
  console.error('docs check failed:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('docs check passed: ' + docFiles.length + ' files, links, anchors and zh/en parity OK')
