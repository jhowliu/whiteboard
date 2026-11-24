// The app's single sync engine and its triggers. `startSync()` is called once from main.tsx;
// tests and local-only mode (no Supabase config) never start it.
import { useSyncExternalStore } from 'react'
import { db, getPdfBlob } from '../storage/index.ts'
import { getSession, subscribe as subscribeAuth } from './auth.ts'
import { createSyncEngine, type SyncEngine, type SyncStatus } from './engine.ts'
import { supabase } from './supabaseClient.ts'
import { SupabaseSyncBackend } from './supabaseBackend.ts'

export const SYNC_INTERVAL_MS = 30_000
export const SYNC_DEBOUNCE_MS = 2_000

const LOCAL_ONLY: SyncStatus = { status: 'offline', pending: 0 }

let engine: SyncEngine | null = null

function getEngine(): SyncEngine | null {
  if (!supabase) return null
  engine ??= createSyncEngine({
    db,
    backend: new SupabaseSyncBackend(supabase),
    getUserId: () => getSession()?.user.id ?? null,
  })
  return engine
}

let started = false

/** Syncs on sign-in, when the browser comes online, every 30 s while visible, and 2 s after the last local write. */
export function startSync(): void {
  const e = getEngine()
  if (!e || started) return
  started = true
  const run = () => void e.syncNow()

  let lastUser = getSession()?.user.id ?? null
  subscribeAuth(() => {
    const user = getSession()?.user.id ?? null
    if (user === lastUser) return
    lastUser = user
    run()
  })
  window.addEventListener('online', run)
  window.addEventListener('offline', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') run()
  }, SYNC_INTERVAL_MS)

  let timer: ReturnType<typeof setTimeout> | undefined
  db.outbox.hook('creating', () => {
    clearTimeout(timer)
    timer = setTimeout(run, SYNC_DEBOUNCE_MS)
    setTimeout(() => void e.refreshPending(), 0)
  })

  void e.refreshPending()
  run()
}

export function getSyncStatus(): SyncStatus {
  return engine?.getStatus() ?? LOCAL_ONLY
}

function subscribeSync(listener: () => void): () => void {
  return getEngine()?.subscribe(listener) ?? (() => {})
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSync, getSyncStatus, getSyncStatus)
}

export function replaceLocalData(): Promise<void> {
  return getEngine()?.replaceLocalData() ?? Promise.resolve()
}

/** The PDF's bytes from this device, or downloaded from the server the first time a pulled PDF is needed. */
export async function loadPdfBlob(pdfId: string): Promise<Blob | undefined> {
  return (await getPdfBlob(pdfId)) ?? (await getEngine()?.ensurePdfBlob(pdfId))
}
