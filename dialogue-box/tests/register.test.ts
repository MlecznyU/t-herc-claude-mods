import { expect, test } from 'claude-code/testing'

import { SPOKEN_INSTRUCTION, SPOKEN_OFF_INSTRUCTION } from '../hooks/speech'

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const ENGINE_SECTIONS = { sections: [{ id: 'intro', text: 'engine', scope: 'shared' }] } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

test('the system prompt gets the spoken section only while on', async ($, on) => {
  let isOn = false
  on('state.get', (_, e) => ({ value: { value: e.key === 'isOn' ? isOn : undefined, version: 1 } }))
  on('prompt.compose', () => ENGINE_SECTIONS)

  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro'])
  isOn = true
  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro', 'dialogue-box:spoken'])
})

test('turning it on and off tells the model through the command context', async ($, on) => {
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'say' ? 'Zosia (Enhanced)    pl_PL    # Witaj, nazywam się Zosia.' : 'pl_PL',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('store.get', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'dialogue' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const turnedOn = await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  expect(turnedOn.context).toEqual([SPOKEN_INSTRUCTION])
  expect(turnedOn.text).toContain('Polish → Zosia (Enhanced)')

  const turnedOff = await $.command.run({ command: 'dialogue', args: 'off', ...TYPED })
  expect(turnedOff.context).toEqual([SPOKEN_OFF_INSTRUCTION])
})
