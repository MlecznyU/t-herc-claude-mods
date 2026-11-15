export type Segment = { language: string; text: string }

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'compact' | 'novelty'

export type Voice = { name: string; language: string; locale: string; quality: VoiceQuality; sample: string }

export type EdgeVoice = { name: string; language: string; locale: string; gender: string; personalities: string }

export type Style = 'integrated' | 'mirror'

export type Engine = 'edge' | 'mac' | 'voxlektor'

export type DialogStatus = 'playing' | 'paused' | 'ended'

export type Dialog = { id: string; paragraphs: string[]; index: number; language: string; status: DialogStatus }

export type SetupView = 'voices' | 'languages'

export type VoxState = 'COLD' | 'LOADING' | 'WARM' | 'UNLOADING'

// How a tagged paragraph ended. 'unknown' is a reason this plugin does not know yet, which never ends a dialog.
export type VoxReason = 'done' | 'skipped' | 'stopped' | 'replaced' | 'back' | 'error' | 'unknown'

// `owner` is null for daemon-wide events and when voxlektor sent none.
export type VoxEvent =
  | {
      type: 'snapshot'
      state: VoxState
      version: string | undefined
      caps: string[]
      tag: string | undefined
      floorOwner: string | null
      outdated: boolean
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
  features: string[] | undefined
  model: { present: boolean; licenseName: string; licenseUrl: string; commercialUse: boolean; sizeBytes: number } | null
  settings: { voice: string; rate: number; volume: number } | undefined
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

// 'stop' ends this session's reading only; hooks/voxlektor.ts maps each to its vxl subcommand.
export type VoxControl = 'pause' | 'resume' | 'stop'

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
      fallback: string | null
      edgeVoicesStatus: 'idle' | 'loading' | 'ready' | 'failed'
      setupView: SetupView
    }
  }
}
