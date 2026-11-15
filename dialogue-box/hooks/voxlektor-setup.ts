import type { VoxCheck, VoxFound } from '../types'
import {
  hasRequiredFeatures,
  supportsProfiles,
  tuneCommand,
  UV_INSTALL_COMMAND,
  VOXLEKTOR_INSTALL_COMMAND,
  VOXLEKTOR_UPDATE_COMMAND,
} from './voxlektor'

// `profiles` says whether the installed voxlektor has profiles (`supportsProfiles`); pass it on to the vxl calls the
// state leads to: `setupArgv` for needs-model, `sayCommand` for ready.
export type VoxSetupState =
  | { kind: 'unsupported' }
  | { kind: 'needs-uv'; command: string }
  | { kind: 'needs-voxlektor'; command: string }
  | { kind: 'needs-update'; command: string }
  | { kind: 'needs-model'; licenseName: string; licenseUrl: string; commercialUse: boolean; sizeBytes: number; profiles: boolean }
  | { kind: 'needs-profile' }
  | { kind: 'ready'; voice: string; rate: number; volume: number; tuneCommand: string; profiles: boolean }

export type VoxStep = 'install-uv' | 'install-voxlektor' | 'update' | 'download' | 'create-profile'

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

// Ordered so that each state is the first thing standing in the way of a working voice.
export function setupState({ arch, checkExit, found, check }: SetupInput): VoxSetupState {
  if (arch.trim() !== 'arm64' || checkExit === 3) return { kind: 'unsupported' }

  if (found.vxl === undefined) return throughUv(found, { kind: 'needs-voxlektor', command: VOXLEKTOR_INSTALL_COMMAND })

  // No check at all (--check failed or printed nothing) means the installed vxl cannot answer the question we need
  // answered, which is what an old version looks like. A check without a model is a broken install: a download cannot
  // fix it and there is no license to show, so it is updated too.
  if (check === undefined || !hasRequiredFeatures(check) || check.model === null) {
    return throughUv(found, { kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND })
  }

  const profiles = supportsProfiles(check)

  if (!check.model.present) {
    const { licenseName, licenseUrl, commercialUse, sizeBytes } = check.model

    return { kind: 'needs-model', licenseName, licenseUrl, commercialUse, sizeBytes, profiles }
  }

  // Without profiles voxlektor's global settings apply, so there is no profile to create.
  if (profiles && (!check.profileExists || !check.setupCompleted || check.settings === undefined)) return { kind: 'needs-profile' }

  if (check.settings === undefined) return throughUv(found, { kind: 'needs-update', command: VOXLEKTOR_UPDATE_COMMAND })

  const { voice, rate, volume } = check.settings

  return { kind: 'ready', voice, rate, volume, tuneCommand: tuneCommand(profiles), profiles }
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
    default:
      return undefined
  }
}
