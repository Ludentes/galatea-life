// A stand-in for mpv, run as `mpv` from an account's PATH: it opens the JSON IPC socket the
// `--input-ipc-server` argument names and answers the properties the mpv plugin asks for, so that
// the real mpv package can run under the bridge where no mpv is installed. `quit` ends it.
import { createServer } from "node:net";

const arg = process.argv.find((a) => a.startsWith("--input-ipc-server="));
if (!arg) {
  console.error("fake mpv: no --input-ipc-server");
  process.exit(2);
}
const path = arg.slice("--input-ipc-server=".length);
const props = new Map([["pause", false], ["volume", 100], ["idle-active", true], ["media-title", null]]);
const observed = new Map();
const clients = new Set();

const server = createServer((socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => {});
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) handle(socket, JSON.parse(line));
    }
  });
});

function send(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}

function handle(socket, { command, request_id: id = 0 }) {
  const [name, ...args] = command;
  if (name === "observe_property") {
    const [oid, prop] = args;
    observed.set(prop, [...(observed.get(prop) ?? []), oid]);
    send(socket, { error: "success", request_id: id });
    send(socket, { event: "property-change", id: oid, name: prop, data: props.get(prop) ?? null });
  } else if (name === "get_property") {
    if (!props.has(args[0])) send(socket, { error: "property not found", request_id: id });
    else send(socket, { error: "success", data: props.get(args[0]), request_id: id });
  } else if (name === "set_property") {
    const [prop, value] = args;
    props.set(prop, value);
    send(socket, { error: "success", request_id: id });
    for (const oid of observed.get(prop) ?? []) for (const c of clients) send(c, { event: "property-change", id: oid, name: prop, data: value });
  } else if (name === "quit") {
    send(socket, { error: "success", request_id: id });
    process.exit(0);
  } else {
    send(socket, { error: "invalid parameter", request_id: id });
  }
}

server.listen(path);
process.on("SIGTERM", () => process.exit(0));
