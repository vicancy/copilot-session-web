import { spawn } from 'node:child_process'
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

  const client = await getSdkClient()
  const session = await client.resumeSession(sessionId, {
    suppressResumeEvent: true,
    streaming: false,
    workingDirectory: await getTrustedWorkingDirectory(sessionId),
  })

  try {
    const events = await session.getEvents()
    const messages = events
      .filter(
        (event) =>
          event.type === 'user.message' || event.type === 'assistant.message',
      )
      .map((event) => ({
        id: event.id,
        role: event.type === 'user.message' ? 'user' : 'assistant',
        content: truncateContent(event.data?.content, 20_000),
        timestamp: event.timestamp,
      }))
      .filter((message) => message.content)

    return messages
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
  } finally {
    await session.disconnect()
  }
}

function getCopilotLaunch() {
  if (process.env.COPILOT_CLI_ENTRY) {
    return {
      command: process.execPath,
      prefixArguments: [resolve(process.env.COPILOT_CLI_ENTRY)],
    }
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    const loader = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@github',
      'copilot',
      'npm-loader.js',
    )
    if (existsSync(loader)) {
      return { command: process.execPath, prefixArguments: [loader] }
    }
  }

  return { command: 'copilot', prefixArguments: [] }
}

function normalizeToolEvent(event) {
  const data = event.data || {}
  const request = data.toolRequest || data.request || {}
  const name =
    data.toolName ||
    data.name ||
    request.toolName ||
    request.name ||
    'Copilot tool'

  return {
    name: String(name),
    status: event.type.endsWith('complete') ? 'complete' : 'running',
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
  const launch = getCopilotLaunch()
  const argumentsList = [
    ...launch.prefixArguments,
    '-p',
    message,
    '--session-id',
    sessionId,
    '--mode',
    mode,
    '--allow-all-tools',
    '--output-format',
    'json',
    '--stream',
    'on',
    '--no-color',
    '--no-auto-update',
    '--no-ask-user',
    '--no-remote-export',
    '-C',
    runWorkspace,
  ]

  if (!allowTools) {
    argumentsList.push('--deny-tool=shell', '--deny-tool=write')
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  writeEvent(response, 'session', { runId, sessionId, allowTools })

  const child = spawn(launch.command, argumentsList, {
    cwd: runWorkspace,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  activeRuns.set(runId, child)
  let stdoutBuffer = ''
  let stderr = ''
  let receivedDelta = false
  let completed = false

  const processLine = (line) => {
    if (!line.trim()) return

    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }

    switch (event.type) {
      case 'assistant.turn_start':
        writeEvent(response, 'status', { status: 'thinking' })
        break
      case 'assistant.message_delta': {
        const content = event.data?.deltaContent
        if (typeof content === 'string' && content) {
          receivedDelta = true
          writeEvent(response, 'delta', { content })
        }
        break
      }
      case 'assistant.message':
        if (!receivedDelta && typeof event.data?.content === 'string') {
          writeEvent(response, 'delta', { content: event.data.content })
        }
        writeEvent(response, 'message', {
          model: event.data?.model || null,
          outputTokens: event.data?.outputTokens || null,
        })
        break
      case 'tool.execution_start':
      case 'tool.execution_complete':
        writeEvent(response, 'tool', normalizeToolEvent(event))
        break
      case 'assistant.idle':
        writeEvent(response, 'status', { status: 'idle' })
        break
      default:
        if (event.type?.startsWith('assistant.reasoning')) {
          writeEvent(response, 'status', { status: 'reasoning' })
        }
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      processLine(stdoutBuffer.slice(0, newlineIndex))
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8_000) stderr += chunk
  })

  child.on('error', (error) => {
    completed = true
    activeRuns.delete(runId)
    writeEvent(response, 'error', {
      message: `Unable to start Copilot CLI: ${error.message}`,
    })
    response.end()
  })

  child.on('close', (exitCode) => {
    if (completed) return
    completed = true
    activeRuns.delete(runId)
    processLine(stdoutBuffer)

    if (exitCode === 0) {
      sessionCatalogUpdatedAt = 0
      writeEvent(response, 'done', { sessionId })
    } else {
      writeEvent(response, 'error', {
        message:
          stderr.trim() ||
          `Copilot CLI exited with code ${exitCode ?? 'unknown'}.`,
      })
    }
    response.end()
  })

  response.on('close', () => {
    if (!completed && child.exitCode === null) {
      child.kill()
      activeRuns.delete(runId)
    }
  })
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
  for (const child of activeRuns.values()) child.kill()
  if (sdkClient) await sdkClient.stop()
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
