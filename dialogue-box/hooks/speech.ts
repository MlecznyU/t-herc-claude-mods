import type { Segment } from '../types'
import { normalizeLanguage } from './voices'

export const RATES = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]
export const DEFAULT_RATE_INDEX = 2
const BASE_WORDS_PER_MINUTE = 185

export function wordsPerMinute(rateIndex: number): number {
  return Math.round(BASE_WORDS_PER_MINUTE * (RATES[rateIndex] ?? 1))
}

export const SPOKEN_INSTRUCTION = `Voice mode is on: the user hears the spoken part of every reply through text-to-speech, one paragraph at a time, and can skip, rewind or pause each paragraph. Most of the time they read along; sometimes they only listen without looking at the screen.

End every reply with a block <spoken lang="xx">...</spoken> as its very last element, where xx is the language code of the spoken text (the language of the conversation).

When to speak: in design discussions, reviews, explanations and decisions, speak fully. In status turns (implementation progress, tooling, logs, build results) say at most one short paragraph with the outcome, or leave the block empty when there is nothing worth hearing.

How to speak:
- Split it into short paragraphs separated by a blank line: one point or decision per paragraph, 2 to 3 sentences, at most 5 paragraphs.
- It must make sense without looking at the screen: say the substance first (the conclusion, the key caveat, the decision needed). Point to the written reply only as an extra at the end, never instead of the substance.
- Never say a bare label (an option code, a question or ticket id, a field or identifier name): say what it means. Do not read out lists, tables, numbers in bulk, file paths or code.
- Ask at most one question, the one decision you need, in the last paragraph; leave other questions in the written reply.
- Wrap every word or phrase in another language in <lang code="yy">...</lang> so a voice for that language pronounces it, for example: <spoken lang="pl">Sprawdziłem <lang code="en">pull request</lang> i testy przechodzą.</spoken>
- Plain sentences only: no markdown, no emoji, no bullet characters, no numbering.

The written reply above the block stays as complete as it would be without voice mode.`

const SPOKEN_BLOCK = /<spoken(?:\s+lang="([^"]*)")?\s*>([\s\S]*?)<\/spoken>/g
const LANGUAGE_INSERT = /<lang\s+code="([^"]*)"\s*>([\s\S]*?)<\/lang>/g

export type Spoken = { language: string | undefined; paragraphs: string[] }

export function extractSpoken(answer: string): Spoken | undefined {
  const block = [...answer.matchAll(SPOKEN_BLOCK)].at(-1)
  if (block === undefined) return undefined

  const [, code, text = ''] = block
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(paragraph =>
      paragraph
        .replace(/`([^`]*)`/g, '$1')
        .replace(/[*_#|]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(paragraph => displayText(paragraph) !== '')
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
