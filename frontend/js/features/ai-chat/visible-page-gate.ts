export function shouldAttachVisiblePdfPage(question: string): boolean {
  return (
    // Deictic requests are about what is currently on screen.
    /\b(this|that|these|those|shown|above|below|here|current|visible)\b/i.test(question) ||
    /\b(dies(?:e[rsnm]?)?|das hier|hier|oben|unten|gezeigt|aktuell)\b/i.test(question) ||
    // Answer/solution/marking claims require the page layout, not flattened text.
    /\b(prof(?:essor)?|solution|answer|correct|marked|selected|checked|choice|option|checkbox|worked|solved)\b/i.test(question) ||
    /\b(prof(?:essor)?|l[oö]sung|antwort|richtig|markiert|angekreuzt|ausgew[aä]hlt|rechnung|gel[oö]st)\b/i.test(question) ||
    // Short exercise/calculation prompts often omit "this" but still refer to
    // the visible task, whose diagram and multiple-choice marks are spatial.
    /\b(calculate|compute|solve|result|how many|exercise|task|problem|question)\b/i.test(question) ||
    /\b(berechne|rechnen|l[oö]se|ergebnis|wie viele|aufgabe|frage|bearbeitungsschritte)\b/i.test(question)
  );
}
