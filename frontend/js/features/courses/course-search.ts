import type { LegacyCourse } from '../../../globals.js';
import { listSuggestions, submitSuggestion } from '../../services/suggestions-service.js';

interface Subject {
  name: string;
  short: string;
  cat?: string;
}

// Per-major cache of crowd-approved course names. Filled the first time a
// user with that major opens the search dropdown.
const _courseSuggestions: Record<string, Subject[]> = {};
const _courseSuggestionsLoading: Record<string, boolean> = {};

async function _loadCourseSuggestions(major: string): Promise<Subject[]> {
  const key = major || '*';
  if (_courseSuggestions[key]) return _courseSuggestions[key];
  if (_courseSuggestionsLoading[key]) return [];
  _courseSuggestionsLoading[key] = true;
  try {
    const items = await listSuggestions('course', key);
    _courseSuggestions[key] = items.map((i) => ({
      name: i.value,
      short: i.value.slice(0, 8),
      cat: '_crowd',
    }));
  } catch {
    _courseSuggestions[key] = [];
  } finally {
    _courseSuggestionsLoading[key] = false;
  }
  return _courseSuggestions[key];
}

export interface CourseSearchContext {
  getUserUniversity: () => string;
  getUserUniversityName: () => string;
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

  function _runSearch(): void {
    selectedSubject = null;
    const q = inp!.value.trim().toLowerCase();
    if (!q) {
      drop!.style.display = 'none';
      return;
    }
    const userMajor = context.getUserMajor();
    const userVertiefung = context.getUserVertiefung();
    const subjectList = context.getSubjectList();
    // Kick off the crowd-suggestion fetch in the background. When it lands,
    // re-run the dropdown so newly-loaded entries become visible mid-typing.
    const crowdReady = !!_courseSuggestions[userMajor || '*'];
    if (!crowdReady) {
      void _loadCourseSuggestions(userMajor).then((loaded) => {
        if (loaded.length && inp!.value.trim().toLowerCase() === q) _runSearch();
      });
    }
    const crowd = _courseSuggestions[userMajor || '*'] || [];
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
    // Append crowd matches that aren't already covered by the static list.
    const seen = new Set(matches.map((m) => m.name.toLowerCase()));
    crowd
      .filter((c) => c.name.toLowerCase().includes(q) && !seen.has(c.name.toLowerCase()))
      .forEach((c) => matches.push(c));
    showDrop(matches.slice(0, 10));
  }

  inp.addEventListener('input', _runSearch);

  inp.addEventListener('blur', () => {
    setTimeout(() => {
      drop.style.display = 'none';
    }, 150);
  });

  function addCourse(): void {
    const name = inp!.value.trim();
    if (!name) return;
    const subject: Subject = selectedSubject || { name, short: name.slice(0, 8) };
    // Crowd-source the dropdown: if the user typed a name that isn't part of
    // the static subject catalog for their major, submit it. Once ≥ 5 users
    // submit the same name it auto-approves and shows up for everyone.
    const userMajor = context.getUserMajor();
    const subjectList = context.getSubjectList();
    const inStatic = subjectList.some(
      (s) => s.name.toLowerCase() === subject.name.toLowerCase()
    );
    if (!inStatic) {
      void submitSuggestion('course', userMajor || '*', subject.name, {
        university: context.getUserUniversity(),
        universityName: context.getUserUniversityName(),
        major: userMajor,
        vertiefung: context.getUserVertiefung(),
      });
    }
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
