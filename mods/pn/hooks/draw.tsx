import type { RenderElement, UiPressArgument } from 'claude-code'

import type { PullRequest, Repo } from '../types'
import { drawAppList, drawAppWaiting } from './draw-app'
import {
  CI_MARKS,
  COLUMN_GAP,
  drawRepos,
  drawTitle,
  type Kit,
  type ListHandlers,
  type ListView,
  type PaneSize,
  STATUS_COLORS,
  STATUS_WORDS,
} from './draw-parts'
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
  repoRowsFor,
} from './layout'

// The terminal's list. Every cell is one wide, so the rows line up in columns; the desktop apps draw theirs in draw-app.
const COPY_KEY = 'copy'
const TOP_KEY = 'top'
const BLANK = ' '
const HINT = '↑↓ move · Enter open · Esc close'
const HINT_REPOS = '↑↓ move · Tab repo · Enter open · Esc close'
const COPY_LABEL = 'copy link'
const COPY_HOTKEY = 'c'
const STATUS_WIDTH = 12
const AUTHOR_WIDTH = 12
const AGE_WIDTH = 4

interface RowOptions {
  now: number
  layout: Layout
  isSelected: boolean
}

const fitAuthor = (author: string): string => {
  if (author.length > AUTHOR_WIDTH) {
    return `${author.slice(0, AUTHOR_WIDTH - 1)}…`
  }
  return author.padEnd(AUTHOR_WIDTH)
}

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

// A row is plain text: the arrows move an underline, and Enter acts on it through the repo holding the ring, so nothing
// inverts a whole row.
const drawLead = (kit: Kit, pr: PullRequest, options: RowOptions): RenderElement => {
  const { Box, Text } = kit
  const mark = CI_MARKS[pr.ci]
  return (
    <Box flexGrow={1} flexShrink={1}>
      <Text wrap="truncate-end">
        <Text color={mark.color}>{`${mark.glyph}  `}</Text>
        {drawLabel(kit, pr, options)}
      </Text>
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

const drawFrame = (kit: Kit, bodyRows: number, content: RenderElement): RenderElement => {
  const { Box } = kit
  return (
    <Box flexDirection="column">
      {drawBlank(kit)}
      <Box key={TOP_KEY} flexDirection="column">
        {content}
      </Box>
      {drawFiller(kit, bodyRows)}
    </Box>
  )
}

const drawWaiting = (kit: Kit, size: PaneSize, text: string): RenderElement => {
  if (size.surface !== 'terminal') {
    return drawAppWaiting(kit, size, text)
  }
  const { Box, Text } = kit
  return drawFrame(
    kit,
    size.bodyRows,
    <Box flexDirection="column">
      {drawTitle(kit, size.bodyColumns)}
      <Text dimColor={true}>{text}</Text>
    </Box>,
  )
}

const drawTerminalList = (kit: Kit, size: PaneSize, view: ListView, handlers: ListHandlers): RenderElement => {
  const { Box, Text } = kit
  const { bodyColumns, bodyRows } = size
  const { repos, repo, at, now } = view
  const { hasBlanks, hasTitle } = chromeFor(bodyRows)
  const pageSize = pageSizeFor(bodyRows, repoRowsFor(repos, bodyColumns))
  const rows = pageOf(repo.prs, at, pageSize)
  const layout = layoutFor(rows, bodyColumns)
  const selectedNumber = repo.prs[at]?.number
  const blank = hasBlanks && drawBlank(kit)
  return drawFrame(
    kit,
    bodyRows,
    <Box flexDirection="column">
      {hasTitle && drawTitle(kit, bodyColumns)}
      {hasTitle && drawBlank(kit)}
      {drawRepos(kit, repos, repo, handlers.onPressRepo)}
      {blank}
      {rows.length > 0 && drawHeader(kit, layout)}
      <Box flexDirection="column">
        {repo.error !== undefined && <Text color="error">{repo.error}</Text>}
        {rows.map(pr => drawRow(kit, pr, { now, layout, isSelected: pr.number === selectedNumber }))}
      </Box>
      {blank}
      {drawHint(kit, repos, pageLabel(repo.prs.length, at, pageSize), handlers.onCopy)}
    </Box>,
  )
}

const drawList = (kit: Kit, size: PaneSize, view: ListView, handlers: ListHandlers): RenderElement => {
  if (size.surface !== 'terminal') {
    return drawAppList(kit, size, view, handlers)
  }
  return drawTerminalList(kit, size, view, handlers)
}

export { drawList, drawWaiting, TOP_KEY }
