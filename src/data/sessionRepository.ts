import type { DashboardSnapshot, SessionRepository } from '../types'

class CopilotSdkSessionRepository implements SessionRepository {
  async getDashboard(): Promise<DashboardSnapshot> {
    const response = await fetch('/api/sessions')
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      throw new Error(body?.error || 'Unable to load Copilot sessions.')
    }
    return (await response.json()) as DashboardSnapshot
  }
}

export const sessionRepository: SessionRepository =
  new CopilotSdkSessionRepository()
