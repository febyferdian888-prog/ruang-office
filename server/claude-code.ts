import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'

// Reads Claude Code's own session transcripts (~/.claude/projects/<project>/<session>.jsonl) to
// stand in for the Hermes CLI that Ruang was built against. Nothing here writes anything; every
// function only ever opens files for reading. One Claude Code *project folder* is treated as one
// office "agent" (its own identity, like a Hermes profile), and every `.jsonl` session file
// directly inside it is that agent's session history. Several sessions running at once in
// different project folders show up as separate agents in the office, which is the common shape
// of parallel sub-agent work; several concurrent sessions in the very same project folder are
// currently folded into that one agent (a known simplification, not a bug).

export const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')
/** An agent counts as "known" (shown at all) only if one of its sessions touched it this recently. */
export const ROSTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** An agent counts as actively working only if a session file is still growing this recently. */
export const WORKING_WINDOW_MS = 2 * 60 * 1000
/** A session counts as "just now"/freshly collaborating within this window. */
export const COLLAB_WINDOW_MS = 3 * 60 * 1000

export interface ProjectAgent {
  /** Directory name under PROJECTS_DIR; also the office/profile id (already name-safe). */
  slug: string
  /** Best-effort human label, read from a session's own `cwd` field. */
  label: string
  dir: string
  /** The real project folder this agent works in, read from a session's own `cwd` field. */
  cwd?: string
  sessionFiles: string[]
  lastActivity: number
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

async function safeMtime(file: string): Promise<number> {
  try { return (await stat(file)).mtimeMs } catch { return 0 }
}

/**
 * Reads the opening lines of a session file (bounded to one chunk), looking for a `cwd` field.
 * A session often opens with a few lines that carry no `cwd` (e.g. a queued-prompt record before
 * the first real turn), so every line in the chunk is checked, not just the very first one.
 */
async function peekCwd(file: string): Promise<string | undefined> {
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: 65_536 })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { cwd?: unknown }
        if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) return parsed.cwd.trim()
      } catch { /* not JSON, or JSON with no cwd (e.g. a queue-operation line); keep scanning */ }
    }
  } catch { return undefined } finally { rl.close(); stream.close() }
  return undefined
}

function labelFromSlug(slug: string, cwd?: string): string {
  if (cwd) {
    const base = path.basename(cwd.replace(/[\\/]+$/, ''))
    if (base) return base
  }
  const parts = slug.split('-').filter(Boolean)
  return parts.slice(-2).join(' ') || slug
}

let rosterCache: { at: number; agents: ProjectAgent[] } | undefined
const ROSTER_CACHE_MS = 5_000

/**
 * Every project folder with at least one session active within ROSTER_WINDOW_MS, newest first.
 * `projectsDir` defaults to PROJECTS_DIR; tests point it at a throwaway directory instead (the
 * 5s roster cache is only ever used for the real, default directory).
 */
export async function listAgents(now = Date.now(), projectsDir = PROJECTS_DIR): Promise<ProjectAgent[]> {
  if (projectsDir === PROJECTS_DIR && rosterCache && now - rosterCache.at < ROSTER_CACHE_MS) return rosterCache.agents
  const slugs = await safeReaddir(projectsDir)
  const agents = (await Promise.all(slugs.map(async (slug): Promise<ProjectAgent | undefined> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(slug)) return undefined
    const dir = path.join(projectsDir, slug)
    const entries = await safeReaddir(dir)
    const sessionFiles = entries.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name))
    if (sessionFiles.length === 0) return undefined
    const mtimes = await Promise.all(sessionFiles.map(safeMtime))
    const lastActivity = Math.max(0, ...mtimes)
    if (now - lastActivity > ROSTER_WINDOW_MS) return undefined
    const newest = sessionFiles[mtimes.indexOf(lastActivity)]
    const cwd = newest ? await peekCwd(newest) : undefined
    return { slug, label: labelFromSlug(slug, cwd), dir, cwd, sessionFiles, lastActivity }
  }))).filter((agent): agent is ProjectAgent => agent !== undefined).sort((a, b) => b.lastActivity - a.lastActivity)
  if (projectsDir === PROJECTS_DIR) rosterCache = { at: now, agents }
  return agents
}

export interface TranscriptEntry {
  type?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  message?: { role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> }
}

/** Streams a session file line by line without loading it whole into memory. */
export async function* readTranscript(file: string): AsyncGenerator<TranscriptEntry> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) as TranscriptEntry } catch { /* skip a malformed/partial line */ }
    }
  } finally { rl.close(); stream.close() }
}

function contentBlocks(content: unknown): { type?: string; name?: string; text?: string }[] {
  return Array.isArray(content) ? content.filter((block): block is { type?: string; name?: string; text?: string } => !!block && typeof block === 'object') : []
}

export interface SessionSummary {
  id: string
  file: string
  title: string
  preview: string
  cwd?: string
  lastActive: number
  messageCount: number
}

/** Reads just enough of a session (first user turn + tail) to summarise it for lists. */
export async function summariseSession(file: string): Promise<SessionSummary | undefined> {
  const id = path.basename(file, '.jsonl')
  let title = ''
  let preview = ''
  let cwd: string | undefined
  let messageCount = 0
  let lastActive = await safeMtime(file)
  for await (const entry of readTranscript(file)) {
    if (entry.cwd) cwd = entry.cwd
    if (entry.timestamp) { const t = Date.parse(entry.timestamp); if (Number.isFinite(t)) lastActive = Math.max(lastActive, t) }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    messageCount += 1
    const content = entry.message?.content
    const text = typeof content === 'string' ? content : contentBlocks(content).find((block) => block.type === 'text')?.text
    if (!text) continue
    if (entry.type === 'user' && !title) title = text.trim().slice(0, 120)
    preview = text.trim().slice(0, 200)
  }
  if (messageCount === 0) return undefined
  return { id, file, title: title || preview || 'Untitled session', preview, cwd, lastActive, messageCount }
}

export interface UsageTotals { sessions: number; messages: number; toolCalls: number; inputTokens: number; outputTokens: number; models: Map<string, { sessions: number; tokens: number }>; tools: Map<string, number> }

function emptyUsage(): UsageTotals {
  return { sessions: 0, messages: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, models: new Map(), tools: new Map() }
}

/** Sums tokens, messages and tool calls across a set of session files within a time window. */
export async function collectUsageTotals(files: readonly string[], sinceMs: number, nowMs = Date.now()): Promise<UsageTotals> {
  const totals = emptyUsage()
  for (const file of files) {
    const mtime = await safeMtime(file)
    if (mtime < sinceMs) continue
    let touchedThisSession = false
    const sessionModels = new Set<string>()
    for await (const entry of readTranscript(file)) {
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (Number.isFinite(ts) && (ts < sinceMs || ts > nowMs)) continue
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      touchedThisSession = true
      totals.messages += 1
      if (entry.type === 'assistant') {
        const model = entry.message?.model
        if (model) sessionModels.add(model)
        const usage = entry.message?.usage
        if (usage) {
          const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)
          const output = Number(usage.output_tokens ?? 0)
          totals.inputTokens += Number.isFinite(input) ? input : 0
          totals.outputTokens += Number.isFinite(output) ? output : 0
          if (model) {
            const row = totals.models.get(model) ?? { sessions: 0, tokens: 0 }
            row.tokens += (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
            totals.models.set(model, row)
          }
        }
        for (const block of contentBlocks(entry.message?.content)) {
          if (block.type === 'tool_use' && block.name) {
            totals.toolCalls += 1
            totals.tools.set(block.name, (totals.tools.get(block.name) ?? 0) + 1)
          }
        }
      }
    }
    if (touchedThisSession) {
      totals.sessions += 1
      for (const model of sessionModels) { const row = totals.models.get(model) ?? { sessions: 0, tokens: 0 }; row.sessions += 1; totals.models.set(model, row) }
    }
  }
  return totals
}

export interface RecentSignal { active: boolean; kind?: 'tools' | 'chat' | 'thinking'; label?: string; lastSeen?: number }

/** Looks only at the tail of the newest session file to say what an agent is doing right now. */
export async function recentSignal(agent: ProjectAgent, now = Date.now()): Promise<RecentSignal> {
  if (agent.sessionFiles.length === 0) return { active: false }
  const mtimes = await Promise.all(agent.sessionFiles.map(safeMtime))
  const mtime = Math.max(...mtimes)
  const newest = agent.sessionFiles[mtimes.indexOf(mtime)]
  if (!newest) return { active: false }
  if (now - mtime > WORKING_WINDOW_MS) return { active: false }
  let lastType: string | undefined
  let lastTool: string | undefined
  let lastTs = mtime
  for await (const entry of readTranscript(newest)) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    lastType = entry.type
    if (entry.timestamp) { const t = Date.parse(entry.timestamp); if (Number.isFinite(t)) lastTs = t }
    const tool = contentBlocks(entry.message?.content).reverse().find((block) => block.type === 'tool_use')
    if (entry.type === 'assistant' && tool?.name) lastTool = tool.name
  }
  if (lastType === 'user') return { active: true, kind: 'thinking', label: 'Working on a request', lastSeen: lastTs }
  if (lastTool) return { active: true, kind: 'tools', label: `Using tools: ${lastTool}`, lastSeen: lastTs }
  return { active: true, kind: 'chat', label: 'Replying to a chat', lastSeen: lastTs }
}
