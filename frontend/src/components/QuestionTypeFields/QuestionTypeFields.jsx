import React, { useId, useState } from 'react'
import { normalizeQuestionType } from '../../utils/questionPayload'
import styles from './QuestionTypeFields.module.scss'

const CHOICE_TYPES = new Set(['MCQ', 'MULTI'])

// Remove an option (or ordering/fill item) and keep MCQ/MULTI correctIndices aligned.
function removeOptionAt(state, index) {
  const options = (state.options || []).filter((_, i) => i !== index)
  const correctIndices = (state.correctIndices || [])
    .filter((i) => i !== index)
    .map((i) => (i > index ? i - 1 : i))
  return state.correctIndices ? { ...state, options, correctIndices } : { ...state, options }
}

function letterFor(index) {
  return String.fromCharCode(65 + index)
}

export default function QuestionTypeFields({ type, state, onChange, disabled = false, t }) {
  const normalized = normalizeQuestionType(type)
  const groupId = useId()
  const [dragIndex, setDragIndex] = useState(null)
  const tr = (key, fallback) => {
    const value = t ? t(key) : key
    return value === key && fallback ? fallback : value
  }

  const setState = (next) => onChange?.(next)
  const setOption = (index, value) =>
    setState({ ...state, options: (state.options || []).map((opt, i) => (i === index ? value : opt)) })
  const addOption = () => setState({ ...state, options: [...(state.options || []), ''] })

  // ---- MCQ / MULTI ----
  if (CHOICE_TYPES.has(normalized)) {
    const options = state.options || []
    const correctIndices = state.correctIndices || []
    const isMulti = normalized === 'MULTI'

    const setCorrect = (index) => {
      if (isMulti) {
        const has = correctIndices.includes(index)
        const nextCorrect = has ? correctIndices.filter((i) => i !== index) : [...correctIndices, index].sort((a, b) => a - b)
        setState({ ...state, correctIndices: nextCorrect })
      } else {
        setState({ ...state, correctIndices: [index] })
      }
    }

    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_options', 'Options')}</div>
        <div className={styles.helper}>
          {isMulti ? tr('qtf_select_correct_options', 'Tick every correct option.') : tr('qtf_select_correct_option', 'Tick the one correct option.')}
        </div>
        {options.map((option, index) => (
          <div key={index} className={styles.optionRow}>
            <input
              type={isMulti ? 'checkbox' : 'radio'}
              name={isMulti ? undefined : `${groupId}-correct`}
              className={styles.choiceInput}
              checked={correctIndices.includes(index)}
              onChange={() => setCorrect(index)}
              disabled={disabled}
              aria-label={`${tr('qtf_mark_correct', 'Mark correct')} ${letterFor(index)}`}
            />
            <span className={styles.optionLetter}>{letterFor(index)}</span>
            <input
              type="text"
              className={styles.textInput}
              value={option}
              onChange={(e) => setOption(index, e.target.value)}
              placeholder={`${tr('qtf_option', 'Option')} ${letterFor(index)}`}
              disabled={disabled}
            />
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => setState(removeOptionAt(state, index))}
              disabled={disabled || options.length <= 2}
              aria-label={tr('qtf_remove', 'Remove')}
              title={tr('qtf_remove', 'Remove')}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={styles.addBtn} onClick={addOption} disabled={disabled}>
          + {tr('qtf_add_option', 'Add option')}
        </button>
      </div>
    )
  }

  // ---- TRUE / FALSE ----
  if (normalized === 'TRUEFALSE') {
    const value = state.booleanAnswer === 'False' ? 'False' : 'True'
    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_correct_answer', 'Correct answer')}</div>
        <div className={styles.boolRow}>
          {['True', 'False'].map((option) => (
            <label key={option} className={styles.boolOption}>
              <input
                type="radio"
                name={`${groupId}-bool`}
                className={styles.choiceInput}
                checked={value === option}
                onChange={() => setState({ ...state, booleanAnswer: option })}
                disabled={disabled}
              />
              <span>{option === 'True' ? tr('bool_true', 'True') : tr('bool_false', 'False')}</span>
            </label>
          ))}
        </div>
      </div>
    )
  }

  // ---- TEXT (short answer / essay) ----
  if (normalized === 'TEXT') {
    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_model_answer', 'Model answer (optional)')}</div>
        <div className={styles.helper}>{tr('qtf_model_answer_help', 'Used as a reference when grading manually. Leave blank for open-ended questions.')}</div>
        <textarea
          className={styles.textArea}
          rows={3}
          value={state.modelAnswer || ''}
          onChange={(e) => setState({ ...state, modelAnswer: e.target.value })}
          disabled={disabled}
        />
      </div>
    )
  }

  // ---- MATCHING ----
  if (normalized === 'MATCHING') {
    const pairs = state.pairs || []
    const setPair = (index, side, value) =>
      setState({ ...state, pairs: pairs.map((pair, i) => (i === index ? { ...pair, [side]: value } : pair)) })
    const addPair = () => setState({ ...state, pairs: [...pairs, { left: '', right: '' }] })
    const removePair = (index) => setState({ ...state, pairs: pairs.filter((_, i) => i !== index) })

    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_matching_pairs', 'Matching pairs')}</div>
        <div className={styles.helper}>{tr('qtf_matching_help', 'Each left item is the correct match for the right item on the same row.')}</div>
        <div className={styles.pairHeader}>
          <span>{tr('qtf_left', 'Left')}</span>
          <span>{tr('qtf_right', 'Right (correct match)')}</span>
        </div>
        {pairs.map((pair, index) => (
          <div key={index} className={styles.pairRow}>
            <span className={styles.optionLetter}>{letterFor(index)}</span>
            <input
              type="text"
              className={styles.textInput}
              value={pair.left}
              onChange={(e) => setPair(index, 'left', e.target.value)}
              placeholder={tr('qtf_left', 'Left')}
              disabled={disabled}
            />
            <input
              type="text"
              className={styles.textInput}
              value={pair.right}
              onChange={(e) => setPair(index, 'right', e.target.value)}
              placeholder={tr('qtf_right', 'Right (correct match)')}
              disabled={disabled}
            />
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => removePair(index)}
              disabled={disabled || pairs.length <= 1}
              aria-label={tr('qtf_remove', 'Remove')}
              title={tr('qtf_remove', 'Remove')}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={styles.addBtn} onClick={addPair} disabled={disabled}>
          + {tr('qtf_add_pair', 'Add pair')}
        </button>
      </div>
    )
  }

  // ---- ORDERING ----
  if (normalized === 'ORDERING') {
    const options = state.options || []
    const move = (index, delta) => {
      const target = index + delta
      if (target < 0 || target >= options.length) return
      const next = [...options]
      ;[next[index], next[target]] = [next[target], next[index]]
      setState({ ...state, options: next })
    }
    const dropOnto = (targetIndex) => {
      if (dragIndex === null || dragIndex === targetIndex) { setDragIndex(null); return }
      const next = [...options]
      const [moved] = next.splice(dragIndex, 1)
      next.splice(targetIndex, 0, moved)
      setState({ ...state, options: next })
      setDragIndex(null)
    }
    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_ordering_items', 'Items in correct order')}</div>
        <div className={styles.helper}>{tr('qtf_ordering_help', 'Drag the handle (or use the arrows) to set the correct order, top to bottom. Items are shuffled for the learner.')}</div>
        {options.map((option, index) => (
          <div
            key={index}
            className={`${styles.optionRow} ${dragIndex === index ? styles.dragging : ''}`}
            draggable={!disabled}
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => { e.preventDefault() }}
            onDrop={() => dropOnto(index)}
            onDragEnd={() => setDragIndex(null)}
          >
            <span className={styles.dragHandle} aria-hidden="true" title={tr('qtf_drag_reorder', 'Drag to reorder')}>⠿</span>
            <span className={styles.optionLetter}>{index + 1}</span>
            <input
              type="text"
              className={styles.textInput}
              value={option}
              onChange={(e) => setOption(index, e.target.value)}
              placeholder={`${tr('qtf_item', 'Item')} ${index + 1}`}
              disabled={disabled}
            />
            <button type="button" className={styles.moveBtn} onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={tr('qtf_move_up', 'Move up')} title={tr('qtf_move_up', 'Move up')}>↑</button>
            <button type="button" className={styles.moveBtn} onClick={() => move(index, 1)} disabled={disabled || index === options.length - 1} aria-label={tr('qtf_move_down', 'Move down')} title={tr('qtf_move_down', 'Move down')}>↓</button>
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => setState(removeOptionAt(state, index))}
              disabled={disabled || options.length <= 2}
              aria-label={tr('qtf_remove', 'Remove')}
              title={tr('qtf_remove', 'Remove')}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={styles.addBtn} onClick={addOption} disabled={disabled}>
          + {tr('qtf_add_item', 'Add item')}
        </button>
      </div>
    )
  }

  // ---- FILLINBLANK ----
  if (normalized === 'FILLINBLANK') {
    const options = state.options || []
    return (
      <div className={styles.fields}>
        <div className={styles.label}>{tr('qtf_acceptable_answers', 'Acceptable answers')}</div>
        <div className={styles.helper}>{tr('qtf_fillinblank_help', 'Any one of these answers is accepted as correct.')}</div>
        {options.map((option, index) => (
          <div key={index} className={styles.optionRow}>
            <input
              type="text"
              className={styles.textInput}
              value={option}
              onChange={(e) => setOption(index, e.target.value)}
              placeholder={`${tr('qtf_answer', 'Answer')} ${index + 1}`}
              disabled={disabled}
            />
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => setState(removeOptionAt(state, index))}
              disabled={disabled || options.length <= 1}
              aria-label={tr('qtf_remove', 'Remove')}
              title={tr('qtf_remove', 'Remove')}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={styles.addBtn} onClick={addOption} disabled={disabled}>
          + {tr('qtf_add_answer', 'Add acceptable answer')}
        </button>
      </div>
    )
  }

  return null
}
