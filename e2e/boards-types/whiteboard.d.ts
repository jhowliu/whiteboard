// Window typing for e2e/boards.spec.ts. Kept apart from the node project because
// e2e/canvas.spec.ts declares a narrower `window.__whiteboard` (without `boardId`).
export {}
declare global {
  interface Window {
    __whiteboard?: { snapshot(): { boardId: string | null } }
  }
}
