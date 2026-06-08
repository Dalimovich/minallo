// ── Minallo Section Loader ────────────────────────────────────────────────
// Fetches each HTML section file and injects it into the DOM in order,
// then loads app.js and fires 'ss-ready' so supabase.js can do auth init.
// All JS runs in the same window scope — no iframes, no module boundaries.
(function () {
    // ── Session routing ──────────────────────────────────────────────────────
    const SS = window.Minallo;
    const root = document.getElementById('ss-sections-root');
    if (!root) {
        console.error('[loader] #ss-sections-root missing');
        return;
    }
    if (SS)
        SS.emit('loader:start', { loggedIn: !!window._ssIsLoggedIn });
    // Universal fetch-with-timeout helper. Every boot-path fetch goes through
    // this so a single stalled request can't hang the entire app. On timeout
    // we resolve the abort which surfaces as a normal fetch error in the
    // caller's .catch — same handling as a network failure.
    function _fetchTimeout(input, ms, init) {
        const hasAC = typeof AbortController !== 'undefined';
        const ctrl = hasAC ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
        return fetch(input, { ...(init || {}), signal: ctrl ? ctrl.signal : undefined })
            .then((r) => { if (timer)
            clearTimeout(timer); return r; })
            .catch((err) => { if (timer)
            clearTimeout(timer); throw err; });
    }
    // Hard splash-hide fallback. If ss-ready hasn't fired 35 seconds after
    // boot — beyond every per-fetch and per-script timeout combined — force
    // the splash off so the user sees SOMETHING they can act on, even if
    // it's a partially-rendered page or a sign-in fallback. This is the
    // last line of defense and must never depend on any boot artifact.
    let _ssReadyFired = false;
    window.addEventListener('ss-ready', () => { _ssReadyFired = true; }, { once: true });
    setTimeout(() => {
        if (_ssReadyFired)
            return;
        console.error('[loader] hard splash-hide fallback — 35s elapsed without ss-ready');
        try {
            document.body.setAttribute('data-ss-ready', '1');
        }
        catch (e) { /* noop */ }
        const splash = document.getElementById('ss-splash');
        if (splash)
            splash.style.display = 'none';
        try {
            window.dispatchEvent(new Event('ss-ready'));
        }
        catch (e) { /* noop */ }
    }, 35000);
    // ── Landing translations ─────────────────────────────────────────────────
    const _landingTrans = {
        en: {
            nav_login: 'Login',
            badge: 'BUILT FOR UNIVERSITY STUDENTS',
            h1: 'Study smarter,<br>not harder.',
            subtitle: 'One workspace for courses, PDFs, your AI tutor and lecture notes. Stop switching tabs — start understanding.',
            cta: 'Start free trial →',
            note: '7-day free trial · Cancel anytime',
            features_label: 'What you get',
            features_title: 'Everything you need to ace your degree',
            f1_title: 'Smart PDF Viewer',
            f1_desc: 'Ask the AI to explain formulas, summarise sections or answer questions — based on the actual document.',
            f2_title: 'AI Study Assistant',
            f2_desc: 'Select any text and get instant explanations, examples and step-by-step solutions from your 24/7 tutor.',
            f3_title: 'Lecture Summaries',
            f3_desc: 'Watch on YouTube or Opencast and auto-generate structured notes with the browser extension.',
            f4_title: 'Course Dashboard',
            f4_desc: 'Subjects, files, timetable, forum and appointments. No more hunting through Stud.IP tabs.',
            f5_title: 'Chat History Per PDF',
            f5_desc: 'Every AI conversation saved per file. Pick up exactly where you left off — on any device.',
            f6_title: 'Secure & Private',
            f6_desc: 'Row-level security via Supabase. Only you can see your notes, settings and profile. Always.',
            cta2_title: 'Ready to study smarter?',
            cta2_desc: 'Join thousands of students already using Minallo to save time, understand more and stress less.',
            cta2_btn: 'Start your free trial →',
            stats_rating: 'Average rating',
            stats_students: 'Students',
            stats_pdfs: 'PDFs analysed',
            reviews_label: 'What students say',
            reviews_title: 'Loved by students',
            footer_signin: 'Sign in',
        },
        de: {
            nav_login: 'Anmelden',
            badge: 'FÜR UNIVERSITÄTSSTUDENTEN',
            h1: 'Klüger studieren,<br>nicht härter.',
            subtitle: 'Ein Arbeitsbereich für Kurse, PDFs, deinen KI-Tutor und Vorlesungsnotizen. Höre auf, Tabs zu wechseln — fange an zu verstehen.',
            cta: 'Kostenlos starten →',
            note: '7 Tage kostenlos testen · Jederzeit kündbar',
            features_label: 'Was du bekommst',
            features_title: 'Alles, was du für deinen Abschluss brauchst',
            f1_title: 'Intelligenter PDF-Viewer',
            f1_desc: 'Bitte die KI, Formeln zu erklären, Abschnitte zusammenzufassen oder Fragen zu beantworten — basierend auf dem Dokument.',
            f2_title: 'KI-Lernassistent',
            f2_desc: 'Markiere Text und erhalte sofortige Erklärungen, Beispiele und Schritt-für-Schritt-Lösungen von deinem 24/7-Tutor.',
            f3_title: 'Vorlesungszusammenfassungen',
            f3_desc: 'Schaue auf YouTube oder Opencast und generiere automatisch strukturierte Notizen mit der Browsererweiterung.',
            f4_title: 'Kurs-Dashboard',
            f4_desc: 'Fächer, Dateien, Stundenplan, Forum und Termine. Kein Suchen mehr in Stud.IP-Tabs.',
            f5_title: 'Chatverlauf pro PDF',
            f5_desc: 'Jedes KI-Gespräch wird pro Datei gespeichert. Mache genau dort weiter, wo du aufgehört hast — auf jedem Gerät.',
            f6_title: 'Sicher & Privat',
            f6_desc: 'Zeilensicherheit über Supabase. Nur du kannst deine Notizen, Einstellungen und dein Profil sehen. Immer.',
            cta2_title: 'Bereit, klüger zu studieren?',
            cta2_desc: 'Schließe dich Tausenden von Studierenden an, die bereits Minallo nutzen, um Zeit zu sparen und mehr zu verstehen.',
            cta2_btn: 'Kostenloses Konto erstellen →',
            stats_rating: 'Durchschnittsbewertung',
            stats_students: 'Studierende',
            stats_pdfs: 'Analysierte PDFs',
            reviews_label: 'Was Studierende sagen',
            reviews_title: 'Geliebt von Studierenden',
            footer_signin: 'Anmelden',
        },
    };
    let _landingLang = localStorage.getItem('ss_lang') === 'de' ? 'de' : 'en';
    function applyLandingTranslation(lang) {
        _landingLang = lang === 'de' ? 'de' : 'en';
        localStorage.setItem('ss_lang', _landingLang);
        const t = _landingTrans[_landingLang];
        if (!root)
            return;
        // Nav
        const loginBtn = root.querySelector('[data-i18n="landing_nav_login"]');
        if (loginBtn)
            loginBtn.textContent = t.nav_login;
        const langBtn = document.getElementById('landingLangBtn');
        if (langBtn)
            langBtn.textContent = _landingLang === 'de' ? 'EN' : 'DE';
        // Hero
        const badge = root.querySelector('.hero-badge');
        if (badge) {
            const dot = badge.querySelector('.hero-badge-dot');
            badge.textContent = t.badge;
            if (dot)
                badge.insertBefore(dot, badge.firstChild);
        }
        const h1 = root.querySelector('.hero-text h1');
        if (h1) {
            h1.textContent = '';
            String(t.h1 || '')
                .split(/<br\s*\/?>/i)
                .forEach((part, i) => {
                if (i)
                    h1.appendChild(document.createElement('br'));
                h1.appendChild(document.createTextNode(part));
            });
        }
        const heroPara = root.querySelector('.hero-text > p');
        if (heroPara)
            heroPara.textContent = t.subtitle;
        const heroCta = root.querySelector('a.hero-cta');
        if (heroCta)
            heroCta.textContent = t.cta;
        const heroNote = root.querySelector('.hero-note');
        if (heroNote)
            heroNote.textContent = t.note;
        // Features section labels
        const sectionLabel = root.querySelector('.section-label.fade-in');
        if (sectionLabel)
            sectionLabel.textContent = t.features_label;
        const sectionTitle = root.querySelector('.section-title.fade-in');
        if (sectionTitle)
            sectionTitle.textContent = t.features_title;
        // Feature cards
        const cards = root.querySelectorAll('.glass-card');
        const descs = [t.f1_desc, t.f2_desc, t.f3_desc, t.f4_desc, t.f5_desc, t.f6_desc];
        const titles = [t.f1_title, t.f2_title, t.f3_title, t.f4_title, t.f5_title, t.f6_title];
        cards.forEach((card, i) => {
            if (i >= titles.length)
                return;
            const h3 = card.querySelector('h3');
            const p = card.querySelector('p');
            if (h3)
                h3.textContent = titles[i] ?? '';
            if (p)
                p.textContent = descs[i] ?? '';
        });
        // CTA section
        const ctaBox = root.querySelector('.cta-box');
        if (ctaBox) {
            const ctaH2 = ctaBox.querySelector('h2');
            const ctaP = ctaBox.querySelector('p');
            const ctaBtn = ctaBox.querySelector('button');
            if (ctaH2)
                ctaH2.textContent = t.cta2_title;
            if (ctaP)
                ctaP.textContent = t.cta2_desc;
            if (ctaBtn)
                ctaBtn.textContent = t.cta2_btn;
        }
        // Stats row labels
        const statSpans = root.querySelectorAll('#ratings .ratings-label');
        const statLabels = [t.stats_rating, t.stats_students, t.stats_pdfs];
        statSpans.forEach((el, i) => {
            const label = statLabels[i];
            if (label)
                el.textContent = label;
        });
        // Reviews heading
        const reviewsLabel = root.querySelector('#ratings .reviews-kicker');
        if (reviewsLabel)
            reviewsLabel.textContent = t.reviews_label;
        const reviewsTitle = root.querySelector('#ratings .reviews-title');
        if (reviewsTitle)
            reviewsTitle.textContent = t.reviews_title;
        // Footer sign-in link
        const footerLink = root.querySelector('footer a');
        if (footerLink)
            footerLink.textContent = t.footer_signin;
    }
    // Public toggle — called by the language button in landing.html
    window._toggleLandingLang = function () {
        applyLandingTranslation(_landingLang === 'en' ? 'de' : 'en');
    };
    if (!window._ssIsLoggedIn) {
        // Load new-landing CSS before rendering the page. The old landing.css
        // remains in the repo (frontend/css/landing.css) but is no longer
        // injected — the new landing replaces it visually.
        (function () {
            function ensureStylesheet(href) {
                const path = href.split('?')[0] || href;
                const exists = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => {
                    const current = link.getAttribute('href') || '';
                    const currentPath = current.split('?')[0] || current;
                    if (current === href)
                        return true;
                    if (currentPath.endsWith(path)) {
                        link.setAttribute('href', href);
                        return true;
                    }
                    return false;
                });
                if (exists)
                    return;
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                document.head.appendChild(link);
            }
            ensureStylesheet('css/new-landing.css?v=17');
            ensureStylesheet('css/auth.css?v=4');
        })();
        _fetchTimeout('pages/new_landing.html', 10000)
            .then((r) => {
            if (!r.ok)
                throw new Error('HTTP ' + r.status + ' loading new_landing.html');
            return r.text();
        })
            .then((html) => {
            root.innerHTML = html;
            document.body.classList.add('nl-body');
            // Inject the new-landing JS module after the fragment lands so it
            // can find its #/data-* hooks on first query.
            (function () {
                const script = document.createElement('script');
                script.src = 'js/pages/new-landing.js?v=15';
                script.defer = true;
                document.body.appendChild(script);
            })();
            // Inject the Google Sign-In client (gsi/client) AFTER the landing
            // partial is in the DOM. Previously this lived as a render-blocking
            // <script async defer> in index.html — Lighthouse flagged it as 95KiB
            // of which ~72KiB is unused on the landing, and it competed for
            // bandwidth with the LCP fonts. auth-bootstrap.js polls for
            // `google.accounts` every 100ms, so delaying the script load by a
            // few hundred ms is transparent to OneTap init.
            (function injectGsiClient() {
                if (document.querySelector('script[src*="accounts.google.com/gsi/client"]'))
                    return;
                const gsi = document.createElement('script');
                gsi.src = 'https://accounts.google.com/gsi/client';
                gsi.async = true;
                gsi.defer = true;
                document.head.appendChild(gsi);
            })();
            if (SS)
                SS.markReady('landing', { file: 'pages/new_landing.html' });
            window.dispatchEvent(new Event('ss-ready'));
            console.log('✓ New landing page loaded');
            // Re-run fade-in observer — scripts inside landing.html don't execute via innerHTML
            const fadeObserver = new IntersectionObserver((entries) => {
                entries.forEach((e) => {
                    if (e.isIntersecting) {
                        e.target.classList.add('visible');
                        fadeObserver.unobserve(e.target);
                    }
                });
            }, { threshold: 0.12 });
            root.querySelectorAll('.fade-in').forEach((el) => {
                fadeObserver.observe(el);
            });
            // Back-to-top button scroll handler (hover is handled by landing.css)
            const backBtn = document.getElementById('backToTop');
            if (backBtn) {
                window.addEventListener('scroll', () => {
                    backBtn.style.display = window.scrollY > 400 ? 'flex' : 'none';
                });
                backBtn.addEventListener('click', () => {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                });
            }
            // Apply saved language
            applyLandingTranslation(_landingLang);
            const landingLangBtn = document.getElementById('landingLangBtn');
            if (landingLangBtn) {
                landingLangBtn.addEventListener('click', () => {
                    if (typeof window._toggleLandingLang === 'function')
                        window._toggleLandingLang();
                });
            }
            ['landingLoginBtn', 'landingHeroStartBtn', 'landingCtaBtn', 'landingFooterSignin'].forEach((id) => {
                const el = document.getElementById(id);
                if (!el)
                    return;
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (typeof window._googleAuth === 'function')
                        window._googleAuth();
                });
            });
            const seeHowBtn = document.getElementById('landingSeeHowBtn');
            if (seeHowBtn) {
                seeHowBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const section = document.querySelector('.section');
                    if (section)
                        section.scrollIntoView({ behavior: 'smooth' });
                });
            }
        })
            .catch((err) => {
            console.error('✗ Could not load new_landing.html:', err);
            root.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:center;' +
                    'height:100vh;font-family:Nunito,sans-serif;color:#3b82f6;font-size:1.1rem">' +
                    'Minallo — ' +
                    '<button id="landingFallbackGoogleBtn" ' +
                    'style="margin-left:12px;padding:10px 24px;' +
                    'background:linear-gradient(90deg,#b87bff,#ef79c4);' +
                    'border:none;border-radius:999px;color:#fff;font-weight:800;cursor:pointer">' +
                    'Sign in with Google</button></div>';
            window.dispatchEvent(new Event('ss-ready'));
        });
        return; // ← do NOT load app sections below
    }
    // ── Full app (user is logged-in this session) ─────────────────────────────
    const SECTIONS = [
        'pages/auth.html',
        'pages/signup.html',
        'views/toast/toast.html',
        'pages/portal.html',
        'pages/modals.html',
    ];
    const FEATURE_SECTIONS = [
        { id: 'psec-profile', file: 'views/profile/profile.html' },
        { id: 'psec-settings', file: 'views/settings/settings.html' },
        { id: 'psec-subscription', file: 'views/subscription/subscription.html' },
    ];
    // Inject feature CSS
    (function () {
        [
            'css/base.css?v=5',
            'css/theme.css?v=5',
            'css/styles.css?v=37',
            'css/courses-redesign.css?v=37',
            'css/app-design-system.css?v=5',
            'css/layout.css?v=10',
            'css/document-rail.css?v=28',
            'css/auth.css?v=4',
            'css/onboarding.css?v=1',
            'views/toast/toast.css',
            'views/games/games.css',
            // Light-mode polish loads LAST so it wins source-order ties
            // against feature CSS that still hard-codes greys.
            'css/light-mode.css?v=50',
        ].forEach((href) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            document.head.appendChild(link);
        });
    })();
    // Shim _t early so feature scripts that call _t() before app.js runs don't throw.
    // app.js will overwrite window._t with the real translation function.
    if (!window._t) {
        window._t = function (key) {
            return key;
        };
    }
    function loadAppScript() {
        const _v = String(window.MinalloConfig?.assetVersion || SS?.version || '1');
        if (SS)
            SS.emit('loader:app-script:start', {});
        function versioned(src) {
            return src + (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(_v);
        }
        // 10s per-script timeout: HTTPS-inspection AV (e.g. Norton WFP) can drop a
        // request silently — no onload, no onerror, just pending forever. Without
        // this fallback the entire boot chain hangs and ss-ready never fires.
        // On timeout we resolve (not reject) so the chain continues — downstream
        // code may run degraded, but the splash hides and the user can recover.
        const SCRIPT_TIMEOUT_MS = 10000;
        function loadScript(src, readyKey, options) {
            return new Promise((resolve) => {
                const opts = options || {};
                const script = document.createElement('script');
                if (opts.type)
                    script.type = opts.type;
                script.src = versioned(src);
                let settled = false;
                const settle = (reason, err) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    if (reason === 'load') {
                        if (SS && readyKey)
                            SS.markReady(readyKey, { file: src });
                    }
                    else {
                        console.error('[loader] ' + reason + ': ' + src, err || '');
                        if (SS)
                            SS.emit('loader:script:' + reason, { file: src });
                    }
                    resolve();
                };
                const timer = setTimeout(() => settle('timeout'), SCRIPT_TIMEOUT_MS);
                script.onload = () => settle('load');
                script.onerror = () => settle('error', new Error('Failed to load ' + src));
                document.body.appendChild(script);
            });
        }
        // Load dependency helpers and early feature globals first, then app/router.
        loadScript('js/dependencies.js', 'dependencies-script')
            .then(() => loadScript('js/utils/db-helpers.js', 'db-helpers-script'))
            .then(() => loadScript('views/subscription/subscription.js', 'subscription-script'))
            .then(() => {
            // app-data.js must load before app.js — it declares SEMS, COLORS, MAJOR_LIST, SUBJECT_LIST
            return loadScript('js/app-data.js', 'app-data-script');
        })
            .then(() => loadScript('js/main.js', 'app-script', { type: 'module' }))
            .then(() => {
            // app-storage.js and app-pdf.js extend app.js globals — load after app.js
            return Promise.all([
                loadScript('js/app-storage.js', 'app-storage-script'),
                loadScript('js/app-pdf.js', 'app-pdf-script'),
            ]);
        })
            .then(() => {
            console.log('app.js + modules loaded');
            return loadScript('js/router.js', 'router-script');
        })
            .then(() => {
            // Feature scripts load AFTER app.js so _init() can safely call app globals.
            // Track all loads so ss-ready only fires after every feature script is done.
            const featureSrcs = [
                'views/toast/toast.js',
            ];
            function loadDeferredFeatures() {
                featureSrcs.forEach((src) => {
                    const s = document.createElement('script');
                    s.src = versioned(src);
                    let settled = false;
                    const settle = (reason) => {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        if (reason !== 'load')
                            console.error('[loader] feature ' + reason + ':', src);
                    };
                    const timer = setTimeout(() => settle('timeout'), SCRIPT_TIMEOUT_MS);
                    s.onload = () => settle('load');
                    s.onerror = () => settle('error');
                    document.body.appendChild(s);
                });
            }
            // Games hub: ~150KB across 13 scripts (8 solitaire variants, tetris,
            // bird, chess, hub dispatcher). Most users never open the games page
            // in a session — defer to first click on the games nav.
            // Sub-modules (tetris/solitaire/bird/chess) must load before games.js
            // (hub) so their window.* functions are defined when games.js _init()
            // wires the buttons — we therefore load them sequentially.
            (function setupGamesLazy() {
                const GAMES_SCRIPTS = [
                    'views/games/games-tetris.js',
                    'views/games/games-solitaire-shared.js',
                    'views/games/games-solitaire-klondike.js',
                    'views/games/games-solitaire-spider.js',
                    'views/games/games-solitaire-scorpion.js',
                    'views/games/games-solitaire-freecell.js',
                    'views/games/games-solitaire-pyramid.js',
                    'views/games/games-solitaire-tripeaks.js',
                    'views/games/games-solitaire-vegas.js',
                    'views/games/games-solitaire-dispatcher.js',
                    'views/games/games-bird.js',
                    'views/games/games-chess.js',
                    'views/games/games.js',
                ];
                let loaded = false;
                function loadGames() {
                    if (loaded)
                        return;
                    loaded = true;
                    GAMES_SCRIPTS.reduce((p, src) => p.then(() => new Promise((res) => {
                        const s = document.createElement('script');
                        s.src = versioned(src);
                        s.onload = () => res();
                        s.onerror = () => { console.error('lazy-games failed:', src); res(); };
                        document.body.appendChild(s);
                    })), Promise.resolve());
                }
                function bindTrigger() {
                    const btn = document.getElementById('psbGames');
                    if (!btn)
                        return false;
                    ['pointerenter', 'pointerdown', 'focusin', 'touchstart', 'click'].forEach((eventName) => {
                        btn.addEventListener(eventName, loadGames, { once: true, passive: eventName !== 'click' });
                    });
                    return true;
                }
                if (!bindTrigger()) {
                    // Section HTML may still be injecting — retry until the nav button exists.
                    const obs = new MutationObserver(() => {
                        if (bindTrigger())
                            obs.disconnect();
                    });
                    obs.observe(document.body, { childList: true, subtree: true });
                }
            })();
            (function setupPortalFeatureLazyLoad() {
                const lazyMap = {
                    dashboard: [
                        'views/dashboard/dashboard-widget.js',
                    ],
                    dashboardCalendar: ['views/dashboard/dashboard-calendar.js'],
                    chat: ['views/chat/chat.js'],
                    aipage: ['views/chatbot/chatbot.js?v=5'],
                    german: ['views/practice/practice.js'],
                    notes: ['views/lecturenotes/lecturenotes.js'],
                    profile: ['views/profile/profile.js'],
                    settings: ['views/settings/settings.js'],
                    flashcards: ['js/utils/db-helpers.js', 'views/flashcards/flashcards.js'],
                    quiz: ['js/utils/db-helpers.js', 'views/quiz/quiz.js'],
                    examforge: ['js/utils/db-helpers.js', 'views/examforge/examforge.js'],
                    cheatsheet: ['js/utils/db-helpers.js', 'views/cheatsheet/cheatsheet.js'],
                    deeplearn: ['js/utils/db-helpers.js', 'views/deep-learn/deep-learn.js'],
                    notesPanel: ['views/notes/notes-panel.js'],
                    // writer/merger register listeners for ss-editor-ready, so load
                    // them before editor.js fetches markup and dispatches the event.
                    editor: [
                        'views/editor/writer.js',
                        'views/editor/merger.js',
                        'views/editor/editor.js',
                    ],
                };
                const lazyCssMap = {
                    dashboard: ['views/dashboard/dashboard.css'],
                    chat: ['views/chat/chat.css'],
                    aipage: ['views/chatbot/chatbot.css?v=3'],
                    german: ['views/practice/practice.css', 'views/writing-coach/writing-coach.css'],
                    notes: ['views/lecturenotes/lecturenotes.css'],
                    profile: ['views/profile/profile.css'],
                    settings: ['views/settings/settings.css'],
                    subscription: ['views/subscription/subscription.css'],
                    flashcards: ['views/flashcards/flashcards.css'],
                    quiz: ['views/quiz/quiz.css'],
                    examforge: ['views/examforge/examforge.css?v=2'],
                    cheatsheet: ['views/cheatsheet/cheatsheet.css'],
                    deeplearn: ['views/deep-learn/deep-learn.css'],
                    notesPanel: ['views/notes/notes-panel.css'],
                    editor: ['views/editor/editor.css'],
                };
                const lazyPromises = {};
                const navFeatureMap = {
                    psbDashboard: 'dashboard',
                    pcStudip: 'studip',
                    psbGerman: 'german',
                    psbProfile: 'profile',
                    authAvatar: 'profile',
                    psbSettings: 'settings',
                    psbSubscription: 'subscription',
                    psbNotes: 'notes',
                    psbEditor: 'editor',
                    psbAIPage: 'aipage',
                    psbChat: 'chat',
                    psbGames: 'games',
                };
                function ensureStylesheet(href) {
                    const hrefWithVersion = versioned(href);
                    const path = href.split('?')[0] || href;
                    const exists = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => {
                        const current = link.getAttribute('href') || '';
                        const currentPath = current.split('?')[0] || current;
                        return current === hrefWithVersion || currentPath.endsWith(path);
                    });
                    if (exists)
                        return;
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = hrefWithVersion;
                    document.head.appendChild(link);
                }
                function keepLightModeLast() {
                    const light = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((link) => {
                        return (link.getAttribute('href') || '').indexOf('css/light-mode.css') !== -1;
                    });
                    if (light)
                        document.head.appendChild(light);
                }
                window._ssLoadPortalFeature = function (name) {
                    const srcs = lazyMap[name] || [];
                    const css = lazyCssMap[name] || [];
                    if (!srcs.length && !css.length)
                        return Promise.resolve();
                    if (lazyPromises[name])
                        return lazyPromises[name];
                    css.forEach(ensureStylesheet);
                    keepLightModeLast();
                    lazyPromises[name] = srcs.reduce((p, src) => p.then(() => loadScript(src, 'lazy-' + name)), Promise.resolve());
                    return lazyPromises[name];
                };
                function loadPortalRoute(name) {
                    const htmlFiles = {
                        profile: 'views/profile/profile.html',
                        settings: 'views/settings/settings.html',
                        subscription: 'views/subscription/subscription.html',
                    };
                    if (name === 'aipage')
                        prewarmChatbotShell();
                    const htmlPromise = htmlFiles[name]
                        ? loadFeatureSection({ id: 'psec-' + name, file: htmlFiles[name] })
                        : Promise.resolve();
                    const featurePromise = window._ssLoadPortalFeature?.(name) || Promise.resolve();
                    return Promise.all([htmlPromise, featurePromise]).then(() => undefined);
                }
                function prewarmChatbotShell() {
                    const w = window;
                    if (!w._ncbHtmlPromise) {
                        w._ncbHtmlPromise = _fetchTimeout('views/chatbot/chatbot.html', 10000).then((r) => {
                            if (!r.ok)
                                throw new Error('HTTP ' + r.status + ' loading chatbot.html');
                            return r.text();
                        });
                    }
                    const shellSrc = 'js/features/chatbot-new/shell.js?v=6&av=' +
                        encodeURIComponent(String(window.MinalloConfig?.assetVersion || SS?.version || '1'));
                    const exists = Array.from(document.querySelectorAll('link[rel="modulepreload"]')).some((link) => (link.getAttribute('href') || '') === shellSrc);
                    if (!exists) {
                        const link = document.createElement('link');
                        link.rel = 'modulepreload';
                        link.href = shellSrc;
                        document.head.appendChild(link);
                    }
                }
                window._ssPrewarmPortalFeature = function (name) {
                    if (!name || name === 'studip' || name === 'notifications' || name === 'lounge') {
                        return Promise.resolve();
                    }
                    return loadPortalRoute(name).catch((err) => {
                        console.warn('[loader] route prewarm failed:', name, err);
                    });
                };
                function setupNavIntentPrewarm() {
                    const rootNav = document.querySelector('#portal .sb-nav');
                    if (!rootNav)
                        return;
                    const prewarmFromTarget = (target) => {
                        const el = target instanceof Element ? target.closest('.sb-item') : null;
                        if (!el || el.dataset.comingSoon)
                            return;
                        const featureName = navFeatureMap[el.id];
                        if (!featureName)
                            return;
                        void window._ssPrewarmPortalFeature?.(featureName);
                    };
                    ['pointerover', 'pointerdown', 'focusin', 'touchstart'].forEach((eventName) => {
                        rootNav.addEventListener(eventName, (event) => prewarmFromTarget(event.target), {
                            passive: true,
                        });
                    });
                }
                setupNavIntentPrewarm();
                function scheduleChatPrewarm() {
                    const run = () => {
                        const loadFeature = window._ssLoadPortalFeature;
                        if (typeof loadFeature !== 'function')
                            return;
                        void Promise.all([loadFeature('aipage'), loadFeature('chat')]).catch((err) => {
                            console.warn('[loader] chat prewarm failed', err);
                        });
                    };
                    const schedule = window.requestIdleCallback
                        ? (cb) => window.requestIdleCallback(cb, { timeout: 4500 })
                        : (cb) => window.setTimeout(cb, 1800);
                    window.setTimeout(() => schedule(run), 900);
                }
                if (document.body.getAttribute('data-ss-ready') === '1')
                    scheduleChatPrewarm();
                else
                    window.addEventListener('ss-ready', scheduleChatPrewarm, { once: true });
            })();
            {
                const aiScript = document.createElement('script');
                aiScript.src = versioned('js/ai.js');
                let aiSettled = false;
                const fireReady = (ok) => {
                    if (aiSettled)
                        return;
                    aiSettled = true;
                    clearTimeout(aiTimer);
                    if (ok) {
                        console.log('js/ai.js loaded');
                        if (SS) {
                            SS.markReady('ai', { file: 'js/ai.js' });
                            SS.markReady('app', {});
                        }
                    }
                    else {
                        console.error('[loader] js/ai.js failed or timed out — falling back');
                        if (SS)
                            SS.markReady('app', { ai: false });
                    }
                    window.dispatchEvent(new Event('ss-ready'));
                    const scheduleDashboard = window.requestIdleCallback
                        ? (cb) => window.requestIdleCallback(cb, { timeout: 3500 })
                        : (cb) => window.setTimeout(cb, 2500);
                    scheduleDashboard(() => {
                        loadDeferredFeatures();
                    });
                };
                const aiTimer = setTimeout(() => fireReady(false), SCRIPT_TIMEOUT_MS);
                aiScript.onload = () => fireReady(true);
                aiScript.onerror = () => fireReady(false);
                document.body.appendChild(aiScript);
            }
        })
            .catch((err) => {
            console.error('Failed to load app scripts:', err);
            if (SS)
                SS.emit('loader:app-script:error', { error: err });
            window.dispatchEvent(new Event('ss-ready'));
        });
    }
    const loadedFeatureSections = {};
    function loadFeatureSection(section) {
        const cached = loadedFeatureSections[section.id];
        if (cached)
            return cached;
        const promise = _fetchTimeout(section.file, 10000)
            .then((r) => {
            if (!r.ok)
                throw new Error('HTTP ' + r.status + ' loading ' + section.file);
            return r.text();
        })
            .then((html) => {
            const target = document.getElementById(section.id);
            if (!target) {
                console.warn('Missing feature section #' + section.id);
                return;
            }
            target.innerHTML = html;
            if (SS)
                SS.emit('feature:html-loaded', { id: section.id, file: section.file });
        })
            .catch((err) => {
            console.error('Error loading ' + section.file + ':', err);
        });
        loadedFeatureSections[section.id] = promise;
        return promise;
    }
    window._ssLoadFeatureSection = function (name) {
        const id = name.startsWith('psec-') ? name : 'psec-' + name;
        const section = FEATURE_SECTIONS.find((item) => item.id === id);
        return section ? loadFeatureSection(section) : Promise.resolve();
    };
    // Fetch all sections in parallel, inject in order
    void Promise.all(SECTIONS.map((filename) => {
        return _fetchTimeout(filename, 10000)
            .then((r) => {
            if (!r.ok)
                throw new Error('HTTP ' + r.status + ' loading ' + filename);
            return r.text();
        })
            .catch((err) => {
            console.error('Error loading ' + filename + ':', err);
            return '';
        });
    })).then((htmls) => {
        htmls.forEach((html, i) => {
            if (!html)
                return;
            const wrapper = document.createElement('div');
            const name = SECTIONS[i];
            if (name)
                wrapper.setAttribute('data-section', name.replace('.html', ''));
            wrapper.innerHTML = html;
            while (wrapper.firstChild)
                root.appendChild(wrapper.firstChild);
        });
        if (SS)
            SS.markReady('sections', { count: htmls.length });
        loadAppScript();
    });
})();
export {};
