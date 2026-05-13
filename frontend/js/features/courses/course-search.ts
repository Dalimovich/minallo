import type { LegacyCourse } from '../../../globals.js';

interface Subject {
  name: string;
  short: string;
  cat?: string;
}

export interface CourseSearchContext {
  getUserMajor: () => string;
  getUserVertiefung: () => string;
  getSubjectList: () => Subject[];
  getSems: () => Record<string, { courses: LegacyCourse[] }>;
  getActiveSemesterId: () => string;
  saveUserCourses: () => void;
  renderCourses: () => void;
}

export function initCourseSearch(context: CourseSearchContext): void {
  const inp = document.getElementById('courseSearchInput') as HTMLInputElement | null;
  const drop = document.getElementById('courseSearchDrop');
  const addBtn = document.getElementById('courseAddBtn');
  if (!inp || !drop || !addBtn) return;

  let selectedSubject: Subject | null = null;

  function getDropBg(): string {
    return document.body.classList.contains('night')
      ? 'rgba(13,20,40,.97)'
      : 'rgba(240,245,255,.98)';
  }

  function showDrop(items: Subject[]): void {
    if (!items.length) {
      drop!.style.display = 'none';
      return;
    }
    drop!.style.background = getDropBg();
    drop!.innerHTML = '';
    items.forEach((s) => {
      const opt = document.createElement('div');
      opt.textContent = s.name;
      opt.style.cssText =
        'padding:9px 14px;cursor:pointer;font-size:.88rem;border-bottom:1px solid rgba(37,99,235,.1);color:inherit';
      opt.addEventListener('mouseenter', () => {
        opt.style.background = 'rgba(37,99,235,.12)';
      });
      opt.addEventListener('mouseleave', () => {
        opt.style.background = '';
      });
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectedSubject = s;
        inp!.value = s.name;
        drop!.style.display = 'none';
      });
      drop!.appendChild(opt);
    });
    drop!.style.display = 'block';
  }

  inp.addEventListener('input', () => {
    selectedSubject = null;
    const q = inp.value.trim().toLowerCase();
    if (!q) {
      drop.style.display = 'none';
      return;
    }
    const userMajor = context.getUserMajor();
    const userVertiefung = context.getUserVertiefung();
    const subjectList = context.getSubjectList();
    const isMB = !userMajor || userMajor === 'Maschinenbau';
    const isET = userMajor === 'Elektrotechnik und Informationstechnik';
    let matches: Subject[];
    if (isMB) {
      matches = subjectList.filter((s) => {
        const inCat = s.cat === 'grundlagen' || s.cat === userVertiefung;
        return inCat && s.name.toLowerCase().includes(q);
      });
    } else if (isET) {
      matches = subjectList.filter((s) => {
        const inCat = s.cat === 'et-grundlagen' || s.cat === userVertiefung;
        return inCat && s.name.toLowerCase().includes(q);
      });
    } else {
      const primary = subjectList.filter(
        (s) => s.cat === userMajor && s.name.toLowerCase().includes(q)
      );
      const secondary = subjectList.filter(
        (s) => s.cat !== userMajor && s.name.toLowerCase().includes(q)
      );
      matches = primary.concat(secondary);
    }
    showDrop(matches.slice(0, 10));
  });

  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });

  function addCourse(): void {
    const name = inp!.value.trim();
    if (!name) return;
    const subject: Subject = selectedSubject || { name, short: name.slice(0, 8) };
    const sems = context.getSems();
    const sem = sems[context.getActiveSemesterId()];
    if (!sem) return;
    if (sem.courses.find((c) => c.name.toLowerCase() === subject.name.toLowerCase())) {
      inp!.value = '';
      selectedSubject = null;
      drop!.style.display = 'none';
      return;
    }
    sem.courses.push({
      id: 'uc_' + Date.now(),
      name: subject.name,
      short: subject.short,
      meta: '',
      files: [],
    } as LegacyCourse);
    context.saveUserCourses();
    context.renderCourses();
    inp!.value = '';
    selectedSubject = null;
    drop!.style.display = 'none';
  }

  addBtn.addEventListener('click', addCourse);
  inp.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') addCourse();
  });
}
