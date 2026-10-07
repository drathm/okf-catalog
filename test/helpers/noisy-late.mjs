// A planted writer that runs after the server's guard is in place: through the current `process.stdout.write`
// and `console.debug`. With the guard, nothing reaches stdout; this is the positive half of the control.
setTimeout(() => {
  process.stdout.write("late leak through process.stdout.write\n");
  console.debug("late console leak");
}, 500);
