# Copilot Workspace

A React and TypeScript dashboard for viewing and controlling Copilot projects
and sessions in one place. It uses the official `@github/copilot-sdk` to read
the shared Copilot session store, including Copilot App chats and project
workspaces, and resumes selected session UUIDs through GitHub Copilot CLI.
On phones, selecting a session opens a full-height chat view with touch-sized
controls, a keyboard-safe composer, and back navigation to the session list.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:4174`. `npm run dev` starts both Vite and the local API.

For a production-style local run:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:8787`.

The bridge binds to localhost and resolves session working directories only
from trusted SDK metadata. Chat starts in safe mode, which denies shell commands
and file writes. Enable **Allow edits & commands** only when you want the
selected session to change its SDK-recorded working directory. Client-provided
paths are never accepted.

The SDK's experimental `sessions.list` RPC records the runtime `clientName`.
Sidebar badges use that field: **APP** means `github/autopilot`, **CLI** means
`github/cli`, and **WEB** is a session created locally by this dashboard. A
Copilot App project workspace may still carry a CLI badge because the App starts
a CLI runtime inside its outer project session.

Copilot App's visual tree is an outer application relationship: a root chat can
spawn one or more project/worktree sessions. Those App IDs differ from the inner
Copilot SDK conversation IDs, and the SDK session list does not expose an outer
`parentSessionId`; the exact App tree therefore cannot be reconstructed from
`listSessions()` alone.

Session listing and persisted history are implemented in `server/index.mjs`.
The browser adapters live in `src/data/sessionRepository.ts` and
`src/data/copilotClient.ts`.

## Privacy and publishing

The source code is suitable for a public repository. It does not embed GitHub
tokens, Copilot credentials, session histories, user names, machine paths, or
repository names. Authentication remains inside the installed Copilot SDK/CLI.

Runtime data is private. The local API and UI read session titles, prompts,
assistant responses, repository/branch metadata, and absolute working-directory
paths from the current user's Copilot home. This information stays in memory
and is not written into this repository.

The server is intentionally bound to `127.0.0.1` and must not be exposed through
port forwarding, a public reverse proxy, or a hosted deployment. Before
publishing screenshots or bug reports, redact session names, repository names,
conversation text, and local paths.

## Commands

- `npm run dev` starts the Vite development server and Copilot bridge.
- `npm run dev:api` starts only the local bridge.
- `npm run dev:web` starts only Vite.
- `npm run lint` runs Oxlint.
- `npm run build` type-checks and creates a production build.
- `npm start` serves the production build and chat API on localhost.
