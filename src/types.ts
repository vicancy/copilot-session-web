export type SessionStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'idle'

export type SessionMode = 'autopilot' | 'interactive' | 'plan'

export type ActivityKind = 'commit' | 'code' | 'status'

export type SessionSource = 'copilot-app' | 'copilot-cli' | 'local'

export interface SessionActivity {
  kind: ActivityKind
  label: string
  detail: string
  time: string
}

export interface SessionChanges {
  files: number
  additions: number
  deletions: number
}

export interface Session {
  id: string
  title: string
  projectId: string
  repository: string
  branch: string
  status: SessionStatus
  mode: SessionMode
  summary: string
  updatedAt: string
  createdAt: string
  progress: number
  unread: boolean
  source: SessionSource
  clientName: string
  isRemote: boolean
  workingDirectory: string
  changes: SessionChanges
  activities: SessionActivity[]
}

export interface Project {
  id: string
  name: string
  owner: string
  repository: string
  color: string
  sessionCount: number
  activeCount: number
}

export interface DashboardSnapshot {
  projects: Project[]
  sessions: Session[]
  lastSyncedAt: string
}

export interface SessionRepository {
  getDashboard(): Promise<DashboardSnapshot>
}
