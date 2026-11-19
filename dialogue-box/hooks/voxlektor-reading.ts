import type { Dialog, SayRequest, VoxBand, VoxControl, VoxEvent, VoxGroup, VoxReason } from '../types'
import { onClose, onNextReply } from './arrivals'
import type { Screen } from './arrivals'
import { nextParagraph } from './dialog'
import { displayText } from './speech'
import { decodeTag, encodeTag, groupOf, speaksProtocol, voxRate } from './voxlektor'

// What dialogue-box tells voxlektor for each screen transition, and what voxlektor's events do to the screen. Pure:
// register.tsx runs the orders and feeds the watcher's events; which dialog plays stays the policy of arrivals.ts.
//
// The caller keeps two values for the session: its owner id (`ownerFor`) and the reading epoch, which starts at 0.
// `ordersFor` returns the epoch to keep, and `applyEvent` ignores tags of any other epoch, so the events of a reading
// this session has since replaced never move the screen.

// Defined in types/index.d.ts (the plugin's state needs it there, and that file may not import).
export type { VoxBand } from '../types'

export const INITIAL_BAND: VoxBand = { waiting: {}, warming: false, paused: false, held: false, floor: false, connecting: false }

export type VoxOrder = { kind: 'say'; request: SayRequest } | { kind: 'control'; control: VoxControl }

type Reading = { owner: string; rate: number; preempt: boolean; epoch: number }

type Planned = { orders: VoxOrder[]; epoch: number }

const control = (name: VoxControl): VoxOrder => ({ kind: 'control', control: name })

function paragraphsFrom(dialog: Dialog, from: number, reading: Reading): VoxOrder[] {
  return dialog.paragraphs.slice(from).map((paragraph, offset) => ({
    kind: 'say',
    request: {
      owner: reading.owner,
      group: groupOf(dialog.id),
      tag: encodeTag(dialog.id, from + offset, reading.epoch),
      text: displayText(paragraph),
      now: false,
      preempt: false,
      rate: reading.rate,
    },
  }))
}

// A new reading under a new epoch. The first paragraph replaces all of this session's reading (`now`; the play-now
// press also takes the floor from another session with `preempt`); everything after it is appended in order, so
// voxlektor reads on without a gap.
function readFrom(screen: Screen, reading: Reading): Planned {
  const next = { ...reading, epoch: reading.epoch + 1 }
  const current = screen.current
  const fromCurrent = current === null || current.status === 'ended' ? [] : paragraphsFrom(current, current.index, next)
  const [first, ...rest] = [...fromCurrent, ...screen.queue.flatMap(dialog => paragraphsFrom(dialog, 0, next))]
  if (first === undefined || first.kind !== 'say') return { orders: [], epoch: reading.epoch }

  return { orders: [{ kind: 'say', request: { ...first.request, now: true, preempt: reading.preempt } }, ...rest], epoch: next.epoch }
}

export function ordersFor(input: {
  owner: string
  before: Screen
  after: Screen
  profileRate: number
  multiplier: number
  // The play-now press.
  preempt: boolean
  // Read the current paragraph again although nothing moved: a rate change, or back on the first paragraph.
  reread: boolean
  epoch: number
}): Planned {
  const { before, after, epoch } = input
  const reading: Reading = { owner: input.owner, rate: voxRate(input.profileRate, input.multiplier), preempt: input.preempt, epoch }
  const same = (orders: VoxOrder[]): Planned => ({ orders, epoch })
  const was = before.current
  const is = after.current

  if (is === null) return same(was === null && before.queue.length === 0 ? [] : [control('stop')])
  if (was === null || was.id !== is.id || input.preempt) return readFrom(after, reading)
  // Only the person's keys end a dialog here (skip on its last paragraph), so what voxlektor still reads is cut off,
  // as Edge is.
  if (is.status === 'ended') return same(was.status === 'ended' ? [] : [control('stop')])

  const replayed = was.status === 'ended' && is.status === 'playing'
  // While paused a re-read waits: reading now would lift the pause the person asked for.
  const reread = input.reread && is.status === 'playing'
  if (was.index !== is.index || replayed || reread) return readFrom(after, reading)

  const toggles =
    was.status === 'playing' && is.status === 'paused'
      ? [control('pause')]
      : was.status === 'paused' && is.status === 'playing'
        ? [control('resume')]
        : []
  const known = new Set([was.id, ...before.queue.map(dialog => dialog.id)])
  const arrived = after.queue.filter(dialog => !known.has(dialog.id)).flatMap(dialog => paragraphsFrom(dialog, 0, reading))

  return same([...toggles, ...arrived])
}

// Skip (key 3) and back (key 1) through voxlektor's tag navigation: one owner control that keeps the audio generated
// ahead, instead of a `now` re-read from the target paragraph. `tagNav`: the install and the running daemon offer it
// and every paragraph of the reading has been handed to voxlektor. `floor`: this session holds the floor (an owner
// skip while waiting is a no-op there).
//
// The box moves on the key to the expected paragraph and shows ⏳ (`pending`) until voxlektor starts it, so every
// press shows at once and presses compose from what the box shows. A back is expected to go to the paragraph before;
// when voxlektor restarts the paragraph instead (it was partway through it), its tag_started moves the box back to it.
// voxlektor stays authoritative (see `applyEvent`'s `moving`). Skip on the last paragraph is a skip too: the box ends
// at once, and its tag finishing `skipped` ends the dialog again; further skips on the ended box send nothing.
//
// voxlektor's back is chronological: at the start of a run it brings back the run played before it from the owner's
// history, which may be a paragraph read under an earlier epoch (this reply read again since) or, once this reply's
// runs there are used up, the reply before. So a back goes by tag only while `trail` proves that a paragraph of this
// reply lies in that history (`heard`), counting every tag back still on its way as one that used a paragraph up.
//
// Undefined leaves the move to `ordersFor`: paused (the re-read waits for resume), back on the first paragraph
// (restarting it), back with nothing of this reply known to be in the history, an ended reply, a move into another
// reply.
export function navigationFor(input: {
  before: Screen
  after: Screen
  move: 'skip' | 'back' | undefined
  tagNav: boolean
  floor: boolean
  trail: TagTrail
}): VoxOrder | undefined {
  const { move } = input
  const was = input.before.current
  const is = input.after.current
  if (!input.tagNav || !input.floor || move === undefined || was === null || is === null) return undefined
  if (was.id !== is.id || was.status !== 'playing') return undefined

  const last = was.paragraphs.length - 1
  const skips =
    move === 'skip' &&
    ((is.status === 'playing' && is.index === was.index + 1) || (is.status === 'ended' && was.index === last && is.index === last))
  const trail = trailOf(input.trail, was.id)
  const backs = move === 'back' && is.status === 'playing' && was.index > 0 && is.index === was.index - 1 && trail.heard > 0

  // After a back voxlektor may have turned into a restart, a tag move could end elsewhere than the box: one `now`
  // re-read from the box's paragraph is sure to end there.
  return (skips || backs) && !trail.uncertain ? control(move) : undefined
}

// Drops the box's ⏳: voxlektor confirmed, corrected or replaced the move.
export function settledDialog(dialog: Dialog): Dialog {
  if (dialog.pending === undefined) return dialog

  const copy = { ...dialog }
  delete copy.pending

  return copy
}

// What this session knows of voxlektor's tag history for the reply on screen, so that tag navigation stays inside it
// and the box follows it. voxlektor keeps the chunks played to the end per owner, newest last: a back takes the
// newest run off, playing it again pushes it back on.
export type TagTrail = {
  // The reply this is about; any other reply on screen starts with an empty trail.
  readonly dialog: string | undefined
  // Paragraphs of it heard to the end (each is in the history) and not since taken off by a tag back. Never more than
  // the history holds of this reply: a run skipped partway is in it too but not counted.
  readonly heard: number
  // A tag move went out since the current reading was handed over: from then on voxlektor may bring back runs of this
  // reply tagged under an earlier epoch, and the box follows them (`trailFollows`).
  readonly navigated: boolean
  // Tag backs sent and not yet answered by a tag_started of this reply.
  readonly backs: number
  // The tag of this reply's run playing (last seen starting, or named by the snapshot), until it ends: the same tag
  // starting again after a back is a restart, which took nothing off the history.
  readonly playing: string | undefined
  // A tag back went out while the box showed a paragraph voxlektor had started: voxlektor restarts that paragraph if
  // any of it finished playing, else goes to the one before, and only its tag_started tells which. Until then the next
  // key re-reads instead of moving by tag (`navigationFor`). A back while the box still waits (⏳) is sure: that run
  // has not played yet.
  readonly uncertain: boolean
}

export const NO_TRAIL: TagTrail = { dialog: undefined, heard: 0, navigated: false, backs: 0, playing: undefined, uncertain: false }

function trailOf(trail: TagTrail, dialogId: string | undefined): TagTrail {
  return trail.dialog === dialogId ? trail : { ...NO_TRAIL, dialog: dialogId }
}

// A tag move went to voxlektor for the reply `dialogId`. A back may take a paragraph of it off the history.
// `started`: the box showed a paragraph voxlektor had started (no ⏳), so a back may restart it.
export function trailMoved(trail: TagTrail, dialogId: string, move: 'skip' | 'back', started = true): TagTrail {
  const on = trailOf(trail, dialogId)
  const back = move === 'back' ? 1 : 0

  return {
    ...on,
    heard: Math.max(0, on.heard - back),
    navigated: true,
    backs: on.backs + back,
    uncertain: on.uncertain || (move === 'back' && started),
  }
}

// A new reading replaced everything this session had in voxlektor: no move is on its way any more, and what it brings
// back of an earlier epoch is a replaced reading's again. The history stays.
export function trailReplaced(trail: TagTrail): TagTrail {
  return !trail.navigated && trail.backs === 0 && !trail.uncertain ? trail : { ...trail, navigated: false, backs: 0, uncertain: false }
}

// Whether tag navigation moved this reading of the reply on screen, so its tag_started is followed whatever reading it
// was first handed over in (see `applyEvent`'s `follow`). Tag moves go out only once every paragraph of the reading
// was handed over, so a replaced reading's own late events are long through by then.
export function trailFollows(trail: TagTrail, screen: Screen): boolean {
  return screen.current !== null && trail.dialog === screen.current.id && trail.navigated
}

// The trail after a watcher event, read against the screen before it. `moving`: a tag move has not been taken by
// voxlektor yet (its control has not returned), so a start may come from before it.
export function trailAfter(input: {
  trail: TagTrail
  screen: Screen
  event: VoxEvent
  owner: string
  epoch: number
  moving?: boolean
}): TagTrail {
  const { screen, event, owner, epoch } = input
  const current = screen.current
  if (current === null) return input.trail

  const trail = trailOf(input.trail, current.id)
  const own = (eventOwner: string | null) => eventOwner === null || eventOwner === owner
  const ofThisReply = (tag: string | undefined) => {
    const decoded = tag === undefined ? undefined : decodeTag(tag)

    return decoded !== undefined && decoded.group === groupOf(current.id) && decoded.epoch <= epoch ? decoded : undefined
  }

  switch (event.type) {
    case 'tag_started': {
      const decoded = own(event.owner) ? ofThisReply(event.tag) : undefined
      if (decoded === undefined || (decoded.epoch !== epoch && !trail.navigated)) return trail

      const restart = trail.backs > 0 && event.tag === trail.playing

      return {
        ...trail,
        heard: trail.heard + (restart ? 1 : 0),
        backs: Math.max(0, trail.backs - 1),
        playing: event.tag,
        // Every move taken: this start says where voxlektor is.
        uncertain: input.moving === true && trail.uncertain,
      }
    }
    case 'tag_finished': {
      if (!own(event.owner) || ofThisReply(event.tag) === undefined) return trail

      // A run heard to the end is in the history: starting it again is bringing it back, not a restart.
      const playing = event.reason === 'back' || event.tag !== trail.playing ? trail.playing : undefined

      return { ...trail, heard: trail.heard + (event.reason === 'done' ? 1 : 0), playing }
    }
    case 'snapshot':
      return event.floorOwner === owner && ofThisReply(event.tag) !== undefined ? { ...trail, playing: event.tag } : trail
    case 'drained':
      return event.owner === owner ? trailReplaced(trail) : trail
    default:
      return trail
  }
}

// After this session stops voxlektor, a `say` it killed may still be applied after the stop (voxlektor gives no
// ordering guarantee there), and its reading starts anyway. The fence remembers which readings were cancelled, so a
// tag_started or floor of one is answered with one more owner stop (at most once per cancelled epoch) and never moves
// the screen. Only while no newer reading was handed to voxlektor: a stop then would cut that one off too.
export type StopFence = {
  // The newest epoch a stop cancelled; -1 before any.
  readonly through: number
  // The groups of the cancelled readings.
  readonly cancelled: readonly string[]
  // The groups of each epoch handed to voxlektor since the last stop.
  readonly live: Readonly<Record<number, readonly string[]>>
  // The cancelled epochs already stopped once more.
  readonly restopped: readonly number[]
}

export const NO_STOP: StopFence = { through: -1, cancelled: [], live: {}, restopped: [] }

// A paragraph of reading `epoch` in `group` went to the say lane.
export function fenceSaid(fence: StopFence, epoch: number, group: string): StopFence {
  const groups = fence.live[epoch] ?? []
  if (groups.includes(group)) return fence

  return { ...fence, live: { ...fence.live, [epoch]: [...groups, group] } }
}

// A stop of everything this session had handed to voxlektor went out.
export function fenceStopped(fence: StopFence): StopFence {
  const epochs = Object.keys(fence.live).map(Number)
  if (epochs.length === 0) return fence

  const groups = Object.values(fence.live).flat()

  return {
    ...fence,
    through: Math.max(fence.through, ...epochs),
    cancelled: [...fence.cancelled, ...groups.filter(group => !fence.cancelled.includes(group))],
    live: {},
  }
}

// 'restop': a cancelled reading started; send one more owner stop. 'ignore': it was stopped once more already. Either
// way the event must not reach the screen. Undefined: no late start.
export function lateStart(fence: StopFence, event: VoxEvent, owner: string): { fence: StopFence; late: 'restop' | 'ignore' | undefined } {
  const none = { fence, late: undefined }
  if (Object.keys(fence.live).length > 0) return none

  let epoch: number | undefined
  if (event.type === 'tag_started' && (event.owner === null || event.owner === owner)) {
    const decoded = decodeTag(event.tag)
    if (decoded !== undefined && decoded.epoch <= fence.through) epoch = decoded.epoch
  } else if (event.type === 'floor' && event.owner === owner && event.group !== null && fence.cancelled.includes(event.group)) {
    epoch = fence.through
  }
  if (epoch === undefined) return none
  if (fence.restopped.includes(epoch)) return { fence, late: 'ignore' }

  return { fence: { ...fence, restopped: [...fence.restopped, epoch] }, late: 'restop' }
}

// The cursor follows what voxlektor is reading. A started tag is being heard, so an ended dialog plays again; a
// paused one keeps its status.
function atParagraph(dialog: Dialog, index: number): Dialog {
  return settledDialog({ ...dialog, index, status: dialog.status === 'ended' ? 'playing' : dialog.status })
}

const inGroup = (group: string) => (dialog: Dialog) => groupOf(dialog.id) === group

function started(screen: Screen, group: string, index: number): Screen {
  const current = screen.current
  if (current !== null && inGroup(group)(current)) return { ...screen, current: atParagraph(current, index) }

  // A tag of a queued reply means voxlektor moved on to it; replies before it in the queue were skipped there too.
  const position = screen.queue.findIndex(inGroup(group))
  if (position < 0) return screen

  let moved = screen
  for (let step = 0; step <= position; step++) moved = onNextReply(moved)

  return moved.current === null ? moved : { ...moved, current: atParagraph(moved.current, index) }
}

// Only a reply's own last paragraph, heard to the end or skipped, ends it, also while the box still shows an earlier
// one (two quick skips drop the last paragraph before it ever starts). Replaced and back belong to a reading that goes
// on; stopped and error leave the cursor where the reading stopped, so a fallback that follows (`disconnected`,
// `error`) reads on from there; daemon-wide drained says nothing about this reply.
function finished(screen: Screen, group: string, index: number, reason: VoxReason): Screen {
  const current = screen.current
  if (reason !== 'done' && reason !== 'skipped') return screen
  if (current === null || !inGroup(group)(current) || current.index > index || index !== current.paragraphs.length - 1) return screen

  return onClose({ ...screen, current: nextParagraph({ ...current, index }) })
}

function withStatus(screen: Screen, status: 'playing' | 'paused'): Screen {
  const current = screen.current
  if (current === null || current.status === 'ended' || current.status === status) return screen

  return { ...screen, current: { ...current, status } }
}

function without(waiting: Readonly<Record<string, number>>, group: string): Record<string, number> {
  const rest = { ...waiting }
  delete rest[group]

  return rest
}

// Whether this session has something unfinished in voxlektor, so that losing voxlektor means falling back.
function isReading(screen: Screen): boolean {
  return screen.current !== null && screen.current.status !== 'ended'
}

// How many groups are ahead of the reply on screen, when it waits behind another session.
export function waitingAhead(screen: Screen, band: VoxBand): number | undefined {
  const current = screen.current
  if (current === null || current.status === 'ended') return undefined

  const group = groupOf(current.id)

  return Object.prototype.hasOwnProperty.call(band.waiting, group) ? band.waiting[group] : undefined
}

// Never feed a screen this returns back into `ordersFor`: a moved cursor would read as a skip.
// `settled`: every order sent for this session's reading has returned and none waits, so voxlektor holds all of it.
// `follow`: tag navigation moved this reading (`trailFollows`): a tag_started of the reply on screen moves the cursor
// also when its run was first handed over under an earlier epoch, since a tag back brings runs back from the history
// with their tags. Without it such a start is a replaced reading's, and is ignored.
// `moving`: a tag control has not returned yet, so voxlektor may not have taken every move behind a ⏳ box.
export function applyEvent(input: {
  screen: Screen
  band: VoxBand
  event: VoxEvent
  owner: string
  epoch: number
  settled?: boolean
  follow?: boolean
  moving?: boolean
}): Applied {
  const applied = eventOn(input)
  // Any word from voxlektor means it is up; `disconnected` is the watcher's, which tries again.
  const connecting = input.event.type === 'daemon_off' || (input.event.type === 'disconnected' && input.band.connecting)

  return applied.band.connecting === connecting ? applied : { ...applied, band: { ...applied.band, connecting } }
}

// `failed`: why this session's reading is lost, for the fallback. `stopped`: the paragraph on screen was stopped from
// outside (a keyboard `vxl stop-reading`, or the daemon shutting down): end the dialog with `endStopped` unless a
// `disconnected` follows within about a second, which makes it a failure instead.
type Applied = { screen: Screen; band: VoxBand; failed: string | undefined; stopped: boolean }

// The reading stopped from outside ends where it stood; the replies queued behind it wait for the person's key.
export function endStopped(screen: Screen): Screen {
  const current = screen.current
  if (current === null || current.status === 'ended') return screen

  return { ...screen, current: { ...current, status: 'ended' } }
}

// The groups of ours the snapshot lists behind another session's, by position; passed-over ones are not waiting.
function waitsOf(groups: readonly VoxGroup[], owner: string): Record<string, number> {
  const waiting: Record<string, number> = {}
  for (const group of groups) {
    if (group.owner === owner && group.position !== null && group.position > 0) waiting[group.group] = group.position
  }

  return waiting
}

function eventOn(input: {
  screen: Screen
  band: VoxBand
  event: VoxEvent
  owner: string
  epoch: number
  settled?: boolean
  follow?: boolean
  moving?: boolean
}): Applied {
  const { screen, band, event, owner, epoch } = input
  const same: Applied = { screen, band, failed: undefined, stopped: false }
  const isOwn = (eventOwner: string | null) => eventOwner === owner
  // A tag of this session's current reading, or undefined.
  const current = (tag: string | undefined, eventOwner: string | null) => {
    if (tag === undefined || (eventOwner !== null && !isOwn(eventOwner))) return undefined

    const decoded = decodeTag(tag)

    return decoded?.epoch === epoch ? decoded : undefined
  }
  // With `follow`: a tag of the reply on screen from an earlier reading, brought back by a tag back.
  const followed = (tag: string | undefined, eventOwner: string | null) => {
    if (input.follow !== true || screen.current === null || tag === undefined || (eventOwner !== null && !isOwn(eventOwner))) return undefined

    const decoded = decodeTag(tag)

    return decoded !== undefined && decoded.epoch < epoch && inGroup(decoded.group)(screen.current) ? decoded : undefined
  }
  const fail = (reason: string): Applied => ({ ...same, failed: isReading(screen) ? reason : undefined })

  switch (event.type) {
    case 'tag_started': {
      const tag = current(event.tag, event.owner) ?? followed(event.tag, event.owner)
      if (tag === undefined) return same

      // Reading started, so this reply holds the floor.
      const floor = { ...same, band: { ...band, waiting: without(band.waiting, tag.group), floor: true } }
      // The box moved ahead on a key (⏳): another paragraph starting before voxlektor took every move is a step on the
      // way, so the box keeps its target. The matching start, or any start after that, is where voxlektor is.
      const on = screen.current
      const onTheWay = on !== null && on.pending === true && inGroup(tag.group)(on) && on.index !== tag.index && input.moving === true

      return onTheWay ? floor : { ...floor, screen: started(screen, tag.group, tag.index) }
    }
    case 'tag_finished': {
      const tag = current(event.tag, event.owner)
      if (tag === undefined) return same

      const on = screen.current
      const stopped =
        event.reason === 'stopped' && isReading(screen) && on !== null && inGroup(tag.group)(on) && on.index === tag.index

      return { ...same, screen: finished(screen, tag.group, tag.index, event.reason), stopped }
    }
    // A watcher (re)connected: the waits, the pauses and the floor are rebuilt from the snapshot, and our reading on
    // the floor puts the cursor right. A daemon of another protocol cannot be read with. With every order delivered
    // and none of our groups left, our reading ended while no watcher listened: it ends here as a stop does.
    case 'snapshot': {
      if (!speaksProtocol(event.protocol)) {
        return fail(`voxlektor speaks protocol v${String(event.protocol)}, newer than this dialogue-box supports`)
      }
      const floorGroup = event.groups.find(group => group.position === 0)
      const next: Applied = {
        ...same,
        band: {
          ...band,
          waiting: waitsOf(event.groups, owner),
          warming: event.state === 'LOADING',
          paused: event.groups.some(group => isOwn(group.owner) && group.paused),
          // Paused playback whose floor holder is not paused itself is the daemon-wide hold.
          held: event.paused && floorGroup?.paused !== true,
          floor: event.floorOwner !== null && isOwn(event.floorOwner),
        },
      }
      const tag = event.floorOwner !== null && isOwn(event.floorOwner) ? current(event.tag, event.floorOwner) : undefined
      if (tag !== undefined) return { ...next, screen: started(screen, tag.group, tag.index) }
      const gone = input.settled === true && isReading(screen) && !event.groups.some(group => isOwn(group.owner))

      return gone ? { ...next, screen: endStopped(screen) } : next
    }
    case 'state':
      return { ...same, band: { ...band, warming: event.state === 'LOADING' } }
    // This session's pause shows on its dialog too, also when the keyboard or voxlektor itself set or lifted it.
    case 'paused':
    case 'resumed': {
      if (event.owner !== null && !isOwn(event.owner)) return same

      const paused = event.type === 'paused'
      if (event.owner !== null) return { ...same, band: { ...band, paused }, screen: withStatus(screen, paused ? 'paused' : 'playing') }

      // A daemon-wide hold (the keyboard's pause). While this session speaks, its box shows paused, so the box's
      // resume sends the owner resume that lifts the hold (voxlektor lifts it for the floor holder only). Lifted, the
      // dialog plays again unless this session paused itself.
      const held = { ...same, band: { ...band, held: paused } }
      if (paused) return band.floor ? { ...held, screen: withStatus(screen, 'paused') } : held

      return band.paused ? held : { ...held, screen: withStatus(screen, 'playing') }
    }
    // Queued behind another session is not a failure: the reply waits its turn.
    case 'waiting':
      return isOwn(event.owner) && event.group !== null
        ? { ...same, band: { ...band, waiting: { ...band.waiting, [event.group]: event.position } } }
        : same
    // Another session's floor never ends our wait; ours ends the wait of that group.
    case 'floor':
      if (!isOwn(event.owner)) return { ...same, band: { ...band, floor: false } }

      return { ...same, band: { ...band, floor: true, waiting: event.group === null ? band.waiting : without(band.waiting, event.group) } }
    case 'drained':
      return isOwn(event.owner) ? { ...same, band: { ...band, waiting: {}, floor: false } } : same
    case 'error':
      return event.owner === null || isOwn(event.owner) ? fail(event.message === '' ? event.code : event.message) : same
    case 'disconnected':
      return fail('the daemon went away')
    // The watcher retries until the daemon is up, and `say` starts it: not a failure.
    case 'daemon_off':
      return same
  }
}

const FIRST_RESPAWN_MS = 500
const LONGEST_RESPAWN_MS = 30_000

// A watcher that keeps dying is tried less and less often, never less than every half minute.
export function respawnDelay(failures: number): number {
  return Math.min(LONGEST_RESPAWN_MS, FIRST_RESPAWN_MS * 2 ** Math.max(0, failures))
}
