import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminCategories from './AdminCategories'

const categoriesMock = vi.fn()
const createCategoryMock = vi.fn()
const updateCategoryMock = vi.fn()
const deleteCategoryMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    categories: (...args) => categoriesMock(...args),
    createCategory: (...args) => createCategoryMock(...args),
    updateCategory: (...args) => updateCategoryMock(...args),
    deleteCategory: (...args) => deleteCategoryMock(...args),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    user: { role: 'ADMIN' },
  }),
}))

describe('AdminCategories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createCategoryMock.mockResolvedValue({ data: {} })
    updateCategoryMock.mockResolvedValue({ data: {} })
    deleteCategoryMock.mockResolvedValue({ data: {} })
    categoriesMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({
        data: [
          { id: 'cat-1', name: 'Core Assessments', type: 'TEST', description: 'Main test category' },
          { id: 'cat-2', name: 'Onboarding', type: 'TRAINING', description: 'Training path' },
        ],
      })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a retry path after loading fails', async () => {
    render(<AdminCategories />)

    await waitFor(() => expect(screen.getByText('Could not load categories.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('Core Assessments')).toBeTruthy())
  })

  it('shows a filter-specific empty state and restores the full list when filters are cleared', async () => {
    render(<AdminCategories />)

    await waitFor(() => expect(screen.getByText('Could not load categories.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Core Assessments')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Search categories by name or description...'), {
      target: { value: 'missing' },
    })

    await waitFor(() => expect(screen.getByText('No categories match your search')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1))

    await waitFor(() => expect(screen.getByText('Core Assessments')).toBeTruthy())
  })
})
