import { execFileSync } from 'node:child_process'

// Exercise the actual projected batch file. These fixtures only pass fixed
// version/help switches; avoid a generic shell command interface in the helper.
export function runSkillLauncher(launcher, args) {
  if (process.platform !== 'win32') return execFileSync(launcher, args, { encoding: 'utf8' })
  if (/[%!"\r\n]/u.test(launcher) || args.some((arg) => !/^[-a-zA-Z0-9_.]+$/u.test(arg))) throw new Error('Unexpected fixture shell characters')
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], {
    encoding: 'utf8', windowsVerbatimArguments: true,
  })
}
