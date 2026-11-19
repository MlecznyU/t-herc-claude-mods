import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { Dialog, EdgeVoice, Engine, Style, Voice } from '../types'
import type { Screen } from './arrivals'
import { isFromPerson, onArrive, onClose, onDismissAll, onNextReply, onPreviousReply } from './arrivals'
import { nextParagraph, pause, previousParagraph, startDialog, togglePause } from './dialog'
import {
  EDGE_INSTALL_HINT,
  EDGE_TIMEOUT_MS,
  edgeRenderArgv,
  edgeVoicesFor,
  FIND_EDGE,
  isMultilingual,
  listEdgeVoicesArgv,
  parseEdgeExecutable,
  parseEdgeVoices,
  resolveEdgeVoice,
  sampleText,
  shortName,
} from './edge'
import type { PlaybackCommand, VoicedText } from './player'
import { CREATE_RENDER_DIRECTORY, LIST_VOICES, liveCommand, READ_SYSTEM_LOCALE, renderArgv, sampleCommand } from './player'
import {
  DEFAULT_RATE_INDEX,
  DEFAULT_STYLE,
  displayText,
  extractSpoken,
  RATES,
  SPOKEN_OFF_INSTRUCTION,
  spokenInstruction,
  splitSegments,
  STYLES,
  wordsPerMinute,
} from './speech'
import {
  checkArgv,
  controlArgv,
  daemonNavigatesTags,
  encodeTag,
  FIND_VOXLEKTOR,
  groupOf,
  LineBuffer,
  ownerFor,
  parseCheck,
  parseEvent,
  parseFound,
  parseProgress,
  parseStatus,
  reportsProgress,
  sayCommand,
  setupArgv,
  speaksProtocol,
  statusArgv,
  stuckMessage,
  stuckOfError,
  stuckOfStatus,
  supportsProfiles,
  uvInstallArgv,
  VOX_CHECK_COMMAND,
  VOXLEKTOR_MIN_VERSION,
  VOXLEKTOR_TAG,
  voxlektorInstallArgv,
  voxlektorUpdateArgv,
  voxRate,
  warmArgv,
  watchArgv,
} from './voxlektor'
import type { VoxStuck } from './voxlektor'
import type { StopFence, TagTrail, VoxOrder } from './voxlektor-reading'
import {
  applyEvent,
  endStopped,
  fenceSaid,
  fenceStopped,
  INITIAL_BAND,
  lateStart,
  navigationFor,
  NO_STOP,
  NO_TRAIL,
  ordersFor,
  respawnDelay,
  trailAfter,
  trailFollows,
  trailMoved,
  settledDialog,
  trailReplaced,
  waitingAhead,
} from './voxlektor-reading'
import type { VoxSetupState, VoxStep } from './voxlektor-setup'
import { commandFor, defaultEngine as engineDefault, licenseLine, notReadyReason, setupState, stepFor } from './voxlektor-setup'
import {
  languageName,
  languagesWithVoices,
  needsBetterVoice,
  normalizeLanguage,
  parseVoices,
  recommendation,
  resolveVoice,
  SYSTEM_VOICE,
  voicesFor,
} from './voices'

const ENGINES: readonly Engine[] = ['edge', 'mac', 'voxlektor']

const isOn = atom({ plugin: 'dialogue-box', key: 'isOn' } as const, false)
const dialog = atom({ plugin: 'dialogue-box', key: 'dialog' } as const, null)
const queue = atom({ plugin: 'dialogue-box', key: 'queue' } as const, [])
const history = atom({ plugin: 'dialogue-box', key: 'history' } as const, [])
const rateIndex = atom({ plugin: 'dialogue-box', key: 'rateIndex' } as const, DEFAULT_RATE_INDEX)
const primaryLanguage = atom({ plugin: 'dialogue-box', key: 'primaryLanguage' } as const, 'en')
const voiceChoices = atom({ plugin: 'dialogue-box', key: 'voiceChoices' } as const, {})
const edgeVoiceChoices = atom({ plugin: 'dialogue-box', key: 'edgeVoiceChoices' } as const, {})
const edgeVoices = atom({ plugin: 'dialogue-box', key: 'edgeVoices' } as const, [])
const defaultStyle = atom({ plugin: 'dialogue-box', key: 'style' } as const, DEFAULT_STYLE)
const styleOverride = atom({ plugin: 'dialogue-box', key: 'styleOverride' } as const, null)
const defaultEngine = atom({ plugin: 'dialogue-box', key: 'engine' } as const, 'edge')
const engineOverride = atom({ plugin: 'dialogue-box', key: 'engineOverride' } as const, null)
const fallback = atom({ plugin: 'dialogue-box', key: 'fallback' } as const, null)
const edgeVoicesStatus = atom({ plugin: 'dialogue-box', key: 'edgeVoicesStatus' } as const, 'idle')
const setupView = atom({ plugin: 'dialogue-box', key: 'setupView' } as const, 'voices')
const voxSetup = atom({ plugin: 'dialogue-box', key: 'voxSetup' } as const, null)
const voxRunning = atom({ plugin: 'dialogue-box', key: 'voxRunning' } as const, null)
const voxProgress = atom({ plugin: 'dialogue-box', key: 'voxProgress' } as const, null)
const voxStepLine = atom({ plugin: 'dialogue-box', key: 'voxStepLine' } as const, null)
const voxStepError = atom({ plugin: 'dialogue-box', key: 'voxStepError' } as const, null)
const voxCommandShown = atom({ plugin: 'dialogue-box', key: 'voxCommandShown' } as const, false)
const voxBand = atom({ plugin: 'dialogue-box', key: 'voxBand' } as const, INITIAL_BAND)
const startOn = atom({ plugin: 'dialogue-box', key: 'startOn' } as const, false)
const voxStuck = atom({ plugin: 'dialogue-box', key: 'voxStuck' } as const, null)

const STORE_KEYS = {
  rateIndex: 'rateIndex',
  primaryLanguage: 'primaryLanguage',
  voiceChoices: 'voiceChoices',
  edgeVoiceChoices: 'edgeVoiceChoices',
  edgeVoices: 'edgeVoices',
  style: 'style',
  engine: 'engine',
  startOn: 'startOn',
}
const STATUS = '🔊 dialogue'
const USAGE = 'Usage: /dialogue on | off | stop | previous | setup | style integrated|mirror | engine edge|mac|voxlektor'
const NOT_AVAILABLE = 'dialogue-box needs macOS: it speaks through the system `say` command, which is not available here.'
const SETUP_PANE = 'dialogue-box-setup'
const VOICES_SHOWN_PER_LANGUAGE = 6
const EDGE_VOICES_SHOWN = 8
const PERSON_PROMPTS_KEPT = 5
// The first uvx run downloads edge-tts.
const LIST_EDGE_VOICES_TIMEOUT_MS = 90_000
const STYLE_LABELS: Record<Style, string> = {
  integrated: 'Integrated · speech leads, the written reply is a board it points at',
  mirror: 'Mirror · the written reply is complete, speech sums it up',
}
const ENGINE_LABELS: Record<Engine, string> = {
  edge: 'Edge neural voices · online, a Mac voice reads when Edge is unreachable',
  mac: 'Mac voices only · offline',
  voxlektor: 'voxlektor · local neural voice (Apple Silicon), Edge or a Mac voice reads when it fails',
}
const VOX_CHECK_TIMEOUT_MS = 15_000
// `vxl warm` asks the daemon to load the model and may start the daemon first.
const VOX_WARM_TIMEOUT_MS = 120_000
// `vxl say` may start the daemon before it queues the paragraph, and gives a daemon that holds the lock without
// answering 15 s before it exits 2 naming it; a control gives up after 5 s. Just above that, so that voxlektor's own
// message is what the person sees, and never long enough to hold a reply.
const VOX_ORDER_TIMEOUT_MS = 20_000
// `vxl status --json` gives a silent lock holder 2 s before it answers `answering: false`.
const VOX_STATUS_TIMEOUT_MS = 5_000
const VOX_STUCK_RECHECK_MS = 3_000
// How long a paragraph stopped from outside waits for a `disconnected` before the dialog ends.
const VOX_STOP_SETTLE_MS = 1_000
const VOX_ERROR_LINES = 5
const VOX_SAMPLE_GROUP = 'dialogue-box-sample'
const VOX_STEP_LABELS: Record<VoxStep, string> = {
  'install-uv': 'Install uv',
  'install-voxlektor': 'Install voxlektor',
  update: 'Update voxlektor',
  download: 'Accept & download',
  'create-profile': 'Create the claude profile',
  'finish-setup': 'Finish voxlektor setup',
}

let installedVoices: Voice[] = []
let canSpeak = false
let edgeExecutable: string[] | undefined
// Set by the first failed Edge render, so the rest of the reply goes straight to the Mac voice instead of waiting on
// the network for every paragraph; the next reply tries Edge again.
let edgeDown = false
let voxlektorExecutable: string | undefined
// Like edgeDown: set by the first failed voxlektor reading, so the rest of the reply goes to Edge or the Mac voice;
// the next reply tries voxlektor again.
let voxlektorDown = false
// This session's voxlektor owner (`ownerFor`), set at session start; every reading and control carries it.
let voxOwner: string | undefined
// The reading epoch `ordersFor` hands back: events of an earlier reading never move the screen.
let voxEpoch = 0
// Whether voxlektor may still hold something of this session's, so leaving voxlektor stops it there.
let voxActive = false
// Whether this session ever sent voxlektor a paragraph: the session end then stops this owner whatever else was
// pending (an owner stop on an idle owner changes nothing).
let voxUsed = false
// A rate change made while paused, read again once playback resumes.
let rateDirty = false
// The version of the daemon the watcher is subscribed to (its snapshot), undefined while there is none: tag
// navigation needs a daemon of 0.4.0 or newer, whatever the installed CLI offers.
let voxDaemonVersion: string | undefined
// Which readings this session stopped, so one that starts after the stop anyway is stopped once more.
let voxFence: StopFence = NO_STOP
// What voxlektor's tag history holds of the reply on screen and which tag moves are on their way (`TagTrail`).
let voxTrail: TagTrail = NO_TRAIL
// `vxl watch` for the session, respawned with a backoff when it ends; failures count the respawns since an event.
let watcher: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let watcherFailures = 0
let respawnTimer: Timer | undefined
// A paragraph stopped from outside ends the dialog unless a disconnect follows: the timer that waits for it.
let pendingStop: Timer | undefined
// The orders still to send to voxlektor, apart from the presenting chain so that keys, the typing pause and watcher
// events never wait for a slow `vxl say`. Two lanes, each one order at a time and in order: the paragraphs (`say`)
// and the controls (pause, resume, stop). A control never waits behind a `say` on its way; a stop kills that `say`
// instead. Each order carries the epoch it was planned in; one whose epoch is no longer `voxEpoch` belongs to a
// replaced reading and is dropped. `quiet`: a failure is not this reply's (the stop after leaving voxlektor).
type PendingOrder = { order: VoxOrder; epoch: number; vxl: string; owner: string; profiles: boolean; quiet?: boolean }
// Why an order failed, and the daemon that holds the lock without answering when that is the cause.
type OrderFailure = { reason: string; stuck: VoxStuck | undefined }
// An order on its way; `cancel` kills its vxl, which then counts as neither done nor failed.
type RunningOrder = { pending: PendingOrder; done: Promise<OrderFailure | undefined>; cancel: () => Promise<void>; cancelled: boolean }
let pendingSays: PendingOrder[] = []
let pendingControls: PendingOrder[] = []
let sayInFlight: RunningOrder | undefined
let controlInFlight: RunningOrder | undefined
let saying = false
let controlling = false
// Settles when the control lane has sent everything it had; the say lane waits for it before each paragraph.
let controlsDone: Promise<void> = Promise.resolve()
// Bumped whenever the paragraphs still to send are dropped, so a paragraph taken off the lane before that is dropped too.
let sayCut = 0
// Settles once every `say` killed so far has ended: a stop goes out only after that.
let cancelling: Promise<void> = Promise.resolve()
// Whether the setup pane shows a daemon that does not answer (`voxStuck`), so clearing it writes only when needed.
let stuckShown = false
// A watcher snapshot named a protocol other than ours; kept for the session, so a check again shows too-new.
let voxProtocolSeen: number | undefined
let playback: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sample: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let sampleGeneration = 0
let presenting: Promise<void> = Promise.resolve()
// The turns that answer the person: the one their prompt was typed over, and the one it started (found by its text).
const personTurns = new Set<string>()
let personPrompts: string[] = []
const toastedFallbacks = new Set<string>()
// Bumped on every start and stop, so a paragraph that was cut short does not advance the dialog.
let generation = 0
// A session that started on by the start-on setting has not told the model yet; its first prompt does.
let isStartInstructionPending = false
let renderDirectory: Promise<string | undefined> | undefined
let renderCount = 0
// Bumped when the renders are discarded: a render that fails after that failed because its directory went away, not
// because Edge did.
let renderEpoch = 0
// The engine the person chose in the pane, kept across sessions. Without it the engine follows `engineDefault`
// (voxlektor when ready, Edge where found, else Mac), and a Mac voice reading is no fallback to warn about.
let storedEngine: Engine | undefined
let voxUv: string | undefined
// The owner of the pane's voxlektor sample, apart from this session's readings, so a sample never replaces them.
let voxSampleOwner: string | undefined
const renders = new Map<string, Promise<string | undefined>>()

// An owner id for a session that names no id of its own.
function randomId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0')
}

async function loadVoices($: EngineInterface) {
  const listing = await $.process.run(LIST_VOICES).catch(() => undefined)
  canSpeak = listing?.exitCode === 0
  installedVoices = canSpeak && listing !== undefined ? parseVoices(listing.stdout) : []
}

async function findEdge($: EngineInterface) {
  const found = await $.process.run(FIND_EDGE).catch(() => undefined)
  edgeExecutable = found?.exitCode === 0 ? parseEdgeExecutable(found.stdout) : undefined
}

async function runCheck($: EngineInterface, vxl: string, profiles: boolean) {
  const result = await $.process.run(checkArgv(vxl, profiles), { timeoutMs: VOX_CHECK_TIMEOUT_MS }).catch(() => undefined)

  return { checkExit: result?.exitCode, check: result === undefined ? undefined : parseCheck(result.stdout) }
}

async function applyDefaultEngine($: EngineInterface) {
  const voxReady = (await read($, voxSetup))?.kind === 'ready'
  await update($, defaultEngine, () => engineDefault({ stored: storedEngine, voxReady, edgeFound: edgeExecutable !== undefined }))
}

// Finds vxl and uv, checks voxlektor, and stores what stands in the way of its voice (`voxSetup`). Run at session
// start, on pane open, on `/dialogue engine voxlektor` and after each setup step.
async function refreshVoxlektor($: EngineInterface) {
  const [finder, uname] = await Promise.all([
    $.process.run(FIND_VOXLEKTOR).catch(() => undefined),
    $.process.run(['uname', '-m']).catch(() => undefined),
  ])
  const found = finder?.exitCode === 0 ? parseFound(finder.stdout) : { vxl: undefined, uv: undefined }
  voxlektorExecutable = found.vxl
  voxUv = found.uv

  let checked: { checkExit: number | undefined; check: ReturnType<typeof parseCheck> } = { checkExit: undefined, check: undefined }
  if (found.vxl !== undefined) {
    checked = await runCheck($, found.vxl, false)
    if (checked.check !== undefined && supportsProfiles(checked.check)) checked = await runCheck($, found.vxl, true)
    if (checked.check !== undefined && voxProtocolSeen !== undefined) checked.check = { ...checked.check, protocol: voxProtocolSeen }
  }

  const arch = uname?.exitCode === 0 ? uname.stdout : ''
  await update($, voxSetup, () => setupState({ arch, found, ...checked }))
  await applyDefaultEngine($)
  // Not awaited: a daemon that does not answer takes `vxl status` 2 s to tell.
  if (found.vxl !== undefined) void checkStuck($, found.vxl).catch(() => undefined)
}

// Shows (or clears) a daemon that holds the lock without answering in the setup pane.
async function setStuck($: EngineInterface, stuck: VoxStuck | undefined) {
  if (stuck === undefined && !stuckShown) return

  stuckShown = stuck !== undefined
  await update($, voxStuck, () => stuck ?? null)
}

// The daemon's status, or undefined when it cannot be read.
async function readStatus($: EngineInterface, vxl: string) {
  const result = await $.process.run(statusArgv(vxl), { timeoutMs: VOX_STATUS_TIMEOUT_MS }).catch(() => undefined)

  return result?.exitCode === 0 ? parseStatus(result.stdout) : undefined
}

// A daemon still binding its socket also reads as not answering for its first seconds, so a stuck status is shown
// only when the status asked again VOX_STUCK_RECHECK_MS later agrees.
async function checkStuck($: EngineInterface, vxl: string) {
  const status = await readStatus($, vxl)
  if (status === undefined) return
  if (stuckOfStatus(status) === undefined) {
    await setStuck($, undefined)
    return
  }
  $.clock.after(VOX_STUCK_RECHECK_MS, () => {
    void readStatus($, vxl)
      .then(again => (again === undefined ? undefined : setStuck($, stuckOfStatus(again))))
      .catch(() => undefined)
  })
}

// Loads the model while the first reply is written. Only while dialogue is on with voxlektor ready; never awaited.
// A daemon that does not answer makes `vxl warm` exit naming it: the person hears of it now, not at the first reply.
async function warmIfReading($: EngineInterface) {
  const vxl = voxlektorExecutable
  if (vxl === undefined || !(await read($, isOn)) || (await engineOf($)) !== 'voxlektor') return
  const setup = await read($, voxSetup)
  if (setup?.kind !== 'ready') return

  void $.process
    .run(warmArgv(vxl, setup.profiles), { timeoutMs: VOX_WARM_TIMEOUT_MS })
    .then(async result => {
      const stuck = result.exitCode === 0 ? undefined : stuckOfError(result.stderr)
      if (result.exitCode !== 0 && stuck === undefined) return
      await setStuck($, stuck)
      if (stuck !== undefined) await announceOnce($, stuckMessage(stuck))
    })
    .catch(() => undefined)
  ensureWatcher($)
}

// What a voxlektor reading needs, when this reply is read through voxlektor: the engine chosen, voxlektor ready and
// not failed during this reply.
async function voxlektorReading($: EngineInterface) {
  const vxl = voxlektorExecutable
  const owner = voxOwner
  const setup = await read($, voxSetup)
  if (voxlektorDown || vxl === undefined || owner === undefined || setup?.kind !== 'ready') return undefined
  if ((await engineOf($)) !== 'voxlektor') return undefined

  return { vxl, owner, setup }
}

// Starts `vxl watch` for this session unless it runs or waits to respawn. Its events go through the same chain as
// the person's keys, one at a time and in order.
function ensureWatcher($: EngineInterface) {
  const vxl = voxlektorExecutable
  const owner = voxOwner
  if (watcher !== undefined || respawnTimer !== undefined || vxl === undefined || owner === undefined) return

  const stream = $.process.spawn({ argv: watchArgv(vxl, owner) })
  watcher = stream
  void (async () => {
    const lines = new LineBuffer()
    try {
      for await (const chunk of stream) {
        if (chunk.stream !== 'stdout') continue
        for (const line of lines.push(chunk.text)) {
          const event = parseEvent(line)
          if (event === undefined) {
            $.ui.log(`dialogue-box: voxlektor watch line ignored: ${line}`, { to: 'debug' })
            continue
          }
          // Only a snapshot is a real subscription; a watcher that only says `disconnected` or `daemon_off` keeps
          // backing off. A snapshot also means the daemon answers.
          if (event.type === 'snapshot') {
            watcherFailures = 0
            voxDaemonVersion = event.version
            void setStuck($, undefined).catch(() => undefined)
          }
          // The daemon is gone; the next snapshot names the one that comes up.
          if (event.type === 'disconnected' || event.type === 'daemon_off') voxDaemonVersion = undefined
          // Whether voxlektor holds every order sent is sampled as the line arrives, not when the event's turn on the
          // presenting chain comes: a snapshot taken before a `say` landed must not read as that reading being over.
          void onVoxEvent($, event, voxActive && ordersSettled()).catch(() => undefined)
        }
      }
    } catch (error) {
      $.ui.log(`dialogue-box: voxlektor watch failed: ${String(error)}`, { to: 'debug' })
    }
    // Stopped on purpose (session end), or replaced already.
    if (watcher !== stream) return

    watcher = undefined
    voxDaemonVersion = undefined
    const delay = respawnDelay(watcherFailures)
    watcherFailures += 1
    respawnTimer = $.clock.after(delay, () => {
      respawnTimer = undefined
      ensureWatcher($)
    })
  })().catch(() => {
    if (watcher === stream) watcher = undefined
  })
}

async function stopWatcher() {
  const current = watcher
  watcher = undefined
  voxDaemonVersion = undefined
  respawnTimer?.cancel()
  respawnTimer = undefined
  pendingStop?.cancel()
  pendingStop = undefined
  // Not awaited: the session's end has a short bound, and the child dies with its stream.
  void current?.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
}

// Spawns one order's vxl, so that it can be killed: by a stop while it is on its way, or after VOX_ORDER_TIMEOUT_MS.
// A failure that names a daemon holding the lock without answering, or one that gave no answer or exited 2 (service
// unavailable) while the status shows such a daemon, carries it.
function startOrder($: EngineInterface, pending: PendingOrder): RunningOrder {
  const { order, vxl, owner, profiles } = pending
  const command: PlaybackCommand = order.kind === 'say' ? sayCommand(vxl, order.request, profiles) : { argv: controlArgv(vxl, order.control, owner) }
  const what = order.kind === 'say' ? 'say' : order.control
  const stream = $.process.spawn(command.input === undefined ? { argv: command.argv } : { argv: command.argv, input: command.input })
  let ended: (end: { code: number | null; stderr: string }) => void = () => undefined
  // A killed child may never report how it ended: its kill is its end then.
  const killedEnd = new Promise<{ code: number | null; stderr: string }>(resolve => (ended = resolve))
  let killing: Promise<void> | undefined
  const kill = () =>
    (killing ??= stream
      .return({ code: null, signal: 'SIGTERM' })
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => ended({ code: null, stderr: '' })))
  let timedOut = false
  const timer = $.clock.after(VOX_ORDER_TIMEOUT_MS, () => {
    timedOut = true
    void kill()
  })
  const exited = (async () => {
    let code: number | null = null
    let stderr = ''
    try {
      for (;;) {
        const next = await stream.next()
        if (next.done === true) {
          code = next.value.code
          break
        }
        if (next.value.stream === 'stderr') stderr += next.value.text
      }
    } catch (error) {
      stderr += String(error)
    }
    return { code, stderr }
  })()

  const running: RunningOrder = {
    pending,
    cancelled: false,
    cancel: async () => {
      running.cancelled = true
      await kill()
    },
    done: Promise.race([exited, killedEnd]).then(async ({ code, stderr }) => {
      timer.cancel()
      if (running.cancelled || code === 0) return undefined

      // A control's exit 2 is mostly a daemon not up yet ("voxlektor is not running": controls never start one, and a
      // status then may call a daemon still binding its socket not answering), so only a `say`, which starts the
      // daemon and gives it 15 s, or an order that gave no answer at all asks the status.
      const asks = timedOut || (code === 2 && order.kind === 'say')
      const stuck = stuckOfError(stderr) ?? (asks ? stuckOfStatus(await readStatus($, vxl)) : undefined)
      if (stuck !== undefined) return { reason: stuckMessage(stuck), stuck }
      if (timedOut) return { reason: `${what} gave no answer in ${VOX_ORDER_TIMEOUT_MS / 1000} s`, stuck }

      const detail = stderr.trim().split('\n').pop() ?? ''

      return { reason: `${what} exited ${String(code ?? 'early')}${detail === '' ? '' : `: ${detail}`}`, stuck }
    }),
  }

  return running
}

type VoxReading = NonNullable<Awaited<ReturnType<typeof voxlektorReading>>>

const isAppend = (order: VoxOrder) => order.kind === 'say' && !order.request.now
const isNow = (order: VoxOrder) => order.kind === 'say' && order.request.now

// Queues orders for the two lanes. A paragraph waits its turn on the say lane. A control goes out at once on the
// control lane, never behind a `say` on its way. A stop also drops the paragraphs still to send and kills the one on
// its way, and goes out once that one has ended, so nothing of the reading lands after it. A pause or resume sent
// while the `now` that starts a reading is still to land (which lifts the owner's pause) is sent again right after
// that `now`, ahead of the paragraphs appended to it (an append keeps the pause).
function enqueueOrders($: EngineInterface, reading: VoxReading, orders: readonly VoxOrder[]) {
  const { vxl, owner, setup } = reading
  pendingSays = pendingSays.filter(pending => pending.epoch === voxEpoch)
  for (const order of orders) {
    const pending: PendingOrder = { order, epoch: voxEpoch, vxl, owner, profiles: setup.profiles }
    if (order.kind === 'say') {
      pendingSays.push(pending)
      voxFence = fenceSaid(voxFence, voxEpoch, order.request.group)
      voxActive = true
      voxUsed = true
      continue
    }
    if (order.control === 'stop') {
      voxFence = fenceStopped(voxFence)
      void cancelSays()
    }
    pendingControls.push(pending)
    if (order.control !== 'stop' && nowOnItsWay()) {
      let at = pendingSays.length
      while (at > 0 && isAppend(pendingSays[at - 1]!.order)) at -= 1
      pendingSays.splice(at, 0, pending)
    }
  }
  startLanes($)
}

// Whether the `now` that starts the current reading has not landed yet.
function nowOnItsWay(): boolean {
  const flying = sayInFlight
  const inFlight = flying !== undefined && !flying.cancelled && flying.pending.epoch === voxEpoch && isNow(flying.pending.order)

  return inFlight || pendingSays.some(pending => isNow(pending.order))
}

function startLanes($: EngineInterface) {
  if (!controlling && pendingControls.length > 0) controlsDone = runControls($).catch(() => undefined)
  if (!saying && pendingSays.length > 0) void runSays($).catch(() => undefined)
}

// The say lane: one paragraph after another, each after the controls sent before it. A failure of the current
// reading drops the rest of that reading and hands it to the fallback; a failure of a reading already replaced
// leaves the newer reading's orders alone.
async function runSays($: EngineInterface) {
  saying = true
  try {
    for (let next = pendingSays.shift(); next !== undefined; next = pendingSays.shift()) {
      if (next.epoch !== voxEpoch) continue
      // A control sent again after the `now` before it.
      if (next.order.kind === 'control') {
        pendingControls.push(next)
        startLanes($)
        continue
      }

      const cut = sayCut
      while (controlling) await controlsDone
      if (next.epoch !== voxEpoch || cut !== sayCut) continue

      const running = startOrder($, next)
      sayInFlight = running
      const failure = await running.done
      sayInFlight = undefined
      if (running.cancelled) continue
      if (failure === undefined) {
        // Not awaited: a control copy at the head of the lane must move on before anything else can be queued.
        void setStuck($, undefined).catch(() => undefined)
        continue
      }
      orderFailed($, next, failure)
    }
  } finally {
    saying = false
  }
}

// The control lane: one control after another, each once the `say` a stop killed has ended.
async function runControls($: EngineInterface) {
  controlling = true
  try {
    for (let next = pendingControls.shift(); next !== undefined; next = pendingControls.shift()) {
      if (next.epoch !== voxEpoch) continue
      await cancelling
      if (next.epoch !== voxEpoch) continue

      const running = startOrder($, next)
      controlInFlight = running
      const failure = await running.done
      controlInFlight = undefined
      if (running.cancelled) continue
      // A failed control never hands the reading to the fallback: it goes out at once, so it may reach a daemon that
      // is still starting ("not running"), where a stop has nothing to stop and a pause sent during the `now` follows
      // that `now` again. A daemon that is really broken fails the say lane. Only a hang voxlektor names is shown.
      if (failure === undefined) void setStuck($, undefined).catch(() => undefined)
      else if (failure.stuck !== undefined) void setStuck($, failure.stuck).catch(() => undefined)
      if (next.order.kind === 'control' && next.order.control === 'stop') {
        voxActive = sayInFlight !== undefined || pendingSays.some(pending => pending.order.kind === 'say')
      }
    }
  } finally {
    controlling = false
  }
}

// A failed order of the current reading drops the rest of that reading and hands it to the fallback, through the
// presenting chain, unless the reading was replaced meanwhile. A daemon that does not answer shows in the pane either
// way.
function orderFailed($: EngineInterface, pending: PendingOrder, failure: OrderFailure) {
  if (failure.stuck !== undefined) void setStuck($, failure.stuck).catch(() => undefined)
  if (pending.quiet === true || pending.epoch !== voxEpoch) return

  pendingSays = pendingSays.filter(other => other.epoch !== pending.epoch)
  pendingControls = pendingControls.filter(other => other.epoch !== pending.epoch)
  const run = presenting.then(async () => {
    if (pending.epoch === voxEpoch && (await voxlektorReading($)) !== undefined) await voxlektorFailed($, failure)
  })
  presenting = run.catch(() => undefined)
}

// Drops the paragraphs still to send and kills the one on its way. Settles once it has ended.
function cancelSays(): Promise<void> {
  pendingSays = []
  sayCut += 1
  const flying = sayInFlight
  if (flying !== undefined && !flying.cancelled) cancelling = Promise.all([cancelling, flying.cancel()]).then(() => undefined)

  return cancelling
}

// Drops every order still to send and kills those on their way, for leaving voxlektor. Settles once they have ended.
function cancelOrders(): Promise<void> {
  pendingControls = []
  const flying = controlInFlight
  if (flying !== undefined && !flying.cancelled) cancelling = Promise.all([cancelling, flying.cancel()]).then(() => undefined)

  return cancelSays()
}

// The stop that ends what voxlektor still holds of this session's, after the orders `cancelOrders` killed.
function sendStop($: EngineInterface) {
  const vxl = voxlektorExecutable
  const owner = voxOwner
  if (vxl === undefined || owner === undefined) return

  pendingControls.push({ order: { kind: 'control', control: 'stop' }, epoch: voxEpoch, vxl, owner, profiles: false, quiet: true })
  startLanes($)
}

// Whether a tag skip or back has not returned yet: voxlektor may not have taken it (only these controls are skip/back).
const isTagMove = (pending: PendingOrder | undefined) =>
  pending?.order.kind === 'control' && (pending.order.control === 'skip' || pending.order.control === 'back')
const tagMoving = () => pendingControls.some(isTagMove) || isTagMove(controlInFlight?.pending)

// Whether voxlektor has every order this session sent: none queued, none on its way.
const ordersSettled = () =>
  pendingSays.length === 0 && pendingControls.length === 0 && sayInFlight === undefined && controlInFlight === undefined

// Tells voxlektor what a change made by the person or by an arriving reply means. The orders go to the order runner,
// so this returns at once. Never for a screen an event produced (`onVoxEvent`): a moved cursor would read as a skip.
async function orderVoxlektor(
  $: EngineInterface,
  reading: VoxReading,
  before: Screen,
  after: Screen,
  options: PresentOptions,
) {
  const { owner, setup } = reading
  if (options.reread && after.current?.status !== 'playing') rateDirty = true
  const planned = ordersFor({
    owner,
    before,
    after,
    profileRate: setup.rate,
    multiplier: RATES[await read($, rateIndex)] ?? 1,
    preempt: options.preempt === true,
    reread: options.reread === true || (rateDirty && after.current?.status === 'playing'),
    epoch: voxEpoch,
  })
  if (planned.epoch !== voxEpoch) {
    voxEpoch = planned.epoch
    voxTrail = trailReplaced(voxTrail)
    rateDirty = false
    pendingStop?.cancel()
    pendingStop = undefined
  }
  if (planned.orders.length > 0) {
    ensureWatcher($)
    enqueueOrders($, reading, planned.orders)
  }
}

// The box's resume while a hold from outside keeps this session's playing reply silent: the owner resume, which
// voxlektor takes as lifting the hold when this session holds the floor.
function liftHold($: EngineInterface): Promise<void> {
  const run = presenting.then(async () => {
    const reading = await voxlektorReading($)
    if (reading !== undefined && (await read($, voxBand)).held) enqueueOrders($, reading, [{ kind: 'control', control: 'resume' }])
  })
  presenting = run.catch(() => undefined)

  return run
}

// Whether Edge can take over a voxlektor reading in this language.
async function edgeCanRead($: EngineInterface, language: string) {
  return !edgeDown && edgeExecutable !== undefined && (await edgeVoiceOf($, language)) !== undefined
}

// What the band and the toast say when voxlektor fails for this reply. A daemon that does not answer is named with
// the command that ends it.
function fallbackNotice(edge: boolean, failure: OrderFailure): string {
  const voice = edge ? 'Edge voice' : 'Mac voice'
  if (failure.stuck !== undefined) {
    return `${voice}: ${stuckMessage(failure.stuck)}. ${edge ? 'Edge reads' : 'A Mac voice reads'} the rest of this reply.`
  }

  return `${voice}: voxlektor failed (${failure.reason}), so ${edge ? 'Edge reads' : 'a Mac voice reads'} the rest of this reply.`
}

// voxlektor lost this session's reading: it is stopped there, and Edge (else a Mac voice) reads on from the paragraph
// on screen for the rest of this reply. Runs inside the presenting chain, and never waits on voxlektor: the orders on
// their way are killed and the stop goes out on the control lane after them.
async function voxlektorFailed($: EngineInterface, failure: OrderFailure) {
  voxlektorDown = true
  // Whatever the failed reading still reports never moves the screen again.
  voxEpoch += 1
  voxTrail = trailReplaced(voxTrail)
  pendingStop?.cancel()
  pendingStop = undefined
  voxFence = fenceStopped(voxFence)
  void cancelOrders()
  sendStop($)
  voxActive = false
  await update($, voxBand, band => ({ ...band, waiting: {}, warming: false, connecting: false }))

  const current = await read($, dialog)
  await announceFallback($, fallbackNotice(await edgeCanRead($, current?.language ?? (await read($, primaryLanguage))), failure))
  await silence($)
  if (current?.status === 'playing') await speakCurrent($, current)
}

// A watcher event, applied to the band and, while voxlektor reads this reply, to the screen. Never turned into orders.
// `settled`: whether voxlektor held every order of this session's when the event's line arrived.
function onVoxEvent($: EngineInterface, event: Parameters<typeof applyEvent>[0]['event'], settled: boolean): Promise<void> {
  const run = presenting.then(async () => {
    const owner = voxOwner
    if (owner === undefined) return

    // A reading this session stopped started anyway (a killed `say` applied after the stop): stop it once more, also
    // after leaving voxlektor, and never let it move the screen or the band.
    const late = lateStart(voxFence, event, owner)
    voxFence = late.fence
    if (late.late === 'restop') sendStop($)
    if (late.late !== undefined) return

    const before: Screen = { current: await read($, dialog), queue: await read($, queue), history: await read($, history) }
    const follow = trailFollows(voxTrail, before)
    const moving = tagMoving()
    const applied = applyEvent({ screen: before, band: await read($, voxBand), event, owner, epoch: voxEpoch, settled, follow, moving })
    voxTrail = trailAfter({ trail: voxTrail, screen: before, event, owner, epoch: voxEpoch, moving })
    await update($, voxBand, () => applied.band)
    // A daemon of another protocol: voxlektor is too new for this session (after the fallback below, which needs the
    // reading to still count as voxlektor's).
    if (event.type === 'snapshot' && !speaksProtocol(event.protocol)) {
      voxProtocolSeen = event.protocol
      const version = `${event.version ?? 'unknown version'} (protocol v${String(event.protocol)})`
      const reading = await voxlektorReading($)
      if (reading !== undefined && applied.failed !== undefined) await voxlektorFailed($, { reason: applied.failed, stuck: undefined })
      await update($, voxSetup, (): VoxSetupState => ({ kind: 'too-new', version }))
      await stopWatcher()
      return
    }
    if ((await voxlektorReading($)) === undefined) return

    if (applied.screen !== before) {
      await update($, queue, () => applied.screen.queue)
      await update($, history, () => applied.screen.history)
      await update($, dialog, () => applied.screen.current)
      // voxlektor moved on to the next reply: its fallback state starts afresh.
      if (applied.screen.current?.id !== before.current?.id) await startFresh($)
    }
    if (applied.failed !== undefined) {
      await voxlektorFailed($, { reason: applied.failed, stuck: undefined })
      return
    }
    if (applied.stopped) {
      const epoch = voxEpoch
      pendingStop?.cancel()
      pendingStop = $.clock.after(VOX_STOP_SETTLE_MS, () => {
        pendingStop = undefined
        void endStoppedReading($, epoch).catch(() => undefined)
      })
    }
  })
  presenting = run.catch(error => {
    try {
      $.ui.log(`dialogue-box: voxlektor event failed: ${String(error)}`, { to: 'debug' })
    } catch {
      // the session is gone
    }
  })

  return run
}

// A paragraph stopped from outside (a keyboard `vxl stop-reading`) with no disconnect after it: the reading is over.
function endStoppedReading($: EngineInterface, epoch: number): Promise<void> {
  const run = presenting.then(async () => {
    if (epoch !== voxEpoch || (await voxlektorReading($)) === undefined) return

    const current = await read($, dialog)
    const ended = endStopped({ current, queue: [], history: [] }).current
    if (ended !== current) await update($, dialog, () => ended)
    voxActive = false
  })
  presenting = run.catch(() => undefined)

  return run
}

async function loadEdgeVoices($: EngineInterface) {
  if (edgeExecutable === undefined || (await read($, edgeVoicesStatus)) === 'loading') return

  await update($, edgeVoicesStatus, () => 'loading')
  const listing = await $.process
    .run(listEdgeVoicesArgv(edgeExecutable), { timeoutMs: LIST_EDGE_VOICES_TIMEOUT_MS })
    .catch(() => undefined)
  const voices = listing?.exitCode === 0 ? parseEdgeVoices(listing.stdout) : []
  if (voices.length === 0) {
    await update($, edgeVoicesStatus, () => 'failed')
    return
  }

  await update($, edgeVoices, () => voices)
  await update($, edgeVoicesStatus, () => 'ready')
  await $.store.set(STORE_KEYS.edgeVoices, voices)
}

async function styleOf($: EngineInterface): Promise<Style> {
  return (await read($, styleOverride)) ?? (await read($, defaultStyle))
}

async function engineOf($: EngineInterface): Promise<Engine> {
  return (await read($, engineOverride)) ?? (await read($, defaultEngine))
}

async function voiceOf($: EngineInterface, language: string) {
  return resolveVoice(installedVoices, await read($, voiceChoices), language)
}

async function edgeVoiceOf($: EngineInterface, language: string) {
  return resolveEdgeVoice(await read($, edgeVoices), await read($, edgeVoiceChoices), language)
}

// The band shows why a Mac voice reads while the person asked for Edge; each reason is also toasted once a session.
async function announceFallback($: EngineInterface, reason: string) {
  await update($, fallback, () => reason)
  await announceOnce($, reason)
}

async function announceOnce($: EngineInterface, text: string) {
  if (toastedFallbacks.has(text)) return

  toastedFallbacks.add(text)
  await $.ui.toast(text)
}

// Edge reads for the Edge engine, and for voxlektor once it failed during this reply; only a chosen Edge warns about
// what keeps Edge from reading, since a voxlektor fallback already said why voxlektor does not.
async function usableEdgeVoice($: EngineInterface, language: string) {
  const engine = await engineOf($)
  if (edgeDown || !(engine === 'edge' || (engine === 'voxlektor' && voxlektorDown))) return undefined
  if (edgeExecutable === undefined) {
    if (engine === 'edge' && (storedEngine !== undefined || (await read($, engineOverride)) !== null)) {
      await announceFallback($, `Mac voice: edge-tts is not installed. ${EDGE_INSTALL_HINT}`)
    }
    return undefined
  }

  const voice = await edgeVoiceOf($, language)
  if (voice !== undefined || engine !== 'edge') return voice

  const reason =
    (await read($, edgeVoices)).length === 0
      ? 'Mac voice: the Edge voice list has not loaded yet (no network?).'
      : `Mac voice: Edge has no ${languageName(language)} voice.`
  await announceFallback($, reason)
  return undefined
}

async function silence($: EngineInterface) {
  generation += 1
  const current = playback
  playback = undefined
  await current?.return({ code: null, signal: 'SIGTERM' })
}

// Edge or a Mac voice is about to read: whatever voxlektor still holds of this session's must not read over it. The
// orders on their way are killed and the stop follows them on the control lane, so the presenting chain never waits
// on a slow or stuck daemon.
async function leaveVoxlektor($: EngineInterface) {
  if (!voxActive || voxlektorExecutable === undefined || voxOwner === undefined) return

  voxActive = false
  voxEpoch += 1
  voxTrail = trailReplaced(voxTrail)
  voxFence = fenceStopped(voxFence)
  void cancelOrders()
  sendStop($)
}

async function discardRenders($: EngineInterface) {
  const pending = renderDirectory
  renderDirectory = undefined
  renders.clear()
  renderEpoch += 1
  const directory = await pending
  if (directory !== undefined) await $.process.run(['rm', '-rf', directory]).catch(() => undefined)
}

function renderFile($: EngineInterface, key: string, extension: string, argv: (out: string) => string[], timeoutMs: number) {
  const existing = renders.get(key)
  if (existing !== undefined) return existing

  renderDirectory ??= $.process
    .run(CREATE_RENDER_DIRECTORY)
    .then(({ exitCode, stdout }) => (exitCode === 0 ? stdout.trim() : undefined))
    .catch(() => undefined)
  const directory = renderDirectory
  renderCount += 1
  const name = `${renderCount}.${extension}`
  const rendering: Promise<string | undefined> = directory
    .then(async path => {
      if (path === undefined) return undefined
      const out = `${path}/${name}`
      const { exitCode } = await $.process.run(argv(out), { timeoutMs })
      return exitCode === 0 ? out : undefined
    })
    .catch(() => undefined)
    .then(file => {
      // A failure is not kept, so the next request tries again.
      if (file === undefined && renders.get(key) === rendering) renders.delete(key)
      return file
    })
  renders.set(key, rendering)

  return rendering
}

async function voicedParts($: EngineInterface, current: Dialog, index: number): Promise<VoicedText[]> {
  const segments = splitSegments(current.paragraphs[index] ?? '', current.language)

  return Promise.all(segments.map(async segment => ({ voice: await voiceOf($, segment.language), text: segment.text })))
}

async function renderMac($: EngineInterface, current: Dialog, index: number, rate: number) {
  const parts = await voicedParts($, current, index)
  if (parts.length < 2) return undefined

  return renderFile($, `mac:${rate}:${JSON.stringify(parts)}`, 'aiff', out => renderArgv(out, parts, rate), 60_000)
}

async function edgeFailed($: EngineInterface) {
  if (edgeDown) return

  edgeDown = true
  await announceFallback($, 'Mac voice: Edge did not answer (offline or blocked), so a Mac voice reads the rest of this reply.')
}

// Resolves the file to play, or undefined when the paragraph is spoken live by `say`.
async function renderParagraph($: EngineInterface, current: Dialog, index: number, rateStep: number) {
  const paragraph = current.paragraphs[index]
  if (paragraph === undefined) return undefined

  const edgeVoice = await usableEdgeVoice($, current.language)
  if (edgeVoice !== undefined && edgeExecutable !== undefined) {
    const epoch = renderEpoch
    const executable = edgeExecutable
    const rate = RATES[rateStep] ?? 1
    const text = displayText(paragraph)
    const file = await renderFile(
      $,
      `edge:${edgeVoice}:${rate}:${text}`,
      'mp3',
      out => edgeRenderArgv(executable, out, edgeVoice, text, rate),
      EDGE_TIMEOUT_MS,
    )
    if (file !== undefined) return file
    if (epoch !== renderEpoch) return undefined
    await edgeFailed($)
  }

  return renderMac($, current, index, wordsPerMinute(rateStep))
}

async function startFresh($: EngineInterface) {
  edgeDown = false
  voxlektorDown = false
  await update($, fallback, () => null)
}

// Playback reaching an end, a reply arriving and a key press each read the screen and write it back; run one at a time
// so none of them loses a dialog the other queued.
// `reread`: read the current paragraph again although nothing moved (a rate change, back). `preempt`: the play-now
// press, which takes the floor from another session. Both matter to voxlektor only.
// `move`: the skip or back key, which voxlektor's tag navigation can carry out without a re-read.
type PresentOptions = { reread?: boolean; preempt?: boolean; move?: 'skip' | 'back' }

// Whether voxlektor can move this session's reading by a tag: the install and the running daemon offer it, every
// paragraph has been handed over (a skip past the last one sent would drain the group), and no rate change waits.
function canNavigateByTag(reading: VoxReading): boolean {
  return (
    reading.setup.tagNav &&
    daemonNavigatesTags(voxDaemonVersion) &&
    !rateDirty &&
    pendingSays.length === 0 &&
    sayInFlight === undefined
  )
}

function present($: EngineInterface, transition: (screen: Screen) => Screen, options: PresentOptions = {}): Promise<void> {
  const run = presenting.then(async () => {
    const before: Screen = { current: await read($, dialog), queue: await read($, queue), history: await read($, history) }
    const moved = transition(before)
    const isFresh = moved.current === null || moved.current.id !== before.current?.id
    // The next reply tries voxlektor again.
    if (isFresh) voxlektorDown = false
    const reading = await voxlektorReading($)
    // Skip or back through tag navigation: the box moves at once and waits (⏳) for voxlektor's tag_started.
    const navigation =
      reading === undefined
        ? undefined
        : navigationFor({
            before,
            after: moved,
            move: options.move,
            tagNav: canNavigateByTag(reading),
            floor: (await read($, voxBand)).floor,
            trail: voxTrail,
          })
    if (reading !== undefined && navigation !== undefined && before.current !== null && options.move !== undefined) {
      voxTrail = trailMoved(voxTrail, before.current.id, options.move, before.current.pending !== true)
      const target = moved.current
      // An ended box (skip on the last paragraph) waits for nothing more.
      await update($, dialog, () => (target === null || target.status === 'ended' ? target : { ...target, pending: true }))
      ensureWatcher($)
      enqueueOrders($, reading, [navigation])
      return
    }
    const after = moved
    if (reading !== undefined) {
      // A fallback reading of the reply before may still play.
      await silence($)
      await update($, queue, () => after.queue)
      await update($, history, () => after.history)
      await update($, dialog, () => after.current)
      if (isFresh) {
        await discardRenders($)
        await startFresh($)
      }
      const epoch = voxEpoch
      await orderVoxlektor($, reading, before, after, options)
      // A new reading from the box's paragraph: what the box shows is what voxlektor reads now.
      if (voxEpoch !== epoch) await update($, dialog, current => (current === null ? current : settledDialog(current)))
      return
    }

    await silence($)
    await leaveVoxlektor($)
    await update($, queue, () => after.queue)
    await update($, history, () => after.history)
    await update($, dialog, () => (after.current === null ? null : settledDialog(after.current)))
    if (isFresh) {
      await discardRenders($)
      await startFresh($)
    }
    // voxlektor chosen but not ready (or no longer found): this reply goes to Edge or a Mac voice, as on a failure.
    if (!voxlektorDown && after.current?.status === 'playing' && (await engineOf($)) === 'voxlektor') {
      voxlektorDown = true
      const why = notReadyReason(await read($, voxSetup))
      await announceFallback($, `${(await edgeCanRead($, after.current.language)) ? 'Edge' : 'Mac'} voice: ${why}`)
    }
    if (after.current?.status === 'playing') await speakCurrent($, after.current)
  })
  presenting = run.catch(() => undefined)

  return run
}

async function apply($: EngineInterface, transition: (current: Dialog) => Dialog) {
  await present($, screen => (screen.current === null ? screen : onClose({ ...screen, current: transition(screen.current) })))
}

async function nextReply($: EngineInterface) {
  await present($, onNextReply)
}

async function previousReply($: EngineInterface) {
  await present($, onPreviousReply)
}

async function closeAll($: EngineInterface) {
  await present($, onDismissAll)
}

async function speakCurrent($: EngineInterface, current: Dialog) {
  const mine = generation
  const rateStep = await read($, rateIndex)
  const rendering = renderParagraph($, current, current.index, rateStep)
  void renderParagraph($, current, current.index + 1, rateStep)
  const parts = await voicedParts($, current, current.index)
  const [only] = parts
  const live =
    parts.length === 1 && only !== undefined
      ? only
      : { voice: await voiceOf($, current.language), text: displayText(current.paragraphs[current.index] ?? '') }

  // The loop owns the child: it keeps playing after the hook returns, until it ends or silence() closes it.
  void (async () => {
    const file = await rendering
    if (mine !== generation) return

    const stream = $.process.spawn(file === undefined ? liveCommand(live, wordsPerMinute(rateStep)) : { argv: ['afplay', file] })
    playback = stream
    try {
      for await (const _ of stream) {
        // the player writes nothing worth reading
      }
    } catch (error) {
      $.ui.log(`dialogue-box: playback failed: ${String(error)}`, { to: 'debug' })
      return
    }
    if (mine !== generation) return

    playback = undefined
    await apply($, nextParagraph)
  })().catch(() => undefined)
}

async function changeRate($: EngineInterface, step: number) {
  const next = Math.min(RATES.length - 1, Math.max(0, (await read($, rateIndex)) + step))
  await update($, rateIndex, () => next)
  await $.store.set(STORE_KEYS.rateIndex, next)

  await present($, screen => screen, { reread: true })
}

async function skip($: EngineInterface) {
  await present($, screen => (screen.current === null ? screen : onClose({ ...screen, current: nextParagraph(screen.current) })), { move: 'skip' })
}

// Back restarts the paragraph even on the first one, where the cursor does not move. With voxlektor's tag navigation
// the box shows the paragraph before at once (⏳); voxlektor decides, and partway through a paragraph it restarts it
// instead, which the box then follows.
async function back($: EngineInterface) {
  await present($, screen => (screen.current === null ? screen : onClose({ ...screen, current: previousParagraph(screen.current) })), {
    reread: true,
    move: 'back',
  })
}

// The play-now press: this session's reply takes the floor from the session speaking, from the paragraph on screen.
async function playNow($: EngineInterface) {
  await present($, screen => screen, { preempt: true })
}

async function settingsSummary($: EngineInterface) {
  const primary = await read($, primaryLanguage)
  const languages = primary === 'en' ? ['en'] : [primary, 'en']
  const macVoices = await Promise.all(
    languages.map(async language => `${languageName(language)} → ${(await voiceOf($, language)) ?? 'system voice'}`),
  )
  const edgeVoice = await edgeVoiceOf($, primary)
  const chosen = await engineOf($)
  const vox = await read($, voxSetup)
  const engine =
    chosen === 'voxlektor' && vox?.kind === 'ready'
      ? `voxlektor voice ${vox.voice} (tune it: ${vox.tuneCommand}), Mac voices as backup: ${macVoices.join(', ')}`
      : chosen === 'voxlektor'
        ? `${notReadyReason(vox)} Mac voices: ${macVoices.join(', ')}`
        : chosen === 'edge' && edgeExecutable !== undefined && edgeVoice !== undefined
        ? `Edge voice ${edgeVoice}, Mac voices as backup: ${macVoices.join(', ')}`
        : `Mac voices: ${macVoices.join(', ')}`

  return `Style: ${await styleOf($)}. ${engine}. Run /dialogue setup to change them.`
}

function isStyle(value: unknown): value is Style {
  return STYLES.some(style => style === value)
}

function isEngine(value: unknown): value is Engine {
  return ENGINES.some(engine => engine === value)
}

function isEdgeVoice(value: unknown): value is EdgeVoice {
  if (typeof value !== 'object' || value === null) return false

  const fields: Record<string, unknown> = { ...value }
  return ['name', 'language', 'locale', 'gender', 'personalities'].every(key => typeof fields[key] === 'string')
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function restoreSettings($: EngineInterface) {
  const storedRate = await $.store.get(STORE_KEYS.rateIndex)
  if (typeof storedRate === 'number' && storedRate >= 0 && storedRate < RATES.length) {
    await update($, rateIndex, () => storedRate)
  }

  const storedChoices = stringRecord(await $.store.get(STORE_KEYS.voiceChoices))
  if (storedChoices !== undefined) await update($, voiceChoices, () => storedChoices)

  const storedEdgeChoices = stringRecord(await $.store.get(STORE_KEYS.edgeVoiceChoices))
  if (storedEdgeChoices !== undefined) await update($, edgeVoiceChoices, () => storedEdgeChoices)

  const storedEdgeVoices = await $.store.get(STORE_KEYS.edgeVoices)
  if (Array.isArray(storedEdgeVoices)) await update($, edgeVoices, () => storedEdgeVoices.filter(isEdgeVoice))

  const storedStyle = await $.store.get(STORE_KEYS.style)
  if (isStyle(storedStyle)) await update($, defaultStyle, () => storedStyle)

  const storedStartOn = await $.store.get(STORE_KEYS.startOn)
  await update($, startOn, () => storedStartOn === true)

  // The engine atom itself is set by applyDefaultEngine once voxlektor and Edge have been looked for.
  const engine = await $.store.get(STORE_KEYS.engine)
  storedEngine = isEngine(engine) ? engine : undefined

  const storedPrimary = await $.store.get(STORE_KEYS.primaryLanguage)
  if (typeof storedPrimary === 'string' && storedPrimary !== '') {
    await update($, primaryLanguage, () => storedPrimary)
    return
  }
  const locale = await $.process.run(READ_SYSTEM_LOCALE).catch(() => undefined)
  const systemLanguage = locale?.exitCode === 0 ? normalizeLanguage(locale.stdout) : ''
  if (systemLanguage !== '') await update($, primaryLanguage, () => systemLanguage)
}

async function openSetup($: EngineInterface) {
  await update($, setupView, () => 'voices')
  await Promise.all([findEdge($), refreshVoxlektor($)])
  await applyDefaultEngine($)
  void loadEdgeVoices($).catch(() => undefined)
  return $.ui.open({ id: SETUP_PANE, title: 'Voice setup', focus: true, closeOnEscape: true, holdToasts: true })
}

async function stopSample($: EngineInterface) {
  sampleGeneration += 1
  const current = sample
  sample = undefined
  await current?.return({ code: null, signal: 'SIGTERM' })

  // A voxlektor sample plays in its daemon, after `vxl say` has returned.
  const owner = voxSampleOwner
  voxSampleOwner = undefined
  if (owner !== undefined && voxlektorExecutable !== undefined) {
    await $.process.run(controlArgv(voxlektorExecutable, 'stop', owner)).catch(() => undefined)
  }
}

function spawnSample($: EngineInterface, command: PlaybackCommand) {
  const stream = $.process.spawn(command)
  sample = stream
  void (async () => {
    for await (const _ of stream) {
      // the player writes nothing worth reading
    }
  })().catch(() => undefined)
}

async function playSample($: EngineInterface, voice: Voice) {
  await stopSample($)
  spawnSample($, sampleCommand({ voice: voice.name, text: voice.sample || voice.name }))
}

// `--preempt`, so ▶ plays even while another session speaks; `--now`, so a second press replaces the first sample.
async function playVoxlektorSample($: EngineInterface, state: Extract<VoxSetupState, { kind: 'ready' }>, language: string) {
  await stopSample($)
  const vxl = voxlektorExecutable
  if (vxl === undefined) return

  const owner = ownerFor(`${await $.session.id().catch(() => 'session')}.sample`)
  const request = {
    owner,
    group: groupOf(VOX_SAMPLE_GROUP),
    tag: encodeTag(VOX_SAMPLE_GROUP, 0, 0),
    text: sampleText(language),
    now: true,
    preempt: true,
    rate: voxRate(state.rate, 1),
  }
  voxSampleOwner = owner
  spawnSample($, sayCommand(vxl, request, state.profiles))
}

async function playEdgeSample($: EngineInterface, voice: EdgeVoice, language: string) {
  await stopSample($)
  const mine = sampleGeneration
  const epoch = renderEpoch
  const executable = edgeExecutable
  if (executable === undefined) return

  const text = sampleText(language)
  const file = await renderFile(
    $,
    `sample:${voice.name}:${text}`,
    'mp3',
    out => edgeRenderArgv(executable, out, voice.name, text, 1),
    LIST_EDGE_VOICES_TIMEOUT_MS,
  )
  if (mine !== sampleGeneration || epoch !== renderEpoch) return
  if (file === undefined) {
    await $.ui.toast('Edge voice unreachable: no sample.')
    return
  }
  spawnSample($, { argv: ['afplay', file] })
}

async function choosePrimary($: EngineInterface, language: string) {
  await update($, primaryLanguage, () => language)
  await $.store.set(STORE_KEYS.primaryLanguage, language)
  await update($, setupView, () => 'voices')
}

async function chooseVoice($: EngineInterface, language: string, name: string) {
  const next = { ...(await read($, voiceChoices)), [language]: name }
  await update($, voiceChoices, () => next)
  await $.store.set(STORE_KEYS.voiceChoices, next)
}

async function chooseEdgeVoice($: EngineInterface, language: string, name: string) {
  const next = { ...(await read($, edgeVoiceChoices)), [language]: name }
  await update($, edgeVoiceChoices, () => next)
  await $.store.set(STORE_KEYS.edgeVoiceChoices, next)
}

async function chooseStartOn($: EngineInterface, value: boolean) {
  await update($, startOn, () => value)
  await $.store.set(STORE_KEYS.startOn, value)
}

async function chooseStyle($: EngineInterface, style: Style) {
  await update($, defaultStyle, () => style)
  await update($, styleOverride, () => null)
  await $.store.set(STORE_KEYS.style, style)
}

async function chooseEngine($: EngineInterface, engine: Engine) {
  const before = await readerOf($)
  edgeDown = false
  voxlektorDown = false
  await update($, fallback, () => null)
  await update($, defaultEngine, () => engine)
  await update($, engineOverride, () => null)
  await $.store.set(STORE_KEYS.engine, engine)
  storedEngine = engine
  await engineChangedFrom($, before)
}

// Who reads the reply on screen: the engine, and whether it has fallen back during this reply.
async function readerOf($: EngineInterface) {
  const engine = await engineOf($)

  return { engine, fellBack: engine === 'voxlektor' ? voxlektorDown : edgeDown }
}

// Choosing the engine already reading changes nothing; choosing it again after it fell back tries it again.
async function engineChangedFrom($: EngineInterface, before: Awaited<ReturnType<typeof readerOf>>) {
  if ((await engineOf($)) !== before.engine || before.fellBack) await engineChanged($)
}

// The reply on screen goes on with the new engine from the paragraph it is at: leaving voxlektor stops its copy there
// (and its watcher, which `ensureWatcher` starts again when voxlektor next reads), coming to it reads from here.
async function engineChanged($: EngineInterface) {
  if ((await engineOf($)) !== 'voxlektor') await stopWatcher()
  await present($, screen => screen, { reread: true })
  await warmIfReading($)
}

function stepArgv(step: VoxStep, state: VoxSetupState): string[] | undefined {
  const vxl = voxlektorExecutable
  switch (step) {
    case 'install-uv':
      return uvInstallArgv()
    case 'install-voxlektor':
      return voxUv === undefined ? undefined : voxlektorInstallArgv(voxUv)
    case 'update':
      return voxUv === undefined ? undefined : voxlektorUpdateArgv(voxUv)
    case 'download':
      return vxl === undefined ? undefined : setupArgv(vxl, { acceptLicense: true, profiles: state.kind === 'needs-model' && state.profiles })
    case 'create-profile':
      return vxl === undefined ? undefined : setupArgv(vxl, { acceptLicense: false, profiles: true })
    case 'finish-setup':
      return vxl === undefined ? undefined : setupArgv(vxl, { acceptLicense: false, profiles: false })
  }
}

// Whether the step's setup run reports its progress as JSON lines.
function stepReportsProgress(step: VoxStep, state: VoxSetupState): boolean {
  if (step === 'create-profile') return reportsProgress({ profiles: true })

  return step === 'download' && state.kind === 'needs-model' && reportsProgress({ profiles: state.profiles })
}

// Runs a step only on the person's press, in the background: the pane stays usable and shows the command, its
// progress and, when it fails, the tail of its output and the command to run by hand. Checks again afterwards.
async function runVoxStep($: EngineInterface, step: VoxStep) {
  const state = await read($, voxSetup)
  if (state === null || (await read($, voxRunning)) !== null || stepFor(state) !== step) return

  const argv = stepArgv(step, state)
  if (argv === undefined) {
    await refreshVoxlektor($)
    return
  }

  const withProgress = stepReportsProgress(step, state)
  await update($, voxRunning, () => argv.join(' '))
  await update($, voxProgress, () => null)
  await update($, voxStepLine, () => null)
  await update($, voxStepError, () => null)
  await update($, voxCommandShown, () => false)

  void (async () => {
    const buffers = { stdout: new LineBuffer(), stderr: new LineBuffer() }
    let tail: string[] = []
    let reported: string | undefined
    const take = async (lines: string[]) => {
      for (const raw of lines) {
        // Progress bars redraw with a carriage return; the last drawing is what shows.
        const line = raw.split('\r').filter(part => part.trim() !== '').pop() ?? ''
        if (line === '') continue
        tail = [...tail, line].slice(-VOX_ERROR_LINES)
        const progress = withProgress ? parseProgress(line) : undefined
        if (progress !== undefined && progress !== 'done' && 'error' in progress) reported = progress.error
        else if (progress !== undefined && progress !== 'done') await update($, voxProgress, () => progress)
        else if (progress === undefined) await update($, voxStepLine, () => line)
      }
    }

    let code: number | null = null
    let threw = false
    try {
      const stream = $.process.spawn({ argv })
      for (;;) {
        const next = await stream.next()
        if (next.done === true) {
          code = next.value.code
          break
        }
        await take(buffers[next.value.stream].push(next.value.text))
      }
    } catch (error) {
      threw = true
      tail = [...tail, String(error)].slice(-VOX_ERROR_LINES)
    }
    await take([...buffers.stdout.flush(), ...buffers.stderr.flush()])

    if (code !== 0 || reported !== undefined) {
      const lines = reported === undefined ? tail : [...tail, reported].slice(-VOX_ERROR_LINES)
      // No exit code: the step was killed (by its timeout, or the session going away).
      const how = threw ? 'failed' : code === null ? 'was stopped' : `failed (exit ${String(code)})`
      await update($, voxStepError, () => [`${VOX_STEP_LABELS[step]} ${how}:`, ...lines].join('\n'))
      await update($, voxCommandShown, () => true)
    }
    await update($, voxRunning, () => null)
    await update($, voxProgress, () => null)
    await update($, voxStepLine, () => null)
    await refreshVoxlektor($)
  })().catch(error => $.ui.log(`dialogue-box: voxlektor setup step failed: ${String(error)}`, { to: 'debug' }))
}

async function checkVoxlektorAgain($: EngineInterface) {
  await update($, voxStepError, () => null)
  await update($, voxCommandShown, () => false)
  await refreshVoxlektor($)
}

// " (warm, watch)" for the pane, or nothing when the list is empty.
function lackingText(missing: readonly string[]): string {
  return missing.length === 0 ? '' : ` (${missing.join(', ')})`
}

async function showLanguages($: EngineInterface) {
  await update($, setupView, () => 'languages')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dialogue', description: 'Hear replies as spoken dialogue: on | off | stop | previous | setup | style | engine' })
    voxOwner = ownerFor(await $.session.id().catch(() => randomId()))
    await Promise.all([loadVoices($), restoreSettings($), findEdge($), refreshVoxlektor($)])
    await applyDefaultEngine($)
    // Also warms uvx, whose first run downloads edge-tts. With voxlektor too, so that its fallback can read with Edge.
    if ((await engineOf($)) !== 'mac') void loadEdgeVoices($).catch(() => undefined)
    // Set up to start on. The system prompt may already have been composed before this ran, so the instruction also
    // rides on the first prompt, as /dialogue on's context does.
    if (canSpeak && (await read($, startOn)) && !(await read($, isOn))) {
      await update($, isOn, () => true)
      isStartInstructionPending = true
      await warmIfReading($)
    }
    $.ui.status((await read($, isOn)) ? STATUS : undefined)

    return next(e)
  })

  // The watcher goes with the session, and voxlektor stops reading what the session left.
  on('session.end', async ($, e, next) => {
    const vxl = voxlektorExecutable
    const owner = voxOwner
    await stopWatcher()
    // Nothing planned before the end goes out any more; the say on its way is killed, and the stop goes out once it
    // has ended (briefly bounded), so that say cannot land after the stop.
    voxEpoch += 1
    voxTrail = trailReplaced(voxTrail)
    const cancelled = cancelOrders()
    let bound: Timer | undefined
    await Promise.race([cancelled, new Promise<void>(resolve => (bound = $.clock.after(VOX_STOP_SETTLE_MS, resolve)))])
    bound?.cancel()
    // Also after leaving voxlektor: the stop of that leave may have been dropped above before it went out.
    if ((voxActive || voxUsed) && vxl !== undefined && owner !== undefined) {
      voxActive = false
      await $.process.run(controlArgv(vxl, 'stop', owner), { timeoutMs: VOX_STOP_SETTLE_MS }).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'dialogue' }, async ($, e) => {
    const [action, value] = e.args.trim().split(/\s+/)
    switch (action) {
      case 'on':
        if (!canSpeak) return { text: NOT_AVAILABLE }
        isStartInstructionPending = false
        await update($, isOn, () => true)
        $.ui.status(STATUS)
        await warmIfReading($)
        return {
          text: `Dialogue on: replies end with spoken paragraphs you can rewind, pause and skip. ${await settingsSummary($)}`,
          context: [spokenInstruction(await styleOf($))],
        }
      case 'off':
        isStartInstructionPending = false
        await update($, isOn, () => false)
        await closeAll($)
        $.ui.status(undefined)
        return { text: 'Dialogue off.', context: [SPOKEN_OFF_INSTRUCTION] }
      case 'previous':
        if ((await read($, history)).length === 0) return { text: 'No earlier reply to play.' }
        await previousReply($)
        return { text: 'Playing the previous reply.' }
      case 'stop':
        await closeAll($)
        return { text: 'Playback stopped.' }
      case 'setup': {
        await loadVoices($)
        if (!canSpeak) return { text: NOT_AVAILABLE }
        const opened = await openSetup($)
        return { text: opened.isPlaced ? 'Voice setup opened.' : `Voice setup could not open: ${opened.reason}` }
      }
      case 'style': {
        if (!isStyle(value)) return { text: USAGE }
        await update($, styleOverride, () => value)
        const text = `Style for this session: ${STYLE_LABELS[value]}.`
        return (await read($, isOn)) ? { text, context: [spokenInstruction(value)] } : { text }
      }
      case 'engine': {
        if (!isEngine(value)) return { text: USAGE }
        if (value === 'edge') {
          await findEdge($)
          if (edgeExecutable === undefined) return { text: EDGE_INSTALL_HINT }
          void loadEdgeVoices($).catch(() => undefined)
        }
        if (value === 'voxlektor') {
          await refreshVoxlektor($)
          const state = await read($, voxSetup)
          if (state?.kind !== 'ready') return { text: notReadyReason(state) }
        }
        const before = await readerOf($)
        edgeDown = false
        voxlektorDown = false
        await update($, fallback, () => null)
        await update($, engineOverride, () => value)
        await engineChangedFrom($, before)
        return { text: `Engine for this session: ${ENGINE_LABELS[value]}.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isOn))) return composed

    return {
      sections: [...composed.sections, { id: 'dialogue-box:spoken', text: spokenInstruction(await styleOf($)), scope: 'session' }],
    }
  })

  // Typing or dictation landing in the prompt means the person has started answering, and the microphone must not hear the voice.
  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    if (e.text.trim() !== '' && (await read($, dialog))?.status === 'playing') await apply($, pause)

    return result
  })

  // A notification, a schedule or another session submits too; only the person's own message, one that reaches the
  // model, ends what is playing.
  on('prompt.submit', async ($, e, next) => {
    // The first prompt of a session that started on carries the spoken instruction (a command's own context does
    // that for /dialogue on); it is attached on the way down, before the prompt enters.
    const attach = isStartInstructionPending && e.command === undefined && (await read($, isOn))
    if (attach) isStartInstructionPending = false
    const result = await next(attach ? { ...e, context: [...(e.context ?? []), spokenInstruction(await styleOf($))] } : e)
    if (!isFromPerson(e.origin) || e.command !== undefined || 'drop' in result) return result

    if (e.turnId !== undefined) personTurns.add(e.turnId)
    personPrompts = [...personPrompts, result.text].slice(-PERSON_PROMPTS_KEPT)
    await closeAll($).catch(() => undefined)
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    const at = e.agentId === undefined ? personPrompts.indexOf(e.text) : -1
    if (at >= 0) {
      personPrompts = personPrompts.filter((_, index) => index !== at)
      personTurns.add(e.turnId)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const isReply = personTurns.delete(e.turnId)
    if (e.reason !== 'answer' || !(await read($, isOn))) return result

    const spoken = extractSpoken(e.answer)
    if (spoken !== undefined && spoken.paragraphs.length > 0) {
      const incoming = startDialog(e.turnId, spoken.paragraphs, spoken.language ?? (await read($, primaryLanguage)))
      await present($, screen => onArrive(screen, incoming, isReply))
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, dialog)
    if (current === null || e.props.hasSurvey) return next(e)

    const rate = RATES[await read($, rateIndex)] ?? 1
    const reason = await read($, fallback)
    const waiting = (await read($, queue)).length
    const heard = (await read($, history)).length
    const { Box, Button, Text } = $.ui.resolve(e)
    // What voxlektor says about this reply, only while voxlektor reads it.
    const band = (await voxlektorReading($)) === undefined ? undefined : await read($, voxBand)
    const ahead = band === undefined ? undefined : waitingAhead({ current, queue: [], history: [] }, band)
    const isHeld = band?.held === true && current.status !== 'ended'
    const state = current.status === 'playing' && isHeld ? ' · ⏸ held (paused outside this session)' : { playing: '', paused: ' · ⏸ paused', ended: ' · end' }[current.status]
    const live = current.status === 'playing' && band !== undefined

    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>
          🔊 {current.index + 1} / {current.paragraphs.length}
          {current.pending === true && ' ⏳'}
          <Text dimColor>
            {' '}
            · {rate}×{state}
            {heard + waiting > 0 && ` · reply ${heard + 1} / ${heard + 1 + waiting}`}
          </Text>
        </Text>
        {reason !== null && <Text color="warning">⚠ {reason}</Text>}
        {ahead !== undefined && (
          <Box flexDirection="row" gap={2}>
            <Text dimColor>🕒 waiting · another session is speaking ({ahead} ahead)</Text>
            <Button key="play-now" label="play now" hotkey="8" plain onPress={() => playNow($)} />
          </Box>
        )}
        {ahead === undefined && live && band?.warming === true && <Text dimColor>🔥 warming up voice…</Text>}
        {ahead === undefined && live && band?.warming !== true && band?.connecting === true && (
          <Text dimColor>connecting to voxlektor…</Text>
        )}
        <Text>{displayText(current.paragraphs[current.index] ?? '')}</Text>
        {/* Wraps: a digit presses only a Button wholly in view. Stop is on 6, not 0: from the prompt the host hands the
            band digits 1 to 9 only, so a 0 was typed into the prompt instead. */}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="back" label="back" hotkey="1" plain onPress={() => back($)} />
          <Button
            key="pause"
            label={current.status === 'playing' && !isHeld ? 'pause' : 'resume'}
            hotkey="2"
            plain
            onPress={() => (current.status === 'playing' && isHeld ? liftHold($) : apply($, togglePause))}
          />
          <Button key="skip" label="skip" hotkey="3" plain onPress={() => skip($)} />
          <Button key="slower" label="slower" hotkey="4" plain onPress={() => changeRate($, -1)} />
          <Button key="faster" label="faster" hotkey="5" plain onPress={() => changeRate($, 1)} />
          {heard > 0 && <Button key="previous-reply" label="prev reply" hotkey="9" plain onPress={() => previousReply($)} />}
          <Button key="stop" label={waiting > 0 ? 'next reply' : 'stop'} hotkey="6" plain onPress={() => nextReply($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const primary = await read($, primaryLanguage)

    if ((await read($, setupView)) === 'languages') {
      return (
        <Box flexDirection="column">
          <Text bold>Main language</Text>
          {languagesWithVoices(installedVoices).map(language => (
            <Button
              key={`language-${language}`}
              label={`${languageName(language)} (${language})${language === primary ? ' ●' : ''}`}
              onPress={() => choosePrimary($, language)}
            />
          ))}
        </Box>
      )
    }

    const choices = await read($, voiceChoices)
    const languages = primary === 'en' ? ['en'] : [primary, 'en']
    const style = await read($, defaultStyle)
    const sessionStyle = await read($, styleOverride)
    const engine = await read($, defaultEngine)
    const sessionEngine = await read($, engineOverride)
    const chosenEdge = await edgeVoiceOf($, primary)
    const ranked = edgeVoicesFor(await read($, edgeVoices), primary)
    const shown = ranked.slice(0, EDGE_VOICES_SHOWN)
    const hiddenChoice = ranked.find(voice => voice.name === chosenEdge && !shown.includes(voice))
    const edgeList = hiddenChoice === undefined ? shown : [...shown, hiddenChoice]
    const edgeStatus = await read($, edgeVoicesStatus)
    const { Progress } = $.ui.resolve(e)
    const vox = await read($, voxSetup)
    const voxStep = vox === null ? undefined : stepFor(vox)
    const voxCommand = vox === null ? undefined : commandFor(vox)
    const voxRun = await read($, voxRunning)
    const voxDone = await read($, voxProgress)
    const voxLine = await read($, voxStepLine)
    const voxError = await read($, voxStepError)
    const voxShown = await read($, voxCommandShown)
    const starting = await read($, startOn)
    const stuck = await read($, voxStuck)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>Main language: {languageName(primary)}</Text>
          <Button key="change-language" label="change" onPress={() => showLanguages($)} />
        </Box>
        <Box flexDirection="column">
          <Text bold>Start of a session</Text>
          {[false, true].map(option => (
            <Box flexDirection="row" gap={1}>
              <Text>{option === starting ? '●' : '○'}</Text>
              <Button
                key={`start-${option ? 'on' : 'off'}`}
                label={option ? 'Dialogue on in every new session' : 'Off until /dialogue on'}
                onPress={() => chooseStartOn($, option)}
              />
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>Conversation style</Text>
          {STYLES.map(option => (
            <Box flexDirection="row" gap={1}>
              <Text>{option === style ? '●' : '○'}</Text>
              <Button key={`style-${option}`} label={STYLE_LABELS[option]} onPress={() => chooseStyle($, option)} />
            </Box>
          ))}
          {sessionStyle !== null && <Text dimColor>This session: {sessionStyle} (/dialogue style)</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Speech engine</Text>
          {ENGINES.map(option => (
            <Box flexDirection="row" gap={1}>
              <Text>{option === engine ? '●' : '○'}</Text>
              <Button key={`engine-${option}`} label={ENGINE_LABELS[option]} onPress={() => chooseEngine($, option)} />
            </Box>
          ))}
          {sessionEngine !== null && <Text dimColor>This session: {sessionEngine} (/dialogue engine)</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>voxlektor · local neural voice</Text>
          {vox === null && <Text dimColor>Checking voxlektor…</Text>}
          {vox?.kind === 'unsupported' && <Text dimColor>voxlektor needs macOS 14+ on Apple Silicon.</Text>}
          {vox?.kind === 'needs-uv' && <Text>voxlektor installs with uv, which is not installed.</Text>}
          {vox?.kind === 'needs-voxlektor' && <Text>voxlektor is not installed.</Text>}
          {vox?.kind === 'needs-update' && (
            <Text>
              {vox.version === undefined
                ? `This voxlektor cannot tell dialogue-box what it offers (it predates ${VOXLEKTOR_MIN_VERSION}); updating installs ${VOXLEKTOR_TAG}.`
                : `This voxlektor (${vox.version}) lacks what dialogue-box needs${lackingText(vox.missing)}; updating installs ${VOXLEKTOR_TAG}.`}
            </Text>
          )}
          {vox?.kind === 'incomplete' && (
            <Box flexDirection="row" gap={2}>
              <Text color="warning">
                {`This voxlektor (${vox.version}) is newer than ${VOXLEKTOR_TAG} but lacks what dialogue-box needs${lackingText(vox.missing)}. `}
                {`Reinstalling ${VOXLEKTOR_TAG} would downgrade it, so repair it yourself (${VOX_CHECK_COMMAND} shows what it reports). `}
                Until then Edge or a Mac voice reads.
              </Text>
              <Button key="vox-check-again" label="check again" onPress={() => checkVoxlektorAgain($)} />
            </Box>
          )}
          {stuck !== null && <Text color="warning">{stuckMessage(stuck)}</Text>}
          {vox?.kind === 'too-new' && (
            <Text color="warning">
              This voxlektor ({vox.version}) is newer than this dialogue-box supports: update dialogue-box. Until then
              Edge or a Mac voice reads.
            </Text>
          )}
          {vox?.kind === 'needs-setup' && <Text>voxlektor's setup has not finished.</Text>}
          {vox?.kind === 'needs-model' && (
            <>
              <Text>The voice model is not downloaded. Its license:</Text>
              <Text>{licenseLine(vox)}</Text>
            </>
          )}
          {vox?.kind === 'needs-profile' && <Text>voxlektor needs the claude profile dialogue-box reads with.</Text>}
          {vox?.kind === 'ready' && (
            <>
              <Box flexDirection="row" gap={1}>
                <Text>
                  Voice {vox.voice} · rate {vox.rate} · volume {vox.volume}
                  {vox.steps === undefined ? '' : ` · steps ${vox.steps}`}
                </Text>
                <Button key="vox-sample" label="▶" plain onPress={() => playVoxlektorSample($, vox, primary)} />
              </Box>
              <Text dimColor>Tune it in a terminal: {vox.tuneCommand}</Text>
            </>
          )}
          {voxStep !== undefined && voxCommand !== undefined && (
            <Box flexDirection="column">
              <Text dimColor>Command: {voxCommand}</Text>
              {voxRun !== null && (
                <Box flexDirection="column">
                  <Text dimColor>Running: {voxRun}</Text>
                  <Progress
                    label={VOX_STEP_LABELS[voxStep]}
                    {...(voxDone === null ? {} : { value: voxDone.done, max: voxDone.total })}
                  />
                  {voxLine !== null && <Text dimColor>{voxLine}</Text>}
                </Box>
              )}
              {voxRun === null && !voxShown && (
                <Box flexDirection="row" gap={2}>
                  <Button key={`vox-step-${voxStep}`} label={VOX_STEP_LABELS[voxStep]} onPress={() => runVoxStep($, voxStep)} />
                  <Button key="vox-show-command" label="No, show me the command" onPress={() => update($, voxCommandShown, () => true)} />
                </Box>
              )}
              {voxRun === null && voxShown && (
                <Box flexDirection="row" gap={2}>
                  <Text>Run this in a terminal: {voxCommand}</Text>
                  <Button key="vox-check-again" label="check again" onPress={() => checkVoxlektorAgain($)} />
                </Box>
              )}
            </Box>
          )}
          {voxError !== null && <Text color="warning">{voxError}</Text>}
        </Box>
        <Box flexDirection="column">
          <Text bold>Edge voice · {languageName(primary)}</Text>
          {edgeExecutable === undefined && <Text color="warning">{EDGE_INSTALL_HINT}</Text>}
          {edgeExecutable !== undefined && edgeStatus === 'loading' && edgeList.length === 0 && (
            <Text dimColor>Loading Edge voices… (the first run downloads edge-tts)</Text>
          )}
          {edgeExecutable !== undefined && edgeStatus === 'failed' && (
            <Box flexDirection="row" gap={2}>
              <Text color="warning">Could not load the Edge voices (offline?).</Text>
              <Button key="edge-retry" label="retry" onPress={() => loadEdgeVoices($)} />
            </Box>
          )}
          {edgeList.map(voice => (
            <Box flexDirection="row" gap={1}>
              <Text>{voice.name === chosenEdge ? '●' : '○'}</Text>
              <Button
                key={`edge-${voice.name}`}
                label={[shortName(voice), voice.gender, isMultilingual(voice) ? `multilingual, ${voice.locale}` : '', voice.personalities]
                  .filter(part => part !== '')
                  .join(' · ')}
                onPress={() => chooseEdgeVoice($, primary, voice.name)}
              />
              {edgeExecutable !== undefined && (
                <Button key={`edge-sample-${voice.name}`} label="▶" plain onPress={() => playEdgeSample($, voice, primary)} />
              )}
            </Box>
          ))}
        </Box>
        {languages.map(language => {
          const chosen = resolveVoice(installedVoices, choices, language)
          const ranked = voicesFor(installedVoices, language).slice(0, VOICES_SHOWN_PER_LANGUAGE)

          return (
            <Box flexDirection="column">
              <Text bold>
                Mac voice · {languageName(language)}
                {language === primary ? '' : ' (words in other languages)'}
              </Text>
              {ranked.length === 0 && <Text color="warning">No voice installed: the system voice speaks it.</Text>}
              {ranked.map(voice => (
                <Box flexDirection="row" gap={1}>
                  <Text>{voice.name === chosen ? '●' : '○'}</Text>
                  <Button
                    key={`pick-${voice.name}`}
                    label={`${voice.name} · ${voice.quality}`}
                    onPress={() => chooseVoice($, language, voice.name)}
                  />
                  <Button key={`sample-${voice.name}`} label="▶" plain onPress={() => playSample($, voice)} />
                </Box>
              ))}
              <Box flexDirection="row" gap={1}>
                <Text>{chosen === undefined ? '●' : '○'}</Text>
                <Button
                  key={`pick-system-${language}`}
                  label="System voice · set in System Settings → Accessibility → Spoken Content"
                  onPress={() => chooseVoice($, language, SYSTEM_VOICE)}
                />
              </Box>
              {needsBetterVoice(installedVoices, language) && <Text color="warning">{recommendation(language)}</Text>}
            </Box>
          )
        })}
        <Text dimColor>Tab or arrows move · Enter picks · ▶ plays a sample · Esc closes</Text>
      </Box>
    )
  })
}
