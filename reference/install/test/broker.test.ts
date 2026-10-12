import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, Stack } from "./stack.js";

/**
 * The installation's broker (the install-core design, *TLS inside the stack*, *The broker's access
 * rules*): mqtts only, from the installation's CA; identities for `applier` and each `bridge_*` alone;
 * one block of grants per identity. Each probe pair, a forbidden and a permitted publish, is the
 * check a reload of the rules must pass.
 */
describe("the broker", () => {
  let s: Stack;
  const pw = (n: string) => readFileSync(join(s.brokerSecrets, n), "utf8");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A subscriber that waits for one message, at most `secs` seconds; `mosquitto_sub -W` exits 27 at its timeout.
  const receive = (user: string, topic: string, secs = 3) => s.mqtt("mosquitto_sub", user, pw(user), ["-t", topic, "-C", "1", "-W", String(secs), "-v"]);
  // At QoS 1 over MQTT 5, with -d: the PUBACK's reason code is in the output (RC:135 is 0x87, not authorised).
  const publish = (user: string, topic: string, payload: string, retain = false) =>
    s.mqtt("mosquitto_pub", user, pw(user), ["-d", "-t", topic, "-m", payload, "-q", "1", ...(retain ? ["-r"] : [])]);
  const rc = (r: { stdout: string }) => Number(/received PUBACK \(Mid: \d+, RC:(\d+)\)/.exec(r.stdout)?.[1] ?? -1);
  /** Polls `check` every 250 ms until it holds; fails after `ms`. */
  async function until(what: string, check: () => Promise<boolean> | boolean, ms = 60_000): Promise<void> {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await check()) return;
    throw new Error(`waited ${ms} ms for ${what}`);
  }
  /** How many times the broker has logged a client connecting under `name`. */
  const connections = async (name: string) =>
    (await s.logs("broker")).split("\n").filter((l) => l.includes(` as ${name} (`)).length;
  /**
   * `user` publishes `topic` while `listener` waits on it: what the listener heard, and the last
   * PUBACK's reason. Each client is a container of its own, and on a loaded box one may take
   * seconds to start, so nothing here waits a set time: the publishes start once the broker has
   * logged the listener's connection, and repeat until the listener has exited (it heard, or its
   * -W ran out). A round counts only when the listener heard, or a publish was acknowledged while it
   * was still listening; otherwise it is run again.
   */
  async function heard(user: string, topic: string, listener: string): Promise<{ heard: string; rc: number }> {
    for (let round = 0; round < 5; round++) {
      let finished = false;
      const seen = await connections(listener);
      const sub = receive(listener, topic, 8).finally(() => { finished = true; });
      await until(`${listener} to connect`, async () => finished || (await connections(listener)) > seen);
      let last = { stdout: "" };
      let ackedWhileListening = false;
      while (!finished) {
        last = await publish(user, topic, `from ${user}`);
        if (!finished && rc(last) !== -1) ackedWhileListening = true;
        if (!finished) await sleep(500);
      }
      const got = (await sub).stdout.trim();
      if (got !== "" || ackedWhileListening) return { heard: got, rc: rc(last) };
    }
    throw new Error(`${listener} never listened while ${user} published ${topic}`);
  }

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward", "bridge_zigbee", "bridge_other", "watch", "watch-2"]);
    await s.must(s.compose("up", "-d", "--wait", "broker"), "up broker");
  });
  afterAll(async () => s?.destroy());

  it("lets a watcher read a bridge's traffic and the applier's", async () => {
    for (const [user, topic] of [["bridge_zigbee", "galatea/bridges/bridge_zigbee/status"], ["bridge_zigbee", "galatea/bridges/bridge_zigbee/devices/d1/ack"],
      ["applier", "galatea/bridges/bridge_zigbee/devices/d1/command"], ["applier", "galatea/bridges/bridge_zigbee/request/snapshot"]] as const) {
      const r = await heard(user, topic, "watch");
      expect(r.heard, topic).toBe(`${topic} from ${user}`);
    }
  });

  it("refuses a watcher's publish anywhere, 0x87, and its rules grant reading everything and writing nothing", async () => {
    for (const topic of ["galatea/bridges/bridge_zigbee/status", "galatea/bridges/bridge_zigbee/lwt", "galatea/bridges/bridge_zigbee/devices/d1/command",
      "galatea/bridges/bridge_zigbee/request/snapshot", "galatea/finder/candidates", "galatea/other"]) {
      expect(rc(await publish("watch", topic, "forged")), topic).toBe(0x87);
    }
    const acl = (await s.must(s.compose("exec", "-T", "broker", "cat", "/mosquitto/run/acl"))).stdout;
    for (const w of ["watch", "watch-2"]) {
      const block = acl.split(/\n(?=user )/).find((b) => b.startsWith(`user ${w}\n`))!;
      expect(block.split("\n").slice(1).filter((l) => l.startsWith("topic ")), w).toEqual(["topic read #"]);
    }
  });

  it("lets two watchers under distinct names listen at once, neither taking the other's session", async () => {
    const takeovers = async () => (await s.logs("broker")).split("\n").filter((l) => / already connected, closing old connection/.test(l)).length;
    const before = await takeovers();
    const topic = "galatea/bridges/bridge_zigbee/event";
    const seen = [await connections("watch"), await connections("watch-2")];
    let done = 0;
    const subs = ["watch", "watch-2"].map((w) => receive(w, topic, 30).finally(() => { done++; }));
    await until("both watchers to connect", async () => (await connections("watch")) > seen[0]! && (await connections("watch-2")) > seen[1]!);
    while (done < 2) {
      await publish("bridge_zigbee", topic, "both");
      if (done < 2) await sleep(500);
    }
    for (const r of await Promise.all(subs)) expect(r.stdout.trim()).toBe(`${topic} both`);
    expect(await takeovers()).toBe(before);
  });

  it("galatea-prepare writes a broker password for the applier, each bridge and each watcher only, the owner's alone, kept once written", async () => {
    expect(statSync(s.brokerSecrets).mode & 0o777).toBe(0o700);
    for (const n of ["applier", "bridge_zigbee", "bridge_other"]) {
      expect(statSync(join(s.brokerSecrets, n)).mode & 0o777).toBe(0o600);
      expect(pw(n)).toMatch(/^[A-Za-z0-9]{32}$/);
      // Not the store's password: one leaked secret opens one door.
      expect(pw(n)).not.toBe(readFileSync(join(s.secrets, n), "utf8"));
    }
    // The steward has no broker identity.
    expect(() => statSync(join(s.brokerSecrets, "steward"))).toThrow();
    const before = pw("applier");
    const r = await s.must(s.bin("galatea-prepare"));
    expect(pw("applier")).toBe(before);
    expect(r.stdout).not.toContain("broker/applier");
  });

  it("answers mqtts on 8883 only: no plain listener, and a client that does not trust the CA is refused", async () => {
    const plain = await s.mqtt("mosquitto_pub", "applier", pw("applier"), ["-t", "galatea/x", "-m", "1"], "plain");
    expect(plain.code).not.toBe(0);
    expect(plain.stderr).toMatch(/connection refused|Unable to connect/i);
    const untrusted = await s.mqtt("mosquitto_pub", "applier", pw("applier"), ["-t", "galatea/x", "-m", "1"], "untrusted");
    expect(untrusted.code).not.toBe(0);
    expect(untrusted.stderr).toMatch(/certificate verify failed|TLS|protocol error/i);
    const ok = await publish("applier", "galatea/bridges/bridge_zigbee/request/snapshot", "{}");
    expect(ok.code, ok.stderr).toBe(0);
  });

  it("refuses a client without a password, with a wrong one, and the steward's name or an unknown one, at CONNECT and in its log", async () => {
    let r = await s.mqtt("mosquitto_pub", undefined, undefined, ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    r = await s.mqtt("mosquitto_pub", "applier", undefined, ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    r = await s.mqtt("mosquitto_pub", "applier", "wrong-password", ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not authori[sz]ed|bad user name or password/i);
    for (const name of ["steward", "stranger"]) {
      r = await s.mqtt("mosquitto_pub", name, "any-password", ["-t", "galatea/x", "-m", "1"]);
      expect(r.code, name).not.toBe(0);
      expect(r.stderr, name).toMatch(/not authori[sz]ed/i);
    }
    const logs = await s.logs("broker");
    expect(logs).toMatch(/Client steward disconnected, not authori[sz]ed/);
    expect(logs).toMatch(/Client stranger disconnected, not authori[sz]ed/);
  });

  it("lets a bridge write its tree, and the applier read it: status, devices, a device's status and ack, reply, event, its will", async () => {
    for (const t of ["status", "lwt", "devices", "devices/d1/status", "devices/d1/ack", "reply", "event"]) {
      const topic = `galatea/bridges/bridge_zigbee/${t}`;
      const r = await heard("bridge_zigbee", topic, "applier");
      expect(r.heard, t).toBe(`${topic} from bridge_zigbee`);
      expect([0, 0x10], t).toContain(r.rc); // granted: delivered, or no subscriber left after the one that heard
    }
  });

  it("lets the applier write a bridge's commands and requests, and that bridge read them", async () => {
    for (const t of ["devices/d1/command", "request/snapshot"]) {
      const topic = `galatea/bridges/bridge_zigbee/${t}`;
      const r = await heard("applier", topic, "bridge_zigbee");
      expect(r.heard, t).toBe(`${topic} from applier`);
      expect([0, 0x10], t).toContain(r.rc); // granted: delivered, or no subscriber left after the one that heard
    }
  });

  it("refuses a bridge's publish to another bridge's tree or to its own commands and requests, 0x87, and the applier never hears it", async () => {
    for (const topic of ["galatea/bridges/bridge_other/status", "galatea/bridges/bridge_zigbee/devices/d1/command",
      "galatea/bridges/bridge_zigbee/request/snapshot", "galatea/finder/candidates"]) {
      const r = await heard("bridge_zigbee", topic, "applier");
      expect(r.rc, topic).toBe(0x87);
      expect(r.heard, topic).toBe("");
    }
  });

  it("refuses the applier's publish anywhere but commands and requests, 0x87", async () => {
    for (const topic of ["galatea/bridges/bridge_zigbee/status", "galatea/bridges/bridge_zigbee/devices", "galatea/finder/status", "galatea/other"]) {
      const r = await publish("applier", topic, "forged");
      expect(rc(r), topic).toBe(0x87);
    }
  });

  /** The applier's block of the rules file the broker wrote at its start. */
  async function applierRules(): Promise<string[]> {
    const acl = (await s.must(s.compose("exec", "-T", "broker", "cat", "/mosquitto/run/acl"))).stdout;
    const block = acl.split(/\n(?=user )/).find((b) => b.startsWith("user applier\n"))!;
    return block.split("\n").slice(1).filter((l) => l.startsWith("topic "));
  }

  it("delivers nothing on a subscription the rules deny: a bridge listening to another's commands", async () => {
    const r = await heard("applier", "galatea/bridges/bridge_other/devices/d1/command", "bridge_zigbee");
    expect(r.heard).toBe("");
  });

  it("never lets the applier read a command or a request: one client subscribing and publishing hears nothing, and the rules hold no such grant", async () => {
    // mosquitto_rr is one client: it subscribes to -e, then publishes to -t, so no second connection
    // under the applier's name takes its session over. It exits 27 when nothing comes within -W.
    for (const t of ["galatea/bridges/bridge_zigbee/devices/d1/command", "galatea/bridges/bridge_zigbee/request/snapshot"]) {
      const r = await s.mqtt("mosquitto_rr", "applier", pw("applier"), ["-t", t, "-e", t, "-m", "x", "-W", "3"]);
      expect(r.code, `${t}: ${r.stdout}${r.stderr}`).toBe(27);
    }
    const rules = await applierRules();
    expect(rules.filter((l) => /^topic (read|readwrite) .*\/(command|request\/\+)$/.test(l))).toEqual([]);
    expect(rules.filter((l) => / galatea\/#$| galatea\/bridges\/#$/.test(l))).toEqual([]);
  });

  it("grants the applier exactly the applier's own BRIDGE_TOPICS and FINDER_TOPICS to read, and commands and requests to write", async () => {
    // The lists as the applier's image holds them, so a topic added there and not here fails this test.
    const r = await s.must(run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", "galatea-applier:local", "-e",
      "import('/app/dist/bus/client.js').then((m) => console.log(JSON.stringify([m.BRIDGE_TOPICS, m.FINDER_TOPICS])))"], process.env));
    const [bridgeTopics, finderTopics] = JSON.parse(r.stdout) as [string[], string[]];
    const rules = await applierRules();
    const reads = rules.filter((l) => l.startsWith("topic read ")).map((l) => l.slice("topic read ".length)).sort();
    const finderReads = reads.filter((t) => t.startsWith("galatea/finder/"));
    expect(reads.filter((t) => !t.startsWith("galatea/finder/"))).toEqual(bridgeTopics.map((t) => `galatea/bridges/+/${t}`).sort());
    // The finder's three topics, under one grant.
    expect(finderReads).toEqual(["galatea/finder/#"]);
    expect(finderTopics.length).toBeGreaterThan(0);
    expect(rules.filter((l) => l.startsWith("topic write ")).sort()).toEqual(["topic write galatea/bridges/+/devices/+/command", "topic write galatea/bridges/+/request/+"]);
    const acl = (await s.must(s.compose("exec", "-T", "broker", "cat", "/mosquitto/run/acl"))).stdout;
    expect(acl).not.toMatch(/^pattern /m);
    expect(acl).not.toContain("user steward");
  });

  it("takes a session over for a second client under one name, visibly: the first client's will fires", async () => {
    const will = "galatea/bridges/bridge_other/lwt";
    const seen = await connections("bridge_other");
    // -W 20: the second client's container may take seconds to start; the first must still be there.
    const first = s.mqtt("mosquitto_sub", "bridge_other", pw("bridge_other"), ["-t", "galatea/bridges/bridge_other/devices/+/command", "-W", "20",
      "--will-topic", will, "--will-payload", "first", "--will-retain", "--will-qos", "1"]);
    const takeovers = async () => (await s.logs("broker")).split("\n")
      .filter((l) => l.includes("Client bridge_other already connected, closing old connection")).length;
    const before = await takeovers();
    await until("the first client to connect", async () => (await connections("bridge_other")) > seen);
    await s.mqtt("mosquitto_pub", "bridge_other", pw("bridge_other"), ["-t", "galatea/bridges/bridge_other/status", "-m", "second"]);
    // mosquitto_sub connects again on its own, so its exit says nothing; the broker's log and the will do.
    await until("the takeover", async () => (await takeovers()) > before);
    const r = await receive("applier", will, 5);
    expect(r.stdout.trim()).toBe(`${will} first`);
    await first;
  });

  it("is healthy from either listening socket, and on a host without IPv6, whose /proc/net/tcp6 is missing", async () => {
    const config = JSON.parse((await s.must(s.compose("config", "--format", "json", "broker"))).stdout);
    // `config` keeps Compose's escaped `$$`, which Docker hands the shell as `$`.
    const check = (config.services.broker.healthcheck.test as string[])[1]!.replaceAll("$$", "$").replaceAll("/proc/net/", "/fixture/");
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    const v4 = (port: string, st: string) => `   0: 00000000:${port} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1883        0 1`;
    const v6 = (port: string, st: string) => `   0: 00000000000000000000000000000000:${port} 00000000000000000000000000000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1883        0 2`;
    const cases: [string, Record<string, string>, number][] = [
      ["both, listening", { tcp: v4("22B3", "0A"), tcp6: v6("22B3", "0A") }, 0],
      ["IPv4 only, no tcp6 file", { tcp: v4("22B3", "0A") }, 0],
      ["IPv6 only", { tcp: v4("1F90", "0A"), tcp6: v6("22B3", "0A") }, 0],
      ["no tcp6 file, not listening", { tcp: v4("22B3", "01") }, 1],
      ["another port only", { tcp: v4("075B", "0A") }, 1],
    ];
    for (const [what, files, want] of cases) {
      const dir = mkdtempSync(join(s.dir, "proc-"));
      for (const [f, line] of Object.entries(files)) writeFileSync(join(dir, f), `${header}\n${line}\n`);
      const r = await run("docker", ["run", "--rm", "--network", "none", "-v", `${dir}:/fixture:ro`, "--entrypoint", "sh", "eclipse-mosquitto:2", "-c", check], process.env);
      expect(r.code, what).toBe(want);
    }
  });

  it("keeps retained messages across its own restart", async () => {
    await s.must(publish("bridge_zigbee", "galatea/bridges/bridge_zigbee/devices", "kept", true));
    await s.must(s.compose("restart", "broker"), "restart broker");
    await s.must(s.compose("up", "-d", "--wait", "broker"), "wait broker");
    const r = await receive("applier", "galatea/bridges/bridge_zigbee/devices", 10);
    expect(r.stdout.trim()).toBe("galatea/bridges/bridge_zigbee/devices kept");
  });

  it("refuses to start when an identity has no broker password", async () => {
    writeFileSync(join(s.brokerSecrets, "bridge_other"), "");
    await s.compose("restart", "broker");
    await until("broker-init's refusal", async () => (await s.logs("broker")).includes("broker-init: no password in secrets/broker/bridge_other"));
  });
});
