import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canWrite, exists, makeRootOnlyDir, type Writer } from "../src/linux/files.js";
import { Watches } from "../src/linux/watch.js";
import { fakeRoot } from "./linux-fakes.js";

const me = process.getuid!();
const myGid = process.getgid!();
/** Another account, in none of this process's groups. */
const stranger: Writer = { uid: 54321, gids: new Set([54321]) };
/** Another account in this process's primary group. */
const colleague: Writer = { uid: 54322, gids: new Set([54322, myGid]) };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});
/** A directory of this process's own, mode 0755, under the system's sticky /tmp: only this process's account can replace it. */
function base(): string {
  const d = mkdtempSync(join(tmpdir(), "galatea-files-"));
  chmodSync(d, 0o755);
  dirs.push(d);
  return d;
}
/** A directory, mode 0755 whatever the umask. */
function dir(path: string): string {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o755);
  return path;
}
function file(path: string, mode: number): string {
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, mode);
  return path;
}

describe("canWrite", () => {
  it("reads the owner's, the group's or the others' bits, as the kernel picks them", async () => {
    const d = base();
    const f = file(join(d, "tool"), 0o644);
    expect(await canWrite({ uid: me, gids: new Set([myGid]) }, f)).toBe(true);
    expect(await canWrite(stranger, f)).toBe(false);
    expect(await canWrite(colleague, f)).toBe(false);
    chmodSync(f, 0o664);
    expect(await canWrite(colleague, f)).toBe(true);
    expect(await canWrite(stranger, f)).toBe(false);
    chmodSync(f, 0o646);
    expect(await canWrite(stranger, f)).toBe(true);
    // The owner's bits alone apply to the owner: a group member's bits do not help it, nor the others' a member.
    chmodSync(f, 0o602);
    expect(await canWrite(colleague, f)).toBe(false);
  });

  it("takes root as writing anything, and a path that is not there as not writable", async () => {
    expect(await canWrite({ uid: 0, gids: new Set([0]) }, "/nonexistent/x")).toBe(true);
    expect(await canWrite(stranger, join(base(), "missing"))).toBe(false);
  });

  it("takes a file in a directory the account can write as writable, however the file's own mode reads", async () => {
    const d = base();
    const sub = dir(join(d, "bin"));
    const f = file(join(sub, "python3"), 0o755);
    expect(await canWrite(colleague, f)).toBe(false);
    chmodSync(sub, 0o775);
    expect(await canWrite(colleague, f)).toBe(true);
    // Two levels up counts as well: the account can rename `bin` away.
    chmodSync(sub, 0o755);
    chmodSync(d, 0o777);
    expect(await canWrite(stranger, f)).toBe(true);
  });

  it("takes a sticky directory as writable only for what the account owns (/tmp)", async () => {
    const d = base();
    const sticky = join(d, "tmp");
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    const f = file(join(sticky, "tool"), 0o755);
    // Owned by this process's account: a stranger cannot replace it in a sticky directory.
    expect(await canWrite(stranger, f)).toBe(false);
    // Its owner can.
    expect(await canWrite({ uid: me, gids: new Set([myGid]) }, f)).toBe(true);
    // Not sticky: anyone who can write the directory can.
    chmodSync(sticky, 0o777);
    expect(await canWrite(stranger, f)).toBe(true);
  });

  it("follows links, answering for the target and every link's own directory (plan 3c's M5)", async () => {
    const d = base();
    for (const sub of ["usr-bin", "alternatives", "real"]) dir(join(d, sub));
    const target = file(join(d, "real", "python3.12"), 0o755);
    symlinkSync(target, join(d, "alternatives", "python3"));
    symlinkSync("../alternatives/python3", join(d, "usr-bin", "python3"));
    const entry = join(d, "usr-bin", "python3");
    expect(await canWrite(colleague, entry)).toBe(false);
    // The target's directory writable.
    chmodSync(join(d, "real"), 0o775);
    expect(await canWrite(colleague, entry)).toBe(true);
    chmodSync(join(d, "real"), 0o755);
    // The middle link's directory writable: the account could point the link elsewhere.
    chmodSync(join(d, "alternatives"), 0o775);
    expect(await canWrite(colleague, entry)).toBe(true);
    chmodSync(join(d, "alternatives"), 0o755);
    // The target itself writable.
    chmodSync(target, 0o775);
    expect(await canWrite(colleague, entry)).toBe(true);
  });

  it("takes a dangling link or a loop as not there, so not writable", async () => {
    const d = base();
    symlinkSync(join(d, "nowhere"), join(d, "dangling"));
    symlinkSync(join(d, "b"), join(d, "a"));
    symlinkSync(join(d, "a"), join(d, "b"));
    expect(await canWrite(stranger, join(d, "dangling"))).toBe(false);
    expect(await canWrite(stranger, join(d, "a"))).toBe(false);
  });
});

describe("exists", () => {
  it("answers whether the path is there and a regular file with an execute bit, links followed", async () => {
    const d = base();
    const f = file(join(d, "tool"), 0o755);
    const plain = file(join(d, "data"), 0o644);
    symlinkSync(f, join(d, "link"));
    expect(await exists(f)).toEqual({ exists: true, executable: true });
    expect(await exists(plain)).toEqual({ exists: true, executable: false });
    expect(await exists(join(d, "link"))).toEqual({ exists: true, executable: true });
    expect(await exists(d)).toEqual({ exists: true, executable: false });
    expect(await exists(join(d, "missing"))).toEqual({ exists: false, executable: false });
  });
});

describe("makeRootOnlyDir", () => {
  it("refuses without root: the plugin host names plugins_unready", async () => {
    const d = base();
    await expect(makeRootOnlyDir(join(d, "plugins"), { euid: 1000 })).rejects.toThrow(/made by root, and this process is not root/);
  });

  it("as root, makes it, owned by root and mode 0755 whatever it was (the owner played by this account)", async () => {
    const d = base();
    dir(join(d, "var"));
    dir(join(d, "var", "lib"));
    const target = join(d, "var", "lib", "plugins");
    mkdirSync(target);
    chmodSync(target, 0o777);
    const chowned: [string, number, number][] = [];
    await makeRootOnlyDir(target, { euid: 0, owner: me, chown: async (p, u, g) => void chowned.push([p, u, g]) });
    expect(chowned).toEqual([[target, me, me]]);
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
  });

  it("refuses a link in its place, and a directory above it that another account can write", async () => {
    const d = base();
    mkdirSync(join(d, "real"));
    symlinkSync(join(d, "real"), join(d, "plugins"));
    const o = { euid: 0, owner: me, chown: async () => {} };
    await expect(makeRootOnlyDir(join(d, "plugins"), o)).rejects.toThrow(/is not a directory/);
    const open = join(d, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    await expect(makeRootOnlyDir(join(open, "plugins"), o)).rejects.toThrow(/can be written by an account other than root/);
  });

  it("checks the directories above before it changes anything, so a directory under an unsafe one is left as it was (review M3)", async () => {
    const d = base();
    const open = join(d, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const target = join(open, "plugins");
    mkdirSync(target);
    chmodSync(target, 0o777);
    const chowned: string[] = [];
    await expect(makeRootOnlyDir(target, { euid: 0, owner: me, chown: async (p) => void chowned.push(p) }))
      .rejects.toThrow(/can be written by an account other than root/);
    expect(chowned).toEqual([]);
    expect(lstatSync(target).mode & 0o777).toBe(0o777);
  });

  it("checks where a linked directory above really is, not only the link (review M3)", async () => {
    const d = base();
    const open = join(d, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const real = dir(join(open, "lib"));
    symlinkSync(real, join(d, "lib"));
    await expect(makeRootOnlyDir(join(d, "lib", "plugins"), { euid: 0, owner: me, chown: async () => {} }))
      .rejects.toThrow(/can be written by an account other than root/);
    // A link above to a safe directory (as /var/lib linked elsewhere): taken where it leads.
    const safe = dir(join(d, "safe"));
    symlinkSync(safe, join(d, "varlib"));
    await makeRootOnlyDir(join(d, "varlib", "plugins"), { euid: 0, owner: me, chown: async () => {} });
    expect(lstatSync(join(safe, "plugins")).mode & 0o777).toBe(0o755);
  });
});

describe("makeRootOnlyDir: the directories holding a link (review N5)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const me = process.getuid!();
  const o = { euid: 0, owner: me, chown: async () => {} };

  it("refuses a link above held by a directory another account can write, wherever the link leads", async () => {
    const d = mkdtempSync(join(tmpdir(), "galatea-n5-"));
    dirs.push(d);
    const safe = join(d, "safe");
    mkdirSync(safe);
    chmodSync(safe, 0o755);
    const open = join(d, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    // /var/lib → /data/lib with /var writable by others: the link could be swapped before mkdir.
    symlinkSync(safe, join(open, "lib"));
    await expect(makeRootOnlyDir(join(open, "lib", "plugins"), o)).rejects.toThrow(/open, above the plugins directory, can be written by an account other than root/);
    // A link in a link's own holder, two deep.
    const inner = join(safe, "inner");
    mkdirSync(inner);
    chmodSync(inner, 0o755);
    symlinkSync(join(open, "lib"), join(d, "outer"));
    await expect(makeRootOnlyDir(join(d, "outer", "inner", "plugins"), o)).rejects.toThrow(/can be written by an account other than root/);
  });

  it("takes a link held by a sticky directory when the link is its own, and one held by a safe directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "galatea-n5-"));
    dirs.push(d);
    const safe = join(d, "safe");
    mkdirSync(safe);
    chmodSync(safe, 0o755);
    const sticky = join(d, "sticky");
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    symlinkSync(safe, join(sticky, "lib"));
    await makeRootOnlyDir(join(sticky, "lib", "plugins"), o);
    symlinkSync(safe, join(d, "lib"));
    await makeRootOnlyDir(join(d, "lib", "more"), o);
    expect(lstatSync(join(safe, "more")).mode & 0o777).toBe(0o755);
  });
});

describe("Watches", () => {
  const roots: { cleanup(): void }[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) r.cleanup();
  });
  const waitFor = async (cond: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  };

  it("reports an account file's change and an administrators' file's change, a burst as one", async () => {
    const r = fakeRoot({ "/etc/passwd": "", "/etc/group": "", "/etc/sudoers.d/README": "", "/usr/share/polkit-1/rules.d/50-default.rules": "" });
    roots.push(r);
    let accounts = 0;
    let admins = 0;
    const w = new Watches({ root: r.root, onAccounts: () => accounts++, onAdmins: () => admins++, debounceMs: 50 });
    w.ensure();
    try {
      expect(w.watched().sort()).toEqual(["/etc", "/etc/sudoers.d", "/usr/share/polkit-1/rules.d"]);
      // useradd's burst: passwd, then group, then their backups.
      r.write("/etc/passwd", "liza:x:1000:1000::/home/liza:/bin/bash\n");
      r.write("/etc/group", "liza:x:1000:\n");
      r.write("/etc/passwd-", "");
      await waitFor(() => accounts > 0 && admins > 0);
      await new Promise((res) => setTimeout(res, 150));
      expect(accounts).toBe(1);
      expect(admins).toBe(1);
      r.write("/etc/sudoers.d/90-less", "dima ALL=(root) /usr/bin/less\n");
      await waitFor(() => admins > 1);
      expect(admins).toBe(2);
      expect(accounts).toBe(1);
      r.write("/etc/hostname", "desk\n");
      await new Promise((res) => setTimeout(res, 150));
      expect([accounts, admins]).toEqual([1, 2]);
    } finally {
      w.close();
    }
  });

  it("reports a directory's configuration appearing as both kinds of change, nsswitch.conf untouched (review N1)", async () => {
    const r = fakeRoot({ "/etc/passwd": "", "/etc/sssd/conf.d/README": "", "/etc/samba/README": "", "/etc/ldap/README": "" });
    roots.push(r);
    let accounts = 0;
    let admins = 0;
    const w = new Watches({ root: r.root, onAccounts: () => accounts++, onAdmins: () => admins++, debounceMs: 20 });
    w.ensure();
    try {
      expect(w.watched()).toEqual(expect.arrayContaining(["/etc/sssd", "/etc/sssd/conf.d", "/etc/samba"]));
      for (const [path, n] of [
        ["/etc/sssd/sssd.conf", 1], ["/etc/sssd/conf.d/50-corp.conf", 2], ["/etc/samba/smb.conf", 3], ["/etc/yp.conf", 4], ["/etc/ldap/ldap.conf", 5],
      ] as const) {
        r.write(path, "x\n");
        await waitFor(() => accounts >= n && admins >= n);
        await new Promise((res) => setTimeout(res, 60));
        expect([accounts, admins]).toEqual([n, n]);
      }
    } finally {
      w.close();
    }
  });

  it("watches a directory made after the start at the next ensure, and never throws for one that is not there", async () => {
    const r = fakeRoot({ "/etc/passwd": "" });
    roots.push(r);
    let admins = 0;
    const w = new Watches({ root: r.root, onAccounts: () => {}, onAdmins: () => admins++, debounceMs: 20 });
    w.ensure();
    try {
      expect(w.watched()).toEqual(["/etc"]);
      r.write("/etc/polkit-1/rules.d/60-mine.rules", "");
      w.ensure();
      expect(w.watched()).toContain("/etc/polkit-1/rules.d");
      r.write("/etc/polkit-1/rules.d/61-more.rules", "");
      await waitFor(() => admins > 0);
      expect(admins).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  });
});
