import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
  RenderSurface,
  UiFocusInput,
  UiFocusResult,
  UiPressArgument,
  UiScrollInput,
  UiScrollResult,
} from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Listing, PullRequest, Repo } from '../types'
import { copyLink, currentRepo, openInBrowser, rememberedRows, rememberRows, reposOf } from './actions'
import { drawList, drawWaiting, REPO_KEY, ROW_KEY, repoKey, TOP_KEY } from './draw'
import { loadRepos } from './github'
import { emptyText, stepRow, wantedRows } from './layout'

const COMMAND = 'pn:pr'
const PANE = 'pr'
const OPEN_ARGS = { id: PANE, title: 'Pull Requests', focus: true, closeOnEscape: true } as const
// `sdk` is how the desktop app's sessions receive what the person typed.
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk']

const listing = atom({ plugin: 'pn', key: 'listing' } as const, { status: 'loading' }, { shape: 'listing-4' })
const selected = atom({ plugin: 'pn', key: 'selected' } as const, '')
const focused = atom({ plugin: 'pn', key: 'focused' } as const, 0)

// Names the open: what an older open still has loading must not land in this one.
let generation = 0
// Whether this open has held the keys: until it has, not holding them says nothing.
let hadKeys = false
// Which repo the ring last landed on: tells which way a move off the repos was going.
let landedRepo = 0
let lastColumns = 0
// A surface that scrolls by itself keeps its own arrows, wheel and window.
let isOnTerminal = false

const report = ($: EngineInterface, error: unknown): void => {
  $.ui.log(`pn: ${String(error)}`, { to: 'debug' })
}

const closePane = ($: EngineInterface): void => {
  $.ui.close({ id: PANE }).catch((error: unknown) => report($, error))
}

// The pane lives only while it holds the keys. Left open behind a conversation, Esc can't reach it: the prompt, the
// turn or a dialog takes that key first. A render hook may not close it, so the close goes through a timer.
const closeWhenKeysLeave = ($: EngineInterface, isFocused: boolean, drawnIn: number): void => {
  if (drawnIn !== generation) {
    return
  }
  if (isFocused) {
    hadKeys = true
    return
  }
  if (hadKeys) {
    hadKeys = false
    $.clock.after(0, () => {
      if (drawnIn === generation) {
        closePane($)
      }
    })
  }
}

const moveRing = async ($: EngineInterface, repos: Repo[], index: number): Promise<void> => {
  const repo = repos[index]
  if (repo === undefined) {
    return
  }
  const moved = await $.ui.focus({ requestId: PANE, key: repoKey(repo) }).catch((error: unknown) => ({
    deny: String(error),
  }))
  if ('deny' in moved) {
    $.ui.log(`pn: the focus stayed: ${String(moved.deny)}`, { to: 'debug' })
    return
  }
  // This mod's own move is not raised to its own `ui.focus` hook, so the landing is noted here.
  landedRepo = index
}

const pinWindow = async ($: EngineInterface): Promise<void> => {
  if (isOnTerminal) {
    await $.ui.scroll({ in: PANE, to: { key: TOP_KEY }, block: 'start' }).catch((error: unknown) => report($, error))
  }
}

const selectRepo = async ($: EngineInterface, repo: Repo): Promise<void> => {
  await update($, selected, () => repo.slug)
  await update($, focused, () => 0)
}

const load = async ($: EngineInterface, startedIn: number): Promise<void> => {
  await pinWindow($)
  const { repos, scanned } = await loadRepos($)
  if (startedIn !== generation) {
    return
  }
  const [first] = repos
  // The repo first: a draw between the two writes would otherwise find none and say nothing is open.
  if (first !== undefined) {
    await update($, selected, () => first.slug)
  }
  await update($, listing, (): Listing => ({ status: 'loaded', repos, scanned }))
  // An open pane keeps the height it opened at, so the height this list needs is for the next open.
  await rememberRows($, wantedRows(repos, lastColumns))
  if (first !== undefined && startedIn === generation) {
    await moveRing($, repos, 0)
  }
  await pinWindow($)
}

const openPane = async ($: EngineInterface): Promise<{ text?: string }> => {
  generation += 1
  const startedIn = generation
  hadKeys = false
  landedRepo = 0
  await update($, listing, (): Listing => ({ status: 'loading' }))
  await update($, selected, () => '')
  await update($, focused, () => 0)
  const opened = await $.ui.open({ ...OPEN_ARGS, rows: await rememberedRows($) })
  // Even a pane still waiting for a surface: it stays open, and draws what this loads once one attaches.
  $.clock.after(0, () => {
    load($, startedIn).catch((error: unknown) => report($, error))
  })
  if (!opened.isPlaced) {
    return { text: `Could not open the pane: ${opened.reason}` }
  }
  return {}
}

const selectedRow = async ($: EngineInterface): Promise<PullRequest | undefined> => {
  const [current, slug, at] = await Promise.all([read($, listing), read($, selected), read($, focused)])
  return currentRepo(reposOf(current), slug)?.prs[at]
}

const copySelected = async ($: EngineInterface, surface: RenderSurface): Promise<void> => {
  const pr = await selectedRow($)
  if (pr !== undefined) {
    await copyLink($, pr, surface)
  }
}

// Enter lands here, on the repo holding the ring, and opens the row under the underline. A click presses without moving
// the ring, so a click on another repo brings the ring along.
const pressRepo = async ($: EngineInterface, repo: Repo, press: UiPressArgument): Promise<void> => {
  const [current, slug] = await Promise.all([read($, listing), read($, selected)])
  if (repo.slug !== slug) {
    const repos = reposOf(current)
    await selectRepo($, repo)
    await moveRing(
      $,
      repos,
      repos.findIndex(candidate => candidate.slug === repo.slug),
    )
    return
  }
  const pr = await selectedRow($)
  if (press.surface === 'terminal' && pr !== undefined) {
    await openInBrowser($, pr.url)
  }
}

// For a pane that never held the keys: the focus refused at open, or a surface that does not report it.
const closeForPrompt = async ($: EngineInterface, origin: string, command: string | undefined): Promise<void> => {
  if (PERSON_ORIGINS.includes(origin) && command !== COMMAND) {
    await $.ui.close({ id: PANE })
  }
}

// Tab walks the repos alone: a move onto the copy button or the close mark stays put, and a timer takes it round.
const goRound = ($: EngineInterface, repos: Repo[]): void => {
  let target = repos.length - 1
  if (landedRepo === repos.length - 1) {
    target = 0
  }
  const repo = repos[target]
  if (repo === undefined) {
    return
  }
  $.clock.after(0, () => {
    moveRing($, repos, target)
      .then(() => selectRepo($, repo))
      .catch((error: unknown) => report($, error))
  })
}

const followRing = async (
  $: EngineInterface,
  e: UiFocusInput,
  next: (e: UiFocusInput) => Promise<UiFocusResult>,
): Promise<UiFocusResult> => {
  if (e.origin.kind !== 'person' || !isOnTerminal || e.element?.startsWith(ROW_KEY) === true) {
    return next(e)
  }
  const repos = reposOf(await read($, listing))
  if (e.element?.startsWith(REPO_KEY) !== true) {
    if (repos.length === 0) {
      return next(e)
    }
    goRound($, repos)
    return {}
  }
  const result = await next(e)
  const index = repos.findIndex(candidate => repoKey(candidate) === e.element)
  const landed = repos[index]
  if (!('deny' in result) && landed !== undefined) {
    landedRepo = index
    await selectRepo($, landed)
  }
  return result
}

const followArrows = async (
  $: EngineInterface,
  e: UiScrollInput,
  next: (e: UiScrollInput) => Promise<UiScrollResult>,
): Promise<UiScrollResult> => {
  if (e.origin.kind !== 'person' || !isOnTerminal) {
    return next(e)
  }
  const [current, slug] = await Promise.all([read($, listing), read($, selected)])
  const count = currentRepo(reposOf(current), slug)?.prs.length ?? 0
  if (count > 0) {
    await update($, focused, at => stepRow(at, e.by, count))
  }
  return {}
}

const drawPane = async ($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> => {
  const drawnIn = generation
  const [current, slug, at, now] = await Promise.all([
    read($, listing),
    read($, selected),
    read($, focused),
    $.clock.now(),
  ])
  isOnTerminal = e.surface === 'terminal'
  lastColumns = e.props.bodyColumns
  if (isOnTerminal) {
    closeWhenKeysLeave($, e.props.isFocused, drawnIn)
  }
  const table = $.ui.resolve(e)
  const size = {
    surface: e.surface,
    bodyColumns: e.props.bodyColumns,
    bodyRows: e.props.scroll.bodyRows,
  }
  const repos = reposOf(current)
  const repo = currentRepo(repos, slug)
  if (repo === undefined) {
    return drawWaiting(table, size, emptyText(current))
  }
  return drawList(
    table,
    size,
    { repos, repo, at, now },
    {
      onPressRepo: (chosen, press) => {
        pressRepo($, chosen, press).catch((error: unknown) => report($, error))
      },
      onCopy: press => {
        copySelected($, press.surface).catch((error: unknown) => report($, error))
      },
      onOpen: pr => {
        openInBrowser($, pr.url).catch((error: unknown) => report($, error))
      },
    },
  )
}

export const register: Register = on => {
  on('command.run', { command: COMMAND }, $ => openPane($))

  on('prompt.submit', async ($, e, next) => {
    await closeForPrompt($, e.origin.kind, e.command?.name)
    return next(e)
  })

  on('ui.focus', { requestId: PANE }, followRing)

  on('ui.scroll', { requestId: PANE }, followArrows)

  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
}
