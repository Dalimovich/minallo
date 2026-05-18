export function initAuthModal(options) {
    const sb = options.sb;
    const t = options.t;
    const { getCurrentUser, verifyAndEnter, enterApp, resetActivityTimer } = options;
    let authMode = 'signin';
    const authModal = document.getElementById('authModal');
    const authEmail = document.getElementById('authEmail');
    const authPassword = document.getElementById('authPassword');
    const authSubmit = document.getElementById('authSubmit');
    const authSwitch = document.getElementById('authSwitch');
    const authError = document.getElementById('authError');
    const authTitle = document.getElementById('authTitle');
    const authConfirm = document.getElementById('authConfirm');
    const togglePw = document.getElementById('togglePw');
    const toggleConfirm = document.getElementById('toggleConfirm');
    const googleSignIn = document.getElementById('googleSignIn');
    function setSubmitIdleLabel() {
        if (!authSubmit)
            return;
        authSubmit.textContent = authMode === 'signin' ? 'Sign In' : 'Create Account';
        authSubmit.disabled = false;
    }
    function showAuthError(msg) {
        if (!authError)
            return;
        authError.textContent = msg;
        authError.style.display = 'block';
    }
    function hideAuthError() {
        if (!authError)
            return;
        authError.style.display = 'none';
    }
    function setAuthMode(mode) {
        authMode = mode;
        const isSignup = mode === 'signup';
        // task-04 new-landing: toggle visibility of mode-dependent elements
        // (welcome badge, big heading, body, submit-text, google label,
        // signin-only row). Both copies live in the DOM with data-mode.
        document.querySelectorAll('[data-mode]').forEach((el) => {
            el.hidden = el.getAttribute('data-mode') !== mode;
        });
        if (authTitle) {
            authTitle.textContent = isSignup ? t('auth_title_signup') : t('auth_title_signin');
        }
        if (authSubmit) {
            authSubmit.textContent = isSignup ? t('auth_submit_signup') : t('auth_submit_signin');
        }
        if (authSwitch) {
            authSwitch.textContent = isSignup ? t('auth_switch_signup') : t('auth_switch_signin');
        }
        const confirmWrap = document.getElementById('authConfirmWrap');
        const strengthWrap = document.getElementById('pwStrengthWrap');
        if (confirmWrap)
            confirmWrap.style.display = isSignup ? 'flex' : 'none';
        if (strengthWrap)
            strengthWrap.style.display = isSignup ? 'block' : 'none';
        if (!isSignup) {
            if (authConfirm)
                authConfirm.value = '';
            const hint = document.getElementById('authConfirmHint');
            if (hint)
                hint.textContent = '';
            ['pws1', 'pws2', 'pws3', 'pws4'].forEach((id) => {
                const el = document.getElementById(id);
                if (el)
                    el.style.background = 'rgba(255,255,255,.1)';
            });
            const lbl = document.getElementById('pwStrengthLabel');
            if (lbl)
                lbl.textContent = '';
        }
        hideAuthError();
    }
    function updateStrengthMeter() {
        if (authMode !== 'signup' || !authPassword)
            return;
        const pw = authPassword.value;
        let score = 0;
        if (pw.length >= 8)
            score++;
        if (pw.length >= 12)
            score++;
        if (/[A-Z]/.test(pw) && /[a-z]/.test(pw))
            score++;
        if (/[0-9]/.test(pw))
            score++;
        if (/[^A-Za-z0-9]/.test(pw))
            score = Math.min(score + 1, 4);
        score = Math.min(score, 4);
        const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e'];
        const labels = ['Weak', 'Fair', 'Good', 'Strong'];
        ['pws1', 'pws2', 'pws3', 'pws4'].forEach((id, i) => {
            const el = document.getElementById(id);
            if (el)
                el.style.background = i < score ? colors[score - 1] : 'rgba(255,255,255,.1)';
        });
        const lbl = document.getElementById('pwStrengthLabel');
        if (!lbl)
            return;
        lbl.textContent = pw.length ? labels[score - 1] || '' : '';
        lbl.style.color = score > 0 ? colors[score - 1] : 'rgba(255,255,255,.35)';
    }
    function updateConfirmHint() {
        if (!authConfirm)
            return;
        const hint = document.getElementById('authConfirmHint');
        if (!hint)
            return;
        const pw = authPassword ? authPassword.value : '';
        if (!authConfirm.value) {
            hint.textContent = '';
            return;
        }
        if (authConfirm.value === pw) {
            hint.textContent = 'Passwords match';
            hint.style.color = '#22c55e';
        }
        else {
            hint.textContent = 'Passwords do not match';
            hint.style.color = '#ef4444';
        }
    }
    async function submitAuth() {
        if (!sb) {
            showAuthError(t('err_connection'));
            return;
        }
        const email = authEmail ? authEmail.value.trim() : '';
        const password = authPassword ? authPassword.value : '';
        if (!email || !password) {
            showAuthError(t('err_fill_fields'));
            return;
        }
        if (authSubmit) {
            authSubmit.textContent = 'Please wait...';
            authSubmit.disabled = true;
        }
        hideAuthError();
        try {
            if (authMode === 'signup') {
                const confirmVal = authConfirm ? authConfirm.value : '';
                if (!confirmVal) {
                    showAuthError(t('err_confirm_pw'));
                    if (authSubmit) {
                        authSubmit.textContent = t('auth_submit_signup');
                        authSubmit.disabled = false;
                    }
                    return;
                }
                if (password !== confirmVal) {
                    showAuthError(t('err_pw_mismatch'));
                    if (authSubmit) {
                        authSubmit.textContent = t('auth_submit_signup');
                        authSubmit.disabled = false;
                    }
                    return;
                }
                if (password.length < 8) {
                    showAuthError(t('err_pw_length'));
                    if (authSubmit) {
                        authSubmit.textContent = t('auth_submit_signup');
                        authSubmit.disabled = false;
                    }
                    return;
                }
                const signUpResult = await sb.auth.signUp(email, password, 'https://minallo.de/');
                if (signUpResult.error || signUpResult.error_description) {
                    throw new Error(signUpResult.error_description || signUpResult.error || 'Signup failed');
                }
                sessionStorage.setItem('pendingConfirm', email);
                if (signUpResult.access_token) {
                    localStorage.setItem('sb_token', signUpResult.access_token);
                    if (signUpResult.refresh_token) {
                        localStorage.setItem('sb_refresh', signUpResult.refresh_token);
                    }
                    verifyAndEnter(signUpResult.access_token);
                    return;
                }
                if (signUpResult.id || (signUpResult.user && signUpResult.user.id)) {
                    showAuthError(t('err_account_created'));
                    if (authSubmit) {
                        authSubmit.textContent = 'Create Account';
                        authSubmit.disabled = false;
                    }
                    return;
                }
                throw new Error('Signup failed - please try again.');
            }
            const signInResult = await sb.auth.signIn(email, password);
            if (!signInResult.access_token) {
                const msg = (signInResult.error_description ||
                    signInResult.error ||
                    signInResult.msg ||
                    '').toLowerCase();
                if (msg.includes('not confirmed') || msg.includes('email not confirmed')) {
                    showAuthError(t('err_confirm_email'));
                    setSubmitIdleLabel();
                    return;
                }
                showAuthError(t('err_wrong_pw'));
                setSubmitIdleLabel();
                return;
            }
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('fetch'))
                showAuthError(t('err_network'));
            else
                showAuthError(msg);
        }
        finally {
            if (authSubmit && authSubmit.textContent === 'Please wait...') {
                setSubmitIdleLabel();
            }
        }
    }
    function updateAuthIndicator(user) {
        if (!user)
            return;
        const u = user;
        const profileNameEl = document.getElementById('profileName');
        const profileName = profileNameEl && profileNameEl.value ? profileNameEl.value : null;
        const name = profileName ||
            (u.user_metadata && u.user_metadata.full_name) ||
            (u.email ? u.email.split('@')[0] : 'User') || 'User';
        const initial = name.charAt(0).toUpperCase();
        const av = document.getElementById('authAvatar');
        const nm = document.getElementById('authName');
        if (av)
            av.textContent = initial;
        if (nm)
            nm.textContent = name;
        const ai = document.getElementById('authIndicator');
        if (ai)
            ai.style.display = 'flex';
        const dcAv = document.getElementById('dcUserAv');
        const dcNm = document.getElementById('dcUserName2');
        if (dcAv && dcAv.textContent === '?')
            dcAv.textContent = initial;
        if (dcNm && dcNm.textContent === 'You')
            dcNm.textContent = name;
    }
    function handleAuthClick() {
        const currentUser = getCurrentUser();
        if (currentUser) {
            if (confirm('Sign out of Minallo?')) {
                sb?.auth.signOut().then(() => {
                    const av = document.getElementById('authAvatar');
                    const nm = document.getElementById('authName');
                    if (av)
                        av.textContent = '?';
                    if (nm)
                        nm.textContent = 'Sign in';
                });
            }
        }
        else if (authModal) {
            authModal.style.display = 'flex';
            pushAuthHistory();
        }
    }
    function showAuthModal(mode) {
        const landing = document.getElementById('landing');
        if (landing)
            landing.classList.add('hidden');
        if (authModal)
            authModal.style.display = 'flex';
        if (mode === 'signup' && authMode !== 'signup')
            setAuthMode('signup');
        else if (mode === 'signin' && authMode !== 'signin')
            setAuthMode('signin');
        pushAuthHistory();
    }
    // Browser back-button support: push a marker history entry when the modal
    // opens so pressing Back closes the modal and reveals the landing again
    // instead of leaving the site.
    function pushAuthHistory() {
        const state = history.state;
        if (state && state.ssAuthModal)
            return;
        history.pushState({ ssAuthModal: true }, '', '#auth');
    }
    function closeAuthFromHistory() {
        if (!authModal || authModal.style.display === 'none')
            return;
        authModal.style.display = 'none';
        const landing = document.getElementById('landing');
        if (landing)
            landing.classList.remove('hidden');
    }
    window.addEventListener('popstate', (e) => {
        const state = e.state;
        if (state && state.ssAuthModal)
            return;
        closeAuthFromHistory();
    });
    authSwitch?.addEventListener('click', () => {
        setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
    });
    authPassword?.addEventListener('input', updateStrengthMeter);
    authConfirm?.addEventListener('input', updateConfirmHint);
    authSubmit?.addEventListener('click', submitAuth);
    [authEmail, authPassword].forEach((el) => {
        el?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && authSubmit)
                authSubmit.click();
        });
    });
    togglePw?.addEventListener('click', () => {
        if (!authPassword)
            return;
        authPassword.type = authPassword.type === 'password' ? 'text' : 'password';
        togglePw.textContent = authPassword.type === 'password' ? '\u{1F441}' : '\u{1F648}';
    });
    toggleConfirm?.addEventListener('click', () => {
        if (!authConfirm)
            return;
        authConfirm.type = authConfirm.type === 'password' ? 'text' : 'password';
        toggleConfirm.textContent = authConfirm.type === 'password' ? '\u{1F441}' : '\u{1F648}';
    });
    googleSignIn?.addEventListener('click', () => {
        if (typeof window._googleAuth === 'function')
            window._googleAuth();
    });
    if (sb && sb.auth && typeof sb.auth.onAuthStateChange === 'function') {
        sb.auth.onAuthStateChange((event) => {
            if (event === 'SIGNED_IN') {
                const currentUser = getCurrentUser();
                if (currentUser)
                    enterApp(currentUser);
                resetActivityTimer();
            }
            else if (event === 'SIGNED_OUT') {
                window.location.reload();
            }
        });
    }
    return {
        getAuthMode: () => authMode,
        setAuthMode,
        showAuthModal,
        updateAuthIndicator,
        handleAuthClick,
    };
}
//# sourceMappingURL=auth-modal.js.map