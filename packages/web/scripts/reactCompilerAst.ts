// Pure reads of a Babel AST for scripts/react-compiler-report.ts: which nested
// functions run while their parent renders, which arguments are certainly
// values, and which module-level bindings a function could read stale. No
// state of its own, so the report's walk stays the one place that holds any.
import { types as t, type NodePath } from "@babel/core";

export const ARRAY_METHODS = new Set(["map", "filter", "flatMap", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted"]);
export const RENDER_TIME_HOOKS = new Set(["useMemo", "useState", "useReducer"]);
// A state initializer runs once per mount, compiled or not: a read there is
// render-time (it counts as a getState() call) but the compiler changes
// nothing about it.
export const INITIALIZER_HOOKS = new Set(["useState", "useReducer", "useRef"]);
export function isStateInitializer(fn: NodePath<t.Function>): boolean {
  const parent = fn.parentPath;
  if (!parent?.isCallExpression()) return false;
  const callee = parent.node.callee;
  const name = t.isIdentifier(callee) ? callee.name : t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : null;
  return !!name && INITIALIZER_HOOKS.has(name);
}
export const STORAGE = new Set(["localStorage", "sessionStorage"]);

// Hooks that hand their first argument back as a callable (useCallback and the
// codebase's own stable-callback hooks). useMemo, useState and useReducer run
// theirs during render instead; effects never hand theirs back.
export const WRAPPER_HOOK = /^use\w*(Callback|Event|Handler)\w*$/;
export const calleeNameOf = (call: t.CallExpression): string | null =>
  t.isIdentifier(call.callee) ? call.callee.name : t.isMemberExpression(call.callee) && t.isIdentifier(call.callee.property) ? call.callee.property.name : null;

/** Whether a nested function runs while its parent renders. */
export function runsDuringRender(fn: NodePath<t.Function>, visiting = new Set<t.Node>()): boolean {
  const parent = fn.parentPath;
  // `const row = () => …; row()` and a nested `function row() {}` called by
  // name: a local function runs during render when a call to it does, which
  // is a call in the owning function's body or in a callback that itself runs
  // during render. A call from a handler does not count.
  // The same through a wrapper that hands the function back: `const row = useCallback(() => …, deps); row()`.
  const wrapped = parent?.isCallExpression() && parent.node.arguments[0] === fn.node && WRAPPER_HOOK.test(calleeNameOf(parent.node) ?? "") && parent.parentPath?.isVariableDeclarator() && t.isIdentifier(parent.parentPath.node.id) ? parent.parentPath.node.id.name : undefined;
  const localName = wrapped ?? (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id) ? parent.node.id.name : fn.isFunctionDeclaration() ? fn.node.id?.name : undefined);
  if (localName) {
    if (visiting.has(fn.node)) return false;
    visiting.add(fn.node);
    const binding = (fn.isFunctionDeclaration() ? fn.parentPath.scope : fn.scope.parent)?.getBinding(localName);
    const owner = binding?.scope.getFunctionParent()?.path.node ?? null;
    if (!binding || !owner) return false;
    return binding.referencePaths.some((ref) => {
      if (!ref.parentPath?.isCallExpression() || ref.parentPath.node.callee !== ref.node) return false;
      for (let up = ref.getFunctionParent(); up && up.node !== owner; up = up.getFunctionParent()) {
        if (!runsDuringRender(up, visiting)) return false;
      }
      return true;
    });
  }
  if (!parent?.isCallExpression()) return false;
  const callee = parent.node.callee;
  if (callee === fn.node) return true; // IIFE
  if (t.isIdentifier(callee)) return RENDER_TIME_HOOKS.has(callee.name) && parent.node.arguments[0] === fn.node;
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
    return ARRAY_METHODS.has(callee.property.name) || (RENDER_TIME_HOOKS.has(callee.property.name) && parent.node.arguments[0] === fn.node);
  }
  return false;
}

/**
 * Whether a passed argument is certainly a value: a literal, a variable that
 * holds a hook's result (`const now = useCoarseNow(60_000)`), or a prop typed
 * inline as a required primitive. Anything else may be undefined, and then the callee's default (`now = Date.now()`)
 * runs after all.
 */
export function definite(arg: NodePath): boolean {
  if (arg.isNumericLiteral() || arg.isStringLiteral() || arg.isBooleanLiteral()) return true;
  if (!arg.isIdentifier()) return false;
  const decl = arg.scope.getBinding(arg.node.name)?.path;
  // A destructured prop with a default: `{ workedMs = 0 }`.
  if (decl?.isObjectPattern() && decl.node.properties.some((prop) => t.isObjectProperty(prop) && t.isAssignmentPattern(prop.value) && t.isIdentifier(prop.value.left, { name: arg.node.name }))) return true;
  // A destructured prop typed inline as required: `{ now }: { now: number }`.
  if (decl?.isObjectPattern() && t.isTSTypeAnnotation(decl.node.typeAnnotation) && t.isTSTypeLiteral(decl.node.typeAnnotation.typeAnnotation)) {
    const member = decl.node.typeAnnotation.typeAnnotation.members.find((m) => t.isTSPropertySignature(m) && t.isIdentifier(m.key, { name: arg.node.name }));
    const type = member && t.isTSPropertySignature(member) && !member.optional ? member.typeAnnotation?.typeAnnotation : null;
    return !!type && (t.isTSNumberKeyword(type) || t.isTSStringKeyword(type) || t.isTSBooleanKeyword(type));
  }
  if (!decl?.isVariableDeclarator() || !t.isIdentifier(decl.node.id)) return false;
  const init = decl.node.init;
  return t.isCallExpression(init) && t.isIdentifier(init.callee) && /^use[A-Z]/.test(init.callee.name);
}
export const maybeArgs = (call: NodePath<t.CallExpression>) => call.get("arguments").flatMap((arg, i) => (definite(arg as NodePath) ? [] : [i]));

/** Module-level bindings a function body could read stale: a reassigned `let`, or a Map/Set something mutates. */
export function mutableModuleBindings(program: NodePath<t.Program>): Set<string> {
  const out = new Set<string>();
  for (const [name, binding] of Object.entries(program.scope.bindings)) {
    const decl = binding.path;
    if (!decl.isVariableDeclarator()) continue;
    const kind = (decl.parent as t.VariableDeclaration).kind;
    if (kind === "let" || kind === "var") {
      if (binding.constantViolations.length > 0) out.add(name);
      continue;
    }
    const init = decl.node.init;
    if (t.isNewExpression(init) && t.isIdentifier(init.callee) && /^(Map|Set)$/.test(init.callee.name)) {
      const written = binding.referencePaths.some((ref) => {
        const member = ref.parentPath;
        return member?.isMemberExpression() && t.isIdentifier(member.node.property) && /^(set|add|delete|clear)$/.test(member.node.property.name) && member.parentPath?.isCallExpression();
      });
      if (written) out.add(name);
    }
  }
  return out;
}
