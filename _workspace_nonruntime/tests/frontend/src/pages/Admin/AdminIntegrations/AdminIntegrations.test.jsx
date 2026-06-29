import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminIntegrations from './AdminIntegrations'

const settings = vi.fn()
const updateSetting = vi.fn()
const testIntegrations = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    settings: (...args) => settings(...args),
    updateSetting: (...args) => updateSetting(...args),
    testIntegrations: (...args) => testIntegrations(...args),
  },
}))

describe('AdminIntegrations page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.mockResolvedValue({
      data: [
        {
          key: 'integrations_config',
          value: JSON.stringify({
            slack: { enabled: false, url: '', secret: '' },
            s3: { enabled: true, url: 'https://archive.example.com', secret: '' },
          }),
        },
      ],
    })
    updateSetting.mockResolvedValue({ data: {} })
    testIntegrations.mockResolvedValue({ data: { results: { slack: 'sent' } } })
  })

  afterEach(() => {
    cleanup()
  })

  it('hides non-webhook integrations that are not part of the MVP utility flow', async () => {
    render(<AdminIntegrations />)

    await waitFor(() => expect(screen.getByText('Slack')).toBeTruthy())
    expect(screen.queryByText('S3 Storage')).toBeNull()
  })

  it('tests only the selected integration card using the current draft values', async () => {
    render(<AdminIntegrations />)

    await waitFor(() => expect(screen.getByText('Slack')).toBeTruthy())
    const slackCard = screen.getByTestId('integration-card-slack')
    fireEvent.change(within(slackCard).getByLabelText('Webhook URL'), { target: { value: 'https://hooks.slack.test/path' } })

    fireEvent.click(within(slackCard).getByRole('button', { name: /send test notification/i }))

    await waitFor(() => expect(testIntegrations).toHaveBeenCalledWith({
      slack: {
        enabled: true,
        url: 'https://hooks.slack.test/path',
        secret: '',
      },
    }))
    await waitFor(() => expect(within(slackCard).getByText('Last Test Result:')).toBeTruthy())
    expect(within(slackCard).getByText('sent')).toBeTruthy()
  })

  it('shows a filter-specific empty state and restores cards when filters are cleared', async () => {
    render(<AdminIntegrations />)

    await waitFor(() => expect(screen.getByText('Showing 3 of 3 integrations')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Filter by name, description, or URL...'), { target: { value: 'archive provider' } })

    await waitFor(() => expect(screen.getByText('No integrations match your filters')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear Filters' })[0])

    await waitFor(() => expect(screen.getByText('Slack')).toBeTruthy())
    expect(screen.getByText('Showing 3 of 3 integrations')).toBeTruthy()
  })
})
