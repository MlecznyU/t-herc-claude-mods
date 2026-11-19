import { expect, mock, test } from 'claude-code/testing'
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

// A Mac with Zosia and no edge-tts unless `edge` is given; nothing stored from an earlier session unless `stored` says.
function host(on: Hooks, edge?: string, stored: Record<string, unknown> = {}) {
  on('process.run', (_, e) => {
    if (e.argv[0] === 'say') return ran(SAY_LISTING)
    if (e.argv[0] === 'defaults') return ran('pl_PL')
    if (e.argv.join(' ').includes('command -v')) return edge === undefined ? ran('', 1) : ran(edge)
    return ran('', 1)
  })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
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

test('without the start-on setting a new session starts with dialogue off', async ($, on) => {
  host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['intro'])
})

test('with the start-on setting stored, a new session starts with dialogue on and the model is told', async ($, on) => {
  host(on, undefined, { startOn: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const spoken = (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === 'dialogue-box:spoken')
  expect(spoken?.text).toBe(spokenInstruction('integrated'))
})

test('a session started on hands the spoken instruction to the first prompt, as /dialogue on does, and only once', async ($, on) => {
  host(on, undefined, { startOn: true })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const first = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect('drop' in first ? undefined : first.context).toContain(spokenInstruction('integrated'))
  const second = await $.prompt.submit({ text: 'and again', wait: false, origin: { kind: 'composer' } })
  expect('drop' in second ? undefined : (second.context ?? [])).not.toContain(spokenInstruction('integrated'))
})

test('without the start-on setting no prompt gets the spoken instruction', async ($, on) => {
  host(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const first = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect('drop' in first ? undefined : (first.context ?? [])).not.toContain(spokenInstruction('integrated'))
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

const VOX_CHECK = {
  ready: true,
  setup_completed: true,
  version: '0.2.0',
  model: { present: true, size_bytes: 1_700_000_000, license_name: 'CC-BY-NC-4.0', license_url: 'https://x', commercial_use: false },
  settings: { voice: 'f3-bright', rate: 1.1, volume: 50 },
  features: ['owners', 'tags', 'warm', 'watch'],
}

// An Apple Silicon Mac with Zosia, voxlektor at /u/vxl answering `check`, no edge-tts; records every command run or
// spawned for voxlektor. Orders (`say`, `pause`, `resume`, `stop-reading`) are spawned (`watchChannel` hands them to
// the host) and exit with `orderExit` and `orderStderr`; `sayExits` gives the exit of each `say` by its index from 0.
// `stdin` records what each `say` read. `slowSay` holds every `say` from the `slowFrom`-th (default the second) until it
// resolves; a held `say` that is killed ends at once and is recorded in `killed`. `status` is what `vxl status --json`
// prints. `edge` adds edge-tts at /e/edge-tts with an empty voice list.
type VoxHostOptions = {
  orderExit?: number
  orderStderr?: string
  sayExits?: number[]
  stdin?: string[]
  slowSay?: Promise<void>
  slowFrom?: number
  killed?: string[][]
  // Several: one per `vxl status --json` call, the last repeated.
  status?: object | object[]
  // Exit and stderr of each control (pause, resume, stop-reading) by its index from 0; others as `orderExit`.
  controlFails?: Record<number, { code: number; stderr: string }>
  // `vxl warm` exits 2 with this on stderr.
  warmStderr?: string
  edge?: boolean
}

type OrderHost = (argv: string[], input: string | undefined, signal: AbortSignal) => Promise<{ code: number | null; stderr: string }>

// The order host of each test's `on`, for the `process.spawn` hook `watchChannel` registers.
const orderHosts = new WeakMap<Hooks, OrderHost>()
const ORDERS = ['say', 'pause', 'resume', 'stop-reading', 'skip', 'back']
const whenAborted = (signal: AbortSignal) =>
  new Promise<true>(resolve => (signal.aborted ? resolve(true) : signal.addEventListener('abort', () => resolve(true))))

function voxHost(on: Hooks, check: object, ran_: string[][], options: VoxHostOptions = {}) {
  let sayCount = 0
  let controlCount = 0
  let statusCount = 0
  const statusLine = () => {
    const all = Array.isArray(options.status) ? options.status : [options.status]
    return all[Math.min(statusCount++, all.length - 1)]
  }
  const orderExit = (index?: number) => (index === undefined ? undefined : options.sayExits?.[index]) ?? options.orderExit ?? 0
  orderHosts.set(on, async (argv, input, signal) => {
    ran_.push([...argv])
    if (argv[1] !== 'say') {
      const fails = options.controlFails?.[controlCount++]
      return fails === undefined ? { code: orderExit(), stderr: options.orderStderr ?? '' } : fails
    }

    options.stdin?.push(input ?? '')
    const index = sayCount++
    if (options.slowSay !== undefined && index + 1 >= (options.slowFrom ?? 2)) {
      const aborted = await Promise.race([options.slowSay.then(() => false), whenAborted(signal)])
      if (aborted) {
        options.killed?.push([...argv])
        return { code: null, stderr: '' }
      }
    }
    return { code: orderExit(index), stderr: orderExit(index) === 0 ? '' : options.orderStderr ?? '' }
  })
  on('process.run', async (_, e) => {
    ran_.push([...e.argv])
    if (e.argv[0] === 'say') return ran(SAY_LISTING)
    if (e.argv[0] === 'defaults') return ran('pl_PL')
    if (e.argv[0] === 'uname') return ran('arm64\n')
    if (e.argv.join(' ').includes('.local/bin/vxl')) return ran('vxl=/u/vxl\nuv=/u/uv\n')
    if (options.edge === true && e.argv.join(' ').includes('edge-tts "$HOME')) return ran('/e/edge-tts\n')
    if (e.argv.includes('/e/edge-tts')) return ran('')
    if (e.argv[0] === '/u/vxl' && e.argv[1] === 'setup') return ran(JSON.stringify(check))
    if (e.argv[0] === '/u/vxl' && e.argv[1] === 'warm') {
      return options.warmStderr === undefined ? ran('') : { value: { ...ran('', 2).value, stderr: options.warmStderr } }
    }
    if (e.argv[0] === '/u/vxl' && e.argv[1] === 'status') {
      const line = statusLine()
      return line === undefined ? ran('', 1) : ran(JSON.stringify(line))
    }
    // The session end and the pane's sample stop still run their stop directly.
    if (e.argv[0] === '/u/vxl' && ORDERS.includes(e.argv[1] ?? '')) return ran('', options.orderExit ?? 0)
    return ran('', 1)
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'dialogue' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ENGINE_SECTIONS)
}

const warmed = (commands: string[][]) => commands.some(argv => argv.join(' ') === '/u/vxl warm')

test('with voxlektor ready and no stored choice it is the engine, and turning on warms it', async ($, on) => {
  const commands: string[][] = []
  voxHost(on, VOX_CHECK, commands)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(warmed(commands)).toBe(false)

  const turnedOn = await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  expect(turnedOn.text).toContain('voxlektor voice f3-bright')
  expect(warmed(commands)).toBe(true)
})

test('the voxlektor engine is refused until voxlektor is ready, and nothing warms', async ($, on) => {
  const commands: string[][] = []
  voxHost(on, { ...VOX_CHECK, ready: false, model: { ...VOX_CHECK.model, present: false } }, commands)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const engine = await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  expect(engine.text).toBe('voxlektor is not ready: open /dialogue setup.')
  const turnedOn = await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  expect(turnedOn.text).toContain('Mac voices')
  expect(warmed(commands)).toBe(false)
})

test('choosing voxlektor for the session warms it only while dialogue is on', async ($, on) => {
  const commands: string[][] = []
  voxHost(on, VOX_CHECK, commands)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const engine = await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  expect(engine.text).toContain('Engine for this session: voxlektor')
  expect(warmed(commands)).toBe(false)

  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  await $.command.run({ command: 'dialogue', args: 'engine mac', ...TYPED })
  commands.length = 0
  await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  expect(warmed(commands)).toBe(true)
})

const PANE = {
  title: 'Voice setup',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 200 },
  view: {},
} as const

// Records every spawned argv; the child writes `output` on stderr and exits with `code`.
function spawns(on: Hooks, spawned: string[][], output: string[] = [], code: number | null = 0) {
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    for (const text of output) yield { stream: 'stderr' as const, text }
    return { value: { code, signal: code === null ? 'SIGTERM' : null } }
  })
}

// A step runs in the background after its press returns; each read of the pane lets it go on until it shows.
// Each try also yields a macrotask, so work the host runs outside the microtask queue goes on too.
const timers = globalThis as unknown as { setTimeout: (callback: () => void, ms: number) => unknown }
async function until(done: () => Promise<boolean>) {
  for (let i = 0; i < 200 && !(await done()); i++) await new Promise<void>(resolve => timers.setTimeout(resolve, 0))
}

async function openPane($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'dialogue', args: 'setup', ...TYPED })

  return $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'dialogue-box-setup' })
}

test('ready: the pane shows the voice values, the tune command and plays a preempting sample', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, VOX_CHECK, commands)
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'abc' }))
  const pane = await openPane($)

  expect(await pane.find({ text: /Voice f3-bright · rate 1\.1 · volume 50/ })).toBeDefined()
  expect(await pane.find({ text: 'Tune it in a terminal: vxl setup' })).toBeDefined()
  await pane.press({ key: 'vox-sample' })
  const sample = spawned.find(argv => argv[1] === 'say')
  expect(sample?.[0]).toBe('/u/vxl')
  expect(sample).toContain('--now')
  expect(sample).toContain('--preempt')
})

test('a missing model shows its license; nothing runs until Accept, and a failed download shows its tail and the command', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK, ready: false, model: { ...VOX_CHECK.model, present: false } }, commands)
  spawns(on, spawned, ['Downloading…\n', 'boom: no network\n'], 1)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  expect(await pane.find({ text: 'CC-BY-NC-4.0 · non-commercial use only · 1.7 GB · https://x' })).toBeDefined()
  expect(await pane.find({ text: 'Command: vxl setup --yes --accept-model-license' })).toBeDefined()
  expect(spawned).toEqual([])

  await pane.press({ key: 'vox-step-download' })
  await until(async () => (await pane.find({ text: /failed/ })) !== undefined)
  expect(spawned).toEqual([['/u/vxl', 'setup', '--yes', '--accept-model-license']])
  expect(await pane.find({ text: /Accept & download failed \(exit 1\)[\s\S]*boom: no network/ })).toBeDefined()
  expect(await pane.find({ text: 'Run this in a terminal: vxl setup --yes --accept-model-license' })).toBeDefined()
})

test('an old voxlektor offers the pinned reinstall, or only shows the command', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK, version: '0.1.0' }, commands)
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)
  const command = 'uv tool install --reinstall git+https://github.com/MlecznyU/voxlektor@v0.4.0'

  expect(await pane.find({ text: /This voxlektor \(0\.1\.0\) lacks what dialogue-box needs \(version 0\.2\.0 or newer\); updating installs v0\.4\.0/ })).toBeDefined()
  expect(await pane.find({ text: /too old/ })).toBeUndefined()
  expect(await pane.find({ text: `Command: ${command}` })).toBeDefined()
  await pane.press({ key: 'vox-show-command' })
  expect(await pane.find({ text: `Run this in a terminal: ${command}` })).toBeDefined()
  expect(spawned).toEqual([])
})

test('a voxlektor newer than the range offers no reinstall, says dialogue-box needs the update, and readings fall back', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK, version: '1.0.0' }, commands)
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  expect(await pane.find({ text: /This voxlektor \(1\.0\.0\) is newer than this dialogue-box supports/ })).toBeDefined()
  expect(await pane.find({ text: /^Command:/ })).toBeUndefined()
  expect(await pane.find({ text: /Update voxlektor|Install voxlektor/ })).toBeUndefined()
  const engine = await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  expect(engine.text).toBe('voxlektor 1.0.0 is newer than this dialogue-box supports: update dialogue-box.')
  expect(commands.some(argv => argv.join(' ').includes('tool install'))).toBe(false)
})

test('an install past the pinned tag that lacks a feature is never offered a downgrade', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK, version: '0.4.1', features: ['owners', 'tags', 'watch'] }, commands)
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  expect(await pane.find({ text: /This voxlektor \(0\.4\.1\) is newer than v0\.4\.0 but lacks what dialogue-box needs \(warm\)/ })).toBeDefined()
  expect(await pane.find({ text: /^Command:/ })).toBeUndefined()
  expect(await pane.find({ text: /Update voxlektor/ })).toBeUndefined()
  expect(await pane.find({ key: 'vox-check-again' })).toBeDefined()
})

const VOX_CHECK_030 = {
  ...VOX_CHECK,
  version: '0.3.0',
  protocol: 1,
  profile: 'claude',
  profile_exists: true,
  settings: { ...VOX_CHECK.settings, steps: 8 },
  features: ['owners', 'profiles', 'steps', 'tags', 'warm', 'watch'],
}

test('with voxlektor 0.3.0 the pane shows the claude profile\'s settings with its steps and how to tune them', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, VOX_CHECK_030, commands)
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  expect(commands).toContainEqual(['/u/vxl', 'setup', '--check', '--profile=claude'])
  expect(await pane.find({ text: 'Voice f3-bright · rate 1.1 · volume 50 · steps 8' })).toBeDefined()
  expect(await pane.find({ text: 'Tune it in a terminal: vxl setup --profile claude' })).toBeDefined()
})

test('a missing model with profiles is downloaded and the claude profile created in one run; a usage error shows its exit', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK_030, ready: false, profile_exists: false, model: { ...VOX_CHECK.model, present: false } }, commands)
  // A usage error prints no JSON line, only its message: the exit code is what counts.
  spawns(on, spawned, ['Error: Invalid value for --progress\n'], 1)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  await pane.press({ key: 'vox-step-download' })
  await until(async () => (await pane.find({ text: /failed/ })) !== undefined)
  expect(spawned).toEqual([['/u/vxl', 'setup', '--yes', '--profile=claude', '--progress=json', '--accept-model-license']])
  expect(await pane.find({ text: /Accept & download failed \(exit 1\)[\s\S]*Invalid value for --progress/ })).toBeDefined()
})

const HUNG = { running: true, answering: false, pid: 10368, protocol: 1 }

test('a daemon that holds the lock without answering is named in the pane once a second status 3 s later agrees', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, VOX_CHECK, commands, { status: HUNG })
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  const statuses = () => commands.filter(argv => argv.join(' ') === '/u/vxl status --json').length
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await pane.find({ text: /not answering/ })).toBeUndefined()
  const asked = statuses()
  await clock.advance(3_000)
  for (let i = 0; i < 20 && (await pane.find({ text: /not answering/ })) === undefined; i++) await clock.settle()
  expect(await pane.find({ text: 'voxlektor is not answering (pid 10368): run vxl stop' })).toBeDefined()
  // Each refresh (session start, pane open) asked once, then once more 3 s later.
  expect(statuses()).toBe(asked * 2)
})

test('a daemon still starting (not answering for a moment) is never named as stuck in the pane', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, VOX_CHECK, commands, { status: [HUNG, { running: true, state: 'LOADING', protocol: 1 }] })
  spawns(on, spawned)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  for (let i = 0; i < 20; i++) await clock.settle()
  await clock.advance(3_000)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await pane.find({ text: /not answering/ })).toBeUndefined()
})

test('voxlektor 0.3.0 and 0.9.5 are spoken to', async ($, on) => {
  const commands: string[][] = []
  voxHost(on, { ...VOX_CHECK, version: '0.9.5' }, commands)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })).text).toContain('Engine for this session: voxlektor')
})

test('a step that was killed says it was stopped, not exit null', async ($, on) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  voxHost(on, { ...VOX_CHECK, ready: false, model: { ...VOX_CHECK.model, present: false } }, commands)
  spawns(on, spawned, ['Downloading…\n'], null)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const pane = await openPane($)

  await pane.press({ key: 'vox-step-download' })
  await until(async () => (await pane.find({ text: /was stopped/ })) !== undefined)
  expect(await pane.find({ text: /Accept & download was stopped:/ })).toBeDefined()
  expect(await pane.find({ text: /exit null/ })).toBeUndefined()
})

test('with voxlektor as the engine, the Edge voice list loads at start so a fallback can use Edge', async ($, on) => {
  const commands: string[][] = []
  voxHost(on, VOX_CHECK, commands, { edge: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await until(async () => commands.some(argv => argv.includes('--list-voices')))
  expect(commands.some(argv => argv.includes('/e/edge-tts') && argv.includes('--list-voices'))).toBe(true)
})

test('with edge-tts found, the Edge engine is accepted', async ($, on) => {
  host(on, '/Users/me/.local/bin/edge-tts\n')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'dialogue', args: 'engine edge', ...TYPED })).text).toContain('Edge neural voices')
})

// The test's `vxl watch`: what `send` writes comes out of the watcher's stdout; `end` makes it exit with 2. A voxlektor
// order goes to the `voxHost` of this `on`. Every other spawn (a Mac or Edge player) is recorded in `players` and ends
// at once, or with `holdPlayers` plays until it is stopped.
function watchChannel(on: Hooks, options: { holdPlayers?: boolean } = {}) {
  const lines: (string | null)[] = []
  let wake: (() => void) | undefined
  const watches: string[][] = []
  const players: string[][] = []
  const killed = { watches: 0 }
  on('process.spawn', async function* (_, e, next) {
    const order = orderHosts.get(on)
    if (order !== undefined && e.argv[0] === '/u/vxl' && ORDERS.includes(e.argv[1] ?? '')) {
      const { code, stderr } = await order([...e.argv], e.input, next.signal)
      if (stderr !== '') yield { stream: 'stderr' as const, text: stderr }
      return { value: { code, signal: code === null ? 'SIGTERM' : null } }
    }
    if (e.argv[1] !== 'watch') {
      players.push([...e.argv])
      if (options.holdPlayers === true) {
        await whenAborted(next.signal)
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      return { value: { code: 0, signal: null } }
    }
    watches.push([...e.argv])
    next.signal.addEventListener('abort', () => wake?.())
    for (;;) {
      while (lines.length === 0 && !next.signal.aborted) await new Promise<void>(resolve => (wake = resolve))
      if (next.signal.aborted) {
        killed.watches += 1
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      const line = lines.shift()
      if (line === null || line === undefined) return { value: { code: 2, signal: null } }
      yield { stream: 'stdout' as const, text: `${line}\n` }
    }
  })
  const push = (line: string | null) => {
    lines.push(line)
    wake?.()
  }

  return { watches, players, killed, send: (event: object) => push(JSON.stringify(event)), end: () => push(null) }
}

const BAND = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const
const END = { reason: 'other', sessionId: 'abc', resume: { id: 'abc' } } as const
const SPOKEN = '<spoken lang="pl">Jeden akapit.\n\nDrugi akapit.\n\nTrzeci akapit.</spoken>'
const OWNER_FLAG = '--owner=dlg-abc'

// Orders go out in the background; with `commands`, waits until the whole reply is queued.
async function startReading($: Parameters<TestBody>[0], commands?: string[][], answer = SPOKEN, paragraphs = 3) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  await $.turn.complete({ turnId: 't1', answer, durationMs: 1, isAborted: false, reason: 'answer' })
  if (commands !== undefined) await until(async () => says(commands).length >= paragraphs)
}

function voxReadingHost(on: Hooks, commands: string[][], options: VoxHostOptions = {}, check: object = VOX_CHECK) {
  voxHost(on, check, commands, options)
  on('session.id', () => ({ value: 'abc' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  return toasts
}

const says = (commands: string[][]) => commands.filter(argv => argv[0] === '/u/vxl' && argv[1] === 'say')

test('a reply read through voxlektor is queued whole under this session\'s owner, and no local player runs', async ($, on) => {
  const commands: string[][] = []
  const stdin: string[] = []
  voxReadingHost(on, commands, { stdin })
  const watch = watchChannel(on)
  await startReading($, commands)

  const sent = says(commands)
  expect(sent).toHaveLength(3)
  expect(sent.map(argv => argv.includes('--now'))).toEqual([true, false, false])
  expect(sent.every(argv => argv.includes(OWNER_FLAG) && !argv.includes('--preempt'))).toBe(true)
  expect(stdin).toEqual(['Jeden akapit.', 'Drugi akapit.', 'Trzeci akapit.'])
  expect(watch.watches).toEqual([['/u/vxl', 'watch', '--json', OWNER_FLAG]])
  expect(watch.players).toEqual([])
  await $.session.end(END)
})

test('the watcher moves the box with voxlektor and never sends orders for it', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const before = commands.length
  const tag1 = says(commands)[1]?.find(arg => arg.startsWith('--tag='))?.slice('--tag='.length)

  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tag1 })
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)
  expect(await band.find({ text: /🔊 2 \/ 3/ })).toBeDefined()
  expect(commands.length).toBe(before)
  await $.session.end(END)
})

test('waiting behind another session shows on the box, and play now takes the floor from the paragraph on screen', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  watch.send({ event: 'waiting', owner: 'dlg-abc', group: 't1', position: 2 })
  await until(async () => (await band.find({ text: /waiting/ })) !== undefined)
  expect(await band.find({ text: '🕒 waiting · another session is speaking (2 ahead)' })).toBeDefined()

  commands.length = 0
  await band.press({ key: 'play-now' })
  await until(async () => says(commands).length >= 3)
  const sent = says(commands)
  expect(sent).toHaveLength(3)
  expect(sent[0]).toContain('--now')
  expect(sent[0]).toContain('--preempt')
  expect(sent.slice(1).some(argv => argv.includes('--preempt'))).toBe(false)
  await $.session.end(END)
})

test('pause, resume and stop act on this session only', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  commands.length = 0
  await band.press({ key: 'pause' })
  await band.press({ key: 'pause' })
  await $.command.run({ command: 'dialogue', args: 'stop', ...TYPED })
  await until(async () => commands.filter(argv => argv[0] === '/u/vxl').length >= 3)
  expect(commands.filter(argv => argv[0] === '/u/vxl')).toEqual([
    ['/u/vxl', 'pause', OWNER_FLAG],
    ['/u/vxl', 'resume', OWNER_FLAG],
    ['/u/vxl', 'stop-reading', OWNER_FLAG],
  ])
  await $.session.end(END)
})

test('a failed say falls back once with a toast, and the next reply tries voxlektor again', async ($, on) => {
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands, { orderExit: 1 })
  const watch = watchChannel(on)
  await startReading($)
  await until(async () => watch.players.length > 0)

  expect(says(commands)).toHaveLength(1)
  expect(commands.some(argv => argv[1] === 'stop-reading' && argv.includes(OWNER_FLAG))).toBe(true)
  expect(toasts.filter(text => text.startsWith('Mac voice: voxlektor failed (say exited 1'))).toHaveLength(1)
  await until(async () => watch.players.length > 0)
  expect(watch.players[0]?.[0]).toBe('say')

  await $.command.run({ command: 'dialogue', args: 'stop', ...TYPED })
  commands.length = 0
  await $.turn.complete({ turnId: 't2', answer: SPOKEN, durationMs: 1, isAborted: false, reason: 'answer' })
  await until(async () => toasts.length > 1 || watch.players.length > 1)
  expect(says(commands)).toHaveLength(1)
  await $.session.end(END)
})

test('a watcher that goes away mid-reply hands the reply to the fallback and is respawned', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)

  watch.send({ event: 'disconnected' })
  watch.end()
  for (let i = 0; i < 20 && !toasts.some(text => text.includes('the daemon went away')); i++) await clock.settle()
  expect(toasts).toContain('Mac voice: voxlektor failed (the daemon went away), so a Mac voice reads the rest of this reply.')
  expect(commands.some(argv => argv[1] === 'stop-reading' && argv.includes(OWNER_FLAG))).toBe(true)
  expect(watch.watches).toHaveLength(1)
  await clock.advance(600)
  expect(watch.watches).toHaveLength(2)
  await $.session.end(END)
})

test('the session end stops the watcher and this session\'s reading', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  watchChannel(on)
  await startReading($, commands)

  commands.length = 0
  await $.session.end(END)
  expect(commands).toEqual([['/u/vxl', 'stop-reading', OWNER_FLAG]])
})

test('the Edge and Mac engines never talk to voxlektor', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  await $.command.run({ command: 'dialogue', args: 'engine mac', ...TYPED })
  commands.length = 0
  await $.turn.complete({ turnId: 't1', answer: SPOKEN, durationMs: 1, isAborted: false, reason: 'answer' })

  await until(async () => watch.players.length > 0)
  expect(watch.players[0]?.[0]).toBe('say')
  expect(commands.filter(argv => argv[0] === '/u/vxl')).toEqual([])
  await $.session.end(END)
})

test('a paragraph stopped from the keyboard ends the box when no disconnect follows', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tag0 = says(commands)[0]?.find(arg => arg.startsWith('--tag='))?.slice('--tag='.length)

  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tag0, reason: 'stopped' })
  for (let i = 0; i < 10; i++) await clock.settle()
  expect(await band.find({ text: /· end/ })).toBeUndefined()
  await clock.advance(1_100)
  expect(await band.find({ text: /· end/ })).toBeDefined()
  await $.session.end(END)
})

test('a stop followed by a disconnect is a failure, not an end', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const tag0 = says(commands)[0]?.find(arg => arg.startsWith('--tag='))?.slice('--tag='.length)

  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tag0, reason: 'stopped' })
  watch.send({ event: 'disconnected' })
  for (let i = 0; i < 20 && toasts.length === 0; i++) await clock.settle()
  await clock.advance(1_100)
  expect(toasts.some(text => text.includes('the daemon went away'))).toBe(true)
  await $.session.end(END)
})

const tagOf = (argv: string[]) => argv.find(arg => arg.startsWith('--tag='))?.slice('--tag='.length)

test('a long reply is queued without holding the box: a pause goes out before the paragraphs still to queue', async ($, on) => {
  let release: () => void = () => undefined
  const slowSay = new Promise<void>(resolve => (release = resolve))
  const commands: string[][] = []
  voxReadingHost(on, commands, { slowSay })
  watchChannel(on)
  // The reply arrives and the turn completes although the second `say` has not returned.
  await startReading($)
  await until(async () => says(commands).length === 2)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'pause' })
  release()
  await until(async () => says(commands).length === 3)
  const orders = commands.filter(argv => argv[0] === '/u/vxl' && ['say', 'pause'].includes(argv[1] ?? '')).map(argv => argv[1])
  expect(orders).toEqual(['say', 'say', 'pause', 'say'])
  await $.session.end(END)
})

test('a skip while a reply is still being queued drops what was left of the replaced reading', async ($, on) => {
  let release: () => void = () => undefined
  const slowSay = new Promise<void>(resolve => (release = resolve))
  const commands: string[][] = []
  voxReadingHost(on, commands, { slowSay })
  watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 2)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'skip' })
  release()
  await until(async () => says(commands).some(argv => tagOf(argv) === 't1:2:2'))
  expect(says(commands).map(tagOf)).toEqual(['t1:1:0', 't1:1:1', 't1:2:1', 't1:2:2'])
  await $.session.end(END)
})

test('switching engine mid-reply hands the paragraph on screen to the new engine and stops the watcher', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  await until(async () => says(commands).length === 3)

  commands.length = 0
  await $.command.run({ command: 'dialogue', args: 'engine mac', ...TYPED })
  expect(commands).toContainEqual(['/u/vxl', 'stop-reading', OWNER_FLAG])
  await until(async () => watch.players.length > 0 && watch.killed.watches > 0)
  expect(watch.players[0]?.[0]).toBe('say')
  expect(watch.killed.watches).toBe(1)
  await $.session.end(END)
})

test('a watcher that only ever says disconnected backs off instead of respawning every half second', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)

  watch.send({ event: 'disconnected' })
  watch.end()
  for (let i = 0; i < 20; i++) await clock.settle()
  await clock.advance(600)
  expect(watch.watches).toHaveLength(2)

  watch.send({ event: 'disconnected' })
  watch.end()
  for (let i = 0; i < 20; i++) await clock.settle()
  await clock.advance(600)
  expect(watch.watches).toHaveLength(2)
  await clock.advance(500)
  expect(watch.watches).toHaveLength(3)
  await $.session.end(END)
})

test('a hold from outside while this session plays offers resume, which sends the owner resume', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  watch.send({ event: 'paused', owner: null })
  await until(async () => (await band.find({ text: /held/ })) !== undefined)
  expect((await band.find({ key: 'pause' }))?.text).toBe('resume')
  commands.length = 0
  await band.press({ key: 'pause' })
  await until(async () => commands.length > 0)
  expect(commands.filter(argv => argv[0] === '/u/vxl')).toEqual([['/u/vxl', 'resume', OWNER_FLAG]])
  await $.session.end(END)
})

test('a watcher snapshot of another protocol version hands the reply to the fallback and marks voxlektor too new', async ($, on) => {
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)

  watch.send({ event: 'snapshot', protocol: 2, state: 'WARM', floor: null, groups: [], version: '0.2.0' })
  await until(async () => watch.players.length > 0)
  expect(toasts).toContain(
    'Mac voice: voxlektor failed (voxlektor speaks protocol v2, newer than this dialogue-box supports), so a Mac voice reads the rest of this reply.',
  )
  const engine = await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })
  expect(engine.text).toContain('newer than this dialogue-box supports')
  await $.session.end(END)
})

const orderNames = (commands: string[][]) =>
  commands.filter(argv => argv[0] === '/u/vxl' && ORDERS.includes(argv[1] ?? '')).map(argv => argv[1])

test('stop never waits behind a say in flight: the say is killed, the stop goes out, and nothing falls back', async ($, on) => {
  const held = new Promise<void>(() => undefined)
  const commands: string[][] = []
  const killed: string[][] = []
  const toasts = voxReadingHost(on, commands, { slowSay: held, slowFrom: 1, killed })
  const watch = watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'stop' })
  await until(async () => orderNames(commands).includes('stop-reading'))
  expect(killed).toHaveLength(1)
  expect(orderNames(commands)).toEqual(['say', 'stop-reading'])
  // Nothing of the reply is sent after the stop, and the person hears no fallback.
  await until(async () => says(commands).length > 1 || toasts.length > 0)
  expect(says(commands)).toHaveLength(1)
  expect(toasts).toEqual([])
  expect(watch.players).toEqual([])
  await $.session.end(END)
})

test('a pause while the say that starts the reading is on its way goes out at once, and again once that say lands', async ($, on) => {
  let release: () => void = () => undefined
  const slowSay = new Promise<void>(resolve => (release = resolve))
  const commands: string[][] = []
  voxReadingHost(on, commands, { slowSay, slowFrom: 1 })
  watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'pause' })
  await until(async () => orderNames(commands).includes('pause'))
  expect(orderNames(commands)).toEqual(['say', 'pause'])
  // The `now` lifts the owner's pause when it lands, so the pause follows it before the rest is appended.
  release()
  await until(async () => says(commands).length === 3)
  expect(orderNames(commands)).toEqual(['say', 'pause', 'pause', 'say', 'say'])
  await $.session.end(END)
})

const NOT_RUNNING = { code: 2, stderr: 'voxlektor is not running\n' }

test('a pause during a cold start that finds no daemon yet hands nothing to the fallback, and the pause follows the now', async ($, on) => {
  let release: () => void = () => undefined
  const slowSay = new Promise<void>(resolve => (release = resolve))
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands, { slowSay, slowFrom: 1, controlFails: { 0: NOT_RUNNING }, status: HUNG })
  const watch = watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  const statuses = () => commands.filter(argv => argv[0] === '/u/vxl' && argv[1] === 'status').length
  const statusesBefore = statuses()

  await band.press({ key: 'pause' })
  await until(async () => orderNames(commands).includes('pause'))
  release()
  await until(async () => says(commands).length === 3)
  expect(orderNames(commands)).toEqual(['say', 'pause', 'pause', 'say', 'say'])
  expect(toasts).toEqual([])
  expect(watch.players).toEqual([])
  // "not running" is no hang: the status is not even asked.
  expect(statuses()).toBe(statusesBefore)
  await $.session.end(END)
})

test('stop during a cold start that finds no daemon yet is no failure: no toast, no fallback', async ($, on) => {
  const commands: string[][] = []
  const killed: string[][] = []
  const toasts = voxReadingHost(on, commands, {
    slowSay: new Promise<void>(() => undefined),
    slowFrom: 1,
    killed,
    controlFails: { 0: NOT_RUNNING },
    status: HUNG,
  })
  const watch = watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'stop' })
  await until(async () => orderNames(commands).includes('stop-reading'))
  await until(async () => toasts.length > 0 || watch.players.length > 0)
  expect(toasts).toEqual([])
  expect(watch.players).toEqual([])
  await $.session.end(END)
})

test('the session end stops voxlektor even when the stop of an engine switch had not gone out yet', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  watchChannel(on)
  await startReading($, commands)
  await $.command.run({ command: 'dialogue', args: 'engine mac', ...TYPED })

  commands.length = 0
  await $.session.end(END)
  expect(commands).toEqual([['/u/vxl', 'stop-reading', OWNER_FLAG]])
})

test('a say that never returns is given up after 20 s, and a daemon that does not answer is named on the box', async ($, on) => {
  const clock = mock.clock(on)
  const commands: string[][] = []
  const killed: string[][] = []
  const status = { running: true, answering: false, pid: 10368, protocol: 1 }
  const toasts = voxReadingHost(on, commands, { slowSay: new Promise<void>(() => undefined), slowFrom: 1, killed, status })
  const watch = watchChannel(on)
  await startReading($)
  for (let i = 0; i < 20 && says(commands).length === 0; i++) await clock.settle()
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await clock.advance(19_000)
  expect(killed).toEqual([])
  await clock.advance(1_000)
  for (let i = 0; i < 40 && toasts.length === 0; i++) await clock.settle()
  expect(killed).toHaveLength(1)
  const notice = 'Mac voice: voxlektor is not answering (pid 10368): run vxl stop. A Mac voice reads the rest of this reply.'
  expect(toasts).toEqual([notice])
  expect(await band.find({ text: `⚠ ${notice}` })).toBeDefined()
  for (let i = 0; i < 20 && watch.players.length === 0; i++) await clock.settle()
  expect(watch.players[0]?.[0]).toBe('say')
  await $.session.end(END)
})

test('a say that exits naming a daemon that does not answer falls back with its pid', async ($, on) => {
  const commands: string[][] = []
  const orderStderr = 'a voxlektor daemon (pid 4242) holds the lock but does not answer; stop it with: vxl stop\n'
  const toasts = voxReadingHost(on, commands, { orderExit: 2, orderStderr })
  watchChannel(on)
  await startReading($)

  await until(async () => toasts.length > 0)
  expect(toasts).toEqual(['Mac voice: voxlektor is not answering (pid 4242): run vxl stop. A Mac voice reads the rest of this reply.'])
  await $.session.end(END)
})

test('turning dialogue on with a daemon that does not answer says so at once', async ($, on) => {
  const commands: string[][] = []
  const warmStderr = 'a voxlektor daemon (pid 77) holds the lock but does not answer; stop it with: vxl stop\n'
  const toasts = voxReadingHost(on, commands, { warmStderr })
  watchChannel(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'dialogue', args: 'on', ...TYPED })

  await until(async () => toasts.length > 0)
  expect(toasts).toEqual(['voxlektor is not answering (pid 77): run vxl stop'])
  await $.session.end(END)
})

test('a failing say of a replaced reading leaves the orders of the reading that replaced it alone', async ($, on) => {
  let release: () => void = () => undefined
  const slowSay = new Promise<void>(resolve => (release = resolve))
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands, { slowSay, slowFrom: 1, sayExits: [1] })
  const watch = watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await band.press({ key: 'skip' })
  release()
  await until(async () => says(commands).some(argv => tagOf(argv) === 't1:2:2'))
  expect(says(commands).map(tagOf)).toEqual(['t1:1:0', 't1:2:1', 't1:2:2'])
  expect(toasts).toEqual([])
  expect(watch.players).toEqual([])
  await $.session.end(END)
})

test('choosing the engine already in use does not read the paragraph again; after a fallback it tries voxlektor again', async ($, on) => {
  const commands: string[][] = []
  const toasts = voxReadingHost(on, commands, { sayExits: [1] })
  const watch = watchChannel(on, { holdPlayers: true })
  await startReading($)
  await until(async () => toasts.length > 0 && watch.players.length > 0)

  // voxlektor failed for this reply: choosing it again reads from the paragraph on screen.
  commands.length = 0
  await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  await until(async () => says(commands).length >= 3)
  expect(says(commands)[0]).toContain('--now')

  // Already reading with voxlektor: nothing is read again.
  commands.length = 0
  await $.command.run({ command: 'dialogue', args: 'engine voxlektor', ...TYPED })
  await until(async () => says(commands).length > 0)
  expect(says(commands)).toEqual([])
  await $.session.end(END)
})

test('at the session end a say on its way is killed before the stop goes out', async ($, on) => {
  const commands: string[][] = []
  const killed: string[][] = []
  voxReadingHost(on, commands, { slowSay: new Promise<void>(() => undefined), slowFrom: 1, killed })
  watchChannel(on)
  await startReading($)
  await until(async () => says(commands).length === 1)

  commands.length = 0
  await $.session.end(END)
  expect(killed).toHaveLength(1)
  expect(commands).toEqual([['/u/vxl', 'stop-reading', OWNER_FLAG]])
})

test('with voxlektor 0.3.0 the readings and the warm-up use the claude profile', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_030)
  watchChannel(on)
  await startReading($, commands)

  expect(commands).toContainEqual(['/u/vxl', 'warm', '--profile=claude'])
  expect(says(commands).every(argv => argv.includes('--profile=claude'))).toBe(true)
  await $.session.end(END)
})

const VOX_CHECK_040 = {
  ...VOX_CHECK_030,
  version: '0.4.0',
  features: ['owners', 'profiles', 'steps', 'tag_nav', 'tags', 'warm', 'watch'],
}

// The watcher's first frame from a daemon of `version` with this session's reading of t1 on the floor at `tag`.
const floorSnapshot = (version: string, tag: string | undefined) => ({
  event: 'snapshot',
  state: 'WARM',
  version,
  protocol: 1,
  floor: { owner: 'dlg-abc', group: 't1' },
  groups: [{ owner: 'dlg-abc', group: 't1', position: 0, paused: false }],
  tag,
  daemon_outdated: version !== '0.4.0',
})

const voxOrders = (commands: string[][]) => commands.filter(argv => argv[0] === '/u/vxl' && ORDERS.includes(argv[1] ?? ''))

// Each band read takes the host a while, so these tests read the band only where it proves something.
const showsOn = async (band: { find: (query: { text: RegExp }) => Promise<unknown> }, text: RegExp) => {
  await until(async () => (await band.find({ text })) !== undefined)
  return (await band.find({ text })) !== undefined
}

test('with tag navigation, skip is one owner control; the box moves on the key and waits (⏳) for tag_started', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  // A 0.4.0 daemon with this session's reading on the floor at the second paragraph.
  watch.send(floorSnapshot('0.4.0', tags[1]))
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'skip' })
  expect(await showsOn(band, /🔊 3 \/ 3 ⏳/)).toBe(true)
  expect(voxOrders(commands)).toEqual([['/u/vxl', 'skip', OWNER_FLAG, '--unit=tag']])
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[1], reason: 'skipped' })
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tags[2] })
  expect(await showsOn(band, /🔊 3 \/ 3 ·/)).toBe(true)
  expect(voxOrders(commands).map(argv => argv[1])).toEqual(['skip'])
  await $.session.end(END)
})

test('with tag navigation, back shows the paragraph before at once, and follows voxlektor when it restarted instead', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  // The first two paragraphs were heard to the end, so both are in voxlektor's history.
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[0], reason: 'done' })
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[1], reason: 'done' })
  watch.send(floorSnapshot('0.4.0', tags[2]))
  await until(async () => (await band.find({ text: /🔊 3 \/ 3/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'back' })
  expect(await showsOn(band, /🔊 2 \/ 3 ⏳/)).toBe(true)
  expect(voxOrders(commands)).toEqual([['/u/vxl', 'back', OWNER_FLAG, '--unit=tag']])
  // voxlektor was partway through paragraph 3: it restarts it, and the box goes with it.
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[2], reason: 'back' })
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tags[2] })
  expect(await showsOn(band, /🔊 3 \/ 3 ·/)).toBe(true)
  expect(says(commands)).toEqual([])
  await $.session.end(END)
})

test('with tag navigation, back then skip at once returns to the paragraph it left, with one re-read', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[0], reason: 'done' })
  watch.send(floorSnapshot('0.4.0', tags[1]))
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)

  // The back may become a restart in voxlektor, so a tag skip after it could land one paragraph further than the box:
  // the skip is one `now` re-read from the paragraph the box shows.
  commands.length = 0
  await band.press({ key: 'back' })
  await band.press({ key: 'skip' })
  await until(async () => says(commands).length >= 1)
  expect(voxOrders(commands)[0]).toEqual(['/u/vxl', 'back', OWNER_FLAG, '--unit=tag'])
  expect(voxOrders(commands).filter(argv => argv[1] === 'skip')).toEqual([])
  expect(says(commands)[0]).toContain('--now')
  expect(tagOf(says(commands)[0]!)).toMatch(/:1$/)
  expect(await showsOn(band, /🔊 2 \/ 3 ·/)).toBe(true)
  await $.session.end(END)
})

const FIVE = '<spoken lang="pl">Jeden.\n\nDwa.\n\nTrzy.\n\nCztery.\n\nPięć.</spoken>'

test('with tag navigation, three quick skips move the box three paragraphs at once, and voxlektor three tags', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands, FIVE, 5)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send(floorSnapshot('0.4.0', tags[0]))
  await until(async () => (await band.find({ text: /🔊 1 \/ 5/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'skip' })
  await band.press({ key: 'skip' })
  await band.press({ key: 'skip' })
  expect(await showsOn(band, /🔊 4 \/ 5 ⏳/)).toBe(true)
  await until(async () => voxOrders(commands).length >= 3)
  // One tag skip per press: voxlektor drops paragraphs 1 to 3 and lands where the box is.
  expect(voxOrders(commands)).toEqual([
    ['/u/vxl', 'skip', OWNER_FLAG, '--unit=tag'],
    ['/u/vxl', 'skip', OWNER_FLAG, '--unit=tag'],
    ['/u/vxl', 'skip', OWNER_FLAG, '--unit=tag'],
  ])
  await $.session.end(END)
})

test('with tag navigation, back into a paragraph first read under an older epoch moves the box there', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const first = says(commands).map(tagOf)

  // The first paragraph was heard to the end, so it is in voxlektor's history.
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: first[0], reason: 'done' })
  watch.send(floorSnapshot('0.4.0', first[1]))
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)
  // A rate change re-reads from the paragraph on screen under a new epoch; the first paragraph keeps its old tag in
  // voxlektor's history.
  commands.length = 0
  await band.press({ key: 'faster' })
  await until(async () => says(commands).length === 2)
  const second = says(commands).map(tagOf)
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: second[0] })

  commands.length = 0
  await band.press({ key: 'back' })
  await until(async () => voxOrders(commands).length > 0)
  expect(voxOrders(commands)).toEqual([['/u/vxl', 'back', OWNER_FLAG, '--unit=tag']])
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: second[0], reason: 'back' })
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: first[0] })
  expect(await showsOn(band, /🔊 1 \/ 3/)).toBe(true)
  await $.session.end(END)
})

test('with tag navigation, backs beyond what this reply has had heard re-read from its start, never into the reply before', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[0], reason: 'done' })
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[1], reason: 'done' })
  watch.send(floorSnapshot('0.4.0', tags[2]))
  await until(async () => (await band.find({ text: /🔊 3 \/ 3/ })) !== undefined)

  // Three quick presses, no tag_started in between: the box goes 2, 1, 1 at once. Only the first is a tag back (the
  // others compose from the box with a `now` re-read), so voxlektor never goes past the first paragraph.
  commands.length = 0
  await band.press({ key: 'back' })
  await band.press({ key: 'back' })
  await band.press({ key: 'back' })
  expect(await showsOn(band, /🔊 1 \/ 3 ·/)).toBe(true)
  await until(async () => says(commands).some(argv => argv.includes('--now')))
  expect(voxOrders(commands).filter(argv => argv[1] === 'back')).toEqual([['/u/vxl', 'back', OWNER_FLAG, '--unit=tag']])
  const nows = says(commands).filter(argv => argv.includes('--now'))
  expect(nows.length).toBeGreaterThan(0)
  expect(nows.every(argv => tagOf(argv)?.endsWith(':0') === true)).toBe(true)
  await $.session.end(END)
})

test('with tag navigation, two quick skips that drop the last paragraph before it started end the box', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send(floorSnapshot('0.4.0', tags[1]))
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'skip' })
  await band.press({ key: 'skip' })
  // A third press on the ended box sends nothing: skips never run past what the box shows.
  await band.press({ key: 'skip' })
  await until(async () => voxOrders(commands).length >= 2)
  expect(voxOrders(commands).map(argv => argv[1])).toEqual(['skip', 'skip'])
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[1], reason: 'skipped' })
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[2], reason: 'skipped' })
  expect(await showsOn(band, /· end/)).toBe(true)
  await $.session.end(END)
})

test('with tag navigation, skip on the last paragraph is a skip, and its skipped tag ends the box', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send(floorSnapshot('0.4.0', tags[2]))
  await until(async () => (await band.find({ text: /🔊 3 \/ 3/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'skip' })
  await until(async () => voxOrders(commands).length > 0)
  expect(voxOrders(commands)).toEqual([['/u/vxl', 'skip', OWNER_FLAG, '--unit=tag']])
  watch.send({ event: 'tag_finished', owner: 'dlg-abc', group: 't1', tag: tags[2], reason: 'skipped' })
  expect(await showsOn(band, /· end/)).toBe(true)
  expect(voxOrders(commands).map(argv => argv[1])).toEqual(['skip'])
  await $.session.end(END)
})

test('a daemon older than 0.4.0 still running under a 0.4.0 install gets the re-read, never a tag skip', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  // The CLI keeps a busy outdated daemon, so the snapshot names the old version.
  watch.send(floorSnapshot('0.3.0', tags[1]))
  await until(async () => (await band.find({ text: /🔊 2 \/ 3/ })) !== undefined)

  commands.length = 0
  await band.press({ key: 'skip' })
  await until(async () => says(commands).length >= 1)
  expect(voxOrders(commands).some(argv => argv[1] === 'skip')).toBe(false)
  expect(says(commands)[0]).toContain('--now')
  expect(tagOf(says(commands)[0]!)).toMatch(/:2$/)
  await $.session.end(END)
})

test('with tag navigation, skip while paused keeps the re-read, as without it', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands, {}, VOX_CHECK_040)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send(floorSnapshot('0.4.0', tags[0]))
  await band.press({ key: 'pause' })
  await until(async () => (await band.find({ text: /paused/ })) !== undefined)
  commands.length = 0
  await band.press({ key: 'skip' })
  await until(async () => says(commands).length >= 2)
  expect(voxOrders(commands).some(argv => argv[1] === 'skip')).toBe(false)
  await $.session.end(END)
})

const stops = (commands: string[][]) => commands.filter(argv => argv[0] === '/u/vxl' && argv[1] === 'stop-reading').length

test('a cancelled reading that starts after the stop anyway is stopped once more, only once, and never reopens the box', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)
  const band = await $.ui.mount({ plugin: 'dialogue-box', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const tags = says(commands).map(tagOf)

  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tags[2] })
  await until(async () => (await band.find({ text: /🔊 3 \/ 3/ })) !== undefined)
  // Skip on the last paragraph (no tag navigation here) ends the box and stops the reading.
  await band.press({ key: 'skip' })
  await until(async () => stops(commands) > 0)
  expect(stops(commands)).toBe(1)

  // A speak that landed after the stop: the cancelled reading starts again, twice.
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tags[2] })
  watch.send({ event: 'tag_started', owner: 'dlg-abc', group: 't1', tag: tags[1] })
  await until(async () => stops(commands) > 2)
  expect(stops(commands)).toBe(2)
  expect(await band.find({ text: /🔊 3 \/ 3[\s\S]*· end/ })).toBeDefined()
  await $.session.end(END)
})

test('a floor for a cancelled group after the stop is stopped once more, and only once', async ($, on) => {
  const commands: string[][] = []
  voxReadingHost(on, commands)
  const watch = watchChannel(on)
  await startReading($, commands)

  await $.command.run({ command: 'dialogue', args: 'stop', ...TYPED })
  await until(async () => stops(commands) > 0)
  expect(stops(commands)).toBe(1)

  watch.send({ event: 'floor', owner: 'dlg-abc', group: 't1' })
  watch.send({ event: 'floor', owner: 'dlg-abc', group: 't1' })
  await until(async () => stops(commands) > 2)
  expect(stops(commands)).toBe(2)
  await $.session.end(END)
})
