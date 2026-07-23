export type CopilotInteraction =
  | {
      requestId: string
      kind: 'permission'
      permissionKind: string
      title: string
      detail: string
      canApproveSession: boolean
      elevated: boolean
    }
  | {
      requestId: string
      kind: 'user-input'
      question: string
      choices: string[]
      allowFreeform: boolean
    }
  | {
      requestId: string
      kind: 'plan'
      summary: string
      planContent: string
      actions: string[]
      recommendedAction: string
    }

export type CopilotInteractionResponse =
  | {
      decision: 'approve-once' | 'approve-for-session' | 'reject'
      feedback?: string
    }
  | { answer: string; wasFreeform: boolean }
  | {
      approved: boolean
      selectedAction?: string
      feedback?: string
    }

export type CopilotStreamEvent =
  | {
      type: 'session'
      runId: string
      sessionId: string
      allowTools: boolean
    }
  | { type: 'ready'; runId: string }
  | { type: 'steer-accepted'; requestId: string; messageId: string }
  | { type: 'status'; status: 'thinking' | 'reasoning' | 'idle' }
  | { type: 'delta'; content: string }
  | { type: 'message'; model: string | null; outputTokens: number | null }
  | { type: 'tool'; name: string; status: 'running' | 'complete' }
  | {
      type: 'progress'
      id: string
      kind: 'intent' | 'reasoning' | 'tool'
      label: string
      status: 'running' | 'complete'
    }
  | ({ type: 'interaction' } & CopilotInteraction)
  | { type: 'interaction-resolved'; requestId: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string }

interface StreamMessageOptions {
  message: string
  sessionId?: string
  mode: 'interactive' | 'plan' | 'autopilot'
  allowTools: boolean
  signal: AbortSignal
  onEvent: (event: CopilotStreamEvent) => void
}

export async function respondToCopilotInteraction(
  runId: string,
  requestId: string,
  value: CopilotInteractionResponse,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/runs/${runId}/interactions/${requestId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      signal,
    },
  )
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error || 'Unable to submit this response.')
  }
}

export async function steerCopilotRun(
  runId: string,
  requestId: string,
  message: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/runs/${runId}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, message }),
    signal,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error || 'Unable to steer this Copilot run.')
  }
  return (await response.json()) as { ok: true; messageId: string }
}

function parseEvent(block: string): CopilotStreamEvent | null {
  let eventType = ''
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }

  if (!eventType || dataLines.length === 0) return null

  try {
    return {
      type: eventType,
      ...JSON.parse(dataLines.join('\n')),
    } as CopilotStreamEvent
  } catch {
    return null
  }
}

export async function streamCopilotMessage({
  message,
  sessionId,
  mode,
  allowTools,
  signal,
  onEvent,
}: StreamMessageOptions) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, mode, allowTools }),
    signal,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error || `Chat request failed (${response.status}).`)
  }
  if (!response.body) throw new Error('Streaming is unavailable in this browser.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const event = parseEvent(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (event) onEvent(event)
      boundary = buffer.indexOf('\n\n')
    }

    if (done) break
  }

  const finalEvent = parseEvent(buffer)
  if (finalEvent) onEvent(finalEvent)
}

export async function getBridgeHealth(signal?: AbortSignal) {
  const response = await fetch('/api/health', { signal })
  if (!response.ok) throw new Error('Copilot bridge is unavailable.')
  return (await response.json()) as {
    ok: boolean
    workspaceRoot: string
    activeRuns: number
  }
}

export interface SessionHistoryMessage {
  id: string
  role: 'assistant' | 'progress' | 'user'
  content: string
  timestamp: string
  progressKind?: 'intent' | 'reasoning' | 'tool'
  label?: string
  status?: 'running' | 'complete'
}

export async function getSessionHistory(
  sessionId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, { signal })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error || 'Unable to load session history.')
  }
  const body = (await response.json()) as {
    messages: SessionHistoryMessage[]
  }
  return body.messages
}
