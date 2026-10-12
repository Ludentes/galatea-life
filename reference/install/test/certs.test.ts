import { X509Certificate } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

const SERVERS = ["applier", "steward", "broker"];

/** The installation's CA and its servers' certificates (the install-core design, *TLS inside the stack*). */
describe("galatea-certs", () => {
  let s: Stack;
  const pem = (name: string) => readFileSync(join(s.tls, `${name}.pem`), "utf8");
  const cert = (name: string) => new X509Certificate(pem(name));
  const key = (name: string) => join(s.secretsRoot, "tls", `${name}.key`);
  const caKey = () => join(s.secretsRoot, "ca", "ca.key");
  const fingerprints = () => Object.fromEntries(["ca", ...SERVERS].map((n) => [n, cert(n).fingerprint256]));
  /** openssl in the certificate tool's image, as the owner, with the stack's files bound. */
  const openssl = (script: string) => run("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`,
    "-v", `${s.secretsRoot}:/s`, "-v", `${s.tls}:/t`, "--entrypoint", "sh", "galatea-certs:local", "-c", script], process.env);

  beforeAll(async () => {
    // Stack.create runs galatea-prepare, which runs galatea-certs.
    s = await Stack.create(["applier", "steward"], { GALATEA_TLS_NAMES: "box.home.arpa,192.0.2.5" });
  });
  afterAll(async () => s?.destroy());

  it("makes a CA: P-256, ten years, critical CA:true with pathlen 0, signing certificates only", () => {
    const ca = cert("ca");
    expect(ca.ca).toBe(true);
    expect(ca.checkIssued(ca)).toBe(true);
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const years = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(9.9);
    expect(ca.keyUsage ?? []).toEqual([]); // Node lists only extended key usage; the text below has the rest.
  });

  it("issues each server a certificate the CA signed, two years, naming its service, localhost, 127.0.0.1 and the configured names", () => {
    const ca = cert("ca");
    for (const n of SERVERS) {
      const c = cert(n);
      expect(c.verify(ca.publicKey), n).toBe(true);
      expect(c.checkIssued(ca), n).toBe(true);
      expect(c.ca, n).toBe(false);
      const days = (Date.parse(c.validTo) - Date.parse(c.validFrom)) / 86_400_000;
      expect(Math.round(days), n).toBe(730);
      expect(c.subjectAltName, n).toBe(`DNS:${n}, DNS:localhost, IP Address:127.0.0.1, DNS:box.home.arpa, IP Address:192.0.2.5`);
      expect(c.checkHost(n), n).toBe(n);
      expect(c.checkIP("127.0.0.1"), n).toBe("127.0.0.1");
    }
  });

  it("writes the extensions a strict verifier asks for: critical basic constraints, key usage, key identifiers", async () => {
    const r = await s.must(openssl("openssl x509 -in /t/ca.pem -noout -text; openssl x509 -in /t/applier.pem -noout -text"));
    const [caText, leafText] = r.stdout.split(/(?=Certificate:\n)/);
    expect(caText).toMatch(/Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
    expect(caText).toMatch(/Key Usage: critical\s+Certificate Sign, CRL Sign/);
    expect(caText).toContain("Subject Key Identifier");
    expect(leafText).toMatch(/Basic Constraints: critical\s+CA:FALSE/);
    expect(leafText).toMatch(/Key Usage: critical\s+Digital Signature/);
    expect(leafText).toMatch(/Extended Key Usage: \s+TLS Web Server Authentication/);
    expect(leafText).toContain("Authority Key Identifier");
  });

  it("passes Python's default verification, strict since 3.13, for every server", async () => {
    for (const n of SERVERS) {
      const r = await run("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`,
        "-v", `${s.secretsRoot}:/s:ro`, "-v", `${s.tls}:/t:ro`, "-v", `${join(PKG, "test", "tls-strict.py")}:/check.py:ro`,
        "python:3.13-alpine", "python", "/check.py", `/t/${n}.pem`, `/s/tls/${n}.key`, "/t/ca.pem", n], process.env);
      expect(r.stdout, `${n}: ${r.stderr}`).toBe("strict\nverified TLSv1.3\n");
    }
  });

  it("keeps every key the owner's alone and every certificate readable", () => {
    for (const f of [caKey(), ...SERVERS.map(key)]) {
      expect(statSync(f).uid, f).toBe(process.getuid!());
      expect(statSync(f).mode & 0o777, f).toBe(0o600);
    }
    for (const d of [join(s.secretsRoot, "ca"), join(s.secretsRoot, "tls")]) expect(statSync(d).mode & 0o777, d).toBe(0o700);
    expect(statSync(s.tls).mode & 0o777).toBe(0o755);
    for (const n of ["ca", ...SERVERS]) {
      expect(statSync(join(s.tls, `${n}.pem`)).uid).toBe(process.getuid!());
      expect(statSync(join(s.tls, `${n}.pem`)).mode & 0o777).toBe(0o644);
    }
  });

  it("leaves everything as it is when run again", async () => {
    const before = fingerprints();
    const r = await s.must(s.bin("galatea-certs"));
    expect(r.stdout.trim()).toBe("ca kept");
    expect(fingerprints()).toEqual(before);
  });

  it("issues again only the certificate inside its last 60 days", async () => {
    const before = fingerprints();
    // The applier's certificate re-signed by the same CA, valid 30 days.
    await s.must(openssl(`cd /t && openssl x509 -x509toreq -in applier.pem -key /s/tls/applier.key -copy_extensions copyall -out /tmp/r.csr &&
      openssl x509 -req -in /tmp/r.csr -CA ca.pem -CAkey /s/ca/ca.key -days 30 -copy_extensions copyall -out applier.pem`));
    expect((Date.parse(cert("applier").validTo) - Date.now()) / 86_400_000).toBeLessThan(31);
    const r = await s.must(s.bin("galatea-certs"));
    expect(r.stdout).toContain("issued applier (60 days or fewer left)");
    expect(r.stdout).not.toMatch(/issued (steward|broker)/);
    const after = fingerprints();
    expect(after.applier).not.toBe(before.applier);
    expect({ ...after, applier: undefined }).toEqual({ ...before, applier: undefined });
  });

  it("issues every server again when the configured names change, as IP: for an address and DNS: for a name", async () => {
    writeFileSync(s.envFile, readFileSync(s.envFile, "utf8").replace("GALATEA_TLS_NAMES=box.home.arpa,192.0.2.5", "GALATEA_TLS_NAMES=galatea.home.arpa,fd00::5"));
    const r = await s.must(s.bin("galatea-certs"));
    for (const n of SERVERS) expect(r.stdout).toContain(`issued ${n} (its names differ from the settings)`);
    expect(cert("broker").subjectAltName).toBe("DNS:broker, DNS:localhost, IP Address:127.0.0.1, DNS:galatea.home.arpa, IP Address:FD00:0:0:0:0:0:0:5");
  });

  it("issues again a certificate the current CA did not sign, and refuses a name that is no host name", async () => {
    await s.must(openssl("cd /t && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /tmp/k -subj /CN=steward -days 700 -out steward.pem 2>/dev/null"));
    let r = await s.must(s.bin("galatea-certs"));
    expect(r.stdout).toContain("issued steward (not signed by the current CA)");
    writeFileSync(s.envFile, `${readFileSync(s.envFile, "utf8")}GALATEA_TLS_NAMES=bad/name\n`);
    r = await s.bin("galatea-certs");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("not a host name or address: bad/name");
    writeFileSync(s.envFile, readFileSync(s.envFile, "utf8").replace("GALATEA_TLS_NAMES=bad/name\n", ""));
  });

  it("prints each certificate's days left with --check, changing nothing", async () => {
    const before = fingerprints();
    const r = await s.must(s.bin("galatea-certs", "--check"));
    expect(r.stdout).toMatch(/^ca: 36\d\d days left$/m);
    for (const n of SERVERS) expect(r.stdout).toMatch(new RegExp(`^${n}: 7[23]\\d days left$`, "m"));
    expect(fingerprints()).toEqual(before);
  });

  it("makes a new CA and every certificate again with --new-ca", async () => {
    const before = fingerprints();
    const r = await s.must(s.bin("galatea-certs", "--new-ca"));
    expect(r.stdout).toContain("ca made");
    const after = fingerprints();
    for (const n of ["ca", ...SERVERS]) expect(after[n], n).not.toBe(before[n]);
    for (const n of SERVERS) expect(cert(n).checkIssued(cert("ca"))).toBe(true);
  });

  it("refuses a CA certificate without its key, rather than making a second CA", async () => {
    const held = readFileSync(caKey());
    writeFileSync(caKey(), "");
    try {
      const r = await s.bin("galatea-certs");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("without the other");
    } finally {
      writeFileSync(caKey(), held);
    }
  });

  it("mounts the CA's key into no service", async () => {
    const r = await s.must(s.compose("--profile", "zigbee", "config", "--format", "json"));
    const services = JSON.parse(r.stdout).services as Record<string, { volumes?: { source: string }[] }>;
    for (const [name, svc] of Object.entries(services)) {
      for (const v of svc.volumes ?? []) {
        expect(v.source ?? "", name).not.toContain(join(s.secretsRoot, "ca"));
        expect(v.source ?? "", name).not.toBe(s.secretsRoot);
      }
    }
  });
});
