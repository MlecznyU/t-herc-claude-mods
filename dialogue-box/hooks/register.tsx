import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { Dialog, Voice } from '../types'
import { nextParagraph, pause, previousParagraph, startDialog, togglePause } from './dialog'
import type { VoicedText } from './player'
import { CREATE_RENDER_DIRECTORY, LIST_VOICES, liveCommand, READ_SYSTEM_LOCALE, renderArgv, sampleCommand } from './player'
import {
  DEFAULT_RATE_INDEX,
  displayText,
  extractSpoken,
  RATES,
  SPOKEN_INSTRUCTION,
  splitSegments,
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

const isOn = atom({ plugin: 'dialogue-box', key: 'isOn' } as const, false)
const dialog = atom({ plugin: 'dialogue-box', key: 'dialog' } as const, null)
const rateIndex = atom({ plugin: 'dialogue-box', key: 'rateIndex' } as const, DEFAULT_RATE_INDEX)
const primaryLanguage = atom({ plugin: 'dialogue-box', key: 'primaryLanguage' } as const, 'en')
const voiceChoices = atom({ plugin: 'dialogue-box', key: 'voiceChoices' } as const, {})
const setupView = atom({ plugin: 'dialogue-box', key: 'setupView' } as const, 'voices')

const STORE_KEYS = { rateIndex: 'rateIndex', primaryLanguage: 'primaryLanguage', voiceChoices: 'voiceChoices' }
const STATUS = '🔊 dialogue'
const USAGE = 'Usage: /dialogue on | off | stop | setup'
const NOT_AVAILABLE = 'dialogue-box needs macOS: it speaks through the system `say` command, which is not available here.'
const SETUP_PANE = 'dialogue-box-setup'
const VOICES_SHOWN_PER_LANGUAGE = 6

let installedVoices: Voice[] = []
let canSpeak = false
let playback: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sample: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
// Bumped on every start and stop, so a paragraph that was cut short does not advance the dialog.
let generation = 0
let renderDirectory: Promise<string | undefined> | undefined
let renderCount = 0
const renders = new Map<string, Promise<string | undefined>>()

async function loadVoices($: EngineInterface) {
  const listing = await $.process.run(LIST_VOICES).catch(() => undefined)
  canSpeak = listing?.exitCode === 0
  installedVoices = canSpeak && listing !== undefined ? parseVoices(listing.stdout) : []
}

async function voiceOf($: EngineInterface, language: string) {
  return resolveVoice(installedVoices, await read($, voiceChoices), language)
}

async function silence() {
  generation += 1
  const current = playback
  playback = undefined
  await current?.return({ code: null, signal: 'SIGTERM' })
}

async function discardRenders($: EngineInterface) {
  const directory = await renderDirectory
  renderDirectory = undefined
  renders.clear()
  if (directory !== undefined) await $.process.run(['rm', '-rf', directory])
}

async function voicedParts($: EngineInterface, current: Dialog, index: number): Promise<VoicedText[]> {
  const segments = splitSegments(current.paragraphs[index] ?? '', current.language)

  return Promise.all(segments.map(async segment => ({ voice: await voiceOf($, segment.language), text: segment.text })))
}

async function render($: EngineInterface, current: Dialog, index: number, rate: number) {
  const parts = await voicedParts($, current, index)
  if (parts.length < 2) return undefined

  const key = `${rate}:${index}:${JSON.stringify(parts)}`
  const existing = renders.get(key)
  if (existing !== undefined) return existing

  renderDirectory ??= $.process
    .run(CREATE_RENDER_DIRECTORY)
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.trim() : undefined))
    .catch(() => undefined)
  const directory = renderDirectory
  renderCount += 1
  const name = `${renderCount}.aiff`
  const rendering = directory
    .then(async path => {
      if (path === undefined) return undefined
      const out = `${path}/${name}`
      const { exitCode } = await $.process.run(renderArgv(out, parts, rate), { timeoutMs: 60_000 })
      return exitCode === 0 ? out : undefined
    })
    .catch(() => undefined)
  renders.set(key, rendering)

  return rendering
}

async function show($: EngineInterface, next: Dialog | null) {
  await silence()
  await update($, dialog, () => next)
  if (next === null) await discardRenders($)
  if (next?.status === 'playing') await speakCurrent($, next)
}

async function apply($: EngineInterface, transition: (current: Dialog) => Dialog) {
  const current = await read($, dialog)
  if (current !== null) await show($, transition(current))
}

async function speakCurrent($: EngineInterface, current: Dialog) {
  const mine = generation
  const rate = wordsPerMinute(await read($, rateIndex))
  const rendering = render($, current, current.index, rate)
  void render($, current, current.index + 1, rate)
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

    const stream = $.process.spawn(file === undefined ? liveCommand(live, rate) : { argv: ['afplay', file] })
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

  const current = await read($, dialog)
  if (current?.status === 'playing') await show($, current)
}

async function voicesSummary($: EngineInterface) {
  const primary = await read($, primaryLanguage)
  const languages = primary === 'en' ? ['en'] : [primary, 'en']
  const lines = await Promise.all(
    languages.map(async language => `${languageName(language)} → ${(await voiceOf($, language)) ?? 'system voice'}`),
  )

  return `Voices: ${lines.join(', ')}. Run /dialogue setup to change them.`
}

async function restoreSettings($: EngineInterface) {
  const storedRate = await $.store.get(STORE_KEYS.rateIndex)
  if (typeof storedRate === 'number' && storedRate >= 0 && storedRate < RATES.length) {
    await update($, rateIndex, () => storedRate)
  }

  const storedChoices = await $.store.get(STORE_KEYS.voiceChoices)
  if (typeof storedChoices === 'object' && storedChoices !== null) {
    const choices = Object.fromEntries(
      Object.entries(storedChoices).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
    await update($, voiceChoices, () => choices)
  }

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
  return $.ui.open({ id: SETUP_PANE, title: 'Voice setup', focus: true, closeOnEscape: true, holdToasts: true })
}

async function playSample($: EngineInterface, voice: Voice) {
  await sample?.return({ code: null, signal: 'SIGTERM' })
  const stream = $.process.spawn(sampleCommand({ voice: voice.name, text: voice.sample || voice.name }))
  sample = stream
  void (async () => {
    for await (const _ of stream) {
      // say writes nothing worth reading
    }
  })().catch(() => undefined)
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

async function showLanguages($: EngineInterface) {
  await update($, setupView, () => 'languages')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dialogue', description: 'Hear replies as spoken dialogue: on | off | stop | setup' })
    await Promise.all([loadVoices($), restoreSettings($)])
    $.ui.status((await read($, isOn)) ? STATUS : undefined)

    return next(e)
  })

  on('command.run', { command: 'dialogue' }, async ($, e) => {
    switch (e.args.trim()) {
      case 'on':
        if (!canSpeak) return { text: NOT_AVAILABLE }
        await update($, isOn, () => true)
        $.ui.status(STATUS)
        return {
          text: `Dialogue on: replies end with spoken paragraphs you can rewind, pause and skip. ${await voicesSummary($)}`,
        }
      case 'off':
        await update($, isOn, () => false)
        await show($, null)
        $.ui.status(undefined)
        return { text: 'Dialogue off.' }
      case 'stop':
        await show($, null)
        return { text: 'Playback stopped.' }
      case 'setup': {
        await loadVoices($)
        if (!canSpeak) return { text: NOT_AVAILABLE }
        const opened = await openSetup($)
        return { text: opened.isPlaced ? 'Voice setup opened.' : `Voice setup could not open: ${opened.reason}` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed

    return {
      sections: [...composed.sections, { id: 'dialogue-box:spoken', text: SPOKEN_INSTRUCTION, scope: 'session' }],
    }
  })

  // Typing or dictation landing in the prompt means the person has started answering, and the microphone must not hear the voice.
  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    if (e.text.trim() !== '' && (await read($, dialog))?.status === 'playing') await apply($, pause)

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await show($, null).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !(await read($, isOn))) return result

    const spoken = extractSpoken(e.answer)
    if (spoken !== undefined && spoken.paragraphs.length > 0) {
      await discardRenders($)
      await show($, startDialog(spoken.paragraphs, spoken.language ?? (await read($, primaryLanguage))))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, dialog)
    if (current === null || e.props.hasSurvey) return next(e)

    const rate = RATES[await read($, rateIndex)] ?? 1
    const state = { playing: '', paused: ' · ⏸ paused', ended: ' · end' }[current.status]
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>
          🔊 {current.index + 1} / {current.paragraphs.length}
          <Text dimColor>
            {' '}
            · {rate}×{state}
          </Text>
        </Text>
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
          <Button key="stop" label="stop" hotkey="0" plain onPress={() => show($, null)} />
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

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>Main language: {languageName(primary)}</Text>
          <Button key="change-language" label="change" onPress={() => showLanguages($)} />
        </Box>
        {languages.map(language => {
          const chosen = resolveVoice(installedVoices, choices, language)
          const ranked = voicesFor(installedVoices, language).slice(0, VOICES_SHOWN_PER_LANGUAGE)

          return (
            <Box flexDirection="column">
              <Text bold>
                {languageName(language)}
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
        <Text dimColor>Tab or arrows move · Enter picks a voice · ▶ plays a sample · Esc closes</Text>
      </Box>
    )
  })
}
