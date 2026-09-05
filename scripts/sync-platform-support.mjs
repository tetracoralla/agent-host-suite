import { readFile, writeFile } from 'node:fs/promises'
const source = new URL('../src/windows-private-access.mjs', import.meta.url)
const bytes = await readFile(source)
for (const component of ['direct-execution-runtime', 'agent-tool-observer']) {
  const target = new URL(`../packages/${component}/src/windows-private-access.mjs`, import.meta.url)
  if (process.argv.includes('--write')) await writeFile(target, bytes)
  else if (!bytes.equals(await readFile(target))) throw new Error(`Stale platform support in ${component}`)
}
