// The negative control for the stdout purity test: writes to stdout before the server can guard it, and keeps a
// console.debug ticking. Loaded with `node --import`; a correct purity assertion must fail on this run.
process.stdout.write("leak before the guard\n");
setInterval(() => console.debug("console leak"), 25);
