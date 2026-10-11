import { createServer, type Server } from "node:net";

/**
 * A Postgres server of a few lines: it asks each client for a cleartext password, records it, and
 * refuses the login. It shows what password a process's pg client really sends.
 */
export async function fakePostgres(): Promise<{ port: number; passwords: string[]; close(): Promise<void> }> {
  const passwords: string[] = [];
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    sock.on("error", () => undefined);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0));
        started = true;
        // AuthenticationCleartextPassword.
        sock.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]));
      }
      if (buf.length < 5 || buf[0] !== 0x70 || buf.length < 1 + buf.readInt32BE(1)) return;
      const len = buf.readInt32BE(1);
      passwords.push(buf.subarray(5, 1 + len - 1).toString("utf8"));
      const fields = Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0", "utf8");
      const head = Buffer.alloc(5);
      head.write("E", 0);
      head.writeInt32BE(4 + fields.length, 1);
      sock.end(Buffer.concat([head, fields]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    passwords,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
