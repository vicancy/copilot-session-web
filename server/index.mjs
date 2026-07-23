import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import { CopilotClient } from '@github/copilot-sdk'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(serverDirectory, '..')
const distRoot = join(appRoot, 'dist')
const workspaceRoot = resolve(
  process.env.COPILOT_WORKSPACE_ROOT || appRoot,
)
const host = '127.0.0.1'
const port = Number(process.env.PORT || 8787)
const activeRuns = new Map()
const sessionCatalog = new Map()
let sessionCatalogUpdatedAt = 0
let sdkClient
let sdkClientPromise

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function readJson(request) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) {
      throw new Error('Request body is too large.')
    }
    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function writeEvent(response, event, data) {
  if (response.destroyed || response.writableEnded) return
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function isSessionId(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

function compactText(value, maximumLength) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 1)}…`
    : normalized
}

function truncateContent(value, maximumLength) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 1)}…`
    : normalized
}

function getSessionSource(clientName, workingDirectory) {
  if (clientName === 'github/autopilot') return 'copilot-app'
  if (clientName === 'github/cli') return 'copilot-cli'

  const normalized = String(workingDirectory || '')
    .replace(/\//g, '\\')
    .toLowerCase()
  return normalized.includes('\\.copilot\\chats\\') ||
    normalized.includes('\\.copilot\\repos\\copilot-worktrees\\')
    ? 'copilot-app'
    : 'copilot-cli'
}

function projectIdentity(metadata) {
  const context = metadata.context || {}
  const repository = compactText(context.repository, 160)
  const workingDirectory = context.workingDirectory || ''
  const normalizedDirectory = String(workingDirectory).replace(/\//g, '\\')
  const worktreeMatch = normalizedDirectory.match(
    /\\\.copilot\\repos\\copilot-worktrees\\([^\\]+)/i,
  )
  const fallbackName =
    worktreeMatch?.[1] ||
    basename(normalizedDirectory) ||
    (metadata.isRemote ? 'Remote sessions' : 'Copilot sessions')
  const name = repository ? repository.split('/').at(-1) : fallbackName
  const owner = repository.includes('/')
    ? repository.split('/')[0]
    : metadata.isRemote
      ? 'GitHub'
      : 'Local'
  const key = repository || worktreeMatch?.[1] || normalizedDirectory || owner

  return {
    id: createHash('sha1').update(key.toLowerCase()).digest('hex').slice(0, 12),
    name,
    owner,
    repository: repository || name,
  }
}

function toDashboardSnapshot(metadataList) {
  const palette = ['#8b5fb4', '#4588cf', '#35a36f', '#d4923b', '#be5f79']
  const projectsById = new Map()
  const sessions = metadataList.map((metadata) => {
    const project = projectIdentity(metadata)
    const context = metadata.context || {}
    const source = getSessionSource(
      metadata.clientName,
      context.workingDirectory,
    )
    const summary =
      compactText(metadata.name || metadata.summary, 320) ||
      `Copilot session ${metadata.sessionId.slice(0, 8)}`
    const title = compactText(summary, 88)

    if (!projectsById.has(project.id)) {
      projectsById.set(project.id, {
        ...project,
        color: palette[projectsById.size % palette.length],
        sessionCount: 0,
        activeCount: 0,
      })
    }
    projectsById.get(project.id).sessionCount += 1

    return {
      id: metadata.sessionId,
      title,
      projectId: project.id,
      repository: context.repository || project.repository,
      branch: context.branch || 'No branch',
      status: 'idle',
      mode: 'interactive',
      summary,
      updatedAt: new Date(metadata.modifiedTime).toISOString(),
      createdAt: new Date(metadata.startTime).toISOString(),
      progress: 0,
      unread: false,
      source,
      clientName: metadata.clientName || 'unknown',
      isRemote: metadata.isRemote,
      workingDirectory: context.workingDirectory || '',
      changes: { files: 0, additions: 0, deletions: 0 },
      activities: [
        {
          kind: 'status',
          label:
            source === 'copilot-app'
              ? 'Synced from Copilot App'
              : 'Synced from Copilot shared store',
          detail: metadata.isRemote ? 'Remote session' : 'Local session',
          time: 'saved',
        },
      ],
    }
  })

  return {
    projects: [...projectsById.values()].sort(
      (left, right) => right.sessionCount - left.sessionCount,
    ),
    sessions,
    lastSyncedAt: new Date().toISOString(),
  }
}

async function getSdkClient() {
  if (sdkClient) return sdkClient
  if (!sdkClientPromise) {
    sdkClientPromise = (async () => {
      const client = new CopilotClient({
        workingDirectory: workspaceRoot,
        logLevel: 'error',
      })
      await client.start()
      sdkClient = client
      return client
    })().catch((error) => {
      sdkClientPromise = undefined
      throw error
    })
  }
  return sdkClientPromise
}

async function refreshSessionCatalog(force = false) {
  if (
    !force &&
    sessionCatalog.size > 0 &&
    Date.now() - sessionCatalogUpdatedAt < 15_000
  ) {
    return [...sessionCatalog.values()]
  }

  const client = await getSdkClient()
  const [metadata, rawSessionList] = await Promise.all([
    client.listSessions(),
    client.rpc.sessions.list({ metadataLimit: 500 }),
  ])
  const rawMetadataById = new Map(
    rawSessionList.sessions.map((session) => [session.sessionId, session]),
  )
  for (const session of metadata) {
    const rawMetadata = rawMetadataById.get(session.sessionId)
    session.clientName = rawMetadata?.clientName
    session.name = rawMetadata?.name
  }
  metadata.sort(
    (left, right) =>
      new Date(right.modifiedTime).getTime() -
      new Date(left.modifiedTime).getTime(),
  )
  sessionCatalog.clear()
  for (const session of metadata) sessionCatalog.set(session.sessionId, session)
  sessionCatalogUpdatedAt = Date.now()
  return metadata
}

async function getTrustedWorkingDirectory(sessionId) {
  if (!sessionId) return workspaceRoot
  let metadata = sessionCatalog.get(sessionId)
  if (!metadata) {
    await refreshSessionCatalog(true)
    metadata = sessionCatalog.get(sessionId)
  }

  const candidate = metadata?.context?.workingDirectory
  return candidate && existsSync(candidate) ? resolve(candidate) : workspaceRoot
}

async function getSessionMessages(sessionId) {
  await refreshSessionCatalog()
  const metadata = sessionCatalog.get(sessionId)
  if (!metadata) return null

  const activeRun = [...activeRuns.values()].find(
    (run) => run.sessionId === sessionId && run.session,
  )
  if (activeRun) {
    return normalizeSessionMessages(await activeRun.session.getEvents())
  }

  const client = await getSdkClient()
  const session = await client.resumeSession(sessionId, {
    suppressResumeEvent: true,
    streaming: false,
    workingDirectory: await getTrustedWorkingDirectory(sessionId),
  })

  try {
    return normalizeSessionMessages(await session.getEvents())
  } finally {
    await session.disconnect()
  }
}

function normalizeSessionMessages(events) {
  const timeline = []
  const progressIndexes = new Map()
  const toolNames = new Map()

  const upsertProgress = (entry) => {
    const existingIndex = progressIndexes.get(entry.id)
    if (existingIndex === undefined) {
      progressIndexes.set(entry.id, timeline.length)
      timeline.push(entry)
    } else {
      timeline[existingIndex] = { ...timeline[existingIndex], ...entry }
    }
  }

  for (const event of events) {
    if (event.agentId) continue

    if (event.type === 'user.message' || event.type === 'assistant.message') {
      const content = truncateContent(event.data?.content, 20_000)
      if (content) {
        timeline.push({
          id: event.id,
          role: event.type === 'user.message' ? 'user' : 'assistant',
          content,
          timestamp: event.timestamp,
        })
      }
    } else if (event.type === 'assistant.intent') {
      const label = compactText(event.data?.intent, 500)
      if (label) {
        upsertProgress({
          id: event.id,
          role: 'progress',
          progressKind: 'intent',
          label,
          status: 'complete',
          content: '',
          timestamp: event.timestamp,
        })
      }
    } else if (event.type === 'assistant.reasoning') {
      upsertProgress({
        id: `reasoning-${event.data?.reasoningId || event.id}`,
        role: 'progress',
        progressKind: 'reasoning',
        label: 'Reasoning complete',
        status: 'complete',
        content: '',
        timestamp: event.timestamp,
      })
    } else if (
      event.type === 'tool.execution_start' ||
      event.type === 'tool.execution_complete'
    ) {
      const toolCallId = event.data?.toolCallId || event.id
      if (event.data?.toolName) {
        toolNames.set(toolCallId, String(event.data.toolName))
      }
      const tool = normalizeToolEvent(event, toolNames.get(toolCallId))
      upsertProgress({
        id: `tool-${toolCallId}`,
        role: 'progress',
        progressKind: 'tool',
        label: tool.name,
        status: tool.status,
        content: '',
        timestamp: event.timestamp,
      })
    }
  }

  return timeline
    .reduce((grouped, message) => {
      const previous = grouped[grouped.length - 1]
      if (message.role === 'assistant' && previous?.role === 'assistant') {
        grouped[grouped.length - 1] = {
          ...previous,
          content: `${previous.content}\n\n${message.content}`,
          timestamp: message.timestamp,
        }
      } else {
        grouped.push(message)
      }
      return grouped
    }, [])
    .slice(-100)
}

function normalizeToolEvent(event, knownName = '') {
  const data = event.data || {}
  const request = data.toolRequest || data.request || {}
  const name =
    data.toolName ||
    data.name ||
    request.toolName ||
    request.name ||
    knownName ||
    'Copilot tool'

  return {
    name: String(name),
    status: event.type.endsWith('complete') ? 'complete' : 'running',
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function describePermission(request) {
  const kind = String(request?.kind || 'tool')
  let title = 'Allow Copilot tool'
  let detail = ''

  switch (kind) {
    case 'shell':
      title = request.intention || 'Run a shell command'
      detail = request.fullCommandText
      break
    case 'write':
      title = request.intention || 'Modify a file'
      detail = [request.fileName, request.diff].filter(Boolean).join('\n\n')
      break
    case 'read':
      title = 'Read a file'
      detail = request.fileName || request.path || ''
      break
    case 'url':
      title = 'Access a URL'
      detail = request.url || request.domain || ''
      break
    case 'mcp':
      title = `Use ${request.toolName || 'an MCP tool'}`
      detail = [
        request.serverName || request.mcpServerName,
        safeJson(request.args),
      ]
        .filter(Boolean)
        .join('\n')
      break
    case 'custom-tool':
      title = `Use ${request.toolName || 'a custom tool'}`
      detail = safeJson(request.args)
      break
    default:
      title = `Allow ${kind.replace(/[-_]/g, ' ')}`
      detail = safeJson(request)
  }

  return {
    kind: 'permission',
    permissionKind: kind,
    title: compactText(title, 240),
    detail: typeof detail === 'string' ? detail.trim() : '',
    canApproveSession: request?.canOfferSessionApproval === true,
    elevated: request?.requestSandboxBypass === true,
  }
}

function unavailableInteractionResult(interaction) {
  switch (interaction.kind) {
    case 'permission':
      return {
        kind: 'reject',
        feedback: 'The browser disconnected before a decision was made.',
      }
    case 'user-input':
      return {
        answer: 'The user is no longer available.',
        wasFreeform: true,
      }
    case 'plan':
      return {
        approved: false,
        feedback: 'The browser disconnected before approving the plan.',
      }
  }
}

function requestInteraction(run, interaction) {
  if (run.closed) {
    return Promise.resolve(unavailableInteractionResult(interaction))
  }

  const requestId = randomUUID()
  return new Promise((resolveInteraction) => {
    run.pendingInteractions.set(requestId, {
      interaction: { requestId, ...interaction },
      resolve: resolveInteraction,
    })
    writeEvent(run.response, 'interaction', { requestId, ...interaction })
  })
}

function settlePendingInteractions(run) {
  for (const pending of run.pendingInteractions.values()) {
    pending.resolve(unavailableInteractionResult(pending.interaction))
  }
  run.pendingInteractions.clear()
}

async function closeRun(run, abort = false) {
  if (run.closed) return
  run.closed = true
  settlePendingInteractions(run)
  run.unsubscribe?.()

  if (run.session) {
    if (abort) await run.session.abort().catch(() => {})
    await run.session.disconnect().catch(() => {})
  }
  activeRuns.delete(run.runId)
}

function processSessionEvent(run, event) {
  if (event.agentId) return

  switch (event.type) {
    case 'assistant.turn_start':
      run.currentMessageStreamed = false
      writeEvent(run.response, 'status', { status: 'thinking' })
      break
    case 'assistant.intent':
      writeEvent(run.response, 'progress', {
        id: event.id,
        kind: 'intent',
        label: compactText(event.data?.intent, 500) || 'Planning next step',
        status: 'complete',
      })
      break
    case 'assistant.reasoning_delta':
      writeEvent(run.response, 'progress', {
        id: `reasoning-${event.data?.reasoningId || event.id}`,
        kind: 'reasoning',
        label: 'Reasoning',
        status: 'running',
      })
      writeEvent(run.response, 'status', { status: 'reasoning' })
      break
    case 'assistant.reasoning':
      writeEvent(run.response, 'progress', {
        id: `reasoning-${event.data?.reasoningId || event.id}`,
        kind: 'reasoning',
        label: 'Reasoning complete',
        status: 'complete',
      })
      break
    case 'assistant.message_start':
      run.currentMessageStreamed = false
      break
    case 'assistant.message_delta': {
      const content = event.data?.deltaContent
      if (typeof content === 'string' && content) {
        run.currentMessageStreamed = true
        writeEvent(run.response, 'delta', { content })
      }
      break
    }
    case 'assistant.message':
      if (
        !run.currentMessageStreamed &&
        typeof event.data?.content === 'string'
      ) {
        writeEvent(run.response, 'delta', { content: event.data.content })
      }
      run.currentMessageStreamed = false
      writeEvent(run.response, 'message', {
        model: event.data?.model || null,
        outputTokens: event.data?.outputTokens || null,
      })
      break
    case 'tool.execution_start':
    case 'tool.execution_complete': {
      const toolCallId = event.data?.toolCallId || event.id
      if (event.data?.toolName) {
        run.toolNames.set(toolCallId, String(event.data.toolName))
      }
      const tool = normalizeToolEvent(event, run.toolNames.get(toolCallId))
      writeEvent(run.response, 'tool', tool)
      writeEvent(run.response, 'progress', {
        id: `tool-${toolCallId}`,
        kind: 'tool',
        label: tool.name,
        status: tool.status,
      })
      break
    }
    case 'assistant.idle':
    case 'session.idle':
      writeEvent(run.response, 'status', { status: 'idle' })
      break
    case 'session.error':
      writeEvent(run.response, 'error', {
        message: event.data?.message || 'Copilot session failed.',
      })
      break
  }
}

async function streamCopilot(request, response, body) {
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const mode = ['interactive', 'plan', 'autopilot'].includes(body.mode)
    ? body.mode
    : 'interactive'

  if (!message) {
    sendJson(response, 400, { error: 'Message is required.' })
    return
  }
  if (message.length > 16_000) {
    sendJson(response, 400, { error: 'Message must be 16,000 characters or less.' })
    return
  }
  if (body.sessionId && !isSessionId(body.sessionId)) {
    sendJson(response, 400, { error: 'sessionId must be a UUID.' })
    return
  }

  const sessionId = body.sessionId || randomUUID()
  const runId = randomUUID()
  const allowTools = body.allowTools === true
  const runWorkspace = await getTrustedWorkingDirectory(body.sessionId)

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  const run = {
    runId,
    sessionId,
    response,
    session: null,
    unsubscribe: null,
    pendingInteractions: new Map(),
    currentMessageStreamed: false,
    toolNames: new Map(),
    completed: false,
    closed: false,
  }
  activeRuns.set(runId, run)
  writeEvent(response, 'session', { runId, sessionId, allowTools })

  const sessionConfig = {
    clientName: 'copilot-session-web',
    workingDirectory: runWorkspace,
    streaming: true,
    includeSubAgentStreamingEvents: false,
    enableConfigDiscovery: true,
    onPermissionRequest: async (permissionRequest) => {
      if (run.closed) {
        return unavailableInteractionResult({ kind: 'permission' })
      }
      if (allowTools) return { kind: 'approve-once' }
      return requestInteraction(run, describePermission(permissionRequest))
    },
    onUserInputRequest: (inputRequest) =>
      requestInteraction(run, {
        kind: 'user-input',
        question: truncateContent(inputRequest.question, 4_000),
        choices: Array.isArray(inputRequest.choices)
          ? inputRequest.choices.slice(0, 20).map((choice) => String(choice))
          : [],
        allowFreeform: inputRequest.allowFreeform !== false,
      }),
    onExitPlanModeRequest: (planRequest) =>
      requestInteraction(run, {
        kind: 'plan',
        summary: truncateContent(planRequest.summary, 4_000),
        planContent: truncateContent(planRequest.planContent, 20_000),
        actions: planRequest.actions.map(String),
        recommendedAction: String(planRequest.recommendedAction),
      }),
  }

  response.on('close', () => {
    if (!run.completed) void closeRun(run, true)
  })

  let completedNormally = false
  try {
    const client = await getSdkClient()
    run.session = body.sessionId
      ? await client.resumeSession(sessionId, {
          ...sessionConfig,
          suppressResumeEvent: true,
          continuePendingWork: true,
        })
      : await client.createSession({
          ...sessionConfig,
          sessionId,
        })
    if (run.closed) {
      await run.session.abort().catch(() => {})
      await run.session.disconnect().catch(() => {})
      return
    }
    run.unsubscribe = run.session.on((event) => processSessionEvent(run, event))

    await run.session.sendAndWait(
      { prompt: message, agentMode: mode },
      30 * 60 * 1_000,
    )
    completedNormally = true
    if (!run.closed) {
      sessionCatalogUpdatedAt = 0
      writeEvent(response, 'done', { sessionId })
    }
  } catch (error) {
    if (!run.closed) {
      writeEvent(response, 'error', {
        message:
          error instanceof Error ? error.message : 'Copilot session failed.',
      })
    }
  } finally {
    run.completed = true
    await closeRun(run, !completedNormally)
    if (!response.writableEnded) response.end()
  }
}

function resolveInteraction(run, requestId, body) {
  const pending = run.pendingInteractions.get(requestId)
  if (!pending) {
    return { status: 409, error: 'This interaction is no longer pending.' }
  }

  const { interaction } = pending
  let result

  if (interaction.kind === 'permission') {
    const decisions = ['approve-once', 'approve-for-session', 'reject']
    if (!decisions.includes(body.decision)) {
      return { status: 400, error: 'Invalid permission decision.' }
    }
    if (
      body.decision === 'approve-for-session' &&
      !interaction.canApproveSession
    ) {
      return {
        status: 400,
        error: 'Session approval is unavailable for this request.',
      }
    }
    result =
      body.decision === 'reject'
        ? {
            kind: 'reject',
            feedback: compactText(body.feedback, 500) || undefined,
          }
        : { kind: body.decision }
  } else if (interaction.kind === 'user-input') {
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    const wasFreeform = body.wasFreeform === true
    if (!answer || answer.length > 4_000) {
      return {
        status: 400,
        error: 'An answer between 1 and 4,000 characters is required.',
      }
    }
    if (wasFreeform && !interaction.allowFreeform) {
      return { status: 400, error: 'Free-form answers are not allowed.' }
    }
    if (!wasFreeform && !interaction.choices.includes(answer)) {
      return { status: 400, error: 'Select one of the available choices.' }
    }
    result = { answer, wasFreeform }
  } else if (interaction.kind === 'plan') {
    if (typeof body.approved !== 'boolean') {
      return { status: 400, error: 'Plan approval is required.' }
    }
    const selectedAction =
      typeof body.selectedAction === 'string' ? body.selectedAction : undefined
    if (
      body.approved &&
      (!selectedAction || !interaction.actions.includes(selectedAction))
    ) {
      return { status: 400, error: 'Select an available plan action.' }
    }
    result = {
      approved: body.approved,
      selectedAction: body.approved ? selectedAction : undefined,
      feedback: compactText(body.feedback, 2_000) || undefined,
    }
  }

  run.pendingInteractions.delete(requestId)
  pending.resolve(result)
  writeEvent(run.response, 'interaction-resolved', { requestId })
  return { status: 200, value: { ok: true } }
}

async function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  let normalizedPath
  try {
    normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(
      /^([/\\])+/,
      '',
    )
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path.' })
    return
  }
  let filePath = resolve(distRoot, normalizedPath)
  const relativePath = relative(distRoot, filePath)

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    sendJson(response, 403, { error: 'Forbidden.' })
    return
  }

  try {
    const fileStats = await stat(filePath)
    if (fileStats.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(distRoot, 'index.html')
  }

  try {
    const content = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type':
        contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
    })
    response.end(content)
  } catch {
    sendJson(response, 404, {
      error: 'Production assets are unavailable. Run npm run build first.',
    })
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')

  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const origin = request.headers.origin
  const allowedOrigins = new Set([
    `http://${host}:${port}`,
    'http://127.0.0.1:4174',
    'http://localhost:4174',
  ])

  if (
    url.pathname.startsWith('/api/') &&
    origin &&
    !allowedOrigins.has(origin)
  ) {
    sendJson(response, 403, { error: 'Origin is not allowed.' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      workspaceRoot,
      activeRuns: activeRuns.size,
      knownSessions: sessionCatalog.size,
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    try {
      const metadata = await refreshSessionCatalog(
        url.searchParams.get('refresh') === 'true',
      )
      sendJson(response, 200, toDashboardSnapshot(metadata))
    } catch (error) {
      sendJson(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to list Copilot sessions.',
      })
    }
    return
  }

  const messageRoute = url.pathname.match(
    /^\/api\/sessions\/([0-9a-f-]+)\/messages$/i,
  )
  if (request.method === 'GET' && messageRoute) {
    const sessionId = messageRoute[1]
    if (!isSessionId(sessionId)) {
      sendJson(response, 400, { error: 'Invalid session ID.' })
      return
    }

    try {
      const messages = await getSessionMessages(sessionId)
      if (!messages) {
        sendJson(response, 404, { error: 'Session not found.' })
      } else {
        sendJson(response, 200, { sessionId, messages })
      }
    } catch (error) {
      sendJson(response, 503, {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to read session history.',
      })
    }
    return
  }

  const interactionRoute = url.pathname.match(
    /^\/api\/runs\/([0-9a-f-]+)\/interactions\/([0-9a-f-]+)$/i,
  )
  if (request.method === 'POST' && interactionRoute) {
    const [, runId, requestId] = interactionRoute
    if (!isSessionId(runId) || !isSessionId(requestId)) {
      sendJson(response, 400, { error: 'Invalid interaction identifier.' })
      return
    }
    const run = activeRuns.get(runId)
    if (!run) {
      sendJson(response, 409, { error: 'This Copilot run is no longer active.' })
      return
    }
    try {
      const result = resolveInteraction(run, requestId, await readJson(request))
      sendJson(response, result.status, result.value || { error: result.error })
    } catch (error) {
      sendJson(response, 400, {
        error:
          error instanceof Error ? error.message : 'Invalid interaction response.',
      })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/chat') {
    if (!request.headers['content-type']?.startsWith('application/json')) {
      sendJson(response, 415, { error: 'Content-Type must be application/json.' })
      return
    }
    try {
      await streamCopilot(request, response, await readJson(request))
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid request.',
      })
    }
    return
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API route not found.' })
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' })
    return
  }

  await serveStatic(response, url.pathname)
})

server.listen(port, host, () => {
  console.log(`Copilot bridge listening on http://${host}:${port}`)
  console.log(`Workspace boundary: ${workspaceRoot}`)
})

async function shutdown() {
  await Promise.all(
    [...activeRuns.values()].map(async (run) => {
      run.completed = true
      await closeRun(run, true)
    }),
  )
  if (sdkClient) await sdkClient.stop()
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
