// The kinds of discovery: the owner's ignores (applier, *Discovery*).
import { bad, checked, type Kind } from "./common.js";

export const discoveryKinds: Record<string, Kind> = {
  ignore_candidate(draft, change, ctx) {
    if (change.op !== "upsert") bad("ignore_candidate takes only upsert");
    const { id } = checked<{ id: string }>("applier/configure.ignore_candidate.json", change.value);
    const c = ctx.listed?.().find((x) => x.id === id);
    if (!c) return bad(`candidate ${id} is not listed`);
    const added = c.keys.filter((k) => !draft.ignored_keys.has(k));
    for (const k of added) draft.ignored_keys.add(k);
    return added.length ? `+ ignored ${added.join(", ")}` : undefined;
  },
  unignore_candidate(draft, change) {
    if (change.op !== "upsert") bad("unignore_candidate takes only upsert");
    const { key } = checked<{ key: string }>("applier/configure.unignore_candidate.json", change.value);
    if (!draft.ignored_keys.delete(key)) bad(`key ${key} is not ignored`);
    return `- ignored ${key}`;
  },
};
