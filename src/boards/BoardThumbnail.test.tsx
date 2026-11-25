import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listPdfPages, listStrokes } from '../storage/index.ts'
import BoardThumbnail from './BoardThumbnail.tsx'

// Issue #33: board list thumbnails are lazy and cached in memory.
// - A thumbnail reads storage only once its card is on screen or near it: an IntersectionObserver with
//   rootMargin 200px. Without IntersectionObserver (jsdom) it draws at once.
// - The <canvas> reports data-thumb="pending" until it is drawn, then "drawn", and data-thumb-source
//   "storage" or "cache" for where the picture came from.
// - A picture drawn for the same boardId and version is copied from the in-memory cache, without listStrokes.

vi.mock('../storage/index.ts', () => ({
  listStrokes: vi.fn(async () => []),
  listPdfPages: vi.fn(async () => []),
}))

/** Stands in for IntersectionObserver: a test reports every observed element as on screen or off it. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly rootMargin: string
  private readonly callback: IntersectionObserverCallback
  private readonly targets = new Set<Element>()

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback
    this.rootMargin = options.rootMargin ?? ''
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
  }
  takeRecords() {
    return []
  }
  report(isIntersecting: boolean) {
    const entries = [...this.targets].map((target) => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    }))
    act(() => {
      this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
    })
  }
}

/** A 2D context that accepts every call and assignment, since jsdom has no canvas. */
function fakeContext() {
  const state: Record<PropertyKey, unknown> = {}
  return new Proxy(state, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value
      return true
    },
  })
}

const latestObserver = () => FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1]!
const thumbCanvas = (container: HTMLElement) => container.querySelector('canvas')!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext()) as never)
  vi.mocked(listStrokes).mockClear()
  vi.mocked(listPdfPages).mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BoardThumbnail lazy drawing', () => {
  it('stays pending, without reading storage, while its card is off screen', async () => {
    const boardId = crypto.randomUUID()
    const { container } = render(<BoardThumbnail boardId={boardId} version={1} />)
    expect(latestObserver().rootMargin).toBe('200px')
    expect(thumbCanvas(container)).toHaveAttribute('data-thumb', 'pending')

    latestObserver().report(false)
    await sleep(20)
    expect(listStrokes).not.toHaveBeenCalled()
    expect(thumbCanvas(container)).toHaveAttribute('data-thumb', 'pending')
  })

  it('reads storage once on screen, and an empty board ends up drawn from storage', async () => {
    const boardId = crypto.randomUUID()
    const { container } = render(<BoardThumbnail boardId={boardId} version={1} />)
    latestObserver().report(false)
    latestObserver().report(true)

    await waitFor(() => expect(thumbCanvas(container)).toHaveAttribute('data-thumb', 'drawn'))
    expect(listStrokes).toHaveBeenCalledTimes(1)
    expect(listStrokes).toHaveBeenCalledWith(boardId)
    expect(thumbCanvas(container)).toHaveAttribute('data-thumb-source', 'storage')
  })

  it('draws at once where IntersectionObserver is missing', async () => {
    vi.unstubAllGlobals()
    expect('IntersectionObserver' in globalThis).toBe(false)
    const boardId = crypto.randomUUID()
    const { container } = render(<BoardThumbnail boardId={boardId} version={1} />)

    await waitFor(() => expect(thumbCanvas(container)).toHaveAttribute('data-thumb', 'drawn'))
    expect(listStrokes).toHaveBeenCalledTimes(1)
  })
})

describe('BoardThumbnail in-memory cache', () => {
  it('copies a picture for the same boardId and version without reading storage on the next mount', async () => {
    const boardId = crypto.randomUUID()
    const first = render(<BoardThumbnail boardId={boardId} version={5} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(first.container)).toHaveAttribute('data-thumb', 'drawn'))
    first.unmount()

    const second = render(<BoardThumbnail boardId={boardId} version={5} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb', 'drawn'))
    expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb-source', 'cache')
    expect(listStrokes).toHaveBeenCalledTimes(1)
  })

  it('reads storage again when the board version has changed', async () => {
    const boardId = crypto.randomUUID()
    const first = render(<BoardThumbnail boardId={boardId} version={5} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(first.container)).toHaveAttribute('data-thumb', 'drawn'))
    first.unmount()

    const second = render(<BoardThumbnail boardId={boardId} version={6} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb', 'drawn'))
    expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb-source', 'storage')
    expect(listStrokes).toHaveBeenCalledTimes(2)
  })

  it('does not reuse one board’s picture for another board', async () => {
    const boardX = crypto.randomUUID()
    const boardY = crypto.randomUUID()
    const first = render(<BoardThumbnail boardId={boardX} version={5} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(first.container)).toHaveAttribute('data-thumb', 'drawn'))
    first.unmount()

    const second = render(<BoardThumbnail boardId={boardY} version={5} />)
    latestObserver().report(true)
    await waitFor(() => expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb', 'drawn'))
    expect(thumbCanvas(second.container)).toHaveAttribute('data-thumb-source', 'storage')
    expect(listStrokes).toHaveBeenCalledTimes(2)
  })
})
