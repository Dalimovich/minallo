// Minallo notifications — lightweight, per-user, localStorage-backed.
//
// The notifications section (#psec-notifications) is static markup in
// portal.html: a two-column layout with a notification inbox on the left
// (header + All/Unread/Projects/Files tabs + search + #notifList) and pinned
// courses + a "selected notification" details panel on the right. This module
// owns the data + rendering and exposes `window.addNotification(...)` so other
// flows (e.g. onboarding's welcome message) can push notifications.
//
// Storage:
//  - `ss_notifs_<uid>`         = Notif[] (newest first, capped)
//  - `ss_pinned_courses_<uid>` = string[] (pinned course ids, capped)
// Per-device for now; can later be backed by Supabase tables for cross-device
// sync without changing callers.

import { computeCourseProgress } from '../courses/courses-render.js';
import type { LegacyCourse } from '../../../globals.js';

type NotifType = 'system' | 'project' | 'file';

interface Notif {
  id: string;
  title: string;
  body?: string;
  icon?: string;
  ts: number;
  read?: boolean;
  // Used for the Projects/Files tabs and the search filter. Defaults to
  // 'system' for notifications that don't belong to either.
  type?: NotifType;
  // Short label for where this notification "belongs", e.g. a course name.
  // Shown in the selected-notification panel and matched by search.
  context?: string;
  // Shown as the "current action" when this notification is selected.
  actionLabel?: string;
}

interface AddNotifInput {
  title: string;
  body?: string;
  icon?: string;
  type?: NotifType;
  context?: string;
  actionLabel?: string;
  // When set, the notification is only added once per user (re-adds are
  // ignored). Used so the welcome message isn't duplicated on re-login.
  dedupeKey?: string;
}

const MAX_NOTIFS = 100;
const MAX_PINNED = 4;
const PREVIEW_NOTIFICATION_EMAIL = 'medalimariam@gmail.com';
const PREVIEW_NOTIFICATION_DEDUPE_KEY = 'preview-notification-medalimariam-20260613';
type Tab = 'all' | 'unread' | 'projects' | 'files';
let _tab: Tab = 'all';
let _search = '';
let _selectedId: string | null = null;
let _pinEditorOpen = false;
let _previewNotificationBound = false;

function _uid(): string {
  try {
    return localStorage.getItem('ss_last_uid') || '';
  } catch {
    return '';
  }
}

function _key(): string {
  return 'ss_notifs_' + _uid();
}

function _pinKey(): string {
  return 'ss_pinned_courses_' + _uid();
}

function _load(): Notif[] {
  try {
    const raw = localStorage.getItem(_key());
    const list = raw ? (JSON.parse(raw) as Notif[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function _save(list: Notif[]): void {
  try {
    localStorage.setItem(_key(), JSON.stringify(list.slice(0, MAX_NOTIFS)));
  } catch {
    /* quota — ignore */
  }
}

function _loadPins(): string[] {
  try {
    const raw = localStorage.getItem(_pinKey());
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function _savePins(ids: string[]): void {
  try {
    localStorage.setItem(_pinKey(), JSON.stringify(ids.slice(0, MAX_PINNED)));
  } catch {
    /* quota — ignore */
  }
}

function _esc(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _t(key: string, fallback: string): string {
  const w = window as unknown as { _t?: (k: string) => string };
  if (typeof w._t === 'function') {
    const v = w._t(key);
    if (v && v !== key) return v;
  }
  return fallback;
}

function _relTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return _t('notif_now', 'Just now');
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd';
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return d + 'd';
  }
}

function _unreadCount(list: Notif[]): number {
  return list.reduce((n, x) => (x.read ? n : n + 1), 0);
}

function _updateBadge(unread: number): void {
  const item = document.getElementById('psbNotifications');
  if (!item) return;
  let badge = item.querySelector('.sb-badge') as HTMLElement | null;
  if (unread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sb-badge';
      item.appendChild(badge);
    }
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.display = '';
  } else if (badge) {
    badge.style.display = 'none';
  }
}

function _matchesTab(x: Notif, tab: Tab): boolean {
  if (tab === 'unread') return !x.read;
  if (tab === 'projects') return x.type === 'project';
  if (tab === 'files') return x.type === 'file';
  return true;
}

function _matchesSearch(x: Notif, q: string): boolean {
  if (!q) return true;
  const hay = [x.title, x.body, x.type, x.context]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

export function renderNotifications(): void {
  const list = _load();
  const unread = _unreadCount(list);
  _updateBadge(unread);

  const countEl = document.getElementById('notifCount');
  if (countEl) countEl.textContent = String(unread);

  const listEl = document.getElementById('notifList');
  if (!listEl) return;

  const q = _search.trim().toLowerCase();
  const shown = list.filter((x) => _matchesTab(x, _tab) && _matchesSearch(x, q));

  if (shown.length === 0) {
    const isFiltered = q.length > 0;
    listEl.innerHTML =
      '<div class="notif-empty">' +
      '<div class="notif-empty-icon">🔔</div>' +
      '<div class="notif-empty-title">' +
      (isFiltered
        ? _esc(_t('notif_empty_search_title', 'No matching notifications'))
        : _esc(_t('notif_empty_title', "You're all caught up!"))) +
      '</div>' +
      '<div class="notif-empty-sub">' +
      (isFiltered
        ? _esc(_t('notif_empty_search_sub', 'Try a different search term.'))
        : _esc(_t('notif_empty_sub', 'New notifications will appear here'))) +
      '</div>' +
      '</div>';
    return;
  }

  listEl.innerHTML = shown
    .map((x) => {
      const classes = ['notif-item'];
      if (!x.read) classes.push('unread');
      if (x.id === _selectedId) classes.push('selected');
      return (
        '<div class="' +
        classes.join(' ') +
        '" data-id="' +
        _esc(x.id) +
        '">' +
        '<div class="notif-item-icon">' +
        _esc(x.icon || '🔔') +
        '</div>' +
        '<div class="notif-item-main">' +
        '<div class="notif-item-title">' +
        _esc(x.title) +
        '</div>' +
        (x.body ? '<div class="notif-item-text">' + _esc(x.body) + '</div>' : '') +
        '<div class="notif-item-time">' +
        _esc(_relTime(x.ts)) +
        '</div>' +
        '</div>' +
        '</div>'
      );
    })
    .join('');

  renderSelected(list);
}

function renderSelected(list: Notif[]): void {
  const actionEl = document.getElementById('notifSelectedAction');
  const areaEl = document.getElementById('notifSelectedArea');
  if (!actionEl || !areaEl) return;

  const selected = _selectedId ? list.find((x) => x.id === _selectedId) : undefined;
  if (!selected) {
    actionEl.textContent = _t('notif_none_selected', 'No notification selected');
    areaEl.textContent = _t('notif_select_item', 'Select an item from the inbox');
    return;
  }

  actionEl.textContent = selected.actionLabel || selected.title;
  areaEl.textContent = selected.context || _t('notif_general_area', 'General');
}

export function addNotification(input: AddNotifInput): void {
  if (!input || !input.title) return;
  if (!_uid()) return;
  const list = _load();
  if (input.dedupeKey && list.some((x) => x.id.indexOf(input.dedupeKey + ':') === 0)) return;
  const item: Notif = {
    id:
      (input.dedupeKey ? input.dedupeKey + ':' : '') +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7),
    title: input.title,
    body: input.body || '',
    icon: input.icon || '🔔',
    ts: Date.now(),
    read: false,
    type: input.type || 'system',
    context: input.context || '',
    actionLabel: input.actionLabel || '',
  };
  list.unshift(item);
  _save(list);
  renderNotifications();
}

function seedPreviewNotificationForOwner(): void {
  const email = (window._currentUser?.email || '').trim().toLowerCase();
  if (email !== PREVIEW_NOTIFICATION_EMAIL) return;
  addNotification({
    dedupeKey: PREVIEW_NOTIFICATION_DEDUPE_KEY,
    title: 'Preview notification',
    body: 'This is how a new unread Minallo notification appears in your inbox.',
    icon: '🔔',
    type: 'system',
    context: 'Minallo Inbox',
    actionLabel: 'Review notification preview'
  });
}

function bindPreviewNotificationSeed(): void {
  if (_previewNotificationBound) return;
  _previewNotificationBound = true;
  seedPreviewNotificationForOwner();
  window.addEventListener('ss-ready', seedPreviewNotificationForOwner, { once: true });
  document.addEventListener('minallo:auth:signed-in', seedPreviewNotificationForOwner);
  document.addEventListener('minallo:auth:entered', seedPreviewNotificationForOwner);
  if (window.Minallo) {
    window.Minallo.on('auth:signed-in', seedPreviewNotificationForOwner);
    window.Minallo.on('auth:entered', seedPreviewNotificationForOwner);
  }
}

function markAllRead(): void {
  const list = _load().map((x) => ({ ...x, read: true }));
  _save(list);
  renderNotifications();
}

function selectNotification(id: string): void {
  const list = _load();
  const item = list.find((x) => x.id === id);
  if (!item) return;
  _selectedId = id;
  if (!item.read) {
    item.read = true;
    _save(list);
  }
  renderNotifications();
}

// --- Pinned courses -------------------------------------------------------

function _allCourses(): LegacyCourse[] {
  const w = window as unknown as { SEMS?: Record<string, { courses: LegacyCourse[] }> };
  const sems = w.SEMS || {};
  const out: LegacyCourse[] = [];
  Object.keys(sems).forEach((semId) => {
    const courses = sems[semId] && sems[semId].courses;
    if (Array.isArray(courses)) out.push(...courses);
  });
  return out;
}

function _courseFileCount(course: LegacyCourse): number {
  let n = Array.isArray(course.files) ? course.files.length : 0;
  if (Array.isArray(course.userFolders)) {
    course.userFolders.forEach((folder) => {
      if (Array.isArray(folder.files)) n += folder.files.length;
    });
  }
  return n;
}

function renderPinnedCourses(): void {
  const grid = document.getElementById('notifPinnedGrid');
  if (!grid) return;
  const panel = grid.closest<HTMLElement>('.notif-pinned');

  const courses = _allCourses();
  const byId = new Map(courses.map((c) => [c.id, c]));
  const pinned = _loadPins()
    .map((id) => byId.get(id))
    .filter((c): c is LegacyCourse => !!c);

  if (pinned.length === 0) {
    grid.innerHTML = '';
    grid.hidden = true;
    panel?.classList.add('notif-pinned-empty-state');
    return;
  }
  grid.hidden = false;
  panel?.classList.remove('notif-pinned-empty-state');

  grid.innerHTML = pinned
    .map((course) => {
      const total = _courseFileCount(course);
      const progress = computeCourseProgress(course.id, total);
      return (
        '<div class="notif-pin-card" data-course-id="' +
        _esc(course.id) +
        '">' +
        '<div class="notif-pin-card-top">' +
        '<div class="notif-pin-card-name">' +
        _esc(course.name || '') +
        '</div>' +
        (course.short ? '<div class="notif-pin-card-meta">' + _esc(course.short) + '</div>' : '') +
        '</div>' +
        '<div class="notif-pin-stats">' +
        '<div class="notif-pin-stat">' +
        '<div class="notif-pin-stat-value">' +
        progress.files +
        '</div>' +
        '<div class="notif-pin-stat-label">' +
        _esc(_t('notif_pin_files', 'Files')) +
        '</div>' +
        '</div>' +
        '<div class="notif-pin-stat">' +
        '<div class="notif-pin-stat-value">' +
        progress.readingProgress +
        '%</div>' +
        '<div class="notif-pin-stat-label">' +
        _esc(_t('notif_pin_study', 'Study')) +
        '</div>' +
        '</div>' +
        '<div class="notif-pin-stat">' +
        '<div class="notif-pin-stat-value">' +
        progress.studiedFiles +
        '</div>' +
        '<div class="notif-pin-stat-label">' +
        _esc(_t('notif_pin_tasks', 'Tasks')) +
        '</div>' +
        '</div>' +
        '<div class="notif-pin-stat">' +
        '<div class="notif-pin-stat-value">' +
        progress.aiSessions +
        '</div>' +
        '<div class="notif-pin-stat-label">' +
        _esc(_t('notif_pin_cards', 'Cards')) +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="notif-pin-info">' +
        '<span class="notif-pin-info-label">' +
        _esc(_t('notif_pin_last_studied', 'Last studied')) +
        '</span>' +
        '<span class="notif-pin-info-value">' +
        _esc(progress.lastOpened) +
        '</span>' +
        '</div>' +
        '<a class="notif-pin-open" href="#" data-course-id="' +
        _esc(course.id) +
        '">' +
        _esc(_t('notif_pin_open', 'Open course')) +
        ' &rarr;</a>' +
        '</div>'
      );
    })
    .join('');
}

function renderPinEditor(): void {
  const editor = document.getElementById('notifPinEditor');
  if (!editor) return;
  if (!_pinEditorOpen) {
    editor.hidden = true;
    editor.innerHTML = '';
    return;
  }

  const courses = _allCourses();
  const pinned = new Set(_loadPins());
  editor.hidden = false;
  editor.innerHTML = courses
    .map((course) => {
      const checked = pinned.has(course.id) ? ' checked' : '';
      return (
        '<label class="notif-pin-option">' +
        '<input type="checkbox" data-course-id="' +
        _esc(course.id) +
        '"' +
        checked +
        ' />' +
        '<span>' +
        _esc(course.name || course.id) +
        '</span>' +
        '</label>'
      );
    })
    .join('');
}

function togglePin(courseId: string, checked: boolean): void {
  let pins = _loadPins();
  if (checked) {
    if (!pins.includes(courseId)) pins = [...pins, courseId].slice(0, MAX_PINNED);
  } else {
    pins = pins.filter((id) => id !== courseId);
  }
  _savePins(pins);
  renderPinnedCourses();
}

export function initNotifications(): void {
  const markAll = document.getElementById('notifMarkAll');
  if (markAll && !markAll.dataset.bound) {
    markAll.dataset.bound = '1';
    markAll.addEventListener('click', markAllRead);
  }

  document.querySelectorAll<HTMLElement>('.notif-tab').forEach((tabEl) => {
    if (tabEl.dataset.bound) return;
    tabEl.dataset.bound = '1';
    tabEl.addEventListener('click', () => {
      const tab = tabEl.dataset.tab;
      _tab = tab === 'unread' || tab === 'projects' || tab === 'files' ? tab : 'all';
      document.querySelectorAll('.notif-tab').forEach((x) => x.classList.remove('active'));
      tabEl.classList.add('active');
      renderNotifications();
    });
  });

  const searchEl = document.getElementById('notifSearch') as HTMLInputElement | null;
  if (searchEl && !searchEl.dataset.bound) {
    searchEl.dataset.bound = '1';
    searchEl.addEventListener('input', () => {
      _search = searchEl.value || '';
      renderNotifications();
    });
  }

  const listEl = document.getElementById('notifList');
  if (listEl && !listEl.dataset.bound) {
    listEl.dataset.bound = '1';
    listEl.addEventListener('click', (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>('.notif-item');
      if (item && item.dataset.id) selectNotification(item.dataset.id);
    });
  }

  const editPinsBtn = document.getElementById('notifEditPins');
  if (editPinsBtn && !editPinsBtn.dataset.bound) {
    editPinsBtn.dataset.bound = '1';
    editPinsBtn.addEventListener('click', () => {
      _pinEditorOpen = !_pinEditorOpen;
      renderPinEditor();
    });
  }

  const editor = document.getElementById('notifPinEditor');
  if (editor && !editor.dataset.bound) {
    editor.dataset.bound = '1';
    editor.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      if (input && input.dataset.courseId) togglePin(input.dataset.courseId, input.checked);
    });
  }

  const pinnedGrid = document.getElementById('notifPinnedGrid');
  if (pinnedGrid && !pinnedGrid.dataset.bound) {
    pinnedGrid.dataset.bound = '1';
    pinnedGrid.addEventListener('click', (ev) => {
      const link = (ev.target as HTMLElement).closest<HTMLElement>('.notif-pin-open');
      if (!link || !link.dataset.courseId) return;
      ev.preventDefault();
      const course = _allCourses().find((c) => c.id === link.dataset.courseId);
      const w = window as unknown as { openCourse?: (c: LegacyCourse) => void };
      if (course && typeof w.openCourse === 'function') w.openCourse(course);
    });
  }

  // Opening the section keeps the list/pins/badge in sync.
  const navItem = document.getElementById('psbNotifications');
  if (navItem && !navItem.dataset.notifBound) {
    navItem.dataset.notifBound = '1';
    navItem.addEventListener('click', () => {
      renderNotifications();
      renderPinnedCourses();
    });
  }

  const w = window as unknown as {
    addNotification?: typeof addNotification;
    renderNotifications?: typeof renderNotifications;
  };
  w.addNotification = addNotification;
  w.renderNotifications = renderNotifications;

  bindPreviewNotificationSeed();
  renderNotifications();
  renderPinnedCourses();
}
