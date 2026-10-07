// Takes the company lock in a folder given as the first argument, prints "exclusive" or "held", and keeps the lock
// until it is killed or its parent goes away (stdin closes). Used by the lock tests to stand in for a second server.
import { acquireLock } from "../../dist/fs/company-lock.js";

const lock = acquireLock(process.argv[2], new Date());
process.stdout.write(`${lock.kind}\n`);
if (lock.kind !== "exclusive") process.exit(0);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 1000);
