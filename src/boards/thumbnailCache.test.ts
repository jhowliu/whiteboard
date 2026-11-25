import { describe, expect, it } from 'vitest'
import { createThumbnailCache } from './thumbnailCache.ts'

// Issue #33: an in-memory cache of the last drawn thumbnail per board, keyed by boardId and version
// (the board's updatedAt). It holds at most `limit` boards (default 200) and evicts the least recently
// used one. Nothing is written to IndexedDB. The picture type is generic here: the app stores an
// offscreen canvas or an ImageBitmap, and these tests use strings.

describe('thumbnail cache', () => {
  it('returns a stored picture for the same boardId and version, and nothing for an unknown board', () => {
    const cache = createThumbnailCache<string>()
    expect(cache.get('a', 1)).toBeUndefined()
    cache.set('a', 1, 'picture-a')
    expect(cache.get('a', 1)).toBe('picture-a')
  })

  it('misses when the version differs', () => {
    const cache = createThumbnailCache<string>()
    cache.set('a', 1, 'picture-a')
    expect(cache.get('a', 2)).toBeUndefined()
    expect(cache.get('a', 1)).toBe('picture-a')
  })

  it('keeps only the latest picture per board, so a new version does not take a second slot', () => {
    const cache = createThumbnailCache<string>(2)
    cache.set('a', 1, 'a1')
    cache.set('b', 1, 'b1')
    cache.set('a', 2, 'a2')
    expect(cache.get('a', 1)).toBeUndefined()
    expect(cache.get('a', 2)).toBe('a2')
    expect(cache.get('b', 1)).toBe('b1')
  })

  it('evicts the least recently read board when a third board is stored with a limit of 2', () => {
    const cache = createThumbnailCache<string>(2)
    cache.set('a', 1, 'a')
    cache.set('b', 1, 'b')
    expect(cache.get('a', 1)).toBe('a') // reading a leaves b as the least recently read
    cache.set('c', 1, 'c')
    expect(cache.get('b', 1)).toBeUndefined()
    expect(cache.get('a', 1)).toBe('a')
    expect(cache.get('c', 1)).toBe('c')
  })

  it('holds 200 boards by default and evicts only when a 201st is stored', () => {
    const cache = createThumbnailCache<number>()
    for (let i = 0; i < 200; i++) cache.set(`b${i}`, 1, i)
    for (let i = 0; i < 200; i++) expect(cache.get(`b${i}`, 1)).toBe(i)
    cache.set('b200', 1, 200)
    expect(cache.get('b0', 1)).toBeUndefined()
    for (let i = 1; i <= 200; i++) expect(cache.get(`b${i}`, 1)).toBe(i)
  })
})
