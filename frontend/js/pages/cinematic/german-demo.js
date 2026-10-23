const $ = (s, ctx = document) => ctx.querySelector(s),
  $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];
$$('.gpace-choice').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.gpace-choice').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    const levels = {
      A2: [
        'A2 · Everyday conversations',
        'Practice asking for directions and describing your routine with simple connecting words.'
      ],
      B1: [
        'B1 · Connected explanations',
        'Build longer sentences with weil and obwohl, then practice short written responses.'
      ],
      C1: [
        'C1 · Nuanced arguments',
        'Practice summarizing complex texts, structuring arguments and choosing precise expressions.'
      ]
    };
    $('#gpace-heading').textContent = levels[b.dataset.level][0];
    $('#gpace-detail').textContent = levels[b.dataset.level][1];
  })
);
$$('#grammar-options button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#grammar-options button').forEach((x) => x.classList.remove('correct', 'wrong'));
    const good = b.dataset.correct === 'true';
    b.classList.add(good ? 'correct' : 'wrong');
    $('#grammar-feedback').textContent = good
      ? 'Correct! After weil, the conjugated verb goes to the end: weil ich müde bin.'
      : 'Not quite. Weil introduces a subordinate clause, so the conjugated verb belongs at the end: weil ich müde bin.';
  })
);
let translated = false;
$('#vocab-card').addEventListener('click', () => {
  translated = !translated;
  $('#vocab-front').lang = translated ? 'en' : 'de';
  $('#vocab-front').textContent = translated
    ? 'Where does the train depart?'
    : 'Wo fährt der Zug ab?';
  $('#vocab-sub').textContent = translated ? 'Tap to see German ↻' : 'Tap to reveal translation ↗';
});

const inputs = $$('#german-exam input');
inputs.forEach((el) =>
  el.addEventListener(
    'change',
    () => ($('#gexam-progress').textContent = inputs.filter((x) => x.checked).length + ' / 4')
  )
);

$$('[data-demo-control]').forEach((el) => (el.disabled = false));
