import { DefinitionError } from "./builder.ts";
import type { FieldSpec } from "./types.ts";

/**
 * Group fields into steps: each field goes in the step after the latest step of anything in its
 * `after` list, and fields with no `after` go in the first step. Within a step, fields keep
 * their declaration order. Repeats the builder's type checks at runtime for untyped callers.
 */
export function plan(fields: readonly FieldSpec[]): FieldSpec[][] {
  const stepOf = new Map<string, number>();
  const steps: FieldSpec[][] = [];
  for (const field of fields) {
    if (stepOf.has(field.name)) {
      throw new DefinitionError(`Field "${field.name}" is declared more than once`);
    }
    let step = 0;
    for (const dep of field.after) {
      const depStep = stepOf.get(dep);
      if (depStep === undefined) {
        const problem =
          dep === field.name
            ? "reads itself"
            : fields.some((f) => f.name === dep)
              ? `reads "${dep}", which is declared after it`
              : `reads unknown field "${dep}"`;
        throw new DefinitionError(`Field "${field.name}" ${problem}`);
      }
      step = Math.max(step, depStep + 1);
    }
    stepOf.set(field.name, step);
    (steps[step] ??= []).push(field);
  }
  return steps;
}
