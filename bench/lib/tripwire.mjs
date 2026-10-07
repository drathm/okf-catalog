// A network tripwire, loaded with `node --import bench/lib/tripwire.mjs …`: any attempt to reach the network
// through fetch, a TCP or TLS socket, a DNS lookup or an HTTP request writes TRIPWIRE to stderr and ends the
// process with exit code 86. Local IPC (a socket path, a pipe) stays allowed. The suite runs the harness's
// no-model paths under it, so "nothing was downloaded" is a failure the test can see, not a claim.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const trip = (what) => {
  process.stderr.write(`TRIPWIRE: network attempt via ${what}\n`);
  process.exit(86);
};
const isIpc = (arg) =>
  (arg !== null && typeof arg === "object" && typeof arg.path === "string") ||
  (typeof arg === "string" && !/^\d+$/.test(arg));

globalThis.fetch = async (input) => trip(`fetch(${String(input)})`);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function tripwireConnect(...args) {
  if (isIpc(args[0])) return connect.apply(this, args);
  return trip(`net.connect(${JSON.stringify(args[0])})`);
};
net.connect = (...args) =>
  isIpc(args[0]) ? new net.Socket().connect(...args) : trip("net.connect");
net.createConnection = net.connect;
tls.connect = () => trip("tls.connect");
dns.lookup = (hostname) => trip(`dns.lookup(${String(hostname)})`);
dns.promises.lookup = async (hostname) => trip(`dns.promises.lookup(${String(hostname)})`);
http.request = () => trip("http.request");
http.get = () => trip("http.get");
https.request = () => trip("https.request");
https.get = () => trip("https.get");
