export type Segment = { language: string; text: string }

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'compact' | 'novelty'

export type Voice = { name: string; language: string; locale: string; quality: VoiceQuality; sample: string }

export type EdgeVoice = { name: string; language: string; locale: string; gender: string; personalities: string }

export type Style = 'integrated' | 'mirror'

export type Engine = 'edge' | 'mac' | 'voxlektor'

export type DialogStatus = 'playing' | 'paused' | 'ended'

// `pending`: the box moved on a skip or back key ahead of voxlektor and waits for it to start that paragraph (⏳).
export type Dialog = { id: string; paragraphs: string[]; index: number; language: string; status: DialogStatus; pending?: true }

export type SetupView = 'voices' | 'languages'

export type VoxState = 'COLD' | 'LOADING' | 'WARM' | 'UNLOADING'

// How a tagged paragraph ended. 'unknown' is a reason this plugin does not know yet, which never ends a dialog.
export type VoxReason = 'done' | 'skipped' | 'stopped' | 'replaced' | 'back' | 'error' | 'unknown'

// One queued group of the snapshot, in play order: position 0 holds the floor, null is passed over (its owner is
// paused); `paused` is that owner's pause.
export type VoxGroup = { owner: string; group: string; position: number | null; paused: boolean }

// `owner` is null for daemon-wide events and when voxlektor sent none.
export type VoxEvent =
  | {
      type: 'snapshot'
      state: VoxState
      version: string | undefined
      // The protocol version (`protocol`), when the line names one.
      protocol: number | undefined
      caps: string[]
      tag: string | undefined
      floorOwner: string | null
      outdated: boolean
      // Playback is paused, by the floor holder's own pause or by a daemon-wide hold.
      paused: boolean
      groups: VoxGroup[]
    }
  | { type: 'state'; state: VoxState }
  | { type: 'tag_started'; owner: string | null; tag: string }
  | { type: 'tag_finished'; owner: string | null; tag: string; reason: VoxReason }
  | { type: 'drained'; owner: string | null }
  | { type: 'paused'; owner: string | null }
  | { type: 'resumed'; owner: string | null }
  | { type: 'waiting'; owner: string | null; group: string | null; position: number }
  | { type: 'floor'; owner: string | null; group: string | null }
  | { type: 'error'; owner: string | null; code: string; message: string }
  | { type: 'daemon_off' }
  | { type: 'disconnected' }

export type VoxCheck = {
  ready: boolean
  setupCompleted: boolean
  profileExists: boolean
  // The CLI's package version, e.g. "0.2.0"; undefined when the check names none.
  version: string | undefined
  // The protocol version (`protocol`), when the check names one.
  protocol: number | undefined
  features: string[] | undefined
  model: { present: boolean; licenseName: string; licenseUrl: string; commercialUse: boolean; sizeBytes: number } | null
  // `steps` from voxlektor 0.3.0 on.
  settings: { voice: string; rate: number; volume: number; steps: number | undefined } | undefined
}

export type VoxFound = { vxl: string | undefined; uv: string | undefined }

export type SayRequest = {
  owner: string
  group: string
  tag: string
  text: string
  now: boolean
  preempt: boolean
  rate: number
}

// 'stop' ends this session's reading only; 'skip' and 'back' move it by a whole paragraph (tag navigation, voxlektor
// 0.4.0). hooks/voxlektor.ts maps each to its vxl subcommand.
export type VoxControl = 'pause' | 'resume' | 'stop' | 'skip' | 'back'

// A daemon that holds voxlektor's lock but does not answer (`vxl status --json`, or the error of a failed order).
export type VoxStuck = { pid: number | null }

// What the band shows besides the dialog: replies queued behind another session (position per voxlektor group, see
// `waitingAhead`), the engine loading, this session's own pause, a daemon-wide hold (the keyboard's pause, `held`),
// whether this session holds the floor, and a daemon that is not up yet (`connecting`).
export type VoxBand = {
  waiting: Readonly<Record<string, number>>
  warming: boolean
  paused: boolean
  held: boolean
  floor: boolean
  connecting: boolean
}

// The setup pane's voxlektor section. `profiles` says whether the installed voxlektor has profiles; pass it on to the
// vxl calls the state leads to: `setupArgv` for needs-model, `sayCommand` for ready.
export type VoxSetupState =
  | { kind: 'unsupported' }
  | { kind: 'needs-uv'; command: string }
  | { kind: 'needs-voxlektor'; command: string }
  // Installing the pinned tag fixes it: the install is older than the tag, or the tag itself with a part missing.
  // `version` is the installed one (undefined: it could not answer the check), `missing` what it lacks.
  | { kind: 'needs-update'; command: string; version: string | undefined; missing: string[] }
  // Inside the range and past the pinned tag, but lacking what this plugin needs: reinstalling the tag would be a
  // downgrade, so no step; the person repairs it.
  | { kind: 'incomplete'; version: string; missing: string[] }
  // Newer than this plugin supports (at or past the range, or another protocol): no step, readings fall back to Edge
  // or a Mac voice. `version` is what to show, e.g. "1.0.0".
  | { kind: 'too-new'; version: string }
  | { kind: 'needs-model'; licenseName: string; licenseUrl: string; commercialUse: boolean; sizeBytes: number; profiles: boolean }
  | { kind: 'needs-profile' }
  // Without profiles: the model is there but `vxl setup` never finished.
  | { kind: 'needs-setup' }
  // `steps` from voxlektor 0.3.0 on; `tagNav`: the install offers tag navigation (0.4.0).
  | {
      kind: 'ready'
      voice: string
      rate: number
      volume: number
      steps: number | undefined
      tuneCommand: string
      profiles: boolean
      tagNav: boolean
    }

declare module 'claude-code' {
  interface PluginState {
    'dialogue-box': {
      isOn: boolean
      dialog: Dialog | null
      queue: Dialog[]
      history: Dialog[]
      rateIndex: number
      primaryLanguage: string
      voiceChoices: Record<string, string>
      edgeVoiceChoices: Record<string, string>
      edgeVoices: EdgeVoice[]
      style: Style
      styleOverride: Style | null
      engine: Engine
      engineOverride: Engine | null
      startOn: boolean
      fallback: string | null
      edgeVoicesStatus: 'idle' | 'loading' | 'ready' | 'failed'
      setupView: SetupView
      // The setup pane's voxlektor section: the state from the last check (null before the first), the command of
      // the step that runs now with its download progress and latest output line, the tail of a failed step, and
      // whether the person asked to see the command instead of having it run.
      voxSetup: VoxSetupState | null
      voxRunning: string | null
      voxProgress: { done: number; total: number } | null
      voxStepLine: string | null
      voxStepError: string | null
      voxCommandShown: boolean
      // A daemon that holds voxlektor's lock but does not answer, from `vxl status --json` or a failed order.
      voxStuck: VoxStuck | null
      // What voxlektor's events say besides the dialog: waiting behind another session, warming, held, connecting.
      voxBand: VoxBand
    }
  }
}
