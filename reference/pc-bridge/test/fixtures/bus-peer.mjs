// A stand-in helper for the endpoint's integration test (plan 4b): a process of its own on a private
// bus, driven by lines on its stdin (`hello [token]`, `report <session> <activity>`, `exit`), printing each
// answer and each notification it is asked to show as a JSON line. It shows nothing on any desktop.
import { createInterface } from "node:readline";
import dbus from "dbus-next";

const [address] = process.argv.slice(2);
process.env.DBUS_SESSION_BUS_ADDRESS = address;
const bus = dbus.sessionBus();
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
await new Promise((resolve, reject) => {
  bus.once("connect", resolve);
  bus.once("error", reject);
});
bus.addMethodHandler((m) => {
  if (m.path !== "/org/galatea/PcBridge1/Helper") return false;
  out({ notified: m.body, from: m.sender });
  bus.send(dbus.Message.newMethodReturn(m, "", []));
  return true;
});
out({ name: bus.name, pid: process.pid });
const call = async (member, signature, body) => {
  try {
    await bus.call(new dbus.Message({
      destination: "org.galatea.PcBridge1", path: "/org/galatea/PcBridge1", interface: "org.galatea.PcBridge1", member,
      ...(signature ? { signature, body } : {}),
    }));
    out({ [member]: "ok" });
  } catch (err) {
    out({ [member]: err.type ?? String(err) });
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  const [what, session, activity] = line.split(" ");
  // `hello [token]`: the start token, empty for a process the service did not start (review N1).
  if (what === "hello") await call("Hello", "s", [session ?? ""]);
  if (what === "report") await call("Report", "sa{sv}", [session, { activity: new dbus.Variant("s", activity) }]);
  if (what === "exit") break;
}
bus.disconnect();
process.exit(0);
