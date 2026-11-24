import '@testing-library/jest-dom/vitest'

// jsdom's Blob/File are not structured-cloneable, so fake-indexeddb would store `{}`.
// Node's native ones survive the clone and behave the same for what the tests need.
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
Object.assign(globalThis, { Blob: NodeBlob, File: NodeFile })
