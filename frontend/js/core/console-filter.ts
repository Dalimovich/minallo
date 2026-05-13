// Suppress noisy warnings from third-party libs (pdf.js mainly).

export function initConsoleFilter(): void {
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const sup = ['fake worker', 'TT:', 'undefined function', 'scale-factor'];

  function shouldSuppress(args: IArguments | unknown[]): boolean {
    const m = Array.prototype.join.call(args, ' ');
    return sup.some((s) => m.indexOf(s) !== -1);
  }

  console.warn = function (...args: unknown[]): void {
    if (shouldSuppress(args)) return;
    origWarn(...args);
  };
  console.error = function (...args: unknown[]): void {
    if (shouldSuppress(args)) return;
    origError(...args);
  };
}
