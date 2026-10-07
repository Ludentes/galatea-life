import { describe, expect, it } from "vitest";
import { brokerFromUrl } from "../src/bus/broker-url.js";

describe("brokerFromUrl", () => {
  it("splits the identity and the password off the URL", () => {
    expect(brokerFromUrl("mqtt://demo-applier:s%40cret@127.0.0.1:1883"))
      .toEqual({ url: "mqtt://127.0.0.1:1883", identity: "demo-applier", password: "s@cret" });
    expect(brokerFromUrl("mqtts://demo-applier@broker.local:8883")).toEqual({ url: "mqtts://broker.local:8883", identity: "demo-applier" });
  });

  it("refuses a malformed URL, another protocol or no identity, and never repeats the value", () => {
    for (const raw of ["mqtt://id:topsecret@[bad", "http://id:topsecret@host:1883", "not a url topsecret", "mqtt://:topsecret@host:1883", "mqtt://id:top%zzsecret@host:1883"]) {
      let message = "";
      try {
        brokerFromUrl(raw);
      } catch (err) {
        message = err instanceof Error ? `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}` : String(err);
      }
      expect(message).toMatch(/^GALATEA_BROKER /);
      expect(message).not.toMatch(/secret/);
    }
  });
});
