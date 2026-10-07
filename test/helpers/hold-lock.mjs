// Takes the company lock in a folder given as the first argument, prints "exclusive" or "held", and keeps the lock
// until it is killed. Used by the lock tests to stand in for a second server process.
import { acquireLock } from "../../dist/fs/company-lock.js";

const lock = acquireLock(process.argv[2], new Date());
process.stdout.write(`${lock.kind}\n`);
if (lock.kind === "exclusive") setInterval(() => {}, 60_000);
else process.exit(0);
