const QUOTE_PAIRS = Object.freeze([
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
])

function exactReply(value) {
  const text = value.trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.startsWith(open) && text.endsWith(close)) return text.slice(open.length, -close.length).trim()
  }
  return text
}

function usedFileInspectionTool(sequence) {
  return sequence.some((name) => /file(?:[_ -]?vitals|[_ -]?inspect)/iu.test(String(name)))
}

export function assessCostExperimentTask(task, summary) {
  const final = summary.finalText.trim()
  if (task.expected === 'no-tool') return summary.toolCallCount === 0 && exactReply(final) === '收到'
  if (task.expected === 'math') return summary.toolSequence.some((name) => String(name).includes('math')) && /3\s*\*?\s*x(?:\^2|\*\*2|²|2)/iu.test(final)
  if (task.expected === 'time') return summary.toolSequence.some((name) => /time|convert/iu.test(String(name))) && /2026-11-01|16:30/iu.test(final)
  if (task.expected === 'file') return usedFileInspectionTool(summary.toolSequence) && final.includes('@openadam/agent-host-suite')
  return false
}
