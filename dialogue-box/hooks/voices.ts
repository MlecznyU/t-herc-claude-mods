import type { Voice, VoiceQuality } from '../types'

// One `say -v '?'` row: the name (it may hold spaces and nested parentheses), the locale, then `#` and a sample line.
const VOICE_LINE = /^(.+?)\s+([A-Za-z]{2,3})_([A-Za-z0-9]+)\s+#\s?(.*)$/
const NOVELTY_VOICES = new Set([
  'Albert',
  'Bad News',
  'Bahh',
  'Bells',
  'Boing',
  'Bubbles',
  'Cellos',
  'Fred',
  'Good News',
  'Jester',
  'Junior',
  'Kathy',
  'Organ',
  'Ralph',
  'Superstar',
  'Trinoids',
  'Whisper',
  'Wobble',
  'Zarvox',
])
const COMPACT_VOICE = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley) \(/
const QUALITY_RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, standard: 1, compact: 0, novelty: -1 }

export function normalizeLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

function qualityOf(name: string): VoiceQuality {
  if (name.includes('(Premium)')) return 'premium'
  if (name.includes('(Enhanced)')) return 'enhanced'
  if (NOVELTY_VOICES.has(name)) return 'novelty'
  if (COMPACT_VOICE.test(name)) return 'compact'
  return 'standard'
}

export function parseVoices(listing: string): Voice[] {
  return listing.split('\n').flatMap(line => {
    const match = VOICE_LINE.exec(line.trimEnd())
    if (match === null) return []

    const [, rawName = '', language = '', region = '', sample = ''] = match
    const name = rawName.trim()
    return [{ name, language: normalizeLanguage(language), locale: `${language}_${region}`, quality: qualityOf(name), sample: sample.trim() }]
  })
}

export function voicesFor(voices: Voice[], language: string): Voice[] {
  return voices
    .filter(voice => voice.language === language && voice.quality !== 'novelty')
    .sort((a, b) => QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || a.name.localeCompare(b.name))
}

// Siri voices are not addressable by `say -v`; the person reaches them only as the System Voice, by leaving the voice out.
export const SYSTEM_VOICE = 'system'

export function resolveVoice(voices: Voice[], choices: Record<string, string>, language: string): string | undefined {
  const chosen = choices[language]
  if (chosen === SYSTEM_VOICE) return undefined
  if (chosen !== undefined && voices.some(voice => voice.name === chosen)) return chosen

  return voicesFor(voices, language)[0]?.name
}

export function needsBetterVoice(voices: Voice[], language: string): boolean {
  const best = voicesFor(voices, language)[0]

  return best === undefined || QUALITY_RANK[best.quality] < QUALITY_RANK.enhanced
}

export function languagesWithVoices(voices: Voice[]): string[] {
  return [...new Set(voices.filter(voice => voice.quality !== 'novelty').map(voice => voice.language))].sort()
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export function recommendation(language: string): string {
  const name = languageName(language)

  return `For a natural ${name} voice, download an Enhanced or Premium one: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → ${name}. Then run /dialogue setup again.`
}
