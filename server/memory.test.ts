import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveAgentFolders } from './folders.js'
import { collectMemory, parseEntries, parseMemorySettings } from './memory.js'

describe('memory settings', () => {
  it('reads the documented memory block and falls back to Hermes defaults', () => {
    expect(parseMemorySettings('model: x\nmemory:\n  memory_enabled: true\n  user_profile_enabled: false\n  memory_char_limit: 3000   # bigger\n  write_approval: true\n  provider: "honcho"\nskills:\n  write_approval: false\n')).toEqual({
      memoryEnabled: true, userProfileEnabled: false, writeApproval: true, provider: 'honcho', memoryLimit: 3000, userLimit: 1375, source: 'config.yaml',
    })
    expect(parseMemorySettings(undefined)).toEqual({ memoryEnabled: true, userProfileEnabled: true, writeApproval: false, memoryLimit: 2200, userLimit: 1375, source: 'defaults' })
  })

  it('splits entries on the section-sign delimiter, keeping multiline entries', () => {
    expect(parseEntries('Runs Ubuntu 22.04\n§\nProject at ~/code/api\nuses Go 1.22\n§\n')).toEqual(['Runs Ubuntu 22.04', 'Project at ~/code/api\nuses Go 1.22'])
  })
})

describe('agent memory (Claude Code projects)', () => {
  let home: string
  const write = (file: string, content: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content) }
  const session = (slug: string, id: string, cwd: string) => write(
    path.join(home, '.claude', 'projects', slug, `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } })}\n`,
  )
  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'mc-memory-'))
    const leadProject = path.join(home, 'work', 'lead')
    session('lead-slug', '11111111-1111-1111-1111-111111111111', leadProject)
    write(path.join(leadProject, 'CLAUDE.md'), '# Lead\nDeploy key: api_key=sk-live-abcdefghijklmnop\n')
    write(path.join(leadProject, '.env'), 'SECRET=1\n')
    const engineerProject = path.join(home, 'work', 'engineer')
    mkdirSync(engineerProject, { recursive: true })
    session('engineer-slug', '22222222-2222-2222-2222-222222222222', engineerProject)
    // No CLAUDE.md for the engineer project: it is a known agent with no context files.
    // `research-slug` is deliberately never listed as a known agent, so its folder cannot resolve.
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('collects CLAUDE.md context files per agent from its real project folder, redacted', async () => {
    const snapshot = await collectMemory(await resolveAgentFolders(['lead-slug', 'engineer-slug', 'research-slug'], {}, home))
    const [lead, engineer, research] = snapshot.agents
    expect(lead).toMatchObject({ profile: 'lead-slug', kind: 'claude-code', available: true })
    expect(lead.contextFiles).toMatchObject([{ name: 'CLAUDE.md', content: '# Lead\nDeploy key: api_key=[redacted]\n' }])
    expect(JSON.stringify(snapshot)).not.toContain('sk-live')
    expect(JSON.stringify(snapshot)).not.toContain('SECRET=1')
    expect(engineer).toMatchObject({ kind: 'claude-code', available: true, contextFiles: [] })
    expect(research).toMatchObject({ available: false, reason: 'Folder not found on this machine' })
  })

  it('reads OpenCode global context unchanged', async () => {
    write(path.join(home, '.opencode', 'AGENTS.md'), '# OpenCode rules\n')
    const snapshot = await collectMemory(await resolveAgentFolders([], {}, home))
    const openCode = snapshot.agents.find((agent) => agent.profile === 'opencode')
    expect(openCode).toMatchObject({ kind: 'opencode', contextFiles: [{ name: 'AGENTS.md', content: '# OpenCode rules\n' }] })
  })
})
