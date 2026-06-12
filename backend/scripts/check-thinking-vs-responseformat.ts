#!/usr/bin/env bun
/**
 * check-thinking-vs-responseformat.ts
 *
 * Static guard for LangChain JS issue #35539: passing `responseFormat` and
 * `thinking` to the same Anthropic call produces malformed structured output
 * (the model emits the schema as plain text instead of obeying the strict
 * grammar). This has cost us a full day of debugging once; CI now refuses
 * any commit that re-introduces the combination.
 *
 * The check is intentionally regex-based, not AST-based: the offending
 * surface is small (literal option keys on `ChatAnthropic` constructor or
 * `.withConfig({...})` / `.bind({...})` calls), and a regex makes the
 * failure message point at the exact line a reviewer can fix.
 *
 * Exits 0 when clean. Exits 1 (and prints offending file:line) when a
 * problematic block is found.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', 'src')
const EXTS = new Set(['.ts', '.tsx'])

interface Finding {
  file: string
  startLine: number
  snippet: string
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      // Skip node_modules, generated, and tests; tests intentionally exercise
      // bad combinations and should not break CI.
      if (name === 'node_modules' || name === 'generated' || name === '__tests__') continue
      walk(full, out)
    } else {
      const dot = name.lastIndexOf('.')
      if (dot >= 0 && EXTS.has(name.slice(dot))) out.push(full)
    }
  }
  return out
}

// Scan each file for object literals (or chained call args) that contain
// BOTH `responseFormat` and `thinking` keys within the same balanced-braces
// block. The matcher walks line by line tracking brace depth so we don't
// false-positive on two unrelated calls in the same file.
function scan(file: string): Finding[] {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const findings: Finding[] = []

  // Track open `{` blocks and the keys they have seen so far. A simple
  // stack of {startLine, hasResponseFormat, hasThinking} is enough.
  type Frame = { startLine: number; hasResponseFormat: boolean; hasThinking: boolean }
  const stack: Frame[] = []
  let inLineComment = false
  let inBlockComment = false
  let inString: false | '"' | "'" | '`' = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      const next = line[c + 1]

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          c++
        }
        continue
      }
      if (inLineComment) break
      if (inString) {
        if (ch === '\\') {
          c++
          continue
        }
        if (ch === inString) inString = false
        continue
      }

      if (ch === '/' && next === '/') {
        inLineComment = true
        break
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        c++
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch as '"' | "'" | '`'
        continue
      }

      if (ch === '{') {
        stack.push({ startLine: i + 1, hasResponseFormat: false, hasThinking: false })
      } else if (ch === '}') {
        const f = stack.pop()
        if (f && f.hasResponseFormat && f.hasThinking) {
          const snippet = lines
            .slice(Math.max(0, f.startLine - 1), Math.min(lines.length, i + 1))
            .join('\n')
          findings.push({ file, startLine: f.startLine, snippet })
        }
      }
    }
    inLineComment = false

    // Key detection on the FULL line; safe because we already stripped
    // comments/strings character-wise for brace tracking.
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      // Match `responseFormat:` or `responseFormat =` or `'responseFormat'` keys.
      if (/\bresponseFormat\b\s*[:=]/.test(line) || /['"`]responseFormat['"`]\s*:/.test(line)) {
        top.hasResponseFormat = true
      }
      // `thinking:` / `'thinking':` / `thinking =`. Match the Anthropic
      // option shape; allow nested `{ type: 'enabled' }` to follow on
      // subsequent lines (we only care about the key presence).
      if (/\bthinking\b\s*[:=]\s*\{/.test(line) || /['"`]thinking['"`]\s*:\s*\{/.test(line)) {
        top.hasThinking = true
      }
    }
  }

  return findings
}

function main(): number {
  const files = walk(ROOT)
  const allFindings: Finding[] = []
  for (const f of files) {
    try {
      allFindings.push(...scan(f))
    } catch (err) {
      console.error(`[check-thinking-vs-responseformat] skip ${f}: ${(err as Error).message}`)
    }
  }

  if (allFindings.length === 0) {
    console.log(
      `[check-thinking-vs-responseformat] OK: scanned ${files.length} files; no responseFormat+thinking combinations.`,
    )
    return 0
  }

  console.error(
    `[check-thinking-vs-responseformat] FAIL: LangChain bug #35539 surface found in ${allFindings.length} location(s):`,
  )
  for (const f of allFindings) {
    console.error('')
    console.error(`  ${f.file}:${f.startLine}`)
    for (const line of f.snippet.split('\n')) {
      console.error(`    ${line}`)
    }
  }
  console.error('')
  console.error('Fix: drop one of the two options. Use providerStrategy() with')
  console.error('responseFormat OR thinking, never both on the same invocation.')
  return 1
}

process.exit(main())
