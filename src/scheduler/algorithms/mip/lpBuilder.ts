// A minimal builder for the CPLEX LP text format HiGHS's `solve()` consumes
// (see node_modules/highs/README.md) — deliberately not a general-purpose
// LP library, just what this algorithm's model needs: named binary/general
// (integer)/continuous variables, linear constraint rows, box bounds, and a
// single linear objective. Kept separate from model.ts so the "how do I
// serialize a linear expression" concern doesn't tangle with "what does
// this scheduling problem's model actually look like."

export type LpTerm = readonly [coefficient: number, variable: string];
export type VarKind = "binary" | "general" | "continuous";

function fmtNum(n: number): string {
  // LP text is parsed as-is; round away float noise (e.g. fair-share
  // divisions) without losing meaningful precision.
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}

function fmtTerms(terms: readonly LpTerm[]): string {
  if (terms.length === 0) return "0";
  return terms
    .map(([coef, name], i) => {
      const sign = coef < 0 ? "-" : i === 0 ? "" : "+";
      const abs = Math.abs(coef);
      const coefText = abs === 1 ? "" : `${fmtNum(abs)} `;
      return `${sign} ${coefText}${name}`;
    })
    .join(" ")
    .replace(/^\+ /, "");
}

export class LpBuilder {
  private objectiveSense: "Minimize" | "Maximize" = "Minimize";
  private objectiveTerms: LpTerm[] = [];
  private constraintLines: string[] = [];
  private boundLines: string[] = [];
  private binaryVars: string[] = [];
  private generalVars: string[] = [];
  private declared = new Set<string>();
  private constraintCount = 0;

  // Every variable used anywhere (objective, constraints, bounds) must be
  // declared exactly once so it lands in the right LP section; declaring
  // twice is a no-op rather than an error, since the same variable
  // legitimately appears in many constraints.
  declareVar(name: string, kind: VarKind, bounds?: { lower?: number; upper?: number }): void {
    if (!this.declared.has(name)) {
      this.declared.add(name);
      if (kind === "binary") this.binaryVars.push(name);
      else if (kind === "general") this.generalVars.push(name);
    }
    if (bounds) {
      const lower = bounds.lower ?? 0;
      const upper = bounds.upper;
      if (upper !== undefined) this.boundLines.push(`${fmtNum(lower)} <= ${name} <= ${fmtNum(upper)}`);
      else if (lower !== 0) this.boundLines.push(`${fmtNum(lower)} <= ${name}`);
    }
  }

  setObjective(sense: "Minimize" | "Maximize", terms: readonly LpTerm[]): void {
    this.objectiveSense = sense;
    this.objectiveTerms = terms.slice();
  }

  // op: "<=" | ">=" | "=". Constraints are auto-named (c0, c1, ...) since
  // nothing downstream needs to address a row by name.
  addConstraint(terms: readonly LpTerm[], op: "<=" | ">=" | "=", rhs: number): void {
    const name = `c${this.constraintCount++}`;
    this.constraintLines.push(`${name}: ${fmtTerms(terms)} ${op} ${fmtNum(rhs)}`);
  }

  build(): string {
    const lines: string[] = [];
    lines.push(this.objectiveSense);
    lines.push(` obj: ${fmtTerms(this.objectiveTerms)}`);
    lines.push("Subject To");
    for (const c of this.constraintLines) lines.push(` ${c}`);
    if (this.boundLines.length > 0) {
      lines.push("Bounds");
      for (const b of this.boundLines) lines.push(` ${b}`);
    }
    if (this.binaryVars.length > 0) {
      lines.push("Binary");
      for (const v of this.binaryVars) lines.push(` ${v}`);
    }
    if (this.generalVars.length > 0) {
      lines.push("General");
      for (const v of this.generalVars) lines.push(` ${v}`);
    }
    lines.push("End");
    return lines.join("\n");
  }
}
