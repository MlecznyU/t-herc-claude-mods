import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { Dialog, EdgeVoice, Engine, Style, Voice } from '../types'
import type { Screen } from './arrivals'
import { isFromPerson, onArrive, onClose, onDismissAll, onNextReply, onPreviousReply } from './arrivals'
import { nextParagraph, pause, previousParagraph, startDialog, togglePause } from './dialog'
import {
  EDGE_INSTALL_HINT,
  EDGE_TIMEOUT_MS,
  edgeRenderArgv,
  edgeVoicesFor,
  FIND_EDGE,
  isMultilingual,
  listEdgeVoicesArgv,
  parseEdgeExecutable,
  parseEdgeVoices,
  resolveEdgeVoice,
  sampleText,
  shortName,
} from './edge'
import type { PlaybackCommand, VoicedText } from './player'
import { CREATE_RENDER_DIRECTORY, LIST_VOICES, liveCommand, READ_SYSTEM_LOCALE, renderArgv, sampleCommand } from './player'
import {
  DEFAULT_RATE_INDEX,
  DEFAULT_STYLE,
  displayText,
  extractSpoken,
  RATES,
  SPOKEN_OFF_INSTRUCTION,
  spokenInstruction,
  splitSegments,
  STYLES,
  wordsPerMinute,
} from './speech'
import {
  languageName,
  languagesWithVoices,
  needsBetterVoice,
  normalizeLanguage,
  parseVoices,
  recommendation,
  resolveVoice,
  SYSTEM_VOICE,
  voicesFor,
} from './voices'

const ENGINES: readonly Engine[] = ['edge', 'mac']

const isOn = atom({ plugin: 'dialogue-box', key: 'isOn' } as const, false)
const dialog = atom({ plugin: 'dialogue-box', key: 'dialog' } as const, null)
const queue = atom({ plugin: 'dialogue-box', key: 'queue' } as const, [])
const history = atom({ plugin: 'dialogue-box', key: 'history' } as const, [])
const rateIndex = atom({ plugin: 'dialogue-box', key: 'rateIndex' } as const, DEFAULT_RATE_INDEX)
const primaryLanguage = atom({ plugin: 'dialogue-box', key: 'primaryLanguage' } as const, 'en')
const voiceChoices = atom({ plugin: 'dialogue-box', key: 'voiceChoices' } as const, {})
const edgeVoiceChoices = atom({ plugin: 'dialogue-box', key: 'edgeVoiceChoices' } as const, {})
const edgeVoices = atom({ plugin: 'dialogue-box', key: 'edgeVoices' } as const, [])
const defaultStyle = atom({ plugin: 'dialogue-box', key: 'style' } as const, DEFAULT_STYLE)
const styleOverride = atom({ plugin: 'dialogue-box', key: 'styleOverride' } as const, null)
const defaultEngine = atom({ plugin: 'dialogue-box', key: 'engine' } as const, 'edge')
const engineOverride = atom({ plugin: 'dialogue-box', key: 'engineOverride' } as const, null)
const fallback = atom({ plugin: 'dialogue-box', key: 'fallback' } as const, null)
const edgeVoicesStatus = atom({ plugin: 'dialogue-box', key: 'edgeVoicesStatus' } as const, 'idle')
const setupView = atom({ plugin: 'dialogue-box', key: 'setupView' } as const, 'voices')

const STORE_KEYS = {
  rateIndex: 'rateIndex',
  primaryLanguage: 'primaryLanguage',
  voiceChoices: 'voiceChoices',
  edgeVoiceChoices: 'edgeVoiceChoices',
  edgeVoices: 'edgeVoices',
  style: 'style',
  engine: 'engine',
}
const STATUS = '🔊 dialogue'
const USAGE = 'Usage: /dialogue on | off | stop | previous | setup | style integrated|mirror | engine edge|mac'
const NOT_AVAILABLE = 'dialogue-box needs macOS: it speaks through the system `say` command, which is not available here.'
const SETUP_PANE = 'dialogue-box-setup'
const VOICES_SHOWN_PER_LANGUAGE = 6
const EDGE_VOICES_SHOWN = 8
const PERSON_PROMPTS_KEPT = 5
// The first uvx run downloads edge-tts.
const LIST_EDGE_VOICES_TIMEOUT_MS = 90_000
const STYLE_LABELS: Record<Style, string> = {
  integrated: 'Integrated · speech leads, the written reply is a board it points at',
  mirror: 'Mirror · the written reply is complete, speech sums it up',
}
const ENGINE_LABELS: Record<Engine, string> = {
  edge: 'Edge neural voices · online, a Mac voice reads when Edge is unreachable',
  mac: 'Mac voices only · offline',
}

let installedVoices: Voice[] = []
let canSpeak = false
let edgeExecutable: string[] | undefined
// Set by the first failed Edge render, so the rest of the reply goes straight to the Mac voice instead of waiting on
// the network for every paragraph; the next reply tries Edge again.
let edgeDown = false
let playback: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sample: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sampleGeneration = 0
let presenting: Promise<void> = Promise.resolve()
// The turns that answer the person: the one their prompt was typed over, and the one it started (found by its text).
const personTurns = new Set<string>()
let personPrompts: string[] = []
const toastedFallbacks = new Set<string>()
// Bumped on every start and stop, so a paragraph that was cut short does not advance the dialog.
let generation = 0
let renderDirectory: Promise<string | undefined> | undefined
let renderCount = 0
// Bumped when the renders are discarded: a render that fails after that failed because its directory went away, not
// because Edge did.
let renderEpoch = 0
// Without a stored or session choice the engine is Edge only where edge-tts is installed, and a Mac voice reading is
// no fallback to warn about.
let isEngineChosen = false
const renders = new Map<string, Promise<string | undefined>>()

async function loadVoices($: EngineInterface) {
  const listing = await $.process.run(LIST_VOICES).catch(() => undefined)
  canSpeak = listing?.exitCode === 0
  installedVoices = canSpeak && listing !== undefined ? parseVoices(listing.stdout) : []
}

async function findEdge($: EngineInterface) {
  const found = await $.process.run(FIND_EDGE).catch(() => undefined)
  edgeExecutable = found?.exitCode === 0 ? parseEdgeExecutable(found.stdout) : undefined
}

async function loadEdgeVoices($: EngineInterface) {
  if (edgeExecutable === undefined || (await read($, edgeVoicesStatus)) === 'loading') return

  await update($, edgeVoicesStatus, () => 'loading')
  const listing = await $.process
    .run(listEdgeVoicesArgv(edgeExecutable), { timeoutMs: LIST_EDGE_VOICES_TIMEOUT_MS })
    .catch(() => undefined)
  const voices = listing?.exitCode === 0 ? parseEdgeVoices(listing.stdout) : []
  if (voices.length === 0) {
    await update($, edgeVoicesStatus, () => 'failed')
    return
  }

  await update($, edgeVoices, () => voices)
  await update($, edgeVoicesStatus, () => 'ready')
  await $.store.set(STORE_KEYS.edgeVoices, voices)
}

async function styleOf($: EngineInterface): Promise<Style> {
  return (await read($, styleOverride)) ?? (await read($, defaultStyle))
}

async function engineOf($: EngineInterface): Promise<Engine> {
  return (await read($, engineOverride)) ?? (await read($, defaultEngine))
}

async function voiceOf($: EngineInterface, language: string) {
  return resolveVoice(installedVoices, await read($, voiceChoices), language)
}

async function edgeVoiceOf($: EngineInterface, language: string) {
  return resolveEdgeVoice(await read($, edgeVoices), await read($, edgeVoiceChoices), language)
}

// The band shows why a Mac voice reads while the person asked for Edge; each reason is also toasted once a session.
async function announceFallback($: EngineInterface, reason: string) {
  await update($, fallback, () => reason)
  if (toastedFallbacks.has(reason)) return

  toastedFallbacks.add(reason)
  await $.ui.toast(reason)
}

async function usableEdgeVoice($: EngineInterface, language: string) {
  if (edgeDown || (await engineOf($)) !== 'edge') return undefined
  if (edgeExecutable === undefined) {
    if (isEngineChosen || (await read($, engineOverride)) !== null) {
      await announceFallback($, `Mac voice: edge-tts is not installed. ${EDGE_INSTALL_HINT}`)
    }
    return undefined
  }

  const voice = await edgeVoiceOf($, language)
  if (voice !== undefined) return voice

  const reason =
    (await read($, edgeVoices)).length === 0
      ? 'Mac voice: the Edge voice list has not loaded yet (no network?).'
      : `Mac voice: Edge has no ${languageName(language)} voice.`
  await announceFallback($, reason)
  return undefined
}

async function silence() {
  generation += 1
  const current = playback
  playback = undefined
  await current?.return({ code: null, signal: 'SIGTERM' })
}

async function discardRenders($: EngineInterface) {
  const pending = renderDirectory
  renderDirectory = undefined
  renders.clear()
  renderEpoch += 1
  const directory = await pending
  if (directory !== undefined) await $.process.run(['rm', '-rf', directory]).catch(() => undefined)
}

function renderFile($: EngineInterface, key: string, extension: string, argv: (out: string) => string[], timeoutMs: number) {
  const existing = renders.get(key)
  if (existing !== undefined) return existing

  renderDirectory ??= $.process
    .run(CREATE_RENDER_DIRECTORY)
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.trim() : undefined))
    .catch(() => undefined)
  const directory = renderDirectory
  renderCount += 1
  const name = `${renderCount}.${extension}`
  const rendering: Promise<string | undefined> = directory
    .then(async path => {
      if (path === undefined) return undefined
      const out = `${path}/${name}`
      const { exitCode } = await $.process.run(argv(out), { timeoutMs })
      return exitCode === 0 ? out : undefined
    })
    .catch(() => undefined)
    .then(file => {
      // A failure is not kept, so the next request tries again.
      if (file === undefined && renders.get(key) === rendering) renders.delete(key)
      return file
    })
  renders.set(key, rendering)

  return rendering
}

async function voicedParts($: EngineInterface, current: Dialog, index: number): Promise<VoicedText[]> {
  const segments = splitSegments(current.paragraphs[index] ?? '', current.language)

  return Promise.all(segments.map(async segment => ({ voice: await voiceOf($, segment.language), text: segment.text })))
}

async function renderMac($: EngineInterface, current: Dialog, index: number, rate: number) {
  const parts = await voicedParts($, current, index)
  if (parts.length < 2) return undefined

  return renderFile($, `mac:${rate}:${JSON.stringify(parts)}`, 'aiff', out => renderArgv(out, parts, rate), 60_000)
}

async function edgeFailed($: EngineInterface) {
  if (edgeDown) return

  edgeDown = true
  await announceFallback($, 'Mac voice: Edge did not answer (offline or blocked), so a Mac voice reads the rest of this reply.')
}

// Resolves the file to play, or undefined when the paragraph is spoken live by `say`.
async function renderParagraph($: EngineInterface, current: Dialog, index: number, rateStep: number) {
  const paragraph = current.paragraphs[index]
  if (paragraph === undefined) return undefined

  const edgeVoice = await usableEdgeVoice($, current.language)
  if (edgeVoice !== undefined && edgeExecutable !== undefined) {
    const epoch = renderEpoch
    const executable = edgeExecutable
    const rate = RATES[rateStep] ?? 1
    const text = displayText(paragraph)
    const file = await renderFile(
      $,
      `edge:${edgeVoice}:${rate}:${text}`,
      'mp3',
      out => edgeRenderArgv(executable, out, edgeVoice, text, rate),
      EDGE_TIMEOUT_MS,
    )
    if (file !== undefined) return file
    if (epoch !== renderEpoch) return undefined
    await edgeFailed($)
  }

  return renderMac($, current, index, wordsPerMinute(rateStep))
}

async function startFresh($: EngineInterface) {
  edgeDown = false
  await update($, fallback, () => null)
}

// Playback reaching an end, a reply arriving and a key press each read the screen and write it back; run one at a time
// so none of them loses a dialog the other queued.
function present($: EngineInterface, transition: (screen: Screen) => Screen): Promise<void> {
  const run = presenting.then(async () => {
    const before = await read($, dialog)
    const after = transition({ current: before, queue: await read($, queue), history: await read($, history) })
    await silence()
    await update($, queue, () => after.queue)
    await update($, history, () => after.history)
    await update($, dialog, () => after.current)
    if (after.current === null || after.current.id !== before?.id) {
      await discardRenders($)
      await startFresh($)
    }
    if (after.current?.status === 'playing') await speakCurrent($, after.current)
  })
  presenting = run.catch(() => undefined)

  return run
}

async function apply($: EngineInterface, transition: (current: Dialog) => Dialog) {
  await present($, screen => (screen.current === null ? screen : onClose({ ...screen, current: transition(screen.current) })))
}

async function nextReply($: EngineInterface) {
  await present($, onNextReply)
}

async function previousReply($: EngineInterface) {
  await present($, onPreviousReply)
}

async function closeAll($: EngineInterface) {
  await present($, onDismissAll)
}

async function speakCurrent($: EngineInterface, current: Dialog) {
  const mine = generation
  const rateStep = await read($, rateIndex)
  const rendering = renderParagraph($, current, current.index, rateStep)
  void renderParagraph($, current, current.index + 1, rateStep)
  const parts = await voicedParts($, current, current.index)
  const [only] = parts
  const live =
    parts.length === 1 && only !== undefined
      ? only
      : { voice: await voiceOf($, current.language), text: displayText(current.paragraphs[current.index] ?? '') }

  // The loop owns the child: it keeps playing after the hook returns, until it ends or silence() closes it.
  void (async () => {
    const file = await rendering
    if (mine !== generation) return

    const stream = $.process.spawn(file === undefined ? liveCommand(live, wordsPerMinute(rateStep)) : { argv: ['afplay', file] })
    playback = stream
    try {
      for await (const _ of stream) {
        // the player writes nothing worth reading
      }
    } catch (error) {
      $.ui.log(`dialogue-box: playback failed: ${String(error)}`, { to: 'debug' })
      return
    }
    if (mine !== generation) return

    playback = undefined
    await apply($, nextParagraph)
  })()
}

async function changeRate($: EngineInterface, step: number) {
  const next = Math.min(RATES.length - 1, Math.max(0, (await read($, rateIndex)) + step))
  await update($, rateIndex, () => next)
  await $.store.set(STORE_KEYS.rateIndex, next)

  await present($, screen => screen)
}

async function settingsSummary($: EngineInterface) {
  const primary = await read($, primaryLanguage)
  const languages = primary === 'en' ? ['en'] : [primary, 'en']
  const macVoices = await Promise.all(
    languages.map(async language => `${languageName(language)} → ${(await voiceOf($, language)) ?? 'system voice'}`),
  )
  const edgeVoice = await edgeVoiceOf($, primary)
  const engine =
    (await engineOf($)) === 'edge' && edgeExecutable !== undefined && edgeVoice !== undefined
      ? `Edge voice ${edgeVoice}, Mac voices as backup: ${macVoices.join(', ')}`
      : `Mac voices: ${macVoices.join(', ')}`

  return `Style: ${await styleOf($)}. ${engine}. Run /dialogue setup to change them.`
}

function isStyle(value: unknown): value is Style {
  return STYLES.some(style => style === value)
}

function isEngine(value: unknown): value is Engine {
  return ENGINES.some(engine => engine === value)
}

function isEdgeVoice(value: unknown): value is EdgeVoice {
  if (typeof value !== 'object' || value === null) return false

  const fields: Record<string, unknown> = { ...value }
  return ['name', 'language', 'locale', 'gender', 'personalities'].every(key => typeof fields[key] === 'string')
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function restoreSettings($: EngineInterface) {
  const storedRate = await $.store.get(STORE_KEYS.rateIndex)
  if (typeof storedRate === 'number' && storedRate >= 0 && storedRate < RATES.length) {
    await update($, rateIndex, () => storedRate)
  }

  const storedChoices = stringRecord(await $.store.get(STORE_KEYS.voiceChoices))
  if (storedChoices !== undefined) await update($, voiceChoices, () => storedChoices)

  const storedEdgeChoices = stringRecord(await $.store.get(STORE_KEYS.edgeVoiceChoices))
  if (storedEdgeChoices !== undefined) await update($, edgeVoiceChoices, () => storedEdgeChoices)

  const storedEdgeVoices = await $.store.get(STORE_KEYS.edgeVoices)
  if (Array.isArray(storedEdgeVoices)) await update($, edgeVoices, () => storedEdgeVoices.filter(isEdgeVoice))

  const storedStyle = await $.store.get(STORE_KEYS.style)
  if (isStyle(storedStyle)) await update($, defaultStyle, () => storedStyle)

  const storedEngine = await $.store.get(STORE_KEYS.engine)
  isEngineChosen = isEngine(storedEngine)
  if (isEngine(storedEngine)) await update($, defaultEngine, () => storedEngine)

  const storedPrimary = await $.store.get(STORE_KEYS.primaryLanguage)
  if (typeof storedPrimary === 'string' && storedPrimary !== '') {
    await update($, primaryLanguage, () => storedPrimary)
    return
  }
  const locale = await $.process.run(READ_SYSTEM_LOCALE).catch(() => undefined)
  const systemLanguage = locale?.exitCode === 0 ? normalizeLanguage(locale.stdout) : ''
  if (systemLanguage !== '') await update($, primaryLanguage, () => systemLanguage)
}

async function openSetup($: EngineInterface) {
  await update($, setupView, () => 'voices')
  await findEdge($)
  void loadEdgeVoices($).catch(() => undefined)
  return $.ui.open({ id: SETUP_PANE, title: 'Voice setup', focus: true, closeOnEscape: true, holdToasts: true })
}

async function stopSample() {
  sampleGeneration += 1
  const current = sample
  sample = undefined
  await current?.return({ code: null, signal: 'SIGTERM' })
}

function spawnSample($: EngineInterface, command: PlaybackCommand) {
  const stream = $.process.spawn(command)
  sample = stream
  void (async () => {
    for await (const _ of stream) {
      // the player writes nothing worth reading
    }
  })().catch(() => undefined)
}

async function playSample($: EngineInterface, voice: Voice) {
  await stopSample()
  spawnSample($, sampleCommand({ voice: voice.name, text: voice.sample || voice.name }))
}

async function playEdgeSample($: EngineInterface, voice: EdgeVoice, language: string) {
  await stopSample()
  const mine = sampleGeneration
  const epoch = renderEpoch
  const executable = edgeExecutable
  if (executable === undefined) return

  const text = sampleText(language)
  const file = await renderFile(
    $,
    `sample:${voice.name}:${text}`,
    'mp3',
    out => edgeRenderArgv(executable, out, voice.name, text, 1),
    LIST_EDGE_VOICES_TIMEOUT_MS,
  )
  if (mine !== sampleGeneration || epoch !== renderEpoch) return
  if (file === undefined) {
    await $.ui.toast('Edge voice unreachable: no sample.')
    return
  }
  spawnSample($, { argv: ['afplay', file] })
}

async function choosePrimary($: EngineInterface, language: string) {
  await update($, primaryLanguage, () => language)
  await $.store.set(STORE_KEYS.primaryLanguage, language)
  await update($, setupView, () => 'voices')
}

async function chooseVoice($: EngineInterface, language: string, name: string) {
  const next = { ...(await read($, voiceChoices)), [language]: name }
  await update($, voiceChoices, () => next)
  await $.store.set(STORE_KEYS.voiceChoices, next)
}

async function chooseEdgeVoice($: EngineInterface, language: string, name: string) {
  const next = { ...(await read($, edgeVoiceChoices)), [language]: name }
  await update($, edgeVoiceChoices, () => next)
  await $.store.set(STORE_KEYS.edgeVoiceChoices, next)
}

async function chooseStyle($: EngineInterface, style: Style) {
  await update($, defaultStyle, () => style)
  await update($, styleOverride, () => null)
  await $.store.set(STORE_KEYS.style, style)
}

async function chooseEngine($: EngineInterface, engine: Engine) {
  edgeDown = false
  await update($, fallback, () => null)
  await update($, defaultEngine, () => engine)
  await update($, engineOverride, () => null)
  await $.store.set(STORE_KEYS.engine, engine)
  isEngineChosen = true
}

async function showLanguages($: EngineInterface) {
  await update($, setupView, () => 'languages')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dialogue', description: 'Hear replies as spoken dialogue: on | off | stop | previous | setup | style | engine' })
    await Promise.all([loadVoices($), restoreSettings($), findEdge($)])
    // Also warms uvx, whose first run downloads edge-tts.
    if ((await engineOf($)) === 'edge') void loadEdgeVoices($).catch(() => undefined)
    $.ui.status((await read($, isOn)) ? STATUS : undefined)

    return next(e)
  })

  on('command.run', { command: 'dialogue' }, async ($, e) => {
    const [action, value] = e.args.trim().split(/\s+/)
    switch (action) {
      case 'on':
        if (!canSpeak) return { text: NOT_AVAILABLE }
        await update($, isOn, () => true)
        $.ui.status(STATUS)
        return {
          text: `Dialogue on: replies end with spoken paragraphs you can rewind, pause and skip. ${await settingsSummary($)}`,
          context: [spokenInstruction(await styleOf($))],
        }
      case 'off':
        await update($, isOn, () => false)
        await closeAll($)
        $.ui.status(undefined)
        return { text: 'Dialogue off.', context: [SPOKEN_OFF_INSTRUCTION] }
      case 'previous':
        if ((await read($, history)).length === 0) return { text: 'No earlier reply to play.' }
        await previousReply($)
        return { text: 'Playing the previous reply.' }
      case 'stop':
        await closeAll($)
        return { text: 'Playback stopped.' }
      case 'setup': {
        await loadVoices($)
        if (!canSpeak) return { text: NOT_AVAILABLE }
        const opened = await openSetup($)
        return { text: opened.isPlaced ? 'Voice setup opened.' : `Voice setup could not open: ${opened.reason}` }
      }
      case 'style': {
        if (!isStyle(value)) return { text: USAGE }
        await update($, styleOverride, () => value)
        const text = `Style for this session: ${STYLE_LABELS[value]}.`
        return (await read($, isOn)) ? { text, context: [spokenInstruction(value)] } : { text }
      }
      case 'engine':
        if (!isEngine(value)) return { text: USAGE }
        if (value === 'edge') {
          await findEdge($)
          if (edgeExecutable === undefined) return { text: EDGE_INSTALL_HINT }
          void loadEdgeVoices($).catch(() => undefined)
        }
        edgeDown = false
        await update($, fallback, () => null)
        await update($, engineOverride, () => value)
        return { text: `Engine for this session: ${ENGINE_LABELS[value]}.` }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed

    return {
      sections: [...composed.sections, { id: 'dialogue-box:spoken', text: spokenInstruction(await styleOf($)), scope: 'session' }],
    }
  })

  // Typing or dictation landing in the prompt means the person has started answering, and the microphone must not hear the voice.
  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    if (e.text.trim() !== '' && (await read($, dialog))?.status === 'playing') await apply($, pause)

    return result
  })

  // A notification, a schedule or another session submits too; only the person's own message, one that reaches the
  // model, ends what is playing.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (!isFromPerson(e.origin) || e.command !== undefined || 'drop' in result) return result

    if (e.turnId !== undefined) personTurns.add(e.turnId)
    personPrompts = [...personPrompts, result.text].slice(-PERSON_PROMPTS_KEPT)
    await closeAll($).catch(() => undefined)
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    const at = e.agentId === undefined ? personPrompts.indexOf(e.text) : -1
    if (at >= 0) {
      personPrompts = personPrompts.filter((_, index) => index !== at)
      personTurns.add(e.turnId)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const isReply = personTurns.delete(e.turnId)
    if (e.reason !== 'answer' || !(await read($, isOn))) return result

    const spoken = extractSpoken(e.answer)
    if (spoken !== undefined && spoken.paragraphs.length > 0) {
      const incoming = startDialog(e.turnId, spoken.paragraphs, spoken.language ?? (await read($, primaryLanguage)))
      await present($, screen => onArrive(screen, incoming, isReply))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, dialog)
    if (current === null || e.props.hasSurvey) return next(e)

    const rate = RATES[await read($, rateIndex)] ?? 1
    const state = { playing: '', paused: ' · ⏸ paused', ended: ' · end' }[current.status]
    const reason = await read($, fallback)
    const waiting = (await read($, queue)).length
    const heard = (await read($, history)).length
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>
          🔊 {current.index + 1} / {current.paragraphs.length}
          <Text dimColor>
            {' '}
            · {rate}×{state}
            {heard + waiting > 0 && ` · reply ${heard + 1} / ${heard + 1 + waiting}`}
          </Text>
        </Text>
        {reason !== null && <Text color="warning">⚠ {reason}</Text>}
        <Text>{displayText(current.paragraphs[current.index] ?? '')}</Text>
        <Box flexDirection="row" gap={2}>
          <Button key="back" label="back" hotkey="1" plain onPress={() => apply($, previousParagraph)} />
          <Button
            key="pause"
            label={current.status === 'playing' ? 'pause' : 'resume'}
            hotkey="2"
            plain
            onPress={() => apply($, togglePause)}
          />
          <Button key="skip" label="skip" hotkey="3" plain onPress={() => apply($, nextParagraph)} />
          <Button key="slower" label="slower" hotkey="4" plain onPress={() => changeRate($, -1)} />
          <Button key="faster" label="faster" hotkey="5" plain onPress={() => changeRate($, 1)} />
          {heard > 0 && <Button key="previous-reply" label="prev reply" hotkey="9" plain onPress={() => previousReply($)} />}
          <Button key="stop" label={waiting > 0 ? 'next reply' : 'stop'} hotkey="0" plain onPress={() => nextReply($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const primary = await read($, primaryLanguage)

    if ((await read($, setupView)) === 'languages') {
      return (
        <Box flexDirection="column">
          <Text bold>Main language</Text>
          {languagesWithVoices(installedVoices).map(language => (
            <Button
              key={`language-${language}`}
              label={`${languageName(language)} (${language})${language === primary ? ' ●' : ''}`}
              onPress={() => choosePrimary($, language)}
            />
          ))}
        </Box>
      )
    }

    const choices = await read($, voiceChoices)
    const languages = primary === 'en' ? ['en'] : [primary, 'en']
    const style = await read($, defaultStyle)
    const sessionStyle = await read($, styleOverride)
    const engine = await read($, defaultEngine)
    const sessionEngine = await read($, engineOverride)
    const chosenEdge = await edgeVoiceOf($, primary)
    const ranked = edgeVoicesFor(await read($, edgeVoices), primary)
    const shown = ranked.slice(0, EDGE_VOICES_SHOWN)
    const hiddenChoice = ranked.find(voice => voice.name === chosenEdge && !shown.includes(voice))
    const edgeList = hiddenChoice === undefined ? shown : [...shown, hiddenChoice]
    const edgeStatus = await read($, edgeVoicesStatus)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>Main language: {languageName(primary)}</Text>
          <Button key="change-language" label="change" onPress={() => showLanguages($)} />
        </Box>
        <Box flexDirection="column">
          <Text bold>Conversation style</Text>
          {STYLES.map(option => (
            <Box flexDirection="row" gap={1}>
              <Text>{option === style ? '●' : '○'}</Text>
              <Button key={`style-${option}`} label={STYLE_LABELS[option]} onPress={() => chooseStyle($, option)} />
            </Box>
          ))}
          {sessionStyle !== null && <Text dimColor>This session: {sessionStyle} (/dialogue style)</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Speech engine</Text>
          {ENGINES.map(option => (
            <Box flexDirection="row" gap={1}>
              <Text>{option === engine ? '●' : '○'}</Text>
              <Button key={`engine-${option}`} label={ENGINE_LABELS[option]} onPress={() => chooseEngine($, option)} />
            </Box>
          ))}
          {sessionEngine !== null && <Text dimColor>This session: {sessionEngine} (/dialogue engine)</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Edge voice · {languageName(primary)}</Text>
          {edgeExecutable === undefined && <Text color="warning">{EDGE_INSTALL_HINT}</Text>}
          {edgeExecutable !== undefined && edgeStatus === 'loading' && edgeList.length === 0 && (
            <Text dimColor>Loading Edge voices… (the first run downloads edge-tts)</Text>
          )}
          {edgeExecutable !== undefined && edgeStatus === 'failed' && (
            <Box flexDirection="row" gap={2}>
              <Text color="warning">Could not load the Edge voices (offline?).</Text>
              <Button key="edge-retry" label="retry" onPress={() => loadEdgeVoices($)} />
            </Box>
          )}
          {edgeList.map(voice => (
            <Box flexDirection="row" gap={1}>
              <Text>{voice.name === chosenEdge ? '●' : '○'}</Text>
              <Button
                key={`edge-${voice.name}`}
                label={[shortName(voice), voice.gender, isMultilingual(voice) ? `multilingual, ${voice.locale}` : '', voice.personalities]
                  .filter(part => part !== '')
                  .join(' · ')}
                onPress={() => chooseEdgeVoice($, primary, voice.name)}
              />
              {edgeExecutable !== undefined && (
                <Button key={`edge-sample-${voice.name}`} label="▶" plain onPress={() => playEdgeSample($, voice, primary)} />
              )}
            </Box>
          ))}
        </Box>
        {languages.map(language => {
          const chosen = resolveVoice(installedVoices, choices, language)
          const ranked = voicesFor(installedVoices, language).slice(0, VOICES_SHOWN_PER_LANGUAGE)

          return (
            <Box flexDirection="column">
              <Text bold>
                Mac voice · {languageName(language)}
                {language === primary ? '' : ' (words in other languages)'}
              </Text>
              {ranked.length === 0 && <Text color="warning">No voice installed: the system voice speaks it.</Text>}
              {ranked.map(voice => (
                <Box flexDirection="row" gap={1}>
                  <Text>{voice.name === chosen ? '●' : '○'}</Text>
                  <Button
                    key={`pick-${voice.name}`}
                    label={`${voice.name} · ${voice.quality}`}
                    onPress={() => chooseVoice($, language, voice.name)}
                  />
                  <Button key={`sample-${voice.name}`} label="▶" plain onPress={() => playSample($, voice)} />
                </Box>
              ))}
              <Box flexDirection="row" gap={1}>
                <Text>{chosen === undefined ? '●' : '○'}</Text>
                <Button
                  key={`pick-system-${language}`}
                  label="System voice · set in System Settings → Accessibility → Spoken Content"
                  onPress={() => chooseVoice($, language, SYSTEM_VOICE)}
                />
              </Box>
              {needsBetterVoice(installedVoices, language) && <Text color="warning">{recommendation(language)}</Text>}
            </Box>
          )
        })}
        <Text dimColor>Tab or arrows move · Enter picks · ▶ plays a sample · Esc closes</Text>
      </Box>
    )
  })
}
