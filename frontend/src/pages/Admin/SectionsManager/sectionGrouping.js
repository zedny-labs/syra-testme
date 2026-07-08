export function groupQuestionsBySection(sections, questions) {
  const ordered = [...(sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const byId = new Map(ordered.map((s) => [String(s.id), { section: s, questions: [] }]))
  const orphan = { section: { id: null, title: 'General', order: Number.MAX_SAFE_INTEGER }, questions: [] }
  for (const q of questions || []) {
    const bucket = byId.get(String(q.section_id)) || orphan
    bucket.questions.push(q)
  }
  const groups = ordered.map((s) => byId.get(String(s.id)))
  if (orphan.questions.length) groups.push(orphan)
  for (const g of groups) g.questions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return groups
}
