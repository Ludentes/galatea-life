import { describe, expect, it } from "vitest";
import { uuidV5 } from "../src/dispatch/command-id.js";

const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidV5", () => {
  it("is RFC 9562's version 5: the DNS namespace's www.example.com", () => {
    expect(uuidV5("www.example.com", DNS)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is a UUID of version 5 and the RFC variant, the same for the same name, whatever the name's length", () => {
    const long = "rule/" + "x".repeat(10_000) + "/hall:leak/1760000000000";
    const id = uuidV5(long, DNS);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV5(long, DNS)).toBe(id);
    expect(uuidV5(long + "1", DNS)).not.toBe(id);
    expect(uuidV5(long, "6ba7b811-9dad-11d1-80b4-00c04fd430c8")).not.toBe(id);
  });
});
