import { afterEach, describe, expect, it } from "vitest";
import { getentPasswd, LoginPaths, PATH_RETRY_MS, PATH_TTL_MS, readAccounts, readIdentity } from "../src/linux/accounts.js";
import {
  hasDirectory, interactive, parseGroup, parseLoginDefs, parseNsswitch, parsePasswd, refusesLogin,
} from "../src/linux/etc.js";
import { run, RunError } from "../src/linux/run.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredDirectory, DIRECTORY_CONFIG_PATHS } from "../src/linux/etc.js";
import { fakeRoot, FakeRunner, LOGIN_DEFS, NSSWITCH_FILES, NSSWITCH_SSS, PASSWD, SSSD_CONF } from "./linux-fakes.js";

const roots: { cleanup(): void }[] = [];
function root(files: Record<string, string>) {
  const r = fakeRoot(files);
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) r.cleanup();
});

describe("the OS's files", () => {
  it("parses passwd, skipping comments, NIS lines and malformed ones", () => {
    const text = `${PASSWD}# a comment\n+@netgroup::::::\nbroken:x:notanumber:1:::/bin/sh\nshort:x:1\n`;
    const entries = parsePasswd(text);
    expect(entries.map((e) => e.name)).toEqual(["root", "daemon", "systemd-network", "polkitd", "liza", "dima", "backup-svc", "gnome-initial-setup"]);
    expect(entries.find((e) => e.name === "liza")).toEqual({ name: "liza", uid: 1000, gid: 1000, home: "/home/liza", shell: "/bin/bash" });
  });

  it("parses group with its listed members", () => {
    expect(parseGroup("sudo:x:27:liza,dima\nliza:x:1000:\ndocker:x:990:\n")).toEqual([
      { name: "sudo", gid: 27, members: ["liza", "dima"] },
      { name: "liza", gid: 1000, members: [] },
      { name: "docker", gid: 990, members: [] },
    ]);
  });

  it("reads UID_MIN and UID_MAX, commented lines left out, defaults where absent", () => {
    expect(parseLoginDefs(LOGIN_DEFS)).toEqual({ uidMin: 1000, uidMax: 60000 });
    expect(parseLoginDefs("UID_MIN 500\n#UID_MAX 10\n")).toEqual({ uidMin: 500, uidMax: 60000 });
    expect(parseLoginDefs("")).toEqual({ uidMin: 1000, uidMax: 60000 });
  });

  it("reads nsswitch's sources, and tells a directory from local files", () => {
    expect(parseNsswitch(NSSWITCH_FILES, "passwd")).toEqual(["files", "systemd"]);
    expect(parseNsswitch("passwd: files [SUCCESS=return] sss # a comment\n", "passwd")).toEqual(["files", "sss"]);
    expect(parseNsswitch("", "passwd")).toEqual(["files"]);
    expect(hasDirectory(["files", "systemd"])).toBe(false);
    expect(hasDirectory(["files", "sss"])).toBe(true);
    expect(hasDirectory(["files", "something-new"])).toBe(true);
  });

  it("counts a named NSS source as a directory only when it is configured (review N1)", async () => {
    const is = async (sources: string[], files: Record<string, string> = {}) => configuredDirectory(root(files).root, sources);
    expect(await is(["files", "systemd"])).toBe(false);
    // sss: sssd.service's own start conditions.
    expect(await is(["files", "systemd", "sss"])).toBe(false);
    expect(await is(["files", "sss"], { "/etc/sssd/conf.d/.keep-not": "" })).toBe(true);
    expect(await is(["files", "sss"], SSSD_CONF)).toBe(true);
    expect(await is(["files", "sss"], { "/etc/sssd/conf.d/50-corp.conf": "[domain/corp]\n" })).toBe(true);
    // ldap: nslcd's, libnss-ldap's or the old pam/nss ldap.conf.
    expect(await is(["files", "ldap"])).toBe(false);
    for (const f of ["/etc/nslcd.conf", "/etc/libnss-ldap.conf", "/etc/ldap.conf", "/etc/ldap/ldap.conf", "/etc/openldap/ldap.conf"]) expect(await is(["files", "ldap"], { [f]: "x" })).toBe(true);
    // winbind: samba's configuration.
    expect(await is(["files", "winbind"])).toBe(false);
    expect(await is(["files", "winbind"], { "/etc/samba/smb.conf": "[global]\n" })).toBe(true);
    // nis and nisplus: a domain or a server.
    for (const src of ["nis", "nisplus"]) {
      expect(await is(["files", src])).toBe(false);
      expect(await is(["files", src], { "/etc/yp.conf": "domain corp server nis\n" })).toBe(true);
      expect(await is(["files", src], { "/etc/defaultdomain": "corp\n" })).toBe(true);
    }
    // A module the backend does not know: always a directory.
    expect(await is(["files", "something-new"])).toBe(true);
  });

  it("takes an empty sssd conf.d as not configured, and a configuration it cannot look at as configured (review N1)", async () => {
    const empty = root({});
    mkdirSync(join(empty.root, "etc", "sssd", "conf.d"), { recursive: true });
    expect(await configuredDirectory(empty.root, ["files", "sss"])).toBe(false);
    const hidden = root({ "/etc/sssd/x": "" });
    chmodSync(join(hidden.root, "etc", "sssd"), 0o000);
    try {
      expect(await configuredDirectory(hidden.root, ["files", "sss"])).toBe(true);
    } finally {
      chmodSync(join(hidden.root, "etc", "sssd"), 0o755);
    }
  });

  it("names every configuration path it reads, for the watches", () => {
    expect([...DIRECTORY_CONFIG_PATHS].sort()).toEqual([
      "/etc/defaultdomain", "/etc/ldap.conf", "/etc/ldap/ldap.conf", "/etc/libnss-ldap.conf", "/etc/nslcd.conf", "/etc/openldap/ldap.conf",
      "/etc/samba/smb.conf", "/etc/sssd/conf.d", "/etc/sssd/sssd.conf", "/etc/yp.conf",
    ]);
  });

  it("takes nologin and false as refusing a login, wherever installed", () => {
    expect(refusesLogin("/usr/sbin/nologin")).toBe(true);
    expect(refusesLogin("/sbin/nologin")).toBe(true);
    expect(refusesLogin("/bin/false")).toBe(true);
    expect(refusesLogin("/usr/bin/fish")).toBe(false);
    expect(refusesLogin("")).toBe(false);
  });

  it("holds a local account to UID_MIN..UID_MAX, a directory account to UID_MIN only", () => {
    const defs = { uidMin: 1000, uidMax: 60000 };
    const e = (uid: number) => ({ name: "x", uid, gid: uid, home: "/home/x", shell: "/bin/bash" });
    expect(interactive(e(999), defs, true)).toBe(false);
    expect(interactive(e(1000), defs, true)).toBe(true);
    expect(interactive(e(60001), defs, true)).toBe(false);
    expect(interactive(e(1_500_001), defs, false)).toBe(true);
    expect(interactive({ ...e(1000), shell: "/usr/sbin/nologin" }, defs, true)).toBe(false);
  });
});

describe("readIdentity", () => {
  it("reads the machine id and DMI's vendor and model", async () => {
    const r = root({
      "/etc/machine-id": "0123456789abcdef0123456789abcdef\n",
      "/sys/class/dmi/id/sys_vendor": "Example Computers Ltd.\n",
      "/sys/class/dmi/id/product_name": "EX-1000\n",
    });
    expect(await readIdentity(r.root)).toEqual({ machineId: "0123456789abcdef0123456789abcdef", vendor: "Example Computers Ltd.", model: "EX-1000" });
  });

  it("falls back to D-Bus's machine id, and names no DMI unknown", async () => {
    const r = root({ "/var/lib/dbus/machine-id": "fedcba9876543210fedcba9876543210\n" });
    expect(await readIdentity(r.root)).toEqual({ machineId: "fedcba9876543210fedcba9876543210", vendor: "unknown", model: "unknown" });
  });

  it("refuses a machine id that is missing or not 32 hex digits", async () => {
    await expect(readIdentity(root({}).root)).rejects.toThrow(/no machine id/);
    await expect(readIdentity(root({ "/etc/machine-id": "uninitialized\n" }).root)).rejects.toThrow(/no machine id/);
  });
});

describe("readAccounts", () => {
  const files = { "/etc/passwd": PASSWD, "/etc/login.defs": LOGIN_DEFS, "/etc/nsswitch.conf": NSSWITCH_FILES };

  it("lists the local interactive accounts: in range, with a shell that logs in", async () => {
    const r = await readAccounts({ root: root(files).root, run: new FakeRunner().run }, []);
    expect(r.listed.map((e) => [e.name, e.uid])).toEqual([["liza", 1000], ["dima", 1001]]);
    expect(r.deleted).toEqual([]);
  });

  it("reports a known uid deleted once it is gone from /etc/passwd, no directory is named, and NSS says it is not there", async () => {
    const runner = new FakeRunner().on(/^getent passwd -- /, { code: 2 });
    const r = await readAccounts({ root: root(files).root, run: runner.run }, [1000, 1003, 0]);
    expect(r.deleted).toEqual([1003]);
    expect(runner.lines()).toEqual(["getent passwd -- 1003"]);
  });

  it("never deletes an account systemd's userdb serves beside /etc/passwd, nor one whose lookup fails", async () => {
    const runner = new FakeRunner()
      .on("getent passwd -- 60513", { stdout: "olga:x:60513:60513:Olga:/home/olga:/bin/bash\n" })
      .on("getent passwd -- 60514", { code: 1 });
    const r = await readAccounts({ root: root(files).root, run: runner.run }, [60513, 60514]);
    expect(r.deleted).toEqual([]);
    expect(r.listed.map((e) => e.uid)).toContain(60513);
  });

  it("reports it again at the next read: nothing is remembered", async () => {
    const src = { root: root(files).root, run: new FakeRunner().on(/^getent passwd -- /, { code: 2 }).run };
    expect((await readAccounts(src, [1003])).deleted).toEqual([1003]);
    expect((await readAccounts(src, [1003])).deleted).toEqual([1003]);
  });

  it("keeps a known uid listed only as non-interactive: not deleted", async () => {
    const r = await readAccounts({ root: root(files).root, run: new FakeRunner().run }, [1002]);
    expect(r.deleted).toEqual([]);
    expect(r.listed.map((e) => e.uid)).not.toContain(1002);
  });

  it("with a directory named, never deletes a uid NSS does not resolve (exit 2), nor one whose lookup fails", async () => {
    const runner = new FakeRunner()
      .on("getent passwd -- 1500001", { code: 2 })
      .on("getent passwd -- 1500002", "hang")
      .on("getent passwd -- 1003", { code: 2 });
    const r = await readAccounts({ root: root({ ...files, "/etc/nsswitch.conf": NSSWITCH_SSS, ...SSSD_CONF }).root, run: runner.run }, [1003, 1500001, 1500002]);
    expect(r.deleted).toEqual([]);
    expect(runner.lines().sort()).toEqual(["getent passwd -- 1003", "getent passwd -- 1500001", "getent passwd -- 1500002"]);
  }, 10_000);

  it("on Ubuntu's desktop shape, sss named with sssd not configured, deletes a uid NSS says is not there (review N1)", async () => {
    const shape = root({ ...files, "/etc/nsswitch.conf": NSSWITCH_SSS });
    mkdirSync(join(shape.root, "etc", "sssd", "conf.d"), { recursive: true });
    const runner = new FakeRunner().on(/^getent passwd -- /, { code: 2 });
    expect((await readAccounts({ root: shape.root, run: runner.run }, [1003])).deleted).toEqual([1003]);
  });

  it("lists a directory account that holds a token or has a session, while NSS resolves it", async () => {
    const runner = new FakeRunner()
      .on("getent passwd -- 1500001", { stdout: "olga@corp.example:*:1500001:1500001:Olga:/home/olga@corp.example:/bin/bash\n" })
      .on("getent passwd -- 1500009", { stdout: "svc@corp.example:*:1500009:1500009::/:/usr/sbin/nologin\n" });
    const r = await readAccounts({ root: root({ ...files, "/etc/nsswitch.conf": NSSWITCH_SSS, ...SSSD_CONF }).root, run: runner.run }, [1500001], [1500009, 1000]);
    expect(r.listed.map((e) => [e.name, e.uid])).toEqual([["liza", 1000], ["dima", 1001], ["olga@corp.example", 1500001]]);
    expect(r.deleted).toEqual([]);
  });

  it("reads login.defs' defaults and local files only when those files are missing", async () => {
    const r = await readAccounts({ root: root({ "/etc/passwd": PASSWD }).root, run: new FakeRunner().on(/^getent passwd -- /, { code: 2 }).run }, [1003]);
    expect(r.listed.map((e) => e.uid)).toEqual([1000, 1001]);
    expect(r.deleted).toEqual([1003]);
  });

  it("takes an empty or truncated /etc/passwd, one with no root line or a malformed line, as a failed read, never as every account deleted (review M2)", async () => {
    for (const passwd of ["", PASSWD.replace(/^root.*\n/m, ""), `${PASSWD}broken:x:notanumber:1:::/bin/sh\n`, PASSWD.slice(0, PASSWD.indexOf("liza") + 9)]) {
      await expect(readAccounts({ root: root({ ...files, "/etc/passwd": passwd }).root, run: new FakeRunner().run }, [1000, 1001]))
        .rejects.toThrow(/\/etc\/passwd/);
    }
  });

  it("reads a line with a colon in its shell as glibc does, so its account is not deleted (review M2)", async () => {
    const passwd = PASSWD.replace("liza:x:1000:1000:,,,:/home/liza:/bin/bash", "liza:x:1000:1000:,,,:/home/liza:/bin/bash:extra");
    const r = await readAccounts({ root: root({ ...files, "/etc/passwd": passwd }).root, run: new FakeRunner().run }, [1000]);
    expect(r.deleted).toEqual([]);
    expect(r.listed.find((e) => e.uid === 1000)?.shell).toBe("/bin/bash:extra");
  });

  it("throws when /etc/passwd cannot be read: the observation fails, nothing is deleted", async () => {
    await expect(readAccounts({ root: root({}).root, run: new FakeRunner().run }, [1000])).rejects.toThrow(/ENOENT/);
  });
});

describe("getentPasswd", () => {
  it("gives the entry, absent for exit 2, failed for anything else", async () => {
    const runner = new FakeRunner()
      .on("getent passwd -- liza", { stdout: "liza:x:1000:1000:,,,:/home/liza:/bin/bash\n" })
      .on("getent passwd -- nobody-here", { code: 2 })
      .on("getent passwd -- broken", { code: 1 });
    expect(await getentPasswd(runner.run, "liza")).toEqual({ name: "liza", uid: 1000, gid: 1000, home: "/home/liza", shell: "/bin/bash" });
    expect(await getentPasswd(runner.run, "nobody-here")).toBe("absent");
    expect(await getentPasswd(runner.run, "broken")).toBe("failed");
    expect(await getentPasswd(new FakeRunner().run, "liza")).toBe("failed");
  });
});

describe("LoginPaths", () => {
  const liza = { name: "liza", uid: 1000, gid: 1000, home: "/home/liza", shell: "/bin/bash" };

  it("as root, runs the account's login shell through setpriv, and keeps the absolute directories of its last line", async () => {
    const runner = new FakeRunner().on(/^setpriv --reuid=1000 --regid=1000 --init-groups -- env -i .* \/bin\/bash -l -c printenv PATH$/, {
      stdout: "Welcome to the profile!\n/home/liza/.local/bin:/usr/local/bin:/usr/bin:/bin:bin::.:/usr/bin\n",
    });
    const paths = new LoginPaths({ run: runner.run, euid: 0 });
    expect(await paths.get(liza)).toEqual(["/home/liza/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });

  it("as root, opens no login session and no new process group: setpriv, no PAM and no setsid, the login shell from a clean environment (review I2, N2)", async () => {
    const runner = new FakeRunner().on(/^setpriv /, { stdout: "/usr/bin\n" });
    await new LoginPaths({ run: runner.run, euid: 0 }).get(liza);
    expect(runner.calls[0]!.file).toBe("setpriv");
    expect(runner.calls[0]!.args).toEqual([
      "--reuid=1000", "--regid=1000", "--init-groups", "--", "env", "-i", "HOME=/home/liza", "USER=liza", "LOGNAME=liza", "SHELL=/bin/bash",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "/bin/bash", "-l", "-c", "printenv PATH",
    ]);
  });

  it("names the account by its uid and gid, so a name that begins with a dash is never an option (review M6)", async () => {
    const runner = new FakeRunner().on(/^setpriv /, { stdout: "/usr/bin\n" });
    await new LoginPaths({ run: runner.run, euid: 0 }).get({ ...liza, name: "-l" });
    expect(runner.calls[0]!.args.slice(0, 4)).toEqual(["--reuid=1000", "--regid=1000", "--init-groups", "--"]);
    expect(runner.calls[0]!.args).not.toContain("-l=");
  });

  it("kills a login shell that hangs, and what it forked, at the bound: setpriv execs in place, so the group kill reaches them (review N2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "galatea-setpriv-"));
    try {
      // A stand-in for setpriv that does what it does here: drops its options and execs the rest in place.
      const setpriv = join(dir, "setpriv");
      writeFileSync(setpriv, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
      chmodSync(setpriv, 0o755);
      // A login shell whose profile forks and hangs.
      const pidFile = join(dir, "pid");
      const shell = join(dir, "hanging-shell");
      writeFileSync(shell, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
      chmodSync(shell, 0o755);
      const paths = new LoginPaths({ run, euid: 0, setpriv, boundMs: 300 });
      expect(await paths.get({ ...liza, shell })).toEqual([]);
      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2_000;
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("for the process's own account without root, runs its shell as a login shell in a clean environment", async () => {
    const runner = new FakeRunner().on("/bin/bash -l -c printenv PATH", { stdout: "/usr/local/bin:/usr/bin\n" });
    const paths = new LoginPaths({ run: runner.run, euid: 1000 });
    expect(await paths.get(liza)).toEqual(["/usr/local/bin", "/usr/bin"]);
    expect(runner.calls[0]!.env).toEqual({ HOME: "/home/liza", USER: "liza", LOGNAME: "liza", SHELL: "/bin/bash" });
  });

  it("for another account without root, gives an empty PATH and runs nothing", async () => {
    const runner = new FakeRunner();
    expect(await new LoginPaths({ run: runner.run, euid: 1001 }).get(liza)).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("keeps a PATH ten minutes, reads it again in the background after, and a failed one is empty and tried again after a minute", async () => {
    let now = 0;
    let answer: "ok" | "fail" | "other" = "fail";
    const runner = new FakeRunner().on(/^setpriv --reuid=1000 --regid=1000 --init-groups -- env -i .* \/bin\/bash -l -c printenv PATH$/, () =>
      answer === "fail" ? { code: 1, stderr: "setpriv: failed to set uid" } : { stdout: answer === "ok" ? "/usr/bin\n" : "/opt/bin\n" });
    const paths = new LoginPaths({ run: runner.run, euid: 0, now: () => now });
    expect(await paths.get(liza)).toEqual([]);
    answer = "ok";
    now = PATH_RETRY_MS - 1;
    expect(await paths.get(liza)).toEqual([]);
    expect(runner.calls).toHaveLength(1);
    now = PATH_RETRY_MS;
    // Stale: the old value now, the new one read meanwhile.
    expect(await paths.get(liza)).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(await paths.get(liza)).toEqual(["/usr/bin"]);
    answer = "other";
    now += PATH_TTL_MS - 1;
    expect(await paths.get(liza)).toEqual(["/usr/bin"]);
    expect(runner.calls).toHaveLength(2);
    now += 1;
    await paths.get(liza);
    await new Promise((r) => setImmediate(r));
    expect(await paths.get(liza)).toEqual(["/opt/bin"]);
  });

  it("reads a shell that hangs or fails as empty, never throwing", async () => {
    const runner = new FakeRunner().on(/^setpriv --reuid=1000 --regid=1000 --init-groups -- env -i .* \/bin\/bash -l -c printenv PATH$/, new RunError("timeout", "setpriv did not finish"));
    expect(await new LoginPaths({ run: runner.run, euid: 0 }).get(liza)).toEqual([]);
  });

  it("reads a new PATH when the account's shell changes", async () => {
    const runner = new FakeRunner()
      .on(/^setpriv --reuid=1000 /, (c) => ({ stdout: c.args.length ? "/usr/bin\n" : "" }));
    const paths = new LoginPaths({ run: runner.run, euid: 0 });
    await paths.get(liza);
    await paths.get({ ...liza, shell: "/usr/bin/zsh" });
    expect(runner.calls).toHaveLength(2);
  });
});
