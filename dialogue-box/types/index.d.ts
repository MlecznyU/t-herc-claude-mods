export type Segment = { language: string; text: string }

export type VoiceQuality = 'premium' | 'enhanced' | 'standard' | 'compact' | 'novelty'

export type Voice = { name: string; language: string; locale: string; quality: VoiceQuality; sample: string }

export type DialogStatus = 'playing' | 'paused' | 'ended'

export type Dialog = { paragraphs: string[]; index: number; language: string; status: DialogStatus }

export type SetupView = 'voices' | 'languages'

declare module 'claude-code' {
  interface PluginState {
    'dialogue-box': {
      isOn: boolean
      dialog: Dialog | null
      rateIndex: number
      primaryLanguage: string
      voiceChoices: Record<string, string>
      setupView: SetupView
    }
  }
}
