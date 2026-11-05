// Stands in for the bot.e2e.test.ts process that runs a bot, so a test can
// kill it outright: runs the command after its first argument (bun bot.ts)
// with its own pid as E2E_PARENT_PID, as the harness does with its own, and
// writes that process's pid to the file its first argument names. The
// E2E_PARENT_PID it gets has to be its parent's, the harness's, or it exits
// at once. It also exits once that parent is gone, as a bot does
import { writeFileSync } from 'node:fs'

const [pidFile, ...cmd] = process.argv.slice(2)
const parent = Number(process.env.E2E_PARENT_PID)
if (process.ppid !== parent) {
  console.error(`test/parent.ts: E2E_PARENT_PID ${process.env.E2E_PARENT_PID} isn't its parent's pid, ${process.ppid}`)
  process.exit(1)
}
// A test run killed outright while it runs (a SIGKILL to a one-file bun test,
// whose tests run in its own process) can't stop it, and while it's there its
// bot's parent is too: both would run for good. So it checks its parent five
// times a second, and once it's gone, the bot's own check ends the bot
setInterval(() => {
  if (process.ppid === parent) return
  console.error(`test/parent.ts: E2E_PARENT_PID ${parent} is gone (the parent is ${process.ppid} now), exiting`)
  process.exit(1)
}, 200).unref()
const child = Bun.spawn(cmd, {
  env: { ...process.env, E2E_PARENT_PID: String(process.pid) },
  stdout: 'inherit',
  stderr: 'inherit',
})
writeFileSync(pidFile!, String(child.pid))
await child.exited
