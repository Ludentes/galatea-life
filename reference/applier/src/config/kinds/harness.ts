// The kinds the conformance harness alone may send.
import { bad, checked, type Kind } from "./common.js";

export const harnessKinds: Record<string, Kind> = {
  time_source(draft, change, ctx) {
    if (!ctx.underHarness) bad("time_source is accepted only under the conformance harness (GA-HARN-1)");
    if (change.op === "delete") {
      draft.timeSource = undefined;
      return "- time_source";
    }
    const source = checked<string>("applier/configure.time_source.json", change.value);
    if (draft.timeSource === source) return undefined;
    draft.timeSource = source;
    return `~ time_source ${source}`;
  },
};
