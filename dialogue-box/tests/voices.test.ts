import { expect, test } from 'claude-code/testing'

import {
  languagesWithVoices,
  needsBetterVoice,
  normalizeLanguage,
  parseVoices,
  resolveVoice,
  SYSTEM_VOICE,
  voicesFor,
} from '../hooks/voices'

const LISTING = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Ava (Premium)       en_US    # Hello! My name is Ava.',
  'Eddy (English (US)) en_US    # Hello! My name is Eddy.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Zosia               pl_PL    # Witaj, nazywam się Zosia.',
  'Zosia (Enhanced)    pl_PL    # Witaj, nazywam się Zosia.',
  'Anna                de_DE    # Hallo! Ich heiße Anna.',
  'Mónica              es_419   # ¡Hola! Me llamo Mónica.',
  'not a voice line',
].join('\n')

const voices = parseVoices(LISTING)

test('parses names with spaces and nested parentheses, locale, quality and sample', async () => {
  expect(voices).toHaveLength(8)
  expect(voices[2]).toEqual({
    name: 'Eddy (English (US))',
    language: 'en',
    locale: 'en_US',
    quality: 'compact',
    sample: 'Hello! My name is Eddy.',
  })
  expect(voices.map(voice => voice.quality)).toEqual([
    'novelty',
    'premium',
    'compact',
    'standard',
    'standard',
    'enhanced',
    'standard',
    'standard',
  ])
  expect(voices[7]?.language).toBe('es')
})

test('ranks a language best first and leaves novelty voices out', async () => {
  expect(voicesFor(voices, 'en').map(voice => voice.name)).toEqual(['Ava (Premium)', 'Samantha', 'Eddy (English (US))'])
  expect(languagesWithVoices(voices)).toEqual(['de', 'en', 'es', 'pl'])
})

test('a chosen voice wins while installed, else the best one, else the system voice', async () => {
  expect(resolveVoice(voices, { pl: 'Zosia' }, 'pl')).toBe('Zosia')
  expect(resolveVoice(voices, { pl: 'Removed Voice' }, 'pl')).toBe('Zosia (Enhanced)')
  expect(resolveVoice(voices, {}, 'fr')).toBe(undefined)
})

test('choosing the system voice leaves the voice out', async () => {
  expect(resolveVoice(voices, { en: SYSTEM_VOICE }, 'en')).toBe(undefined)
})

test('recommends a better voice when the best is below Enhanced', async () => {
  expect(needsBetterVoice(voices, 'pl')).toBe(false)
  expect(needsBetterVoice(voices, 'de')).toBe(true)
  expect(needsBetterVoice(voices, 'fr')).toBe(true)
})

test('normalizes language codes to their base language', async () => {
  expect(normalizeLanguage(' pl-PL ')).toBe('pl')
  expect(normalizeLanguage('en_US\n')).toBe('en')
})
