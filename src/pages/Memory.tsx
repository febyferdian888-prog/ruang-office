import { useState } from 'react'
import { formatDateTime, formatNumber } from '../format.ts'
import { usePolling } from '../polling.ts'
import type { AgentMemory, MemoryDocument, MemorySnapshot } from '../types.ts'
import { EmptyState, LoadingState, PageTitle, SourceStatus, Unavailable } from '../ui.tsx'
import { PixelCharacter } from './Office.tsx'
import { PrivateGate, ProfileUnlock } from '../ProfileLock.tsx'

function DocumentBody({ document, empty }: { document?: MemoryDocument; empty: string }) {
  if (!document || !document.exists) return <p className="muted">{empty}</p>
  if (document.error) return <p className="file-notice locked">{document.error}</p>
  return <>
    <p className="doc-meta">{formatNumber(document.chars ?? 0)} chars · updated {formatDateTime(document.modified)}{document.redactions ? ` · ${document.redactions} line(s) redacted` : ''}{document.truncated ? ' · showing first 256 KB' : ''}</p>
    <pre className="task-text doc-text">{document.content || <span className="muted">(empty file)</span>}</pre>
  </>
}

function AgentPanel({ agent, onOpenFolders }: { agent: AgentMemory; onOpenFolders?: () => void }) {
  const [openContext, setOpenContext] = useState<string | undefined>()
  if (!agent.available) return <EmptyState title="Not available">{agent.reason ?? 'This agent folder is not available.'}</EmptyState>
  return <div className="memory-panel">
    <div className="toolbar">
      <code className="folder-path">{agent.path}</code>
      {onOpenFolders && <button type="button" className="refresh-button" onClick={onOpenFolders}>OPEN IN FOLDERS →</button>}
    </div>
    <article className="card memory-soul">
      <header className="memory-card-head"><div><p className="eyebrow">CONTEXT FILES</p><h2>{agent.kind === 'opencode' ? 'Global rules' : 'CLAUDE.md, .clauderules…'}</h2></div></header>
      {agent.contextFiles.length === 0 ? <p className="muted">No context files in this project folder yet.</p>
        : <ul className="context-list">{agent.contextFiles.map((document) => <li key={document.path}>
          <button type="button" className="file-row" aria-expanded={openContext === document.path} onClick={() => setOpenContext(openContext === document.path ? undefined : document.path)}><span className="file-icon" aria-hidden="true">📄</span><span className="file-name">{document.name}</span><span className="file-size">{formatNumber(document.chars ?? 0)} chars</span></button>
          {openContext === document.path && <DocumentBody document={document} empty=""/>}
        </li>)}</ul>}
    </article>
  </div>
}

/** One agent's context files (CLAUDE.md etc.), for the Office agent dialog. */
export function AgentMemoryView({ profile }: { profile: string }) {
  const snapshot = usePolling<MemorySnapshot>('/api/memory', 30_000)
  const agent = snapshot.status === 'ready' ? snapshot.data.agents.find((item) => item.profile === profile) : undefined
  if (snapshot.status === 'pending') return <LoadingState message="Reading agent memory..."/>
  if (snapshot.status === 'failed') return <EmptyState title="Not Available">{snapshot.message ?? 'Memory could not be read.'}</EmptyState>
  if (!agent) return <EmptyState title="Not available">No memory was found for this agent.</EmptyState>
  return <PrivateGate agent={agent.profile} compact>{agent.locked ? <ProfileUnlock agent={agent.profile} compact/> : <AgentPanel key={agent.profile} agent={agent}/>}</PrivateGate>
}

export function Memory({ onOpenFolders }: { onOpenFolders?: () => void }) {
  const snapshot = usePolling<MemorySnapshot>('/api/memory', 30_000)
  const data = snapshot.status === 'ready' ? snapshot.data : undefined
  const [selected, setSelected] = useState<string | undefined>()
  const agents = data?.agents ?? []
  const agent = agents.find((item) => item.profile === selected) ?? agents.find((item) => item.available) ?? agents[0]
  const source = data ? { availability: 'available' as const, data: null } : undefined
  return <><PageTitle eyebrow="MEMORY & KNOWLEDGE" title="Memory">What each agent carries into every session: its CLAUDE.md context files, read from the project it works in. Read-only; secrets are redacted.</PageTitle>
    <SourceStatus source={source} fetchedAt={data?.fetchedAt} request={snapshot}/>
    <Unavailable source={source} request={snapshot}/>
    {snapshot.status === 'pending' ? <LoadingState message="Reading agent memory..."/> : agent && <>
      <div className="memory-tabs" role="tablist" aria-label="Agents">{agents.map((item) => {
        return <button key={item.profile} role="tab" aria-selected={item.profile === agent.profile} className={`memory-tab${item.profile === agent.profile ? ' active' : ''}`} onClick={() => setSelected(item.profile)} disabled={!item.available && !item.locked}>
          <span className="folder-glyph small" aria-hidden="true"><PixelCharacter agent={item.profile}/></span>
          <span><strong>{item.locked ? '🔒 ' : ''}{item.label}</strong><small>{!item.available ? item.reason ?? 'not available' : `${item.contextFiles.length} context file(s)`}</small></span>
        </button>
      })}</div>
      <PrivateGate agent={agent.profile}>{agent.locked ? <ProfileUnlock agent={agent.profile}/> : <AgentPanel key={agent.profile} agent={agent} onOpenFolders={onOpenFolders}/>}</PrivateGate>
    </>}
  </>
}
