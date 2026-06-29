// Single source of truth for translating between a question's stored shape
// ({ options, correct_answer }) and the editor-friendly "answer state" used by
// the shared <QuestionTypeFields> component. Pure, framework-free, unit-tested
// in questionPayload.test.js. The serialized format intentionally matches the
// bulk-import path (parseQuestionRows.js) and the backend grader/validator:
//   MCQ        options[], correct_answer = correct option text
//   MULTI      options[], correct_answer = comma-joined correct option texts
//   TRUEFALSE  ['True','False'], correct_answer = 'True' | 'False'
//   TEXT       options=null, correct_answer = model answer (optional)
//   ORDERING   options[] in correct order, correct_answer = null
//   FILLINBLANK options[] = acceptable answers, correct_answer = null
//   MATCHING   options[] = 'Left | Right', correct_answer = 'A-1,B-2,...'

export const MAX_ANSWER_LENGTH = 255

const TYPE_ALIASES = {
  TRUE_FALSE: 'TRUEFALSE',
  SHORT_ANSWER: 'TEXT',
  FILL_IN_BLANK: 'FILLINBLANK',
  MULTIPLE_CHOICE: 'MULTI',
}

const CHOICE_TYPES = new Set(['MCQ', 'MULTI'])

export function normalizeQuestionType(value) {
  if (!value) return 'MCQ'
  const upper = String(value).trim().toUpperCase()
  if (TYPE_ALIASES[upper]) return TYPE_ALIASES[upper]
  return upper
}

function letterFor(index) {
  return String.fromCharCode(65 + index)
}

function indexForToken(token, options) {
  const trimmed = String(token ?? '').trim()
  if (!trimmed) return -1
  // Legacy letter form (A, B, C, ...)
  if (/^[A-Z]$/i.test(trimmed)) {
    const idx = trimmed.toUpperCase().charCodeAt(0) - 65
    if (idx >= 0 && idx < options.length) return idx
  }
  // Option-text form
  const textMatch = options.findIndex((opt) => String(opt).trim() === trimmed)
  return textMatch
}

export function emptyAnswerState(type) {
  const normalized = normalizeQuestionType(type)
  if (CHOICE_TYPES.has(normalized)) return { options: ['', '', '', ''], correctIndices: [] }
  if (normalized === 'TRUEFALSE') return { booleanAnswer: 'True' }
  if (normalized === 'TEXT') return { modelAnswer: '' }
  if (normalized === 'ORDERING') return { options: ['', ''] }
  if (normalized === 'FILLINBLANK') return { options: [''] }
  if (normalized === 'MATCHING') return { pairs: [{ left: '', right: '' }] }
  return { options: ['', '', '', ''], correctIndices: [] }
}

export function questionToAnswerState(question) {
  const type = normalizeQuestionType(question?.question_type || question?.type)
  const options = Array.isArray(question?.options) ? question.options : []
  const correct = question?.correct_answer

  if (CHOICE_TYPES.has(type)) {
    const opts = options.length ? options : ['', '', '', '']
    const tokens = String(correct ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
    const correctIndices = tokens
      .map((token) => indexForToken(token, opts))
      .filter((idx) => idx >= 0)
    return { options: opts, correctIndices: type === 'MCQ' ? correctIndices.slice(0, 1) : correctIndices }
  }

  if (type === 'TRUEFALSE') {
    const raw = String(correct ?? '').trim().toUpperCase()
    const booleanAnswer = raw === 'B' || raw === 'FALSE' ? 'False' : 'True'
    return { booleanAnswer }
  }

  if (type === 'TEXT') {
    return { modelAnswer: correct == null ? '' : String(correct) }
  }

  if (type === 'MATCHING') {
    const pairs = options.length
      ? options.map((line) => {
          const [left, right = ''] = String(line).split('|')
          return { left: left.trim(), right: right.trim() }
        })
      : [{ left: '', right: '' }]
    return { pairs }
  }

  // ORDERING / FILLINBLANK
  if (options.length) return { options: [...options] }
  return emptyAnswerState(type)
}

export function answerStateToPayload(type, state) {
  const normalized = normalizeQuestionType(type)

  if (CHOICE_TYPES.has(normalized)) {
    const rawOptions = state?.options || []
    const correctSet = new Set(state?.correctIndices || [])
    const kept = []
    const keptCorrect = []
    rawOptions.forEach((option, index) => {
      const trimmed = String(option).trim()
      if (!trimmed) return
      kept.push(trimmed)
      keptCorrect.push(correctSet.has(index))
    })
    const correctTexts = kept.filter((_, index) => keptCorrect[index])
    const correct_answer = normalized === 'MCQ'
      ? (correctTexts[0] ?? null)
      : (correctTexts.length ? correctTexts.join(',') : null)
    return { options: kept, correct_answer }
  }

  if (normalized === 'TRUEFALSE') {
    return { options: ['True', 'False'], correct_answer: state?.booleanAnswer === 'False' ? 'False' : 'True' }
  }

  if (normalized === 'TEXT') {
    const trimmed = String(state?.modelAnswer ?? '').trim()
    return { options: null, correct_answer: trimmed || null }
  }

  if (normalized === 'MATCHING') {
    const pairs = (state?.pairs || [])
      .map((pair) => ({ left: String(pair?.left ?? '').trim(), right: String(pair?.right ?? '').trim() }))
      .filter((pair) => pair.left && pair.right)
    const options = pairs.map((pair) => `${pair.left} | ${pair.right}`)
    const correct_answer = pairs.length
      ? pairs.map((_, index) => `${letterFor(index)}-${index + 1}`).join(',')
      : null
    return { options, correct_answer }
  }

  // ORDERING / FILLINBLANK
  const options = (state?.options || []).map((option) => String(option).trim()).filter(Boolean)
  return { options, correct_answer: null }
}

export function validateAnswerState(type, state) {
  const normalized = normalizeQuestionType(type)
  const { options, correct_answer } = answerStateToPayload(normalized, state)

  if (CHOICE_TYPES.has(normalized)) {
    if (!options || options.length < 2) return 'qtf_err_min_options'
    if (!correct_answer) return normalized === 'MCQ' ? 'qtf_err_select_correct' : 'qtf_err_select_correct_multi'
    if (correct_answer.length > MAX_ANSWER_LENGTH) return 'qtf_err_answer_too_long'
    return null
  }

  if (normalized === 'ORDERING') {
    if (!options || options.length < 2) return 'qtf_err_min_items'
    return null
  }

  if (normalized === 'FILLINBLANK') {
    if (!options || options.length < 1) return 'qtf_err_min_answer'
    return null
  }

  if (normalized === 'MATCHING') {
    if (!options || options.length < 1) return 'qtf_err_min_pair'
    if (correct_answer && correct_answer.length > MAX_ANSWER_LENGTH) return 'qtf_err_answer_too_long'
    return null
  }

  // TRUEFALSE / TEXT — always valid (text required is enforced by the host form)
  return null
}
