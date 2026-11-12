import type { EngineInterface, On, Register } from 'claude-code'

// Only catches a model talking at length. Rules can ask for a longer language or form, so it leaves them room.
const MAX_NAME_CHARS = 80
const PERSON_ORIGINS = ['composer', 'bridge']
const LINE_BREAK = /\r?\n/u
const DECORATION = /[`"「」*]/gu
const SENTENCE_END = /[。.]$/u
const COMMAND = 'nametag'
const NOTHING_TO_NAME = 'nametag: nothing to name yet.'
const NO_NAME = 'nametag: could not find a name.'

// The format and the SKIP answer are this mod's own: it reads the reply by them. The rules between are the person's to
// change, and their default lives in plugin.json. It holds no examples: a model copies their language and shape.
// It names no effort and asks for haste in words instead, so the fork reads the session's cache on every model.
const promptFor = (rules: string): string =>
  `Name this session after what the person is working on now, judged from their latest messages. Earlier subjects they have moved on from don't count; a short follow-up belongs to the subject it continues. When they handed over a link, name what the linked content turned out to be about, not the act of opening it. You have no tools: answer straight away without thinking it over. Output only the name on one line, with no explanation, quotes, or brackets.
${rules}
If you cannot tell what the work is, output only SKIP.`

// Not awaited: the command waits for an idle session, and the hook that calls this is awaited first.
const rollColor = ($: EngineInterface): void => {
  $.command.run({ command: 'color' }).catch((error: unknown) => {
    $.ui.log(`nametag: ${String(error)}`)
  })
}

// The last line, because a model that reasons aloud puts its answer there. A name is a noun phrase, so a line
// that ends like a sentence is the model talking. A name that really holds SKIP is asked for again next time.
const cleanName = (text: string): string | undefined => {
  const line = text.split(LINE_BREAK).findLast(row => row.trim()) ?? ''
  const name = line.replace(DECORATION, '').trim()
  if (!name || text.includes('SKIP') || SENTENCE_END.test(name) || name.length > MAX_NAME_CHARS) {
    return
  }
  return name
}

type Landed = () => string | undefined
// Hears the name that came back, `undefined` when none did, and answers how to land it, or nothing when it no longer
// stands.
type Claim = (name: string | undefined) => Landed | undefined

// The command waits for an idle session. `landed` hears when it is done and may hand back a name to give after it.
const rename = async ($: EngineInterface, name: string, landed: Landed): Promise<void> => {
  try {
    await $.command.run({ command: 'rename', args: name })
  } catch (error: unknown) {
    $.ui.log(`nametag: ${String(error)}`)
  }
  const back = landed()
  if (back) {
    applyName($, back)
  }
}

// From a timer: a command's own hook may not run another command.
function applyName($: EngineInterface, name: string, landed: Landed = () => undefined): void {
  $.clock.after(0, () => {
    rename($, name, landed).catch((error: unknown) => {
      $.ui.log(`nametag: ${String(error)}`)
    })
  })
}

const askName = async ($: EngineInterface, prompt: string): Promise<{ name: string } | { text: string }> => {
  const reply = await $.model.fork({ prompt })
  if (!reply.isAnswered) {
    if (reply.reason === 'nothing-to-fork') {
      return { text: NOTHING_TO_NAME }
    }
    $.ui.log(`nametag: no name: ${reply.reason}`, { to: 'debug' })
    return { text: NO_NAME }
  }
  const name = cleanName(reply.text)
  if (!name) {
    return { text: NO_NAME }
  }
  return { name }
}

// A resumed session keeps whatever color it had.
const rollColorIfNew = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  if (isInteractive && (await $.session.turns()) === 0) {
    rollColor($)
  }
}

// Not only for an interactive session: the desktop app hosts its sessions as headless ones.
const registerCommand = async ($: EngineInterface): Promise<void> => {
  await $.command.register({
    name: COMMAND,
    description: 'Rename this session from the conversation so far',
    immediate: true,
  })
}

const renameNow = async ($: EngineInterface, prompt: string, claim: Claim): Promise<{ text?: string }> => {
  // A refused fork rejects; the claim still hears that no name came.
  const asked = await askName($, prompt).catch((error: unknown) => {
    claim(undefined)
    throw error
  })
  if ('text' in asked) {
    claim(undefined)
    return asked
  }
  const landed = claim(asked.name)
  if (landed) {
    applyName($, asked.name, landed)
  }
  return {}
}

// After the turn, not before it: by then the conversation holds what the prompt pointed at, such as a linked page.
const onAnsweredTurn = (on: On, prompt: string, ask: () => Claim | undefined): void => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') {
      return result
    }
    const claim = ask()
    if (claim) {
      $.clock.after(0, () => {
        renameNow($, prompt, claim).catch((error: unknown) => {
          $.ui.log(`nametag: ${String(error)}`)
        })
      })
    }
    return result
  })
}

// Hears each prompt a person sent that goes on to the model, with the session's title as it was sent. The classic hook
// runs inside prompt.submit's next(e), so the flag holds for exactly one prompt.
const onPersonPrompt = (on: On, heard: (title: string | undefined) => void): void => {
  let isFromPerson = false

  on('prompt.submit', async (_$, e, next) => {
    isFromPerson = PERSON_ORIGINS.includes(e.origin.kind)
    try {
      return await next(e)
    } finally {
      isFromPerson = false
    }
  })

  on('classic.UserPromptSubmit', async (_$, e, next) => {
    // Read before next(e), because another prompt can arrive while the hooks beneath run.
    const wasFromPerson = isFromPerson
    const result = await next(e)
    if (wasFromPerson && !result.block && !result.preventContinuation) {
      heard(e.session_title)
    }
    return result
  })
}

interface Waiting {
  name?: string
  byHand?: string
  // While it asks: whether a prompt sent meanwhile would have marked the session, to mark it if no name comes.
  wouldMark?: boolean
}

interface Naming {
  explicit: () => Claim
  heard: (title: string | undefined) => void
  renamed: (name: string) => void
  cleared: () => void
  ask: () => Claim | undefined
}

// A person's prompt to an unnamed session marks it, and the end of a turn that answered names it. A failed name is
// asked for again after the next turn, because the next prompt marks the still unnamed session again.
// `waiting` is what this mod is about to name the session: `{}` while the model is asked, `{ name }` until its
// /rename is done, which runs only once the session is idle. Meanwhile prompts don't ask again. A name from the person
// or another plugin while it asks drops this mod's, and so does /clear; one while its /rename waits is given back
// after it.
// /clear keeps the title. An automatic one is replaced after the next turn, and a hand-written one stays: `staleName`.
const naming = (): Naming => {
  let isUnnamed = false
  let waiting: Waiting | undefined
  let autoName: string | undefined
  let staleName: string | undefined

  // A name counts as automatic once this mod decides it, so /clear replaces it like any other this mod gave.
  const decide = (name: string): Landed => {
    const mine: Waiting = { name }
    autoName = name
    staleName = undefined
    isUnnamed = false
    waiting = mine
    return () => {
      if (waiting === mine) {
        waiting = undefined
        return mine.byHand
      }
    }
  }

  // What comes back counts only if no other name arrived since: `renamed` and `cleared` take `waiting` away.
  const begin = (keepsMark: boolean): Claim => {
    const asking: Waiting = {}
    isUnnamed = false
    waiting = asking
    return name => {
      if (waiting !== asking) {
        return
      }
      waiting = undefined
      isUnnamed = name === undefined && (keepsMark || asking.wouldMark === true)
      if (name !== undefined) {
        return decide(name)
      }
    }
  }

  return {
    explicit: (): Claim => begin(isUnnamed),
    heard: (title: string | undefined): void => {
      const wouldMark = !title || title === staleName
      if (waiting) {
        waiting.wouldMark = waiting.name === undefined && wouldMark
        return
      }
      isUnnamed = wouldMark
    },
    renamed: (name: string): void => {
      isUnnamed = false
      if (waiting?.name === undefined) {
        waiting = undefined
      } else {
        waiting.byHand = name
      }
    },
    cleared: (): void => {
      staleName = autoName
      if (waiting?.name === undefined) {
        waiting = undefined
      }
    },
    ask: (): Claim | undefined => {
      if (isUnnamed) {
        return begin(false)
      }
    },
  }
}

export const register: Register = (on, options) => {
  const prompt = promptFor(String(options.naming_rules ?? '').trim())
  const state = naming()

  on('session.start', async ($, e, next) => {
    await registerCommand($)
    const result = await next(e)
    await rollColorIfNew($, e.isInteractive)
    return result
  })

  on('command.run', { command: COMMAND }, $ => renameNow($, prompt, state.explicit()))

  // This mod's own /rename does not pass its own hooks.
  on('command.run', { command: 'rename' }, (_$, e, next) => {
    state.renamed(e.args)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      state.cleared()
      rollColor($)
    }
    return result
  })

  onPersonPrompt(on, state.heard)
  onAnsweredTurn(on, prompt, state.ask)
}
