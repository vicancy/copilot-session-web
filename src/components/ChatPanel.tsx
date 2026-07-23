import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { KeyboardEvent } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronUp,
  CircleHelp,
  CircleStop,
  CornerUpRight,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UserRound,
  Wrench,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getBridgeHealth,
  getSessionHistory,
  respondToCopilotInteraction,
  steerCopilotRun,
  streamCopilotMessage,
} from '../data/copilotClient'
import type {
  CopilotInteraction,
  CopilotInteractionResponse,
  CopilotStreamEvent,
} from '../data/copilotClient'
import type { Session } from '../types'

type MessageRole = 'assistant' | 'error' | 'progress' | 'tool' | 'user'

interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  progressKind?: 'intent' | 'reasoning' | 'tool'
  label?: string
  status?: 'running' | 'complete'
  variant?: 'steering'
}

interface PendingSteering {
  requestId: string
  runId: string
  assistantMessageId: string
  content: string
  acknowledged: boolean
  postComplete: boolean
}

const INITIAL_VISIBLE_ROUNDS = 4
const ROUNDS_PER_PAGE = 4

const sessionStorageKey = (sessionId: string) =>
  `copilot-workspace:cli-session:${sessionId}`
const messageStorageKey = (sessionId: string) =>
  `copilot-workspace:messages:${sessionId}`

function loadMessages(session: Session): ChatMessage[] {
  try {
    const saved = localStorage.getItem(messageStorageKey(session.id))
    if (saved) return JSON.parse(saved) as ChatMessage[]
  } catch {
    // Ignore malformed local data and start a clean conversation.
  }

  return [
    {
      id: 'welcome',
      role: 'assistant',
      content: `Ready to work on ${session.repository}. Messages here start or resume a real local Copilot CLI session.`,
    },
  ]
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  return messages.map((message) => (message.id === id ? updater(message) : message))
}

function groupConversationRounds(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[][]>((rounds, message) => {
    if (rounds.length === 0 || message.role === 'user') {
      rounds.push([message])
    } else {
      rounds[rounds.length - 1].push(message)
    }
    return rounds
  }, [])
}

type TimelineItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'activity'; id: string; entries: ChatMessage[] }

function groupActivityTimeline(messages: ChatMessage[]) {
  return messages.reduce<TimelineItem[]>((items, message) => {
    if (message.role !== 'progress') {
      items.push({ kind: 'message', message })
      return items
    }

    const previous = items[items.length - 1]
    if (previous?.kind === 'activity') {
      previous.entries.push(message)
    } else {
      items.push({
        kind: 'activity',
        id: `activity-${message.id}`,
        entries: [message],
      })
    }
    return items
  }, [])
}

function ActivityTimeline({
  entries,
  initiallyOpen,
}: {
  entries: ChatMessage[]
  initiallyOpen: boolean
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen)

  return (
    <details
      className="activity-timeline"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <Sparkles size={13} />
        Working
        <span>{entries.length} steps</span>
      </summary>
      <div className="activity-steps">
        {entries.map((entry) => (
          <div
            className={`chat-progress ${entry.progressKind || 'intent'}`}
            key={entry.id}
          >
            <span className="progress-step-icon">
              {entry.status === 'running' ? (
                <LoaderCircle size={12} className="spinning" />
              ) : entry.progressKind === 'tool' ? (
                <Wrench size={12} />
              ) : (
                <CheckCircle2 size={12} />
              )}
            </span>
            <span>{entry.label || 'Working'}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function InteractionCard({
  interaction,
  disabled,
  onRespond,
}: {
  interaction: CopilotInteraction
  disabled: boolean
  onRespond: (
    requestId: string,
    value: CopilotInteractionResponse,
  ) => Promise<void>
}) {
  const [answer, setAnswer] = useState('')

  if (interaction.kind === 'permission') {
    return (
      <div className="interaction-card permission-card">
        <div className="interaction-heading">
          <span className="interaction-icon">
            <ShieldAlert size={16} />
          </span>
          <div>
            <small>{interaction.permissionKind} permission</small>
            <strong>{interaction.title}</strong>
          </div>
        </div>
        {interaction.elevated && (
          <div className="interaction-warning">
            <AlertTriangle size={13} />
            This action requests execution outside the sandbox.
          </div>
        )}
        {interaction.detail && <pre>{interaction.detail}</pre>}
        <div className="interaction-actions">
          <button
            className="interaction-button reject"
            type="button"
            disabled={disabled}
            onClick={() =>
              void onRespond(interaction.requestId, { decision: 'reject' })
            }
          >
            Reject
          </button>
          <button
            className="interaction-button"
            type="button"
            disabled={disabled}
            onClick={() =>
              void onRespond(interaction.requestId, {
                decision: 'approve-once',
              })
            }
          >
            Approve once
          </button>
          {interaction.canApproveSession && (
            <button
              className="interaction-button primary"
              type="button"
              disabled={disabled}
              onClick={() =>
                void onRespond(interaction.requestId, {
                  decision: 'approve-for-session',
                })
              }
            >
              Approve session
            </button>
          )}
        </div>
      </div>
    )
  }

  if (interaction.kind === 'plan') {
    return (
      <div className="interaction-card plan-card">
        <div className="interaction-heading">
          <span className="interaction-icon">
            <ListChecks size={16} />
          </span>
          <div>
            <small>Plan ready</small>
            <strong>{interaction.summary || 'Review the proposed plan'}</strong>
          </div>
        </div>
        {interaction.planContent && (
          <details>
            <summary>View full plan</summary>
            <div className="message-markdown interaction-markdown">
              <Markdown remarkPlugins={[remarkGfm]}>
                {interaction.planContent}
              </Markdown>
            </div>
          </details>
        )}
        <div className="interaction-actions">
          <button
            className="interaction-button reject"
            type="button"
            disabled={disabled}
            onClick={() =>
              void onRespond(interaction.requestId, { approved: false })
            }
          >
            Keep planning
          </button>
          {interaction.actions.map((action) => (
            <button
              className={
                action === interaction.recommendedAction
                  ? 'interaction-button primary'
                  : 'interaction-button'
              }
              type="button"
              disabled={disabled}
              key={action}
              onClick={() =>
                void onRespond(interaction.requestId, {
                  approved: true,
                  selectedAction: action,
                })
              }
            >
              {action === interaction.recommendedAction ? 'Recommended: ' : ''}
              {action.replace(/[_-]/g, ' ')}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const submitFreeform = () => {
    const value = answer.trim()
    if (!value) return
    void onRespond(interaction.requestId, {
      answer: value,
      wasFreeform: true,
    })
  }

  return (
    <div className="interaction-card question-card">
      <div className="interaction-heading">
        <span className="interaction-icon">
          <CircleHelp size={16} />
        </span>
        <div>
          <small>Copilot needs your input</small>
          <strong>{interaction.question}</strong>
        </div>
      </div>
      {interaction.choices.length > 0 && (
        <div className="interaction-choices">
          {interaction.choices.map((choice) => (
            <button
              type="button"
              disabled={disabled}
              key={choice}
              onClick={() =>
                void onRespond(interaction.requestId, {
                  answer: choice,
                  wasFreeform: false,
                })
              }
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      {interaction.allowFreeform && (
        <div className="interaction-freeform">
          <input
            value={answer}
            disabled={disabled}
            placeholder="Type another answer..."
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitFreeform()
            }}
          />
          <button
            type="button"
            disabled={disabled || !answer.trim()}
            onClick={submitFreeform}
          >
            Send
          </button>
        </div>
      )}
    </div>
  )
}

export function ChatPanel({ session }: { session: Session }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadMessages(session),
  )
  const [input, setInput] = useState('')
  const [allowTools, setAllowTools] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isSteering, setIsSteering] = useState(false)
  const [runReady, setRunReady] = useState(false)
  const [streamStatus, setStreamStatus] = useState('Ready')
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null)
  const [historyLoading, setHistoryLoading] = useState(
    session.source !== 'local',
  )
  const [interactions, setInteractions] = useState<CopilotInteraction[]>([])
  const [respondingInteractionId, setRespondingInteractionId] = useState('')
  const [interactionError, setInteractionError] = useState('')
  const [visibleRoundCount, setVisibleRoundCount] = useState(
    INITIAL_VISIBLE_ROUNDS,
  )
  const abortController = useRef<AbortController | null>(null)
  const activeRunId = useRef('')
  const activeAssistantMessageId = useRef('')
  const pendingSteering = useRef<PendingSteering | null>(null)
  const activeInteractionResponse = useRef('')
  const messagesContainer = useRef<HTMLDivElement | null>(null)
  const scrollAnchor = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestore = useRef<{
    scrollHeight: number
    scrollTop: number
  } | null>(null)

  const conversationRounds = useMemo(
    () => groupConversationRounds(messages),
    [messages],
  )
  const hiddenRoundCount = Math.max(
    0,
    conversationRounds.length - visibleRoundCount,
  )
  const roundsToLoad = Math.min(ROUNDS_PER_PAGE, hiddenRoundCount)
  const visibleMessages = conversationRounds
    .slice(-visibleRoundCount)
    .flat()
  const visibleTimeline = groupActivityTimeline(visibleMessages)

  useEffect(() => {
    const controller = new AbortController()
    getBridgeHealth(controller.signal)
      .then(() => setBridgeOnline(true))
      .catch(() => setBridgeOnline(false))
    return () => controller.abort()
  }, [])

  const refreshHistory = useCallback(
    async (signal?: AbortSignal) => {
      if (session.source === 'local') {
        setHistoryLoading(false)
        return
      }

      setHistoryLoading(true)
      try {
        const history = await getSessionHistory(session.id, signal)
        setVisibleRoundCount(INITIAL_VISIBLE_ROUNDS)
        setMessages(
          history.length > 0
            ? history.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                progressKind: message.progressKind,
                label: message.label,
                status: message.status,
              }))
            : loadMessages(session),
        )
      } catch (error) {
        if (signal?.aborted) return
        setMessages((current) => [
          ...current,
          {
            id: `history-error-${Date.now()}`,
            role: 'error',
            content:
              error instanceof Error
                ? error.message
                : 'Unable to load session history.',
          },
        ])
      } finally {
        if (!signal?.aborted) setHistoryLoading(false)
      }
    },
    [session],
  )

  useEffect(() => {
    const controller = new AbortController()
    void refreshHistory(controller.signal)
    return () => controller.abort()
  }, [refreshHistory])

  useEffect(() => {
    localStorage.setItem(
      messageStorageKey(session.id),
      JSON.stringify(messages.slice(-50)),
    )
    scrollAnchor.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, session.id])

  useLayoutEffect(() => {
    const previous = pendingScrollRestore.current
    const container = messagesContainer.current
    if (!previous || !container) return

    container.scrollTop =
      previous.scrollTop + (container.scrollHeight - previous.scrollHeight)
    pendingScrollRestore.current = null
  }, [visibleRoundCount])

  useEffect(
    () => () => {
      abortController.current?.abort()
    },
    [],
  )

  const acknowledgeSteering = (requestId: string) => {
    const pending = pendingSteering.current
    if (
      !pending ||
      pending.requestId !== requestId ||
      pending.runId !== activeRunId.current
    ) {
      return
    }

    const nextAssistantMessage: ChatMessage = {
      id: `assistant-steer-${Date.now()}`,
      role: 'assistant',
      content: '',
    }
    activeAssistantMessageId.current = nextAssistantMessage.id
    pending.acknowledged = true
    setMessages((current) => {
      const assistantIndex = current.findIndex(
        (message) => message.id === pending.assistantMessageId,
      )
      const steeringMessage: ChatMessage = {
        id: `steer-${Date.now()}`,
        role: 'user',
        content: pending.content,
        variant: 'steering',
      }
      if (assistantIndex < 0) {
        return [...current, steeringMessage, nextAssistantMessage]
      }
      const assistantMessage = current[assistantIndex]
      return [
        ...current.slice(0, assistantIndex),
        ...(assistantMessage.content ? [assistantMessage] : []),
        steeringMessage,
        nextAssistantMessage,
        ...current.slice(assistantIndex + 1),
      ]
    })
    setStreamStatus('Steering accepted')

    if (pending.postComplete) {
      pendingSteering.current = null
      setIsSteering(false)
    }
  }

  const handleStreamEvent = (event: CopilotStreamEvent) => {
    switch (event.type) {
      case 'session':
        activeRunId.current = event.runId
        localStorage.setItem(sessionStorageKey(session.id), event.sessionId)
        break
      case 'ready':
        if (event.runId === activeRunId.current) setRunReady(true)
        break
      case 'steer-accepted':
        acknowledgeSteering(event.requestId)
        break
      case 'status':
        setStreamStatus(
          event.status === 'reasoning'
            ? 'Reasoning'
            : event.status === 'thinking'
              ? 'Thinking'
              : 'Finishing',
        )
        break
      case 'delta': {
        const assistantMessageId = activeAssistantMessageId.current
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content: message.content + event.content,
          })),
        )
        break
      }
      case 'tool':
        setStreamStatus(
          event.status === 'complete'
            ? `${event.name} complete`
            : `Using ${event.name}`,
        )
        break
      case 'progress': {
        const assistantMessageId = activeAssistantMessageId.current
        setMessages((current) => {
          const id = `progress-${event.id}`
          const progressMessage: ChatMessage = {
            id,
            role: 'progress',
            content: '',
            progressKind: event.kind,
            label: event.label,
            status: event.status,
          }
          if (current.some((message) => message.id === id)) {
            return updateMessage(current, id, () => progressMessage)
          }

          const assistantIndex = current.findIndex(
            (message) => message.id === assistantMessageId,
          )
          if (assistantIndex < 0) return [...current, progressMessage]
          return [
            ...current.slice(0, assistantIndex),
            progressMessage,
            ...current.slice(assistantIndex),
          ]
        })
        break
      }
      case 'interaction':
        setInteractions((current) => [
          ...current.filter(
            (interaction) => interaction.requestId !== event.requestId,
          ),
          event,
        ])
        setStreamStatus('Waiting for your input')
        break
      case 'interaction-resolved':
        setInteractions((current) =>
          current.filter(
            (interaction) => interaction.requestId !== event.requestId,
          ),
        )
        setStreamStatus('Continuing')
        break
      case 'message':
        if (event.model) setStreamStatus(event.model)
        break
      case 'error': {
        const assistantMessageId = activeAssistantMessageId.current
        setInteractions([])
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content: event.message,
            role: 'error',
          })),
        )
        break
      }
      case 'done':
        setInteractions([])
        setRunReady(false)
        setStreamStatus('Ready')
        break
    }
  }

  const sendMessage = async () => {
    const content = input.trim()
    if (!content || isSending) return

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
    }
    const assistantMessageId = `assistant-${Date.now()}`
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
    }
    const controller = new AbortController()

    setMessages((current) => [...current, userMessage, assistantMessage])
    setInteractions([])
    setInteractionError('')
    setRespondingInteractionId('')
    activeRunId.current = ''
    activeAssistantMessageId.current = assistantMessageId
    pendingSteering.current = null
    activeInteractionResponse.current = ''
    setRunReady(false)
    setInput('')
    setIsSending(true)
    setStreamStatus('Connecting')
    abortController.current = controller

    try {
      await streamCopilotMessage({
        message: content,
        sessionId:
          localStorage.getItem(sessionStorageKey(session.id)) ||
          (session.source === 'local' ? undefined : session.id),
        mode: session.mode,
        allowTools,
        signal: controller.signal,
        onEvent: handleStreamEvent,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content: message.content || 'Generation stopped.',
          })),
        )
      } else {
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content:
              error instanceof Error ? error.message : 'Unable to reach Copilot.',
            role: 'error',
          })),
        )
        setBridgeOnline(false)
      }
    } finally {
      controller.abort()
      abortController.current = null
      activeRunId.current = ''
      activeAssistantMessageId.current = ''
      pendingSteering.current = null
      activeInteractionResponse.current = ''
      setRunReady(false)
      setIsSteering(false)
      setInteractions([])
      setInteractionError('')
      setRespondingInteractionId('')
      setIsSending(false)
      setStreamStatus('Ready')
    }
  }

  const respondToInteraction = async (
    requestId: string,
    value: CopilotInteractionResponse,
  ) => {
    const runId = activeRunId.current
    const controller = abortController.current
    if (!runId || !controller || respondingInteractionId) return
    const responseToken = `${runId}:${requestId}`
    activeInteractionResponse.current = responseToken
    setRespondingInteractionId(requestId)
    setInteractionError('')
    try {
      await respondToCopilotInteraction(
        runId,
        requestId,
        value,
        controller.signal,
      )
      if (
        controller.signal.aborted ||
        activeRunId.current !== runId ||
        activeInteractionResponse.current !== responseToken
      ) {
        return
      }
      setInteractions((current) =>
        current.filter((interaction) => interaction.requestId !== requestId),
      )
      setStreamStatus('Continuing')
    } catch (error) {
      if (
        !controller.signal.aborted &&
        activeRunId.current === runId &&
        activeInteractionResponse.current === responseToken
      ) {
        setInteractionError(
          error instanceof Error
            ? error.message
            : 'Unable to submit this response.',
        )
      }
    } finally {
      if (activeInteractionResponse.current === responseToken) {
        activeInteractionResponse.current = ''
        setRespondingInteractionId('')
      }
    }
  }

  const sendSteering = async () => {
    const content = input.trim()
    const runId = activeRunId.current
    const assistantMessageId = activeAssistantMessageId.current
    const controller = abortController.current
    if (
      !content ||
      !isSending ||
      !runReady ||
      !runId ||
      !assistantMessageId ||
      !controller ||
      isSteering ||
      interactions.length > 0
    ) {
      return
    }

    setInput('')
    setIsSteering(true)
    setInteractionError('')
    const requestId = crypto.randomUUID()
    pendingSteering.current = {
      requestId,
      runId,
      assistantMessageId,
      content,
      acknowledged: false,
      postComplete: false,
    }
    try {
      await steerCopilotRun(runId, requestId, content, controller.signal)
      const pending = pendingSteering.current
      if (
        controller.signal.aborted ||
        activeRunId.current !== runId ||
        !pending ||
        pending.requestId !== requestId
      ) {
        return
      }
      pending.postComplete = true
      if (pending.acknowledged) {
        pendingSteering.current = null
        setIsSteering(false)
      }
    } catch (error) {
      const pending = pendingSteering.current
      if (
        !controller.signal.aborted &&
        activeRunId.current === runId &&
        pending?.requestId === requestId
      ) {
        if (!pending.acknowledged) {
          setInput((current) => current || content)
          setInteractionError(
            error instanceof Error ? error.message : 'Unable to steer this run.',
          )
        }
        pendingSteering.current = null
        setIsSteering(false)
      }
    }
  }

  const submitComposer = () => {
    if (isSending) {
      void sendSteering()
    } else {
      void sendMessage()
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitComposer()
    }
  }

  const resetOrReloadChat = () => {
    if (isSending) return
    setInteractions([])
    setInteractionError('')
    setVisibleRoundCount(INITIAL_VISIBLE_ROUNDS)
    if (session.source === 'local') {
      localStorage.removeItem(sessionStorageKey(session.id))
      localStorage.removeItem(messageStorageKey(session.id))
      setMessages(loadMessages({ ...session, id: `${session.id}:fresh` }))
      setStreamStatus('New session')
    } else {
      void refreshHistory()
      setStreamStatus('Reloading history')
    }
  }

  const loadEarlierRounds = () => {
    const container = messagesContainer.current
    if (container) {
      pendingScrollRestore.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      }
    }
    setVisibleRoundCount((current) =>
      Math.min(current + ROUNDS_PER_PAGE, conversationRounds.length),
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-connection">
        <span>
          <span
            className={`connection-dot ${
              bridgeOnline === false ? 'connection-offline' : ''
            }`}
          />
          {bridgeOnline === null
            ? 'Checking bridge'
            : bridgeOnline
              ? 'Local Copilot connected'
              : 'Bridge offline'}
        </span>
        <button
          type="button"
          onClick={resetOrReloadChat}
          disabled={isSending || historyLoading}
          title={
            session.source === 'local'
              ? 'Start a new CLI session'
              : 'Reload persisted session history'
          }
        >
          <RefreshCw size={13} className={historyLoading ? 'spinning' : ''} />
          {session.source === 'local' ? 'New' : 'Reload'}
        </button>
      </div>

      <div
        className="chat-messages"
        aria-live="polite"
        ref={messagesContainer}
      >
        {hiddenRoundCount > 0 && (
          <div className="history-load-more">
            <button type="button" onClick={loadEarlierRounds}>
              <ChevronUp size={13} />
              Load {roundsToLoad} earlier{' '}
              {roundsToLoad === 1 ? 'round' : 'rounds'}
            </button>
            <span>{hiddenRoundCount} earlier rounds hidden</span>
          </div>
        )}
        {visibleTimeline.map((item) =>
          item.kind === 'activity' ? (
            <ActivityTimeline
              entries={item.entries}
              initiallyOpen={isSending}
              key={item.id}
            />
          ) : (
            <div
              className={`chat-message ${item.message.role} ${
                item.message.variant || ''
              }`}
              key={item.message.id}
            >
              <div className="message-avatar">
                {item.message.role === 'user' ? (
                  <UserRound size={13} />
                ) : item.message.role === 'tool' ? (
                  <Wrench size={13} />
                ) : (
                  <Bot size={14} />
                )}
              </div>
              <div className="message-body">
                {item.message.role !== 'tool' && (
                  <strong>
                    {item.message.role === 'user'
                      ? item.message.variant === 'steering'
                        ? 'You · steering'
                        : 'You'
                      : item.message.role === 'error'
                        ? 'Copilot error'
                        : 'Copilot'}
                  </strong>
                )}
                {item.message.content ? (
                  item.message.role === 'assistant' ? (
                    <div className="message-markdown">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a
                              {...props}
                              target="_blank"
                              rel="noreferrer noopener"
                            />
                          ),
                        }}
                      >
                          {item.message.content}
                      </Markdown>
                    </div>
                  ) : (
                      <p>{item.message.content}</p>
                  )
                ) : isSending &&
                  item.message.id === activeAssistantMessageId.current ? (
                  <p>
                    <span className="typing-indicator">
                      <i />
                      <i />
                      <i />
                    </span>
                  </p>
                ) : null}
              </div>
            </div>
          ),
        )}
        {interactions.map((interaction) => (
          <InteractionCard
            interaction={interaction}
            disabled={Boolean(respondingInteractionId)}
            key={interaction.requestId}
            onRespond={respondToInteraction}
          />
        ))}
        {interactionError && (
          <div className="interaction-error" role="alert">
            {interactionError}
          </div>
        )}
        <div ref={scrollAnchor} />
      </div>

      <div className="chat-status">
        <span>
          {isSending || historyLoading ? (
            <LoaderCircle size={12} className="spinning" />
          ) : (
            <CheckCircle2 size={12} />
          )}
          {historyLoading ? 'Loading history' : streamStatus}
        </span>
        <span>{session.mode} mode</span>
      </div>

      <div className="chat-composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            interactions.length > 0
              ? 'Resolve the pending request above to continue...'
              : isSending
                ? 'Steer the active run with new guidance...'
                : 'Ask Copilot to inspect, explain, or change code...'
          }
          rows={3}
          disabled={historyLoading || isSteering || interactions.length > 0}
        />
        <div className="composer-toolbar">
          <label
            className={allowTools ? 'permission-toggle enabled' : 'permission-toggle'}
            title="Automatically approve tool permission requests for this run"
          >
            <input
              type="checkbox"
              checked={allowTools}
              onChange={(event) => setAllowTools(event.target.checked)}
              disabled={isSending || historyLoading}
            />
            <ShieldCheck size={13} />
            Auto-approve tools
          </label>
          {isSending ? (
            <div className="composer-run-actions">
              <button
                className="steer-button"
                type="button"
                disabled={
                  !input.trim() ||
                  !runReady ||
                  isSteering ||
                  interactions.length > 0
                }
                onClick={() => void sendSteering()}
              >
                {isSteering ? (
                  <LoaderCircle size={14} className="spinning" />
                ) : (
                  <CornerUpRight size={14} />
                )}
                Steer
              </button>
              <button
                className="send-button stop"
                type="button"
                aria-label="Stop Copilot"
                onClick={() => abortController.current?.abort()}
              >
                <CircleStop size={15} />
              </button>
            </div>
          ) : (
            <button
              className="send-button"
              type="button"
              aria-label="Send message"
              disabled={
                !input.trim() || bridgeOnline === false || historyLoading
              }
              onClick={submitComposer}
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="chat-safety">
        {allowTools ? <TerminalSquare size={12} /> : <Sparkles size={12} />}
        {isSending
          ? 'Steering updates the current run immediately without starting a new session.'
          : allowTools
            ? 'Tool permission requests are approved automatically for this run.'
            : 'Approval mode: risky tools pause and wait for your decision.'}
      </div>
    </div>
  )
}
