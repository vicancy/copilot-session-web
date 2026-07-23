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
  Bot,
  CheckCircle2,
  ChevronUp,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  Send,
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
  streamCopilotMessage,
} from '../data/copilotClient'
import type { CopilotStreamEvent } from '../data/copilotClient'
import type { Session } from '../types'

type MessageRole = 'assistant' | 'error' | 'tool' | 'user'

interface ChatMessage {
  id: string
  role: MessageRole
  content: string
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

export function ChatPanel({ session }: { session: Session }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadMessages(session),
  )
  const [input, setInput] = useState('')
  const [allowTools, setAllowTools] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [streamStatus, setStreamStatus] = useState('Ready')
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null)
  const [historyLoading, setHistoryLoading] = useState(
    session.source !== 'local',
  )
  const [visibleRoundCount, setVisibleRoundCount] = useState(
    INITIAL_VISIBLE_ROUNDS,
  )
  const abortController = useRef<AbortController | null>(null)
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

  const handleStreamEvent = (
    event: CopilotStreamEvent,
    assistantMessageId: string,
  ) => {
    switch (event.type) {
      case 'session':
        localStorage.setItem(sessionStorageKey(session.id), event.sessionId)
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
      case 'delta':
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content: message.content + event.content,
          })),
        )
        break
      case 'tool':
        setMessages((current) => {
          const id = `tool-${assistantMessageId}-${event.name}`
          const existing = current.some((message) => message.id === id)
          const content =
            event.status === 'complete'
              ? `${event.name} completed`
              : `Using ${event.name}`
          return existing
            ? updateMessage(current, id, (message) => ({ ...message, content }))
            : current.length > 0
              ? [
                  ...current.slice(0, -1),
                  { id, role: 'tool', content },
                  current[current.length - 1],
                ]
              : [{ id, role: 'tool', content }]
        })
        break
      case 'message':
        if (event.model) setStreamStatus(event.model)
        break
      case 'error':
        setMessages((current) =>
          updateMessage(current, assistantMessageId, (message) => ({
            ...message,
            content: event.message,
            role: 'error',
          })),
        )
        break
      case 'done':
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
        onEvent: (event) => handleStreamEvent(event, assistantMessageId),
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
      abortController.current = null
      setIsSending(false)
      setStreamStatus('Ready')
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const resetOrReloadChat = () => {
    if (isSending) return
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
        {visibleMessages.map((message) => (
          <div className={`chat-message ${message.role}`} key={message.id}>
            <div className="message-avatar">
              {message.role === 'user' ? (
                <UserRound size={13} />
              ) : message.role === 'tool' ? (
                <Wrench size={13} />
              ) : (
                <Bot size={14} />
              )}
            </div>
            <div className="message-body">
              {message.role !== 'tool' && (
                <strong>
                  {message.role === 'user'
                    ? 'You'
                    : message.role === 'error'
                      ? 'Copilot error'
                      : 'Copilot'}
                </strong>
              )}
              {message.content ? (
                message.role === 'assistant' ? (
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
                      {message.content}
                    </Markdown>
                  </div>
                ) : (
                  <p>{message.content}</p>
                )
              ) : isSending && message.id.startsWith('assistant-') ? (
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
        ))}
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
          placeholder="Ask Copilot to inspect, explain, or change code..."
          rows={3}
          disabled={isSending || historyLoading}
        />
        <div className="composer-toolbar">
          <label
            className={allowTools ? 'permission-toggle enabled' : 'permission-toggle'}
            title="Allow Copilot to edit files and run terminal commands in this project"
          >
            <input
              type="checkbox"
              checked={allowTools}
              onChange={(event) => setAllowTools(event.target.checked)}
              disabled={isSending || historyLoading}
            />
            <ShieldCheck size={13} />
            Allow edits & commands
          </label>
          {isSending ? (
            <button
              className="send-button stop"
              type="button"
              aria-label="Stop Copilot"
              onClick={() => abortController.current?.abort()}
            >
              <CircleStop size={15} />
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              aria-label="Send message"
              disabled={
                !input.trim() || bridgeOnline === false || historyLoading
              }
              onClick={() => void sendMessage()}
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="chat-safety">
        {allowTools ? <TerminalSquare size={12} /> : <Sparkles size={12} />}
        {allowTools
          ? 'Copilot can modify files inside this workspace.'
          : 'Safe mode: shell commands and file writes are denied.'}
      </div>
    </div>
  )
}
