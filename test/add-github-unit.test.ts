/**
 * Unit tests for the pure `parseGitHubSource` function exported from `src/add.ts`.
 *
 * These cover all source-string forms:
 *   owner/repo
 *   owner/repo/path/to/mask
 *   owner/repo@id
 *   owner/repo#ref@id
 *   owner/repo#ref
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/<ref>/path/to/mask
 *
 * And confirm that local-path forms (./…, /…, existing paths) return null.
 */
import { describe, expect, it } from 'vitest'
import { parseGitHubSource } from '../src/add.js'

describe('parseGitHubSource — owner/repo shorthand', () => {
  it('parses bare owner/repo', () => {
    const r = parseGitHubSource('owner/repo')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.cloneUrl).toBe('https://github.com/owner/repo.git')
    expect(r!.ref).toBeUndefined()
    expect(r!.subPath).toBeUndefined()
    expect(r!.personaId).toBeUndefined()
  })

  it('parses owner/repo/path/to/mask', () => {
    const r = parseGitHubSource('owner/repo/path/to/mask')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.subPath).toBe('path/to/mask')
    expect(r!.ref).toBeUndefined()
    expect(r!.personaId).toBeUndefined()
  })

  it('parses owner/repo@senpai-rust (persona id selector)', () => {
    const r = parseGitHubSource('owner/repo@senpai-rust')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.personaId).toBe('senpai-rust')
    expect(r!.ref).toBeUndefined()
    expect(r!.subPath).toBeUndefined()
  })

  it('parses owner/repo#main (ref only, no persona id)', () => {
    const r = parseGitHubSource('owner/repo#main')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.ref).toBe('main')
    expect(r!.personaId).toBeUndefined()
  })

  it('parses owner/repo#main@senpai-rust (ref + persona id)', () => {
    const r = parseGitHubSource('owner/repo#main@senpai-rust')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.ref).toBe('main')
    expect(r!.personaId).toBe('senpai-rust')
    expect(r!.subPath).toBeUndefined()
  })

  it('parses owner/repo#abc1234 (commit SHA as ref)', () => {
    const r = parseGitHubSource('owner/repo#abc1234567890abcdef')
    expect(r).not.toBeNull()
    expect(r!.ref).toBe('abc1234567890abcdef')
  })

  it('parses owner/repo/sub/path#ref@id together', () => {
    const r = parseGitHubSource('owner/repo/masks/senpai#main@senpai-rust')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.subPath).toBe('masks/senpai')
    expect(r!.ref).toBe('main')
    expect(r!.personaId).toBe('senpai-rust')
  })
})

describe('parseGitHubSource — full GitHub URL', () => {
  it('parses https://github.com/owner/repo', () => {
    const r = parseGitHubSource('https://github.com/owner/repo')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.cloneUrl).toBe('https://github.com/owner/repo.git')
    expect(r!.ref).toBeUndefined()
    expect(r!.subPath).toBeUndefined()
  })

  it('parses https://github.com/owner/repo.git', () => {
    const r = parseGitHubSource('https://github.com/owner/repo.git')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.cloneUrl).toBe('https://github.com/owner/repo.git')
  })

  it('parses https://github.com/owner/repo/tree/main/path/to/mask', () => {
    const r = parseGitHubSource('https://github.com/owner/repo/tree/main/path/to/mask')
    expect(r).not.toBeNull()
    expect(r!.source).toBe('owner/repo')
    expect(r!.ref).toBe('main')
    expect(r!.subPath).toBe('path/to/mask')
    expect(r!.cloneUrl).toBe('https://github.com/owner/repo.git')
  })

  it('parses https://github.com/owner/repo/tree/v1.2.3 (tag ref, no path)', () => {
    const r = parseGitHubSource('https://github.com/owner/repo/tree/v1.2.3')
    expect(r).not.toBeNull()
    expect(r!.ref).toBe('v1.2.3')
    expect(r!.subPath).toBeUndefined()
  })
})

describe('parseGitHubSource — local paths return null', () => {
  it('returns null for ./relative/path', () => {
    expect(parseGitHubSource('./relative/path')).toBeNull()
  })

  it('returns null for ../parent/path', () => {
    expect(parseGitHubSource('../parent/path')).toBeNull()
  })

  it('returns null for /absolute/path', () => {
    expect(parseGitHubSource('/absolute/path')).toBeNull()
  })

  it('returns null for ~/home/path', () => {
    expect(parseGitHubSource('~/home/path')).toBeNull()
  })
})
