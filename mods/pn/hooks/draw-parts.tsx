import type { ElementTable, RenderElement, RenderSurface, ThemeKey, UiPressArgument } from 'claude-code'

import type { CiState, PrStatus, PullRequest, Repo } from '../types'
import { REPO_GAP, repoLabel } from './layout'

const REPO_KEY = 'repo:'
const ROW_KEY = 'pr:'
const TITLE = 'Pull Requests'
const COLUMN_GAP = 2
const COLUMNS_FOR_LEGEND = 50

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

type Kit = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

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

const rowKey = (pr: PullRequest): string => `${ROW_KEY}${pr.number}`
const repoKey = (repo: Repo): string => `${REPO_KEY}${repo.slug}`

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

export type { Kit, ListHandlers, ListView, PaneSize }
export { CI_MARKS, COLUMN_GAP, drawRepos, drawTitle, REPO_KEY, ROW_KEY, repoKey, rowKey, STATUS_COLORS, STATUS_WORDS }
