import type { RenderElement } from 'claude-code'

import type { PullRequest } from '../types'
import {
  CI_MARKS,
  drawRepos,
  drawTitle,
  type Kit,
  type ListHandlers,
  type ListView,
  type PaneSize,
  rowKey,
  STATUS_COLORS,
  STATUS_WORDS,
} from './draw-parts'
import { formatAge } from './github'

// Grey with alpha, so a row lights the same on a light and a dark theme.
const HOVER_BACKGROUND = '#80808026'
const SEPARATOR = ' · '

const drawStatus = ({ Text }: Kit, pr: PullRequest): RenderElement[] => {
  const word = STATUS_WORDS[pr.status]
  if (word === '') {
    return []
  }
  return [<Text dimColor={true}>{SEPARATOR}</Text>, <Text color={STATUS_COLORS[pr.status]}>{word}</Text>]
}

const drawMeta = (kit: Kit, pr: PullRequest, now: number): RenderElement => {
  const { Text } = kit
  const mark = CI_MARKS[pr.ci]
  const facts = [`#${pr.number}`, pr.author, formatAge(pr.updatedAt, now)].filter(fact => fact !== '')
  return (
    <Text size="caption">
      <Text color={mark.color}>{`${mark.glyph} `}</Text>
      <Text dimColor={true}>{facts.join(SEPARATOR)}</Text>
      {drawStatus(kit, pr)}
    </Text>
  )
}

// Letters differ in width here, so nothing can line up in columns: each pull request is a title over a line of facts.
const drawRow = (kit: Kit, pr: PullRequest, now: number, onOpen: () => void): RenderElement => {
  const { Box, Button, Text } = kit
  return (
    <Box
      key={`row:${pr.number}`}
      flexDirection="column"
      paddingX="xs"
      paddingY="xs"
      hover={{ backgroundColor: HOVER_BACKGROUND }}
    >
      <Button key={rowKey(pr)} plain={true} onPress={onOpen}>
        <Text wrap="truncate-end" dimColor={pr.status === 'draft'}>
          {pr.title}
        </Text>
      </Button>
      {drawMeta(kit, pr, now)}
    </Box>
  )
}

const drawAppWaiting = (kit: Kit, { bodyColumns }: PaneSize, text: string): RenderElement => {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column" rowGap="sm">
      {drawTitle(kit, bodyColumns)}
      <Text dimColor={true}>{text}</Text>
    </Box>
  )
}

const drawAppList = (
  kit: Kit,
  { bodyColumns }: PaneSize,
  { repos, repo, now }: ListView,
  handlers: ListHandlers,
): RenderElement => {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column" rowGap="sm">
      {drawTitle(kit, bodyColumns)}
      {drawRepos(kit, repos, repo, handlers.onPressRepo)}
      <Box flexDirection="column">
        {repo.error !== undefined && <Text color="error">{repo.error}</Text>}
        {repo.prs.map(pr => drawRow(kit, pr, now, (): void => handlers.onOpen(pr)))}
      </Box>
    </Box>
  )
}

export { drawAppList, drawAppWaiting }
