import type { EdgeVoice } from '../types'
import { normalizeLanguage } from './voices'

// Prints the argv prefix that runs edge-tts, one item per line, or nothing: an installed edge-tts first, then uvx.
// The host PATH may miss ~/.local/bin, where `uv tool install` puts it.
export const FIND_EDGE = [
  '/bin/sh',
  '-c',
  'for c in edge-tts "$HOME/.local/bin/edge-tts"; do p=$(command -v "$c") && { echo "$p"; exit 0; }; done; for c in uvx "$HOME/.local/bin/uvx" /opt/homebrew/bin/uvx; do p=$(command -v "$c") && { echo "$p"; echo edge-tts; exit 0; }; done',
]

// edge-tts does not read the proxy from the environment, so it is passed on when one is set.
const RUN_EDGE = 'p=${HTTPS_PROXY:-$https_proxy}; if [ -n "$p" ]; then exec "$@" --proxy "$p"; else exec "$@"; fi'

export const EDGE_TIMEOUT_MS = 10_000

const SAMPLE_TEXTS: Record<string, string> = {
  en: 'I checked the pull request and every test passes. Shall we merge it?',
  pl: 'Sprawdziłem pull request i wszystkie testy przechodzą. Mergujemy?',
  de: 'Ich habe den Pull Request geprüft und alle Tests laufen durch. Sollen wir mergen?',
  fr: 'J’ai vérifié la pull request et tous les tests passent. On fusionne ?',
  es: 'Revisé el pull request y todas las pruebas pasan. ¿Lo fusionamos?',
}

export function sampleText(language: string): string {
  return SAMPLE_TEXTS[language] ?? SAMPLE_TEXTS.en ?? ''
}

export const EDGE_INSTALL_HINT = 'For Edge voices install edge-tts: uv tool install edge-tts (or pipx install edge-tts).'

export function parseEdgeExecutable(stdout: string): string[] | undefined {
  const argv = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')

  return argv.length > 0 ? argv : undefined
}

function edgeArgv(executable: string[], args: string[]): string[] {
  return ['/bin/sh', '-c', RUN_EDGE, 'dialogue-box', ...executable, ...args]
}

export function listEdgeVoicesArgv(executable: string[]): string[] {
  return edgeArgv(executable, ['--list-voices'])
}

export function edgeRate(rate: number): string {
  const percent = Math.round((rate - 1) * 100)

  return `${percent < 0 ? '-' : '+'}${Math.abs(percent)}%`
}

// Each value is joined to its option, so text that starts with a dash is not read as one.
export function edgeRenderArgv(executable: string[], out: string, voice: string, text: string, rate: number): string[] {
  return edgeArgv(executable, [`--voice=${voice}`, `--rate=${edgeRate(rate)}`, `--text=${text}`, `--write-media=${out}`])
}

const VOICE_ROW = /^([a-z]{2,3}-[A-Za-z0-9-]+?Neural)\s+(\S+)\s+(?:\S.*?\s{2,})?(\S.*?)?\s*$/

export function parseEdgeVoices(listing: string): EdgeVoice[] {
  return listing.split('\n').flatMap(line => {
    const match = VOICE_ROW.exec(line.trim())
    if (match === null) return []

    const [, name = '', gender = '', personalities = ''] = match
    const locale = name.split('-').slice(0, 2).join('-')
    return [{ name, language: normalizeLanguage(locale), locale, gender, personalities }]
  })
}

export function isMultilingual(voice: EdgeVoice): boolean {
  return voice.name.includes('Multilingual')
}

export function shortName(voice: EdgeVoice): string {
  return voice.name.split('-').slice(2).join('-').replace(/Neural$/, '')
}

// The language's own voices first, female before male, then the multilingual voices of other languages.
export function edgeVoicesFor(voices: EdgeVoice[], language: string): EdgeVoice[] {
  const own = voices
    .filter(voice => voice.language === language)
    .sort((a, b) => Number(b.gender === 'Female') - Number(a.gender === 'Female') || a.name.localeCompare(b.name))
  const multilingual = voices.filter(voice => voice.language !== language && isMultilingual(voice))

  return [...own, ...multilingual]
}

export function resolveEdgeVoice(voices: EdgeVoice[], choices: Record<string, string>, language: string): string | undefined {
  const chosen = choices[language]
  if (chosen !== undefined && voices.some(voice => voice.name === chosen)) return chosen

  return voices.find(voice => voice.language === language && voice.gender === 'Female')?.name ??
    voices.find(voice => voice.language === language)?.name
}
