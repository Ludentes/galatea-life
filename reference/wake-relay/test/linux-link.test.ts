import { describe, expect, it, vi } from "vitest";
import { broadcastAddress, gatewayFromRoutes, LinuxLink, type Runner } from "../src/linux-link.js";

describe("the arp probe", () => {
  const failing = (code: string | number): Runner => (_file, _args, _opts, done) =>
    done(Object.assign(new Error(`arping: ${code}`), { code }));

  it("says once per error code that arping cannot start, and reads it as no answer", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await new LinuxLink("eth0", "192.168.1.1", failing("ENOENT")).arp()).toBe(false);
      expect(await new LinuxLink("eth0", "192.168.1.1", failing("ENOENT")).arp()).toBe(false);
      expect(await new LinuxLink("eth0", "192.168.1.1", failing("EACCES")).arp()).toBe(false);
      // An arping that ran and heard nothing exits 1: an unanswered probe, not a fault.
      expect(await new LinuxLink("eth0", "192.168.1.1", failing(1)).arp()).toBe(false);
      expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("ENOENT"), expect.stringContaining("EACCES"),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("is an answer when arping exits 0", async () => {
    const answered: Runner = (_file, args, _opts, done) => {
      expect(args).toEqual(["-c", "1", "-w", "2", "-I", "eth0", "192.168.1.1"]);
      done(null);
    };
    expect(await new LinuxLink("eth0", "192.168.1.1", answered).arp()).toBe(true);
  });
});

const ROUTES = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
wlan0	00000000	FE01A8C0	0003	0	0	600	00000000	0	0	0
eth0	0001A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
eth0	00000000	0101A8C0	0003	0	0	100	00000000	0	0	0
`;

describe("gatewayFromRoutes", () => {
  it("reads the interface's default route, little-endian", () => {
    expect(gatewayFromRoutes(ROUTES, "eth0")).toBe("192.168.1.1");
    expect(gatewayFromRoutes(ROUTES, "wlan0")).toBe("192.168.1.254");
  });

  it("is undefined for an interface with no default route", () => {
    expect(gatewayFromRoutes(ROUTES, "eth1")).toBeUndefined();
    expect(gatewayFromRoutes("", "eth0")).toBeUndefined();
  });
});

describe("broadcastAddress", () => {
  it("sets the host bits", () => {
    expect(broadcastAddress("192.168.1.23", "255.255.255.0")).toBe("192.168.1.255");
    expect(broadcastAddress("10.20.30.40", "255.255.240.0")).toBe("10.20.31.255");
    expect(broadcastAddress("172.16.5.4", "255.255.255.255")).toBe("172.16.5.4");
  });
});
