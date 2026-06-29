// Pure helpers to turn the question-import workbook into question-create payloads.
// No React, no network — unit tested in parseQuestionRows.test.js.
//
// The workbook has two data sheets joined by a shared Common ID, plus an
// informational Legend sheet (not parsed):
//   • Questions: Common ID (Question ID) | Question Text | Question Type | Points
//   • Answers:   Common ID (Question ID) | Answer Text | Answer Ordinal Number | Correct Answer
//
// Only fields SYRA stores are represented — every answer for a question lives on
// its own row in the Answers sheet, ordered by "Answer Ordinal Number" and flagged
// correct with "Y" in "Correct Answer".

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

// Header text (lowercased) → internal key, per sheet. Unknown headers are ignored.
const QUESTION_HEADERS = {
  'common id (question id)': 'common_id',
  'common id': 'common_id',
  'question id': 'common_id',
  'question text': 'text',
  text: 'text',
  'question type': 'type',
  type: 'type',
  points: 'points',
}

const ANSWER_HEADERS = {
  'common id (question id)': 'common_id',
  'common id': 'common_id',
  'question id': 'common_id',
  'answer text': 'answer_text',
  'answer ordinal number': 'ordinal',
  ordinal: 'ordinal',
  'correct answer': 'correct',
  correct: 'correct',
}

const isCorrectFlag = (value) => ['Y', 'YES', 'TRUE', 'T', '1'].includes(String(value ?? '').trim().toUpperCase())

const ordinalValue = (answer) => {
  const parsed = Number(String(answer?.ordinal ?? '').trim())
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

// matrix: array-of-arrays (first row = header). Returns [{ __row, <key>: value }],
// keyed via the supplied header map. __row is the 1-based spreadsheet row.
export function recordsFromSheet(matrix, headerMap) {
  if (!Array.isArray(matrix) || matrix.length === 0) return []
  const keys = (matrix[0] || []).map((header) => headerMap[String(header ?? '').trim().toLowerCase()] || null)
  const records = []
  for (let index = 1; index < matrix.length; index += 1) {
    const cols = matrix[index]
    if (!Array.isArray(cols) || !cols.some((col) => String(col ?? '').trim() !== '')) continue
    const record = { __row: index + 1 }
    keys.forEach((key, column) => {
      if (key) record[key] = cols[column] ?? ''
    })
    records.push(record)
  }
  return records
}

// question: { common_id?, text, type, points }
// answers:  [{ answer_text, ordinal, correct }], already ordered by ordinal.
// Returns { payload } for a valid question, or { error: <code> }.
export function mapQuestion(question, answers = []) {
  const text = String(question?.text ?? '').trim()
  if (!text) return { error: 'missing_text' }

  const type = normalizeType(question?.type)
  if (!type) return { error: 'unknown_type' }

  let points = Number(String(question?.points ?? '').trim())
  if (!Number.isFinite(points) || points <= 0) points = 1

  const opts = answers.map((answer) => String(answer?.answer_text ?? '').trim()).filter(Boolean)
  const correctTexts = answers
    .filter((answer) => isCorrectFlag(answer?.correct))
    .map((answer) => String(answer?.answer_text ?? '').trim())
    .filter(Boolean)

  let options = null
  let correctAnswer = null

  if (type === 'MCQ') {
    if (opts.length < 2) return { error: 'need_2_options' }
    if (correctTexts.length === 0) return { error: 'missing_correct_answer' }
    if (correctTexts.length > 1) return { error: 'one_correct' }
    options = opts
    correctAnswer = correctTexts[0]
  } else if (type === 'MULTI') {
    if (opts.length < 2) return { error: 'need_2_options' }
    if (correctTexts.length === 0) return { error: 'missing_correct_answer' }
    options = opts
    correctAnswer = correctTexts.join(',')
  } else if (type === 'TRUEFALSE') {
    if (correctTexts.length !== 1) return { error: 'truefalse_answer' }
    const normalized = correctTexts[0].toLowerCase()
    if (normalized !== 'true' && normalized !== 'false') return { error: 'truefalse_answer' }
    options = ['True', 'False']
    correctAnswer = normalized === 'true' ? 'True' : 'False'
  } else if (type === 'ORDERING') {
    if (opts.length < 2) return { error: 'need_2_options' }
    options = opts
    correctAnswer = null
  } else if (type === 'FILLINBLANK') {
    if (opts.length < 1) return { error: 'need_1_option' }
    options = opts
    correctAnswer = null
  } else if (type === 'MATCHING') {
    if (opts.length < 1) return { error: 'need_1_option' }
    if (!opts.every((line) => line.split('|').length === 2)) return { error: 'matching_pair_format' }
    options = opts
    correctAnswer = null
  } else {
    // TEXT — optional model answer (the Y-marked row, or the only row), no options.
    options = null
    correctAnswer = correctTexts[0] || opts[0] || null
  }

  return { payload: { text, question_type: type, options, correct_answer: correctAnswer, points } }
}

// questionMatrix / answerMatrix: array-of-arrays (header row first). Joins the
// Answers sheet onto the Questions sheet by Common ID and maps each to a payload.
// Returns [{ row, commonId, payload? , error? }] — question rows in sheet order,
// followed by one entry per orphaned answer group.
export function buildQuestions(questionMatrix, answerMatrix) {
  const questionRecords = recordsFromSheet(questionMatrix, QUESTION_HEADERS)
  const answerRecords = recordsFromSheet(answerMatrix, ANSWER_HEADERS)

  const answersById = new Map()
  for (const record of answerRecords) {
    const id = String(record.common_id ?? '').trim()
    if (!id) continue
    if (!answersById.has(id)) answersById.set(id, [])
    answersById.get(id).push(record)
  }
  for (const group of answersById.values()) {
    group.sort((a, b) => ordinalValue(a) - ordinalValue(b))
  }

  const seenIds = new Set()
  const rows = questionRecords.map((record) => {
    const commonId = String(record.common_id ?? '').trim()
    if (commonId && seenIds.has(commonId)) {
      return { row: record.__row, commonId, error: 'duplicate_id' }
    }
    if (commonId) seenIds.add(commonId)
    const answers = (commonId && answersById.get(commonId)) || []
    return { row: record.__row, commonId, ...mapQuestion(record, answers) }
  })

  const orphanRows = []
  for (const [id, group] of answersById.entries()) {
    if (!seenIds.has(id)) {
      orphanRows.push({ row: group[0].__row, commonId: id, error: 'orphan_answer' })
    }
  }

  return [...rows, ...orphanRows]
}

// Sample "Questions" sheet for the downloadable template (header + one row per type).
export function templateQuestions() {
  return [
    ['Common ID (Question ID)', 'Question Text', 'Question Type', 'Points'],
    ['1', 'What is 2 + 2?', 'MCQ', '1'],
    ['2', 'Select the prime numbers.', 'MULTI', '1'],
    ['3', 'The sky is blue.', 'TRUEFALSE', '1'],
    ['4', 'Define photosynthesis.', 'TEXT', '2'],
    ['5', 'Order the planets from the sun.', 'ORDERING', '1'],
    ['6', 'The capital of France is [blank].', 'FILLINBLANK', '1'],
    ['7', 'Match each country to its capital.', 'MATCHING', '1'],
  ]
}

// Sample "Answers" sheet — every answer references its question's Common ID.
export function templateAnswers() {
  return [
    ['Common ID (Question ID)', 'Answer Text', 'Answer Ordinal Number', 'Correct Answer'],
    ['1', '3', '1', 'N'],
    ['1', '4', '2', 'Y'],
    ['1', '5', '3', 'N'],
    ['1', '6', '4', 'N'],
    ['2', '2', '1', 'Y'],
    ['2', '3', '2', 'Y'],
    ['2', '4', '3', 'N'],
    ['2', '6', '4', 'N'],
    ['3', 'True', '1', 'Y'],
    ['3', 'False', '2', 'N'],
    ['4', 'Conversion of light into chemical energy', '1', 'Y'],
    ['5', 'Mercury', '1', 'N'],
    ['5', 'Venus', '2', 'N'],
    ['5', 'Earth', '3', 'N'],
    ['5', 'Mars', '4', 'N'],
    ['6', 'Paris', '1', 'N'],
    ['6', 'paris', '2', 'N'],
    ['7', 'France | Paris', '1', 'N'],
    ['7', 'Egypt | Cairo', '2', 'N'],
  ]
}

// Human-readable guidance for the "Legend" sheet (array-of-arrays). Informational
// only — the importer reads the "Questions" and "Answers" sheets.
export function templateLegend() {
  return [
    ['How to use this template'],
    [''],
    ['1. Fill the "Questions" sheet — one question per row. Give each a unique Common ID.'],
    ['2. Fill the "Answers" sheet — one answer per row. Repeat the question\'s Common ID on every one of its answers.'],
    ['3. Use "Answer Ordinal Number" (1, 2, 3 …) to order the answers. Mark each correct answer with "Y" in "Correct Answer"; mark the rest "N".'],
    ['4. Save the file and upload it via "Import Questions".'],
    [''],
    ['Question Type', 'Code', 'How to fill the Answers sheet'],
    ['Single / Multiple choice', 'MCQ / MULTI', 'One row per choice. MCQ: mark exactly one "Y". MULTI: mark one or more "Y".'],
    ['True / False', 'TRUEFALSE', 'Two rows: "True" and "False". Mark the correct one "Y".'],
    ['Open / essay answer', 'TEXT', 'Optional: one row with the model answer (mark it "Y"). Leave answers blank for a free-text question.'],
    ['Ordering', 'ORDERING', 'One row per item, in the correct order via "Answer Ordinal Number". Correct Answer = "N".'],
    ['Fill in the blanks', 'FILLINBLANK', 'One row per acceptable answer. Correct Answer = "N".'],
    ['Matching', 'MATCHING', 'One row per pair, written as "Left | Right". Correct Answer = "N".'],
    [''],
    ['Correct Answer', 'Code'],
    ['Correct', 'Y'],
    ['Not correct', 'N'],
  ]
}
