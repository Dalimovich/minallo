const $ = (s, ctx = document) => ctx.querySelector(s),
  $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];
// Active demo: actual JavaScript physics interaction with a fixed 2kg object.
const force = $('#force'),
  val = $('#force-value'),
  accel = $('#accel'),
  block = $('#demo-block'),
  arrow = $('#force-arrow');
function physics() {
  const f = Number(force.value);
  val.textContent = String(f);
  accel.textContent = (f / 2).toFixed(1);
  const dx = ((f - 2) / 18) * Math.min(130, block.parentElement.clientWidth - 90);
  block.style.setProperty('--block-left', dx + 'px');
  arrow.style.setProperty('--block-left', dx + 'px');
  arrow.textContent = `${f} N →`;
}
force.addEventListener('input', physics);
physics();
// Student tutoring demo: guided, clearly scripted explanations.
$$('[data-sample-question]').forEach((b) =>
  b.addEventListener('click', () => {
    $$('[data-answer]').forEach((p) => (p.hidden = p.dataset.answer !== b.dataset.sampleQuestion));
    $$('[data-sample-question]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  })
);
const flashItems = [
  ['What is the formula for net force?', 'F = m × a'],
  ['If force doubles and mass stays the same, what changes?', 'Acceleration doubles.'],
  ['Why do heavier objects need more force?', 'They have more inertia (more mass).']
];
let flashI = 0,
  flashBack = false;
const card = $('#demo-flashcard');
function renderFlash() {
  $('#demo-flash-text').textContent = flashItems[flashI][flashBack ? 1 : 0];
  $('.big-flash-label', card).textContent =
    'FLASHCARD ' + String(flashI + 1).padStart(2, '0') + ' / 03';
  $('.big-flash-hint', card).textContent = flashBack
    ? 'Answer · click to return ↻'
    : 'Question · click to reveal ↗';
}
function flip() {
  flashBack = !flashBack;
  renderFlash();
}
card.addEventListener('click', flip);
$('#flash-flip').addEventListener('click', flip);
$('#flash-next').addEventListener('click', () => {
  flashI = (flashI + 1) % flashItems.length;
  flashBack = false;
  renderFlash();
});
// Exam checklist progress, local-only
function checklist(selector, out) {
  const labels = $$(selector + ' input');
  const sync = () =>
    ($(out).textContent = labels.filter((x) => x.checked).length + ' / ' + labels.length);
  labels.forEach((x) => x.addEventListener('change', sync));
  sync();
}
checklist('#student-exam .exam-checklist', '#exam-progress');
$$('.pace-choice').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.pace-choice').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    const weak = b.dataset.outcome === 'struggle';
    $('#pace-icon').textContent = weak ? '↗' : '✓';
    $('#pace-heading').textContent = weak ? 'Review force diagrams' : 'Try an exam-style problem';
    $('#pace-detail').textContent = weak
      ? 'Go back to the explanation, then try one simpler practice question.'
      : 'You got the concept. Challenge yourself with a mixed problem and revisit it later.';
  })
);

$$('[data-demo-control]').forEach((el) => (el.disabled = false));
