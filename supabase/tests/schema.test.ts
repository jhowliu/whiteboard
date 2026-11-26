// @vitest-environment node
//
// Exercises the Supabase migrations under `supabase/migrations/` on PGlite.
// `supabase/tests/stub.sql` stands in for what a real Supabase project
// provides: the `authenticated` role, `auth.users`, `auth.uid()` (reading
// `request.jwt.claim.sub`), and a minimal `storage.buckets` / `storage.objects`
// with `storage.foldername()`. Each test gets a fresh database and runs its
// client queries as `authenticated` with the claim set to one user.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const STUB = join(ROOT, 'supabase', 'tests', 'stub.sql')

const TIMEOUT = 60_000

const USER_A = '00000000-0000-4000-8000-00000000000a'
const USER_B = '00000000-0000-4000-8000-00000000000b'

// Issue #44 adds `videos` and `video_marks`; the generic checks below cover them too.
const TABLES = ['boards', 'strokes', 'pdf_files', 'pdf_pages', 'videos', 'video_marks'] as const
type Table = (typeof TABLES)[number]

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(readFileSync(STUB, 'utf8'))
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // Users live in auth.users; created as the superuser, like Supabase Auth does.
  await db.query('insert into auth.users (id) values ($1), ($2)', [USER_A, USER_B])
  return db
}

/** Run `fn` as the `authenticated` role with `auth.uid()` = `userId` (or no claim). */
async function as<T>(db: PGlite, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
  }
}

const uuid = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function insertBoard(db: PGlite, extra: Record<string, unknown> = {}): Promise<string> {
  const id = uuid()
  await insertRow(db, 'boards', { id, title: 'Board', created_at: 1, updated_at: 1, ...extra })
  return id
}

async function insertStroke(
  db: PGlite,
  boardId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = uuid()
  await insertRow(db, 'strokes', {
    id,
    board_id: boardId,
    tool: 'pen',
    color: '#000000',
    size: 4,
    points: JSON.stringify([
      [0, 0, 0.5],
      [10, 5, 0.7],
    ]),
    min_x: 0,
    min_y: 0,
    max_x: 10,
    max_y: 5,
    created_at: 1,
    ...extra,
  })
  return id
}

async function insertPdfFile(db: PGlite, extra: Record<string, unknown> = {}): Promise<string> {
  const id = uuid()
  await insertRow(db, 'pdf_files', { id, name: 'doc.pdf', created_at: 1, ...extra })
  return id
}

async function insertPdfPage(
  db: PGlite,
  boardId: string,
  pdfId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = uuid()
  await insertRow(db, 'pdf_pages', {
    id,
    board_id: boardId,
    pdf_id: pdfId,
    page_index: 0,
    x: 0,
    y: 0,
    width: 612,
    height: 792,
    ...extra,
  })
  return id
}

async function insertVideo(
  db: PGlite,
  boardId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = uuid()
  await insertRow(db, 'videos', {
    id,
    board_id: boardId,
    provider: 'youtube',
    external_id: 'dQw4w9WgXcQ',
    title: 'Talk',
    created_at: 1,
    ...extra,
  })
  return id
}

async function insertVideoMark(
  db: PGlite,
  boardId: string,
  videoId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = uuid()
  await insertRow(db, 'video_marks', {
    id,
    board_id: boardId,
    video_id: videoId,
    t: 1.5,
    x: 0,
    y: 0,
    created_at: 1,
    ...extra,
  })
  return id
}

async function insertRow(db: PGlite, table: Table, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row)
  const params = cols.map((_, i) => `$${i + 1}`)
  await db.query(
    `insert into ${table} (${cols.join(', ')}) values (${params.join(', ')})`,
    Object.values(row),
  )
}

/** Inserts one row into `table` (with any parents it needs) and returns its id. */
async function insertInto(
  db: PGlite,
  table: Table,
  extra: Record<string, unknown> = {},
): Promise<string> {
  switch (table) {
    case 'boards':
      return insertBoard(db, extra)
    case 'pdf_files':
      return insertPdfFile(db, extra)
    case 'strokes':
      return insertStroke(db, await insertBoard(db), extra)
    case 'pdf_pages':
      return insertPdfPage(db, await insertBoard(db), await insertPdfFile(db), extra)
    case 'videos':
      return insertVideo(db, await insertBoard(db), extra)
    case 'video_marks': {
      const boardId = await insertBoard(db)
      return insertVideoMark(db, boardId, await insertVideo(db, boardId), extra)
    }
  }
}

async function ids(db: PGlite, table: Table): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`select id from ${table} order by id`)
  return rows.map((r) => r.id)
}

async function syncedAt(db: PGlite, table: Table, id: string): Promise<number> {
  const { rows } = await db.query<{ ms: number }>(
    `select (extract(epoch from synced_at) * 1000)::double precision as ms from ${table} where id = $1`,
    [id],
  )
  expect(rows).toHaveLength(1)
  return Number(rows[0].ms)
}

describe('supabase migrations', { timeout: TIMEOUT }, () => {
  let db: PGlite

  beforeEach(async () => {
    db = await freshDb()
  }, TIMEOUT)

  afterEach(async () => {
    await db?.close()
  })

  describe('files', () => {
    it('are named <version>_<name>.sql so `supabase db push` picks them up', () => {
      const files = migrationFiles()
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) expect(f).toMatch(/^\d{14}_[A-Za-z0-9_-]+\.sql$/)
    })

    it('apply cleanly after the stub and create all four tables', async () => {
      const { rows } = await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
      )
      expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining([...TABLES]))
    })
  })

  describe('schema', () => {
    type Column = { column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }

    async function columns(table: Table): Promise<Record<string, Column>> {
      const { rows } = await db.query<Column>(
        `select column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table],
      )
      return Object.fromEntries(rows.map((r) => [r.column_name, r]))
    }

    function expectColumn(
      cols: Record<string, Column>,
      name: string,
      type: string,
      nullable: boolean,
    ) {
      expect(cols[name], `column ${name}`).toBeDefined()
      expect(cols[name].data_type, `type of ${name}`).toBe(type)
      expect(cols[name].is_nullable, `nullability of ${name}`).toBe(nullable ? 'YES' : 'NO')
    }

    it.each(TABLES)('%s has uuid id/owner_id and a non-null timestamptz synced_at', async (t) => {
      const cols = await columns(t)
      expectColumn(cols, 'id', 'uuid', false)
      expectColumn(cols, 'owner_id', 'uuid', false)
      expectColumn(cols, 'synced_at', 'timestamp with time zone', false)
    })

    it('boards mirrors the Dexie Board with bigint epoch-ms times', async () => {
      const cols = await columns('boards')
      expect(cols.title?.data_type, 'type of title').toBe('text')
      expectColumn(cols, 'created_at', 'bigint', false)
      expectColumn(cols, 'updated_at', 'bigint', false)
      expectColumn(cols, 'deleted_at', 'bigint', true)
    })

    it('strokes stores points as jsonb and bbox as four double precision columns', async () => {
      const cols = await columns('strokes')
      expectColumn(cols, 'board_id', 'uuid', false)
      expectColumn(cols, 'points', 'jsonb', false)
      for (const c of ['min_x', 'min_y', 'max_x', 'max_y']) {
        expectColumn(cols, c, 'double precision', false)
      }
      expectColumn(cols, 'created_at', 'bigint', false)
      expectColumn(cols, 'deleted_at', 'bigint', true)
      for (const c of ['tool', 'color', 'size']) expect(cols[c], `column ${c}`).toBeDefined()
    })

    it('pdf_files holds metadata only — no blob column', async () => {
      const cols = await columns('pdf_files')
      expect(Object.keys(cols).sort()).toEqual(
        ['created_at', 'id', 'name', 'owner_id', 'synced_at'].sort(),
      )
      expectColumn(cols, 'created_at', 'bigint', false)
    })

    it('pdf_pages mirrors the Dexie PdfPage in snake_case', async () => {
      const cols = await columns('pdf_pages')
      expectColumn(cols, 'board_id', 'uuid', false)
      expectColumn(cols, 'pdf_id', 'uuid', false)
      for (const c of ['page_index', 'x', 'y', 'width', 'height']) {
        expect(cols[c], `column ${c}`).toBeDefined()
        expect(cols[c].is_nullable, `nullability of ${c}`).toBe('NO')
      }
    })

    it('stores and returns a stroke round-trip (points jsonb, bbox, epoch ms)', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      const points = [
        [1.5, -2.25, 0],
        [1e6, -1e6, 1],
      ]
      const id = await as(db, USER_A, () =>
        insertStroke(db, boardId, {
          points: JSON.stringify(points),
          min_x: -1e6,
          min_y: -2.25,
          max_x: 1e6,
          max_y: 0.5,
          created_at: 1_732_406_400_123,
        }),
      )
      const { rows } = await as(db, USER_A, () =>
        db.query<Record<string, unknown>>(
          'select points, min_x, min_y, max_x, max_y, created_at, deleted_at from strokes where id = $1',
          [id],
        ),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].points).toEqual(points)
      expect(rows[0].min_x).toBe(-1e6)
      expect(rows[0].min_y).toBe(-2.25)
      expect(rows[0].max_x).toBe(1e6)
      expect(rows[0].max_y).toBe(0.5)
      expect(Number(rows[0].created_at)).toBe(1_732_406_400_123)
      expect(rows[0].deleted_at).toBeNull()
    })

    it('rejects a duplicate client id', async () => {
      const id = await as(db, USER_A, () => insertBoard(db))
      await expect(as(db, USER_A, () => insertBoard(db, { id }))).rejects.toThrow()
    })

    it.each(TABLES)('%s defaults owner_id to auth.uid()', async (t) => {
      const id = await as(db, USER_A, () => insertInto(db, t))
      const { rows } = await db.query<{ owner_id: string }>(
        `select owner_id from ${t} where id = $1`,
        [id],
      )
      expect(rows).toEqual([{ owner_id: USER_A }])
    })

    it.each(TABLES)('%s.owner_id references auth.users', async (t) => {
      // As the superuser (RLS bypassed) with auth.uid() = A, so parent rows get
      // owner A by default and only the foreign key can reject the unknown owner.
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [USER_A])
      await expect(insertInto(db, t, { owner_id: uuid() })).rejects.toThrow(/foreign key/i)
    })

    it.each(TABLES)('%s has an (owner_id, synced_at) index', async (t) => {
      const { rows } = await db.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = $1`,
        [t],
      )
      expect(rows.map((r) => r.indexdef)).toEqual(
        expect.arrayContaining([expect.stringMatching(/\(owner_id, synced_at\b/)]),
      )
    })
  })

  describe('row level security', () => {
    it.each(TABLES)('is enabled on %s', async (t) => {
      const { rows } = await db.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where oid = $1::regclass`,
        [`public.${t}`],
      )
      expect(rows).toEqual([{ relrowsecurity: true }])
    })

    it('lets user A insert and select their own boards and strokes', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      const strokeId = await as(db, USER_A, () => insertStroke(db, boardId))
      expect(await as(db, USER_A, () => ids(db, 'boards'))).toEqual([boardId])
      expect(await as(db, USER_A, () => ids(db, 'strokes'))).toEqual([strokeId])
    })

    it.each(TABLES)('hides A’s %s rows from user B', async (t) => {
      const aId = await as(db, USER_A, () => insertInto(db, t))
      const bId = await as(db, USER_B, () => insertInto(db, t))
      const seenByB = await as(db, USER_B, () => ids(db, t))
      expect(seenByB).not.toContain(aId)
      expect(seenByB).toContain(bId)
      expect(await as(db, USER_A, () => ids(db, t))).toContain(aId)
    })

    it.each(TABLES)('rejects user B inserting %s with owner_id = A', async (t) => {
      // Parents (if any) are B's own, so only the owner_id check can fail.
      if (t === 'boards' || t === 'pdf_files') {
        await expect(as(db, USER_B, () => insertInto(db, t, { owner_id: USER_A }))).rejects.toThrow()
      } else {
        const boardId = await as(db, USER_B, () => insertBoard(db))
        const insert = async (): Promise<unknown> => {
          switch (t) {
            case 'strokes':
              return insertStroke(db, boardId, { owner_id: USER_A })
            case 'pdf_pages':
              return insertPdfPage(db, boardId, await insertPdfFile(db), { owner_id: USER_A })
            case 'videos':
              return insertVideo(db, boardId, { owner_id: USER_A })
            case 'video_marks':
              return insertVideoMark(db, boardId, await insertVideo(db, boardId), { owner_id: USER_A })
          }
        }
        await expect(as(db, USER_B, insert)).rejects.toThrow()
      }
      expect(await as(db, USER_A, () => ids(db, t))).toEqual([])
    })

    it.each(TABLES)('rejects %s inserts with no signed-in user', async (t) => {
      await expect(as(db, null, () => insertInto(db, t))).rejects.toThrow()
    })

    it('shows nothing when no user is signed in', async () => {
      await as(db, USER_A, () => insertBoard(db))
      expect(await as(db, null, () => ids(db, 'boards'))).toEqual([])
    })

    it('lets A update their own board', async () => {
      const id = await as(db, USER_A, () => insertBoard(db))
      await as(db, USER_A, () =>
        db.query('update boards set title = $1, updated_at = 2, deleted_at = 3 where id = $2', [
          'Renamed',
          id,
        ]),
      )
      const { rows } = await db.query<Record<string, unknown>>(
        'select title, updated_at, deleted_at from boards where id = $1',
        [id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toBe('Renamed')
      expect(Number(rows[0].updated_at)).toBe(2)
      expect(Number(rows[0].deleted_at)).toBe(3)
    })

    it('does not let B update A’s board', async () => {
      const id = await as(db, USER_A, () => insertBoard(db, { title: 'Mine' }))
      const res = await as(db, USER_B, () =>
        db.query('update boards set title = $1 where id = $2', ['Stolen', id]),
      )
      expect(res.affectedRows ?? 0).toBe(0)
      const { rows } = await db.query<{ title: string }>('select title from boards where id = $1', [
        id,
      ])
      expect(rows).toEqual([{ title: 'Mine' }])
    })

    it('does not let A hand their board over to B', async () => {
      const id = await as(db, USER_A, () => insertBoard(db))
      await expect(
        as(db, USER_A, () => db.query('update boards set owner_id = $1 where id = $2', [USER_B, id])),
      ).rejects.toThrow()
      const { rows } = await db.query('select owner_id from boards where id = $1', [id])
      expect(rows).toEqual([{ owner_id: USER_A }])
    })

    it.each(TABLES)('has no delete policy on %s: even the owner cannot delete', async (t) => {
      const id = await as(db, USER_A, () => insertInto(db, t))
      // With RLS and no delete policy, a DELETE silently matches no rows.
      await as(db, USER_A, () =>
        db.query(`delete from ${t} where id = $1`, [id]).catch(() => undefined),
      )
      expect(await ids(db, t)).toContain(id)
    })
  })

  describe('stroke immutability', () => {
    let strokeId: string

    beforeEach(async () => {
      strokeId = await as(db, USER_A, async () => insertStroke(db, await insertBoard(db)))
    })

    const update = (set: string, params: unknown[] = []) =>
      as(db, USER_A, () =>
        db.query(`update strokes set ${set} where id = $${params.length + 1}`, [
          ...params,
          strokeId,
        ]),
      )

    async function deletedAt(): Promise<number | null> {
      const { rows } = await db.query<{ deleted_at: bigint | number | null }>(
        'select deleted_at from strokes where id = $1',
        [strokeId],
      )
      return rows[0].deleted_at === null ? null : Number(rows[0].deleted_at)
    }

    it('rejects updating points', async () => {
      await expect(update('points = $1', [JSON.stringify([[1, 1, 1]])])).rejects.toThrow()
      const { rows } = await db.query<{ points: unknown }>(
        'select points from strokes where id = $1',
        [strokeId],
      )
      expect(rows[0].points).toEqual([
        [0, 0, 0.5],
        [10, 5, 0.7],
      ])
    })

    it.each([
      ['color', "color = '#ff0000'"],
      ['size', 'size = 8'],
      ['tool', "tool = 'highlighter'"],
      ['bbox', 'min_x = -1'],
      ['board_id', 'board_id = gen_random_uuid()'],
      ['created_at', 'created_at = 2'],
    ])('rejects updating %s', async (_name, set) => {
      await expect(update(set)).rejects.toThrow()
    })

    it('rejects changing points together with the tombstone', async () => {
      await expect(
        update('deleted_at = 5, points = $1', [JSON.stringify([[1, 1, 1]])]),
      ).rejects.toThrow()
      expect(await deletedAt()).toBeNull()
    })

    it('allows setting deleted_at once, from null to a value', async () => {
      await update('deleted_at = 1732406400000')
      expect(await deletedAt()).toBe(1_732_406_400_000)
    })

    it('allows a tombstone at epoch 0', async () => {
      await update('deleted_at = 0')
      expect(await deletedAt()).toBe(0)
    })

    it('rejects setting deleted_at a second time', async () => {
      await update('deleted_at = 100')
      await expect(update('deleted_at = 200')).rejects.toThrow()
      expect(await deletedAt()).toBe(100)
    })

    it('rejects re-setting deleted_at to the same value', async () => {
      await update('deleted_at = 100')
      await expect(update('deleted_at = 100')).rejects.toThrow()
    })

    it('rejects clearing deleted_at', async () => {
      await update('deleted_at = 100')
      await expect(update('deleted_at = null')).rejects.toThrow()
      expect(await deletedAt()).toBe(100)
    })

    it('rejects an update that leaves deleted_at null', async () => {
      await expect(update('deleted_at = null')).rejects.toThrow()
    })

    it('is enforced even for the database owner', async () => {
      await expect(
        db.query('update strokes set points = $1 where id = $2', [
          JSON.stringify([[1, 1, 1]]),
          strokeId,
        ]),
      ).rejects.toThrow()
    })
  })

  describe('synced_at', () => {
    it.each(TABLES)('is set by the server on %s insert, ignoring a client value', async (t) => {
      const before = Date.now()
      const id = await as(db, USER_A, () => insertInto(db, t, { synced_at: '2000-01-01T00:00:00Z' }))
      const ms = await syncedAt(db, t, id)
      expect(ms).toBeGreaterThanOrEqual(before - 5_000)
      expect(ms).toBeLessThanOrEqual(Date.now() + 5_000)
    })

    it('advances on insert: a later row has a later cursor', async () => {
      const first = await as(db, USER_A, () => insertBoard(db))
      await sleep(20)
      const second = await as(db, USER_A, () => insertBoard(db))
      expect(await syncedAt(db, 'boards', second)).toBeGreaterThan(
        await syncedAt(db, 'boards', first),
      )
    })

    it('advances on a stroke tombstone update', async () => {
      const id = await as(db, USER_A, async () => insertStroke(db, await insertBoard(db)))
      const inserted = await syncedAt(db, 'strokes', id)
      await sleep(20)
      await as(db, USER_A, () => db.query('update strokes set deleted_at = 5 where id = $1', [id]))
      expect(await syncedAt(db, 'strokes', id)).toBeGreaterThan(inserted)
    })

    it('advances on a board update, ignoring a client value', async () => {
      const id = await as(db, USER_A, () => insertBoard(db))
      const inserted = await syncedAt(db, 'boards', id)
      await sleep(20)
      await as(db, USER_A, () =>
        db.query(
          "update boards set deleted_at = 9, synced_at = '2000-01-01T00:00:00Z' where id = $1",
          [id],
        ),
      )
      expect(await syncedAt(db, 'boards', id)).toBeGreaterThan(inserted)
    })
  })

  // Issue #44: videos and their timestamp marks. Both follow the stroke rules: the owner's rows only,
  // immutable except for one tombstone.
  describe('videos and video marks', () => {
    it.each(['aB3_-xY9Zq-', 'dQw4w9WgXcQ'])('accepts the 11-character YouTube id %s', async (externalId) => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      await expect(
        as(db, USER_A, () => insertVideo(db, boardId, { external_id: externalId })),
      ).resolves.toEqual(expect.any(String))
    })

    it.each(['not-an-id', '', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'dQw4w9WgX!Q'])(
      'rejects the external_id %j',
      async (externalId) => {
        const boardId = await as(db, USER_A, () => insertBoard(db))
        await expect(
          as(db, USER_A, () => insertVideo(db, boardId, { external_id: externalId })),
        ).rejects.toThrow()
        expect(await ids(db, 'videos')).toEqual([])
      },
    )

    it('rejects a provider other than youtube', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      await expect(
        as(db, USER_A, () => insertVideo(db, boardId, { provider: 'vimeo' })),
      ).rejects.toThrow()
    })

    it('rejects a video without a title', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      await expect(as(db, USER_A, () => insertVideo(db, boardId, { title: null }))).rejects.toThrow()
    })

    it('rejects a video on a board that does not exist', async () => {
      await expect(as(db, USER_A, () => insertVideo(db, uuid()))).rejects.toThrow(/foreign key/i)
    })

    it('accepts a mark at t = 0 and rejects a negative t', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      const videoId = await as(db, USER_A, () => insertVideo(db, boardId))
      await expect(as(db, USER_A, () => insertVideoMark(db, boardId, videoId, { t: 0 }))).resolves.toEqual(
        expect.any(String),
      )
      await expect(as(db, USER_A, () => insertVideoMark(db, boardId, videoId, { t: -0.1 }))).rejects.toThrow()
      await expect(as(db, USER_A, () => insertVideoMark(db, boardId, videoId, { t: -1 }))).rejects.toThrow()
    })

    it('rejects a mark whose video does not exist', async () => {
      const boardId = await as(db, USER_A, () => insertBoard(db))
      await expect(as(db, USER_A, () => insertVideoMark(db, boardId, uuid()))).rejects.toThrow(/foreign key/i)
    })
  })

  describe.each(['videos', 'video_marks'] as const)('%s tombstones', (t) => {
    // Every column except deleted_at and synced_at is fixed after insert.
    const IMMUTABLE: Record<'videos' | 'video_marks', [column: string, set: string][]> = {
      videos: [
        ['title', "title = 'Renamed'"],
        ['external_id', "external_id = 'aB3_-xY9Zq-'"],
        ['created_at', 'created_at = 2'],
        ['board_id', 'board_id = gen_random_uuid()'],
      ],
      video_marks: [
        ['t', 't = 2'],
        ['x', 'x = 9'],
        ['y', 'y = 9'],
        ['created_at', 'created_at = 2'],
      ],
    }

    let rowId: string

    beforeEach(async () => {
      rowId = await as(db, USER_A, () => insertInto(db, t))
    })

    const update = (set: string, params: unknown[] = []) =>
      as(db, USER_A, () =>
        db.query(`update ${t} set ${set} where id = $${params.length + 1}`, [...params, rowId]),
      )

    async function deletedAt(): Promise<number | null> {
      const { rows } = await db.query<{ deleted_at: bigint | number | null }>(
        `select deleted_at from ${t} where id = $1`,
        [rowId],
      )
      return rows[0].deleted_at === null ? null : Number(rows[0].deleted_at)
    }

    it.each(IMMUTABLE[t])('rejects updating %s', async (_column, set) => {
      await expect(update(set)).rejects.toThrow()
      expect(await deletedAt()).toBeNull()
    })

    it('rejects changing an immutable column together with the tombstone', async () => {
      await expect(update(`deleted_at = 5, ${IMMUTABLE[t][0][1]}`)).rejects.toThrow()
      expect(await deletedAt()).toBeNull()
    })

    it('lets the owner read the row and tombstone it once, from null to a value', async () => {
      expect(await as(db, USER_A, () => ids(db, t))).toEqual([rowId])
      await update('deleted_at = 1732406400000')
      expect(await deletedAt()).toBe(1_732_406_400_000)
    })

    it('allows a tombstone at epoch 0', async () => {
      await update('deleted_at = 0')
      expect(await deletedAt()).toBe(0)
    })

    it('rejects setting deleted_at a second time, or to the same value', async () => {
      await update('deleted_at = 100')
      await expect(update('deleted_at = 200')).rejects.toThrow()
      await expect(update('deleted_at = 100')).rejects.toThrow()
      expect(await deletedAt()).toBe(100)
    })

    it('rejects clearing deleted_at', async () => {
      await update('deleted_at = 100')
      await expect(update('deleted_at = null')).rejects.toThrow()
      expect(await deletedAt()).toBe(100)
    })

    it('is enforced even for the database owner', async () => {
      await expect(db.query(`update ${t} set ${IMMUTABLE[t][0][1]} where id = $1`, [rowId])).rejects.toThrow()
    })

    it('does not let B tombstone A’s row', async () => {
      const res = await as(db, USER_B, () =>
        db.query(`update ${t} set deleted_at = 7 where id = $1`, [rowId]),
      )
      expect(res.affectedRows ?? 0).toBe(0)
      expect(await deletedAt()).toBeNull()
    })

    it('advances synced_at on the tombstone, so pulls see it', async () => {
      const inserted = await syncedAt(db, t, rowId)
      await sleep(20)
      await update('deleted_at = 5')
      expect(await syncedAt(db, t, rowId)).toBeGreaterThan(inserted)
    })
  })

  describe('storage', () => {
    const insertObject =(bucket: string, name: string) =>
      db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name])

    const objectNames = () =>
      db
        .query<{ name: string }>('select name from storage.objects order by name')
        .then((r) => r.rows.map((o) => o.name))

    it('creates a private pdfs bucket', async () => {
      const { rows } = await db.query<{ public: boolean }>(
        "select public from storage.buckets where id = 'pdfs'",
      )
      expect(rows).toEqual([{ public: false }])
    })

    it('lets A insert and read A/<id>.pdf', async () => {
      const name = `${USER_A}/${uuid()}.pdf`
      await as(db, USER_A, () => insertObject('pdfs', name))
      expect(await as(db, USER_A, objectNames)).toEqual([name])
    })

    it('rejects A inserting into B’s folder', async () => {
      await expect(
        as(db, USER_A, () => insertObject('pdfs', `${USER_B}/${uuid()}.pdf`)),
      ).rejects.toThrow()
    })

    it('rejects an object outside any user folder', async () => {
      await expect(as(db, USER_A, () => insertObject('pdfs', `${uuid()}.pdf`))).rejects.toThrow()
    })

    it('rejects A’s folder in another bucket', async () => {
      await expect(
        as(db, USER_A, () => insertObject('other', `${USER_A}/${uuid()}.pdf`)),
      ).rejects.toThrow()
    })

    it('rejects inserts with no signed-in user', async () => {
      await expect(as(db, null, () => insertObject('pdfs', `${USER_A}/${uuid()}.pdf`))).rejects.toThrow()
    })

    it('hides A’s object from B', async () => {
      const aName = `${USER_A}/${uuid()}.pdf`
      const bName = `${USER_B}/${uuid()}.pdf`
      await as(db, USER_A, () => insertObject('pdfs', aName))
      await as(db, USER_B, () => insertObject('pdfs', bName))
      expect(await as(db, USER_B, objectNames)).toEqual([bName])
      expect(await as(db, null, objectNames)).toEqual([])
    })
  })
})
