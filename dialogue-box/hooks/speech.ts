import type { Segment, Style } from '../types'
import { normalizeLanguage } from './voices'

export const RATES = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]
export const DEFAULT_RATE_INDEX = 2
const BASE_WORDS_PER_MINUTE = 185

export function wordsPerMinute(rateIndex: number): number {
  return Math.round(BASE_WORDS_PER_MINUTE * (RATES[rateIndex] ?? 1))
}

export const STYLES: readonly Style[] = ['integrated', 'mirror']
export const DEFAULT_STYLE: Style = 'integrated'

const SPOKEN_INTRO = `Voice mode is on (these rules replace any earlier voice-mode instructions in this conversation): the user hears the spoken part of every reply through text-to-speech, one paragraph at a time, and can skip, rewind or pause each paragraph.

End every reply with a block <spoken lang="xx">...</spoken> as its very last element, where xx is the language code of the spoken text (the language of the conversation).`

const SPOKEN_FORM = `- Never say a bare label (an option code, a question or ticket id, a field or identifier name): say what it means. Do not read out tables, numbers in bulk, file paths or code.
- Ask at most one question, the one decision you need, in the last paragraph; leave other questions in the written reply.
- Wrap every word or phrase in another language in <lang code="yy">...</lang>, for example: <spoken lang="pl">Sprawdziłem <lang code="en">pull request</lang> i testy przechodzą.</spoken>
- Plain sentences only: no markdown, no emoji, no bullet characters, no numbering.`

const STYLE_RULES: Record<Style, string> = {
  integrated: `Speech carries the conversation; the written reply is the shared board you point at, the way a colleague talks you through a diagram on a whiteboard.

What goes where:
- On the board only what is better seen than heard: tables, diagrams, code, file paths, commands, lists of options. Keep prose there to a line of context per item, and give every table, diagram and list a heading worth saying aloud.
- Never say what the board already shows, and never write out what you say. The reasoning, the trade-offs, your recommendation and the question live in speech.
- Refer to the board by name and place: "in the engines table, the second row…", "on the diagram, the fallback arrow…", "the command under Samples…".
- A reply with nothing worth seeing has no board: speech alone is the reply.

When to speak: in design discussions, reviews, explanations and decisions, speak as long as the reasoning needs, up to 6 paragraphs. In status turns (implementation progress, tooling, logs, build results) the board carries the result in full and speech says one short sentence on the outcome, or the block stays empty.

How to speak:
- Short paragraphs separated by a blank line: one point per paragraph, 2 to 4 sentences, spoken the way you would talk to a colleague across the desk.
${SPOKEN_FORM}`,
  mirror: `Most of the time the user reads along; sometimes they only listen without looking at the screen.

When to speak: in design discussions, reviews, explanations and decisions, speak fully. In status turns (implementation progress, tooling, logs, build results) say at most one short paragraph with the outcome, or leave the block empty when there is nothing worth hearing.

How to speak:
- Split it into short paragraphs separated by a blank line: one point or decision per paragraph, 2 to 3 sentences, at most 5 paragraphs.
- It must make sense without looking at the screen: say the substance first (the conclusion, the key caveat, the decision needed). Point to the written reply only as an extra at the end, never instead of the substance.
- Do not read out lists.
${SPOKEN_FORM}

The written reply above the block stays as complete as it would be without voice mode.`,
}

export function spokenInstruction(style: Style): string {
  return `${SPOKEN_INTRO}\n\n${STYLE_RULES[style]}`
}

export const SPOKEN_OFF_INSTRUCTION = 'Voice mode is off: stop ending replies with a <spoken> block.'

const SPOKEN_OPENING = /<spoken(?:\s+lang="([^"]*)")?\s*>/g
const SPOKEN_CLOSING = '</spoken>'
const LANGUAGE_INSERT = /<lang\s+code="([^"]*)"\s*>([\s\S]*?)<\/lang>/g

export type Spoken = { language: string | undefined; paragraphs: string[] }

// Only a block that ends the answer counts, opened by the nearest tag before its end: a reply that mentions the tags
// in its written part must not be read aloud from the mention.
export function extractSpoken(answer: string): Spoken | undefined {
  const trimmed = answer.trimEnd()
  if (!trimmed.endsWith(SPOKEN_CLOSING)) return undefined

  const end = trimmed.length - SPOKEN_CLOSING.length
  const opening = [...trimmed.slice(0, end).matchAll(SPOKEN_OPENING)].at(-1)
  if (opening === undefined) return undefined

  const code = opening[1]
  const text = trimmed.slice(opening.index + opening[0].length, end)
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(paragraph =>
      paragraph
        .replace(/`([^`]*)`/g, '$1')
        .replace(/[*_#|]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(paragraph => /\p{L}/u.test(displayText(paragraph)))
  const language = code === undefined || normalizeLanguage(code) === '' ? undefined : normalizeLanguage(code)

  return { language, paragraphs }
}

export function displayText(paragraph: string): string {
  return paragraph.replace(LANGUAGE_INSERT, '$2').replace(/\s+/g, ' ').trim()
}

export function splitSegments(paragraph: string, language: string): Segment[] {
  const pieces: Segment[] = []
  const append = (pieceLanguage: string, text: string) => {
    const last = pieces.at(-1)
    if (last !== undefined && last.language === pieceLanguage) last.text += text
    else pieces.push({ language: pieceLanguage, text })
  }

  let rest = 0
  for (const match of paragraph.matchAll(LANGUAGE_INSERT)) {
    append(language, paragraph.slice(rest, match.index))
    append(normalizeLanguage(match[1] ?? '') || language, ` ${match[2] ?? ''} `)
    rest = match.index + match[0].length
  }
  append(language, paragraph.slice(rest))

  return pieces
    .map(piece => ({ ...piece, text: piece.text.replace(/\s+/g, ' ').trim() }))
    .filter(piece => piece.text !== '')
}
