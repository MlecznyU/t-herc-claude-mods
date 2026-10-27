import { expect, test } from 'claude-code/testing'

import {
  HISTORY_KEPT,
  isFromPerson,
  onArrive,
  onClose,
  onDismissAll,
  onNextReply,
  onPreviousReply,
} from '../hooks/arrivals'
import type { Screen } from '../hooks/arrivals'
import { startDialog } from '../hooks/dialog'

const playing = startDialog('t1', ['Pierwsza odpowiedź.', 'Drugi akapit.'], 'pl')
const notification = startDialog('t2', ['Agent w tle skończył.'], 'pl')
const reply = startDialog('t3', ['Odpowiedź na twoje pytanie.'], 'pl')
const ended = { ...playing, index: 1, status: 'ended' as const }

test('only the person at the terminal or through the bridge counts as the person', async () => {
  expect(isFromPerson({ kind: 'composer' })).toBe(true)
  expect(isFromPerson({ kind: 'bridge' })).toBe(true)
  expect(isFromPerson({ kind: 'task-notification' })).toBe(false)
  expect(isFromPerson({ kind: 'scheduled-trigger' })).toBe(false)
  expect(isFromPerson(undefined)).toBe(false)
})

test('a reply nobody asked for waits behind the one playing, in arrival order', async () => {
  const once = onArrive({ current: playing, queue: [], history: [] }, notification, false)
  const twice = onArrive(once, reply, false)

  expect(once).toEqual({ current: playing, queue: [notification], history: [] })
  expect(twice).toEqual({ current: playing, queue: [notification, reply], history: [] })
})

test('a paused dialog still holds its place', async () => {
  const paused = { ...playing, status: 'paused' as const }
  expect(onArrive({ current: paused, queue: [], history: [] }, notification, false).current).toBe(paused)
})

test('with nothing on screen, or the last one ended, the oldest waiting one plays', async () => {
  expect(onArrive({ current: null, queue: [], history: [] }, notification, false).current).toBe(notification)
  expect(onArrive({ current: ended, queue: [], history: [] }, notification, false)).toEqual({
    current: notification,
    queue: [],
    history: [ended],
  })
  expect(onArrive({ current: null, queue: [notification], history: [] }, reply, false).current).toBe(notification)
})

test('a reply to the person replaces what plays, drops what waits and keeps what was heard', async () => {
  expect(onArrive({ current: playing, queue: [notification], history: [] }, reply, true)).toEqual({
    current: reply,
    queue: [],
    history: [playing],
  })
})

test('an ended one stays on screen while nothing waits', async () => {
  const screen = { current: ended, queue: [], history: [] }
  expect(onClose(screen)).toBe(screen)
  expect(onClose({ current: playing, queue: [notification], history: [] }).current).toBe(playing)
})

test('the next reply moves the current one to history, or closes the box when nothing waits', async () => {
  expect(onNextReply({ current: playing, queue: [notification], history: [] })).toEqual({
    current: notification,
    queue: [],
    history: [playing],
  })
  expect(onNextReply({ current: playing, queue: [], history: [] })).toEqual({ current: null, queue: [], history: [playing] })
})

test('the previous reply plays from its start, and the next reply returns to where you were', async () => {
  const back = onPreviousReply({ current: notification, queue: [reply], history: [ended] })

  expect(back).toEqual({ current: { ...ended, index: 0, status: 'playing' }, queue: [notification, reply], history: [] })
  expect(onNextReply(back).current?.id).toBe('t2')
  expect(onPreviousReply({ current: playing, queue: [], history: [] }).current).toBe(playing)
})

test('dismissing clears the screen and the queue but keeps what was heard', async () => {
  expect(onDismissAll({ current: playing, queue: [notification], history: [] })).toEqual({
    current: null,
    queue: [],
    history: [playing],
  })
})

test('history keeps only the latest replies', async () => {
  let screen: Screen = { current: null, queue: [], history: [] }
  for (let turn = 0; turn < HISTORY_KEPT + 5; turn += 1) {
    screen = onArrive(screen, startDialog(`t${turn}`, ['x'], 'pl'), true)
  }

  expect(screen.history.length).toBe(HISTORY_KEPT)
  expect(screen.history.at(-1)?.id).toBe(`t${HISTORY_KEPT + 3}`)
})
