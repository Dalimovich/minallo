// Bridge between TS modules and the legacy `window`-scoped surface.
// These helpers exist only during the migration; once everything is
// module-scoped we delete this file.
export function exposeLegacyVar(name, getValue, setValue) {
    try {
        Object.defineProperty(window, name, {
            configurable: true,
            get: getValue,
            set: setValue || (() => undefined),
        });
    }
    catch {
        /* legacy browsers / locked-down envs — ignore */
    }
}
export function publishLegacyGlobals(bindings) {
    Object.keys(bindings || {}).forEach((key) => {
        window[key] = bindings[key];
    });
}
//# sourceMappingURL=globals.js.map