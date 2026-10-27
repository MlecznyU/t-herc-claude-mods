import { expect, test } from 'claude-code/testing'

import { nextParagraph, pause, previousParagraph, startDialog, togglePause } from '../hooks/dialog'

const dialog = startDialog('turn-1', ['one', 'two', 'three'], 'pl')

test('starts playing the first paragraph', async () => {
  expect(dialog).toEqual({ id: 'turn-1', paragraphs: ['one', 'two', 'three'], index: 0, language: 'pl', status: 'playing' })
})

test('next moves on and ends on the last paragraph, keeping it shown', async () => {
  const second = nextParagraph(dialog)
  expect(second.index).toBe(1)

  const last = nextParagraph(nextParagraph(second))
  expect(last).toEqual({ ...dialog, index: 2, status: 'ended' })
})

test('previous goes back one and restarts the first', async () => {
  expect(previousParagraph({ ...dialog, index: 2, status: 'ended' })).toEqual({ ...dialog, index: 1, status: 'playing' })
  expect(previousParagraph(dialog)).toEqual(dialog)
})

test('pause stops only what plays, toggle resumes the same paragraph', async () => {
  const paused = pause({ ...dialog, index: 1 })
  expect(paused.status).toBe('paused')
  expect(pause({ ...dialog, status: 'ended' }).status).toBe('ended')
  expect(togglePause(paused)).toEqual({ ...dialog, index: 1, status: 'playing' })
  expect(togglePause({ ...dialog, status: 'ended' }).status).toBe('playing')
})
