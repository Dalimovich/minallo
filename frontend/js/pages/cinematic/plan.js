export function createPlan({ subject, challenge, deadline, duration, path }) {
  const german = path === 'german';
  const focus = {
    understand: german
      ? 'Review one grammar rule and write two examples'
      : 'Explain one core concept using your course sources',
    practice: german
      ? 'Write a short response, then check the grammar'
      : 'Answer practice questions before checking solutions',
    organize: german
      ? 'Choose one everyday topic and a small vocabulary set'
      : 'Choose a priority topic from your course material'
  }[challenge];
  const minutes = Number(duration);
  const first = Math.round(minutes * 0.5);
  const second = Math.round(minutes * 0.3);
  return {
    title: `Your ${subject.trim()} starting path`,
    description:
      Number(deadline) <= 7
        ? 'With a week or less, focus on the essentials and review mistakes each day. Avoid trying to cover everything at once.'
        : Number(deadline) <= 21
          ? 'Over the next three weeks, build understanding first, then mix practice with regular review.'
          : 'With more time, build a steady routine and revisit topics across several sessions.',
    tasks: [
      [focus, first],
      [
        german ? 'Recall useful vocabulary in context' : 'Check understanding with active recall',
        second
      ],
      [
        german
          ? 'Use one sentence aloud and review a mistake'
          : 'Review mistakes against the original source',
        minutes - first - second
      ]
    ]
  };
}

export function initPlan() {
  const form = document.getElementById('plan-form');
  if (!form) return;
  const result = document.getElementById('plan-result');
  form.querySelector('button[type="submit"]').disabled = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const subject = form.elements.subject;
    subject.setCustomValidity(
      subject.value.trim() ? '' : 'Please enter your subject or learning goal.'
    );
    if (!form.reportValidity()) return;
    const plan = createPlan({ ...Object.fromEntries(new FormData(form)), path: form.dataset.path });
    document.getElementById('result-title').textContent = plan.title;
    document.getElementById('result-desc').textContent = plan.description;
    const list = document.getElementById('result-tasks');
    list.replaceChildren(
      ...plan.tasks.map(([task, minutes]) => {
        const li = document.createElement('li');
        li.textContent = `${task} — ${minutes} minutes`;
        return li;
      })
    );
    form.hidden = true;
    result.hidden = false;
    result.focus();
  });
  form.elements.subject.addEventListener('input', () =>
    form.elements.subject.setCustomValidity('')
  );
  document.getElementById('restart').addEventListener('click', () => {
    result.hidden = true;
    form.hidden = false;
    form.elements.subject.focus();
  });
}
