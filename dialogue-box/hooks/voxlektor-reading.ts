import type { Dialog, SayRequest, VoxControl, VoxEvent, VoxReason } from '../types'
import { onClose, onNextReply } from './arrivals'
import type { Screen } from './arrivals'
import { nextParagraph } from './dialog'
import { displayText } from './speech'
import { decodeTag, encodeTag, groupOf, voxRate } from './voxlektor'

// What dialogue-box tells voxlektor for each screen transition, and what voxlektor's events do to the screen. Pure:
// register.tsx runs the orders and feeds the watcher's events; which dialog plays stays the policy of arrivals.ts.
//
// The caller keeps two values for the session: its owner id (`ownerFor`) and the reading epoch, which starts at 0.
// `ordersFor` returns the epoch to keep, and `applyEvent` ignores tags of any other epoch, so the events of a reading
// this session has since replaced never move the screen.

// What the band shows besides the dialog: replies queued behind another session (position per voxlektor group, see
// `waitingAhead`), the engine loading, voxlektor paused.
export type VoxBand = { waiting: Readonly<Record<string, number>>; warming: boolean; paused: boolean }

export const INITIAL_BAND: VoxBand = { waiting: {}, warming: false, paused: false }

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

// The cursor follows what voxlektor is reading. A started tag is being heard, so an ended dialog plays again; a
// paused one keeps its status.
function atParagraph(dialog: Dialog, index: number): Dialog {
  return { ...dialog, index, status: dialog.status === 'ended' ? 'playing' : dialog.status }
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

// Only a reply's own last paragraph, heard to the end or skipped, ends it. Replaced and back belong to a reading that
// goes on; stopped and error leave the cursor where the reading stopped, so a fallback that follows (`disconnected`,
// `error`) reads on from there; daemon-wide drained says nothing about this reply.
function finished(screen: Screen, group: string, index: number, reason: VoxReason): Screen {
  const current = screen.current
  if (reason !== 'done' && reason !== 'skipped') return screen
  if (current === null || !inGroup(group)(current) || current.index !== index || index !== current.paragraphs.length - 1) return screen

  return onClose({ ...screen, current: nextParagraph(current) })
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
export function applyEvent(input: {
  screen: Screen
  band: VoxBand
  event: VoxEvent
  owner: string
  epoch: number
}): { screen: Screen; band: VoxBand; failed: string | undefined } {
  const { screen, band, event, owner, epoch } = input
  const same = { screen, band, failed: undefined }
  const isOwn = (eventOwner: string | null) => eventOwner === owner
  // A tag of this session's current reading, or undefined.
  const current = (tag: string | undefined, eventOwner: string | null) => {
    if (tag === undefined || (eventOwner !== null && !isOwn(eventOwner))) return undefined

    const decoded = decodeTag(tag)

    return decoded?.epoch === epoch ? decoded : undefined
  }
  const fail = (reason: string) => ({ ...same, failed: isReading(screen) ? `voxlektor: ${reason}` : undefined })

  switch (event.type) {
    case 'tag_started': {
      const tag = current(event.tag, event.owner)
      // Reading started, so this reply holds the floor.
      return tag === undefined
        ? same
        : { ...same, screen: started(screen, tag.group, tag.index), band: { ...band, waiting: without(band.waiting, tag.group) } }
    }
    case 'tag_finished': {
      const tag = current(event.tag, event.owner)
      return tag === undefined ? same : { ...same, screen: finished(screen, tag.group, tag.index, event.reason) }
    }
    // A watcher (re)connected: waits it knew of may be stale, and our reading on the floor puts the cursor right.
    case 'snapshot': {
      const next = { ...same, band: { ...band, waiting: {}, warming: event.state === 'LOADING' } }
      const tag = event.floorOwner !== null && isOwn(event.floorOwner) ? current(event.tag, event.floorOwner) : undefined

      return tag === undefined ? next : { ...next, screen: started(screen, tag.group, tag.index) }
    }
    case 'state':
      return { ...same, band: { ...band, warming: event.state === 'LOADING' } }
    // This session's pause shows on its dialog too, also when the keyboard or voxlektor itself set or lifted it; a
    // daemon-wide hold (no owner) shows only on the band.
    case 'paused':
    case 'resumed': {
      if (event.owner !== null && !isOwn(event.owner)) return same

      const paused = event.type === 'paused'
      const next = { ...same, band: { ...band, paused } }

      return event.owner === null ? next : { ...next, screen: withStatus(screen, paused ? 'paused' : 'playing') }
    }
    // Queued behind another session is not a failure: the reply waits its turn.
    case 'waiting':
      return isOwn(event.owner) && event.group !== null
        ? { ...same, band: { ...band, waiting: { ...band.waiting, [event.group]: event.position } } }
        : same
    // Another session's floor never ends our wait; ours ends the wait of that group.
    case 'floor':
      return isOwn(event.owner) && event.group !== null ? { ...same, band: { ...band, waiting: without(band.waiting, event.group) } } : same
    case 'drained':
      return isOwn(event.owner) ? { ...same, band: { ...band, waiting: {} } } : same
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
