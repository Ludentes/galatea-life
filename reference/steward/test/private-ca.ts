import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private CA and a server certificate it signed for 127.0.0.1 and localhost, made with openssl, as
 * the installation's CA makes them; returned as PEM contents, the files removed.
 */
export function privateCa(): { ca: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "private-ca-"));
  const at = (f: string) => join(dir, f);
  const run = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  try {
    run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", at("ca.key"), "-out", at("ca.pem"),
      "-days", "1", "-subj", "/CN=test-ca", "-addext", "basicConstraints=critical,CA:true,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", at("server.key"), "-out", at("server.csr"), "-subj", "/CN=server");
    writeFileSync(at("ext"), "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
    run("x509", "-req", "-in", at("server.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-CAcreateserial", "-days", "1", "-out", at("server.pem"), "-extfile", at("ext"));
    return { ca: readFileSync(at("ca.pem"), "utf8"), cert: readFileSync(at("server.pem"), "utf8"), key: readFileSync(at("server.key"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
