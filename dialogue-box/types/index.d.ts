export type Segment = { language: string; text: string }

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'compact' | 'novelty'

export type Voice = { name: string; language: string; locale: string; quality: VoiceQuality; sample: string }

export type EdgeVoice = { name: string; language: string; locale: string; gender: string; personalities: string }

export type Style = 'integrated' | 'mirror'

export type Engine = 'edge' | 'mac'

export type DialogStatus = 'playing' | 'paused' | 'ended'

export type Dialog = { id: string; paragraphs: string[]; index: number; language: string; status: DialogStatus }

export type SetupView = 'voices' | 'languages'

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
