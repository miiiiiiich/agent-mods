import type { Listing, PullRequest, Repo } from '../types'

const REPO_GAP = 2
const NUMBER_HEADING = 'No.'
const MAX_WANTED_ROWS = 30
// A blank and the column names above the list, and a blank and the hint below.
const ROWS_AROUND_LIST = 4
const TITLE_ROWS = 2
// The hint and the column names.
const LABEL_ROWS = 2
const MIN_ROWS = 1
// With little room the rows come first: the blank lines go, then the title. An inline pane is often this short.
const ROOM_FOR_BLANKS = 9
const ROOM_FOR_TITLE = 12
// Below these, the title needs the room more than the column does.
const COLUMNS_FOR_AUTHOR = 66
const COLUMNS_FOR_STATUS = 50

interface Layout {
  numberWidth: number
  showAuthor: boolean
  showStatus: boolean
}

const emptyText = (current: Listing): string => {
  if (current.status === 'loading') {
    return 'Loading…'
  }
  if (current.isCut) {
    return 'Searching below this folder took too long. Open the pane in a smaller folder.'
  }
  if (current.scanned > 0) {
    return `No open pull requests in ${current.scanned} repos.`
  }
  return 'No GitHub repos in this folder.'
}

const repoLabel = (repo: Repo): string => `${repo.name} ${repo.prs.length}`

// How many rows the repos take once they wrap.
const repoRowsFor = (repos: Repo[], bodyColumns: number): number => {
  let rows = 1
  let used = 0
  for (const repo of repos) {
    const width = repoLabel(repo).length
    if (used > 0 && used + width > bodyColumns) {
      rows += 1
      used = 0
    }
    used += width + REPO_GAP
  }
  return rows
}

const chromeFor = (bodyRows: number): { hasBlanks: boolean; hasTitle: boolean } => ({
  hasBlanks: bodyRows >= ROOM_FOR_BLANKS,
  hasTitle: bodyRows >= ROOM_FOR_TITLE,
})

const pageSizeFor = (bodyRows: number, repoRows: number): number => {
  const { hasBlanks, hasTitle } = chromeFor(bodyRows)
  const blanks = Number(hasBlanks) * 2
  const title = Number(hasTitle) * 2
  return Math.max(MIN_ROWS, bodyRows - repoRows - LABEL_ROWS - blanks - title)
}

const pageOf = (rows: PullRequest[], at: number, size: number): PullRequest[] => {
  const start = Math.floor(at / size) * size
  return rows.slice(start, start + size)
}

const pageLabel = (count: number, at: number, size: number): string => {
  if (count <= size) {
    return ''
  }
  const start = Math.floor(at / size) * size
  return ` · ${start + 1}-${Math.min(start + size, count)} of ${count}`
}

// One step goes round at the ends. A page key or Home and End stop there.
const stepRow = (at: number, by: number, count: number): number => {
  if (Math.abs(by) === 1) {
    return (at + by + count) % count
  }
  return Math.max(0, Math.min(at + by, count - 1))
}

const layoutFor = (rows: PullRequest[], bodyColumns: number): Layout => ({
  numberWidth: Math.max(NUMBER_HEADING.length, ...rows.map(pr => `#${pr.number}`.length)),
  showAuthor: bodyColumns >= COLUMNS_FOR_AUTHOR,
  showStatus: bodyColumns >= COLUMNS_FOR_STATUS && rows.some(pr => pr.status !== 'none'),
})

// As tall as the longest list needs, with what the room then lets stand around it.
const wantedRows = (repos: Repo[], bodyColumns: number): number => {
  const longest = Math.max(0, ...repos.map(repo => repo.prs.length))
  const rows = longest + repoRowsFor(repos, bodyColumns) + ROWS_AROUND_LIST
  if (rows < ROOM_FOR_BLANKS) {
    return ROOM_FOR_BLANKS
  }
  if (rows < ROOM_FOR_TITLE) {
    return rows
  }
  return Math.min(MAX_WANTED_ROWS, rows + TITLE_ROWS)
}

export type { Layout }
export {
  chromeFor,
  emptyText,
  layoutFor,
  NUMBER_HEADING,
  pageLabel,
  pageOf,
  pageSizeFor,
  REPO_GAP,
  repoLabel,
  repoRowsFor,
  stepRow,
  wantedRows,
}
