import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAdminFacts, sudoAnswer } from "../src/linux/admins.js";
import { parseDpkgSearch, parseDpkgVerify, RULES_DIRS, scanPolkit, STOCK_RULES } from "../src/linux/polkit.js";
import { RunError } from "../src/linux/run.js";
import { parseSudoList } from "../src/linux/sudo.js";
import { reduceAdmins } from "../src/admins.js";
import { fakeRoot, FakeRunner, LOGIN_DEFS, NSSWITCH_FILES, NSSWITCH_SSS, PASSWD, SSSD_CONF } from "./linux-fakes.js";

/**
 * `sudo -l -U <account>` as sudo 1.9 prints it to root in the C locale: its header, the defaults
 * that match, then the rules. The format is sudo's documentation's (sudo(8), sudoers(5)); this
 * machine cannot run it without root.
 */
function sudoList(account: string, ...rules: string[]): string {
  return [
    `Matching Defaults entries for ${account} on desk:`,
    "    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin, use_pty",
    "",
    `Runas and Command-specific defaults for ${account}:`,
    "    Defaults!/usr/bin/less !env_reset",
    "",
    `User ${account} may run the following commands on desk:`,
    ...rules.map((r) => (r.startsWith(" ") ? r : `    ${r}`)),
    "",
  ].join("\n");
}

describe("parseSudoList", () => {
  it.each([
    ["the sudo group's rule", ["(ALL : ALL) ALL"], "yes"],
    ["a one-command grant (GA-BRIDGE-53's trusts-a-one-command-grant)", ["(root) /usr/bin/less"], "yes"],
    ["a one-command grant with tags", ["(root) NOPASSWD: SETENV: /usr/bin/less"], "yes"],
    ["ALL with su taken out", ["(root) ALL, !/bin/su, !/usr/bin/passwd"], "yes"],
    ["a command alias as root", ["(root) SHUTDOWN"], "yes"],
    ["sudoedit of one file", ["(root) sudoedit /etc/hosts"], "yes"],
    ["options before the command", ["(root) CWD=/tmp TIMEOUT=10 NOPASSWD: /usr/bin/apt"], "yes"],
    ["a later command's own Runas root", ["(www-data) /usr/bin/php, (root) /usr/bin/apt update"], "yes"],
    ["a wrapped line", ["(root) NOPASSWD: /usr/bin/apt update,", "        /usr/bin/apt upgrade"], "yes"],
    ["only as another user", ["(www-data) NOPASSWD: /usr/bin/php"], "no"],
    ["only negations", ["(root) !/bin/su"], "no"],
    ["a digest", ["(root) sha224:0GomF8mNN3wlDt1HD9XldjJ3SNgpFdbjO1+NsQ== /bin/ls"], "cannotTell"],
    ["a Runas alias", ["(OP) /usr/bin/foo"], "cannotTell"],
    ["a Runas group of users", ["(%wheel) /usr/bin/foo"], "cannotTell"],
    ["a Runas with root taken out", ["(ALL, !root) /usr/bin/vi"], "cannotTell"],
    ["a Runas of groups only, any group", ["( : ALL) /usr/bin/foo"], "cannotTell"],
    ["a Runas of an ordinary group only", ["( : video) /usr/bin/foo"], "no"],
    ["a digest beside a plain grant", ["(root) sha256:abc= /bin/ls", "(root) /usr/bin/less"], "yes"],
  ])("%s", (_name, rules, expected) => {
    expect(parseSudoList(sudoList("liza", ...rules))).toBe(expected);
  });

  it("reads 'is not allowed to run sudo' as no", () => {
    expect(parseSudoList("User dima is not allowed to run sudo on desk.\n")).toBe("no");
  });

  it("reads a Runas user whose uid is 0 as root, whatever its name (review M9)", () => {
    const uidOf = (name: string) => ({ toor: 0, www: 33 } as Record<string, number | undefined>)[name];
    expect(parseSudoList(sudoList("liza", "(toor) /usr/bin/less"), uidOf)).toBe("yes");
    expect(parseSudoList(sudoList("liza", "(toor) /usr/bin/less"))).toBe("no");
    expect(parseSudoList(sudoList("liza", "(www) /usr/bin/less"), uidOf)).toBe("no");
    expect(parseSudoList(sudoList("liza", "(#0) /usr/bin/less"), uidOf)).toBe("yes");
    expect(parseSudoList(sudoList("liza", "(#1000) /usr/bin/less"), uidOf)).toBe("no");
  });

  it("reads anything else as cannotTell", () => {
    expect(parseSudoList("sudo: unknown user nobody-here\nsudo: error initializing audit plugin sudoers_audit\n")).toBe("cannotTell");
    expect(parseSudoList("")).toBe("cannotTell");
  });
});

describe("sudoAnswer", () => {
  it("runs sudo -n -l -U, never a prompt, wide so no line wraps", async () => {
    const runner = new FakeRunner().on("sudo -n -l -U liza", { stdout: sudoList("liza", "(ALL : ALL) ALL") });
    expect(await sudoAnswer(runner.run, "liza")).toEqual({ root: "yes", missing: false });
    expect(runner.calls[0]!.env).toEqual({ COLUMNS: "4096" });
  });

  it("takes sudo not installed as no, a hung or failed sudo as cannotTell", async () => {
    expect(await sudoAnswer(new FakeRunner().run, "liza")).toEqual({ root: "no", missing: true });
    const hung = new FakeRunner().on("sudo -n -l -U liza", new RunError("timeout", "sudo did not finish within 5000 ms"));
    expect(await sudoAnswer(hung.run, "liza")).toMatchObject({ root: "cannotTell", note: "sudo -l -U liza: sudo did not finish within 5000 ms" });
    const refused = new FakeRunner().on("sudo -n -l -U liza", { code: 1, stderr: "sudo: a password is required\n" });
    expect(await sudoAnswer(refused.run, "liza")).toMatchObject({ root: "cannotTell", note: "sudo -l -U liza: sudo: a password is required" });
  });
});

describe("dpkg's answers", () => {
  it("reads dpkg-query -S: the owners, an architecture qualifier dropped, and a diversion", () => {
    // As this machine's dpkg-query prints it.
    expect(parseDpkgSearch("polkitd: /usr/share/polkit-1/rules.d/50-default.rules\n", "/usr/share/polkit-1/rules.d/50-default.rules"))
      .toEqual({ packages: ["polkitd"], diverted: false });
    expect(parseDpkgSearch("libx:amd64, liby: /usr/lib/x\n", "/usr/lib/x")).toEqual({ packages: ["libx", "liby"], diverted: false });
    const diverted = "diversion by local from: /usr/share/polkit-1/rules.d/50-default.rules\n"
      + "diversion by local to: /usr/share/polkit-1/rules.d/50-default.rules.distrib\n"
      + "polkitd: /usr/share/polkit-1/rules.d/50-default.rules\n";
    expect(parseDpkgSearch(diverted, "/usr/share/polkit-1/rules.d/50-default.rules")).toEqual({ packages: ["polkitd"], diverted: true });
  });

  it("reads dpkg --verify's lines, a conffile's included (dpkg(1)'s format)", () => {
    const out = "??5?????? c /etc/polkit-1/rules.d/x.rules\n??5??????   /usr/share/polkit-1/rules.d/50-default.rules\nmissing     /usr/share/doc/polkitd/NEWS.gz\n";
    expect([...parseDpkgVerify(out)]).toEqual([
      "/etc/polkit-1/rules.d/x.rules", "/usr/share/polkit-1/rules.d/50-default.rules", "/usr/share/doc/polkitd/NEWS.gz",
    ]);
    // An unmodified package prints nothing, as this machine's `dpkg --verify polkitd` did.
    expect([...parseDpkgVerify("")]).toEqual([]);
  });
});

/** A runner answering dpkg for Debian 13's stock files, unmodified. */
function dpkg(): FakeRunner {
  return new FakeRunner()
    // NSS answers "not found" (exit 2) for any name a test does not give.
    .on(/^getent (passwd|group) -- /, { code: 2 })
    .on(/^dpkg-query -S /, (c) => ({ code: 1, stderr: `dpkg-query: no path found matching pattern ${c.args[1]}\n` }))
    .on(/^dpkg-query -S \/usr\/share\/polkit-1\/rules\.d\/50-default\.rules$/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/50-default.rules\n" })
    .on(/^dpkg-query -S \/usr\/share\/polkit-1\/rules\.d\/systemd-networkd\.rules$/, { stdout: "systemd: /usr/share/polkit-1/rules.d/systemd-networkd.rules\n" })
    .on(/^dpkg --verify /, { stdout: "" });
}

const roots: { cleanup(): void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.cleanup();
});
function root(files: Record<string, string>) {
  const r = fakeRoot(files);
  roots.push(r);
  return r;
}

const STOCK = {
  "/usr/share/polkit-1/rules.d/50-default.rules": 'polkit.addAdminRule(function(action, subject) {\n    return ["unix-group:sudo"];\n});\n',
  "/usr/share/polkit-1/rules.d/systemd-networkd.rules": "// This file is part of systemd.\n",
};

describe("scanPolkit", () => {
  it("reads polkitd's four directories, in its order", () => {
    expect(RULES_DIRS).toEqual(["/etc/polkit-1/rules.d", "/run/polkit-1/rules.d", "/usr/local/share/polkit-1/rules.d", "/usr/share/polkit-1/rules.d"]);
  });

  it("recognises Debian 13's stock files, owned and unmodified, and names their identities", async () => {
    const runner = dpkg();
    const scan = await scanPolkit(root(STOCK).root, runner.run);
    expect(scan).toEqual({ identities: ["unix-group:sudo"], unrecognised: [] });
    // One `dpkg --verify` per package.
    expect(runner.lines().filter((l) => l.startsWith("dpkg --verify")).sort()).toEqual(["dpkg --verify polkitd", "dpkg --verify systemd"]);
  });

  it("recognises a stock Debian 13 GNOME install's two further files, gdm3's and malcontent's, and takes no identity from them (plan 4b, *The desktop run*)", async () => {
    const files = {
      ...STOCK,
      "/usr/share/polkit-1/rules.d/20-gdm.rules": "polkit.addRule(function(action, subject) {\n    if (subject.user !== \"Debian-gdm\")\n        return undefined;\n});\n",
      "/usr/share/polkit-1/rules.d/com.endlessm.ParentalControls.rules": "polkit.addRule(function(action, subject) {\n    return polkit.Result.NOT_HANDLED;\n});\n",
    };
    const runner = dpkg()
      .on(/^dpkg-query -S \/usr\/share\/polkit-1\/rules\.d\/20-gdm\.rules$/, { stdout: "gdm3: /usr/share/polkit-1/rules.d/20-gdm.rules\n" })
      .on(/^dpkg-query -S \/usr\/share\/polkit-1\/rules\.d\/com\.endlessm\.ParentalControls\.rules$/,
        { stdout: "malcontent: /usr/share/polkit-1/rules.d/com.endlessm.ParentalControls.rules\n" });
    expect(await scanPolkit(root(files).root, runner.run)).toEqual({ identities: ["unix-group:sudo"], unrecognised: [] });
  });

  it("takes a file not in the table, one not owned by the table's package, a modified one and a diverted one as unrecognised", async () => {
    const r = root({ ...STOCK, "/etc/polkit-1/rules.d/10-office.rules": "polkit.addRule(function(a, s) { if (new Date().getHours() < 9) return 'yes'; });\n" });
    const scan1 = await scanPolkit(r.root, dpkg().run);
    expect(scan1.unrecognised).toEqual(["/etc/polkit-1/rules.d/10-office.rules: not a stock file the backend knows"]);
    expect(scan1.identities).toEqual(["unix-group:sudo"]);

    const r2 = root({ "/usr/share/polkit-1/rules.d/50-default.rules": "x" });
    const owned = new FakeRunner().on(/^dpkg-query -S /, { code: 1, stderr: "dpkg-query: no path found matching pattern\n" });
    expect((await scanPolkit(r2.root, owned.run)).unrecognised).toEqual(["/usr/share/polkit-1/rules.d/50-default.rules: not owned by polkitd"]);

    const modified = new FakeRunner()
      .on(/^dpkg-query -S /, { stdout: "polkitd: /usr/share/polkit-1/rules.d/50-default.rules\n" })
      .on("dpkg --verify polkitd", { code: 1, stdout: "??5??????   /usr/share/polkit-1/rules.d/50-default.rules\n" });
    expect((await scanPolkit(r2.root, modified.run)).unrecognised).toEqual(["/usr/share/polkit-1/rules.d/50-default.rules: modified since polkitd installed it"]);

    const diverted = new FakeRunner()
      .on(/^dpkg-query -S /, { stdout: "diversion by local from: /usr/share/polkit-1/rules.d/50-default.rules\npolkitd: /usr/share/polkit-1/rules.d/50-default.rules\n" })
      .on(/^dpkg --verify /, { stdout: "" });
    expect((await scanPolkit(r2.root, diverted.run)).unrecognised).toEqual(["/usr/share/polkit-1/rules.d/50-default.rules: diverted"]);
  });

  it("takes dpkg not installed or not answering as unrecognised, and an unreadable directory as well", async () => {
    const r = root(STOCK);
    expect((await scanPolkit(r.root, new FakeRunner().run)).unrecognised).toEqual([
      "/usr/share/polkit-1/rules.d/50-default.rules: dpkg-query did not answer (dpkg-query: not installed)",
      "/usr/share/polkit-1/rules.d/systemd-networkd.rules: dpkg-query did not answer (dpkg-query: not installed)",
    ]);
    const failing = new FakeRunner()
      .on(/^dpkg-query -S \/usr\/share\/polkit-1\/rules\.d\/50-default\.rules$/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/50-default.rules\n" })
      .on(/^dpkg --verify /, { code: 2, stderr: "dpkg: error: cannot access archive\n" });
    const r2 = root({ "/usr/share/polkit-1/rules.d/50-default.rules": "x" });
    expect((await scanPolkit(r2.root, failing.run)).unrecognised).toEqual(["/usr/share/polkit-1/rules.d/50-default.rules: dpkg --verify polkitd did not answer"]);
    // A directory mode 000 cannot be read, as /etc/polkit-1/rules.d (root:polkitd 0700) by a non-root run.
    const r3 = root(STOCK);
    r3.write("/etc/polkit-1/rules.d/.keep", "");
    chmodSync(`${r3.root}/etc/polkit-1/rules.d`, 0o000);
    try {
      const scan = await scanPolkit(r3.root, dpkg().run);
      if (process.geteuid?.() !== 0) expect(scan.unrecognised).toEqual(["/etc/polkit-1/rules.d: cannot be read (EACCES)"]);
    } finally {
      chmodSync(`${r3.root}/etc/polkit-1/rules.d`, 0o755);
    }
  });

  it("reads only .rules files", async () => {
    const r = root({ ...STOCK, "/etc/polkit-1/rules.d/README": "notes", "/etc/polkit-1/rules.d/old.rules.bak": "x" });
    expect((await scanPolkit(r.root, dpkg().run)).unrecognised).toEqual([]);
  });

  it("marks each 'as good as root' judgement of the table for the maintainer's review", () => {
    for (const t of STOCK_RULES) {
      expect(t.path.startsWith("/usr/share/polkit-1/rules.d/")).toBe(true);
      expect(t.source).not.toBe("");
    }
    // An administrator rule (addAdminRule) needs no judgement; a rule granting actions does.
    expect(STOCK_RULES.find((t) => t.path.endsWith("/50-default.rules"))!.review).toBeUndefined();
    expect(STOCK_RULES.find((t) => t.path.endsWith("/systemd-networkd.rules"))!.review).toMatch(/not as good as root/);
    expect(STOCK_RULES.find((t) => t.path.endsWith("/20-gnome-initial-setup.rules"))!.review).toMatch(/as good as root/);
    for (const name of ["/20-gdm.rules", "/com.endlessm.ParentalControls.rules"]) {
      const t = STOCK_RULES.find((s) => s.path.endsWith(name))!;
      expect(t.review, name).toMatch(/not as good as root/);
      expect(t.identities, name).toEqual([]);
    }
  });
});

describe("readAdminFacts", () => {
  const GROUP = [
    "root:x:0:", "sudo:x:27:liza,ghost", "docker:x:990:dima", "video:x:44:liza,dima", "liza:x:1000:", "dima:x:1001:", "backup-svc:x:1002:", "",
  ].join("\n");
  const files = { "/etc/passwd": PASSWD, "/etc/group": GROUP, "/etc/login.defs": LOGIN_DEFS, "/etc/nsswitch.conf": NSSWITCH_FILES, ...STOCK };

  /** sudo on the fake machine: no account may run it, unless a test says otherwise. */
  const sudoers = () => dpkg().on(/^sudo -n -l -U /, (c) => ({ code: 1, stdout: `User ${c.args[3]} is not allowed to run sudo on desk.\n` }));
  const byName = (sudo: { name: string; root: string }[]) => Object.fromEntries(sudo.map((s) => [s.name, s.root]));

  it("as root: the groups with their listed and primary members, every account's sudo answer, polkit's identities resolved", async () => {
    const runner = sudoers()
      .on("sudo -n -l -U liza", { stdout: sudoList("liza", "(ALL : ALL) ALL") })
      .on("sudo -n -l -U backup-svc", { stdout: sudoList("backup-svc", "(root) NOPASSWD: /usr/bin/rsync") });
    const { facts, notes } = await readAdminFacts({ root: root(files).root, run: runner.run, euid: 0 });
    expect(facts.groups.find((g) => g.name === "sudo")).toEqual({ name: "sudo", gid: 27, members: [{ osId: 1000, name: "liza" }] });
    expect(facts.groups.find((g) => g.name === "docker")!.members).toEqual([{ osId: 1001, name: "dima" }]);
    expect(facts.groups.find((g) => g.name === "liza")!.members).toEqual([{ osId: 1000, name: "liza" }]);
    expect(facts.groups.find((g) => g.name === "root")!.members).toEqual([{ osId: 0, name: "root" }]);
    // Every account but root, a service account's one-command grant included (the standard's "every account").
    expect(byName(facts.sudo)).toEqual({
      daemon: "no", "systemd-network": "no", polkitd: "no", liza: "yes", dima: "no", "backup-svc": "yes", "gnome-initial-setup": "no",
    });
    expect(facts.sudo.find((s) => s.name === "backup-svc")).toEqual({ osId: 1002, name: "backup-svc", root: "yes" });
    expect(facts.polkit).toEqual({ users: [], groups: [{ name: "sudo", gid: 27 }], unresolved: [], unrecognised: false });
    expect(notes).toEqual(["group sudo: member ghost does not resolve"]);
  });

  it("without root, reads every sudo answer as cannotTell and runs no sudo", async () => {
    const runner = sudoers();
    const { facts, notes } = await readAdminFacts({ root: root(files).root, run: runner.run, euid: 1000 });
    expect(facts.sudo).toHaveLength(7);
    expect(facts.sudo.every((s) => s.root === "cannotTell")).toBe(true);
    expect(runner.lines().some((l) => l.startsWith("sudo"))).toBe(false);
    expect(notes).toContain("sudo: not root, so no account's rules can be listed");
  });

  it("takes sudo not installed as no for every account", async () => {
    const { facts } = await readAdminFacts({ root: root(files).root, run: dpkg().run, euid: 0 });
    expect(facts.sudo).toHaveLength(7);
    expect(facts.sudo.every((s) => s.root === "no")).toBe(true);
  });

  it("runs at most eight sudo at once", async () => {
    let running = 0;
    let most = 0;
    const many = Array.from({ length: 30 }, (_, i) => `svc${i}:x:${2000 + i}:${2000 + i}::/:/usr/sbin/nologin`).join("\n");
    const runner = sudoers();
    const original = runner.run;
    const counting: typeof original = async (f, a, o) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await original(f, a, o);
      } finally {
        running--;
      }
    };
    const { facts } = await readAdminFacts({ root: root({ ...files, "/etc/passwd": `${PASSWD}${many}\n` }).root, run: counting, euid: 0 });
    expect(facts.sudo).toHaveLength(37);
    expect(most).toBeLessThanOrEqual(8);
  });

  it("bounds a hung sudo: its account cannotTell, the others answered", async () => {
    const runner = sudoers().on("sudo -n -l -U liza", "hang");
    const started = Date.now();
    const { facts } = await readAdminFacts({ root: root(files).root, run: runner.run, euid: 0 });
    expect(byName(facts.sudo)).toMatchObject({ liza: "cannotTell", dima: "no" });
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 15_000);

  it("resolves a polkit user by /etc/passwd, and names an unrecognised file", async () => {
    const r = root({ ...files, "/usr/share/polkit-1/rules.d/20-gnome-initial-setup.rules": "x", "/etc/polkit-1/rules.d/60-mine.rules": "x" });
    const runner = dpkg().on(/^dpkg-query -S .*gnome-initial-setup/, { stdout: "gnome-initial-setup: /usr/share/polkit-1/rules.d/20-gnome-initial-setup.rules\n" });
    const { facts, notes } = await readAdminFacts({ root: r.root, run: runner.run, euid: 1000 });
    expect(facts.polkit.users).toEqual([{ osId: 119, name: "gnome-initial-setup" }]);
    expect(facts.polkit.unrecognised).toBe(true);
    expect(notes).toContain("polkit: /etc/polkit-1/rules.d/60-mine.rules: not a stock file the backend knows");
  });

  it("drops an identity the local files do not hold where no directory is named, and gives it as written where one is", async () => {
    // Ubuntu's stock 49-ubuntu-admin.rules names unix-group:admin, a group Ubuntu no longer makes.
    const rules = { "/usr/share/polkit-1/rules.d/49-ubuntu-admin.rules": "x", "/usr/share/polkit-1/rules.d/20-gnome-initial-setup.rules": "x" };
    const passwd = PASSWD.replace(/^gnome-initial-setup.*\n/m, "");
    const runner = dpkg()
      .on(/^dpkg-query -S .*49-ubuntu-admin/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/49-ubuntu-admin.rules\n" })
      .on(/^dpkg-query -S .*gnome-initial-setup/, { stdout: "gnome-initial-setup: /usr/share/polkit-1/rules.d/20-gnome-initial-setup.rules\n" });
    const local = await readAdminFacts({ root: root({ ...files, "/etc/passwd": passwd, ...rules }).root, run: runner.run, euid: 1000 });
    expect(local.facts.polkit).toEqual({ users: [], groups: [{ name: "sudo", gid: 27 }], unresolved: [], unrecognised: false });
    expect(local.notes).toEqual(expect.arrayContaining(["polkit: unix-group:admin names no group here", "polkit: unix-user:gnome-initial-setup names no account here"]));
    const directory = await readAdminFacts({
      root: root({ ...files, "/etc/passwd": passwd, "/etc/nsswitch.conf": NSSWITCH_SSS, ...SSSD_CONF, ...rules }).root, run: runner.run, euid: 1000,
    });
    expect(directory.facts.polkit.unresolved.sort()).toEqual(["unix-group:admin", "unix-user:gnome-initial-setup"]);
  });

  it("with a directory named, resolves a listed member and a polkit group through NSS", async () => {
    const r = root({ ...files, "/etc/nsswitch.conf": NSSWITCH_SSS, ...SSSD_CONF, "/etc/group": GROUP.replace("sudo:x:27:liza,ghost", "sudo:x:27:liza,olga@corp.example") });
    const runner = dpkg()
      .on("getent passwd -- olga@corp.example", { stdout: "olga@corp.example:*:1500001:1500001:Olga:/home/olga@corp.example:/bin/bash\n" });
    const { facts } = await readAdminFacts({ root: r.root, run: runner.run, euid: 1000 });
    expect(facts.groups.find((g) => g.name === "sudo")!.members).toEqual([{ osId: 1000, name: "liza" }, { osId: 1500001, name: "olga@corp.example" }]);
  });

  it("with a directory named for passwd, group or sudoers, says the set cannot be enumerated, so the core adds unknown (review I1)", async () => {
    for (const nss of [NSSWITCH_SSS, `${NSSWITCH_FILES}sudoers:        files sss\n`]) {
      const runner = sudoers().on("sudo -n -l -U liza", { stdout: sudoList("liza", "(ALL : ALL) ALL") });
      const { facts } = await readAdminFacts({ root: root({ ...files, "/etc/nsswitch.conf": nss, ...SSSD_CONF }).root, run: runner.run, euid: 0 });
      expect(facts.incomplete?.length).toBeGreaterThan(0);
      expect(reduceAdmins(facts, (_id, name) => name).map((a) => a.label)).toContain("unknown");
    }
    const { facts } = await readAdminFacts({ root: root(files).root, run: sudoers().run, euid: 0 });
    expect(facts.incomplete ?? []).toEqual([]);
  });

  it("on Ubuntu's desktop shape, sss named with sssd not configured, gives a complete set: no unknown for this cause (review N1)", async () => {
    const rules = { "/usr/share/polkit-1/rules.d/49-ubuntu-admin.rules": "x" };
    const runner = sudoers().on(/^dpkg-query -S .*49-ubuntu-admin/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/49-ubuntu-admin.rules\n" });
    const shape = root({ ...files, "/etc/nsswitch.conf": NSSWITCH_SSS, "/etc/sssd/conf.d/.placeholder-removed": "", ...rules });
    rmSync(join(shape.root, "etc", "sssd", "conf.d", ".placeholder-removed"));
    const { facts, notes } = await readAdminFacts({ root: shape.root, run: runner.run, euid: 0 });
    expect(facts.incomplete).toEqual([]);
    expect(facts.polkit.unresolved).toEqual([]);
    expect(notes).toContain("polkit: unix-group:admin names no group here");
    expect(reduceAdmins(facts, (_id, name) => name).map((a) => a.label)).not.toContain("unknown");
  });

  it("drops an administrators' group member NSS says is not there, and says the set is incomplete when the lookup fails (review I1)", async () => {
    const found = await readAdminFacts({
      root: root(files).root, euid: 0,
      run: sudoers().on("getent passwd -- ghost", { stdout: "ghost:x:61000:61000::/home/ghost:/bin/bash\n" }).run,
    });
    // An account NSS serves beside /etc/passwd (systemd's userdb): a member.
    expect(found.facts.groups.find((g) => g.name === "sudo")!.members).toEqual([{ osId: 1000, name: "liza" }, { osId: 61000, name: "ghost" }]);
    const absent = await readAdminFacts({ root: root(files).root, run: sudoers().run, euid: 0 });
    expect(absent.facts.incomplete ?? []).toEqual([]);
    const failed = await readAdminFacts({
      root: root(files).root, euid: 0, run: sudoers().on("getent passwd -- ghost", new RunError("timeout", "getent did not finish")).run,
    });
    expect(failed.facts.incomplete).toEqual(["group sudo: member ghost could not be looked up"]);
  });

  it("drops a polkit identity only on NSS's own \"not found\", resolves one NSS serves beside the files, and keeps a failed lookup unresolved (review M8)", async () => {
    const rules = { "/usr/share/polkit-1/rules.d/49-ubuntu-admin.rules": "x" };
    const owner = dpkg().on(/^dpkg-query -S .*49-ubuntu-admin/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/49-ubuntu-admin.rules\n" });
    const served = await readAdminFacts({
      root: root({ ...files, ...rules }).root, euid: 1000, run: owner.on("getent group -- admin", { stdout: "admin:x:600:\n" }).run,
    });
    expect(served.facts.polkit.groups).toEqual([{ name: "sudo", gid: 27 }, { name: "admin", gid: 600 }]);
    const failing = dpkg().on(/^dpkg-query -S .*49-ubuntu-admin/, { stdout: "polkitd: /usr/share/polkit-1/rules.d/49-ubuntu-admin.rules\n" })
      .on("getent group -- admin", { code: 1, stderr: "getent: error\n" });
    const failed = await readAdminFacts({ root: root({ ...files, ...rules }).root, euid: 1000, run: failing.run });
    expect(failed.facts.polkit.unresolved).toEqual(["unix-group:admin"]);
  });

  it("reads a Runas name whose uid is 0 in /etc/passwd as root (review M9)", async () => {
    const runner = sudoers().on("sudo -n -l -U liza", { stdout: sudoList("liza", "(toor) /usr/bin/less") });
    const passwd = `${PASSWD}toor:x:0:0:,,,:/root:/bin/sh\n`;
    const { facts } = await readAdminFacts({ root: root({ ...files, "/etc/passwd": passwd }).root, run: runner.run, euid: 0 });
    expect(byName(facts.sudo).liza).toBe("yes");
  });

  it("refuses a truncated /etc/passwd, one with no root or a malformed line, as a failed read (review M2)", async () => {
    for (const passwd of ["", PASSWD.replace(/^root.*\n/m, ""), `${PASSWD}broken:x:notanumber\n`]) {
      await expect(readAdminFacts({ root: root({ ...files, "/etc/passwd": passwd }).root, run: sudoers().run, euid: 0 })).rejects.toThrow(/\/etc\/passwd/);
    }
  });

  it("throws when /etc/group cannot be read: the core keeps the last set with unknown", async () => {
    await expect(readAdminFacts({ root: root({ "/etc/passwd": PASSWD }).root, run: dpkg().run, euid: 0 })).rejects.toThrow(/ENOENT/);
  });
});
