// Bridge between TS modules and the legacy `window`-scoped surface.
// These helpers exist only during the migration; once everything is
// module-scoped we delete this file.

export function exposeLegacyVar<T>(
  name: string,
  getValue: () => T,
  setValue?: (value: T) => void
): void {
  try {
    Object.defineProperty(window, name, {
      configurable: true,
      get: getValue,
      set: setValue || (() => undefined),
    });
  } catch {
    /* legacy browsers / locked-down envs — ignore */
  }
}

export function publishLegacyGlobals(bindings: Record<string, unknown>): void {
  Object.keys(bindings || {}).forEach((key) => {
    (window as unknown as Record<string, unknown>)[key] = bindings[key];
  });
}
