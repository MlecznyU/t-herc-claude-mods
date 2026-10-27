import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SPOKEN_OFF_INSTRUCTION, spokenInstruction } from '../hooks/speech'

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const ENGINE_SECTIONS = { sections: [{ id: 'intro', text: 'engine', scope: 'shared' }] } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const SAY_LISTING = 'Zosia (Enhanced)    pl_PL    # Witaj, nazywam się Zosia.'

type Hooks = Parameters<TestBody>[1]

function ran(stdout: string, exitCode = 0) {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

// A Mac with Zosia and no edge-tts unless `edge` is given; nothing stored from an earlier session.
function host(on: Hooks, edge?: string) {
  on('process.run', (_, e) => {
    if (e.argv[0] === 'say') return ran(SAY_LISTING)
    if (e.argv[0] === 'defaults') return ran('pl_PL')
    if (e.argv.join(' ').includes('command -v')) return edge === undefined ? ran('', 1) : ran(edge)
    return ran('', 1)
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'dialogue' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ENGINE_SECTIONS)
}

test('the system prompt gets the spoken section only while on', async ($, on) => {
  let isOn = false
  on('state.get', (_, e) => ({ value: { value: e.key === 'isOn' ? isOn : undefined, version: 1 } }))
  on('prompt.compose', () => ENGINE_SECTIONS)

  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro'])
  isOn = true
  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro', 'dialogue-box:spoken'])
})

test('turning it on and off tells the model through the command context, integrated by default', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const turnedOn = await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  expect(turnedOn.context).toEqual([spokenInstruction('integrated')])
  expect(turnedOn.text).toContain('Polish → Zosia (Enhanced)')

  const turnedOff = await $.command.run({ command: 'dialogue', args: 'off', ...TYPED })
  expect(turnedOff.context).toEqual([SPOKEN_OFF_INSTRUCTION])
})

test('a style switch reaches the model only while on, and the prompt follows it', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const whileOff = await $.command.run({ command: 'dialogue', args: 'style mirror', ...TYPED })
  expect(whileOff.context).toBe(undefined)

  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  const whileOn = await $.command.run({ command: 'dialogue', args: 'style integrated', ...TYPED })
  expect(whileOn.context).toEqual([spokenInstruction('integrated')])

  await $.command.run({ command: 'dialogue', args: 'style mirror', ...TYPED })
  const spoken = (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === 'dialogue-box:spoken')
  expect(spoken?.text).toBe(spokenInstruction('mirror'))
})

test('a session style survives the session starting again, as on a reload', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  await $.command.run({ command: 'dialogue', args: 'style mirror', ...TYPED })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const spoken = (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === 'dialogue-box:spoken')
  expect(spoken?.text).toBe(spokenInstruction('mirror'))
})

test('the Edge engine is refused with an install hint when edge-tts is missing', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'dialogue', args: 'engine edge', ...TYPED })).text).toContain('uv tool install edge-tts')
  expect((await $.command.run({ command: 'dialogue', args: 'engine mac', ...TYPED })).text).toContain('Mac voices only')
  expect((await $.command.run({ command: 'dialogue', args: 'style loud', ...TYPED })).text).toContain('Usage')
})

test('with edge-tts found, the Edge engine is accepted', async ($, on) => {
  host(on, '/Users/me/.local/bin/edge-tts\n')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'dialogue', args: 'engine edge', ...TYPED })).text).toContain('Edge neural voices')
})
