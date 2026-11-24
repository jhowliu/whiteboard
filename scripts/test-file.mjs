// Runs one test file with the right runner. Used by agent-cage red-green
// checks (`guards.red_green.run` in .agent-cage.yml): Playwright for e2e/,
// Vitest for everything else.
import { spawnSync } from 'node:child_process'

const file = process.argv[2]?.replace(/^\.\//, '')
if (!file) {
  console.error('usage: node scripts/test-file.mjs <test file>')
  process.exit(2)
}

const e2e = file.startsWith('e2e/')
const result = spawnSync('npx', e2e ? ['playwright', 'test', file] : ['vitest', 'run', file], {
  stdio: 'inherit',
  env: e2e ? { ...process.env, CI: '1' } : process.env,
})
process.exit(result.status ?? 1)
