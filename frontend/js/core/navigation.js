import { hideFilesView, showFilesView } from './panels.js';

var _activePortalSection = null;

export function setNavActive(id) {
  document.querySelectorAll('.psb').forEach(function (el) {
    el.classList.remove('on');
  });
  var el = document.getElementById(id);
  if (el) el.classList.add('on');
}

export function showPortalSection(sec) {
  var g = document.getElementById('psbGames');
  if (sec === 'games' && g && g.classList.contains('st-locked')) return;
  var _titles = {
    dashboard: 'Dashboard',
    notes: 'Lecture Notes',
    editor: 'Editor',
    profile: 'Profile',
    settings: 'Settings',
    subscription: 'Subscription',
    studip: 'Courses',
    chat: 'Chat',
    notifications: 'Notifications',
    games: 'Games',
    lounge: 'Study Lounge',
    aipage: 'Chatbot',
    german: 'Practice'
  };
  var ms = document.querySelector('#portal .main .main-scroll');
  var target = document.getElementById('psec-' + sec);
  var _fab = document.getElementById('addWidgetFab');
  var tt = document.getElementById('topTitle');

  function _revealTarget() {
    document.querySelectorAll('.portal-section').forEach(function (el) {
      el.style.display = 'none';
      el.classList.remove('psec-entering', 'psec-leaving');
    });
    if (!target) return;
    target.style.display =
      target.classList.contains('editor-portal-section') || sec === 'chat' ? 'flex' : 'block';
    target.classList.remove('psec-entering');
    void target.offsetWidth;
    target.classList.add('psec-entering');
    if (ms) ms.classList.toggle('editor-active', sec === 'editor' || sec === 'chat');
    if (tt) tt.textContent = _titles[sec] || sec;
    if (_fab) _fab.classList.toggle('visible', sec === 'dashboard');
    _activePortalSection = target;
  }

  var leaving = _activePortalSection;
  if (leaving && leaving !== target && leaving.style.display !== 'none') {
    leaving.classList.add('psec-leaving');
    setTimeout(_revealTarget, 170);
  } else {
    _revealTarget();
  }
}

export function showPortal() {
  if (typeof window._statsStopFile === 'function') window._statsStopFile();
  var portal = document.getElementById('portal');
  var alreadyVisible =
    portal.classList.contains('show') &&
    portal.style.display !== 'none' &&
    document.getElementById('app') &&
    document.getElementById('app').style.display === 'none';
  var studipVisible =
    document.getElementById('studipDash') &&
    document.getElementById('studipDash').style.display !== 'none';
  if (!alreadyVisible || studipVisible) {
    hideFilesView();
    portal.style.transition = 'none';
    portal.style.opacity = '0';
    portal.style.transform = 'scale(0.97)';
    portal.style.pointerEvents = 'none';
    portal.style.zIndex = '220';
    portal.classList.add('show');
    void portal.offsetWidth;
    portal.style.transition =
      'opacity 380ms cubic-bezier(0.22,1,0.36,1),transform 380ms cubic-bezier(0.22,1,0.36,1)';
    portal.style.opacity = '1';
    portal.style.transform = 'scale(1)';
    portal.style.pointerEvents = 'auto';
    setTimeout(function () {
      portal.style.zIndex = '';
      portal.style.opacity = '';
      portal.style.transition = '';
      portal.style.transform = '';
      portal.style.display = 'block';
    }, 400);
  } else {
    hideFilesView();
    portal.classList.add('show');
    portal.style.display = 'block';
  }
  try {
    var st = JSON.parse(localStorage.getItem('ss_state') || '{}');
    st.inApp = false;
    st.view = '';
    localStorage.setItem('ss_state', JSON.stringify(st));
  } catch (e) {}
}

export function showStudip() {
  hideFilesView();
  var portal = document.getElementById('portal');
  if (portal) {
    portal.classList.add('show');
    portal.style.display = 'block';
  }
  setNavActive('pcStudip');
  if (typeof window.showPortalSection === 'function') window.showPortalSection('courses');
  else showPortalSection('courses');
  if (typeof window.sdRenderCourses === 'function') window.sdRenderCourses();
  try {
    var st = JSON.parse(localStorage.getItem('ss_state') || '{}');
    st.view = 'courses';
    st.inApp = false;
    localStorage.setItem('ss_state', JSON.stringify(st));
  } catch (e) {}
}

export function hideStudip(stRunning) {
  showFilesView(stRunning);
}

export function navTo(navId, section) {
  var appEl = document.getElementById('app');
  var fromFiles = appEl && appEl.style.display !== 'none';
  var studipEl = document.getElementById('studipDash');
  var fromStudip = studipEl && studipEl.style.display !== 'none';
  if (fromFiles || fromStudip) showPortal();
  setNavActive(navId);
  // Use window.showPortalSection so router wrapper runs (URL update + section save)
  if (typeof window.showPortalSection === 'function') window.showPortalSection(section);
  else showPortalSection(section);
}
