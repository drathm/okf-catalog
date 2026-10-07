// A writer that captured the original stdout before the server's guard and writes through it later, as native
// code or a module loaded before the guard could. The guard cannot catch this; the purity assertion must.
const original = process.stdout.write.bind(process.stdout);
setTimeout(() => original("leak through a captured writer\n"), 500);
