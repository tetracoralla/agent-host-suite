/**
 * SemVer 2.0 precedence (core + pre-release). Build metadata is ignored.
 * Returns -1 if left < right, 0 if equal, 1 if left > right.
 */
export function compareSemVer(left, right) {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  if (a.prerelease === null && b.prerelease === null) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(leftPart)
      const rightNumber = Number(rightPart)
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function parseSemVer(value) {
  const raw = String(value ?? '').replace(/^v/u, '').trim()
  const withoutBuild = raw.split('+', 1)[0]
  const dash = withoutBuild.indexOf('-')
  const coreText = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const prereleaseText = dash === -1 ? null : withoutBuild.slice(dash + 1)
  const core = coreText.split('.').map((part) => (/^\d+$/u.test(part) ? Number(part) : 0))
  while (core.length < 3) core.push(0)
  return {
    core: core.slice(0, 3),
    prerelease: prereleaseText === null || prereleaseText === '' ? null : prereleaseText.split('.'),
  }
}
