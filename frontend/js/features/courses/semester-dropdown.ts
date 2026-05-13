export interface SemesterDropdownOptions {
  setActiveSemesterId: (id: string) => void;
  renderCourses: () => void;
}

export function initSemesterDropdown(options: SemesterDropdownOptions): void {
  const sdSemBtn = document.getElementById('sdSemBtn');
  const sdSemDD = document.getElementById('sdSemDD');
  const sdSemDot = document.getElementById('sdSemDot');
  const sdSemLabel = document.getElementById('sdSemLabel');
  const sdSemChev = document.getElementById('sdSemChev');
  if (!sdSemBtn || !sdSemDD || !sdSemDot || !sdSemLabel || !sdSemChev) return;

  let sdDdOpen = false;

  sdSemBtn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    sdDdOpen = !sdDdOpen;
    sdSemDD.classList.toggle('open', sdDdOpen);
    sdSemBtn.classList.toggle('open', sdDdOpen);
    sdSemChev.classList.toggle('up', sdDdOpen);
  });

  sdSemDD.querySelectorAll<HTMLElement>('.sem-opt').forEach((o) => {
    o.addEventListener('click', () => {
      const sid = o.getAttribute('data-sid');
      const col = o.getAttribute('data-col');
      if (sid) options.setActiveSemesterId(sid);
      sdSemLabel.textContent = (o.textContent || '').trim();
      if (col) sdSemDot.style.background = col;
      sdSemDD.querySelectorAll('.sem-opt').forEach((x) => x.classList.remove('sel'));
      o.classList.add('sel');
      sdDdOpen = false;
      sdSemDD.classList.remove('open');
      sdSemBtn.classList.remove('open');
      sdSemChev.classList.remove('up');
      options.renderCourses();
    });
  });

  document.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (sdDdOpen && target && !target.closest('#sdSemBtn') && !target.closest('#sdSemDD')) {
      sdDdOpen = false;
      sdSemDD.classList.remove('open');
      sdSemBtn.classList.remove('open');
      sdSemChev.classList.remove('up');
    }
  });
}
