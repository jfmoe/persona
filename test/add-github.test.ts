/**
 * Integration tests for `persona add <github-source>`.
 *
 * Network isolation seam:
 *   The harness sets `PERSONA_GIT_REMOTE_BASE=file://<reposRoot>/` in the child
 *   process environment. When `src/add.ts` sees this variable, it replaces
 *   `https://github.com/` with the base, so clones hit a local git repository
 *   instead of GitHub.
 *
 * The helper `makeLocalGitRepo(owner, repo, files)` creates a minimal git
 * repository under `reposRoot/<owner>/<repo>` and commits the given files.
 * The harness `run` method automatically injects `PERSONA_GIT_REMOTE_BASE`.
 */
import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness } from './harness.js'
import { VALID_PERSONA_MD } from './fixtures.js'

// ─── paths ────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = pathResolve(HERE, '..')
const CLI_ENTRY = pathResolve(REPO_ROOT, 'src', 'cli.ts')
const TMP_ROOT = realpathSync(tmpdir())

// ─── local-repo factory ───────────────────────────────────────────────────────

/** Root dir holding all fake remote repos for the current test run. */
let reposRoot: string

/**
 * Create a local git repository at `<reposRoot>/<owner>/<repo>`, commit the
 * given files onto `main`, and return the absolute local directory path.
 */
function makeLocalGitRepo(owner: string, repo: string, files: Record<string, string>): string {
  const repoDir = join(reposRoot, owner, repo)
  mkdirSync(repoDir, { recursive: true })

  const git = (cmd: string): void => {
    execSync(cmd, { cwd: repoDir, stdio: 'pipe' })
  }

  git('git init')
  git('git config user.email "test@persona.test"')
  git('git config user.name "Persona Test"')
  git('git checkout -b main')

  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(repoDir, relPath)
    mkdirSync(pathResolve(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    git(`git add "${relPath}"`)
  }

  git('git commit -m "initial"')
  return repoDir
}

// ─── GitHub-aware harness ─────────────────────────────────────────────────────

interface GitHubHarness {
  readonly home: string
  run(args: string[]): { stdout: string; stderr: string; code: number }
  exists(relToHome: string): boolean
  readFile(relToHome: string): string
  seedMask(id: string, files?: Record<string, string>): void
  cleanup(): void
}

function createGitHubHarness(remoteBase: string): GitHubHarness {
  const inner = createHarness()

  return {
    get home() { return inner.home },

    run(args) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: inner.home,
          USERPROFILE: inner.home,
          PERSONA_GIT_REMOTE_BASE: remoteBase,
        },
      })
      if (result.error) throw result.error
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        code: result.status ?? -1,
      }
    },

    exists(rel) { return inner.exists(rel) },
    readFile(rel) { return inner.readFile(rel) },
    seedMask(id, files) { inner.seedMask(id, files) },
    cleanup() { inner.cleanup() },
  }
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('persona add — GitHub source', () => {
  let h: GitHubHarness

  beforeEach(() => {
    reposRoot = mkdtempSync(join(TMP_ROOT, 'persona-git-repos-'))
    h = createGitHubHarness(`file://${reposRoot}/`)
  })

  afterEach(() => {
    h.cleanup()
    rmSync(reposRoot, { recursive: true, force: true })
  })

  // ── Slice 1: bare owner/repo — root-level persona.md ─────────────────────

  it('imports a single mask from owner/repo (root-level persona.md)', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    const { code, stderr } = h.run(['add', 'owner/repo'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.readFile('.persona/senpai-rust/persona.md')).toBe(VALID_PERSONA_MD)
  })

  // ── Slice 2: owner/repo/path — subpath ───────────────────────────────────

  it('imports mask from owner/repo/path/to/mask subpath', () => {
    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
      'masks/senpai-rust/memory.md': '# memory',
    })

    const { code, stderr } = h.run(['add', 'owner/repo/masks/senpai-rust'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/senpai-rust/memory.md')).toBe(true)
  })

  // ── Slice 3: owner/repo@id — persona id selector ────────────────────────

  it('selects mask by id with owner/repo@id shorthand', () => {
    const maskB = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')

    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
      'masks/kohai-ts/persona.md': maskB,
    })

    const { code, stderr } = h.run(['add', 'owner/repo@senpai-rust'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/kohai-ts')).toBe(false)
  })

  // ── Slice 4: owner/repo#ref@id — ref + persona id ────────────────────────

  it('clones with --branch when ref is specified (owner/repo#main@id)', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    // We use 'main' as the ref — that's the branch we created in makeLocalGitRepo
    const { code, stderr } = h.run(['add', 'owner/repo#main@senpai-rust'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  // ── Slice 5: multi-mask remote — non-interactive hard fail ────────────────

  it('hard-fails in non-interactive mode when remote has multiple masks and lists ids', () => {
    const maskB = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')

    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
      'masks/kohai-ts/persona.md': maskB,
    })

    const { code, stderr } = h.run(['add', 'owner/repo/masks'])

    expect(code).toBe(1)
    expect(stderr).toMatch(/senpai-rust/)
    expect(stderr).toMatch(/kohai-ts/)
    expect(stderr).toMatch(/--persona/i)
  })

  // ── Slice 6: multi-mask remote — --persona selects ───────────────────────

  it('imports specific mask from multi-mask remote with --persona', () => {
    const maskB = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')

    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
      'masks/kohai-ts/persona.md': maskB,
    })

    const { code, stderr } = h.run(['add', 'owner/repo/masks', '--persona', 'senpai-rust'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
    expect(h.exists('.persona/kohai-ts')).toBe(false)
  })

  // ── Slice 7: --force overwrites existing mask ─────────────────────────────

  it('overwrites an existing mask with --force', () => {
    h.seedMask('senpai-rust', { 'persona.md': '# old' })

    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    const { code } = h.run(['add', 'owner/repo', '--force'])

    expect(code).toBe(0)
    expect(h.readFile('.persona/senpai-rust/persona.md')).toBe(VALID_PERSONA_MD)
  })

  // ── Slice 8: lock entry — github sourceType ───────────────────────────────

  it('writes a github lock entry with all required fields', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    h.run(['add', 'owner/repo'])

    expect(h.exists('.persona/.lock.json')).toBe(true)
    const lock = JSON.parse(h.readFile('.persona/.lock.json'))
    expect(lock.version).toBe(1)

    const entry = lock.personas['senpai-rust']
    expect(entry).toBeDefined()
    expect(entry.sourceType).toBe('github')
    expect(entry.source).toBe('owner/repo')
    expect(entry.sourceUrl).toBe('https://github.com/owner/repo.git')
    expect(entry.maskPath).toBe('')
    expect(entry.maskFolderHash).toMatch(/^[0-9a-f]{64}$/)
    expect(entry.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.ref).toBeUndefined()
  })

  it('records ref in lock entry when ref is specified', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    h.run(['add', 'owner/repo#main'])

    const lock = JSON.parse(h.readFile('.persona/.lock.json'))
    expect(lock.personas['senpai-rust'].ref).toBe('main')
  })

  it('records maskPath in lock entry when subpath is used', () => {
    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
    })

    h.run(['add', 'owner/repo/masks/senpai-rust'])

    const lock = JSON.parse(h.readFile('.persona/.lock.json'))
    expect(lock.personas['senpai-rust'].maskPath).toBe('masks/senpai-rust')
  })

  it('preserves importedAt on re-import with --force', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    h.run(['add', 'owner/repo'])
    const lock1 = JSON.parse(h.readFile('.persona/.lock.json'))
    const firstImportedAt = lock1.personas['senpai-rust'].importedAt

    h.run(['add', 'owner/repo', '--force'])
    const lock2 = JSON.parse(h.readFile('.persona/.lock.json'))

    expect(lock2.personas['senpai-rust'].importedAt).toBe(firstImportedAt)
    expect(lock2.personas['senpai-rust'].updatedAt).toBeDefined()
  })

  // ── Slice 9: clone failure → non-zero exit ────────────────────────────────

  it('exits 1 with a clear error when the repo does not exist', () => {
    // No repo created — clone will fail
    const { code, stderr } = h.run(['add', 'nonexistent/repo'])

    expect(code).toBe(1)
    expect(stderr).toMatch(/failed to clone|clone/i)
  })

  // ── Slice 10: full GitHub URL ─────────────────────────────────────────────

  it('imports from a full https://github.com/owner/repo URL', () => {
    makeLocalGitRepo('owner', 'repo', {
      'persona.md': VALID_PERSONA_MD,
    })

    const { code, stderr } = h.run(['add', 'https://github.com/owner/repo'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  it('imports from a tree URL with ref and path', () => {
    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
    })

    const { code, stderr } = h.run([
      'add',
      'https://github.com/owner/repo/tree/main/masks/senpai-rust',
    ])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/senpai-rust/persona.md')).toBe(true)
  })

  // ── Slice 11: --persona flag with URL source ──────────────────────────────

  it('uses --persona flag with full URL for multi-mask selection', () => {
    const maskB = VALID_PERSONA_MD
      .replace('id: senpai-rust', 'id: kohai-ts')
      .replace('name: 锈学姐', 'name: TS 后辈')

    makeLocalGitRepo('owner', 'repo', {
      'masks/senpai-rust/persona.md': VALID_PERSONA_MD,
      'masks/kohai-ts/persona.md': maskB,
    })

    const { code, stderr } = h.run([
      'add',
      'https://github.com/owner/repo/tree/main/masks',
      '--persona',
      'kohai-ts',
    ])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(h.exists('.persona/kohai-ts/persona.md')).toBe(true)
    expect(h.exists('.persona/senpai-rust')).toBe(false)
  })
})
