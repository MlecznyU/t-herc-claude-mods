import { expect, test } from 'claude-code/testing'

import { liveCommand, renderArgv, sampleCommand } from '../hooks/player'

test('a live paragraph is spoken by say with its voice and rate', async () => {
  expect(liveCommand({ voice: 'Zosia (Enhanced)', text: 'Bez wstawek.' }, 185)).toEqual({
    argv: ['say', '-v', 'Zosia (Enhanced)', '-r', '185'],
    input: 'Bez wstawek.',
  })
  expect(liveCommand({ voice: undefined, text: 'Plain.' }, 200)).toEqual({ argv: ['say', '-r', '200'], input: 'Plain.' })
})

test('a sample plays at the voice own pace', async () => {
  expect(sampleCommand({ voice: 'Ava (Premium)', text: 'Hello' })).toEqual({ argv: ['say', '-v', 'Ava (Premium)'], input: 'Hello' })
})

test('a mixed paragraph is rendered from voice and text pairs, the system voice as empty', async () => {
  const argv = renderArgv(
    '/tmp/dialogue-box.x/1.aiff',
    [
      { voice: 'Zosia (Enhanced)', text: 'Zrobiłem' },
      { voice: undefined, text: 'pull request' },
    ],
    185,
  )

  expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(argv.slice(3)).toEqual(['dialogue-box', '/tmp/dialogue-box.x/1.aiff', '185', 'Zosia (Enhanced)', 'Zrobiłem', '', 'pull request'])
})
