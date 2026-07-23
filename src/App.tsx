import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity,
  Bell,
  Bot,
  Check,
  ChevronDown,
  CircleDotDashed,
  Code2,
  Command,
  Copy,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  GitFork,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import './App.css'
import { ChatPanel } from './components/ChatPanel'
import { sessionRepository } from './data/sessionRepository'
import type {
  DashboardSnapshot,
  Project,
  Session,
  SessionStatus,
} from './types'

type SessionFilter = 'all' | 'app' | 'cli'

const statusMeta: Record<
  SessionStatus,
  { label: string; className: string }
> = {
  running: { label: 'Running', className: 'status-running' },
  waiting: { label: 'Needs review', className: 'status-waiting' },
  completed: { label: 'Completed', className: 'status-completed' },
  failed: { label: 'Failed', className: 'status-failed' },
  idle: { label: 'Available', className: 'status-idle' },
}

const filterLabels: Record<SessionFilter, string> = {
  all: 'All sessions',
  app: 'App workspaces',
  cli: 'CLI / folder',
}

function formatRelativeTime(value: string) {
  const elapsedMinutes = Math.max(
    1,
    Math.round((Date.now() - new Date(value).getTime()) / 60_000),
  )

  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)}h ago`
  return `${Math.floor(elapsedMinutes / 1_440)}d ago`
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = statusMeta[status]
  return (
    <span className={`status-badge ${meta.className}`}>
      <span className="status-dot" />
      {meta.label}
    </span>
  )
}

function SidebarSessionItem({
  session,
  selected,
  onSelect,
}: {
  session: Session
  selected: boolean
  onSelect: () => void
}) {
  const sourceLabel =
    session.source === 'copilot-app'
      ? 'APP'
      : session.source === 'copilot-cli'
        ? 'CLI'
        : 'WEB'

  return (
    <button
      className={
        selected ? 'sidebar-session-item selected' : 'sidebar-session-item'
      }
      type="button"
      onClick={onSelect}
      title={`${session.title}\nSource: ${session.clientName}`}
    >
      <span
        className={
          session.source === 'copilot-app'
            ? 'sidebar-session-icon source-app'
            : 'sidebar-session-icon source-shared'
        }
      >
        {session.source === 'copilot-app' ? (
          <MessageSquareText size={13} />
        ) : (
          <Code2 size={13} />
        )}
      </span>
      <span>{session.title}</span>
      <small className={`source-badge ${session.source}`}>{sourceLabel}</small>
    </button>
  )
}

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [query, setQuery] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [copiedBranch, setCopiedBranch] = useState(false)
  const [detailView, setDetailView] = useState<'details' | 'chat'>('details')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    sessionRepository
      .getDashboard()
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setSelectedSessionId(nextSnapshot.sessions[0]?.id ?? '')
      })
      .catch((error) =>
        setLoadError(
          error instanceof Error ? error.message : 'Unable to load sessions.',
        ),
      )
  }, [])

  const filteredSessions = useMemo(() => {
    if (!snapshot) return []
    const normalizedQuery = query.trim().toLowerCase()

    return snapshot.sessions.filter((session) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'app' && session.source === 'copilot-app') ||
        (filter === 'cli' && session.source === 'copilot-cli')
      const matchesQuery =
        !normalizedQuery ||
        [
          session.title,
          session.repository,
          session.branch,
          session.summary,
        ].some((value) => value.toLowerCase().includes(normalizedQuery))

      return matchesFilter && matchesQuery
    })
  }, [filter, query, snapshot])

  const sidebarSessionGroups = useMemo(() => {
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000
    return {
      recent: filteredSessions.filter(
        (session) => new Date(session.updatedAt).getTime() >= recentCutoff,
      ),
      older: filteredSessions.filter(
        (session) => new Date(session.updatedAt).getTime() < recentCutoff,
      ),
    }
  }, [filteredSessions])

  const selectedSession =
    snapshot?.sessions.find((session) => session.id === selectedSessionId) ??
    filteredSessions[0]
  const selectedProject = snapshot?.projects.find(
    (project) => project.id === selectedSession?.projectId,
  )

  const refreshDashboard = async () => {
    setIsRefreshing(true)
    setLoadError('')
    try {
      const nextSnapshot = await sessionRepository.getDashboard()
      setSnapshot(nextSnapshot)
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Unable to refresh sessions.',
      )
    } finally {
      window.setTimeout(() => setIsRefreshing(false), 450)
    }
  }

  const selectFilter = (nextFilter: SessionFilter) => {
    setFilter(nextFilter)
    setIsSidebarOpen(false)
  }

  const selectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId)
    setDetailView('details')
    setIsSidebarOpen(false)
  }

  const createSession = (session: Session) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            sessions: [session, ...current.sessions],
            projects: current.projects.map((project) =>
              project.id === session.projectId
                ? {
                    ...project,
                    sessionCount: project.sessionCount + 1,
                    activeCount: project.activeCount + 1,
                  }
                : project,
            ),
          }
        : current,
    )
    setSelectedSessionId(session.id)
    setDetailView('chat')
    setFilter('all')
    setIsCreateOpen(false)
  }

  const copyBranch = async () => {
    if (!selectedSession) return
    await navigator.clipboard.writeText(selectedSession.branch)
    setCopiedBranch(true)
    window.setTimeout(() => setCopiedBranch(false), 1_400)
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">
          <Sparkles size={20} />
        </div>
        {loadError ? (
          <>
            <strong>Copilot sessions are unavailable</strong>
            <span>{loadError}</span>
            <button type="button" onClick={() => window.location.reload()}>
              Try again
            </button>
          </>
        ) : (
          <span>Loading real Copilot sessions...</span>
        )}
      </main>
    )
  }

  const appSessionCount = snapshot.sessions.filter(
    (session) => session.source === 'copilot-app',
  ).length
  const cliSessionCount = snapshot.sessions.filter(
    (session) => session.source === 'copilot-cli',
  ).length

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-leading">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            onClick={() => setIsSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <a className="brand" href="/" aria-label="Copilot workspace home">
            <span className="brand-mark">
              <Sparkles size={18} />
            </span>
            <span>Copilot</span>
            <span className="brand-divider" />
            <strong>Workspace</strong>
          </a>
        </div>

        <label className="global-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions, repositories, branches..."
          />
          <kbd>
            <Command size={12} /> K
          </kbd>
        </label>

        <div className="topbar-actions">
          <button className="icon-button" type="button" aria-label="Notifications">
            <Bell size={18} />
            <span className="notification-dot" />
          </button>
          <button className="profile-button" type="button">
            <span className="avatar">CP</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </header>

      <aside className={`sidebar ${isSidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-mobile-header">
          <span>Navigation</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Close navigation"
            onClick={() => setIsSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            className={filter === 'all' ? 'nav-item active' : 'nav-item'}
            type="button"
            onClick={() => selectFilter('all')}
          >
            <LayoutDashboard size={17} />
            Overview
          </button>
          <button
            className={filter === 'app' ? 'nav-item active' : 'nav-item'}
            type="button"
            onClick={() => selectFilter('app')}
          >
            <Activity size={17} />
            Copilot App
            <span className="nav-count">{appSessionCount}</span>
          </button>
          <button
            className={filter === 'cli' ? 'nav-item active' : 'nav-item'}
            type="button"
            onClick={() => selectFilter('cli')}
          >
            <Code2 size={17} />
            CLI / folder
            <span className="nav-count">{cliSessionCount}</span>
          </button>
          <button className="nav-item" type="button">
            <GitPullRequest size={17} />
            Pull requests
          </button>
        </nav>

        <div className="sidebar-section session-navigation">
          <div className="sidebar-heading">
            <span>Recent sessions</span>
            <div>
              <button
                type="button"
                aria-label="Clear session filters"
                title="Show all sessions"
                onClick={() => {
                  setFilter('all')
                  setQuery('')
                }}
              >
                <Search size={14} />
              </button>
              <button
                type="button"
                aria-label="Create session"
                onClick={() => setIsCreateOpen(true)}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
          <div className="sidebar-session-scroll">
            <div className="sidebar-session-group">
              {sidebarSessionGroups.recent.map((session) => (
                <SidebarSessionItem
                  key={session.id}
                  session={session}
                  selected={selectedSession?.id === session.id}
                  onSelect={() => selectSession(session.id)}
                />
              ))}
              {sidebarSessionGroups.recent.length === 0 && (
                <span className="sidebar-empty">No recent sessions</span>
              )}
            </div>

            {sidebarSessionGroups.older.length > 0 && (
              <>
                <div className="sidebar-heading older-heading">
                  <span>Older</span>
                </div>
                <div className="sidebar-session-group">
                  {sidebarSessionGroups.older.map((session) => (
                    <SidebarSessionItem
                      key={session.id}
                      session={session}
                      selected={selectedSession?.id === session.id}
                      onSelect={() => selectSession(session.id)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <button className="nav-item" type="button">
            <Settings size={17} />
            Settings
          </button>
          <div className="usage-card">
            <div>
              <span>Premium requests</span>
              <strong>64%</strong>
            </div>
            <div className="usage-track">
              <span />
            </div>
            <small>Resets in 9 days</small>
          </div>
        </div>
      </aside>

      {isSidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <main className="workspace">
        <section className="workspace-header">
          <div>
            <p className="eyebrow">Your workspace</p>
            <h1>Good evening</h1>
            <p className="header-copy">
              Search, read, and continue sessions from the shared Copilot store.
            </p>
          </div>
          <div className="header-actions">
            <button
              className="button secondary-button"
              type="button"
              onClick={refreshDashboard}
            >
              <RefreshCw
                size={16}
                className={isRefreshing ? 'spinning' : ''}
              />
              Sync
            </button>
            <button
              className="button primary-button"
              type="button"
              onClick={() => setIsCreateOpen(true)}
            >
              <Plus size={17} />
              New session
            </button>
          </div>
        </section>

        <section className="metrics-grid" aria-label="Workspace metrics">
          <article className="metric-card metric-featured">
            <div className="metric-icon">
              <Zap size={19} />
            </div>
            <div>
              <span>Sessions synced</span>
              <strong>{snapshot.sessions.length}</strong>
              <small>Across {snapshot.projects.length} projects</small>
            </div>
            <div className="metric-pulse">
              <span />
              Live
            </div>
          </article>
          <article className="metric-card">
            <div className="metric-icon amber">
              <MessageSquareText size={19} />
            </div>
            <div>
              <span>App workspaces</span>
              <strong>{appSessionCount}</strong>
              <small>Chats and project workspaces</small>
            </div>
          </article>
          <article className="metric-card">
            <div className="metric-icon green">
              <Code2 size={19} />
            </div>
            <div>
              <span>CLI / folder</span>
              <strong>{cliSessionCount}</strong>
              <small>CLI and SDK sessions</small>
            </div>
          </article>
        </section>

        <section className="session-workbench">
          <div className="session-column">
            <div className="section-toolbar">
              <div>
                <h2>Sessions</h2>
                <span>{filteredSessions.length} shown</span>
              </div>
              <div className="filter-group">
                {(Object.keys(filterLabels) as SessionFilter[]).map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={filter === item ? 'filter active' : 'filter'}
                    onClick={() => setFilter(item)}
                  >
                    {filterLabels[item]}
                  </button>
                ))}
              </div>
            </div>

            <div className="session-list">
              {filteredSessions.map((session) => {
                const project = snapshot.projects.find(
                  (item) => item.id === session.projectId,
                )
                return (
                  <button
                    className={
                      selectedSession?.id === session.id
                        ? 'session-row selected'
                        : 'session-row'
                    }
                    type="button"
                    key={session.id}
                    onClick={() => selectSession(session.id)}
                  >
                    <span
                      className={`session-status-line ${statusMeta[session.status].className}`}
                    />
                    <span className="session-main">
                      <span className="session-title-line">
                        <strong>{session.title}</strong>
                        {session.unread && <span className="unread-dot" />}
                      </span>
                      <span className="session-description">
                        {session.summary}
                      </span>
                      <span className="session-meta">
                        <span>
                          <FolderGit2 size={13} />
                          {project?.name}
                        </span>
                        <span>
                          <GitBranch size={13} />
                          {session.branch}
                        </span>
                        <span className="session-source">
                          {session.source === 'copilot-app' ? 'App' : 'Shared'}
                        </span>
                      </span>
                    </span>
                    <span className="session-aside">
                      <StatusBadge status={session.status} />
                      <time>{formatRelativeTime(session.updatedAt)}</time>
                    </span>
                  </button>
                )
              })}

              {filteredSessions.length === 0 && (
                <div className="empty-state">
                  <Search size={24} />
                  <strong>No sessions found</strong>
                  <span>Try another search or filter.</span>
                  <button type="button" onClick={() => setQuery('')}>
                    Clear search
                  </button>
                </div>
              )}
            </div>
          </div>

          {selectedSession && selectedProject && (
            <aside className="detail-panel">
              <div className="detail-topline">
                <StatusBadge status={selectedSession.status} />
                <div className="detail-tabs">
                  <button
                    className={detailView === 'details' ? 'active' : ''}
                    type="button"
                    onClick={() => setDetailView('details')}
                  >
                    Details
                  </button>
                  <button
                    className={detailView === 'chat' ? 'active' : ''}
                    type="button"
                    onClick={() => setDetailView('chat')}
                  >
                    Chat
                  </button>
                </div>
              </div>

              <div className="detail-title">
                <div className="detail-agent">
                  <Bot size={20} />
                </div>
                <div>
                  <p>{selectedProject.owner}</p>
                  <h2>{selectedSession.title}</h2>
                </div>
              </div>
              <p className="detail-summary">{selectedSession.summary}</p>

              {detailView === 'chat' ? (
                <ChatPanel key={selectedSession.id} session={selectedSession} />
              ) : (
                <>
                  <div className="detail-actions">
                    <button
                      className="button primary-button wide"
                      type="button"
                      onClick={() => setDetailView('chat')}
                    >
                      <MessageSquareText size={16} />
                      Chat with session
                    </button>
                    <button
                      className="icon-button bordered"
                      type="button"
                      aria-label="Open repository"
                    >
                      <GitFork size={17} />
                    </button>
                  </div>

                  <div className="detail-section">
                    <h3>Session source</h3>
                    <div className="progress-label">
                      <span>
                        {selectedSession.source === 'copilot-app'
                          ? 'GitHub Copilot App'
                          : 'Shared Copilot session'}
                      </span>
                      <span>{selectedSession.clientName}</span>
                    </div>
                    <p className="source-note">
                      Read from the official Copilot SDK shared session store.
                    </p>
                  </div>

                  <div className="detail-section">
                    <h3>Workspace</h3>
                    <dl className="workspace-facts">
                      <div>
                        <dt>Repository</dt>
                        <dd>
                          <GitFork size={14} />
                          {selectedSession.repository}
                        </dd>
                      </div>
                      <div>
                        <dt>Branch</dt>
                        <dd>
                          <GitBranch size={14} />
                          <span title={selectedSession.branch}>
                            {selectedSession.branch}
                          </span>
                          <button
                            type="button"
                            aria-label="Copy branch"
                            onClick={copyBranch}
                          >
                            {copiedBranch ? (
                              <Check size={13} />
                            ) : (
                              <Copy size={13} />
                            )}
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt>Location</dt>
                        <dd title={selectedSession.workingDirectory}>
                          <FileCode2 size={14} />
                          <span>
                            {selectedSession.workingDirectory || 'Remote'}
                          </span>
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="detail-section activity-section">
                    <h3>Recent activity</h3>
                    <div className="activity-list">
                      {selectedSession.activities.map((item, index) => (
                        <div
                          className="activity-item"
                          key={`${item.label}-${index}`}
                        >
                          <div className="activity-marker">
                            {item.kind === 'commit' ? (
                              <GitCommitHorizontal size={14} />
                            ) : item.kind === 'code' ? (
                              <Code2 size={14} />
                            ) : (
                              <CircleDotDashed size={14} />
                            )}
                          </div>
                          <div>
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </div>
                          <time>{item.time}</time>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </aside>
          )}
        </section>

        <footer className="workspace-footer">
          <span>
            <span className="connection-dot" />
            Official Copilot SDK connected
          </span>
          <span className={loadError ? 'sync-error' : ''}>
            {loadError
              ? loadError
              : `Last synced ${formatRelativeTime(snapshot.lastSyncedAt)}`}
          </span>
        </footer>
      </main>

      {isCreateOpen && (
        <CreateSessionDialog
          projects={snapshot.projects}
          onClose={() => setIsCreateOpen(false)}
          onCreate={createSession}
        />
      )}
    </div>
  )
}

function CreateSessionDialog({
  projects,
  onClose,
  onCreate,
}: {
  projects: Project[]
  onClose: () => void
  onCreate: (session: Session) => void
}) {
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const project = projects.find((item) => item.id === projectId) ?? projects[0]

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedTitle = title.trim()
    if (!normalizedTitle || !project) return

    const now = new Date().toISOString()
    onCreate({
      id: `local-${Date.now()}`,
      title: normalizedTitle,
      projectId: project.id,
      repository: project.repository,
      branch: `copilot/${normalizedTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')}`,
      status: 'running',
      mode: 'interactive',
      summary: 'A new local Copilot session ready for your first prompt.',
      updatedAt: now,
      createdAt: now,
      progress: 4,
      unread: false,
      source: 'local',
      clientName: 'copilot-session-web',
      isRemote: false,
      workingDirectory: '',
      changes: { files: 0, additions: 0, deletions: 0 },
      activities: [
        {
          kind: 'status',
          label: 'Session created',
          detail: 'Workspace is ready',
          time: 'now',
        },
      ],
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Start something new</p>
            <h2 id="create-title">Create a session</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            What should Copilot work on?
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. Add repository search"
            />
          </label>
          <label>
            Project
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name} · {item.repository}
                </option>
              ))}
            </select>
          </label>
          <div className="dialog-note">
            <Sparkles size={16} />
            This MVP creates a local session. The data adapter can be connected
            to Copilot CLI next.
          </div>
          <div className="dialog-actions">
            <button
              className="button secondary-button"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="button primary-button"
              type="submit"
              disabled={!title.trim()}
            >
              <Plus size={16} />
              Create session
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default App
