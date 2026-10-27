import type { PromptOrigin } from 'claude-code'

import type { Dialog } from '../types'

// What is on screen, what waits and what was heard. Every decision about which dialog plays lives in this file, so
// another policy (asking first, say) replaces it without touching playback.
export type Screen = { current: Dialog | null; queue: Dialog[]; history: Dialog[] }

export const HISTORY_KEPT = 30

// The person's own message means they moved on: what is playing or waiting is no longer worth hearing.
export function isFromPerson(origin: PromptOrigin | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge'
}

function remember(history: Dialog[], dialog: Dialog | null): Dialog[] {
  return dialog === null ? history : [...history, dialog].slice(-HISTORY_KEPT)
}

function fromStart(dialog: Dialog): Dialog {
  return { ...dialog, index: 0, status: 'playing' }
}

function isIdle(current: Dialog | null): boolean {
  return current === null || current.status === 'ended'
}

// The person's message, /dialogue stop and /dialogue off; what was heard stays reachable.
export function onDismissAll(screen: Screen): Screen {
  return { current: null, queue: [], history: remember(screen.history, screen.current) }
}

// A reply to the person replaces everything; any other reply waits its turn behind the one playing.
export function onArrive(screen: Screen, incoming: Dialog, isReplyToPerson: boolean): Screen {
  if (isReplyToPerson) return { current: incoming, queue: [], history: remember(screen.history, screen.current) }

  return onClose({ ...screen, queue: [...screen.queue, incoming] })
}

// The dialog on screen reached its end: the oldest waiting one takes its place, else it stays to be gone back over.
export function onClose(screen: Screen): Screen {
  if (!isIdle(screen.current) || screen.queue.length === 0) return screen

  return onNextReply(screen)
}

export function onNextReply(screen: Screen): Screen {
  const [next, ...rest] = screen.queue

  return { current: next ?? null, queue: rest, history: remember(screen.history, screen.current) }
}

// The current one goes back to the front of the queue, so the next reply returns to it.
export function onPreviousReply(screen: Screen): Screen {
  const previous = screen.history.at(-1)
  if (previous === undefined) return screen

  return {
    current: fromStart(previous),
    queue: screen.current === null ? screen.queue : [fromStart(screen.current), ...screen.queue],
    history: screen.history.slice(0, -1),
  }
}
