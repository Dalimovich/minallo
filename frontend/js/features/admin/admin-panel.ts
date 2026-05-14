import { checkAdminStatus, searchUsers, setUserPlan, reindexUserCourse } from '../../services/admin-service.js';
import { escapeHtml } from '../../utils/escape-html.js';

interface AdminUser {
  id: string;
  email?: string;
  plan?: string;
  status?: string;
  created_at?: string;
}

export function adminShowIfEligible(user: { id?: string } | null): void {
  const btn = document.getElementById('psbAdmin');
  if (!btn || !user) return;
  btn.style.display = 'none';
  checkAdminStatus()
    .then((data) => {
      const isAdmin = !!(data && typeof data === 'object' && 'isAdmin' in data && (data as { isAdmin?: boolean }).isAdmin);
      if (isAdmin) btn.style.display = '';
    })
    .catch(() => {});
}

export function initAdminPanel(): void {
  const searchBtn = document.getElementById('adminSearchBtn');
  const searchInput = document.getElementById('adminSearchInput') as HTMLInputElement | null;
  const navBtn = document.getElementById('psbAdmin');

  if (navBtn) {
    navBtn.addEventListener('click', () => {
      if (typeof window.showPortal === 'function') window.showPortal();
      if (typeof window.setNavActive === 'function') window.setNavActive('psbAdmin');
      if (typeof window.showPortalSection === 'function') window.showPortalSection('admin');
    });
  }
  if (searchBtn) searchBtn.addEventListener('click', adminSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') adminSearch();
    });
  }
}

async function adminSearch(): Promise<void> {
  const input = document.getElementById('adminSearchInput') as HTMLInputElement | null;
  const results = document.getElementById('adminResults');
  if (!results) return;
  const q = (input?.value || '').trim();
  if (!q) return;
  results.innerHTML =
    '<div style="color:var(--on-glass-muted);font-size:.85rem">Searching...</div>';
  try {
    const users = (await searchUsers(q)) as AdminUser[] | unknown;
    if (!Array.isArray(users) || !users.length) {
      results.innerHTML =
        '<div style="color:var(--on-glass-muted);font-size:.85rem">No users found.</div>';
      return;
    }
    results.innerHTML = '';
    (users as AdminUser[]).forEach((u) => {
      const isPro = u.plan === 'pro' && u.status === 'active';
      const joined = u.created_at ? new Date(u.created_at).toLocaleDateString() : '';

      const card = document.createElement('div');
      card.style.cssText =
        'background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:14px;padding:14px 18px;margin-bottom:10px;display:flex;align-items:center;gap:12px';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';

      const emailEl = document.createElement('div');
      emailEl.style.cssText = 'font-weight:800;color:var(--on-glass);font-size:.88rem';
      emailEl.textContent = u.email || '';

      const joinedEl = document.createElement('div');
      joinedEl.style.cssText = 'font-size:.72rem;color:var(--on-glass-muted)';
      joinedEl.textContent = 'Joined ' + joined;

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size:.75rem;margin-top:4px;font-weight:800;color:' + (isPro ? '#22c55e' : '#f87171');
      statusEl.textContent = isPro ? '✓ Pro (subscribed)' : '✕ Free (not subscribed)';

      info.append(emailEl, joinedEl, statusEl);

      const actionBtn = document.createElement('button');
      actionBtn.className = 'sub-btn ' + (isPro ? 'sub-btn-current' : 'sub-btn-upgrade');
      actionBtn.dataset.uid = u.id;
      actionBtn.dataset.pro = String(isPro);
      actionBtn.style.cssText = 'width:auto;padding:8px 18px;font-size:.78rem';
      actionBtn.textContent = isPro ? 'Revoke Pro' : 'Grant Pro';

      actionBtn.addEventListener('click', async function (this: HTMLButtonElement) {
        const uid = this.dataset.uid || '';
        const grantPro = this.dataset.pro === 'false';
        this.textContent = '...';
        this.disabled = true;
        try {
          await setUserPlan(uid, grantPro ? 'pro' : 'free');
          if (typeof window.showToast === 'function')
            window.showToast(grantPro ? '✓ Pro granted' : 'Pro revoked', u.email);
          adminSearch();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (typeof window.showToast === 'function') window.showToast('Error', msg);
          this.disabled = false;
        }
      });

      const reindexBtn = document.createElement('button');
      reindexBtn.className = 'sub-btn';
      reindexBtn.dataset.uid = u.id;
      reindexBtn.style.cssText = 'width:auto;padding:8px 14px;font-size:.72rem;margin-left:6px';
      reindexBtn.textContent = 'Reindex course…';
      reindexBtn.addEventListener('click', async function (this: HTMLButtonElement) {
        const uid = this.dataset.uid || '';
        const courseId = (window.prompt('Course ID to reindex for ' + (u.email || uid) + ':') || '').trim();
        if (!courseId) return;
        this.disabled = true;
        const origText = this.textContent;
        this.textContent = 'Checking…';
        try {
          const dry = await reindexUserCourse(uid, courseId, true);
          const n = typeof dry.count === 'number' ? dry.count : 0;
          if (dry.error) throw new Error(dry.error);
          if (!n) {
            if (typeof window.showToast === 'function') window.showToast('No documents', 'Course "' + courseId + '" has 0 docs for this user.');
            return;
          }
          if (!window.confirm('Reindex ' + n + ' document(s) in course "' + courseId + '"? This clears chunks/pages and re-runs the indexer.')) return;
          this.textContent = 'Reindexing…';
          const real = await reindexUserCourse(uid, courseId, false);
          if (real.error) throw new Error(real.error);
          if (typeof window.showToast === 'function')
            window.showToast('Reindex queued', 'Total ' + (real.total ?? 0) + ' · kicked ' + (real.kicked ?? 0) + (real.failed ? ' · failed ' + real.failed : ''));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (typeof window.showToast === 'function') window.showToast('Error', msg);
        } finally {
          this.disabled = false;
          this.textContent = origText;
        }
      });

      card.append(info, actionBtn, reindexBtn);
      results.appendChild(card);
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.innerHTML = '<div style="color:#f87171;font-size:.85rem">Error: ' + escapeHtml(msg) + '</div>';
  }
}
