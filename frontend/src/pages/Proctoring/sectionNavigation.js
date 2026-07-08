export function buildHub(sections, questions) {
  const ordered = [...(sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const byId = new Map(ordered.map((s) => [String(s.id), { ...s, questions: [] }]))
  for (const q of questions || []) {
    const bucket = byId.get(String(q.section_id))
    if (bucket) bucket.questions.push(q)
  }
  return ordered.map((s) => byId.get(String(s.id)))
}

export function sectionStatus(hub, index, { finished = [], answers = {}, sequential = false } = {}) {
  const section = hub[index]
  if (!section) return 'not_started'
  const finishedSet = new Set(finished.map(String))
  if (finishedSet.has(String(section.id))) return 'finished'
  if (sequential) {
    const priorUnfinished = hub.slice(0, index).some((s) => !finishedSet.has(String(s.id)))
    if (priorUnfinished) return 'locked'
  }
  const hasAnswer = (section.questions || []).some((q) => answers[q.id] != null && answers[q.id] !== '')
  return hasAnswer ? 'in_progress' : 'not_started'
}
