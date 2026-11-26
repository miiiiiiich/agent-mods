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

// Hears whether the /rename went through.
type Landed = (isRenamed: boolean) => string | undefined
// Hears the name that came back, `undefined` when none did, and answers how to land it, or nothing when it no longer
// stands.
type Claim = (name: string | undefined) => Landed | undefined

// The command waits for an idle session. `landed` hears when it is done and may hand back a name to give after it.
const rename = async ($: EngineInterface, name: string, landed: Landed): Promise<void> => {
  const isRenamed = await $.command.run({ command: 'rename', args: name }).then(
    () => true,
    (error: unknown) => {
      $.ui.log(`nametag: ${String(error)}`)
      return false
    },
  )
  const back = landed(isRenamed)
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

// Hears each prompt a person sent that went on to the model. One dropped on the way, by a settings hook's block among
// others, never reached it.
const onPersonPrompt = (on: On, heard: () => void): void => {
  on('prompt.submit', async (_$, e, next) => {
    const isFromPerson = PERSON_ORIGINS.includes(e.origin.kind)
    const result = await next(e)
    if (isFromPerson && result.drop === undefined) {
      heard()
    }
    return result
  })
}

interface Waiting {
  name?: string
  byHand?: string
}

interface Naming {
  restarted: (isNameless: boolean) => void
  explicit: () => Claim
  heard: () => void
  renamed: (name: string) => void
  ask: () => Claim | undefined
}

// No hook a person's mod gets on a team plan tells it the session's title, so this mod keeps what it saw. A session is
// nameless when it started fresh or /clear left the old title in place, until a name comes from this mod or /rename.
// A title out of its sight counts as a name, so it never writes over one: a resumed session's, or the one a session
// with turns had when this mod was reloaded into it. Before the first prompt it can't tell: a title from `claude -n`
// or a settings hook, or one given by hand before a reload, is replaced like no name.
// A person's prompt to a nameless session marks it, and the end of a turn that answered names it. A failed name, or a
// failed /rename of a nameless session, is asked for again after the next turn, because the next prompt marks the
// still nameless session again.
// `waiting` is what this mod is about to name the session: `{}` while the model is asked, `{ name }` until its
// /rename is done, which runs only once the session is idle. Meanwhile turns don't ask again, and a prompt marks the
// session only while it asks. A name from the person or another plugin while it asks drops this mod's, and so do
// /clear and a resume. One while its /rename waits is given back after it, also across /clear, as the /rename is sent
// already; not across a resume, as the name by hand was the other session's.
const naming = (): Naming => {
  let isNameless = false
  let isMarked = false
  let waiting: Waiting | undefined

  const decide = (name: string): Landed => {
    const mine: Waiting = { name }
    const wasNameless = isNameless
    isNameless = false
    isMarked = false
    waiting = mine
    return isRenamed => {
      if (waiting === mine) {
        waiting = undefined
        isNameless ||= wasNameless && !(isRenamed || mine.byHand)
        return mine.byHand
      }
    }
  }

  // What comes back counts only if no other name arrived since: `renamed` and `restarted` take `waiting` away.
  const begin = (keepsMark: boolean): Claim => {
    const asking: Waiting = {}
    isMarked = false
    waiting = asking
    return name => {
      if (waiting !== asking) {
        return
      }
      waiting = undefined
      if (name !== undefined) {
        return decide(name)
      }
      isMarked = isNameless && (keepsMark || isMarked)
    }
  }

  return {
    restarted: (isNamelessNow: boolean): void => {
      isNameless = isNamelessNow
      isMarked = false
      if (waiting?.name === undefined || !isNamelessNow) {
        waiting = undefined
      }
    },
    explicit: (): Claim => begin(isMarked),
    heard: (): void => {
      if (waiting?.name === undefined) {
        isMarked = isNameless
      }
    },
    renamed: (name: string): void => {
      isNameless = false
      isMarked = false
      if (waiting?.name === undefined) {
        waiting = undefined
      } else {
        waiting.byHand = name
      }
    },
    ask: (): Claim | undefined => {
      if (isMarked && !waiting) {
        return begin(false)
      }
    },
  }
}

export const register: Register = (on, options) => {
  const prompt = promptFor(String(options.naming_rules ?? '').trim())
  const state = naming()

  // A resumed session keeps whatever color it had.
  on('session.start', async ($, e, next) => {
    await registerCommand($)
    const result = await next(e)
    const isFresh = (await $.session.turns()) === 0
    state.restarted(isFresh)
    if (isFresh && e.isInteractive) {
      rollColor($)
    }
    return result
  })

  on('command.run', { command: COMMAND }, $ => renameNow($, prompt, state.explicit()))

  // This mod's own /rename does not pass its own hooks.
  on('command.run', { command: 'rename' }, (_$, e, next) => {
    state.renamed(e.args)
    return next(e)
  })

  // /clear goes on in a new session, with no session.start for it. It keeps the old title, and no hook can empty it,
  // so that counts as no name, hand-written or not. A resume in the session puts another in its place, its title out
  // of sight. The color waits for a timer, as a command may not run from inside another.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      state.restarted(true)
      $.clock.after(0, () => rollColor($))
    } else if (e.reason === 'resume') {
      state.restarted(false)
    }
    return next(e)
  })

  onPersonPrompt(on, state.heard)
  onAnsweredTurn(on, prompt, state.ask)
}
