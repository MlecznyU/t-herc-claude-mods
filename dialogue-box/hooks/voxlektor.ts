import type { SayRequest, VoxCheck, VoxControl, VoxEvent, VoxFound, VoxGroup, VoxReason, VoxState, VoxStuck } from '../types'
import type { PlaybackCommand } from './player'

// voxlektor (https://github.com/MlecznyU/voxlektor): a local neural voice served by a daemon on Apple Silicon.
// Flag and event names follow its v0.4.0 contract (README, docs/protocol.md). Every vxl name this plugin uses lives
// in this file.
//
// Profiles came with voxlektor 0.3.0. Wherever a function takes `profiles`, pass whether `vxl setup --check` lists
// the 'profiles' feature (`supportsProfiles`): with it, readings, warming and setup go to the `claude` profile;
// without it (0.2.x), voxlektor's global settings apply and no profile flag is sent.

export const PROFILE = 'claude'

// What this plugin needs from the installed voxlektor. `vxl setup --check` lists them, so an older install is told
// apart from a daemon that is merely down, never by an exit code.
export const REQUIRED_FEATURES: readonly string[] = ['owners', 'tags', 'warm', 'watch']

const PROFILES_FEATURE = 'profiles'

// Tag navigation (voxlektor 0.4.0): `skip` and `back` with `--unit tag` move by a whole tag, one paragraph here,
// keeping the audio generated ahead. Offered when `vxl setup --check` lists TAG_NAV_FEATURE and the daemon that runs
// is TAG_NAV_MIN_VERSION or newer: an older daemon ignores the unit and moves by a chunk.
export const TAG_NAV_FEATURE = 'tag_nav'
export const TAG_NAV_MIN_VERSION = '0.4.0'
const TAG_UNIT = 'tag'

// The voxlektor versions this plugin speaks to: from VOXLEKTOR_MIN_VERSION up to, not including,
// VOXLEKTOR_BELOW_VERSION. Protocol v1 only grows by additions, so every 0.x release from 0.2.0 on speaks it; 1.0.0
// may break it. Installing and updating both pin VOXLEKTOR_TAG, never main, so an install always lands inside the
// range. A voxlektor past the range is never reinstalled: that would be a downgrade, and dialogue-box is what needs
// the update.
export const VOXLEKTOR_TAG_VERSION = '0.4.1'
export const VOXLEKTOR_TAG = `v${VOXLEKTOR_TAG_VERSION}`
export const VOXLEKTOR_MIN_VERSION = '0.2.0'
export const VOXLEKTOR_BELOW_VERSION = '1.0.0'

// The voxlektor protocol this plugin speaks. A check or snapshot that names another (`protocol`) is too new for it.
export const PROTOCOL_VERSION = 1

const VOXLEKTOR_SOURCE = `git+https://github.com/MlecznyU/voxlektor@${VOXLEKTOR_TAG}`

export const UV_INSTALL_COMMAND = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
// `--reinstall` makes the same command install, update and move an install of another version onto the pinned tag.
export const VOXLEKTOR_INSTALL_COMMAND = `uv tool install --reinstall ${VOXLEKTOR_SOURCE}`
export const VOXLEKTOR_UPDATE_COMMAND = VOXLEKTOR_INSTALL_COMMAND

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

const SUBCOMMANDS: Record<VoxControl, string> = { pause: 'pause', resume: 'resume', stop: 'stop-reading', skip: 'skip', back: 'back' }

// Scoped to the owner so that this session's keys never cut another session's reading off. Skip and back always move
// by a whole tag; send them only with tag navigation (`supportsTagNav` and `daemonNavigatesTags`).
export function controlArgv(vxl: string, control: VoxControl, owner: string): string[] {
  const unit = control === 'skip' || control === 'back' ? [`--unit=${TAG_UNIT}`] : []

  return [vxl, SUBCOMMANDS[control], `--owner=${owner}`, ...unit]
}

// Loads the model, and with profiles prepares the claude profile's voice, so the first reading starts quickly.
export function warmArgv(vxl: string, profiles: boolean): string[] {
  return [vxl, 'warm', ...profileFlags(profiles)]
}

// What the person runs to see what voxlektor reports about itself.
export const VOX_CHECK_COMMAND = 'vxl setup --check'

export function statusArgv(vxl: string): string[] {
  return [vxl, 'status', '--json']
}

// A daemon that holds voxlektor's lock but does not answer; `pid` is null when voxlektor could not tell it.
// Defined in types/index.d.ts (the plugin's state needs it there, and that file may not import).
export type { VoxStuck } from '../types'

// What the person is told about a stuck daemon, and the command that ends it.
export function stuckMessage(stuck: VoxStuck): string {
  return `voxlektor is not answering${stuck.pid === null ? '' : ` (pid ${stuck.pid})`}: run vxl stop`
}

// `vxl say`, `warm` and `watch --start` give a silent lock holder 15 s, then exit 2 with this message on stderr.
const HUNG_ERROR = /a voxlektor daemon(?: \(pid (\d+)\))? holds the lock but does not answer/

export function stuckOfError(stderr: string): VoxStuck | undefined {
  const match = HUNG_ERROR.exec(stderr)

  return match === null ? undefined : { pid: match[1] === undefined ? null : Number(match[1]) }
}

export function watchArgv(vxl: string, owner: string): string[] {
  return [vxl, 'watch', '--json', `--owner=${owner}`]
}

// Run first with `profiles: false`; when that check supports profiles, run it again with `true` for the profile's
// own fields.
export function checkArgv(vxl: string, profiles: boolean): string[] {
  return [vxl, 'setup', '--check', ...profileFlags(profiles)]
}

// Whether `setupArgv` with these options prints its progress as JSON lines for `parseProgress`.
export function reportsProgress(options: { profiles: boolean }): boolean {
  return options.profiles
}

// Headless. Download progress comes as JSON lines (`parseProgress`) only with profiles; without them the output is
// free text, so show the step as running without a bar.
export function setupArgv(vxl: string, options: { acceptLicense: boolean; profiles: boolean }): string[] {
  return [
    vxl,
    'setup',
    '--yes',
    ...(options.profiles ? [`--profile=${PROFILE}`] : []),
    ...(reportsProgress(options) ? ['--progress=json'] : []),
    ...(options.acceptLicense ? ['--accept-model-license'] : []),
  ]
}

export function uvInstallArgv(): string[] {
  return ['/bin/sh', '-c', UV_INSTALL_COMMAND]
}

export function voxlektorInstallArgv(uv: string): string[] {
  return [uv, 'tool', 'install', '--reinstall', VOXLEKTOR_SOURCE]
}

export function voxlektorUpdateArgv(uv: string): string[] {
  return voxlektorInstallArgv(uv)
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
// The protocol version, `protocol` in the CLI's JSON (from 0.3.0): an integer; anything else reads as none.
const protocolOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)

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
    version: typeof data.version === 'string' ? data.version : undefined,
    protocol: protocolOf(data.protocol),
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
          // From 0.3.0: diffusion steps, 4 to 32.
          steps: typeof settings.steps === 'number' && Number.isInteger(settings.steps) ? settings.steps : undefined,
        },
  }
}

// `vxl status --json`: `running` is a daemon process being there; `answering: false` (from 0.3.0) is one that holds
// the lock but does not answer. Undefined when the line is no JSON object.
export function parseStatus(stdout: string): { running: boolean; answering: boolean; pid: number | null } | undefined {
  const data = parseObject(stdout.trim())
  if (data === undefined) return undefined

  return {
    running: data.running === true,
    answering: data.answering !== false,
    pid: typeof data.pid === 'number' && Number.isInteger(data.pid) ? data.pid : null,
  }
}

export function stuckOfStatus(status: ReturnType<typeof parseStatus>): VoxStuck | undefined {
  return status?.running === true && !status.answering ? { pid: status.pid } : undefined
}

export function hasRequiredFeatures(check: VoxCheck): boolean {
  const features = check.features

  return features !== undefined && REQUIRED_FEATURES.every(feature => features.includes(feature))
}

// The leading `major.minor.patch` of a version; anything after it (a pre-release or local part) is ignored.
function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())

  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0)

  return 0
}

// Where a version stands against the compatible range. No version, or one that cannot be read, is an old voxlektor.
export function versionStanding(version: string | undefined): 'older' | 'within' | 'newer' {
  const parts = version === undefined ? undefined : versionParts(version)
  if (parts === undefined || compareParts(parts, versionParts(VOXLEKTOR_MIN_VERSION)!) < 0) return 'older'

  return compareParts(parts, versionParts(VOXLEKTOR_BELOW_VERSION)!) < 0 ? 'within' : 'newer'
}

// Whether a version is past the pinned tag, so that installing the tag over it would be a downgrade.
export function isPastTag(version: string | undefined): boolean {
  const parts = version === undefined ? undefined : versionParts(version)

  return parts !== undefined && compareParts(parts, versionParts(VOXLEKTOR_TAG_VERSION)!) > 0
}

export function isCompatibleVersion(version: string | undefined): boolean {
  return versionStanding(version) === 'within'
}

// No `protocol` is a voxlektor from before it named its protocol (0.2.x), which is v1.
export function speaksProtocol(protocol: number | undefined): boolean {
  return protocol === undefined || protocol === PROTOCOL_VERSION
}

// What this plugin can read with: a version inside the range, its protocol, and every feature it needs.
export function isCompatible(check: VoxCheck): boolean {
  return isCompatibleVersion(check.version) && speaksProtocol(check.protocol) && hasRequiredFeatures(check)
}

export function supportsProfiles(check: VoxCheck): boolean {
  return check.features?.includes(PROFILES_FEATURE) === true
}

// Whether the installed voxlektor offers tag navigation. The daemon that runs may still be an older one, so ask
// `daemonNavigatesTags` too.
export function supportsTagNav(check: VoxCheck): boolean {
  return check.features?.includes(TAG_NAV_FEATURE) === true
}

// Whether the daemon (its `version` from the watcher's snapshot or `vxl status --json`) moves by a tag when told to.
// A pre-release of the first version with it (`0.4.0rc1`, `0.4.0.dev3`) may predate the feature, so it does not count.
export function daemonNavigatesTags(version: string | undefined): boolean {
  const parts = version === undefined ? undefined : versionParts(version)
  if (parts === undefined) return false

  const order = compareParts(parts, versionParts(TAG_NAV_MIN_VERSION)!)

  return order > 0 || (order === 0 && !/^\d+\.\d+\.\d+[.-]?(a|b|c|rc|alpha|beta|pre|preview|dev)/i.test(version!.trim()))
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

// A snapshot group without an owner or a group name is left out.
function voxGroup(value: unknown): VoxGroup[] {
  const data = asObject(value)
  if (data === undefined || typeof data.owner !== 'string' || typeof data.group !== 'string') return []

  const position = typeof data.position === 'number' && Number.isFinite(data.position) ? data.position : null

  return [{ owner: data.owner, group: data.group, position, paused: data.paused === true }]
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
        protocol: protocolOf(data.protocol),
        caps: strings(data.caps),
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        floorOwner: nullableText(asObject(data.floor)?.owner),
        outdated: data.daemon_outdated === true,
        paused: data.paused === true,
        groups: Array.isArray(data.groups) ? data.groups.flatMap(voxGroup) : [],
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
