import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

interface RawPr {
  number: number
  title: string
  url?: string
  isDraft?: boolean
  updatedAt?: string
  author?: { login: string }
  reviewDecision?: string | null
  mergeable?: string
  commits?: unknown
}

interface Folder {
  topLevel?: string
  remote?: string
}

interface Setup {
  projects?: Record<string, Folder>
  children?: Record<string, Folder>
  // By the path below the session's folder.
  nested?: Record<string, Folder>
  // find fails on a folder it cannot read, after printing the rest.
  findFails?: boolean
  rootRemote?: string
  prs?: Record<string, RawPr[] | { error: string }>
  isPlaced?: boolean
}

const ROOT = '/work/home'
const FIRST_PAGE = /1-7 of 20/u
const LEGEND = /running/u
const NO_CHECKS = /^· {2}#1/u

const rollup = (state: string): unknown => ({
  nodes: [{ commit: { statusCheckRollup: { state } } }],
})

const pr = (number: number, title = `PR ${number}`): RawPr => ({
  number,
  title,
  url: `https://github.com/me/x/pull/${number}`,
  updatedAt: '2026-11-01T00:00:00Z',
  author: { login: 'someone' },
})

const paneAt = (bodyRows = 30, isFocused = true, bodyColumns = 80) =>
  ({
    plugin: 'pn',
    component: 'Pane',
    requestId: 'pr',
    props: {
      title: 'Pull Requests',
      isFocused,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const open = ($: TestEngine) =>
  $.command.run({
    command: 'pn:pr',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 140 },
  })

const answer = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const foldersOf = (options: Setup): [string, Folder][] => [
  ...Object.entries(options.children ?? {}),
  ...Object.entries(options.projects ?? {}).map(([name, folder]): [string, Folder] => [`projects/${name}`, folder]),
  ...Object.entries(options.nested ?? {}),
]

const folderAt = (cwd: string | undefined, options: Setup) =>
  foldersOf(options).find(([path]) => cwd === `${ROOT}/${path}`)?.[1]

// Like find, it keeps to -maxdepth, and a folder inside the session's repo has no `.git` of its own.
const answerFind = (argv: string[], options: Setup) => {
  const maxDepth = Number(argv[argv.indexOf('-maxdepth') + 1])
  const found = foldersOf(options)
    .filter(([path, folder]) => folder.topLevel !== ROOT && path.split('/').length + 1 <= maxDepth)
    .map(([path]) => `./${path}/.git`)
  return answer(['./.git', ...found].join('\n'), options.findFails ? 1 : 0)
}

const answerRemote = (cwd: string | undefined, options: Setup) => {
  const remote = cwd === ROOT ? (options.rootRemote ?? 'git@github.com:me/home.git') : folderAt(cwd, options)?.remote
  return remote === undefined ? answer('', 2, 'no such remote') : answer(remote)
}

const fieldOf = (argv: string[], name: string): string =>
  argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''

const slugIn = (argv: string[]): string => `${fieldOf(argv, 'owner')}/${fieldOf(argv, 'name')}`

const answerGh = (argv: string[], options: Setup) => {
  const prs = options.prs?.[slugIn(argv)] ?? []
  if ('error' in prs) {
    return answer('', 1, prs.error === '' ? '' : `\n${prs.error}\nmore`)
  }
  return answer(JSON.stringify({ data: { repository: { pullRequests: { nodes: prs } } } }))
}

const answerFor = (argv: string[], cwd: string | undefined, options: Setup) => {
  if (argv[0] === 'find') {
    return answerFind(argv, options)
  }
  if (argv[1] === 'remote') {
    return answerRemote(cwd, options)
  }
  if (argv[0] === 'gh') {
    return answerGh(argv, options)
  }
  return answer('')
}

const setup = (on: On, options: Setup = {}) => {
  const argvs: string[][] = []
  const opens: unknown[] = []
  const closes: unknown[] = []
  const copies: unknown[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  const stored = new Map<string, unknown>()
  on('session.root', () => ({ value: ROOT }) as never)
  on('store.get', (_, e) => ({ value: stored.get(e.key) }) as never)
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.open', (_, e) => {
    opens.push(e)
    return {
      value: options.isPlaced === false ? { isPlaced: false, reason: 'no surface' } : { isPlaced: true },
    }
  })
  on('ui.close', (_, e) => {
    closes.push(e)
    return { value: undefined } as never
  })
  on('ui.copy', (_, e) => {
    copies.push(e)
    return { value: { isCopied: true } } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text))
    return { value: undefined } as never
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    argvs.push(argv)
    return answerFor(argv, e.init?.cwd, options)
  })
  return { argvs, opens, closes, copies, toasts, clock }
}

const BLOG = { remote: 'https://github.com/me/blog.git' }
const CLI = { remote: 'https://github.com/me/cli.git' }

const asked = (argvs: string[][]) => new Set(argvs.filter(argv => argv[0] === 'gh').map(slugIn))

const arrow = ($: TestEngine, by: number) =>
  $.ui.scroll({
    component: 'Pane',
    requestId: 'pr',
    offset: 1,
    by,
    bodyRows: 30,
    contentRows: 60,
    origin: { kind: 'person' },
  } as never)

const ringTo = ($: TestEngine, element?: string) =>
  $.ui.focus({
    component: 'Pane',
    requestId: 'pr',
    ...(element !== undefined && { plugin: 'pn', element }),
    origin: { kind: 'person' },
  })

const isUnderlined = (row: unknown): boolean => JSON.stringify(row).includes('"underline":true')

test('opening asks for a tall pane that takes the keys and closes on Esc', async ($, on) => {
  const { opens } = setup(on)
  const result = await open($)
  expect(result.text).toBeUndefined()
  expect(opens[0]).toMatchObject({ id: 'pr', focus: true, closeOnEscape: true, rows: 16 })
})

test('it looks at the session repo and the GitHub repos up to three levels under it, through symlinks', async ($, on) => {
  const { argvs, clock } = setup(on, {
    children: { service: { remote: 'https://github.com/org/service.git' }, docs: {} },
    projects: {
      cli: CLI,
      blog: BLOG,
      notes: {},
      inner: { topLevel: ROOT, remote: 'git@github.com:me/o.git' },
    },
    nested: {
      'work/api': { remote: 'https://github.com/org/api.git' },
      'work/old/app': { remote: 'https://github.com/org/app.git' },
      'work/old/legacy/tool': { remote: 'https://github.com/org/tool.git' },
    },
  })
  await open($)
  await clock.advance(0)
  expect(asked(argvs)).toEqual(new Set(['me/home', 'org/service', 'me/cli', 'me/blog', 'org/api', 'org/app']))
  expect(argvs).toContainEqual([
    'find',
    '-L',
    '.',
    '-mindepth',
    '1',
    '-maxdepth',
    '4',
    '-name',
    '.git',
    '-prune',
    '-print',
  ])
})

test('a folder find cannot read loses none of the repos it found', async ($, on) => {
  const { argvs, clock } = setup(on, { projects: { cli: CLI }, findFails: true })
  await open($)
  await clock.advance(0)
  expect(asked(argvs)).toEqual(new Set(['me/home', 'me/cli']))
})

test('a folder that is no repo still looks at the repos under it', async ($, on) => {
  const { argvs, clock } = setup(on, {
    rootRemote: 'git@gitlab.com:me/x.git',
    children: { service: { remote: 'https://github.com/org/service.git' } },
  })
  await open($)
  await clock.advance(0)
  expect(asked(argvs)).toEqual(new Set(['org/service']))
})

for (const remote of [
  'git@github.com:me/x.git',
  'https://github.com/me/x',
  'https://github.com/me/x.git/',
  'https://token@github.com/me/x.git',
  'ssh://git@github.com:22/me/x.git',
  'ssh://git@ssh.github.com:443/me/x.git',
  'git@github.com-work:me/x.git',
  'https://GitHub.com/me/x',
]) {
  test(`${remote} is me/x`, async ($, on) => {
    const { argvs, clock } = setup(on, { rootRemote: remote })
    await open($)
    await clock.advance(0)
    expect(asked(argvs)).toEqual(new Set(['me/x']))
  })
}

for (const remote of [
  'https://notgithub.com/me/x.git',
  'git@mygithub.com:me/x.git',
  'https://gitlab.example.com/github.com/me/x.git',
  'git@gitlab.com:me/x.git',
]) {
  test(`${remote} is no GitHub repo`, async ($, on) => {
    const { argvs, clock } = setup(on, { rootRemote: remote })
    await open($)
    await clock.advance(0)
    expect(asked(argvs).size).toBe(0)
  })
}

test('a repo with nothing open gets no place, and the pane opens on the first with something', async ($, on) => {
  const { clock } = setup(on, {
    projects: { cli: CLI, blog: BLOG },
    prs: { 'me/cli': [pr(157, 'Bump dependencies')] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Loading…' })).toBeDefined()
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: 'repo:me/cli' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'repo:me/blog' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Bump dependencies' })).toBeDefined()
  await ui.unmount()
})

test('nothing open says how many repos were looked at, and no repo says that', async ($, on) => {
  const { clock } = setup(on, { projects: { blog: BLOG } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'No open pull requests in 2 repos.' })).toBeDefined()
  await ui.unmount()
})

test('a folder holding no GitHub repo says so', async ($, on) => {
  const { clock } = setup(on, { rootRemote: 'git@gitlab.com:me/x.git' })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'No GitHub repos in this folder.' })).toBeDefined()
  await ui.unmount()
})

test('the arrows move the underline, and go round at the ends', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': [pr(1), pr(2), pr(3)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  const underlined = async (title: string) => isUnderlined(await ui.find({ type: 'Text', text: title }))
  expect(await underlined('PR 1')).toBe(true)
  expect(await underlined('PR 2')).toBe(false)

  await arrow($, 1)
  expect(await underlined('PR 2')).toBe(true)
  expect(await underlined('PR 1')).toBe(false)

  await arrow($, -1)
  await arrow($, -1)
  expect(await underlined('PR 3')).toBe(true)

  await arrow($, 1)
  expect(await underlined('PR 1')).toBe(true)

  await arrow($, 30)
  expect(await underlined('PR 3')).toBe(true)
  await ui.unmount()
})

test('rows are plain text on the terminal, so nothing inverts a whole row', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': [pr(1)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: 'pr:1' })).toBeUndefined()
  await ui.unmount()
})

test('Tab onto a repo shows its rows from the top', async ($, on) => {
  const { clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': [pr(1), pr(2)], 'me/blog': [pr(9, 'Draft post'), pr(8, 'Other')] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  await arrow($, 1)

  await ringTo($, 'repo:me/blog')
  expect(await ui.find({ type: 'Text', text: 'PR 1' })).toBeUndefined()
  expect(isUnderlined(await ui.find({ type: 'Text', text: 'Draft post' }))).toBe(true)
  await ui.unmount()
})

test('the ring stops neither on the copy button nor the close mark', async ($, on) => {
  const { clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': [pr(1)], 'me/blog': [pr(2)] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ringTo($, 'copy')).toEqual({})
  expect(await ringTo($)).toEqual({})
  await ui.unmount()
})

test('Enter on the repo holding the ring opens the underlined row, and leaves the pane open', async ($, on) => {
  const { argvs, closes, clock } = setup(on, { prs: { 'me/home': [pr(3), pr(4)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  await arrow($, 1)
  await ui.press({ key: 'repo:me/home' })
  expect(argvs).toContainEqual(['gh', 'pr', 'view', 'https://github.com/me/x/pull/4', '--web'])
  expect(closes).toHaveLength(0)
  await ui.unmount()
})

test('a click on another repo only chooses it', async ($, on) => {
  const { argvs, clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': [pr(1)], 'me/blog': [pr(2)] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  await ui.press({ key: 'repo:me/blog' })
  expect(await ui.find({ type: 'Text', text: 'PR 2' })).toBeDefined()
  expect(argvs.some(argv => argv.includes('--web'))).toBe(false)
  await ui.unmount()
})

test('the copy key copies the underlined row and says so', async ($, on) => {
  const { copies, toasts, clock } = setup(on, { prs: { 'me/home': [pr(3), pr(4)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  await arrow($, 1)
  await ui.press({ key: 'copy' })
  expect(copies[0]).toMatchObject({ text: 'https://github.com/me/x/pull/4', surface: 'terminal' })
  expect(toasts).toContain('Link copied: #4')
  await ui.unmount()
})

test('a url that is not GitHub is never offered', async ($, on) => {
  const { clock } = setup(on, {
    prs: { 'me/home': [{ number: 4, title: 'evil', url: 'file:///etc/passwd' }, pr(5)] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'evil' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'PR 5' })).toBeDefined()
  await ui.unmount()
})

test('a control character in a title cannot cost the pane', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': [pr(6, 'bad\u0007title')] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'bad title' })).toBeDefined()
  await ui.unmount()
})

test('a repo gh cannot read keeps its place and says why', async ($, on) => {
  const { clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': { error: 'gh: no access' }, 'me/blog': [pr(2)] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'gh: no access' })).toBeDefined()
  await ui.unmount()
})

test('gh failing with nothing on stderr still says something', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': { error: '' } } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'gh exited with 1' })).toBeDefined()
  await ui.unmount()
})

const manyPrs = Array.from({ length: 20 }, (_, index) => pr(index + 1))

test('more rows than fit come in pages, and the arrows turn them', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': manyPrs } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(14), surface: 'terminal' })
  await clock.advance(0)
  // 14 rows less the title and blank, the repos, two blanks, the column names and the hint.
  expect(await ui.find({ type: 'Text', text: 'PR 7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PR 8' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: FIRST_PAGE })).toBeDefined()

  await arrow($, 7)
  expect(await ui.find({ type: 'Text', text: 'PR 8' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PR 7' })).toBeUndefined()
  await ui.unmount()
})

test('a short pane gives its room to the rows: the title and blank lines go', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': manyPrs } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(6), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'Pull Requests' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'PR 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PR 4' })).toBeUndefined()
  await ui.unmount()
})

test('a tall pane says what the marks mean under a title', async ($, on) => {
  const { clock } = setup(on, { prs: { 'me/home': [pr(1)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'Pull Requests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: LEGEND })).toBeDefined()
  await ui.unmount()
})

for (const [state, glyph] of [
  ['SUCCESS', '✓'],
  ['FAILURE', '✗'],
  ['ERROR', '✗'],
  ['PENDING', '●'],
  ['EXPECTED', '●'],
] as const) {
  test(`a rollup of ${state} shows ${glyph}`, async ($, on) => {
    const { clock } = setup(on, {
      prs: { 'me/home': [{ ...pr(1), commits: rollup(state) }] },
    })
    await open($)
    const ui = await $.ui.mount({ ...paneAt(30, true, 40), surface: 'terminal' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${glyph}  #1`, 'u') })).toBeDefined()
    await ui.unmount()
  })
}

test('no rollup shows a dot', async ($, on) => {
  const { clock } = setup(on, {
    prs: {
      'me/home': [{ ...pr(1), commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }],
    },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(30, true, 40), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: NO_CHECKS })).toBeDefined()
  await ui.unmount()
})

for (const [fields, word] of [
  [{ isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' }, 'draft'],
  [{ mergeable: 'CONFLICTING', reviewDecision: 'APPROVED' }, 'conflict'],
  [{ reviewDecision: 'CHANGES_REQUESTED' }, 'changes'],
  [{ reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }, 'approved'],
  [{ reviewDecision: 'REVIEW_REQUIRED' }, 'needs review'],
] as const) {
  test(`${JSON.stringify(fields)} shows as ${word}`, async ($, on) => {
    const { clock } = setup(on, { prs: { 'me/home': [{ ...pr(1), ...fields }] } })
    await open($)
    const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
    await clock.advance(0)
    expect(await ui.find({ type: 'Text', text: word.padStart(12) })).toBeDefined()
    await ui.unmount()
  })
}

test('a long author is cut', async ($, on) => {
  const { clock } = setup(on, {
    prs: { 'me/home': [{ ...pr(1), author: { login: 'a-very-long-login-name' } }] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'a-very-long…' })).toBeDefined()
  await ui.unmount()
})

test('no status in a page drops the column, and a narrow pane drops the author, then the status', async ($, on) => {
  const { clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': [pr(1)], 'me/blog': [{ ...pr(2), reviewDecision: 'APPROVED' }] },
  })
  await open($)
  await clock.advance(0)
  const word = 'approved'.padStart(12)

  const wide = await $.ui.mount({ ...paneAt(30, true, 80), surface: 'terminal' })
  expect(await wide.find({ type: 'Text', text: 'someone     ' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: word })).toBeUndefined()
  await wide.press({ key: 'repo:me/blog' })
  expect(await wide.find({ type: 'Text', text: word })).toBeDefined()
  await wide.unmount()

  const medium = await $.ui.mount({ ...paneAt(30, true, 55), surface: 'terminal' })
  expect(await medium.find({ type: 'Text', text: word })).toBeDefined()
  expect(await medium.find({ type: 'Text', text: 'someone     ' })).toBeUndefined()
  await medium.unmount()

  const narrow = await $.ui.mount({ ...paneAt(30, true, 40), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: word })).toBeUndefined()
  await narrow.unmount()
})

test('repos that do not fit one row wrap, and the rows give up the room they take', async ($, on) => {
  const names = ['weather-proxy', 'recipe-scraper', 'photo-gallery', 'invoice-generator-tools', 'markdown-previewer']
  const children = Object.fromEntries(names.map(name => [name, { remote: `git@github.com:org/${name}.git` }]))
  const prs = Object.fromEntries(names.map(name => [`org/${name}`, manyPrs]))
  const { clock } = setup(on, { rootRemote: 'git@gitlab.com:me/x.git', children, prs })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(14, true, 40), surface: 'terminal' })
  await clock.advance(0)
  // 14 rows less the title and blank, four rows of repos at this width, two blanks, the column names and the hint.
  expect(await ui.find({ type: 'Text', text: 'PR 4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PR 5' })).toBeUndefined()
  await ui.unmount()
})

test('a pane still waiting for a surface loads anyway, and says why it is not showing', async ($, on) => {
  const { clock } = setup(on, { isPlaced: false, prs: { 'me/home': [pr(1)] } })
  const result = await open($)
  expect(result.text).toContain('no surface')
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: 'PR 1' })).toBeDefined()
  await ui.unmount()
})

test('the pane closes once the keys leave, not before it has held them', async ($, on) => {
  const { closes, clock } = setup(on, { prs: { 'me/home': [pr(1)] } })
  await open($)
  const before = await $.ui.mount({ ...paneAt(30, false), surface: 'terminal' })
  await clock.advance(0)
  expect(closes).toHaveLength(0)
  await before.unmount()

  const holding = await $.ui.mount({ ...paneAt(30, true), surface: 'terminal' })
  await holding.unmount()
  const after = await $.ui.mount({ ...paneAt(30, false), surface: 'terminal' })
  await clock.advance(0)
  expect(closes).toHaveLength(1)
  await after.unmount()
})

test('the desktop app draws every row as a button, with no filler and no copy key', async ($, on) => {
  const { argvs, clock } = setup(on, { prs: { 'me/home': manyPrs } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(10), surface: 'desktop' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: 'pr:20' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'copy' })).toBeUndefined()
  await ui.press({ key: 'pr:20' })
  expect(argvs).toContainEqual(['gh', 'pr', 'view', 'https://github.com/me/x/pull/20', '--web'])
  await ui.unmount()
})

test('a prompt the person sends closes the pane, /pn:pr does not', async ($, on) => {
  const { closes } = setup(on)
  await open($)
  await $.prompt.submit({
    text: '/pn:pr',
    origin: { kind: 'composer' },
    command: { name: 'pn:pr', args: '' },
  } as never)
  expect(closes).toHaveLength(0)
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  expect(closes).toHaveLength(1)
})

test('the columns are named above the rows, and drop with them', async ($, on) => {
  const { clock } = setup(on, {
    prs: { 'me/home': [{ ...pr(1), reviewDecision: 'APPROVED' }] },
  })
  await open($)
  await clock.advance(0)
  const wide = await $.ui.mount({ ...paneAt(30, true, 80), surface: 'terminal' })
  expect(await wide.find({ type: 'Text', text: 'CI No. Title' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'Status'.padStart(12) })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'Author'.padEnd(12) })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: 'Age'.padStart(4) })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ ...paneAt(30, true, 40), surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: 'Status'.padStart(12) })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'Author'.padEnd(12) })).toBeUndefined()
  await narrow.unmount()
})

test('no repo has a hotkey: Tab moves between them', async ($, on) => {
  const { clock } = setup(on, {
    projects: { blog: BLOG },
    prs: { 'me/home': [pr(1)], 'me/blog': [pr(2)] },
  })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props?.hotkey)
  expect(hotkeys).toEqual([undefined, undefined, 'c'])
  await ui.unmount()
})

test('the first open asks for a default height, and the next for what its list needed', async ($, on) => {
  const { opens, clock } = setup(on, { prs: { 'me/home': [pr(1), pr(2)] } })
  await open($)
  const ui = await $.ui.mount({ ...paneAt(), surface: 'terminal' })
  await clock.advance(0)
  expect(opens.at(0)).toMatchObject({ rows: 16 })
  await open($)
  expect(opens.at(-1)).toMatchObject({ rows: 9 })
  await ui.unmount()
})
