import { expect, test } from 'claude-code/testing'

import {
  edgeRate,
  edgeRenderArgv,
  edgeVoicesFor,
  parseEdgeExecutable,
  parseEdgeVoices,
  resolveEdgeVoice,
  sampleText,
  shortName,
} from '../hooks/edge'

const LISTING = `Name                               Gender    ContentCategories      VoicePersonalities
---------------------------------  --------  ---------------------  --------------------------------------
en-US-AvaMultilingualNeural        Female    Conversation, Copilot  Expressive, Caring, Pleasant, Friendly
pl-PL-MarekNeural                  Male      General                Friendly, Positive
pl-PL-ZofiaNeural                  Female    General                Friendly, Positive
de-DE-KatjaNeural                  Female    General                Friendly, Positive
`

test('the voice list is read from the edge-tts table, header and rule left out', async () => {
  const voices = parseEdgeVoices(LISTING)

  expect(voices.map(voice => voice.name)).toEqual([
    'en-US-AvaMultilingualNeural',
    'pl-PL-MarekNeural',
    'pl-PL-ZofiaNeural',
    'de-DE-KatjaNeural',
  ])
  expect(voices[0]).toEqual({
    name: 'en-US-AvaMultilingualNeural',
    language: 'en',
    locale: 'en-US',
    gender: 'Female',
    personalities: 'Expressive, Caring, Pleasant, Friendly',
  })
  expect(shortName(voices[0]!)).toBe('AvaMultilingual')
})

test('a language lists its own voices, female first, then the multilingual ones', async () => {
  const voices = parseEdgeVoices(LISTING)

  expect(edgeVoicesFor(voices, 'pl').map(voice => voice.name)).toEqual([
    'pl-PL-ZofiaNeural',
    'pl-PL-MarekNeural',
    'en-US-AvaMultilingualNeural',
  ])
})

test('the chosen voice wins while it exists, else a voice of the language', async () => {
  const voices = parseEdgeVoices(LISTING)

  expect(resolveEdgeVoice(voices, {}, 'pl')).toBe('pl-PL-ZofiaNeural')
  expect(resolveEdgeVoice(voices, { pl: 'pl-PL-MarekNeural' }, 'pl')).toBe('pl-PL-MarekNeural')
  expect(resolveEdgeVoice(voices, { pl: 'pl-PL-GoneNeural' }, 'pl')).toBe('pl-PL-ZofiaNeural')
  expect(resolveEdgeVoice(voices, {}, 'cs')).toBe(undefined)
})

test('the rate is a signed percentage', async () => {
  expect(edgeRate(1)).toBe('+0%')
  expect(edgeRate(0.85)).toBe('-15%')
  expect(edgeRate(2)).toBe('+100%')
})

test('text starting with a dash stays one option value', async () => {
  const argv = edgeRenderArgv(['uvx', 'edge-tts'], '/tmp/x/1.mp3', 'pl-PL-ZofiaNeural', '- punkt pierwszy', 1.15)

  expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(argv.slice(3)).toEqual([
    'dialogue-box',
    'uvx',
    'edge-tts',
    '--voice=pl-PL-ZofiaNeural',
    '--rate=+15%',
    '--text=- punkt pierwszy',
    '--write-media=/tmp/x/1.mp3',
  ])
})

test('the executable is the argv prefix found, or nothing', async () => {
  expect(parseEdgeExecutable('/opt/homebrew/bin/uvx\nedge-tts\n')).toEqual(['/opt/homebrew/bin/uvx', 'edge-tts'])
  expect(parseEdgeExecutable('')).toBe(undefined)
})

test('a sample sentence in the language, English otherwise', async () => {
  expect(sampleText('pl')).toContain('pull request')
  expect(sampleText('cs')).toBe(sampleText('en'))
})
