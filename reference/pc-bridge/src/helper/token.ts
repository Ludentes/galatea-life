import { createReadStream } from "node:fs";

/** The service writes 32 random bytes, as 64 hex digits, and nothing else. */
const TOKEN = /^[0-9a-f]{64}$/;
/** More than this on the descriptor is no start token of the service's. */
const MAX_BYTES = 256;
/** The service writes the token before it releases the helper, so it is there at once; this bounds a descriptor that never ends. */
export const TOKEN_READ_MS = 5_000;

/**
 * The helper's start token (review N1): read at once at start from the descriptor the service handed
 * it (fd 4 through the launcher), to its end, then closed, so that nothing the helper starts holds
 * it. The helper presents it in its first call, `Hello(s)`. Rejects for anything that is not the
 * service's token, and when the descriptor gives nothing within TOKEN_READ_MS.
 */
export function readToken(fd: number, boundMs = TOKEN_READ_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stream = createReadStream("", { fd, autoClose: true });
    const done = (err?: Error, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      // The descriptor is closed when the stream has let it go, read to its end or not.
      const end = () => (err ? reject(err) : resolve(token!));
      if (stream.closed) end();
      else stream.once("close", end);
    };
    const timer = setTimeout(() => done(new Error(`no start token on fd ${fd} within ${boundMs} ms`)), boundMs);
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > MAX_BYTES) return done(new Error(`the start token on fd ${fd} is longer than any the service writes`));
      chunks.push(b);
    });
    stream.on("error", (err) => done(new Error(`the start token on fd ${fd}: ${err.message}`)));
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!TOKEN.test(text)) return done(new Error(`the start token on fd ${fd} is not one the service writes`));
      done(undefined, text);
    });
  });
}
