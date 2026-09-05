import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { repositoryRoot } from './helpers.mjs'

test('repository check accepts a source comment while rejecting a model-facing plugin file', async () => {
  const verificationRoot = resolve(repositoryRoot, '.verify')
  await mkdir(verificationRoot, { recursive: true })
  const directory = await mkdtemp(resolve(verificationRoot, 'repository-check-'))
  const candidate = resolve(directory, 'runtime')
  const excluded = new Set(['.git', 'node_modules', '.verify', 'build'])
  try {
    // Keep dependency resolution in this workspace, but mutate only the copy.
    await mkdir(candidate)
    for (const entry of await readdir(repositoryRoot)) {
      if (excluded.has(entry)) continue
      await cp(resolve(repositoryRoot, entry), resolve(candidate, entry), {
        recursive: true,
        filter: (path) => !relative(repositoryRoot, path).split(sep).some((part) => excluded.has(part)),
      })
    }
    const check = () => spawnSync(process.execPath, ['scripts/check-repository.mjs'], {
      cwd: candidate, encoding: 'utf8', timeout: 30000,
    })
    const baseline = check()
    assert.equal(baseline.status, 0, baseline.error?.message ?? baseline.stderr)

    await appendFile(resolve(candidate, 'src/index.mjs'),
      '\n// Documentation reference only: @modelcontextprotocol/sdk/server\n')
    const commented = check()
    assert.equal(commented.status, 0, commented.error?.message ?? commented.stderr)

    await writeFile(resolve(candidate, '.mcp.json'), JSON.stringify({
      mcpServers: { runtime: { command: 'node', args: ['src/cli.mjs'] } },
    }))
    const plugin = check()
    assert.equal(plugin.status, 1, plugin.error?.message ?? plugin.stderr)
    assert.match(plugin.stderr, /must not package a model-facing plugin/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
