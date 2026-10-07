---
title: The wake relay — manual check on a real LAN
status: draft
last_verified:
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-09-28-pc-build-2-wake-relay.md
  - docs/specs/2026-09-27-pc-reference-build-design.md
---

# The wake relay — manual check on a real LAN

The harness grades the relay through its test transport. This guide checks what only a real LAN
shows: the carrier read from sysfs, the gateway's ARP answer, the packet on the wire, and a computer
that actually wakes. About 30 minutes.

## What you need

- **The relay's machine:** Linux on the LAN by cable (Wake-on-LAN over Wi-Fi rarely works), with
  Node 24 or 20 at `/usr/bin/node` (Debian's package; with another Node, change `ExecStart` in the
  unit), pnpm, git, and root for the install steps.
- **A computer to wake:** by cable on the same segment, with Wake-on-LAN on in its firmware and in
  its OS (on Linux, `sudo ethtool <its interface> | grep Wake-on` shows `g`; on Windows, the
  adapter's *Wake on Magic Packet*). Note its MAC.
- **A broker** the relay can reach. For this check, a throwaway Mosquitto on port 18830, so that it
  does not clash with a system one on 1883:

```bash
sudo apt install mosquitto mosquitto-clients iputils-arping tcpdump uuid-runtime
printf 'listener 18830 127.0.0.1\nallow_anonymous true\n' > /tmp/wake-check.conf
mosquitto -c /tmp/wake-check.conf -v
```

Leave it running in its own terminal. In a home the relay uses the home's broker with a password
file and TLS (`broker.passwordFile`, `broker.caFile`).

## Install

The relay runs from a built checkout of this repository under `/opt/galatea`. It cannot yet run
as a package deployed on its own: `@ludentes/galatea-life-schemas` reads the bridge-type manifest from
[`conformance/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance), outside its package, so a deployed relay would fail every command's validation.

In a second terminal. Replace `<repository>` with this repository's clone URL or your local
checkout's path, `<interface>` with the relay's LAN interface (`ip -br link`), `<id>` with a name
for the computer (letters, digits, `.`, `_`, `-`), and `<mac>` with its MAC:

```bash
sudo mkdir -p /opt/galatea /etc/galatea
sudo chown "$USER" /opt/galatea
git clone <repository> /opt/galatea/galatea-home
cd /opt/galatea/galatea-home && pnpm install && pnpm -r build && cd -
sudo useradd --system --no-create-home --shell /usr/sbin/nologin galatea-wake
sudo tee /etc/galatea/wake-relay.json > /dev/null <<'EOF'
{
  "interface": "<interface>",
  "entries": [{ "id": "<id>", "mac": "<mac>" }],
  "broker": { "url": "mqtt://127.0.0.1:18830", "username": "wake-relay" },
  "root": "home"
}
EOF
sudo cp /opt/galatea/galatea-home/reference/wake-relay/deploy/galatea-wake-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Check that the gateway answers `arping` before going on, since the relay's transport rests on it:

```bash
sudo arping -c 1 -I <interface> "$(ip -4 route show default dev <interface> | awk '{print $3}')"
```

Expected: one reply received.

## Watch it

In a third terminal:

```bash
mosquitto_sub -h 127.0.0.1 -p 18830 -V mqttv5 -v -t 'home/bridges/wake-relay/#'
```

Start the relay:

```bash
sudo systemctl start galatea-wake-relay
journalctl -u galatea-wake-relay -f
```

Expected:
- the journal says `ready`;
- `home/bridges/wake-relay/devices` shows your entry with `"feedback":"open"`, `"internal":true`,
  `"proposedClass":null` and one action, `power.wake` with `"confirms":false`;
- `home/bridges/wake-relay/status` shows `"state":"online"` and the transport `lan` `"state":"up"`,
  within a few seconds, and again every 10 s.

## Happy path: a wake

Shut the computer down (or suspend it). Then, on the relay's machine:

```bash
mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -t 'home/bridges/wake-relay/devices/<id>/command' \
  -m "{\"commandId\":\"$(uuidgen)\",\"issuedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"resultWithinMs\":5000,\"value\":{\"action\":\"power.wake\"}}"
```

Expected:
- `home/bridges/wake-relay/devices/<id>/ack` with `"result":"sent"`;
- the computer powers on within a few seconds.

To see the packet itself, run in another terminal before the command:

```bash
sudo tcpdump -i <interface> -XX udp port 9
```

Expected: one packet to the interface's broadcast address, port 9, 102 bytes of payload: six `ff`
bytes, then your MAC sixteen times.

## Edge cases

- **A repeated command.** Send the same `commandId` twice (write it to a variable first). Expected:
  two identical acks and one packet in `tcpdump`.
- **An unknown device.** Send the command to `devices/nas/command`. Expected: an ack with
  `"result":"failed","reason":"unknown_device"`, and no packet.
- **Another action.** Send `"value":{"action":"power.off"}`. Expected: `"result":"unsupported"`.
- **A retained command.** Send the command with `-r`. Expected: no ack and no packet. Clear it
  afterwards: `mosquitto_pub -h 127.0.0.1 -p 18830 -r -n -t 'home/bridges/wake-relay/devices/<id>/command'`.
- **The cable out.** Unplug the relay's cable. Expected: within about a second, a `status` with the
  transport `"state":"down"` and `"state":"offline"`; a wake command now acks
  `"reason":"unreachable"`. Plug it back: `up` again within a few seconds. Behind a switch port
  running STP, the port forwards nothing for its first 30 s or so, so the probe made on plugging
  back may fail and the next ones follow the backoff: `up` can then take 30 to 70 s.
- **A gateway that never answers.** Stop the service, add `"gateway": "192.0.2.1"` (a documentation
  address nothing answers) to the configuration, and start it. Expected: the transport stays `down`,
  its `retryIntervalMs` going 10000, 20000, 40000, then 60000 over about two minutes. Remove the line
  afterwards.
- **No `CAP_NET_RAW`.** First run `getcap "$(command -v arping)"`. If it prints nothing, stop the
  service and run the relay by hand as your own user:

  ```bash
  node /opt/galatea/galatea-home/reference/wake-relay/dist/main.js --config /etc/galatea/wake-relay.json
  ```

  Expected: it starts, but `arping` cannot open its socket, so the transport stays `down`. Stop it
  with Ctrl-C and start the service again. If `getcap` prints `cap_net_raw`, your `arping` carries
  the capability itself and this case cannot be shown; skip it.

## Round trip

- **A clean stop.** `sudo systemctl stop galatea-wake-relay`. Expected: a `status` with
  `"state":"offline","graceful":true`, then `lwt` cleared (an empty retained message).
- **A start again.** `sudo systemctl start galatea-wake-relay`. Expected: `devices`, then `status`
  `online`, as at the first start.
- **A crash.** `sudo systemctl kill -s KILL galatea-wake-relay`. Expected: almost at once,
  `lwt` carries `{"bridgeId":"wake-relay","instanceId":…}`, since the kernel closes the killed
  process's socket and the broker sees the connection drop (the 15 s keepalive matters only when
  the network is lost or the host hangs); systemd restarts the relay after 5 s, and the new
  instance clears `lwt` and publishes `online`.

## Clean up

```bash
sudo systemctl disable --now galatea-wake-relay
sudo rm /etc/systemd/system/galatea-wake-relay.service /etc/galatea/wake-relay.json
sudo rm -rf /opt/galatea
sudo userdel galatea-wake
sudo systemctl daemon-reload
```

Stop the throwaway Mosquitto with Ctrl-C and delete `/tmp/wake-check.conf`.
