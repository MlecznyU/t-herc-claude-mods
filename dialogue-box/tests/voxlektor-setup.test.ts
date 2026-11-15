import { expect, test } from 'claude-code/testing'

import type { VoxCheck } from '../types'
import { setupState, stepFor } from '../hooks/voxlektor-setup'
import { tuneCommand, UV_INSTALL_COMMAND, VOXLEKTOR_INSTALL_COMMAND, VOXLEKTOR_UPDATE_COMMAND } from '../hooks/voxlektor'

const FOUND = { vxl: '/u/.local/bin/vxl', uv: '/u/.local/bin/uv' }

// voxlektor S1: no profiles, its global settings apply.
const CHECK: VoxCheck = {
  ready: true,
  setupCompleted: true,
  profileExists: false,
  features: ['owners', 'tags', 'warm', 'watch'],
  model: { present: true, licenseName: 'CC BY-NC 4.0', licenseUrl: 'https://example.com/license', commercialUse: false, sizeBytes: 1_700_000_000 },
  settings: { voice: 'claude', rate: 1.2, volume: 0.8 },
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

test('an install without features asks for an update', () => {
  const old: VoxCheck = { ...CHECK, features: undefined }

  expect(setupState(input({ check: old }))).toEqual({ kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND })
  expect(setupState(input({ check: { ...CHECK, features: ['owners', 'tags', 'watch'] } })).kind).toBe('needs-update')
  // A vxl that could not answer --check is too old for the check we need.
  expect(setupState(input({ check: undefined, checkExit: 2 })).kind).toBe('needs-update')
})

test('an install that knows no model is updated, not offered a download without a license', () => {
  expect(setupState(input({ check: { ...CHECK, model: null } }))).toEqual({ kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND })
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
  const state = setupState(input({ check: { ...CHECK, profileExists: false, setupCompleted: false } }))

  expect(state).toEqual({ kind: 'ready', voice: 'claude', rate: 1.2, volume: 0.8, tuneCommand: tuneCommand(false), profiles: false })
})

test('ready shows the values and the tune command for the profile in use', () => {
  expect(setupState(input())).toEqual({
    kind: 'ready',
    voice: 'claude',
    rate: 1.2,
    volume: 0.8,
    tuneCommand: tuneCommand(false),
    profiles: false,
  })
  expect(setupState(input({ check: WITH_PROFILES }))).toEqual({
    kind: 'ready',
    voice: 'claude',
    rate: 1.2,
    volume: 0.8,
    tuneCommand: tuneCommand(true),
    profiles: true,
  })
})

test('stepFor maps each state to the step that fixes it', () => {
  expect(stepFor({ kind: 'unsupported' })).toBeUndefined()
  expect(stepFor({ kind: 'needs-uv', command: 'x' })).toBe('install-uv')
  expect(stepFor({ kind: 'needs-voxlektor', command: 'x' })).toBe('install-voxlektor')
  expect(stepFor({ kind: 'needs-update', command: 'x' })).toBe('update')
  expect(stepFor({ kind: 'needs-model', licenseName: '', licenseUrl: '', commercialUse: false, sizeBytes: 0, profiles: false })).toBe('download')
  expect(stepFor({ kind: 'needs-profile' })).toBe('create-profile')
  expect(stepFor({ kind: 'ready', voice: 'v', rate: 1, volume: 1, tuneCommand: 'x', profiles: false })).toBeUndefined()
})
