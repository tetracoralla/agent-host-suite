import { readFileSync } from 'node:fs'

// The Studio project is the only Research Brief Method. This module exposes
// that same graph to development references and fixtures; installed Runs load
// the sealed component copy, not this source path.
const methodUrl = new URL(
  '../../../procedure-studio/examples/research-brief/method.json',
  import.meta.url,
)

export const researchBriefMethod = JSON.parse(readFileSync(methodUrl, 'utf8'))
