import { CommandError } from './command-error.js'
import {
  COLLAB_WINDOW_MS,
  collectUsageTotals,
  listAgents,
  recentSignal,
  summariseSession,
  type ProjectAgent,
} from './claude-code.js'

// Stands in for the Hermes CLI (`hermes ...`) that Ruang's collectors in mission-control.ts
// normally run: this module renders the same plain-text/JSON shapes Hermes prints, built from
// Claude Code's own session transcripts under ~/.claude/projects, so every existing parser in
// mission-control.ts (parseProfiles, parseSessions, parseInsights, ...) keeps working unchanged.
// It never runs a shell command and never writes anything.

const LOG_MISSING_TEXT = 'Log file not found.'

function notInstalled(): never {
  throw new CommandError('Command not installed or not on PATH.', 'COMMAND_FAILED', '')
}

function logMissing(): never {
  throw new CommandError(LOG_MISSING_TEXT, 'COMMAND_FAILED', LOG_MISSING_TEXT)
}

function arg(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** Collapses embedded newlines/control characters so a value stays on one table row. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function pad(value: string, width: number): string {
  const flat = oneLine(value)
  return flat.length >= width ? `${flat.slice(0, Math.max(0, width - 1))}…` : flat.padEnd(width)
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const three = (n: number) => String(n).padStart(3, '0')
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())},${three(d.getUTCMilliseconds())}`
}

function relative(deltaMs: number): string {
  if (deltaMs < 60_000) return 'just now'
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`
  return `${Math.floor(deltaMs / 86_400_000)}d ago`
}

// ---------------------------------------------------------------------------
// `hermes profile list` — one row per known Claude Code project. Gateway is always reported
// "stopped" (Claude Code has no listening gateway concept); Ruang already treats that as
// informational, not as taking an agent offline.

function profileListOutput(agents: ProjectAgent[]): string {
  // `parseProfiles` only ever keeps the stable id out of a "Display Name (id)" cell (see
  // Ruang's own doc comment on that regex) — there is no separate display-name field anywhere
  // downstream, so there is no point rendering one here; the slug is what the office shows.
  const header = `${pad('Profile', 42)}${pad('Model', 20)}Gateway`
  const rows = agents.map((agent) => `${pad(agent.slug, 42)}${pad('claude-code', 20)}stopped`)
  return [header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// `hermes sessions list --limit N` (optionally scoped to one profile via -p).

interface SessionRow { title: string; preview: string; workspace: string; lastActive: string; lastActiveMs: number; src: string; id: string }

function sessionsTable(rows: SessionRow[]): string {
  if (rows.length === 0) return 'No sessions found.\n'
  const header = `${pad('Title', 26)}${pad('Preview', 42)}${pad('Workspace', 24)}${pad('Last Active', 14)}${pad('Src', 6)}ID`
  const body = rows.map((row) => `${pad(row.title || 'Untitled session', 26)}${pad(row.preview, 42)}${pad(row.workspace, 24)}${pad(row.lastActive, 14)}${pad(row.src, 6)}${row.id}`)
  return [header, ...body].join('\n')
}

async function sessionRowsFor(agents: ProjectAgent[], now: number): Promise<SessionRow[]> {
  const summaries = (await Promise.all(agents.flatMap((agent) => agent.sessionFiles.map(async (file) => {
    const summary = await summariseSession(file)
    return summary ? { ...summary, agentSlug: agent.slug } : undefined
  })))).filter((s): s is NonNullable<typeof s> => s !== undefined)
  return summaries
    .sort((a, b) => b.lastActive - a.lastActive)
    .map((summary) => ({
      title: summary.title,
      preview: summary.preview,
      workspace: summary.cwd ?? summary.agentSlug,
      lastActive: relative(now - summary.lastActive),
      lastActiveMs: summary.lastActive,
      src: 'cli',
      id: summary.id,
    }))
}

// ---------------------------------------------------------------------------
// `hermes status --all` — no messaging platforms in Claude Code; only the session count is real.

function statusOutput(activeSessions: number): string {
  return ['◆ Messaging Platforms', '', '◆ Sessions', `  Active:  ${activeSessions} session(s)`].join('\n')
}

// ---------------------------------------------------------------------------
// `hermes insights --days N` (optionally scoped to one profile via -p).

function insightsOutput(totals: Awaited<ReturnType<typeof collectUsageTotals>>, days: number): string {
  if (totals.sessions === 0) return `No sessions found in the last ${days} day(s).`
  const lines = [
    '◆ Overview',
    `  Sessions:      ${totals.sessions}`,
    `  Messages:      ${totals.messages}`,
    `  Tool calls:    ${totals.toolCalls}`,
    `  Input tokens:  ${totals.inputTokens}`,
    `  Output tokens: ${totals.outputTokens}`,
    `  Total tokens:  ${totals.inputTokens + totals.outputTokens}`,
  ]
  if (totals.models.size > 0) {
    lines.push('', '◆ Models Used', `  ${pad('Model', 24)}${pad('Sessions', 10)}Tokens`)
    for (const [model, row] of [...totals.models].sort((a, b) => b[1].tokens - a[1].tokens)) lines.push(`  ${pad(model, 24)}${pad(String(row.sessions), 10)}${row.tokens}`)
  }
  if (totals.tools.size > 0) {
    const totalCalls = Math.max(1, totals.toolCalls)
    lines.push('', '◆ Top Tools', `  ${pad('Tool', 24)}${pad('Calls', 10)}Share`)
    for (const [tool, calls] of [...totals.tools].sort((a, b) => b[1] - a[1])) lines.push(`  ${pad(tool, 24)}${pad(String(calls), 10)}${((calls / totalCalls) * 100).toFixed(1)}%`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// `hermes [-p <profile>] logs agent -n N --since <window>` — the tail of what an agent is doing,
// synthesised from the newest growing line of its session transcript (see claude-code.ts).

async function agentLogOutput(agents: ProjectAgent[], now: number): Promise<string> {
  const lines: string[] = []
  for (const agent of agents) {
    const signal = await recentSignal(agent, now)
    if (!signal.active || !signal.kind || signal.lastSeen === undefined) continue
    const logger = signal.kind === 'thinking' ? 'agent' : signal.kind === 'tools' ? 'tools' : 'gateway'
    const message = signal.kind === 'chat' ? `message received from user: ${signal.label ?? 'chat'}` : signal.label ?? ''
    lines.push(`${stamp(signal.lastSeen)} INFO ${logger}: ${message}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

export async function claudeCodeRun(file: string, args: readonly string[], _options: { benign?: RegExp } = {}): Promise<string> {
  if (file !== 'hermes') notInstalled()
  const now = Date.now()
  let rest = args
  let profileSlug: string | undefined
  if (rest[0] === '-p') { profileSlug = rest[1]; rest = rest.slice(2) }

  const agents = await listAgents(now)
  const scoped = profileSlug ? agents.filter((agent) => agent.slug === profileSlug) : agents

  if (rest[0] === 'profile' && rest[1] === 'list') return profileListOutput(agents)
  if (rest[0] === 'kanban') return rest[1] === 'show' ? (() => { throw new CommandError('Task not found.', 'COMMAND_FAILED', '') })() : '[]'
  if (rest[0] === 'cron' && rest[1] === 'list') return 'No scheduled jobs.\n'
  if (rest[0] === 'sessions' && rest[1] === 'list') {
    const limit = Number(arg(rest, '--limit') ?? '20')
    const rows = (await sessionRowsFor(scoped, now)).slice(0, Number.isFinite(limit) ? limit : 20)
    return sessionsTable(rows)
  }
  if (rest[0] === 'skills' && rest[1] === 'list') return `│ ${pad('Name', 10)}│ ${pad('Category', 10)}│ ${pad('Source', 10)}│ ${pad('Trust', 10)}│ Status │`
  if (rest[0] === 'status' && rest[1] === '--all') {
    const rows = await sessionRowsFor(agents, now)
    const active = rows.filter((row) => now - row.lastActiveMs <= COLLAB_WINDOW_MS).length
    return statusOutput(active)
  }
  if (rest[0] === 'insights') {
    const days = Number(arg(rest, '--days') ?? '7')
    const sinceMs = now - (Number.isFinite(days) ? days : 7) * 86_400_000
    const files = scoped.flatMap((agent) => agent.sessionFiles)
    const totals = await collectUsageTotals(files, sinceMs, now)
    return insightsOutput(totals, Number.isFinite(days) ? days : 7)
  }
  if (rest[0] === 'logs' && rest[1] === 'agent') return agentLogOutput(scoped, now)
  if (rest[0] === 'logs') logMissing()
  notInstalled()
}
