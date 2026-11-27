import { expect, test } from 'claude-code/testing'

import type { VoxCheck } from '../types'
import { commandFor, defaultEngine, licenseLine, notReadyReason, setupState, stepFor } from '../hooks/voxlektor-setup'
import { tuneCommand, UV_INSTALL_COMMAND, VOXLEKTOR_INSTALL_COMMAND, VOXLEKTOR_UPDATE_COMMAND } from '../hooks/voxlektor'

const FOUND = { vxl: '/u/.local/bin/vxl', uv: '/u/.local/bin/uv' }

// voxlektor S1: no profiles, its global settings apply.
const CHECK: VoxCheck = {
  ready: true,
  setupCompleted: true,
  profileExists: false,
  version: '0.2.0',
  protocol: undefined,
  features: ['owners', 'tags', 'warm', 'watch'],
  model: { present: true, licenseName: 'CC BY-NC 4.0', licenseUrl: 'https://example.com/license', commercialUse: false, sizeBytes: 1_700_000_000 },
  settings: { voice: 'claude', rate: 1.2, volume: 0.8, steps: undefined },
}

const WITH_PROFILES: VoxCheck = { ...CHECK, profileExists: true, features: ['owners', 'profiles', 'tags', 'warm', 'watch'] }

const input = (over: Partial<Parameters<typeof setupState>[0]> = {}): Parameters<typeof setupState>[0] => ({
  arch: 'arm64\n',
  checkExit: 0,
  found: FOUND,
  check: CHECK,
  ...over,
})

test('an Intel Mac or exit 3 is unsupported', () => {
  expect(setupState(input({ arch: 'x86_64\n' }))).toEqual({ kind: 'unsupported' })
  expect(setupState(input({ checkExit: 3 }))).toEqual({ kind: 'unsupported' })
})

test('uname output with its newline is still Apple Silicon', () => {
  expect(setupState(input({ arch: 'arm64\n' })).kind).toBe('ready')
})

test('without uv the uv command is offered', () => {
  const state = setupState(input({ found: { vxl: undefined, uv: undefined }, check: undefined, checkExit: undefined }))

  expect(state).toEqual({ kind: 'needs-uv', command: UV_INSTALL_COMMAND })
})

test('with uv but no vxl the install command is offered', () => {
  const state = setupState(input({ found: { vxl: undefined, uv: FOUND.uv }, check: undefined, checkExit: undefined }))

  expect(state).toEqual({ kind: 'needs-voxlektor', command: VOXLEKTOR_INSTALL_COMMAND })
})

test('an install without features asks for an update and says what it lacks', () => {
  const old: VoxCheck = { ...CHECK, features: undefined }

  expect(setupState(input({ check: old }))).toEqual({
    kind: 'needs-update',
    command: VOXLEKTOR_UPDATE_COMMAND,
    version: '0.2.0',
    missing: ['owners', 'tags', 'warm', 'watch'],
  })
  expect(setupState(input({ check: { ...CHECK, features: ['owners', 'tags', 'watch'] } }))).toMatchObject({ kind: 'needs-update', missing: ['warm'] })
  // A vxl that could not answer --check is too old for the check we need.
  expect(setupState(input({ check: undefined, checkExit: 2 }))).toEqual({
    kind: 'needs-update',
    command: VOXLEKTOR_UPDATE_COMMAND,
    version: undefined,
    missing: [],
  })
})

test('an install at the pinned tag that lacks something is reinstalled; one past the tag is never downgraded', () => {
  const at = (version: string) => setupState(input({ check: { ...CHECK, version, features: ['owners', 'tags', 'watch'] } }))

  expect(at('0.3.0')).toMatchObject({ kind: 'needs-update', version: '0.3.0', missing: ['warm'] })
  expect(at('0.4.0')).toMatchObject({ kind: 'needs-update', version: '0.4.0', missing: ['warm'] })
  expect(at('0.4.1')).toMatchObject({ kind: 'needs-update', version: '0.4.1', missing: ['warm'] })
  expect(at('0.4.2')).toEqual({ kind: 'incomplete', version: '0.4.2', missing: ['warm'] })
  expect(at('0.9.5').kind).toBe('incomplete')
  expect(setupState(input({ check: { ...CHECK, version: '0.4.2', model: null } }))).toEqual({
    kind: 'incomplete',
    version: '0.4.2',
    missing: ['a model for its engine'],
  })
  // Nothing to run: a reinstall of the tag would be a downgrade, also when uv is missing.
  expect(stepFor(at('0.4.2'))).toBeUndefined()
  expect(commandFor(at('0.4.2'))).toBeUndefined()
  expect(setupState(input({ found: { vxl: FOUND.vxl, uv: undefined }, check: { ...CHECK, version: '0.4.2', features: [] } })).kind).toBe('incomplete')
})

test('a voxlektor below the compatible range asks for the pinned version', () => {
  const at = (version: string | undefined) => setupState(input({ check: { ...CHECK, version } }))

  expect(at('0.1.0')).toEqual({ kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND, version: '0.1.0', missing: ['version 0.2.0 or newer'] })
  expect(at(undefined).kind).toBe('needs-update')
  expect(at('0.2.7').kind).toBe('ready')
  expect(at('0.3.0').kind).toBe('ready')
  expect(at('0.9.5').kind).toBe('ready')
})

test('a voxlektor at or past the upper bound is too new: nothing to run, dialogue-box needs the update', () => {
  const at = (check: Partial<VoxCheck>) => setupState(input({ check: { ...CHECK, ...check } }))

  expect(at({ version: '1.0.0' })).toEqual({ kind: 'too-new', version: '1.0.0' })
  // Too new wins over a missing feature: a reinstall would be a downgrade.
  expect(at({ version: '1.3.0', features: ['owners'] })).toEqual({ kind: 'too-new', version: '1.3.0' })
  // Too new even without uv: nothing is installed.
  expect(setupState(input({ found: { vxl: FOUND.vxl, uv: undefined }, check: { ...CHECK, version: '1.0.0' } })).kind).toBe('too-new')
  // A protocol other than v1 is too new whatever the version says.
  expect(at({ protocol: 2 })).toEqual({ kind: 'too-new', version: '0.2.0 (protocol v2)' })
  expect(at({ protocol: 1 }).kind).toBe('ready')
  const tooNew = at({ version: '1.0.0' })
  expect(stepFor(tooNew)).toBeUndefined()
  expect(commandFor(tooNew)).toBeUndefined()
})

test('the not-ready reason says what is wrong with a too-new voxlektor', () => {
  expect(notReadyReason({ kind: 'too-new', version: '1.0.0' })).toBe(
    'voxlektor 1.0.0 is newer than this dialogue-box supports: update dialogue-box.',
  )
  expect(notReadyReason({ kind: 'needs-profile' })).toBe('voxlektor is not ready: open /dialogue setup.')
  expect(notReadyReason(null)).toBe('voxlektor is not ready: open /dialogue setup.')
})

test('an install that knows no model is updated, not offered a download without a license', () => {
  expect(setupState(input({ check: { ...CHECK, model: null } }))).toEqual({
    kind: 'needs-update',
    command: VOXLEKTOR_UPDATE_COMMAND,
    version: '0.2.0',
    missing: ['a model for its engine'],
  })
})

test('an update without uv asks for uv first', () => {
  const state = setupState(input({ found: { vxl: FOUND.vxl, uv: undefined }, check: { ...CHECK, features: undefined } }))

  expect(state).toEqual({ kind: 'needs-uv', command: UV_INSTALL_COMMAND })
})

test('a missing model shows its license', () => {
  const missing: VoxCheck = { ...CHECK, ready: false, model: { ...CHECK.model!, present: false } }

  expect(setupState(input({ check: missing }))).toEqual({
    kind: 'needs-model',
    licenseName: 'CC BY-NC 4.0',
    licenseUrl: 'https://example.com/license',
    commercialUse: false,
    sizeBytes: 1_700_000_000,
    profiles: false,
  })
  expect(setupState(input({ check: { ...missing, features: WITH_PROFILES.features } }))).toMatchObject({ kind: 'needs-model', profiles: true })
})

test('with profiles, a missing profile only needs creating', () => {
  const state = setupState(input({ check: { ...WITH_PROFILES, ready: false, profileExists: false } }))

  expect(state).toEqual({ kind: 'needs-profile' })
})

test('without profiles there is no profile to create: the global settings are ready', () => {
  const state = setupState(input({ check: { ...CHECK, profileExists: false } }))

  expect(state).toEqual({
    kind: 'ready',
    voice: 'claude',
    rate: 1.2,
    volume: 0.8,
    steps: undefined,
    tuneCommand: tuneCommand(false),
    profiles: false,
    tagNav: false,
  })
})

test('without profiles, a model present but a setup never finished offers to finish it', () => {
  const state = setupState(input({ check: { ...CHECK, ready: false, setupCompleted: false } }))

  expect(state).toEqual({ kind: 'needs-setup' })
  expect(stepFor(state)).toBe('finish-setup')
  expect(commandFor(state)).toBe('vxl setup --yes')
})

test('ready shows the values and the tune command for the profile in use', () => {
  expect(setupState(input())).toEqual({
    kind: 'ready',
    voice: 'claude',
    rate: 1.2,
    volume: 0.8,
    steps: undefined,
    tuneCommand: tuneCommand(false),
    profiles: false,
    tagNav: false,
  })
  expect(setupState(input({ check: { ...WITH_PROFILES, settings: { ...CHECK.settings!, steps: 8 } } }))).toEqual({
    kind: 'ready',
    voice: 'claude',
    rate: 1.2,
    volume: 0.8,
    steps: 8,
    tuneCommand: tuneCommand(true),
    profiles: true,
    tagNav: false,
  })
})

test('ready says whether the install offers tag navigation (voxlektor 0.4.0)', () => {
  const features = ['owners', 'profiles', 'steps', 'tag_nav', 'tags', 'warm', 'watch']
  const state = setupState(input({ check: { ...WITH_PROFILES, version: '0.4.0', features } }))

  expect(state).toMatchObject({ kind: 'ready', tagNav: true })
})

test('with profiles the model download creates the claude profile in the same run, as voxlektor 0.3.0 allows', () => {
  const missing: VoxCheck = { ...WITH_PROFILES, ready: false, profileExists: false, setupCompleted: false, model: { ...CHECK.model!, present: false } }
  const state = setupState(input({ check: missing }))

  // --accept-model-license and --progress are no global options: only --engine, --idle and --autostart are refused
  // with --profile (voxlektor tests/entrypoints/cli/test_setup.py runs exactly this command).
  expect(commandFor(state)).toBe('vxl setup --yes --profile=claude --progress=json --accept-model-license')
  // The model present, the profile missing: the profile alone is created, which also marks the setup completed.
  const noProfile = setupState(input({ check: { ...missing, model: CHECK.model } }))
  expect(noProfile).toEqual({ kind: 'needs-profile' })
  expect(commandFor(noProfile)).toBe('vxl setup --yes --profile=claude --progress=json')
})

test('a stored engine wins', () => {
  expect(defaultEngine({ stored: 'mac', voxReady: true, edgeFound: true })).toBe('mac')
  expect(defaultEngine({ stored: 'edge', voxReady: true, edgeFound: false })).toBe('edge')
  expect(defaultEngine({ stored: 'voxlektor', voxReady: false, edgeFound: true })).toBe('voxlektor')
})

test('voxlektor is the default when ready', () => {
  expect(defaultEngine({ stored: undefined, voxReady: true, edgeFound: true })).toBe('voxlektor')
  expect(defaultEngine({ stored: undefined, voxReady: true, edgeFound: false })).toBe('voxlektor')
})

test('else Edge where found, else Mac', () => {
  expect(defaultEngine({ stored: undefined, voxReady: false, edgeFound: true })).toBe('edge')
  expect(defaultEngine({ stored: undefined, voxReady: false, edgeFound: false })).toBe('mac')
})

test('every state that needs a step shows the command it runs', () => {
  const model = { kind: 'needs-model', licenseName: 'L', licenseUrl: 'u', commercialUse: false, sizeBytes: 1, profiles: false } as const

  expect(commandFor({ kind: 'unsupported' })).toBeUndefined()
  expect(commandFor({ kind: 'needs-uv', command: UV_INSTALL_COMMAND })).toBe(UV_INSTALL_COMMAND)
  expect(commandFor({ kind: 'needs-voxlektor', command: VOXLEKTOR_INSTALL_COMMAND })).toBe(VOXLEKTOR_INSTALL_COMMAND)
  expect(commandFor({ kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND, version: '0.2.0', missing: [] })).toBe(VOXLEKTOR_UPDATE_COMMAND)
  expect(commandFor(model)).toBe('vxl setup --yes --accept-model-license')
  expect(commandFor({ ...model, profiles: true })).toBe('vxl setup --yes --profile=claude --progress=json --accept-model-license')
  expect(commandFor({ kind: 'needs-profile' })).toBe('vxl setup --yes --profile=claude --progress=json')
  expect(commandFor({ kind: 'ready', voice: 'v', rate: 1, volume: 50, steps: undefined, tuneCommand: 'vxl setup', profiles: false, tagNav: false })).toBe('vxl setup')
})

test('the license line names the license, its use, the size and where to read it', () => {
  const model = { kind: 'needs-model', licenseName: 'CC-BY-NC-4.0', licenseUrl: 'https://x', commercialUse: false, sizeBytes: 1_700_000_000, profiles: false } as const

  expect(licenseLine(model)).toBe('CC-BY-NC-4.0 · non-commercial use only · 1.7 GB · https://x')
  expect(licenseLine({ ...model, commercialUse: true, sizeBytes: 0 })).toBe('CC-BY-NC-4.0 · commercial use allowed · size unknown · https://x')
})

test('stepFor maps each state to the step that fixes it', () => {
  expect(stepFor({ kind: 'unsupported' })).toBeUndefined()
  expect(stepFor({ kind: 'needs-uv', command: 'x' })).toBe('install-uv')
  expect(stepFor({ kind: 'needs-voxlektor', command: 'x' })).toBe('install-voxlektor')
  expect(stepFor({ kind: 'needs-update', command: 'x', version: undefined, missing: [] })).toBe('update')
  expect(stepFor({ kind: 'needs-model', licenseName: '', licenseUrl: '', commercialUse: false, sizeBytes: 0, profiles: false })).toBe('download')
  expect(stepFor({ kind: 'needs-profile' })).toBe('create-profile')
  expect(stepFor({ kind: 'ready', voice: 'v', rate: 1, volume: 1, steps: undefined, tuneCommand: 'x', profiles: false, tagNav: false })).toBeUndefined()
})
