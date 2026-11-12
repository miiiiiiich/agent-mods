// Type-checks each mod whose types Claude Code has written. It lays them beside a mod when an interactive session
// loads it with --plugin-dir, and git ignores them, so a fresh clone has none until then.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import process from 'node:process'

const MODS = 'mods'
const TYPES = '.claude-plugin/types/tsconfig.json'

const mods = readdirSync(MODS, { withFileTypes: true }).filter(entry => entry.isDirectory())
let failed = false
for (const { name } of mods) {
  const dir = `${MODS}/${name}`
  if (existsSync(`${dir}/${TYPES}`)) {
    const { status, error } = spawnSync('tsc', ['-p', dir], { stdio: 'inherit' })
    if (error !== undefined) {
      process.stderr.write(`${name}: could not run tsc: ${error.message}\n`)
    }
    failed = status !== 0 || failed
  } else {
    process.stderr.write(
      `${name}: not type-checked, no types yet. Run \`claude --plugin-dir ${dir}\` once to have them written.\n`,
    )
  }
}
if (failed) {
  process.exitCode = 1
}
