import type { EngineInterface } from 'claude-code'

import type { CiState, PrStatus, PullRequest, Repo } from '../types'

// Asks for the commit's rollup state, not every check: `gh pr list --json statusCheckRollup` fetches them all, and takes
// about a third longer across several repos.
const QUERY =
  // biome-ignore lint/security/noSecrets: a GraphQL query, not a secret.
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url isDraft updatedAt author{login} reviewDecision mergeable commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'
const PR_URL_PREFIX = 'https://github.com/'
// The `.git` (a folder, or a worktree's file) of the session's folder and of each folder up to three levels below it.
// Each level deeper takes three to four times as long, for few more repos. `-L` follows symlinks, so a repo linked in
// from elsewhere counts. find stays out of each `.git`, of hidden folders and of `node_modules`: tools keep caches and
// checkouts there, and from a home folder they made the search take seconds instead of a tenth of one.
const FIND_REPOS = [
  'find',
  '-L',
  '.',
  '-mindepth',
  '1',
  '-maxdepth',
  '4',
  '(',
  '-name',
  '.git',
  '-print',
  '-o',
  '-name',
  '.?*',
  '-o',
  '-name',
  'node_modules',
  ')',
  '-prune',
]
// A search still running then is given up, and the pane says so instead of that nothing is open.
const FIND_TIMEOUT_MS = 15_000
// At most this many git or gh at once: a home folder can hold a hundred repos or more.
const MAX_RUNNING = 8
const ROOT_GIT = './.git'
const GIT_SUFFIX = '/.git'
const REMOTE = ['git', 'remote', 'get-url', 'origin']
// The host is matched whole, so a look-alike or a path holding its name is no GitHub repo. `github.com-work` is the
// usual ssh alias for a second account, and `ssh.github.com` the host behind port 443.
const GITHUB_REMOTE =
  /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:ssh\.)?github\.com(?:-[^:/]+)?(?::\d+)?[:/](?<slug>[^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/iu
// A control character in any text costs the whole pane: the engine refuses the tree it is in.
const CONTROL = /\p{Cc}/gu
const UNREADABLE = 'gh printed output this mod cannot read.'

const CI_STATES = new Map<unknown, CiState>([
  ['SUCCESS', 'pass'],
  ['FAILURE', 'fail'],
  ['ERROR', 'fail'],
  ['PENDING', 'pending'],
  ['EXPECTED', 'pending'],
])

const MINUTE_MS = 60_000
const HOUR_MINUTES = 60
const DAY_MINUTES = 1440
const MONTH_MINUTES = 43_200

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isText = (value: string | undefined): value is string => value !== undefined

const clean = (text: string): string => text.replaceAll(CONTROL, ' ').trim()

const firstLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map(clean)
    .find(line => line !== '')

async function runText($: EngineInterface, argv: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { cwd })
    if (exitCode !== 0) {
      return undefined
    }
    return stdout.trim()
  } catch {
    return undefined
  }
}

async function slugOf($: EngineInterface, dir: string): Promise<string | undefined> {
  const remote = await runText($, REMOTE, dir)
  return remote?.match(GITHUB_REMOTE)?.groups?.slug
}

// Runs `run` on every item, at most MAX_RUNNING at a time, and keeps the results in the items' order.
const mapLimited = async <T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> => {
  const entries = items.entries()
  const results: R[] = []
  const work = async (): Promise<void> => {
    for (const [index, item] of entries) {
      // biome-ignore lint/performance/noAwaitInLoops: each worker takes one item at a time; the workers run side by side.
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_RUNNING, items.length) }, work))
  return results
}

// find prints what it found even when a folder it could not read makes it fail. Undefined when it did not finish.
async function findRepos($: EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await $.process.run(FIND_REPOS, { cwd, timeoutMs: FIND_TIMEOUT_MS })
    return stdout
  } catch {
    return undefined
  }
}

async function discoverSlugs($: EngineInterface): Promise<{ slugs: string[]; isCut: boolean }> {
  const root = await $.session.root()
  const found = await findRepos($, root)
  const dirs = (found ?? '')
    .split('\n')
    .filter(line => line !== ROOT_GIT && line.startsWith('./') && line.endsWith(GIT_SUFFIX))
    .map(line => `${root}/${line.slice('./'.length, -GIT_SUFFIX.length)}`)
  const slugs = await mapLimited([root, ...dirs], dir => slugOf($, dir))
  return { slugs: [...new Set(slugs.filter(isText))], isCut: found === undefined }
}

const timeOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const time = Date.parse(value)
  if (Number.isNaN(time)) {
    return undefined
  }
  return time
}

const pick = (value: unknown, path: readonly (string | number)[]): unknown => {
  let current = value
  for (const step of path) {
    if (Array.isArray(current) && typeof step === 'number') {
      current = current[step]
    } else if (isRecord(current) && typeof step === 'string') {
      current = current[step]
    } else {
      return undefined
    }
  }
  return current
}

const ciOf = (value: unknown): CiState =>
  CI_STATES.get(pick(value, ['commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'state'])) ?? 'none'

// What stands in the way first: a draft isn't asking for anything yet, and a conflict blocks whatever reviewers said.
const statusOf = (value: Record<string, unknown>): PrStatus => {
  if (value.isDraft === true) {
    return 'draft'
  }
  if (value.mergeable === 'CONFLICTING') {
    return 'conflict'
  }
  if (value.reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes'
  }
  if (value.reviewDecision === 'APPROVED') {
    return 'approved'
  }
  if (value.reviewDecision === 'REVIEW_REQUIRED') {
    return 'review'
  }
  return 'none'
}

const authorOf = (value: unknown): string => {
  const login = pick(value, ['author', 'login'])
  if (typeof login === 'string') {
    return clean(login)
  }
  return ''
}

const toPullRequest = (value: unknown): PullRequest[] => {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    !value.url.startsWith(PR_URL_PREFIX)
  ) {
    return []
  }
  const updatedAt = timeOf(value.updatedAt)
  return [
    {
      number: value.number,
      title: clean(value.title),
      url: value.url,
      author: authorOf(value),
      ci: ciOf(value),
      status: statusOf(value),
      ...(updatedAt !== undefined && { updatedAt }),
    },
  ]
}

const parsePullRequests = (text: string): PullRequest[] | undefined => {
  try {
    const parsed = pick(JSON.parse(text), ['data', 'repository', 'pullRequests', 'nodes'])
    if (Array.isArray(parsed)) {
      return parsed.flatMap(toPullRequest)
    }
    return undefined
  } catch {
    return undefined
  }
}

async function fetchRepo($: EngineInterface, slug: string): Promise<Repo> {
  const name = slug.split('/').at(-1) ?? slug
  try {
    const [owner = '', repoName = ''] = slug.split('/')
    const { exitCode, stdout, stderr } = await $.process.run([
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repoName}`,
    ])
    if (exitCode !== 0) {
      return { slug, name, prs: [], error: firstLine(stderr) ?? `gh exited with ${exitCode}` }
    }
    const prs = parsePullRequests(stdout)
    if (prs === undefined) {
      return { slug, name, prs: [], error: UNREADABLE }
    }
    return { slug, name, prs }
  } catch (error) {
    return { slug, name, prs: [], error: clean(String(error)) }
  }
}

// A repo with nothing open has nothing to show, so only the rest get a place in the pane. The count says what was
// looked at, so a folder with no repos isn't mistaken for repos with nothing open.
async function loadRepos($: EngineInterface): Promise<{ repos: Repo[]; scanned: number; isCut: boolean }> {
  const { slugs, isCut } = await discoverSlugs($)
  const repos = await mapLimited(slugs, slug => fetchRepo($, slug))
  return {
    repos: repos.filter(repo => repo.prs.length > 0 || repo.error !== undefined),
    scanned: slugs.length,
    isCut,
  }
}

const formatAge = (updatedAt: number | undefined, now: number): string => {
  if (updatedAt === undefined) {
    return ''
  }
  const minutes = Math.max(0, Math.floor((now - updatedAt) / MINUTE_MS))
  if (minutes < HOUR_MINUTES) {
    return `${minutes}m`
  }
  if (minutes < DAY_MINUTES) {
    return `${Math.floor(minutes / HOUR_MINUTES)}h`
  }
  if (minutes < MONTH_MINUTES) {
    return `${Math.floor(minutes / DAY_MINUTES)}d`
  }
  return `${Math.floor(minutes / MONTH_MINUTES)}mo`
}

export { formatAge, loadRepos }
