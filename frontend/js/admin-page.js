import { checkAdminStatus } from './services/admin-service.js';
import { initAdminPanel } from './features/admin/admin-panel.js';
const root = document.getElementById('adminRoot');
let token = localStorage.getItem('sb_sess_token') || sessionStorage.getItem('sb_sess_token') || localStorage.getItem('sb_token');
function redirectToSignIn() {
    window.location.replace('/?auth=signin');
}
async function refreshToken() {
    const refresh = localStorage.getItem('sb_sess_refresh') || sessionStorage.getItem('sb_sess_refresh') || localStorage.getItem('sb_refresh');
    const config = window.MinalloConfig || {};
    const supabaseUrl = typeof config.supabaseUrl === 'string' ? config.supabaseUrl : window._SUPA;
    const anonKey = typeof config.supabaseAnonKey === 'string' ? config.supabaseAnonKey : window._SAKEY;
    if (!refresh || !supabaseUrl || !anonKey)
        return null;
    const response = await fetch(supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey },
        body: JSON.stringify({ refresh_token: refresh })
    });
    if (!response.ok)
        return null;
    const data = await response.json();
    if (!data.access_token)
        return null;
    localStorage.setItem('sb_sess_token', data.access_token);
    if (data.refresh_token)
        localStorage.setItem('sb_sess_refresh', data.refresh_token);
    return data.access_token;
}
async function verifyAdmin(retried = false) {
    if (!token)
        return false;
    window._sbToken = token;
    const status = await checkAdminStatus();
    if (status?.isAdmin)
        return true;
    if (!retried) {
        token = await refreshToken();
        if (token)
            return verifyAdmin(true);
    }
    return false;
}
async function mountAdmin() {
    if (!token)
        return redirectToSignIn();
    if (!(await verifyAdmin())) {
        window.location.replace('/');
        return;
    }
    const response = await fetch('/pages/portal.html');
    if (!response.ok)
        throw new Error('Could not load the admin dashboard');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const admin = doc.getElementById('psec-admin');
    const styles = doc.getElementById('adm-dash-styles');
    if (!admin || !styles || !root)
        throw new Error('Admin dashboard markup is unavailable');
    document.head.appendChild(styles);
    admin.style.display = '';
    root.replaceChildren(admin);
    window.showToast = (title, subtitle) => {
        document.querySelector('.admin-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = 'admin-toast';
        toast.textContent = title;
        if (subtitle) {
            const small = document.createElement('small');
            small.textContent = subtitle;
            toast.appendChild(small);
        }
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3200);
    };
    initAdminPanel();
}
mountAdmin().catch(() => {
    if (root)
        root.innerHTML = '<div class="admin-state">We could not load the admin dashboard right now.</div>';
});
