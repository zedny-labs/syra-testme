import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import QuestionTypeFields from './QuestionTypeFields'

afterEach(cleanup)

// Stub translator: returns the key, so the component's tr() falls back to its
// English default string (matching how aria-labels render in the app).
const t = (key) => key

function dataTransfer() {
  return { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(), setDragImage: vi.fn() }
}

describe('QuestionTypeFields ORDERING reordering', () => {
  it('moves an item down when the down arrow is clicked', () => {
    const onChange = vi.fn()
    render(<QuestionTypeFields type="ORDERING" state={{ options: ['A', 'B', 'C'] }} onChange={onChange} t={t} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0])
    expect(onChange).toHaveBeenCalledWith({ options: ['B', 'A', 'C'] })
  })

  it('moves an item up when the up arrow is clicked', () => {
    const onChange = vi.fn()
    render(<QuestionTypeFields type="ORDERING" state={{ options: ['A', 'B', 'C'] }} onChange={onChange} t={t} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[2])
    expect(onChange).toHaveBeenCalledWith({ options: ['A', 'C', 'B'] })
  })

  it('disables move-up on the first row and move-down on the last row', () => {
    render(<QuestionTypeFields type="ORDERING" state={{ options: ['A', 'B', 'C'] }} onChange={() => {}} t={t} />)
    expect(screen.getAllByRole('button', { name: 'Move up' })[0].disabled).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Move down' })[2].disabled).toBe(true)
  })

  it('reorders by dragging a handle onto another row', () => {
    const onChange = vi.fn()
    const { container } = render(
      <QuestionTypeFields type="ORDERING" state={{ options: ['A', 'B', 'C'] }} onChange={onChange} t={t} />,
    )
    const handles = container.querySelectorAll('[draggable="true"]')
    const rows = container.querySelectorAll('[class*="optionRow"]')
    const dt = dataTransfer()
    // drag handle of row 0 onto row 2
    fireEvent.dragStart(handles[0], { dataTransfer: dt })
    fireEvent.dragOver(rows[2], { dataTransfer: dt })
    fireEvent.drop(rows[2], { dataTransfer: dt })
    expect(dt.setData).toHaveBeenCalledWith('text/plain', '0')
    expect(onChange).toHaveBeenCalledWith({ options: ['B', 'C', 'A'] })
  })
})
