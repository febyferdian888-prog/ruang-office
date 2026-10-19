import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Throttle } from './access.js'
import type { MemorySnapshot } from './memory.js'
import type { CalendarSnapshot, LogsSnapshot, OfficeSnapshot, OfficeStation, TaskBoardSnapshot } from './mission-control.js'
import { PRIVATE_JOB, PRIVATE_TASK, redactCalendar, redactLogs, redactMemory, redactOffice, redactTasks } from './privacy.js'
import { installProfileLock, isHidden, issueUnlock, ProfileLockStore, unlockedAgents, UNLOCK_MS, type Privacy } from './profile-lock.js'

const PIN = '482916'
let dir: string
let base: string
let close: () => void

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ruang-profile-lock-'))
  const app = express()
  const privacyOf = installProfileLock(app, new ProfileLockStore(dir), new Throttle({ free: 5, maxWaitMs: 5 * 60_000, hardLimit: 10, hardWaitMs: 60 * 60_000 }))
  app.get('/api/who', async (request, response) => { const privacy = await privacyOf(request); response.json({ hidden: [...privacy.hidden], all: privacy.all }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})
afterEach(() => close())

const post = (path: string, body: unknown, cookie = '') => fetch(`${base}/api/profile-lock/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ruang-request': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const who = async (cookie = '') => (await (await fetch(`${base}/api/who`, { headers: cookie ? { cookie } : {} })).json()) as { hidden: string[]; all: boolean }
const cookieOf = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? ''

describe('profile lock', () => {
  it('is off by default, then hides the chosen agents and stores only a hash', async () => {
    expect(await (await fetch(`${base}/api/profile-lock`)).json()).toMatchObject({ enabled: false, agents: [], pinLength: 6, unlockMinutes: 15 })
    expect((await post('setup', { pin: '1234', agents: ['coder'] })).status).toBe(400)
    expect((await post('setup', { pin: PIN, agents: ['--evil'] })).status).toBe(400)
    expect((await post('setup', { pin: PIN, agents: ['coder', 'research'] })).status).toBe(200)
    expect(await who()).toEqual({ hidden: ['coder', 'research'], all: false })
    const saved = await readFile(join(dir, 'profile-lock.json'), 'utf8')
    expect(saved).not.toContain(PIN)
    expect((await stat(join(dir, 'profile-lock.json'))).mode & 0o777).toBe(0o600)
    // A second setup cannot replace the PIN without the current one.
    expect((await post('setup', { pin: '111111', agents: [] })).status).toBe(409)
  })

  it('unlocks one agent at a time in this browser, and locks it again', async () => {
    await post('setup', { pin: PIN, agents: ['coder', 'research'] })
    expect((await post('unlock', { agent: 'coder', pin: '000000' })).status).toBe(401)
    expect((await post('unlock', { agent: 'default', pin: PIN })).status).toBe(400)
    const unlocked = await post('unlock', { agent: 'coder', pin: PIN })
    expect(unlocked.status).toBe(200)
    expect(unlocked.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/)
    expect(await unlocked.json()).toMatchObject({ unlocked: ['coder'] })
    const one = cookieOf(unlocked)
    expect((await who(one)).hidden).toEqual(['research'])
    const both = cookieOf(await post('unlock', { agent: 'research', pin: PIN }, one))
    expect((await who(both)).hidden).toEqual([])
    const relocked = cookieOf(await post('lock', { agent: 'coder' }, both))
    expect((await who(relocked)).hidden).toEqual(['coder'])
    // Another browser (no cookie) still sees both locked.
    expect((await who()).hidden).toEqual(['coder', 'research'])
  })

  it('needs the PIN to change agents or the PIN, and a new PIN ends every unlock', async () => {
    await post('setup', { pin: PIN, agents: ['coder'] })
    expect((await post('update', { pin: '999999', agents: [] })).status).toBe(401)
    expect((await post('update', { pin: PIN, agents: ['coder', 'writer'] })).status).toBe(200)
    expect((await who()).hidden).toEqual(['coder', 'writer'])
    const cookie = cookieOf(await post('unlock', { agent: 'coder', pin: PIN }))
    expect((await who(cookie)).hidden).toEqual(['writer'])
    expect((await post('update', { pin: PIN, newPin: '135790' }, cookie)).status).toBe(200)
    expect((await who(cookie)).hidden).toEqual(['coder', 'writer'])
    expect((await post('disable', { pin: PIN })).status).toBe(401)
    expect((await post('disable', { pin: '135790' })).status).toBe(200)
    expect(await who()).toEqual({ hidden: [], all: false })
  })

  it('slows down guessing and then locks out for an hour', async () => {
    await post('setup', { pin: PIN, agents: ['coder'] })
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await post('unlock', { agent: 'coder', pin: `00000${attempt}` })).status).toBe(401)
    const waiting = await post('unlock', { agent: 'coder', pin: PIN })
    expect(waiting.status).toBe(429)
    expect(await waiting.json()).toMatchObject({ error: expect.stringMatching(/Try again in 1 s/) })
    const throttle = new Throttle({ free: 5, maxWaitMs: 5 * 60_000, hardLimit: 10, hardWaitMs: 60 * 60_000 })
    for (let attempt = 0; attempt < 9; attempt += 1) throttle.fail('ip', 0)
    expect(throttle.waitMs('ip', 0)).toBe(16_000)
    throttle.fail('ip', 0)
    expect(throttle.waitMs('ip', 0)).toBe(60 * 60_000)
  })

  it('rejects cross-site changes and stays locked when the file is damaged', async () => {
    const forged = await fetch(`${base}/api/profile-lock/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN, agents: [] }) })
    expect(forged.status).toBe(403)
    await writeFile(join(dir, 'profile-lock.json'), '{oops')
    expect((await who()).all).toBe(true)
  })

  it('signs unlocks per agent, for 15 minutes', async () => {
    const file = await new ProfileLockStore(dir).setPin(PIN, ['coder', 'research'])
    const now = Date.parse('2026-10-06T00:00:00Z')
    const token = issueUnlock(file, 'coder', now)
    expect(unlockedAgents(file, token, now + 60_000)).toEqual(new Set(['coder']))
    expect(unlockedAgents(file, token, now + UNLOCK_MS + 1)).toEqual(new Set())
    const forged = token.replace(Buffer.from('coder').toString('base64url'), Buffer.from('research').toString('base64url'))
    expect(unlockedAgents(file, forged, now)).toEqual(new Set())
  })
})

describe('private data of locked agents', () => {
  const privacy: Privacy = { hidden: new Set(['coder', 'default']), locked: new Set(['coder', 'default', 'writer']), all: false }
  const station = (id: string, extra: Partial<OfficeStation> = {}): OfficeStation => ({ id, name: id, role: 'Hermes profile', room: 'Workspace', roomPosition: 'assigned-desk', state: 'Working', currentTask: 'Secret plan', recentActivity: 'Replying to a chat', activity: 'Kanban: Secret plan', seat: 1, provenance: 'live activity (hermes -p coder logs/sessions, last 3m): chat', freshness: '', ...extra })

  it('keeps locked agents in the office without their task or activity', () => {
    const office: OfficeSnapshot = { stations: [station('coder'), station('writer'), station('research')], summary: { declared: 3, active: 3, idle: 0, offline: 0, unknown: 0, gatewaysReachable: 0, gatewaysDeclared: 0 }, fetchedAt: '' }
    const [coder, writer, research] = redactOffice(office, privacy).stations
    expect(coder).toMatchObject({ id: 'coder', state: 'Working', privacy: 'locked', currentTask: '🔒 Private', activity: '🔒 Working' })
    expect(JSON.stringify(coder)).not.toContain('Secret plan')
    expect(coder.provenance).toBe('🔒 Private (profile lock)')
    expect(writer).toMatchObject({ privacy: 'unlocked', currentTask: 'Secret plan' })
    expect(research.privacy).toBeUndefined()
  })

  it('withholds task titles, cron job names, memory and the default agent logs', () => {
    const board: TaskBoardSnapshot = { tasks: { availability: 'available', data: [{ id: 't_1', title: 'Secret plan', status: 'running', assignee: 'Coder' }, { id: 't_2', title: 'Open plan', status: 'todo', assignee: 'research' }] }, fetchedAt: '' }
    expect(redactTasks(board, privacy).tasks.data.map((task) => task.title)).toEqual([PRIVATE_TASK, 'Open plan'])
    const calendar: CalendarSnapshot = { jobs: { availability: 'available', data: [{ name: 'Secret digest', schedule: '0 8 * * *', agent: 'coder' }, { name: 'Morning brief', schedule: '0 9 * * *', agent: 'research' }] }, fetchedAt: '' }
    const jobs = redactCalendar(calendar, privacy).jobs.data
    expect(jobs.map((job) => job.name)).toEqual([PRIVATE_JOB, 'Morning brief'])
    expect(jobs[0].schedule).toBe('0 8 * * *')
    const memory: MemorySnapshot = { agents: [{ profile: 'coder', label: 'coder', path: '~/work/coder', kind: 'claude-code', available: true, soul: { name: 'SOUL.md', path: 'SOUL.md', content: 'secret soul' } as never, contextFiles: [] }], fetchedAt: '' }
    const locked = redactMemory(memory, privacy).agents[0]
    expect(locked).toMatchObject({ locked: true, available: false })
    expect(JSON.stringify(locked)).not.toContain('secret soul')
    const logs: LogsSnapshot = { files: [{ name: 'agent', label: 'Agent', source: { availability: 'available', data: [{ text: 'secret line', level: 'INFO' }] } }], fetchedAt: '' }
    expect(JSON.stringify(redactLogs(logs, privacy))).not.toContain('secret line')
    expect(isHidden(privacy, 'CODER')).toBe(true)
    expect(isHidden({ hidden: new Set(['opencode']), locked: new Set(['opencode']), all: false }, 'open-code')).toBe(true)
  })
})
