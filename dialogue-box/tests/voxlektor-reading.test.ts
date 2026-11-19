import { expect, test } from 'claude-code/testing'

import type { Screen } from '../hooks/arrivals'
import { startDialog } from '../hooks/dialog'
import { displayText } from '../hooks/speech'
import type { VoxEvent } from '../types'
import { encodeTag, groupOf, voxRate } from '../hooks/voxlektor'
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
  trailReplaced,
  waitingAhead,
} from '../hooks/voxlektor-reading'
import type { TagTrail, VoxBand, VoxOrder } from '../hooks/voxlektor-reading'

const d1 = startDialog('d1', ['Pierwszy <lang xml:lang="en">akapit</lang>.', 'Drugi akapit.', 'Trzeci akapit.'], 'pl')
const d2 = startDialog('d2', ['Agent w tle skończył.', 'Wynik jest gotowy.'], 'pl')

const OWNER = 'o1'
// The reading epoch this session is at when the events below arrive.
const EPOCH = 4

const empty: Screen = { current: null, queue: [], history: [] }
const band: VoxBand = INITIAL_BAND

const plan = (before: Screen, after: Screen, extra: { preempt?: boolean; reread?: boolean; multiplier?: number; epoch?: number } = {}) =>
  ordersFor({
    owner: OWNER,
    before,
    after,
    profileRate: 1,
    multiplier: extra.multiplier ?? 1.25,
    preempt: extra.preempt ?? false,
    reread: extra.reread ?? false,
    epoch: extra.epoch ?? EPOCH,
  })

const orders = (...args: Parameters<typeof plan>) => plan(...args).orders
const says = (list: VoxOrder[]) => list.flatMap(order => (order.kind === 'say' ? [order.request] : []))

const apply = (screen: Screen, event: VoxEvent, at: VoxBand = band, epoch = EPOCH) =>
  applyEvent({ screen, band: at, event, owner: OWNER, epoch })

const tag = (dialogId: string, index: number, epoch = EPOCH) => encodeTag(dialogId, index, epoch)
const started = (dialogId: string, index: number, epoch = EPOCH): VoxEvent => ({ type: 'tag_started', owner: OWNER, tag: tag(dialogId, index, epoch) })
const finished = (dialogId: string, index: number, reason: Extract<VoxEvent, { type: 'tag_finished' }>['reason'], epoch = EPOCH): VoxEvent => ({
  type: 'tag_finished',
  owner: OWNER,
  tag: tag(dialogId, index, epoch),
  reason,
})
type Snapshot = Extract<VoxEvent, { type: 'snapshot' }>
const snap = (fields: Partial<Snapshot> = {}): Snapshot => ({
  type: 'snapshot',
  state: 'WARM',
  version: '0.2.0',
  protocol: undefined,
  caps: [],
  tag: undefined,
  floorOwner: null,
  outdated: false,
  paused: false,
  groups: [],
  ...fields,
})

test('a new current reply is queued whole under a new reading epoch, the first paragraph replacing this session\'s reading', async () => {
  const { orders: list, epoch } = plan(empty, { ...empty, current: d1 })

  expect(epoch).toBe(EPOCH + 1)
  expect(list).toHaveLength(3)
  expect(says(list).map(request => request.tag)).toEqual([0, 1, 2].map(index => tag('d1', index, EPOCH + 1)))
  expect(says(list).map(request => request.group)).toEqual([groupOf('d1'), groupOf('d1'), groupOf('d1')])
  expect(says(list).map(request => request.now)).toEqual([true, false, false])
  expect(says(list).map(request => request.text)).toEqual(d1.paragraphs.map(displayText))
  expect(says(list).every(request => request.rate === voxRate(1, 1.25) && request.owner === OWNER)).toBe(true)
  expect(says(list).some(request => request.preempt)).toBe(false)
})

test('queued replies are appended right after the current one', async () => {
  const requests = says(orders(empty, { ...empty, current: d1, queue: [d2] }))

  expect(requests.map(request => request.tag)).toEqual([
    tag('d1', 0, EPOCH + 1), tag('d1', 1, EPOCH + 1), tag('d1', 2, EPOCH + 1), tag('d2', 0, EPOCH + 1), tag('d2', 1, EPOCH + 1),
  ])
  expect(requests.slice(3).every(request => request.group === groupOf('d2') && !request.now)).toBe(true)
})

test('a reply that arrives while one plays is only appended, in the same epoch', async () => {
  const { orders: list, epoch } = plan({ ...empty, current: d1 }, { ...empty, current: d1, queue: [d2] })

  expect(epoch).toBe(EPOCH)
  expect(says(list).map(request => request.tag)).toEqual([tag('d2', 0), tag('d2', 1)])
  expect(says(list).some(request => request.now)).toBe(false)
})

test('skip and back re-queue from the target paragraph', async () => {
  const requests = says(orders({ ...empty, current: d1, queue: [d2] }, { ...empty, current: { ...d1, index: 2 }, queue: [d2] }))

  expect(requests.map(request => request.tag)).toEqual([tag('d1', 2, EPOCH + 1), tag('d2', 0, EPOCH + 1), tag('d2', 1, EPOCH + 1)])
  expect(requests.map(request => request.now)).toEqual([true, false, false])
})

test('another reply on screen re-queues from where it stands', async () => {
  const requests = says(orders({ ...empty, current: d1, queue: [d2] }, { current: d2, queue: [], history: [d1] }))

  expect(requests.map(request => request.tag)).toEqual([tag('d2', 0, EPOCH + 1), tag('d2', 1, EPOCH + 1)])
  expect(requests.map(request => request.now)).toEqual([true, false])
})

test('pause and resume are controls, not re-readings', async () => {
  const paused = { ...d1, status: 'paused' as const }

  expect(plan({ ...empty, current: d1 }, { ...empty, current: paused })).toEqual({ orders: [{ kind: 'control', control: 'pause' }], epoch: EPOCH })
  expect(orders({ ...empty, current: paused }, { ...empty, current: d1 })).toEqual([{ kind: 'control', control: 'resume' }])
})

test('a replay reads again, an ending in place tells voxlektor nothing', async () => {
  const ended = { ...d1, index: 2, status: 'ended' as const }

  expect(orders({ ...empty, current: ended }, { ...empty, current: { ...ended, status: 'paused' } })).toEqual([])
  expect(says(orders({ ...empty, current: ended }, { ...empty, current: { ...ended, status: 'playing' } })).map(request => request.tag))
    .toEqual([tag('d1', 2, EPOCH + 1)])
})

test('skipping the last paragraph stops this session\'s reading', async () => {
  const last = { ...d1, index: 2 }

  expect(orders({ ...empty, current: last }, { ...empty, current: { ...last, status: 'ended' } })).toEqual([{ kind: 'control', control: 'stop' }])
})

test('dismissing stops only this session', async () => {
  expect(orders({ ...empty, current: d1, queue: [d2] }, { current: null, queue: [], history: [d1] }))
    .toEqual([{ kind: 'control', control: 'stop' }])
  expect(orders(empty, empty)).toEqual([])
})

test('a re-read starts again from the current paragraph', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 1 } }
  const requests = says(orders(screen, screen, { reread: true, multiplier: 1.5 }))

  expect(requests.map(request => request.tag)).toEqual([tag('d1', 1, EPOCH + 1), tag('d1', 2, EPOCH + 1)])
  expect(requests.map(request => request.now)).toEqual([true, false])
  expect(requests.every(request => request.rate === voxRate(1, 1.5))).toBe(true)
  expect(orders(screen, screen, { reread: false })).toEqual([])
})

test('back on the first paragraph re-reads it', async () => {
  const screen: Screen = { ...empty, current: d1 }

  expect(says(orders(screen, screen, { reread: true })).map(request => request.tag)).toEqual([0, 1, 2].map(index => tag('d1', index, EPOCH + 1)))
})

test('a re-read waits while paused and is sent on resume', async () => {
  const paused: Screen = { ...empty, current: { ...d1, index: 1, status: 'paused' } }
  const playing: Screen = { ...empty, current: { ...d1, index: 1 } }

  expect(orders(paused, paused, { reread: true })).toEqual([])
  expect(says(orders(paused, playing, { reread: true })).map(request => request.now)).toEqual([true, false])
})

test('the play-now press takes the floor and replaces this session\'s queued reading', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 1 } }
  const requests = says(orders(screen, screen, { preempt: true }))

  expect(requests[0]?.tag).toBe(tag('d1', 1, EPOCH + 1))
  expect(requests[0]?.preempt).toBe(true)
  expect(requests[0]?.now).toBe(true)
  expect(requests.slice(1).some(request => request.preempt || request.now)).toBe(false)
})

test('tag_started moves the cursor, also into the next reply', async () => {
  const screen: Screen = { ...empty, current: d1, queue: [d2] }
  const next = apply(screen, started('d2', 0))

  expect(next.screen.current?.id).toBe('d2')
  expect(next.screen.current?.index).toBe(0)
  expect(next.screen.queue).toEqual([])
  expect(next.screen.history.map(dialog => dialog.id)).toEqual(['d1'])
  expect(apply(screen, started('d1', 1)).screen.current?.index).toBe(1)
})

test('a tag of a reply no longer on screen is ignored', async () => {
  const screen: Screen = { current: d2, queue: [], history: [d1] }
  const next = apply(screen, started('d1', 2))

  expect(next.screen).toEqual(screen)
  expect(next.failed).toBeUndefined()
})

test('a tag of an earlier reading is ignored, so a replaced reading cannot move the screen', async () => {
  // Previous reply: d1 on screen, d2 queued again; the old reading of d2 still reports in.
  const screen: Screen = { current: d1, queue: [d2], history: [] }

  expect(apply(screen, started('d2', 1, EPOCH - 1)).screen).toEqual(screen)
  expect(apply({ ...empty, current: { ...d1, index: 2 } }, finished('d1', 2, 'done', EPOCH - 1)).screen.current?.status).toBe('playing')
})

test('another owner\'s tag is ignored', async () => {
  const screen: Screen = { ...empty, current: d1 }

  expect(apply(screen, { type: 'tag_started', owner: 'o2', tag: tag('d1', 1) }).screen).toEqual(screen)
})

test('a dialog ends when its last tag is done or skipped, not on drained', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 2 } }

  expect(apply(screen, finished('d1', 2, 'done')).screen.current?.status).toBe('ended')
  expect(apply(screen, finished('d1', 2, 'skipped')).screen.current?.status).toBe('ended')
  expect(apply(screen, finished('d1', 1, 'done')).screen).toEqual(screen)
  expect(apply(screen, { type: 'drained', owner: OWNER }).screen).toEqual(screen)
})

test('the last paragraph done or skipped ends the dialog also while the box still shows an earlier one', async () => {
  // A second quick skip dropped the last paragraph before it ever started: no tag_started came for it.
  const screen: Screen = { ...empty, current: { ...d1, index: 1 } }

  expect(apply(screen, finished('d1', 2, 'skipped')).screen.current?.status).toBe('ended')
  expect(apply(screen, finished('d1', 2, 'done')).screen.current?.status).toBe('ended')
  // Not past the box, not of an earlier reading, and only the last paragraph.
  expect(apply({ ...empty, current: { ...d1, index: 2 } }, finished('d1', 1, 'skipped')).screen.current?.status).toBe('playing')
  expect(apply(screen, finished('d1', 2, 'skipped', EPOCH - 1)).screen).toEqual(screen)
  expect(apply({ ...empty, current: d1 }, finished('d1', 1, 'skipped')).screen.current).toMatchObject({ index: 0, status: 'playing' })
})

test('replaced, back, stopped, error or an unknown reason never end a dialog', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 2 } }

  for (const reason of ['replaced', 'back', 'stopped', 'error', 'unknown'] as const) {
    const next = apply(screen, finished('d1', 2, reason))

    expect(next.screen).toEqual(screen)
    expect(next.failed).toBeUndefined()
  }
})

test('a reply ends and the next one takes the screen', async () => {
  const next = apply({ ...empty, current: { ...d1, index: 2 }, queue: [d2] }, finished('d1', 2, 'done'))

  expect(next.screen.current?.id).toBe('d2')
})

test('a reply queued behind another session waits and does not stop it', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const waiting = apply(screen, { type: 'waiting', owner: OWNER, group: groupOf('d1'), position: 2 })

  expect(waitingAhead(screen, waiting.band)).toBe(2)
  expect(waiting.failed).toBeUndefined()
  expect(waiting.screen).toEqual(screen)
  expect(waitingAhead(screen, apply(screen, { type: 'floor', owner: OWNER, group: groupOf('d1') }, waiting.band).band)).toBeUndefined()
})

test('another session taking the floor does not end our wait', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const waiting = apply(screen, { type: 'waiting', owner: OWNER, group: groupOf('d1'), position: 1 }).band

  expect(waitingAhead(screen, apply(screen, { type: 'floor', owner: 'o2', group: 'x' }, waiting).band)).toBe(1)
})

test('only the reply on screen shows as waiting', async () => {
  const screen: Screen = { ...empty, current: d1, queue: [d2] }
  const waiting = apply(screen, { type: 'waiting', owner: OWNER, group: groupOf('d2'), position: 1 }).band

  expect(waitingAhead(screen, waiting)).toBeUndefined()
  expect(waitingAhead({ current: d2, queue: [], history: [d1] }, waiting)).toBe(1)
})

test('our tag starting ends the wait of its reply', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const waiting = apply(screen, { type: 'waiting', owner: OWNER, group: groupOf('d1'), position: 1 }).band

  expect(waitingAhead(screen, apply(screen, started('d1', 0), waiting).band)).toBeUndefined()
})

test('nothing left in voxlektor or a new snapshot clears the waits', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const waiting = apply(screen, { type: 'waiting', owner: OWNER, group: groupOf('d1'), position: 1 }).band
  const snapshot = snap()

  expect(waitingAhead(screen, apply(screen, { type: 'drained', owner: OWNER }, waiting).band)).toBeUndefined()
  expect(waitingAhead(screen, apply(screen, { type: 'drained', owner: null }, waiting).band)).toBe(1)
  expect(waitingAhead(screen, apply(screen, snapshot, waiting).band)).toBeUndefined()
})

test('a snapshot with our reading on the floor puts the cursor on its tag', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const ours = snap({ tag: tag('d1', 2), floorOwner: OWNER })

  expect(apply(screen, ours).screen.current?.index).toBe(2)
  expect(apply(screen, { ...ours, floorOwner: 'o2' }).screen).toEqual(screen)
})

test('a snapshot without our groups ends our reading once every order was delivered', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 1 }, queue: [d2] }
  const gone = snap({ floorOwner: 'o2', groups: [{ owner: 'o2', group: 'x', position: 0, paused: false }] })
  const settled = (event: VoxEvent, on: Screen = screen) => applyEvent({ screen: on, band, event, owner: OWNER, epoch: EPOCH, settled: true })

  const ended = settled(gone).screen
  expect(ended.current?.status).toBe('ended')
  expect(ended.current?.index).toBe(1)
  expect(ended.queue.map(dialog => dialog.id)).toEqual(['d2'])
  // A paused reading is gone as well.
  expect(settled(gone, { ...screen, current: { ...d1, status: 'paused' } }).screen.current?.status).toBe('ended')
  // While an order may still be on its way, its groups may not be there yet.
  expect(apply(screen, gone).screen).toEqual(screen)
  // Our group still queued (also passed over) keeps the reading.
  const kept = snap({ groups: [{ owner: OWNER, group: groupOf('d1'), position: null, paused: true }] })
  expect(settled(kept).screen).toEqual(screen)
  // Nothing of ours reading: nothing to end.
  const idle: Screen = { ...empty, current: { ...d1, status: 'ended' } }
  expect(settled(gone, idle).screen).toEqual(idle)
})

test('a snapshot of another protocol version is a failure while we read', async () => {
  const reading: Screen = { ...empty, current: d1 }

  expect(apply(reading, snap({ protocol: 2 })).failed).toBe('voxlektor speaks protocol v2, newer than this dialogue-box supports')
  expect(apply(reading, snap({ protocol: 1 })).failed).toBeUndefined()
  expect(apply(reading, snap()).failed).toBeUndefined()
  expect(apply(empty, snap({ protocol: 2 })).failed).toBeUndefined()
})

test('a new reply after a stop plays unpaused', async () => {
  const screen: Screen = { ...empty, current: d1 }

  expect(apply(screen, { type: 'resumed', owner: OWNER }, { ...band, paused: true }).band.paused).toBe(false)
  expect(apply(screen, { type: 'paused', owner: OWNER }).band.paused).toBe(true)

  const snapshot = apply(screen, snap({ state: 'LOADING', paused: true }))
  expect(snapshot.band.warming).toBe(true)
  // The snapshot's pause says nothing about this session's own pause.
  expect(snapshot.band.paused).toBe(false)
})

test('a keyboard hold shows as held; it pauses the dialog only while this session holds the floor', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const hold: VoxEvent = { type: 'paused', owner: null }
  const lift: VoxEvent = { type: 'resumed', owner: null }

  // Another session speaks: only the band says the daemon is held.
  const elsewhere = apply(screen, hold)
  expect(elsewhere.band.held).toBe(true)
  expect(elsewhere.band.paused).toBe(false)
  expect(elsewhere.screen).toEqual(screen)
  expect(apply(screen, lift, elsewhere.band).band.held).toBe(false)

  // This session speaks: the box shows paused, so its resume sends the owner resume that lifts the hold.
  const onFloor = apply(screen, { type: 'floor', owner: OWNER, group: groupOf('d1') })
  expect(onFloor.band.floor).toBe(true)
  const held = apply(screen, hold, onFloor.band)
  expect(held.screen.current?.status).toBe('paused')
  const lifted = apply(held.screen, lift, held.band)
  expect(lifted.band.held).toBe(false)
  expect(lifted.screen.current?.status).toBe('playing')

  // A pause of this session's own outlives the hold.
  const ownPause = apply(held.screen, { type: 'paused', owner: OWNER }, held.band)
  expect(apply(ownPause.screen, lift, ownPause.band).screen.current?.status).toBe('paused')
})

test('the floor follows floor events, our tag starting, our drain and the snapshot', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const ours = apply(screen, started('d1', 0)).band

  expect(ours.floor).toBe(true)
  expect(apply(screen, { type: 'floor', owner: 'o2', group: 'x' }, ours).band.floor).toBe(false)
  expect(apply(screen, { type: 'drained', owner: OWNER }, ours).band.floor).toBe(false)
  expect(apply(screen, snap({ floorOwner: OWNER })).band.floor).toBe(true)
  expect(apply(screen, snap({ floorOwner: 'o2' }), ours).band.floor).toBe(false)
})

test('a snapshot rebuilds our waits from its groups and the hold from its pause', async () => {
  const screen: Screen = { ...empty, current: d1, queue: [d2] }
  const next = apply(screen, snap({
    floorOwner: 'o2',
    paused: true,
    groups: [
      { owner: 'o2', group: 'x', position: 0, paused: false },
      { owner: OWNER, group: groupOf('d1'), position: 1, paused: false },
      { owner: 'o3', group: groupOf('d2'), position: 2, paused: false },
      { owner: OWNER, group: groupOf('d2'), position: null, paused: true },
    ],
  }))

  expect(waitingAhead(screen, next.band)).toBe(1)
  expect(next.band.waiting).toEqual({ [groupOf('d1')]: 1 })
  expect(next.band.held).toBe(true)
  // A paused floor holder is its owner's pause, not a hold.
  const ownersPause = snap({ floorOwner: 'o2', paused: true, groups: [{ owner: 'o2', group: 'x', position: 0, paused: true }] })
  expect(apply(screen, ownersPause).band.held).toBe(false)
})

test('a stop from outside of the paragraph being read is reported, so the box can end once no disconnect follows', async () => {
  const screen: Screen = { ...empty, current: { ...d1, index: 1 } }

  expect(apply(screen, finished('d1', 1, 'stopped')).stopped).toBe(true)
  expect(apply(screen, finished('d1', 1, 'stopped')).screen).toEqual(screen)
  expect(apply(screen, finished('d1', 2, 'stopped')).stopped).toBe(false)
  expect(apply(screen, finished('d1', 1, 'stopped', EPOCH - 1)).stopped).toBe(false)
  expect(apply(screen, finished('d1', 1, 'replaced')).stopped).toBe(false)
  expect(apply({ ...empty, current: { ...d1, index: 1, status: 'ended' } }, finished('d1', 1, 'stopped')).stopped).toBe(false)

  const ended = endStopped({ ...screen, queue: [d2] })
  expect(ended.current?.status).toBe('ended')
  expect(ended.current?.index).toBe(1)
  expect(ended.queue.map(dialog => dialog.id)).toEqual(['d2'])
})

test('a daemon not up yet shows as connecting until an event comes from it', async () => {
  const off = apply({ ...empty, current: d1 }, { type: 'daemon_off' })

  expect(off.band.connecting).toBe(true)
  expect(apply({ ...empty, current: d1 }, { type: 'disconnected' }, off.band).band.connecting).toBe(true)
  expect(apply({ ...empty, current: d1 }, snap(), off.band).band.connecting).toBe(false)
})

test('a pause or resume made outside this session shows on the dialog', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const paused = apply(screen, { type: 'paused', owner: OWNER })

  expect(paused.screen.current?.status).toBe('paused')
  expect(apply(paused.screen, { type: 'resumed', owner: OWNER }, paused.band).screen.current?.status).toBe('playing')
  expect(apply(screen, { type: 'paused', owner: 'o2' }).band.paused).toBe(false)
  const ended: Screen = { ...empty, current: { ...d1, status: 'ended' } }
  expect(apply(ended, { type: 'resumed', owner: OWNER }).screen).toEqual(ended)
})

test('warming while the engine loads', async () => {
  const warming = apply(empty, { type: 'state', state: 'LOADING' })

  expect(warming.band.warming).toBe(true)
  expect(apply(empty, { type: 'state', state: 'WARM' }, warming.band).band.warming).toBe(false)
})

test('failures while this session reads give a fallback reason', async () => {
  const reading: Screen = { ...empty, current: d1 }

  expect(apply(reading, { type: 'error', owner: OWNER, code: 'audio', message: 'no output device' }).failed).toBe('no output device')
  expect(apply(reading, { type: 'error', owner: null, code: 'engine', message: '' }).failed).toBe('engine')
  expect(apply(reading, { type: 'disconnected' }).failed).toBeDefined()
  expect(apply({ ...empty, current: { ...d1, status: 'paused' } }, { type: 'disconnected' }).failed).toBeDefined()
})

test('a failure with nothing of ours in voxlektor, or another owner\'s, is no fallback', async () => {
  const idle: Screen = { ...empty, current: { ...d1, status: 'ended' } }

  expect(apply(empty, { type: 'error', owner: null, code: 'audio', message: 'x' }).failed).toBeUndefined()
  expect(apply(idle, { type: 'disconnected' }).failed).toBeUndefined()
  expect(apply({ ...empty, current: d1 }, { type: 'error', owner: 'o2', code: 'audio', message: 'x' }).failed).toBeUndefined()
})

test('a daemon that is not up yet is no failure: the watcher retries', async () => {
  expect(apply({ ...empty, current: d1 }, { type: 'daemon_off' }).failed).toBeUndefined()
  expect(apply(empty, { type: 'daemon_off' }).failed).toBeUndefined()
})

// d1's first two paragraphs heard to the end: both are in voxlektor's history.
const HEARD: TagTrail = { ...NO_TRAIL, dialog: 'd1', heard: 2 }
const navigate = (
  before: Screen,
  after: Screen,
  move: 'skip' | 'back' | undefined,
  extra: { tagNav?: boolean; floor?: boolean; trail?: TagTrail } = {},
) => navigationFor({ before, after, move, tagNav: extra.tagNav ?? true, floor: extra.floor ?? true, trail: extra.trail ?? HEARD })

test('with tag navigation, skip and back on a playing reading are one owner control, not a re-read', async () => {
  const at = (index: number): Screen => ({ ...empty, current: { ...d1, index } })

  expect(navigate(at(0), at(1), 'skip')).toEqual({ kind: 'control', control: 'skip' })
  expect(navigate(at(2), at(1), 'back')).toEqual({ kind: 'control', control: 'back' })
  // Skip on the last paragraph is a skip too: its tag finishes `skipped`, which ends the dialog.
  expect(navigate(at(2), { ...empty, current: { ...d1, index: 2, status: 'ended' } }, 'skip')).toEqual({ kind: 'control', control: 'skip' })
})

test('tag navigation is left to the re-read wherever voxlektor\'s move could differ from the box\'s', async () => {
  const at = (index: number, status: 'playing' | 'paused' | 'ended' = 'playing'): Screen => ({ ...empty, current: { ...d1, index, status } })

  // Not offered: no tag_nav, an outdated daemon, or no key press at all.
  expect(navigate(at(0), at(1), 'skip', { tagNav: false })).toBeUndefined()
  expect(navigate(at(0), at(1), undefined)).toBeUndefined()
  // Waiting behind another session: voxlektor ignores an owner skip there.
  expect(navigate(at(0), at(1), 'skip', { floor: false })).toBeUndefined()
  // Paused: the re-read waits for resume, as today.
  expect(navigate(at(0, 'paused'), at(1, 'paused'), 'skip')).toBeUndefined()
  // Back on the first paragraph restarts it; voxlektor could go back into the reply before.
  expect(navigate(at(0), at(0), 'back')).toBeUndefined()
  // An ended reply played again, and a skip that lands on the next reply.
  expect(navigate(at(2, 'ended'), at(1), 'back')).toBeUndefined()
  expect(navigate({ ...empty, current: { ...d1, index: 2 }, queue: [d2] }, { current: d2, queue: [], history: [d1] }, 'skip')).toBeUndefined()
  // A move the key did not make (the screen moved some other way).
  expect(navigate(at(0), at(2), 'skip')).toBeUndefined()
  expect(navigate(at(1), at(2), 'back')).toBeUndefined()
})

test('the box follows voxlektor\'s back: a restarted paragraph keeps the cursor, the previous one moves it', async () => {
  const on2: Screen = { ...empty, current: { ...d1, index: 2 } }
  const cut = apply(on2, finished('d1', 2, 'back')).screen

  expect(cut).toEqual(on2)
  expect(apply(cut, started('d1', 2)).screen.current).toMatchObject({ index: 2, status: 'playing' })
  expect(apply(cut, started('d1', 1)).screen.current).toMatchObject({ index: 1, status: 'playing' })
})

test('back by tag only while voxlektor\'s history surely holds a paragraph of this reply before the one on screen', async () => {
  const at = (index: number): Screen => ({ ...empty, current: { ...d1, index } })

  expect(navigate(at(2), at(1), 'back', { trail: { ...NO_TRAIL, dialog: 'd1', heard: 1 } })).toEqual({ kind: 'control', control: 'back' })
  // Nothing of d1 heard to the end (read again from here, or its paragraphs skipped): the back could leave the reply.
  expect(navigate(at(2), at(1), 'back', { trail: NO_TRAIL })).toBeUndefined()
  expect(navigate(at(2), at(1), 'back', { trail: { ...NO_TRAIL, dialog: 'd1', heard: 0 } })).toBeUndefined()
  // What was heard of another reply says nothing about this one.
  expect(navigate(at(2), at(1), 'back', { trail: { ...NO_TRAIL, dialog: 'd2', heard: 2 } })).toBeUndefined()
  // Skip never leaves the reply backwards, so it needs nothing heard.
  expect(navigate(at(1), at(2), 'skip', { trail: NO_TRAIL })).toEqual({ kind: 'control', control: 'skip' })
})

test('the trail counts paragraphs heard to the end, each tag back uses one up, and another reply starts afresh', async () => {
  const on2: Screen = { ...empty, current: { ...d1, index: 2 }, queue: [d2] }
  const after = (trail: TagTrail, event: VoxEvent, screen: Screen = on2) => trailAfter({ trail, screen, event, owner: OWNER, epoch: EPOCH })

  // Done in any reading of d1 (an earlier epoch was heard too); not skipped, another reply's or another owner's.
  let trail = after(NO_TRAIL, finished('d1', 0, 'done', EPOCH - 2))
  trail = after(trail, finished('d1', 1, 'done'))
  trail = after(trail, finished('d1', 1, 'skipped'))
  trail = after(trail, finished('d2', 0, 'done'))
  trail = after(trail, { type: 'tag_finished', owner: 'o2', tag: tag('d1', 1), reason: 'done' })
  expect(trail).toMatchObject({ dialog: 'd1', heard: 2, navigated: false, backs: 0 })
  // Before any tag move, a start of an earlier reading is a replaced one's: nothing changes.
  expect(after(trail, started('d1', 1, EPOCH - 2))).toEqual(trail)

  // Each back sent uses one up (it may bring back the paragraph before); a skip uses none.
  trail = trailMoved(trail, 'd1', 'back')
  trail = trailMoved(trail, 'd1', 'skip')
  expect(trail).toMatchObject({ dialog: 'd1', heard: 1, navigated: true, backs: 1 })
  expect(trailFollows(trail, on2)).toBe(true)
  expect(trailFollows(trail, { ...empty, current: d2 })).toBe(false)

  // A start of d1 answers a back, whatever reading it was first handed over in.
  trail = after(trail, started('d1', 1, EPOCH - 2))
  expect(trail).toMatchObject({ dialog: 'd1', heard: 1, navigated: true, backs: 0, playing: tag('d1', 1, EPOCH - 2) })
  expect(after(trail, started('d1', 2))).toMatchObject({ backs: 0 })
  // A new reading ends the following; voxlektor's history stays.
  expect(trailReplaced(trail)).toMatchObject({ dialog: 'd1', heard: 1, navigated: false, backs: 0 })
  expect(trailFollows(trailReplaced(trail), on2)).toBe(false)
  // Nothing left of ours in voxlektor: nothing to follow.
  expect(after(trail, { type: 'drained', owner: OWNER })).toMatchObject({ dialog: 'd1', heard: 1, navigated: false })
  // Another reply on screen starts afresh.
  expect(trailMoved(trail, 'd2', 'skip')).toEqual({ dialog: 'd2', heard: 0, navigated: true, backs: 0, playing: undefined, uncertain: false })
  expect(after(trail, finished('d2', 0, 'done'), { ...empty, current: d2 })).toMatchObject({ dialog: 'd2', heard: 1, navigated: false })
  // Never below zero.
  expect(trailMoved(NO_TRAIL, 'd1', 'back')).toMatchObject({ dialog: 'd1', heard: 0, navigated: true, backs: 1 })
})

test('a back that voxlektor turned into a restart of the paragraph playing gives back what it used up', async () => {
  const on2: Screen = { ...empty, current: { ...d1, index: 2 } }
  const after = (trail: TagTrail, event: VoxEvent) => trailAfter({ trail, screen: on2, event, owner: OWNER, epoch: EPOCH })
  const playing = after({ ...NO_TRAIL, dialog: 'd1', heard: 2 }, started('d1', 2))

  // The same tag starts again: a restart, nothing came back from the history.
  const restarted = after(after(trailMoved(playing, 'd1', 'back'), finished('d1', 2, 'back')), started('d1', 2))
  expect(restarted).toMatchObject({ heard: 2, backs: 0 })
  // Paragraph 3 as read before a rate change has another tag: it came back from the history.
  expect(after(trailMoved(playing, 'd1', 'back'), started('d1', 2, EPOCH - 1))).toMatchObject({ heard: 1, backs: 0 })
  expect(after(trailMoved(playing, 'd1', 'back'), started('d1', 1))).toMatchObject({ heard: 1, backs: 0 })
  // Heard to the end, then brought back before the next paragraph started: not a restart.
  const done = after(playing, finished('d1', 2, 'done'))
  expect(done).toMatchObject({ heard: 3, playing: undefined })
  expect(after(trailMoved(done, 'd1', 'back'), started('d1', 2))).toMatchObject({ heard: 2 })
  // The snapshot names the tag playing, too.
  const snapped = after({ ...NO_TRAIL, dialog: 'd1', heard: 2 }, snap({ floorOwner: OWNER, tag: tag('d1', 2) }))
  expect(after(trailMoved(snapped, 'd1', 'back'), started('d1', 2))).toMatchObject({ heard: 2 })
})

test('once tag navigation moved the reading, a start of the reply on screen moves the box whatever reading it came from', async () => {
  const on2: Screen = { ...empty, current: { ...d1, index: 2 }, queue: [d2] }
  const follow = (event: VoxEvent) => applyEvent({ screen: on2, band, event, owner: OWNER, epoch: EPOCH, follow: true }).screen

  // voxlektor's back brings back paragraph 2 as first read, under an earlier epoch (a rate change since).
  expect(follow(started('d1', 1, EPOCH - 3)).current).toMatchObject({ index: 1, status: 'playing' })
  // Without tag navigation in this reading that stays a replaced reading's event.
  expect(apply(on2, started('d1', 1, EPOCH - 3)).screen).toEqual(on2)
  // Never another reply's, another owner's, or a tag of a later epoch.
  expect(follow(started('d2', 0, EPOCH - 3))).toEqual(on2)
  expect(follow({ type: 'tag_started', owner: 'o2', tag: tag('d1', 1, EPOCH - 3) })).toEqual(on2)
  expect(follow(started('d1', 1, EPOCH + 1))).toEqual(on2)
})

test('a back from a paragraph already started may be a restart, so until voxlektor answers the next key re-reads', async () => {
  const at = (index: number): Screen => ({ ...empty, current: { ...d1, index } })

  // The box showed a paragraph voxlektor had started: its back restarts it or goes to the one before.
  const unsure = trailMoved(HEARD, 'd1', 'back', true)
  expect(unsure.uncertain).toBe(true)
  // Composed from the box (back then skip, back then back): one `now` re-read from the box makes voxlektor end there.
  expect(navigate(at(1), at(2), 'skip', { trail: unsure })).toBeUndefined()
  expect(navigate(at(1), at(0), 'back', { trail: unsure })).toBeUndefined()
  // A back while the box still waits for the start of its last move: that run has not played, so it goes to the one
  // before for sure. Skips never leave doubt.
  expect(trailMoved(HEARD, 'd1', 'back', false).uncertain).toBe(false)
  expect(trailMoved(HEARD, 'd1', 'skip', true).uncertain).toBe(false)

  // voxlektor answered (a start after every tag move was taken): no doubt left. Not while moves are still on their way.
  const on1: Screen = { ...empty, current: { ...d1, index: 1, pending: true } }
  const answer = (moving: boolean) => trailAfter({ trail: unsure, screen: on1, event: started('d1', 2), owner: OWNER, epoch: EPOCH, moving })
  expect(answer(false).uncertain).toBe(false)
  expect(answer(true).uncertain).toBe(true)
  expect(trailReplaced(unsure).uncertain).toBe(false)
})

test('a box moved ahead of voxlektor waits for the matching start, then follows whatever voxlektor reports', async () => {
  // The box moved to paragraph 2 on the key and waits (⏳).
  const ahead: Screen = { ...empty, current: { ...d1, index: 1, pending: true } }
  const on = (event: VoxEvent, moving: boolean) =>
    applyEvent({ screen: ahead, band, event, owner: OWNER, epoch: EPOCH, follow: true, moving }).screen.current

  // The matching start confirms it, also while moves are still on their way.
  expect(on(started('d1', 1), true)).toEqual({ ...d1, index: 1 })
  // Another paragraph starting while moves are still on their way is a step in between: the box keeps its target.
  expect(on(started('d1', 2), true)).toEqual(ahead.current)
  // Once every move was taken, voxlektor is right (it restarted the paragraph instead of going back).
  expect(on(started('d1', 2), false)).toEqual({ ...d1, index: 2 })
})

test('after a stop, a cancelled reading that starts anyway is stopped once more, at most once per epoch', async () => {
  let fence = NO_STOP
  fence = fenceSaid(fence, 3, groupOf('d1'))
  fence = fenceStopped(fence)
  const check = (event: VoxEvent) => {
    const verdict = lateStart(fence, event, OWNER)
    fence = verdict.fence
    return verdict.late
  }

  expect(check(started('d1', 1, 3))).toBe('restop')
  // Once per cancelled epoch; a further start of it still never reaches the screen.
  expect(check(started('d1', 2, 3))).toBe('ignore')
  // An earlier epoch counts as cancelled too, with its own re-stop.
  expect(check(started('d1', 0, 2))).toBe('restop')
  // Another owner's, or an epoch the stop did not cancel, is no late start.
  expect(check({ type: 'tag_started', owner: 'o2', tag: tag('d1', 1, 3) })).toBeUndefined()
  expect(check(started('d1', 0, 4))).toBeUndefined()
})

test('a floor for a cancelled group after a stop is stopped once more', async () => {
  const fence = fenceStopped(fenceSaid(NO_STOP, 3, groupOf('d1')))
  const floor = (group: string, owner = OWNER): VoxEvent => ({ type: 'floor', owner, group })

  const first = lateStart(fence, floor(groupOf('d1')), OWNER)
  expect(first.late).toBe('restop')
  expect(lateStart(first.fence, floor(groupOf('d1')), OWNER).late).toBe('ignore')
  expect(lateStart(fence, floor(groupOf('d2')), OWNER).late).toBeUndefined()
  expect(lateStart(fence, floor(groupOf('d1'), 'o2'), OWNER).late).toBeUndefined()
})

test('nothing is late before any stop, or once a new reading was handed to voxlektor after it', async () => {
  const said = fenceSaid(NO_STOP, 3, groupOf('d1'))

  expect(lateStart(said, started('d1', 1, 3), OWNER).late).toBeUndefined()
  // A new reading (epoch 4) is live: a stop now would cut it, so nothing is stopped again.
  const live = fenceSaid(fenceStopped(said), 4, groupOf('d1'))
  expect(lateStart(live, started('d1', 1, 3), OWNER).late).toBeUndefined()
  expect(lateStart(live, { type: 'floor', owner: OWNER, group: groupOf('d1') }, OWNER).late).toBeUndefined()
  // Stopped again: epoch 4 is cancelled as well.
  expect(lateStart(fenceStopped(live), started('d1', 0, 4), OWNER).late).toBe('restop')
})

test('respawn backs off and caps', async () => {
  expect([0, 1, 2, 3].map(respawnDelay)).toEqual([500, 1000, 2000, 4000])
  expect(respawnDelay(10)).toBe(30_000)
})
