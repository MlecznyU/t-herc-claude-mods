import type { SayRequest, VoxCheck, VoxControl, VoxEvent, VoxFound, VoxReason, VoxState } from '../types'
import type { PlaybackCommand } from './player'

// voxlektor (https://github.com/MlecznyU/voxlektor): a local neural voice served by a daemon on Apple Silicon.
// Flag and event names follow its S1 contract (queue and events). Every vxl name this plugin uses lives in this file.
//
// Profiles come later in voxlektor (S3). Wherever a function takes `profiles`, pass whether `vxl setup --check` lists
// the 'profiles' feature (`supportsProfiles`): with it, readings and setup go to the `claude` profile; without it,
// voxlektor's global settings apply and no profile flag is sent.

export const PROFILE = 'claude'

// What this plugin needs from the installed voxlektor. `vxl setup --check` lists them, so an older install is told
// apart from a daemon that is merely down, never by an exit code.
export const REQUIRED_FEATURES: readonly string[] = ['owners', 'tags', 'warm', 'watch']

const PROFILES_FEATURE = 'profiles'

const VOXLEKTOR_SOURCE = 'git+https://github.com/MlecznyU/voxlektor'

export const UV_INSTALL_COMMAND = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
export const VOXLEKTOR_INSTALL_COMMAND = `uv tool install ${VOXLEKTOR_SOURCE}`
export const VOXLEKTOR_UPDATE_COMMAND = 'uv tool upgrade voxlektor'

// What the person runs in a terminal to tune the voice this plugin reads with.
export function tuneCommand(profiles: boolean): string {
  return profiles ? `vxl setup --profile ${PROFILE}` : 'vxl setup'
}

const profileFlags = (profiles: boolean): string[] => (profiles ? [`--profile=${PROFILE}`] : [])

// Prints `vxl=<path>` and `uv=<path>` for what it finds, nothing for what is missing. The host PATH may miss
// ~/.local/bin, where `uv tool install` puts vxl and the uv installer puts uv, and /opt/homebrew/bin, where brew does.
export const FIND_VOXLEKTOR = [
  '/bin/sh',
  '-c',
  'for c in vxl "$HOME/.local/bin/vxl"; do p=$(command -v "$c") && { echo "vxl=$p"; break; }; done; for c in uv "$HOME/.local/bin/uv" /opt/homebrew/bin/uv; do p=$(command -v "$c") && { echo "uv=$p"; break; }; done; exit 0',
]

export function parseFound(stdout: string): VoxFound {
  const found: VoxFound = { vxl: undefined, uv: undefined }

  for (const line of stdout.split('\n')) {
    const path = line.slice(line.indexOf('=') + 1).trim()
    if (path === '') continue
    if (line.startsWith('vxl=')) found.vxl = path
    else if (line.startsWith('uv=')) found.uv = path
  }

  return found
}

// voxlektor accepts rates from 0.5 to 3. Rounded so that 1.1 * 3 does not come out as 3.3000000000000003. A broken
// profile rate reads as 1 and a broken multiplier as 1, so a bad value never reaches vxl as NaN.
export function voxRate(profileRate: number, multiplier: number): number {
  const base = Number.isFinite(profileRate) ? profileRate : 1
  const times = Number.isFinite(multiplier) ? multiplier : 1

  return Math.round(Math.min(3, Math.max(0.5, base * times)) * 100) / 100
}

// The text goes on standard input, so a paragraph that starts with a dash is not read as an option. `now` replaces this
// owner's own reading; `preempt` takes the floor from another owner and is only for a button the person presses. The
// play-now press sends both, so this session's queued reading is replaced, not read twice.
export function sayCommand(vxl: string, request: SayRequest, profiles: boolean): PlaybackCommand {
  const { owner, group, tag, text, now, preempt, rate } = request
  const flags = [...profileFlags(profiles), `--owner=${owner}`, `--group=${group}`, `--tag=${tag}`, `--rate=${rate}`]

  return { argv: [vxl, 'say', ...flags, ...(now ? ['--now'] : []), ...(preempt ? ['--preempt'] : [])], input: text }
}

const SUBCOMMANDS: Record<VoxControl, string> = { pause: 'pause', resume: 'resume', stop: 'stop-reading' }

// Scoped to the owner so that this session's keys never cut another session's reading off.
export function controlArgv(vxl: string, control: VoxControl, owner: string): string[] {
  return [vxl, SUBCOMMANDS[control], `--owner=${owner}`]
}

// Warming is daemon-wide, so it names no profile.
export function warmArgv(vxl: string): string[] {
  return [vxl, 'warm']
}

export function watchArgv(vxl: string, owner: string): string[] {
  return [vxl, 'watch', '--json', `--owner=${owner}`]
}

// Run first with `profiles: false`; when that check supports profiles, run it again with `true` for the profile's
// own fields.
export function checkArgv(vxl: string, profiles: boolean): string[] {
  return [vxl, 'setup', '--check', ...profileFlags(profiles)]
}

// Headless. Download progress comes as JSON lines (`parseProgress`) only with profiles; without them the output is
// free text, so show the step as running without a bar.
export function setupArgv(vxl: string, options: { acceptLicense: boolean; profiles: boolean }): string[] {
  return [
    vxl,
    'setup',
    '--yes',
    ...(options.profiles ? [`--profile=${PROFILE}`, '--progress=json'] : []),
    ...(options.acceptLicense ? ['--accept-model-license'] : []),
  ]
}

export function uvInstallArgv(): string[] {
  return ['/bin/sh', '-c', UV_INSTALL_COMMAND]
}

export function voxlektorInstallArgv(uv: string): string[] {
  return [uv, 'tool', 'install', VOXLEKTOR_SOURCE]
}

export function voxlektorUpdateArgv(uv: string): string[] {
  return [uv, 'tool', 'upgrade', 'voxlektor']
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function parseObject(text: string): Json | undefined {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])

export function parseCheck(stdout: string): VoxCheck | undefined {
  const data = parseObject(stdout)
  if (data === undefined) return undefined

  const model = asObject(data.model)
  const settings = asObject(data.settings)
  const rate = settings?.rate

  return {
    ready: data.ready === true,
    setupCompleted: data.setup_completed === true,
    profileExists: data.profile_exists === true,
    features: Array.isArray(data.features) ? strings(data.features) : undefined,
    model: model === undefined
      ? null
      : {
          present: model.present === true,
          licenseName: text(model.license_name),
          licenseUrl: text(model.license_url),
          commercialUse: model.commercial_use === true,
          sizeBytes: number(model.size_bytes),
        },
    settings: settings === undefined
      ? undefined
      : {
          voice: text(settings.voice),
          rate: typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1,
          volume: number(settings.volume),
        },
  }
}

export function hasRequiredFeatures(check: VoxCheck): boolean {
  const features = check.features

  return features !== undefined && REQUIRED_FEATURES.every(feature => features.includes(feature))
}

export function supportsProfiles(check: VoxCheck): boolean {
  return check.features?.includes(PROFILES_FEATURE) === true
}

const STATES: readonly string[] = ['COLD', 'LOADING', 'WARM', 'UNLOADING']
const REASONS: readonly VoxReason[] = ['done', 'skipped', 'stopped', 'replaced', 'back', 'error']

function voxState(value: unknown): VoxState {
  return STATES.includes(value as string) ? (value as VoxState) : 'COLD'
}

// No reason means the tag played to its end; a reason added later must not end a dialog by mistake.
function voxReason(value: unknown): VoxReason {
  if (value === undefined || value === null) return 'done'

  return REASONS.find(reason => reason === value) ?? 'unknown'
}

// An event name this plugin does not know is ignored, as the voxlektor contract asks of its clients.
export function parseEvent(line: string): VoxEvent | undefined {
  const data = parseObject(line)
  if (data === undefined) return undefined

  const owner = nullableText(data.owner)

  switch (data.event) {
    case 'snapshot':
      return {
        type: 'snapshot',
        state: voxState(data.state),
        version: typeof data.version === 'string' ? data.version : undefined,
        caps: strings(data.caps),
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        floorOwner: nullableText(asObject(data.floor)?.owner),
        outdated: data.daemon_outdated === true,
      }
    case 'state':
      return { type: 'state', state: voxState(data.state) }
    case 'tag_started':
      return { type: 'tag_started', owner, tag: text(data.tag) }
    case 'tag_finished':
      return { type: 'tag_finished', owner, tag: text(data.tag), reason: voxReason(data.reason) }
    case 'drained':
    case 'paused':
    case 'resumed':
      return { type: data.event, owner }
    case 'waiting':
      return { type: 'waiting', owner, group: nullableText(data.group), position: number(data.position) }
    case 'floor':
      return { type: 'floor', owner, group: nullableText(data.group) }
    case 'error':
      return { type: 'error', owner, code: text(data.code), message: text(data.message) }
    case 'daemon_off':
    case 'disconnected':
      return { type: data.event }
    default:
      return undefined
  }
}

export function parseProgress(line: string): { done: number; total: number } | 'done' | { error: string } | undefined {
  const data = parseObject(line)

  switch (data?.event) {
    case 'download':
      return { done: number(data.done), total: number(data.total) }
    case 'done':
      return 'done'
    case 'error':
      return { error: text(data.message) }
    default:
      return undefined
  }
}

// Output arrives in chunks that end anywhere; a line is complete only at its newline.
export class LineBuffer {
  private rest = ''

  push(chunk: string): string[] {
    const lines = (this.rest + chunk).split('\n')
    this.rest = lines.pop() ?? ''

    return lines.filter(line => line.trim() !== '')
  }

  flush(): string[] {
    const rest = this.rest
    this.rest = ''

    return rest.trim() === '' ? [] : [rest]
  }
}

// voxlektor takes owners matching [A-Za-z0-9._:-]{1,64} and reserves `cli`; groups and tags up to 128 characters.
const OWNER_PREFIX = 'dlg-'
const OWNER_LIMIT = 64
const GROUP_LIMIT = 96
const GROUP_KEPT = 87

// FNV-1a over UTF-16 code units, 8 hex digits: enough to keep two long ids of one session apart.
function hash(value: string): string {
  let state = 0x811c9dc5
  for (let i = 0; i < value.length; i++) state = Math.imul(state ^ value.charCodeAt(i), 0x01000193) >>> 0

  return state.toString(16).padStart(8, '0')
}

// This session's owner id, from the Claude session id (or any random string when there is none). The prefix keeps it
// from ever being `cli`.
export function ownerFor(sessionId: string): string {
  return `${OWNER_PREFIX}${sessionId.replace(/[^A-Za-z0-9._:-]/g, '-')}`.slice(0, OWNER_LIMIT)
}

// The voxlektor group of a dialog: its percent-encoded id, so it has no colon, shortened with a hash past the limit.
// Tags carry the same group, so the two are always derived the same way.
export function groupOf(dialogId: string): string {
  const encoded = encodeURIComponent(dialogId)

  return encoded.length <= GROUP_LIMIT ? encoded : `${encoded.slice(0, GROUP_KEPT)}~${hash(dialogId)}`
}

// `<group>:<epoch>:<index>`. The epoch counts this session's readings, so events of a reading it has since replaced
// are told apart from the current one even though the dialog and paragraph are the same.
export function encodeTag(dialogId: string, index: number, epoch: number): string {
  return `${groupOf(dialogId)}:${epoch}:${index}`
}

export function decodeTag(tag: string): { group: string; epoch: number; index: number } | undefined {
  const match = /^([^:]+):(\d+):(\d+)$/.exec(tag)
  if (match === null) return undefined

  return { group: match[1]!, epoch: Number(match[2]), index: Number(match[3]) }
}

// spike: removed in Task 5 (register.tsx still reads the spike's single-reading flow)
export const VOXLEKTOR_INSTALL_HINT =
  'For the voxlektor voice install it: uv tool install git+https://github.com/MlecznyU/voxlektor, then run vxl setup.'

// spike: removed in Task 5
const SPEAK_SCRIPT = `
vxl=$1
shift
"$vxl" say --now "$@" || exit $?
while :; do
  status=$("$vxl" status --json) || exit 2
  case $status in
    *'"running": false'*) exit 2 ;;
  esac
  case $status in
    *'"queued": 0,'*'"playing": false,'*'"paused": false'*) exit 0 ;;
  esac
  /bin/sleep 0.25
done
`

// spike: removed in Task 5
export function voxlektorSpeakArgv(vxl: string, language: string, rate: number): string[] {
  const lang = language === 'pl' || language === 'en' ? language : 'auto'

  return ['/bin/sh', '-c', SPEAK_SCRIPT, 'dialogue-box', vxl, `--lang=${lang}`, `--rate=${Math.min(3, Math.max(0.5, rate))}`]
}

// spike: removed in Task 5
export function voxlektorStopArgv(vxl: string): string[] {
  return [vxl, 'stop-reading']
}

// spike: removed in Task 5. Reads the old finder's single path line, which the new `vxl=` lines replace.
export function parseVoxlektorExecutable(stdout: string): string | undefined {
  return parseFound(stdout).vxl
}
