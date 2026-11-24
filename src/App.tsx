import AuthControls from './auth/AuthControls.tsx'

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Whiteboard</h1>
        <AuthControls />
      </header>
      <main className="board-root" data-testid="board-root" />
    </div>
  )
}
