import { useAuth } from './auth.ts'
import { ACCOUNT_MISMATCH_MESSAGE } from './engine.ts'
import { replaceLocalData, useSyncStatus } from './runtime.ts'

const LABELS = { synced: '已同步', syncing: '同步中', offline: '離線', failed: '同步失敗' } as const

/** Header sync status; shown only while signed in. */
export default function SyncStatus() {
  const auth = useAuth()
  const sync = useSyncStatus()
  if (auth.status !== 'signedIn') return null
  return (
    <div className="sync-status" data-testid="sync-status" data-status={sync.status}>
      <span>{LABELS[sync.status]}</span>
      {sync.pending > 0 && <span className="sync-pending">（{sync.pending}）</span>}
      {sync.status === 'failed' && sync.message && <span role="alert">{sync.message}</span>}
      {sync.status === 'failed' && sync.message === ACCOUNT_MISMATCH_MESSAGE && (
        <button type="button" data-testid="replace-local-data" onClick={() => void replaceLocalData()}>
          清除本機資料並改用此帳號
        </button>
      )}
    </div>
  )
}
