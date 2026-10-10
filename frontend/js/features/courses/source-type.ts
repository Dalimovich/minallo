// Heuristic file-type classifier for uploaded course materials.
// Used for RAG source_type so retrieval can prefer the right kind of chunk
// (solutions for "how do I solve this", lectures for "what is X", etc.).
//
// Order matters: solution wins over exercise (a "Lösungen zu Aufgabe 3.pdf"
// is a solution, not an exercise), and summary/notes win over lecture.
export function guessSourceType(fileName: string): string {
  const n = fileName.toLowerCase();

  if (/lösung|loesung|musterlösung|musterloesung|solution|lsg/.test(n)) return 'solution';

  if (
    /aufgabe|übung|uebung|exercise|tutorium|tutorial|hausaufgabe|hausuebung|hausübung/.test(n) ||
    /(^|[^a-z])blatt(\b|[_\-0-9])/.test(n) ||
    /(^|[^a-z])(üb|ub|ue)bl/.test(n) ||
    /(^|[^a-z])ha[_\-\s]?\d/.test(n) ||
    /(^|[^a-z])ag_/.test(n)
  ) return 'exercise';

  if (/klausur|altklausur|prüfung|pruefung|exam|midterm|final/.test(n)) return 'exam';

  if (
    /formelzettel|formelsammlung|formelblatt|formel|formula|cheatsheet|cheat\s*sheet|merkblatt|zusammenfassung|summary|überblick|ueberblick/.test(n)
  ) return 'summary';

  if (/notes?|notiz|mitschrift/.test(n)) return 'notes';

  return 'lecture';
}
