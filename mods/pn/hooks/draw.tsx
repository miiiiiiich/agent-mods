import type { ElementTable, RenderElement, RenderSurface, ThemeKey, UiPressArgument } from 'claude-code'

import type { CiState, PrStatus, PullRequest, Repo } from '../types'
import { formatAge } from './github'
import {
  chromeFor,
  type Layout,
  layoutFor,
  NUMBER_HEADING,
  pageLabel,
  pageOf,
  pageSizeFor,
  REPO_GAP,
  repoLabel,
  repoRowsFor,
} from './layout'

const REPO_KEY = 'repo:'
const ROW_KEY = 'pr:'
const COPY_KEY = 'copy'
const TOP_KEY = 'top'
const TITLE = 'Pull Requests'
const BLANK = ' '
const HINT = '↑↓ move · Enter open · Esc close'
const HINT_REPOS = '↑↓ move · Tab repo · Enter open · Esc close'
const COPY_LABEL = 'copy link'
const COPY_HOTKEY = 'c'

const CI_MARKS: Record<CiState, { glyph: string; color: ThemeKey }> = {
  pass: { glyph: '✓', color: 'success' },
  fail: { glyph: '✗', color: 'error' },
  pending: { glyph: '●', color: 'warning' },
  none: { glyph: '·', color: 'inactive' },
}
const LEGEND: { ci: CiState; word: string }[] = [
  { ci: 'pass', word: 'pass' },
  { ci: 'fail', word: 'fail' },
  { ci: 'pending', word: 'running' },
]
const STATUS_COLORS: Record<PrStatus, ThemeKey> = {
  draft: 'inactive',
  conflict: 'error',
  changes: 'error',
  approved: 'success',
  review: 'warning',
  none: 'inactive',
}
const STATUS_WORDS: Record<PrStatus, string> = {
  draft: 'draft',
  conflict: 'conflict',
  changes: 'changes',
  approved: 'approved',
  review: 'needs review',
  none: '',
}
const STATUS_WIDTH = 12
const AUTHOR_WIDTH = 12
const AGE_WIDTH = 4
const COLUMN_GAP = 2
const COLUMNS_FOR_LEGEND = 50

type Kit = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

interface RowOptions {
  now: number
  layout: Layout
  isTerminal: boolean
  isSelected: boolean
  onOpen: () => void
}

const rowKey = (pr: PullRequest): string => `${ROW_KEY}${pr.number}`
const repoKey = (repo: Repo): string => `${REPO_KEY}${repo.slug}`

const fitAuthor = (author: string): string => {
  if (author.length > AUTHOR_WIDTH) {
    return `${author.slice(0, AUTHOR_WIDTH - 1)}…`
  }
  return author.padEnd(AUTHOR_WIDTH)
}

const drawTitle = ({ Box, Text }: Kit, bodyColumns: number): RenderElement => (
  <Box flexDirection="row" justifyContent="space-between">
    <Text bold={true}>{TITLE}</Text>
    {bodyColumns >= COLUMNS_FOR_LEGEND && (
      <Box flexDirection="row" gap={COLUMN_GAP}>
        {LEGEND.map(({ ci, word }) => (
          <Text>
            <Text color={CI_MARKS[ci].color}>{CI_MARKS[ci].glyph}</Text>
            <Text dimColor={true}>{` ${word}`}</Text>
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

const drawRepos = (
  { Box, Button, Text }: Kit,
  repos: Repo[],
  current: Repo,
  onPress: (repo: Repo, press: UiPressArgument) => void,
): RenderElement => (
  <Box flexDirection="row" flexWrap="wrap" columnGap={REPO_GAP}>
    {repos.map(repo => {
      const isActive = repo.slug === current.slug
      return (
        <Button key={repoKey(repo)} plain={true} onPress={(press): void => onPress(repo, press)}>
          <Text bold={isActive} {...(isActive && { color: 'suggestion' as const })} dimColor={!isActive}>
            {repoLabel(repo)}
          </Text>
        </Button>
      )
    })}
  </Box>
)

const drawHeader = ({ Box, Text }: Kit, layout: Layout): RenderElement => (
  <Box flexDirection="row" gap={1}>
    <Box flexGrow={1} flexShrink={1}>
      <Text bold={true} dimColor={true} wrap="truncate-end">
        {`CI ${NUMBER_HEADING.padEnd(layout.numberWidth)} Title`}
      </Text>
    </Box>
    <Box flexShrink={0} gap={COLUMN_GAP}>
      {layout.showStatus && (
        <Text mono={true} bold={true} dimColor={true}>
          {'Status'.padStart(STATUS_WIDTH)}
        </Text>
      )}
      {layout.showAuthor && (
        <Text mono={true} bold={true} dimColor={true}>
          {'Author'.padEnd(AUTHOR_WIDTH)}
        </Text>
      )}
      <Text mono={true} bold={true} dimColor={true}>
        {'Age'.padStart(AGE_WIDTH)}
      </Text>
    </Box>
  </Box>
)

const drawLabel = ({ Text }: Kit, pr: PullRequest, { layout, isSelected }: RowOptions): RenderElement[] => [
  <Text bold={true} color="suggestion" underline={isSelected}>
    {`#${pr.number}`.padEnd(layout.numberWidth)}
  </Text>,
  <Text dimColor={pr.status === 'draft'} underline={isSelected}>{` ${pr.title}`}</Text>,
]

// On the terminal a row is plain text: the arrows move an underline, and Enter acts on it through the repo holding the
// ring, so nothing inverts a whole row. A desktop has no such keys, and its rows are buttons to click.
const drawLead = (kit: Kit, pr: PullRequest, options: RowOptions): RenderElement => {
  const { Box, Button, Text } = kit
  const mark = CI_MARKS[pr.ci]
  if (options.isTerminal) {
    return (
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={mark.color}>{`${mark.glyph}  `}</Text>
          {drawLabel(kit, pr, options)}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexGrow={1} flexShrink={1}>
      <Button key={rowKey(pr)} plain={true} {...(pr.status === 'draft' && { dimColor: true })} onPress={options.onOpen}>
        <Text color={mark.color}>{`${mark.glyph}  `}</Text>
        {drawLabel(kit, pr, options)}
      </Button>
    </Box>
  )
}

const drawRow = (kit: Kit, pr: PullRequest, options: RowOptions): RenderElement => {
  const { Box, Text } = kit
  const { now, layout } = options
  return (
    <Box key={`row:${pr.number}`} flexDirection="row" gap={1}>
      {drawLead(kit, pr, options)}
      <Box flexShrink={0} gap={COLUMN_GAP}>
        {layout.showStatus && (
          <Text mono={true} color={STATUS_COLORS[pr.status]}>
            {STATUS_WORDS[pr.status].padStart(STATUS_WIDTH)}
          </Text>
        )}
        {layout.showAuthor && (
          <Text mono={true} dimColor={true}>
            {fitAuthor(pr.author)}
          </Text>
        )}
        <Text mono={true} dimColor={true}>
          {formatAge(pr.updatedAt, now).padStart(AGE_WIDTH)}
        </Text>
      </Box>
    </Box>
  )
}

const drawHint = (
  { Box, Button, Text }: Kit,
  repos: Repo[],
  position: string,
  onCopy: (press: UiPressArgument) => void,
): RenderElement => {
  let hint = HINT
  if (repos.length > 1) {
    hint = HINT_REPOS
  }
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={REPO_GAP}>
      <Text dimColor={true}>{`${hint}${position}`}</Text>
      <Button key={COPY_KEY} plain={true} dimColor={true} hotkey={COPY_HOTKEY} label={COPY_LABEL} onPress={onCopy} />
    </Box>
  )
}

const drawBlank = ({ Text }: Kit): RenderElement => <Text>{BLANK}</Text>

// Arrows only reach a mod as scrolling, and only while there are rows to scroll both ways. So the tree opens on a blank
// row the window starts below, and ends past the room, and the mod answers each scroll without moving the window.
const drawFiller = ({ Text }: Kit, bodyRows: number): RenderElement[] =>
  Array.from({ length: bodyRows + 2 }, () => <Text>{BLANK}</Text>)

interface PaneSize {
  surface: RenderSurface
  bodyColumns: number
  bodyRows: number
}

interface ListView {
  repos: Repo[]
  repo: Repo
  at: number
  now: number
}

interface ListHandlers {
  onPressRepo: (repo: Repo, press: UiPressArgument) => void
  onCopy: (press: UiPressArgument) => void
  onOpen: (pr: PullRequest) => void
}

const drawFrame = (kit: Kit, { surface, bodyRows }: PaneSize, content: RenderElement): RenderElement => {
  const { Box } = kit
  const isTerminal = surface === 'terminal'
  return (
    <Box flexDirection="column">
      {isTerminal && drawBlank(kit)}
      <Box key={TOP_KEY} flexDirection="column">
        {content}
      </Box>
      {isTerminal && drawFiller(kit, bodyRows)}
    </Box>
  )
}

const drawWaiting = (kit: Kit, size: PaneSize, text: string): RenderElement => {
  const { Box, Text } = kit
  return drawFrame(
    kit,
    size,
    <Box flexDirection="column">
      {drawTitle(kit, size.bodyColumns)}
      <Text dimColor={true}>{text}</Text>
    </Box>,
  )
}

const drawList = (kit: Kit, size: PaneSize, view: ListView, handlers: ListHandlers): RenderElement => {
  const { Box, Text } = kit
  const { surface, bodyColumns, bodyRows } = size
  const { repos, repo, at, now } = view
  const isTerminal = surface === 'terminal'
  const { hasBlanks, hasTitle } = chromeFor(bodyRows)
  let rows = repo.prs
  let position = ''
  if (isTerminal) {
    const pageSize = pageSizeFor(bodyRows, repoRowsFor(repos, bodyColumns))
    rows = pageOf(repo.prs, at, pageSize)
    position = pageLabel(repo.prs.length, at, pageSize)
  }
  const layout = layoutFor(rows, bodyColumns)
  const selectedNumber = repo.prs[at]?.number
  const blank = isTerminal && hasBlanks && drawBlank(kit)
  const showTitle = !isTerminal || hasTitle
  return drawFrame(
    kit,
    size,
    <Box flexDirection="column">
      {showTitle && drawTitle(kit, bodyColumns)}
      {showTitle && drawBlank(kit)}
      {drawRepos(kit, repos, repo, handlers.onPressRepo)}
      {blank}
      {rows.length > 0 && drawHeader(kit, layout)}
      <Box flexDirection="column">
        {repo.error !== undefined && <Text color="error">{repo.error}</Text>}
        {rows.map(pr =>
          drawRow(kit, pr, {
            now,
            layout,
            isTerminal,
            isSelected: isTerminal && pr.number === selectedNumber,
            onOpen: (): void => handlers.onOpen(pr),
          }),
        )}
      </Box>
      {blank}
      {isTerminal && drawHint(kit, repos, position, handlers.onCopy)}
    </Box>,
  )
}

export { drawList, drawWaiting, REPO_KEY, ROW_KEY, repoKey, TOP_KEY }
