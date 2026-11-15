import { expect, test } from 'claude-code/testing'

import {
  checkArgv,
  controlArgv,
  decodeTag,
  encodeTag,
  groupOf,
  hasRequiredFeatures,
  LineBuffer,
  ownerFor,
  parseCheck,
  parseEvent,
  parseFound,
  parseProgress,
  sayCommand,
  setupArgv,
  supportsProfiles,
  tuneCommand,
  voxRate,
  warmArgv,
  watchArgv,
} from '../hooks/voxlektor'

const CHECK = JSON.stringify({
  ready: true,
  setup_completed: true,
  profile_exists: true,
  features: ['owners', 'profiles', 'tags', 'warm', 'watch'],
  version: '0.5.0',
  engine: 'omnivoice',
  model: {
    present: true,
    repo: 'k2-fsa/OmniVoice',
    revision: 'abc',
    size_bytes: 3_000_000_000,
    license_name: 'CC-BY-NC-4.0',
    license_url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    commercial_use: false,
  },
  settings: { voice: 'ania', lang: 'auto', base_lang: 'pl', rate: 1.1, volume: 0.8, idle_timeout_s: 600, autostart: true },
})

const REQUEST = { owner: 'o1', group: 'g1', tag: 't1', text: '-dash first', now: true, preempt: false, rate: 1.1 }

test('the finder output gives both paths, either may be missing', async () => {
  expect(parseFound('vxl=/a/vxl\nuv=/b/uv\n')).toEqual({ vxl: '/a/vxl', uv: '/b/uv' })
  expect(parseFound('uv=/b/uv\n')).toEqual({ vxl: undefined, uv: '/b/uv' })
  expect(parseFound('')).toEqual({ vxl: undefined, uv: undefined })
})

test('a reading carries owner, group, tag and rate, the text goes on stdin', async () => {
  const now = sayCommand('/x/vxl', REQUEST, false)

  expect(now.input).toBe('-dash first')
  expect(now.argv[0]).toBe('/x/vxl')
  for (const flag of ['--owner=o1', '--group=g1', '--tag=t1', '--rate=1.1', '--now']) {
    expect(now.argv).toContain(flag)
  }
  expect(now.argv).not.toContain('--preempt')
  expect(now.argv.some(arg => arg.startsWith('--profile'))).toBe(false)

  const preempt = sayCommand('/x/vxl', { ...REQUEST, now: false, preempt: true }, false)

  expect(preempt.argv).toContain('--preempt')
  expect(preempt.argv).not.toContain('--now')
})

test('play now sends now and preempt together', async () => {
  const both = sayCommand('/x/vxl', { ...REQUEST, now: true, preempt: true }, false)

  expect(both.argv).toContain('--now')
  expect(both.argv).toContain('--preempt')
})

test('the claude profile is named only when voxlektor has profiles', async () => {
  expect(sayCommand('/x/vxl', REQUEST, true).argv).toContain('--profile=claude')
  expect(checkArgv('vxl', true)).toEqual(['vxl', 'setup', '--check', '--profile=claude'])
  expect(checkArgv('vxl', false)).toEqual(['vxl', 'setup', '--check'])
  expect(tuneCommand(true)).toBe('vxl setup --profile claude')
  expect(tuneCommand(false)).toBe('vxl setup')
})

test('warming is daemon-wide and names no profile', async () => {
  expect(warmArgv('vxl')).toEqual(['vxl', 'warm'])
})

test('controls are scoped to the owner and mapped to their subcommands', async () => {
  expect(controlArgv('vxl', 'stop', 'o1')).toEqual(['vxl', 'stop-reading', '--owner=o1'])
  expect(controlArgv('vxl', 'pause', 'o1')).toEqual(['vxl', 'pause', '--owner=o1'])
  expect(controlArgv('vxl', 'resume', 'o1')).toEqual(['vxl', 'resume', '--owner=o1'])
})

test('the watcher follows this owner as JSON', async () => {
  expect(watchArgv('vxl', 'o1')).toEqual(['vxl', 'watch', '--json', '--owner=o1'])
})

test('setup is headless and accepts the license only when told to', async () => {
  expect(setupArgv('vxl', { acceptLicense: false, profiles: false })).toEqual(['vxl', 'setup', '--yes'])
  expect(setupArgv('vxl', { acceptLicense: true, profiles: false })).toEqual(['vxl', 'setup', '--yes', '--accept-model-license'])
})

test('with profiles, setup goes to the claude profile and reports progress as JSON', async () => {
  const argv = setupArgv('vxl', { acceptLicense: true, profiles: true })

  for (const flag of ['--yes', '--profile=claude', '--progress=json', '--accept-model-license']) expect(argv).toContain(flag)
})

test('check output is read with its license, features and settings', async () => {
  const check = parseCheck(CHECK)

  expect(check).toEqual({
    ready: true,
    setupCompleted: true,
    profileExists: true,
    features: ['owners', 'profiles', 'tags', 'warm', 'watch'],
    model: {
      present: true,
      licenseName: 'CC-BY-NC-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      commercialUse: false,
      sizeBytes: 3_000_000_000,
    },
    settings: { voice: 'ania', rate: 1.1, volume: 0.8 },
  })
  expect(hasRequiredFeatures(check!)).toBe(true)
  expect(supportsProfiles(check!)).toBe(true)
  expect(parseCheck('not json')).toBe(undefined)
})

test('the S1 features are enough, profiles are optional', async () => {
  const s1 = parseCheck(JSON.stringify({ ready: true, setup_completed: true, features: ['owners', 'tags', 'warm', 'watch'] }))!

  expect(hasRequiredFeatures(s1)).toBe(true)
  expect(supportsProfiles(s1)).toBe(false)
  expect(hasRequiredFeatures({ ...s1, features: ['owners', 'tags', 'watch'] })).toBe(false)
})

test('a check without features reads as too old', async () => {
  const old = parseCheck(JSON.stringify({ ready: true, setup_completed: true, model: null }))!

  expect(old.features).toBe(undefined)
  expect(old.model).toBe(null)
  expect(hasRequiredFeatures(old)).toBe(false)
  expect(supportsProfiles(old)).toBe(false)
})

test('a missing or broken rate reads as the normal rate', async () => {
  const noRate = parseCheck(JSON.stringify({ settings: { voice: 'ania', volume: 0.8 } }))!

  expect(noRate.settings?.rate).toBe(1)
  expect(voxRate(Number.NaN, 2)).toBe(2)
  expect(voxRate(1.2, Number.NaN)).toBe(1.2)
  expect(voxRate(1.2, undefined as unknown as number)).toBe(1.2)
})

test('events are read by name with their owner and group; unknown names and broken lines are ignored', async () => {
  expect(parseEvent('{"event":"tag_started","owner":"o1","group":"g","tag":"r1:0"}')).toEqual({
    type: 'tag_started',
    owner: 'o1',
    tag: 'r1:0',
  })
  expect(parseEvent('{"event":"waiting","owner":"o1","group":"g2","position":2}')).toEqual({
    type: 'waiting',
    owner: 'o1',
    group: 'g2',
    position: 2,
  })
  expect(parseEvent('{"event":"floor","owner":"o2","group":"x"}')).toEqual({ type: 'floor', owner: 'o2', group: 'x' })
  expect(parseEvent('{"event":"paused","owner":null}')).toEqual({ type: 'paused', owner: null })
  expect(parseEvent('{"event":"resumed","owner":"o1"}')).toEqual({ type: 'resumed', owner: 'o1' })
  expect(parseEvent('{"event":"drained","owner":"o1"}')).toEqual({ type: 'drained', owner: 'o1' })
  expect(parseEvent('{"event":"error","owner":null,"code":"audio","message":"no device"}')).toEqual({
    type: 'error',
    owner: null,
    code: 'audio',
    message: 'no device',
  })
  expect(parseEvent('{"event":"daemon_off"}')).toEqual({ type: 'daemon_off' })
  expect(parseEvent('{"event":"disconnected"}')).toEqual({ type: 'disconnected' })
  expect(parseEvent('{"event":"brand_new"}')).toBe(undefined)
  expect(parseEvent('{oops')).toBe(undefined)
})

test('a missing owner reads as none', async () => {
  expect(parseEvent('{"event":"drained"}')).toEqual({ type: 'drained', owner: null })
})

test('tag_finished reasons follow voxlektor; a missing one is done, an unknown one ends nothing', async () => {
  const reason = (value: string | undefined) => {
    const event = parseEvent(JSON.stringify({ event: 'tag_finished', owner: 'o1', tag: 'r1:0', reason: value }))

    return event?.type === 'tag_finished' ? event.reason : undefined
  }

  for (const known of ['done', 'skipped', 'stopped', 'replaced', 'back', 'error'] as const) expect(reason(known)).toBe(known)
  expect(reason(undefined)).toBe('done')
  expect(reason('played')).toBe('unknown')
  expect(reason('brand_new')).toBe('unknown')
})

test('the snapshot gives the floor, the playing tag and an outdated daemon', async () => {
  const line = JSON.stringify({
    event: 'snapshot',
    state: 'WARM',
    paused: true,
    version: '0.5.0',
    caps: ['subscribe'],
    tag: 'r1:1:0',
    floor: { owner: 'o1', group: 'r1' },
    waiting: 2,
    daemon_outdated: true,
  })

  expect(parseEvent(line)).toEqual({
    type: 'snapshot',
    state: 'WARM',
    version: '0.5.0',
    caps: ['subscribe'],
    tag: 'r1:1:0',
    floorOwner: 'o1',
    outdated: true,
  })
  expect(parseEvent('{"event":"snapshot","state":"COLD","floor":null}')).toEqual({
    type: 'snapshot',
    state: 'COLD',
    version: undefined,
    caps: [],
    tag: undefined,
    floorOwner: null,
    outdated: false,
  })
})

test('lines split across chunks are joined, several per chunk are split', async () => {
  const buffer = new LineBuffer()

  expect(buffer.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
  expect(buffer.push(':2}\n\n')).toEqual(['{"b":2}'])
  expect(buffer.push('tail')).toEqual([])
  expect(buffer.flush()).toEqual(['tail'])
})

test('tags round-trip with their group, reading epoch and paragraph', async () => {
  const tag = encodeTag('turn/ä:1 x', 3, 7)

  expect(decodeTag(tag)).toEqual({ group: groupOf('turn/ä:1 x'), epoch: 7, index: 3 })
  expect(decodeTag('garbage')).toBe(undefined)
  expect(decodeTag('g:1')).toBe(undefined)
  expect(decodeTag(':1:2')).toBe(undefined)
})

test('groups and tags stay within voxlektor limits and apart for long ids', async () => {
  const long = 'ä'.repeat(200)
  const other = `${'ä'.repeat(199)}b`

  expect(groupOf(long).length).toBeLessThanOrEqual(128)
  expect(encodeTag(long, 999, 99_999).length).toBeLessThanOrEqual(128)
  expect(groupOf(long)).not.toBe(groupOf(other))
  expect(groupOf('turn-1')).toBe('turn-1')
})

test('the owner id is valid for voxlektor and never cli', async () => {
  const pattern = /^[A-Za-z0-9._:-]{1,64}$/

  expect(ownerFor('5f2c-aa')).toBe('dlg-5f2c-aa')
  expect(ownerFor('cli')).not.toBe('cli')
  expect(ownerFor('a b/ä')).toMatch(pattern)
  expect(ownerFor('x'.repeat(100))).toMatch(pattern)
})

test('rate multiplies the profile rate within voxlektor limits', async () => {
  expect(voxRate(1.1, 1)).toBe(1.1)
  expect(voxRate(1.1, 2)).toBe(2.2)
  expect(voxRate(2, 2)).toBe(3)
  expect(voxRate(1, 0.3)).toBe(0.5)
})

test('download progress is read from JSON lines', async () => {
  expect(parseProgress('{"event":"download","done":5,"total":10}')).toEqual({ done: 5, total: 10 })
  expect(parseProgress('{"event":"done"}')).toBe('done')
  expect(parseProgress('{"event":"error","message":"x"}')).toEqual({ error: 'x' })
  expect(parseProgress('downloading the model: 5%')).toBe(undefined)
})
