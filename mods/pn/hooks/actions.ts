import type { EngineInterface, RenderSurface } from 'claude-code'

import type { Listing, PullRequest, Repo } from '../types'

const COPIED = 'Link copied'
// Left out, an inline pane gets a third of the screen. After the first open each folder remembers what its list needs.
const FIRST_ROWS = 16

const reposOf = (current: Listing): Repo[] => {
  if (current.status === 'loaded') {
    return current.repos
  }
  return []
}

const currentRepo = (repos: Repo[], slug: string): Repo | undefined => repos.find(repo => repo.slug === slug)

async function rememberedRows($: EngineInterface): Promise<number> {
  const remembered = await $.store.get(`rows:${await $.session.root()}`)
  if (typeof remembered === 'number' && remembered > 0) {
    return remembered
  }
  return FIRST_ROWS
}

async function rememberRows($: EngineInterface, rows: number): Promise<void> {
  await $.store.set(`rows:${await $.session.root()}`, rows)
}

async function openInBrowser($: EngineInterface, url: string): Promise<void> {
  const { exitCode, stderr } = await $.process.run(['open', url])
  if (exitCode !== 0) {
    $.ui.toast(`pn: could not open the browser: ${stderr.trim()}`)
  }
}

async function copyLink($: EngineInterface, pr: PullRequest, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: pr.url, surface })
  if (copied.isCopied) {
    $.ui.toast(`${COPIED}: #${pr.number}`)
    return
  }
  $.ui.toast(`pn: could not copy: ${copied.reason}`)
}

export { copyLink, currentRepo, openInBrowser, rememberedRows, rememberRows, reposOf }
