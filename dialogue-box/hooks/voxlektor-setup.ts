import type { Engine, VoxCheck, VoxFound, VoxSetupState } from '../types'
import {
  hasRequiredFeatures,
  isCompatible,
  isPastTag,
  REQUIRED_FEATURES,
  setupArgv,
  speaksProtocol,
  supportsProfiles,
  supportsTagNav,
  tuneCommand,
  UV_INSTALL_COMMAND,
  versionStanding,
  VOXLEKTOR_INSTALL_COMMAND,
  VOXLEKTOR_MIN_VERSION,
  VOXLEKTOR_UPDATE_COMMAND,
} from './voxlektor'

// Defined in types/index.d.ts (the plugin's state needs it there, and that file may not import).
export type { VoxSetupState } from '../types'

export type VoxStep = 'install-uv' | 'install-voxlektor' | 'update' | 'download' | 'create-profile' | 'finish-setup'

type SetupInput = {
  // Output of `uname -m`: only 'arm64' (Apple Silicon) can run voxlektor.
  arch: string
  // Exit code of `vxl setup --check`; 3 means voxlektor refuses this platform.
  checkExit: number | undefined
  found: VoxFound
  // With profiles, the check run with the claude profile.
  check: VoxCheck | undefined
}

// Both installing and updating vxl go through uv.
function throughUv(found: VoxFound, state: VoxSetupState): VoxSetupState {
  return found.uv === undefined ? { kind: 'needs-uv', command: UV_INSTALL_COMMAND } : state
}

// What an install that answered the check lacks for this plugin, in words for the pane.
function missingParts(check: VoxCheck): string[] {
  if (versionStanding(check.version) === 'older') return [`version ${VOXLEKTOR_MIN_VERSION} or newer`]

  const features = check.features ?? []
  const missing = hasRequiredFeatures(check) ? [] : REQUIRED_FEATURES.filter(feature => !features.includes(feature))
  if (check.model === null) missing.push('a model for its engine')
  if (check.settings === undefined) missing.push('its settings')

  return missing
}

// The install answered the check but lacks something: updated onto the pinned tag, unless that is a downgrade.
function lacking(found: VoxFound, check: VoxCheck | undefined): VoxSetupState {
  if (check === undefined) return throughUv(found, { kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND, version: undefined, missing: [] })

  const missing = missingParts(check)
  // Past the pinned tag, a reinstall of the tag would be a downgrade.
  if (check.version !== undefined && isPastTag(check.version)) return { kind: 'incomplete', version: check.version, missing }

  return throughUv(found, { kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND, version: check.version, missing })
}

// Ordered so that each state is the first thing standing in the way of a working voice.
export function setupState({ arch, checkExit, found, check }: SetupInput): VoxSetupState {
  if (arch.trim() !== 'arm64' || checkExit === 3) return { kind: 'unsupported' }

  if (found.vxl === undefined) return throughUv(found, { kind: 'needs-voxlektor', command: VOXLEKTOR_INSTALL_COMMAND })

  // Newer than the range, or another protocol: reinstalling the pinned tag would be a downgrade, so nothing is
  // offered; dialogue-box is what needs updating.
  if (check !== undefined && !speaksProtocol(check.protocol)) {
    return { kind: 'too-new', version: `${check.version ?? 'unknown version'} (protocol v${String(check.protocol)})` }
  }
  if (check !== undefined && versionStanding(check.version) === 'newer') return { kind: 'too-new', version: check.version ?? '' }

  // No check at all (--check failed or printed nothing) means the installed vxl cannot answer the question we need
  // answered, which is what an old version looks like. A version below the compatible range is moved onto the
  // pinned one. A check without a model is a broken install: a download cannot fix it and there is no license to
  // show, so it is updated too.
  if (check === undefined || !isCompatible(check) || check.model === null) return lacking(found, check)

  const profiles = supportsProfiles(check)

  if (!check.model.present) {
    const { licenseName, licenseUrl, commercialUse, sizeBytes } = check.model

    return { kind: 'needs-model', licenseName, licenseUrl, commercialUse, sizeBytes, profiles }
  }

  // Without profiles voxlektor's global settings apply, so there is no profile to create, but `vxl setup` must have
  // finished once.
  if (profiles && (!check.profileExists || !check.setupCompleted || check.settings === undefined)) return { kind: 'needs-profile' }
  if (!profiles && !check.ready) return { kind: 'needs-setup' }

  if (check.settings === undefined) return lacking(found, check)

  const { voice, rate, volume, steps } = check.settings

  return { kind: 'ready', voice, rate, volume, steps, tuneCommand: tuneCommand(profiles), profiles, tagNav: supportsTagNav(check) }
}

// The command a state's step runs, as the person would type it in a terminal; for ready, the one that tunes the voice.
// The pane runs vxl and uv by the paths it found, with these same arguments.
export function commandFor(state: VoxSetupState): string | undefined {
  switch (state.kind) {
    case 'needs-uv':
    case 'needs-voxlektor':
    case 'needs-update':
      return state.command
    case 'needs-model':
      return setupArgv('vxl', { acceptLicense: true, profiles: state.profiles }).join(' ')
    case 'needs-profile':
      return setupArgv('vxl', { acceptLicense: false, profiles: true }).join(' ')
    case 'needs-setup':
      return setupArgv('vxl', { acceptLicense: false, profiles: false }).join(' ')
    case 'ready':
      return state.tuneCommand
    default:
      return undefined
  }
}

// Why voxlektor does not read, for the command answer and the fallback notice.
export function notReadyReason(state: VoxSetupState | null): string {
  return state?.kind === 'too-new'
    ? `voxlektor ${state.version} is newer than this dialogue-box supports: update dialogue-box.`
    : 'voxlektor is not ready: open /dialogue setup.'
}

export function licenseLine(state: Extract<VoxSetupState, { kind: 'needs-model' }>): string {
  const use = state.commercialUse ? 'commercial use allowed' : 'non-commercial use only'
  const size = state.sizeBytes > 0 ? `${(state.sizeBytes / 1e9).toFixed(1)} GB` : 'size unknown'

  return `${state.licenseName} · ${use} · ${size} · ${state.licenseUrl}`
}

// The engine when the person has not chosen one: the best voice that works here right now.
export function defaultEngine({ stored, voxReady, edgeFound }: { stored: Engine | undefined; voxReady: boolean; edgeFound: boolean }): Engine {
  if (stored !== undefined) return stored
  if (voxReady) return 'voxlektor'

  return edgeFound ? 'edge' : 'mac'
}

export function stepFor(state: VoxSetupState): VoxStep | undefined {
  switch (state.kind) {
    case 'needs-uv':
      return 'install-uv'
    case 'needs-voxlektor':
      return 'install-voxlektor'
    case 'needs-update':
      return 'update'
    case 'needs-model':
      return 'download'
    case 'needs-profile':
      return 'create-profile'
    case 'needs-setup':
      return 'finish-setup'
    default:
      return undefined
  }
}
