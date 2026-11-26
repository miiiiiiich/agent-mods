import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
type ForkReply = { isAnswered: true; text: string } | { isAnswered: false; reason: string } | 'deny'

interface EngineSetup {
  turns?: number
  // Why the engine drops every prompt, as a settings hook's block does.
  drop?: string
  // One reply for every fork, or one per fork in turn, the last one repeated.
  fork?: ForkReply | ForkReply[]
  // Each fork waits for releaseFork().
  holdsForks?: boolean
  // How many /rename runs fail first.
  failsRenames?: number
}

interface TurnEnd {
  reason?: 'answer' | 'aborted' | 'error'
  agentId?: string
}

declare const setTimeout: (run: (value: unknown) => void, ms: number) => unknown

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const engine = ($: TestEngine, on: On, setup: EngineSetup = {}) => {
  const { turns = 0, drop } = setup
  let renamesToFail = setup.failsRenames ?? 0
  const replies = [setup.fork ?? { isAnswered: true, text: '売上集計の修正' }].flat()
  // Each timer of the mod waits here until step() lets the oldest one run, as an engine queue would.
  const timers: (() => void)[] = []
  const heldForks: (() => void)[] = []
  const runs: string[] = []
  const models: unknown[] = []
  const registered: unknown[] = []
  const forks: string[] = []

  on('command.register', (_$, e) => {
    registered.push(e)
    return { value: { command: e.name } } as never
  })
  on('clock.after', () => new Promise(resolve => timers.push(() => resolve({ value: undefined } as never))))
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)
    const reply = replies[Math.min(forks.length, replies.length) - 1]
    if (setup.holdsForks) {
      await new Promise<void>(resolve => heldForks.push(resolve))
    }
    if (reply === 'deny') {
      return { deny: 'refused' } as never
    }
    return { value: { usage: NO_USAGE, ...reply } } as never
  })
  on('model.complete', (_$, e) => {
    models.push(e)
    return { value: { isAnswered: false, reason: 'empty-reply', usage: NO_USAGE } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.turns', () => ({ value: turns }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => (drop ? { drop } : { text: e.text }))
  on('command.run', (_$, e) => {
    runs.push(`/${e.command} ${e.args}`.trim())
    // A hook that throws is skipped, and with none beneath it the run rejects.
    if (e.command === 'rename' && renamesToFail > 0) {
      renamesToFail -= 1
      throw new Error('rename failed')
    }
    return { text: '' }
  })

  const fromPerson = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)

  const endTurn = ({ reason = 'answer', agentId }: TurnEnd = {}) =>
    $.turn.complete({
      answer: '',
      durationMs: 0,
      isAborted: reason === 'aborted',
      turnId: 'turn',
      reason,
      ...(agentId ? { agentId } : {}),
    } as never)

  const step = async () => {
    timers.shift()?.()
    await settle()
  }
  const flush = async (): Promise<void> => {
    if (timers.length > 0) {
      await step()
      return flush()
    }
  }
  const turnEnds = async (end: TurnEnd = {}) => {
    await endTurn(end)
    await flush()
  }
  const releaseFork = async () => {
    heldForks.shift()?.()
    await settle()
  }

  const renameAs = (origin: unknown, args: string) =>
    $.command.run({ command: 'rename', args, origin, presentation: { isFullscreen: true, columns: 140 } } as never)

  const renames = () => runs.filter(run => run.startsWith('/rename'))

  return { runs, models, registered, forks, fromPerson, endTurn, turnEnds, step, flush, releaseFork, renameAs, renames }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

const nametag = ($: TestEngine) =>
  $.command.run({
    command: 'nametag',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 140 },
  })

const start = ($: TestEngine) => $.session.start(START)
const endSession = ($: TestEngine, reason: 'clear' | 'resume') =>
  $.session.end({ reason, sessionId: 'session', resume: { id: 'session' } } as never)

test('a new interactive session runs bare /color', async ($, on) => {
  const { runs } = engine($, on)

  await $.session.start(START)
  await settle()

  expect(runs).toEqual(['/color'])
})

test('a session with turns keeps its color', async ($, on) => {
  const { runs } = engine($, on, { turns: 3 })

  await $.session.start(START)
  await settle()

  expect(runs).toEqual([])
})

test('a headless session is not colored', async ($, on) => {
  const { runs } = engine($, on)

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await settle()

  expect(runs).toEqual([])
})

test('/clear rolls the color again, from a timer', async ($, on) => {
  const { runs, flush } = engine($, on, { turns: 3 })

  await endSession($, 'clear')
  expect(runs).toEqual([])

  await flush()
  expect(runs).toEqual(['/color'])
})

test('/resume leaves the color alone', async ($, on) => {
  const { runs, flush } = engine($, on, { turns: 3 })

  await endSession($, 'resume')
  await flush()

  expect(runs).toEqual([])
})

test('sending a prompt names nothing yet', async ($, on) => {
  const { forks, models, renames, fromPerson, flush } = engine($, on)
  await start($)

  await fromPerson('https://www.notion.so/page')
  await flush()

  expect(forks).toEqual([])
  expect(models).toEqual([])
  expect(renames()).toEqual([])
})

test('the end of the first answered turn names the session from the conversation', async ($, on) => {
  const { forks, models, renames, fromPerson, turnEnds } = engine($, on)
  await start($)

  await fromPerson('https://www.notion.so/page')
  await turnEnds()

  expect(forks).toHaveLength(1)
  expect(models).toEqual([])
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test('the name goes to /rename from a timer, after the turn has ended', async ($, on) => {
  const { forks, renames, fromPerson, flush, endTurn } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  expect(forks).toEqual([])

  await flush()
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test('a session is named once, not at every turn', async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()
  await fromPerson('続けて')
  await turnEnds()

  expect(forks).toHaveLength(1)
})

test('a resumed session, or one this mod is reloaded into past its first prompt, is never named', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on, { turns: 3 })

  await start($)
  await fromPerson('別の話')
  await turnEnds()

  expect(forks).toEqual([])
  expect(renames()).toEqual([])
})

test('a session resumed in place of a fresh one is never named', async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on)

  await start($)
  await endSession($, 'resume')
  await fromPerson('別の話')
  await turnEnds()

  expect(forks).toEqual([])
})

test('an interrupted turn leaves the naming to the next answered one', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds({ reason: 'aborted' })
  await turnEnds({ reason: 'error' })
  expect(forks).toEqual([])

  await turnEnds()
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test("a subagent's turn does not name the session", async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds({ agentId: 'agent-1' })
  expect(forks).toEqual([])

  await turnEnds()
  expect(forks).toHaveLength(1)
})

for (const [label, origin] of [
  ['the person', { kind: 'composer' }],
  ['another plugin', { kind: 'plugin', name: 'other' }],
] as const) {
  test(`a name ${label} gives during the turn stands`, async ($, on) => {
    const { forks, fromPerson, turnEnds, renameAs } = engine($, on)
    await start($)

    await fromPerson('売上集計を直して')
    await renameAs(origin, '別の名前')
    await turnEnds()

    expect(forks).toEqual([])
  })

  test(`a name ${label} gives while this mod's /rename waits is given back after it`, async ($, on) => {
    const { renames, fromPerson, step, flush, renameAs, endTurn } = engine($, on)
    await start($)

    await fromPerson('売上集計を直して')
    await endTurn()
    await step()
    await renameAs(origin, '別の名前')
    await flush()

    expect(renames()).toEqual(['/rename 別の名前', '/rename 売上集計の修正', '/rename 別の名前'])
  })
}

for (const [label, origin] of [
  ['the person', { kind: 'composer' }],
  ['another plugin', { kind: 'plugin', name: 'other' }],
] as const) {
  test(`a name ${label} gives while the turn's end asks stands`, async ($, on) => {
    const { renames, fromPerson, endTurn, step, flush, releaseFork, renameAs } = engine($, on, { holdsForks: true })
    await start($)

    await fromPerson('売上集計を直して')
    await endTurn()
    await step()
    await renameAs(origin, '別の名前')
    await releaseFork()
    await flush()

    expect(renames()).toEqual(['/rename 別の名前'])
  })
}

test("a prompt sent while the turn's end asks does not ask again", async ($, on) => {
  const { forks, fromPerson, endTurn, turnEnds, step, flush, releaseFork } = engine($, on, { holdsForks: true })
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await fromPerson('続けて')
  await turnEnds()
  await releaseFork()
  await flush()

  expect(forks).toHaveLength(1)
})

test("/clear while the turn's end asks drops the name from before it", async ($, on) => {
  const { forks, renames, fromPerson, endTurn, step, flush, releaseFork } = engine($, on, { holdsForks: true })
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await endSession($, 'clear')
  await releaseFork()
  await flush()
  expect(renames()).toEqual([])

  await fromPerson('別の話')
  await endTurn()
  await step()
  expect(forks).toHaveLength(2)
})

test('a refused fork lets the next prompt ask again', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on, {
    fork: ['deny', { isAnswered: true, text: '売上集計の修正' }],
  })
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()
  await fromPerson('続けて')
  await turnEnds()

  expect(forks).toHaveLength(2)
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test("a prompt sent while the turn's end asks is asked about if no name comes", async ($, on) => {
  const { forks, fromPerson, endTurn, step, releaseFork } = engine($, on, {
    holdsForks: true,
    fork: { isAnswered: true, text: 'SKIP' },
  })
  await start($)

  await fromPerson('こんにちは')
  await endTurn()
  await step()
  await fromPerson('売上集計を直して')
  await releaseFork()
  await endTurn()
  await step()

  expect(forks).toHaveLength(2)
})

test("a failed name at the turn's end lets the next prompt ask again", async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on, {
    fork: [
      { isAnswered: false, reason: 'api-error' },
      { isAnswered: true, text: '売上集計の修正' },
    ],
  })
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()
  await fromPerson('続けて')
  await turnEnds()

  expect(forks).toHaveLength(2)
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test("a prompt sent while this mod's name waits does not ask for a name again", async ($, on) => {
  const { forks, renames, fromPerson, turnEnds, step, flush, endTurn } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await fromPerson('続けて')
  await turnEnds()
  await flush()

  expect(forks).toHaveLength(1)
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

for (const text of [
  '**SKIP。**',
  'SKIP\n\n挨拶のみのため。',
  '作業内容が読み取れません。',
  'I cannot tell what the work is.',
]) {
  test(`the reply ${JSON.stringify(text)} leaves the session unnamed, and the next turn asks again`, async ($, on) => {
    const { forks, renames, fromPerson, turnEnds } = engine($, on, { fork: { isAnswered: true, text } })
    await start($)

    await fromPerson('こんにちは')
    await turnEnds()
    expect(renames()).toEqual([])

    await fromPerson('売上集計を直して')
    await turnEnds()
    expect(forks).toHaveLength(2)
  })
}

test('a reply with reasoning before the name uses the last line', async ($, on) => {
  const { renames, fromPerson, turnEnds } = engine($, on, {
    fork: { isAnswered: true, text: '作業依頼なので名前を付ける。\n\nタスク改善' },
  })
  await start($)

  await fromPerson('タスクを改善したい')
  await turnEnds()

  expect(renames()).toEqual(['/rename タスク改善'])
})

test('a failed /rename lets the next prompt ask again', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on, { failsRenames: 1 })
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()
  await fromPerson('続けて')
  await turnEnds()

  expect(forks).toHaveLength(2)
  expect(renames()).toEqual(['/rename 売上集計の修正', '/rename 売上集計の修正'])
})

test('a failed /rename from /nametag leaves a named session named', async ($, on) => {
  const { forks, fromPerson, turnEnds, flush } = engine($, on, { turns: 3, failsRenames: 1 })
  await start($)

  await nametag($)
  await flush()
  await fromPerson('続けて')
  await turnEnds()

  expect(forks).toHaveLength(1)
})

test("a name by hand while this mod's /rename waits is not given back across a resume", async ($, on) => {
  const { renames, fromPerson, endTurn, step, flush, renameAs } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await renameAs({ kind: 'composer' }, '手で付けた名前')
  await endSession($, 'resume')
  await flush()

  expect(renames()).toEqual(['/rename 手で付けた名前', '/rename 売上集計の修正'])
})

test('a failed fork leaves the session unnamed', async ($, on) => {
  const { renames, fromPerson, turnEnds } = engine($, on, { fork: { isAnswered: false, reason: 'api-error' } })
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()

  expect(renames()).toEqual([])
})

test('a prompt that is not from a person does not name the session', async ($, on) => {
  const { forks, turnEnds } = engine($, on)
  await start($)

  await $.prompt.submit({ text: 'tick', origin: { kind: 'scheduled-trigger' } } as never)
  await turnEnds()

  expect(forks).toEqual([])
})

test('a prompt dropped on the way, by a settings hook among others, names nothing', async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on, { drop: 'secret' })

  await start($)
  await fromPerson('secret text')
  await turnEnds()

  expect(forks).toEqual([])
})

test('after /clear an automatic name is replaced once', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await turnEnds()
  await endSession($, 'clear')

  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toHaveLength(2)
  expect(renames()).toHaveLength(2)

  await fromPerson('さらに別の話')
  await turnEnds()
  expect(forks).toHaveLength(2)
})

test('after /clear a title this mod did not give, by hand or from before a reload, is replaced', async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on)

  await endSession($, 'clear')
  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toHaveLength(1)
})

test('after /clear a greeting with nothing to name leaves the old title to the next prompt', async ($, on) => {
  const { forks, renames, fromPerson, turnEnds } = engine($, on, {
    fork: [
      { isAnswered: true, text: 'SKIP' },
      { isAnswered: true, text: '別の話の名前' },
    ],
  })

  await endSession($, 'clear')
  await fromPerson('こんにちは')
  await turnEnds()
  expect(renames()).toEqual([])

  await fromPerson('別の話をしたい')
  await turnEnds()
  expect(forks).toHaveLength(2)
  expect(renames()).toEqual(['/rename 別の話の名前'])
})

test('a name written by hand after /clear stays', async ($, on) => {
  const { forks, renameAs, fromPerson, turnEnds } = engine($, on)

  await endSession($, 'clear')
  await renameAs({ kind: 'composer' }, '手で付けた名前')
  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toEqual([])
})

test("this mod's name that lands after /clear is replaced after the next turn", async ($, on) => {
  const { forks, renames, fromPerson, endTurn, step, flush, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await endSession($, 'clear')
  await flush()
  expect(renames()).toEqual(['/rename 売上集計の修正'])

  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toHaveLength(2)
  expect(renames()).toHaveLength(2)
})

test("this mod's name that lands after the first prompt past /clear is replaced a turn later", async ($, on) => {
  const { renames, fromPerson, endTurn, step, flush, turnEnds } = engine($, on, {
    fork: [
      { isAnswered: true, text: '先の名前' },
      { isAnswered: true, text: '後の名前' },
    ],
  })
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await endSession($, 'clear')
  await fromPerson('別の話')
  await flush()
  await turnEnds()
  expect(renames()).toEqual(['/rename 先の名前'])

  await fromPerson('別の話の続き')
  await turnEnds()
  expect(renames()).toEqual(['/rename 先の名前', '/rename 後の名前'])
})

test('a name given by hand after /clear stays, even the old one', async ($, on) => {
  const { forks, renameAs, fromPerson, turnEnds } = engine($, on)

  await endSession($, 'clear')
  await renameAs({ kind: 'composer' }, '前の名前')
  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toEqual([])
})

test('a hand-written name this mod gives back after /clear is replaced', async ($, on) => {
  const { forks, renames, renameAs, fromPerson, endTurn, step, flush, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await renameAs({ kind: 'composer' }, '手で付けた名前')
  await endSession($, 'clear')
  await flush()
  expect(renames().at(-1)).toBe('/rename 手で付けた名前')

  await fromPerson('別の話')
  await turnEnds()
  expect(forks).toHaveLength(2)
})

test('/clear drops the mark a prompt left before it', async ($, on) => {
  const { forks, fromPerson, endTurn, turnEnds } = engine($, on)
  await start($)

  await fromPerson('売上集計を直して')
  await endTurn({ reason: 'aborted' })
  await endSession($, 'clear')
  await turnEnds()
  expect(forks).toEqual([])
})

test('/nametag is registered in every session, and runs mid-turn', async ($, on) => {
  const { registered } = engine($, on)
  await $.session.start({ ...START, isInteractive: false } as never)
  expect(registered[0]).toMatchObject({ name: 'nametag', immediate: true })
})

test('/nametag asks over the conversation and hands the name to /rename from a timer', async ($, on) => {
  const { forks, renames, flush } = engine($, on)
  const result = await nametag($)
  expect(result.text).toBeUndefined()
  expect(forks).toHaveLength(1)
  expect(renames()).toEqual([])
  await flush()
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test('/nametag during the first turn finds nothing yet, and the turn end names the session', async ($, on) => {
  const { renames, fromPerson, turnEnds } = engine($, on, {
    fork: [
      { isAnswered: false, reason: 'nothing-to-fork' },
      { isAnswered: true, text: '売上集計の修正' },
    ],
  })
  await start($)
  await fromPerson('売上集計を直して')
  expect((await nametag($)).text).toBe('nametag: nothing to name yet.')
  await turnEnds()
  expect(renames()).toEqual(['/rename 売上集計の修正'])
})

test('a name the person gives while /nametag asks stands', async ($, on) => {
  const { renames, renameAs, releaseFork, flush } = engine($, on, { holdsForks: true })
  const asked = nametag($)
  await settle()
  await renameAs({ kind: 'composer' }, '手書きの名前')
  await releaseFork()
  await asked
  await flush()
  expect(renames()).toEqual(['/rename 手書きの名前'])
})

test('/clear while /nametag asks drops the name from before it', async ($, on) => {
  const { renames, releaseFork, flush } = engine($, on, { holdsForks: true })
  const asked = nametag($)
  await settle()
  await endSession($, 'clear')
  await releaseFork()
  await asked
  await flush()
  expect(renames()).toEqual([])
})

test('/nametag while an unnamed turn runs leaves its end nothing to do', async ($, on) => {
  const { forks, fromPerson, turnEnds } = engine($, on)
  await start($)
  await fromPerson('売上集計を直して')
  await nametag($)
  await turnEnds()
  expect(forks).toHaveLength(1)
})

test('of two names this mod gives, the later one is given last, over a name by hand between them', async ($, on) => {
  const { renames, fromPerson, step, flush, endTurn, renameAs } = engine($, on, {
    fork: [
      { isAnswered: true, text: '先の名前' },
      { isAnswered: true, text: '後の名前' },
    ],
  })
  await start($)
  await fromPerson('売上集計を直して')
  await endTurn()
  await step()
  await renameAs({ kind: 'composer' }, '手書きの名前')
  await nametag($)
  await flush()
  expect(renames().at(-1)).toBe('/rename 後の名前')
})

for (const [label, fork, said] of [
  ['nothing to fork', { isAnswered: false, reason: 'nothing-to-fork' }, 'nametag: nothing to name yet.'],
  ['a failed call', { isAnswered: false, reason: 'empty-reply' }, 'nametag: could not find a name.'],
  ['SKIP', { isAnswered: true, text: 'SKIP' }, 'nametag: could not find a name.'],
] as const) {
  test(`/nametag with ${label} says so and renames nothing`, async ($, on) => {
    const { renames } = engine($, on, { fork })
    const result = await nametag($)
    await settle()
    expect(result.text).toBe(said)
    expect(renames()).toEqual([])
  })
}

test('the prompt carries no examples, judges the language from the person, and names what a link held', async ($, on) => {
  const { forks } = engine($, on)
  await nametag($)
  expect(forks[0]).toContain('the language the person writes in')
  expect(forks[0]).toContain('what the linked content turned out to be about')
  expect(forks[0]).toContain('answer straight away')
  expect(forks[0]).not.toContain('e.g.')
  expect(forks[0]).not.toContain('Example')
})

test('the rules from the manifest reach the prompt', async ($, on) => {
  const { forks } = engine($, on)
  await nametag($)
  expect(forks[0]).toContain('Make it a bare noun phrase')
})

test(
  'the rules can be replaced, and the format stays',
  { options: { naming_rules: 'Always use Klingon.' } },
  async ($, on) => {
    const { forks } = engine($, on)
    await nametag($)
    expect(forks[0]).toContain('Always use Klingon.')
    expect(forks[0]).not.toContain('bare noun phrase')
    expect(forks[0]).toContain('Output only the name on one line')
    expect(forks[0]).toContain('output only SKIP')
  },
)

test('emptied rules still ask for one line', { options: { naming_rules: '  ' } }, async ($, on) => {
  const { forks } = engine($, on)
  await nametag($)
  expect(forks[0]).toContain('Output only the name on one line')
  expect(forks[0]).not.toContain('bare noun phrase')
})

test('a long name under the limit is kept, and a paragraph is not', async ($, on) => {
  const long = 'Authentification Basic middleware Next.js et Vercel'
  engine($, on, { fork: { isAnswered: true, text: long } })
  expect((await nametag($)).text).toBeUndefined()
})

test('a reply as long as a paragraph is no name', async ($, on) => {
  engine($, on, { fork: { isAnswered: true, text: 'a'.repeat(81) } })
  expect((await nametag($)).text).toBe('nametag: could not find a name.')
})
