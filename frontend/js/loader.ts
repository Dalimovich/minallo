// ── Minallo Section Loader ────────────────────────────────────────────────
// Fetches each HTML section file and injects it into the DOM in order,
// then loads app.js and fires 'ss-ready' so supabase.js can do auth init.
// All JS runs in the same window scope — no iframes, no module boundaries.

interface LandingTranslation {
  nav_login: string;
  badge: string;
  h1: string;
  subtitle: string;
  cta: string;
  note: string;
  features_label: string;
  features_title: string;
  f1_title: string;
  f1_desc: string;
  f2_title: string;
  f2_desc: string;
  f3_title: string;
  f3_desc: string;
  f4_title: string;
  f4_desc: string;
  f5_title: string;
  f5_desc: string;
  f6_title: string;
  f6_desc: string;
  cta2_title: string;
  cta2_desc: string;
  cta2_btn: string;
  stats_rating: string;
  stats_students: string;
  stats_pdfs: string;
  reviews_label: string;
  reviews_title: string;
  footer_signin: string;
}

(function (): void {
  // ── Session routing ──────────────────────────────────────────────────────
  const SS = window.Minallo;
  const root = document.getElementById('ss-sections-root');
  if (!root) {
    console.error('[loader] #ss-sections-root missing');
    return;
  }
  if (SS) SS.emit('loader:start', { loggedIn: !!window._ssIsLoggedIn });

  // ── Landing translations ─────────────────────────────────────────────────
  const _landingTrans: Record<'en' | 'de', LandingTranslation> = {
    en: {
      nav_login: 'Login',
      badge: 'BUILT FOR UNIVERSITY STUDENTS',
      h1: 'Study smarter,<br>not harder.',
      subtitle:
        'One workspace for courses, PDFs, your AI tutor and lecture notes. Stop switching tabs — start understanding.',
      cta: 'Start free trial →',
      note: '7-day free trial · Cancel anytime',
      features_label: 'What you get',
      features_title: 'Everything you need to ace your degree',
      f1_title: 'Smart PDF Viewer',
      f1_desc:
        'Ask the AI to explain formulas, summarise sections or answer questions — based on the actual document.',
      f2_title: 'AI Study Assistant',
      f2_desc:
        'Select any text and get instant explanations, examples and step-by-step solutions from your 24/7 tutor.',
      f3_title: 'Lecture Summaries',
      f3_desc:
        'Watch on YouTube or Opencast and auto-generate structured notes with the browser extension.',
      f4_title: 'Course Dashboard',
      f4_desc:
        'Subjects, files, timetable, forum and appointments. No more hunting through Stud.IP tabs.',
      f5_title: 'Chat History Per PDF',
      f5_desc:
        'Every AI conversation saved per file. Pick up exactly where you left off — on any device.',
      f6_title: 'Secure & Private',
      f6_desc:
        'Row-level security via Supabase. Only you can see your notes, settings and profile. Always.',
      cta2_title: 'Ready to study smarter?',
      cta2_desc:
        'Join thousands of students already using Minallo to save time, understand more and stress less.',
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
      subtitle:
        'Ein Arbeitsbereich für Kurse, PDFs, deinen KI-Tutor und Vorlesungsnotizen. Höre auf, Tabs zu wechseln — fange an zu verstehen.',
      cta: 'Kostenlos starten →',
      note: '7 Tage kostenlos testen · Jederzeit kündbar',
      features_label: 'Was du bekommst',
      features_title: 'Alles, was du für deinen Abschluss brauchst',
      f1_title: 'Intelligenter PDF-Viewer',
      f1_desc:
        'Bitte die KI, Formeln zu erklären, Abschnitte zusammenzufassen oder Fragen zu beantworten — basierend auf dem Dokument.',
      f2_title: 'KI-Lernassistent',
      f2_desc:
        'Markiere Text und erhalte sofortige Erklärungen, Beispiele und Schritt-für-Schritt-Lösungen von deinem 24/7-Tutor.',
      f3_title: 'Vorlesungszusammenfassungen',
      f3_desc:
        'Schaue auf YouTube oder Opencast und generiere automatisch strukturierte Notizen mit der Browsererweiterung.',
      f4_title: 'Kurs-Dashboard',
      f4_desc: 'Fächer, Dateien, Stundenplan, Forum und Termine. Kein Suchen mehr in Stud.IP-Tabs.',
      f5_title: 'Chatverlauf pro PDF',
      f5_desc:
        'Jedes KI-Gespräch wird pro Datei gespeichert. Mache genau dort weiter, wo du aufgehört hast — auf jedem Gerät.',
      f6_title: 'Sicher & Privat',
      f6_desc:
        'Zeilensicherheit über Supabase. Nur du kannst deine Notizen, Einstellungen und dein Profil sehen. Immer.',
      cta2_title: 'Bereit, klüger zu studieren?',
      cta2_desc:
        'Schließe dich Tausenden von Studierenden an, die bereits Minallo nutzen, um Zeit zu sparen und mehr zu verstehen.',
      cta2_btn: 'Kostenloses Konto erstellen →',
      stats_rating: 'Durchschnittsbewertung',
      stats_students: 'Studierende',
      stats_pdfs: 'Analysierte PDFs',
      reviews_label: 'Was Studierende sagen',
      reviews_title: 'Geliebt von Studierenden',
      footer_signin: 'Anmelden',
    },
  };

  let _landingLang: 'en' | 'de' = localStorage.getItem('ss_lang') === 'de' ? 'de' : 'en';

  function applyLandingTranslation(lang: string): void {
    _landingLang = lang === 'de' ? 'de' : 'en';
    localStorage.setItem('ss_lang', _landingLang);
    const t = _landingTrans[_landingLang];
    if (!root) return;

    // Nav
    const loginBtn = root.querySelector('[data-i18n="landing_nav_login"]');
    if (loginBtn) loginBtn.textContent = t.nav_login;
    const langBtn = document.getElementById('landingLangBtn');
    if (langBtn) langBtn.textContent = _landingLang === 'de' ? 'EN' : 'DE';

    // Hero
    const badge = root.querySelector('.hero-badge');
    if (badge) {
      const dot = badge.querySelector('.hero-badge-dot');
      badge.textContent = t.badge;
      if (dot) badge.insertBefore(dot, badge.firstChild);
    }
    const h1 = root.querySelector('.hero-text h1');
    if (h1) {
      h1.textContent = '';
      String(t.h1 || '')
        .split(/<br\s*\/?>/i)
        .forEach((part, i) => {
          if (i) h1.appendChild(document.createElement('br'));
          h1.appendChild(document.createTextNode(part));
        });
    }
    const heroPara = root.querySelector('.hero-text > p');
    if (heroPara) heroPara.textContent = t.subtitle;
    const heroCta = root.querySelector('a.hero-cta');
    if (heroCta) heroCta.textContent = t.cta;
    const heroNote = root.querySelector('.hero-note');
    if (heroNote) heroNote.textContent = t.note;

    // Features section labels
    const sectionLabel = root.querySelector('.section-label.fade-in');
    if (sectionLabel) sectionLabel.textContent = t.features_label;
    const sectionTitle = root.querySelector('.section-title.fade-in');
    if (sectionTitle) sectionTitle.textContent = t.features_title;

    // Feature cards
    const cards = root.querySelectorAll('.glass-card');
    const descs = [t.f1_desc, t.f2_desc, t.f3_desc, t.f4_desc, t.f5_desc, t.f6_desc];
    const titles = [t.f1_title, t.f2_title, t.f3_title, t.f4_title, t.f5_title, t.f6_title];
    cards.forEach((card, i) => {
      if (i >= titles.length) return;
      const h3 = card.querySelector('h3');
      const p = card.querySelector('p');
      if (h3) h3.textContent = titles[i] ?? '';
      if (p) p.textContent = descs[i] ?? '';
    });

    // CTA section
    const ctaBox = root.querySelector('.cta-box');
    if (ctaBox) {
      const ctaH2 = ctaBox.querySelector('h2');
      const ctaP = ctaBox.querySelector('p');
      const ctaBtn = ctaBox.querySelector('button');
      if (ctaH2) ctaH2.textContent = t.cta2_title;
      if (ctaP) ctaP.textContent = t.cta2_desc;
      if (ctaBtn) ctaBtn.textContent = t.cta2_btn;
    }

    // Stats row labels
    const statSpans = root.querySelectorAll('#ratings .ratings-label');
    const statLabels = [t.stats_rating, t.stats_students, t.stats_pdfs];
    statSpans.forEach((el, i) => {
      const label = statLabels[i];
      if (label) el.textContent = label;
    });

    // Reviews heading
    const reviewsLabel = root.querySelector('#ratings .reviews-kicker');
    if (reviewsLabel) reviewsLabel.textContent = t.reviews_label;
    const reviewsTitle = root.querySelector('#ratings .reviews-title');
    if (reviewsTitle) reviewsTitle.textContent = t.reviews_title;

    // Footer sign-in link
    const footerLink = root.querySelector('footer a');
    if (footerLink) footerLink.textContent = t.footer_signin;
  }

  // Public toggle — called by the language button in landing.html
  window._toggleLandingLang = function (): void {
    applyLandingTranslation(_landingLang === 'en' ? 'de' : 'en');
  };

  if (!window._ssIsLoggedIn) {
    // Load new-landing CSS before rendering the page. The old landing.css
    // remains in the repo (frontend/css/landing.css) but is no longer
    // injected — the new landing replaces it visually.
    (function () {
      function ensureStylesheet(href: string): void {
        const path = href.split('?')[0] || href;
        const exists = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some((link) => {
          const current = link.getAttribute('href') || '';
          const currentPath = current.split('?')[0] || current;
          return current === href || currentPath.endsWith(path);
        });
        if (exists) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      }
      ensureStylesheet('css/new-landing.css?v=1');
      ensureStylesheet('css/auth.css?v=4');
    })();

    fetch('pages/new_landing.html')
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' loading new_landing.html');
        return r.text();
      })
      .then((html) => {
        root.innerHTML = html;
        document.body.classList.add('nl-body');
        // Inject the new-landing JS module after the fragment lands so it
        // can find its #/data-* hooks on first query.
        (function () {
          const script = document.createElement('script');
          script.src = 'js/pages/new-landing.js?v=1';
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
        (function injectGsiClient(): void {
          if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) return;
          const gsi = document.createElement('script');
          gsi.src = 'https://accounts.google.com/gsi/client';
          gsi.async = true;
          gsi.defer = true;
          document.head.appendChild(gsi);
        })();
        if (SS) SS.markReady('landing', { file: 'pages/new_landing.html' });
        console.log('✓ New landing page loaded');

        // Re-run fade-in observer — scripts inside landing.html don't execute via innerHTML
        const fadeObserver = new IntersectionObserver(
          (entries) => {
            entries.forEach((e) => {
              if (e.isIntersecting) {
                e.target.classList.add('visible');
                fadeObserver.unobserve(e.target);
              }
            });
          },
          { threshold: 0.12 }
        );
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
            if (typeof window._toggleLandingLang === 'function') window._toggleLandingLang();
          });
        }
        ['landingLoginBtn', 'landingHeroStartBtn', 'landingCtaBtn', 'landingFooterSignin'].forEach(
          (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('click', (e) => {
              e.preventDefault();
              if (typeof window._googleAuth === 'function') window._googleAuth();
            });
          }
        );
        const seeHowBtn = document.getElementById('landingSeeHowBtn');
        if (seeHowBtn) {
          seeHowBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const section = document.querySelector('.section');
            if (section) section.scrollIntoView({ behavior: 'smooth' });
          });
        }
      })
      .catch((err: unknown) => {
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

  interface FeatureSection {
    id: string;
    file: string;
  }
  const FEATURE_SECTIONS: FeatureSection[] = [
    { id: 'psec-profile', file: 'views/profile/profile.html' },
    { id: 'psec-settings', file: 'views/settings/settings.html' },
    { id: 'psec-subscription', file: 'views/subscription/subscription.html' },
  ];

  // Inject feature CSS
  (function () {
    [
      'css/base.css?v=5',
      'css/theme.css?v=5',
      'css/styles.css?v=18',
      'css/courses-redesign.css?v=34',
      'css/app-design-system.css?v=5',
      'css/layout.css?v=7',
      'css/document-rail.css?v=15',
      'css/auth.css?v=4',
      'css/onboarding.css?v=1',
      'views/toast/toast.css',
      'views/chatbot/chatbot.css',
      'views/chatbot/ai-bubble.css',
      'views/chat/chat.css',
      'views/dashboard/dashboard.css',
      'views/practice/practice.css',
      'views/writing-coach/writing-coach.css',
      'views/flashcards/flashcards.css',
      'views/quiz/quiz.css',
      'views/lecturenotes/lecturenotes.css',
      'views/profile/profile.css',
      'views/settings/settings.css',
      'views/subscription/subscription.css',
      'views/editor/editor.css',
      'views/games/games.css',
      'views/notes/notes-panel.css',
      // Light-mode polish loads LAST so it wins source-order ties
      // against feature CSS that still hard-codes greys.
      'css/light-mode.css?v=43',
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
    window._t = function (key: string): string {
      return key;
    };
  }

  interface LoadScriptOptions {
    type?: string;
  }

  function loadAppScript(): void {
    const _v = String(window.MinalloConfig?.assetVersion || SS?.version || '1');
    if (SS) SS.emit('loader:app-script:start', {});

    function versioned(src: string): string {
      return src + (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(_v);
    }

    function loadScript(src: string, readyKey: string, options?: LoadScriptOptions): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const opts = options || {};
        const script = document.createElement('script');
        if (opts.type) script.type = opts.type;
        script.src = versioned(src);
        script.onload = () => {
          if (SS && readyKey) SS.markReady(readyKey, { file: src });
          resolve();
        };
        script.onerror = () => {
          reject(new Error('Failed to load ' + src));
        };
        document.body.appendChild(script);
      });
    }

    // Load dependency helpers and early feature globals first, then app/router.
    loadScript('js/dependencies.js', 'dependencies-script')
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
          'views/chatbot/chatbot.js?v=2',
          'views/chatbot/ai-bubble.js?v=4',
          'views/chat/chat.js',
          'views/dashboard/dashboard-widget.js',
          'views/dashboard/dashboard-calendar.js',
          'js/utils/db-helpers.js',
          'views/practice/practice.js',
          'views/flashcards/flashcards.js',
          'views/quiz/quiz.js',
          'views/lecturenotes/lecturenotes.js',
          'views/profile/profile.js',
          'views/settings/settings.js',
          'views/editor/editor.js',
          'views/editor/merger.js',
          'views/editor/writer.js',
          'views/notes/notes-panel.js',
        ];
        const featurePromises = featureSrcs.map((src) => {
          return new Promise<void>((res) => {
            const s = document.createElement('script');
            s.src = versioned(src);
            s.onload = () => res();
            s.onerror = () => {
              console.error('Failed to load feature script:', src);
              res();
            };
            document.body.appendChild(s);
          });
        });

        // Games hub: ~150KB across 13 scripts (8 solitaire variants, tetris,
        // bird, chess, hub dispatcher). Most users never open the games page
        // in a session — defer to first click on the games nav.
        // Sub-modules (tetris/solitaire/bird/chess) must load before games.js
        // (hub) so their window.* functions are defined when games.js _init()
        // wires the buttons — we therefore load them sequentially.
        (function setupGamesLazy(): void {
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
          function loadGames(): void {
            if (loaded) return;
            loaded = true;
            GAMES_SCRIPTS.reduce<Promise<void>>(
              (p, src) => p.then(() => new Promise<void>((res) => {
                const s = document.createElement('script');
                s.src = versioned(src);
                s.onload = (): void => res();
                s.onerror = (): void => { console.error('lazy-games failed:', src); res(); };
                document.body.appendChild(s);
              })),
              Promise.resolve()
            );
          }
          function bindTrigger(): boolean {
            const btn = document.getElementById('psbGames');
            if (!btn) return false;
            btn.addEventListener('click', loadGames, { once: true });
            return true;
          }
          if (!bindTrigger()) {
            // Section HTML may still be injecting — retry until the nav button exists.
            const obs = new MutationObserver(() => {
              if (bindTrigger()) obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
          }
        })();

        void Promise.all(featurePromises).then(() => {
          const aiScript = document.createElement('script');
          aiScript.src = versioned('js/ai.js');
          aiScript.onload = () => {
            console.log('js/ai.js loaded');
            if (SS) {
              SS.markReady('ai', { file: 'js/ai.js' });
              SS.markReady('app', {});
            }
            window.dispatchEvent(new Event('ss-ready'));
          };
          aiScript.onerror = () => {
            console.error('Failed to load js/ai.js — falling back');
            if (SS) SS.markReady('app', { ai: false });
            window.dispatchEvent(new Event('ss-ready'));
          };
          document.body.appendChild(aiScript);
        });
      })
      .catch((err: unknown) => {
        console.error('Failed to load app scripts:', err);
        if (SS) SS.emit('loader:app-script:error', { error: err });
        window.dispatchEvent(new Event('ss-ready'));
      });
  }

  function loadFeatureSections(): Promise<unknown> {
    return Promise.all(
      FEATURE_SECTIONS.map((section) => {
        return fetch(section.file)
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + section.file);
            return r.text();
          })
          .then((html) => {
            const target = document.getElementById(section.id);
            if (!target) {
              console.warn('Missing feature section #' + section.id);
              return;
            }
            target.innerHTML = html;
            if (SS) SS.emit('feature:html-loaded', { id: section.id, file: section.file });
          })
          .catch((err: unknown) => {
            console.error('Error loading ' + section.file + ':', err);
          });
      })
    );
  }

  // Fetch all sections in parallel, inject in order
  void Promise.all(
    SECTIONS.map((filename) => {
      return fetch(filename)
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + filename);
          return r.text();
        })
        .catch((err: unknown) => {
          console.error('Error loading ' + filename + ':', err);
          return '';
        });
    })
  ).then((htmls) => {
    htmls.forEach((html, i) => {
      if (!html) return;
      const wrapper = document.createElement('div');
      const name = SECTIONS[i];
      if (name) wrapper.setAttribute('data-section', name.replace('.html', ''));
      wrapper.innerHTML = html;
      while (wrapper.firstChild) root.appendChild(wrapper.firstChild);
    });
    if (SS) SS.markReady('sections', { count: htmls.length });
    void loadFeatureSections().then(() => {
      if (SS) SS.markReady('feature-sections', { count: FEATURE_SECTIONS.length });
      loadAppScript();
    });
  });
})();

export {};
