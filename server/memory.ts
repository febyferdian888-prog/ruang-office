import { FolderError, readFolderFile, type AgentFolder } from './folders.js'

// Memory & knowledge view of each agent.
//
// A Claude Code agent (a project folder, see claude-code.ts) has no Hermes-style SOUL.md or
// memories/MEMORY.md + memories/USER.md stores; its persistent instructions live in CLAUDE.md
// files read at the start of every session (project CLAUDE.md, plus a project-local override),
// so that is what this page shows as its context files instead.
// Every read goes through readFolderFile, so it stays inside the agent's folder, never opens
// credential files and is secret-redacted.

export const ENTRY_DELIMITER = '\n§\n'
export const DEFAULT_MEMORY_LIMIT = 2200
export const DEFAULT_USER_LIMIT = 1375
const CLAUDE_CODE_CONTEXT_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.clauderules']
const OPENCODE_CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md']

export interface MemoryDocument {
  name: string
  path: string
  exists: boolean
  size?: number
  modified?: string
  chars?: number
  content?: string
  truncated?: boolean
  redactions?: number
  error?: string
}
export interface MemoryStore extends MemoryDocument {
  entries: string[]
  limit: number
  used: number
  percent: number
}
export interface MemorySettings {
  memoryEnabled: boolean
  userProfileEnabled: boolean
  writeApproval: boolean
  provider?: string
  memoryLimit: number
  userLimit: number
  source: 'config.yaml' | 'defaults'
}
export interface AgentMemory {
  profile: string
  label: string
  path: string
  kind: 'claude-code' | 'opencode'
  available: boolean
  reason?: string
  soul?: MemoryDocument
  memory?: MemoryStore
  user?: MemoryStore
  contextFiles: MemoryDocument[]
  settings?: MemorySettings
  /** Withheld by the profile lock. */
  locked?: boolean
}
export interface MemorySnapshot { agents: AgentMemory[]; fetchedAt: string }

async function readDocument(folder: AgentFolder, relative: string): Promise<MemoryDocument> {
  const name = relative.split('/').pop() ?? relative
  try {
    const file = await readFolderFile(folder, relative)
    if (file.kind === 'sensitive') return { name, path: relative, exists: true, size: file.size, modified: file.modified, error: 'Credential-like file; not opened.' }
    if (file.kind === 'binary') return { name, path: relative, exists: true, size: file.size, modified: file.modified, error: 'Binary file; no preview.' }
    return { name, path: relative, exists: true, size: file.size, modified: file.modified, chars: file.content?.length ?? 0, content: file.content ?? '', truncated: file.truncated, redactions: file.redactions }
  } catch (error) {
    if (error instanceof FolderError && error.status === 404) return { name, path: relative, exists: false }
    return { name, path: relative, exists: true, error: error instanceof Error ? error.message : 'Could not read this file.' }
  }
}

export function parseEntries(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean)
}

/** Reads the `memory:` block of config.yaml (flat keys only; enough for the documented settings). */
export function parseMemorySettings(configYaml: string | undefined): MemorySettings {
  const values = new Map<string, string>()
  if (configYaml) {
    let inside = false
    for (const raw of configYaml.replace(/\r\n/g, '\n').split('\n')) {
      if (/^memory:\s*(#.*)?$/.test(raw)) { inside = true; continue }
      if (!inside) continue
      if (/^\S/.test(raw)) break
      const match = raw.match(/^\s+([A-Za-z_]+):\s*("?)([^"#]*)\2\s*(#.*)?$/)
      if (match) values.set(match[1], match[3].trim())
    }
  }
  const flag = (key: string, fallback: boolean) => {
    const value = values.get(key)?.toLowerCase()
    return value === undefined || value === '' ? fallback : ['true', 'yes', 'on', '1'].includes(value)
  }
  const number = (key: string, fallback: number) => {
    const value = Number(values.get(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const provider = values.get('provider')
  return {
    memoryEnabled: flag('memory_enabled', true),
    userProfileEnabled: flag('user_profile_enabled', true),
    writeApproval: flag('write_approval', false),
    ...(provider && !['null', 'none', '~'].includes(provider.toLowerCase()) ? { provider } : {}),
    memoryLimit: number('memory_char_limit', DEFAULT_MEMORY_LIMIT),
    userLimit: number('user_char_limit', DEFAULT_USER_LIMIT),
    source: values.size > 0 ? 'config.yaml' : 'defaults',
  }
}

export async function collectAgentMemory(folder: AgentFolder): Promise<AgentMemory> {
  const base = { profile: folder.profile, label: folder.label, path: folder.path }
  const kind = folder.profile === 'opencode' ? 'opencode' as const : 'claude-code' as const
  if (!folder.available) return { ...base, kind, available: false, reason: folder.reason, contextFiles: [] }
  const files = folder.profile === 'opencode' ? OPENCODE_CONTEXT_FILES : CLAUDE_CODE_CONTEXT_FILES
  const contextFiles = (await Promise.all(files.map((name) => readDocument(folder, name)))).filter((document) => document.exists)
  return { ...base, kind, available: true, contextFiles }
}

export async function collectMemory(folders: AgentFolder[]): Promise<MemorySnapshot> {
  // One unreadable agent must not take the whole page down.
  const agents = await Promise.all(folders.map((folder) => collectAgentMemory(folder).catch((error: unknown): AgentMemory => ({
    profile: folder.profile, label: folder.label, path: folder.path, kind: folder.profile === 'opencode' ? 'opencode' : 'claude-code',
    available: false, reason: error instanceof Error ? error.message : 'Could not read this agent.', contextFiles: [],
  }))))
  return { agents, fetchedAt: new Date().toISOString() }
}
