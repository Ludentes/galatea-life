import { describe, expect, it } from "vitest";
import { notifyError, shownText } from "../src/notify-text.js";

describe("shownText", () => {
  it.each([
    ["a person at an endpoint", { endpoint: "Дмитрий", role: "guest" }, "От: Дмитрий (гость)"],
    ["an endpoint with a role it has no word for", { endpoint: "Зал", role: "kiosk" }, "От: Зал (kiosk)"],
    ["a rule", { rule: "Свет в прихожей" }, "От: правило «Свет в прихожей»"],
    ["a rule a brain wrote", { rule: "Полив", brain_authored: true }, "От: правило «Полив» — написано ассистентом"],
    ["a scenario", { scenario: "Утро", brain_authored: false }, "От: сценарий «Утро»"],
    ["a scenario a brain started", { scenario: "Утро", brain_authored: true }, "От: сценарий «Утро» — написано ассистентом"],
    ["the house's own notice", { notice: "n-42" }, "От: Galatea"],
    ["no from at all", undefined, "От: неизвестный отправитель"],
  ])("puts the source first for %s", (_name, from, first) => {
    expect(shownText("Ужин готов", from as never)).toBe(`${first}\nУжин готов`);
  });
});

describe("notifyError", () => {
  it.each([
    [{ text: "hi", urgency: "info" }],
    [{ text: "hi", urgency: "critical", from: { endpoint: "kitchen", role: "owner" } }],
    [{ text: "hi", urgency: "warning", from: { rule: "r1" } }],
    [{ text: "hi", urgency: "warning", from: { scenario: "s1", brain_authored: true } }],
    [{ text: "hi", urgency: "info", from: { notice: "n1" } }],
  ])("takes %j", (value) => {
    expect(notifyError(value)).toBeUndefined();
  });

  it.each([
    ["a bare string", "hi", /an object/],
    ["no text", { urgency: "info" }, /text/],
    ["an empty text", { text: "", urgency: "info" }, /text/],
    ["an urgency of its own", { text: "hi", urgency: "loud" }, /urgency/],
    ["an unknown key", { text: "hi", urgency: "info", title: "x" }, /unknown keys: title/],
    ["a from of no shape", { text: "hi", urgency: "info", from: { person: "x" } }, /none of the applier's shapes/],
    ["a from mixing two shapes", { text: "hi", urgency: "info", from: { rule: "r", notice: "n" } }, /none of the applier's shapes/],
    ["an endpoint without its role", { text: "hi", urgency: "info", from: { endpoint: "kitchen" } }, /none of the applier's shapes/],
    ["brain_authored on a notice", { text: "hi", urgency: "info", from: { notice: "n", brain_authored: true } }, /none of the applier's shapes/],
    ["brain_authored that is not a boolean", { text: "hi", urgency: "info", from: { rule: "r", brain_authored: "yes" } }, /not a boolean/],
    ["a from that is not an object", { text: "hi", urgency: "info", from: "guest" }, /not an object/],
  ])("refuses %s", (_name, value, error) => {
    expect(notifyError(value)).toMatch(error);
  });
});
