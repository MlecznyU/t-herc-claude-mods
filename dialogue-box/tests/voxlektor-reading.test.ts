import { expect, test } from 'claude-code/testing'

import type { Screen } from '../hooks/arrivals'
import { startDialog } from '../hooks/dialog'
import { displayText } from '../hooks/speech'
import type { VoxEvent } from '../types'
import { encodeTag, groupOf, voxRate } from '../hooks/voxlektor'
import { applyEvent, INITIAL_BAND, ordersFor, respawnDelay, waitingAhead } from '../hooks/voxlektor-reading'
import type { VoxBand, VoxOrder } from '../hooks/voxlektor-reading'

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
  const snapshot: VoxEvent = { type: 'snapshot', state: 'WARM', version: '0.5.0', caps: [], tag: undefined, floorOwner: null, outdated: false }

  expect(waitingAhead(screen, apply(screen, { type: 'drained', owner: OWNER }, waiting).band)).toBeUndefined()
  expect(waitingAhead(screen, apply(screen, { type: 'drained', owner: null }, waiting).band)).toBe(1)
  expect(waitingAhead(screen, apply(screen, snapshot, waiting).band)).toBeUndefined()
})

test('a snapshot with our reading on the floor puts the cursor on its tag', async () => {
  const screen: Screen = { ...empty, current: d1 }
  const ours: VoxEvent = { type: 'snapshot', state: 'WARM', version: '0.5.0', caps: [], tag: tag('d1', 2), floorOwner: OWNER, outdated: false }

  expect(apply(screen, ours).screen.current?.index).toBe(2)
  expect(apply(screen, { ...ours, floorOwner: 'o2' }).screen).toEqual(screen)
})

test('a new reply after a stop plays unpaused', async () => {
  const screen: Screen = { ...empty, current: d1 }

  expect(apply(screen, { type: 'resumed', owner: OWNER }, { ...band, paused: true }).band.paused).toBe(false)
  expect(apply(screen, { type: 'paused', owner: OWNER }).band.paused).toBe(true)

  const snapshot = apply(screen, { type: 'snapshot', state: 'LOADING', version: '0.3.0', caps: [], tag: undefined, floorOwner: null, outdated: false })
  expect(snapshot.band.warming).toBe(true)
  // The snapshot's pause is daemon-wide, so it says nothing about this session.
  expect(snapshot.band.paused).toBe(false)
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

  expect(apply(reading, { type: 'error', owner: OWNER, code: 'audio', message: 'no output device' }).failed).toContain('no output device')
  expect(apply(reading, { type: 'error', owner: null, code: 'engine', message: '' }).failed).toContain('engine')
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

test('respawn backs off and caps', async () => {
  expect([0, 1, 2, 3].map(respawnDelay)).toEqual([500, 1000, 2000, 4000])
  expect(respawnDelay(10)).toBe(30_000)
})
