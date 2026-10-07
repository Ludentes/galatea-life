import type { Requested } from "../gate/resolve.js";
import type { House, Scenario, ScenarioCondition, ScenarioStep, ScenarioWait } from "../house/model.js";

/**
 * An action step of a run: its place among the scenario's action steps (from 1), the action as a
 * request's, whether it respects occupancy, and whether it is `brain_authored` work: its scenario, or
 * one whose `run` step reached it, was defined through a brain (GA-DEF-7).
 */
export interface ActionNode { kind: "action"; index: number; action: Requested; respect: boolean; conditional: boolean; brain?: true }
/**
 * One step of a run, as the steward runs it (steward, *Scenarios*): `run` steps are expanded in place,
 * so a run is one sequence; an `if` and a `wait` carry an id of their own (`if<n>`, `w<n>`), by which an
 * `if`'s own outcome is listed in `failed_steps` and a `wait`'s timeout recorded.
 */
export type Node = ActionNode
  | { kind: "if"; id: string; cond: ScenarioCondition; then: Node[]; else?: Node[] }
  | { kind: "delay"; ms: number }
  | { kind: "wait"; id: string; wait: ScenarioWait };

/** A scenario as a run takes it: its steps, its action steps in order, and the targets it owns, those of the scenarios its `run` steps reach included. */
export interface Program { scenario: string; nodes: Node[]; actions: ActionNode[]; owned: string[] }

/**
 * A scenario compiled from the house model as it stands (steward, *Scenario runs*): each `run` step
 * replaced by the steps of the scenario it names, whose own `respect_occupancy` and `owned` apply to
 * them; the action steps numbered in the order they appear, branches included, an action inside an
 * `if` marked `conditional`. `define` refuses a cycle (GA-DEF-4), so this ends. The house is the one
 * the plan was made at: `scenario_run` refuses a plan of another revision, so compiling it again there
 * gives the same program.
 */
export function compile(house: House, id: string): Program {
  let index = 0;
  let ifs = 0;
  let waits = 0;
  const actions: ActionNode[] = [];
  const owned = new Set<string>();
  // `brain`: a scenario on the way to this one is brain_authored, so every step it reaches is (GA-DEF-7).
  const of = (sc: Scenario, conditional: boolean, brain: boolean): Node[] => {
    for (const o of sc.owned) owned.add(o);
    return sc.steps.flatMap((st) => step(st, sc, conditional, brain || sc.brain_authored === true));
  };
  const step = (st: ScenarioStep, sc: Scenario, conditional: boolean, brain: boolean): Node[] => {
    if ("run" in st) return of(house.scenarios.get(st.run)!, conditional, brain);
    if ("delay" in st) return [{ kind: "delay", ms: st.delay * 1000 }];
    if ("wait" in st) return [{ kind: "wait", id: `w${++waits}`, wait: st.wait }];
    if ("if" in st) {
      const n: Node = { kind: "if", id: `if${++ifs}`, cond: st.if, then: [] };
      n.then = st.then.flatMap((x) => step(x, sc, true, brain));
      if (st.else) n.else = st.else.flatMap((x) => step(x, sc, true, brain));
      return [n];
    }
    const { respect_occupancy, ...a } = st;
    const n: ActionNode = { kind: "action", index: ++index, action: a as Requested, respect: respect_occupancy ?? sc.respect_occupancy, conditional,
      ...(brain ? { brain: true as const } : {}) };
    actions.push(n);
    return [n];
  };
  const nodes = of(house.scenarios.get(id)!, false, false);
  return { scenario: id, nodes, actions, owned: [...owned].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/** A step's id in a scenario's plan: `s<n>` for the n-th action step, `s<n>.<k>` for the k-th device of one that reaches several. */
export const stepIdOf = (index: number, k: number, of: number): string => (of === 1 ? `s${index}` : `s${index}.${k}`);

/** The action step a plan's step id belongs to. */
export const indexOf = (stepId: string): number => Number(stepId.slice(1).split(".")[0]);
