// Pure helpers to turn spreadsheet rows into question-create payloads.
// No React, no network — unit tested in parseQuestionRows.test.js.

const VALID_TYPES = new Set(['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING'])

const TYPE_ALIASES = {
  TRUE_FALSE: 'TRUEFALSE',
  SHORT_ANSWER: 'TEXT',
  FILL_IN_BLANK: 'FILLINBLANK',
  MULTIPLE_CHOICE: 'MULTI',
}

function normalizeType(raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/[-\s/]+/g, '_')
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key]
  const compact = key.replace(/_/g, '')
  if (VALID_TYPES.has(compact)) return compact
  if (VALID_TYPES.has(key)) return key
  return null
}

function lines(cell) {
  return String(cell ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

// matrix: array-of-arrays (first row = header). Returns array of records keyed by lowercased header.
export function rowsToRecords(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return []
  const headers = (matrix[0] || []).map((header) => String(header ?? '').trim().toLowerCase())
  return matrix
    .slice(1)
    .filter((cols) => Array.isArray(cols) && cols.some((col) => String(col ?? '').trim() !== ''))
    .map((cols) => Object.fromEntries(headers.map((header, index) => [header, cols[index] ?? ''])))
}

// Returns { payload } for a valid row, or { error: <code> } otherwise.
export function mapRecordToQuestion(record) {
  const text = String(record?.text ?? '').trim()
  if (!text) return { error: 'missing_text' }

  const type = normalizeType(record?.type)
  if (!type) return { error: 'unknown_type' }

  let points = Number(String(record?.points ?? '').trim())
  if (!Number.isFinite(points) || points <= 0) points = 1

  const opts = lines(record?.options)
  const answerRaw = String(record?.correct_answer ?? '').trim()

  let options = null
  let correctAnswer = null

  if (type === 'MCQ') {
    if (opts.length < 2) return { error: 'mcq_need_2_options' }
    if (!answerRaw) return { error: 'missing_correct_answer' }
    if (!opts.includes(answerRaw)) return { error: 'answer_not_in_options' }
    options = opts
    correctAnswer = answerRaw
  } else if (type === 'MULTI') {
    if (opts.length < 2) return { error: 'mcq_need_2_options' }
    const answers = answerRaw.split(',').map((value) => value.trim()).filter(Boolean)
    if (!answers.length) return { error: 'missing_correct_answer' }
    if (!answers.every((answer) => opts.includes(answer))) return { error: 'answer_not_in_options' }
    options = opts
    correctAnswer = answers.join(',')
  } else if (type === 'TRUEFALSE') {
    const normalized = answerRaw.toLowerCase()
    if (normalized !== 'true' && normalized !== 'false') return { error: 'truefalse_answer' }
    options = ['True', 'False']
    correctAnswer = normalized === 'true' ? 'True' : 'False'
  } else if (type === 'ORDERING') {
    if (opts.length < 2) return { error: 'ordering_need_2' }
    options = opts
    correctAnswer = null
  } else if (type === 'FILLINBLANK') {
    if (opts.length < 1) return { error: 'fillinblank_need_1' }
    options = opts
    correctAnswer = null
  } else if (type === 'MATCHING') {
    if (opts.length < 1) return { error: 'matching_need_1' }
    if (!opts.every((line) => line.split('|').length === 2)) return { error: 'matching_pair_format' }
    options = opts
    correctAnswer = answerRaw || null
  } else {
    // TEXT
    options = null
    correctAnswer = answerRaw || null
  }

  return { payload: { text, question_type: type, options, correct_answer: correctAnswer, points } }
}

// records: output of rowsToRecords. Returns [{ row, payload? , error? }] with 1-based
// spreadsheet row numbers (header is row 1, so data starts at row 2).
export function mapRecords(records) {
  return (records || []).map((record, index) => ({ row: index + 2, ...mapRecordToQuestion(record) }))
}

// Sample data for the downloadable template (array-of-arrays: header + one row per type).
export function templateMatrix() {
  return [
    ['text', 'type', 'options', 'correct_answer', 'points'],
    ['What is 2 + 2?', 'MCQ', '3\n4\n5\n6', '4', '1'],
    ['Select the prime numbers.', 'MULTI', '2\n3\n4\n6', '2,3', '1'],
    ['The sky is blue.', 'TRUEFALSE', '', 'True', '1'],
    ['Define photosynthesis.', 'TEXT', '', 'Conversion of light into chemical energy', '2'],
    ['Order the planets from the sun.', 'ORDERING', 'Mercury\nVenus\nEarth\nMars', '', '1'],
    ['The capital of France is [blank].', 'FILLINBLANK', 'Paris\nparis', '', '1'],
    ['Match each country to its capital.', 'MATCHING', 'France | Paris\nEgypt | Cairo', 'A-1,B-2', '1'],
  ]
}

// Human-readable guidance for the "Instructions" sheet of the downloadable template
// (array-of-arrays). This sheet is informational only — the importer reads the "Questions" sheet.
export function templateInstructions() {
  return [
    ['How to use this template'],
    [''],
    ['1. Fill the "Questions" sheet — one question per row. Keep the header row.'],
    ['2. For multiple values in one cell (options, acceptable answers, pairs), put each value on its own line (Alt+Enter inside the cell).'],
    ['3. Save the file and upload it via "Import Questions".'],
    [''],
    ['Column', 'Required', 'Notes'],
    ['text', 'Yes', 'The question text.'],
    ['type', 'Yes', 'One of: MCQ, MULTI, TRUEFALSE, TEXT, ORDERING, FILLINBLANK, MATCHING.'],
    ['options', 'Depends on type', 'MCQ/MULTI: choices (one per line). TRUEFALSE: leave blank. ORDERING: items in correct order. FILLINBLANK: acceptable answers. MATCHING: "Left | Right" per line.'],
    ['correct_answer', 'Depends on type', 'MCQ: the correct option text. MULTI: comma-separated correct option texts. TRUEFALSE: True or False. TEXT: model answer (optional). ORDERING & FILLINBLANK: leave blank. MATCHING: e.g. A-1,B-2.'],
    ['points', 'No', 'Number greater than 0. Defaults to 1 when blank.'],
    [''],
    ['Type', 'Example options (one per line)', 'Example correct_answer'],
    ['MCQ', '3 / 4 / 5 / 6', '4'],
    ['MULTI', '2 / 3 / 4 / 6', '2,3'],
    ['TRUEFALSE', '(leave blank)', 'True'],
    ['TEXT', '(leave blank)', 'Conversion of light into energy (optional)'],
    ['ORDERING', 'Mercury / Venus / Earth / Mars', '(leave blank)'],
    ['FILLINBLANK', 'Paris / paris', '(leave blank)'],
    ['MATCHING', 'France | Paris / Egypt | Cairo', 'A-1,B-2'],
  ]
}
