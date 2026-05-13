interface LoungeStats {
  studyMinutes: number;
  filesOpened: string[];
  coursesStudied: string[];
  aiMessages: number;
  gamesPlayed: number;
  streak: number;
  lastDate: string;
  recentFiles: Array<{ name: string; course?: string; ts: number }>;
}

interface ResetBtn extends HTMLButtonElement {
  _wired?: boolean;
}

export function initStudyLounge(): void {
  const STATS_KEY = 'ss_stats';
  let studyTimer: ReturnType<typeof setInterval> | null = null;

  function loadStats(): Partial<LoungeStats> {
    try {
      return JSON.parse(localStorage.getItem(STATS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function saveStats(stats: LoungeStats): void {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch { /* quota */ }
  }

  function getStats(): LoungeStats {
    const defaults: LoungeStats = {
      studyMinutes: 0,
      filesOpened: [],
      coursesStudied: [],
      aiMessages: 0,
      gamesPlayed: 0,
      streak: 0,
      lastDate: '',
      recentFiles: [],
    };
    const stats = loadStats() as Partial<LoungeStats>;
    return { ...defaults, ...stats } as LoungeStats;
  }

  function touchStreak(): void {
    const stats = getStats();
    const today = new Date().toISOString().slice(0, 10);
    if (stats.lastDate === today) return;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    stats.streak = stats.lastDate === yesterday ? (stats.streak || 0) + 1 : 1;
    stats.lastDate = today;
    saveStats(stats);
  }

  function timeAgo(ts?: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  function renderCourseChips(stats: LoungeStats): void {
    const chips = document.getElementById('loungeCourseChips');
    if (!chips) return;
    chips.replaceChildren();
    if (!stats.coursesStudied.length) {
      const empty = document.createElement('div');
      empty.className = 'lounge-empty-msg';
      empty.textContent = 'No courses yet - open a subject to get started';
      chips.appendChild(empty);
      return;
    }
    stats.coursesStudied.forEach((courseName) => {
      const chip = document.createElement('div');
      chip.className = 'lounge-course-chip';
      chip.textContent = courseName;
      chips.appendChild(chip);
    });
  }

  function renderRecentFiles(stats: LoungeStats): void {
    const list = document.getElementById('loungeRecentList');
    if (!list) return;
    list.replaceChildren();
    if (!stats.recentFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'lounge-empty-msg';
      empty.textContent = 'No files opened yet';
      list.appendChild(empty);
      return;
    }
    stats.recentFiles.forEach((recent) => {
      const item = document.createElement('div');
      item.className = 'lounge-recent-item';
      const icon = document.createElement('div');
      icon.className = 'lounge-recent-item-icon';
      icon.textContent = 'PDF';
      const name = document.createElement('div');
      name.className = 'lounge-recent-item-name';
      name.textContent = recent.name || '';
      const meta = document.createElement('div');
      meta.className = 'lounge-recent-item-course';
      const ago = timeAgo(recent.ts);
      meta.textContent = recent.course ? recent.course + (ago ? ' · ' + ago : '') : ago;
      item.append(icon, name, meta);
      list.appendChild(item);
    });
  }

  function loungeRender(): void {
    const stats = getStats();
    const hours = Math.floor((stats.studyMinutes || 0) / 60);
    const minutes = (stats.studyMinutes || 0) % 60;
    const hoursStr = hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm';

    const el = document.getElementById('lsHours');
    if (el) el.textContent = hoursStr;
    const el2 = document.getElementById('lsHoursSub');
    if (el2) {
      el2.textContent =
        hours > 0
          ? hours + ' hour' + (hours !== 1 ? 's' : '') +
            (minutes ? ' ' + minutes + 'm' : '') + ' total'
          : minutes + ' min total';
    }

    const filesCount = stats.filesOpened.length;
    const filesEl = document.getElementById('lsFiles');
    if (filesEl) filesEl.textContent = String(filesCount);
    const filesSub = document.getElementById('lsFilesSub');
    if (filesSub) filesSub.textContent = filesCount + ' unique PDF' + (filesCount !== 1 ? 's' : '');

    const coursesCount = stats.coursesStudied.length;
    const coursesEl = document.getElementById('lsCourses');
    if (coursesEl) coursesEl.textContent = String(coursesCount);
    const coursesSub = document.getElementById('lsCoursesSub');
    if (coursesSub) {
      coursesSub.textContent = coursesCount + ' subject' + (coursesCount !== 1 ? 's' : '');
    }

    const aiEl = document.getElementById('lsAI');
    if (aiEl) aiEl.textContent = String(stats.aiMessages || 0);

    const noteCards = document.querySelectorAll('#lnContent .ln-card');
    const notesEl = document.getElementById('lsNotes');
    if (notesEl) notesEl.textContent = String(noteCards.length);

    const gamesEl = document.getElementById('lsGames');
    if (gamesEl) gamesEl.textContent = String(stats.gamesPlayed || 0);

    const streakEl = document.getElementById('loungeStreakVal');
    if (streakEl) streakEl.textContent = String(stats.streak || 0);
    const streakMsg = document.getElementById('loungeStreakMsg');
    if (streakMsg) {
      const streak = stats.streak || 0;
      streakMsg.textContent =
        streak === 0
          ? 'Start studying today to begin your streak!'
          : streak === 1
            ? 'Great start - come back tomorrow!'
            : streak < 7
              ? 'Keep it up, ' + streak + ' days strong!'
              : 'Amazing! ' + streak + ' day streak';
    }

    renderCourseChips(stats);
    renderRecentFiles(stats);

    const resetBtn = document.getElementById('loungeResetBtn') as ResetBtn | null;
    if (resetBtn && !resetBtn._wired) {
      resetBtn._wired = true;
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset all study stats? This cannot be undone.')) {
          localStorage.removeItem(STATS_KEY);
          loungeRender();
        }
      });
    }
  }

  window._statsTrackFile = function (fileName: string, courseName?: string): void {
    const stats = getStats();
    touchStreak();
    if (fileName && stats.filesOpened.indexOf(fileName) < 0) stats.filesOpened.push(fileName);
    if (courseName && stats.coursesStudied.indexOf(courseName) < 0) {
      stats.coursesStudied.push(courseName);
    }
    stats.recentFiles = (stats.recentFiles || []).filter((r) => r.name !== fileName);
    stats.recentFiles.unshift({ name: fileName, course: courseName || '', ts: Date.now() });
    if (stats.recentFiles.length > 10) stats.recentFiles = stats.recentFiles.slice(0, 10);
    saveStats(stats);
    if (studyTimer) clearInterval(studyTimer);
    studyTimer = setInterval(() => {
      const next = getStats();
      next.studyMinutes = (next.studyMinutes || 0) + 1;
      saveStats(next);
    }, 60000);
  };

  window._statsStopFile = function (): void {
    if (studyTimer) {
      clearInterval(studyTimer);
      studyTimer = null;
    }
  };

  window._statsTrackAI = function (): void {
    const stats = getStats();
    stats.aiMessages = (stats.aiMessages || 0) + 1;
    saveStats(stats);
    touchStreak();
  };

  window._statsTrackGame = function (): void {
    const stats = getStats();
    stats.gamesPlayed = (stats.gamesPlayed || 0) + 1;
    saveStats(stats);
  };

  window._loungeRender = loungeRender;
}
