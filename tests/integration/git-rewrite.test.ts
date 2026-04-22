import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { $ } from 'bun'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseLineSpecs } from '../../src/parser.ts'
import {
  checkGitVersion,
  getLineBlameInfo,
  groupReplacementsByCommit,
} from '../../src/git-utils.ts'
import { performRebase } from '../../src/rebase.ts'

async function spawnCli(args: string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited
  const stdout = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stdout))
  const stderr = new TextDecoder().decode(await Bun.readableStreamToArrayBuffer(proc.stderr))

  return { exitCode, stdout, stderr }
}

async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
}

describe('Git integration tests', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'))
    process.chdir(tempDir)

    await $`git init`
    await $`git config user.email "test@example.com"`
    await $`git config user.name "Test User"`
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('detects git version', async () => {
    await expect(checkGitVersion('1.0.0')).resolves.toBeUndefined()
    await expect(checkGitVersion('99.99.99')).rejects.toThrow()
  })

  it('gets blame info for single line', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\n')
    await $`git add test.txt`
    await $`git commit -m "Initial commit"`

    const ranges = parseLineSpecs(['2'])
    const info = await getLineBlameInfo('test.txt', ranges[0])

    expect(info).toHaveLength(1)
    expect(info[0].content).toBe('line2')
    expect(info[0].lineNumber).toBe(2)
    expect(info[0].commitHash).toMatch(/^[a-f0-9]{40}$/)
  })

  it('gets blame info for range', async () => {
    await writeFile('test.txt', 'line1\nline2\nline3\nline4\nline5\n')
    await $`git add test.txt`
    await $`git commit -m "Initial commit"`

    const ranges = parseLineSpecs(['2-4'])
    const info = await getLineBlameInfo('test.txt', ranges[0])

    expect(info).toHaveLength(3)
    expect(info[0].content).toBe('line2')
    expect(info[1].content).toBe('line3')
    expect(info[2].content).toBe('line4')
  })

  it('groups replacements by commit', async () => {
    await writeFile('test.txt', 'line1\nSECRET_KEY=abc123\nline3\n')
    await $`git add test.txt`
    await $`git commit -m "Initial commit"`

    const ranges = parseLineSpecs(['2'])
    const info = await getLineBlameInfo('test.txt', ranges[0])
    const replacements = new Map([[2, 'SECRET_KEY=REDACTED']])

    const grouped = await groupReplacementsByCommit(info, replacements)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].lines).toHaveLength(1)
    expect(grouped[0].lines[0].originalContent).toBe('SECRET_KEY=abc123')
    expect(grouped[0].lines[0].replacementContent).toBe('SECRET_KEY=REDACTED')
  })

  it('handles multiple files in same commit', async () => {
    await writeFile('file1.txt', 'content1\n')
    await writeFile('file2.txt', 'content2\n')
    await $`git add file1.txt file2.txt`
    await $`git commit -m "Add two files"`

    const ranges = parseLineSpecs(['1'])
    const info = await getLineBlameInfo('file1.txt', ranges[0])

    expect(info).toHaveLength(1)
    expect(info[0].content).toBe('content1')
  })

  it('handles multiple commits', async () => {
    await writeFile('test.txt', 'line1\nline2\n')
    await $`git add test.txt`
    await $`git commit -m "First commit"`

    await writeFile('test.txt', 'line1\nline2\nline3\n')
    await $`git add test.txt`
    await $`git commit -m "Second commit"`

    const ranges = parseLineSpecs(['1', '3'])
    const info1 = await getLineBlameInfo('test.txt', ranges[0])
    const info3 = await getLineBlameInfo('test.txt', ranges[1])

    expect(info1[0].commitHash).not.toBe(info3[0].commitHash)
  })

  it('performRebase rewrites history', async () => {
    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\n')
    await $`git add secret.txt`
    await $`git commit -m "Add secret"`

    await writeFile('secret.txt', 'SECRET=old-value\nOTHER=keep\nMORE=data\n')
    await $`git add secret.txt`
    await $`git commit -m "Add more data"`

    const ranges = parseLineSpecs(['1'])
    const info = await getLineBlameInfo('secret.txt', ranges[0])
    const replacements = new Map([[1, 'SECRET=REDACTED']])
    const commits = await groupReplacementsByCommit(info, replacements)

    expect(commits).toHaveLength(1)

    await performRebase(commits, 'secret.txt', false)

    const blame = await getLineBlameInfo('secret.txt', ranges[0])
    expect(blame[0].content).toBe('SECRET=REDACTED')

    const log = await $`git log --oneline`.text()
    expect(log).toContain('Add secret')
    expect(log).toContain('Add more data')
  })
})

describe('Working directory flag', () => {
  let tempDir: string
  let projectRoot: string

  beforeEach(() => {
    projectRoot = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'git-private-data-remover-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('accepts --help with working directory', async () => {
    const { exitCode, stdout } = await spawnCli(['-w', tempDir, '--help'], projectRoot)

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Git Private Data Remover')
  })

  it('fails with non-existent working directory', async () => {
    const nonExistentDir = join(tempDir, 'does-not-exist')

    const { exitCode, stderr } = await spawnCli(['-w', nonExistentDir, '-f', 'file.txt', '-l', '1'], projectRoot)

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Working directory not found')
  })

  it('operates in specified working directory', async () => {
    process.chdir(tempDir)
    await $`git init`
    await $`git config user.email "test@example.com"`
    await $`git config user.name "Test User"`
    await writeFile('secret.txt', 'SECRET=old\n')
    await $`git add secret.txt`
    await $`git commit -m "Add secret"`
    await writeFile('secret.txt', 'modified\n')
    process.chdir(projectRoot)

    const { exitCode, stderr } = await spawnCli(['-w', tempDir, '-f', 'secret.txt', '-l', '1'], projectRoot)

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Git repository has uncommitted changes')
  })
})
