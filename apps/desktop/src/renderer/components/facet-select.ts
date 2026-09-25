// The multi-select facet gesture, shared by every chip whose options are an
// inventory the server computes: Claude Code's Tool / Session / Project and
// Detections' Source. Moved out of ClaudeCode.tsx verbatim so Detections can
// use it without importing a sibling view (ClaudeCode already imports from
// Detections, and a cycle between the two is what this avoids).

// Multi-select facet gesture (commit 6, Detections' Severity/Category
// semantics): null = no filter, rendered as all-checked; toggling narrows to
// the checked subset; all checked OR none checked collapses back to null.
export function facetChange(
  next: readonly string[],
  all: readonly string[],
  set: (v: readonly string[] | null) => void,
): void {
  set(next.length === 0 || next.length === all.length ? null : [...next]);
}

// Facet options = the server's stable inventory (computed on the base
// filter, so picking Bash never removes the other tools from the menu),
// unioned with any active selection whose value slid out of the current
// time window — it must stay visible to be un-checkable.
export function facetOptions(
  inventory: readonly string[],
  active: readonly string[] | null,
): string[] {
  if (active === null) return [...inventory];
  const s = new Set([...inventory, ...active]);
  return [...s].sort();
}
