// ── Minallo Section Loader ────────────────────────────────────────────────
// Fetches each HTML section file and injects it into the DOM in order,
// then loads app.js and fires 'ss-ready' so supabase.js can do auth init.
// All JS runs in the same window scope — no iframes, no module boundaries.

(function () {
  // ── Session routing ──────────────────────────────────────────────────────
  var SS = window.Minallo;
  var root = document.getElementById('ss-sections-root');
  if (SS) SS.emit('loader:start', { loggedIn: !!window._ssIsLoggedIn });

  // ── Landing translations ─────────────────────────────────────────────────
  var _landingTrans = {
    en: {
      nav_login: 'Login',
      badge: 'BUILT FOR UNIVERSITY STUDENTS',
      h1: 'Study smarter,<br>not harder.',
      subtitle:
        'One workspace for courses, PDFs, your AI tutor and lecture notes. Stop switching tabs — start understanding.',
      cta: 'Start for free →',
      note: 'Free forever · No credit card needed',
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
      cta2_btn: 'Create your free account →',
      stats_rating: 'Average rating',
      stats_students: 'Students',
      stats_pdfs: 'PDFs analysed',
      reviews_label: 'What students say',
      reviews_title: 'Loved by students',
      footer_signin: 'Sign in'
    },
    de: {
      nav_login: 'Anmelden',
      badge: 'FÜR UNIVERSITÄTSSTUDENTEN',
      h1: 'Klüger studieren,<br>nicht härter.',
      subtitle:
        'Ein Arbeitsbereich für Kurse, PDFs, deinen KI-Tutor und Vorlesungsnotizen. Höre auf, Tabs zu wechseln — fange an zu verstehen.',
      cta: 'Kostenlos starten →',
      note: 'Für immer kostenlos · Keine Kreditkarte nötig',
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
      footer_signin: 'Anmelden'
    }
  };

  var _landingLang = localStorage.getItem('ss_lang') || 'en';

  function applyLandingTranslation(lang) {
    _landingLang = lang === 'de' ? 'de' : 'en';
    localStorage.setItem('ss_lang', _landingLang);
    var t = _landingTrans[_landingLang];

    // Nav
    var loginBtn = root.querySelector('[data-i18n="landing_nav_login"]');
    if (loginBtn) loginBtn.textContent = t.nav_login;
    var langBtn = document.getElementById('landingLangBtn');
    if (langBtn) langBtn.textContent = _landingLang === 'de' ? 'EN' : 'DE';

    // Hero
    var badge = root.querySelector('.hero-badge');
    if (badge) {
      var dot = badge.querySelector('.hero-badge-dot');
      badge.textContent = t.badge;
      if (dot) badge.insertBefore(dot, badge.firstChild);
    }
    var h1 = root.querySelector('.hero-text h1');
    if (h1) {
      h1.textContent = '';
      String(t.h1 || '').split(/<br\s*\/?>/i).forEach(function (part, i) {
        if (i) h1.appendChild(document.createElement('br'));
        h1.appendChild(document.createTextNode(part));
      });
    }
    var heroPara = root.querySelector('.hero-text > p');
    if (heroPara) heroPara.textContent = t.subtitle;
    var heroCta = root.querySelector('a.hero-cta');
    if (heroCta) heroCta.textContent = t.cta;
    var heroNote = root.querySelector('.hero-note');
    if (heroNote) heroNote.textContent = t.note;

    // Features section labels
    var sectionLabel = root.querySelector('.section-label.fade-in');
    if (sectionLabel) sectionLabel.textContent = t.features_label;
    var sectionTitle = root.querySelector('.section-title.fade-in');
    if (sectionTitle) sectionTitle.textContent = t.features_title;

    // Feature cards
    var cards = root.querySelectorAll('.glass-card');
    var descs = [t.f1_desc, t.f2_desc, t.f3_desc, t.f4_desc, t.f5_desc, t.f6_desc];
    var titles = [t.f1_title, t.f2_title, t.f3_title, t.f4_title, t.f5_title, t.f6_title];
    cards.forEach(function (card, i) {
      if (i >= titles.length) return;
      var h3 = card.querySelector('h3');
      var p = card.querySelector('p');
      if (h3) h3.textContent = titles[i];
      if (p) p.textContent = descs[i];
    });

    // CTA section
    var ctaBox = root.querySelector('.cta-box');
    if (ctaBox) {
      var ctaH2 = ctaBox.querySelector('h2');
      var ctaP = ctaBox.querySelector('p');
      var ctaBtn = ctaBox.querySelector('button');
      if (ctaH2) ctaH2.textContent = t.cta2_title;
      if (ctaP) ctaP.textContent = t.cta2_desc;
      if (ctaBtn) ctaBtn.textContent = t.cta2_btn;
    }

    // Stats row labels
    var statSpans = root.querySelectorAll('#ratings .ratings-label');
    var statLabels = [t.stats_rating, t.stats_students, t.stats_pdfs];
    statSpans.forEach(function (el, i) {
      if (statLabels[i]) el.textContent = statLabels[i];
    });

    // Reviews heading
    var reviewsLabel = root.querySelector('#ratings .reviews-kicker');
    if (reviewsLabel) reviewsLabel.textContent = t.reviews_label;
    var reviewsTitle = root.querySelector('#ratings .reviews-title');
    if (reviewsTitle) reviewsTitle.textContent = t.reviews_title;

    // Footer sign-in link
    var footerLink = root.querySelector('footer a');
    if (footerLink) footerLink.textContent = t.footer_signin;
  }

  // Public toggle — called by the language button in landing.html
  window._toggleLandingLang = function () {
    applyLandingTranslation(_landingLang === 'en' ? 'de' : 'en');
  };

  if (!window._ssIsLoggedIn) {
    // Load landing-specific CSS before rendering the page
    (function () {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'css/landing.css?v=5';
      document.head.appendChild(link);
    })();

    fetch('pages/landing.html')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' loading landing.html');
        return r.text();
      })
      .then(function (html) {
        root.innerHTML = html;
        document.body.classList.add('landing');
        if (SS) SS.markReady('landing', { file: 'pages/landing.html' });
        console.log('✓ Landing page loaded');

        // Re-run fade-in observer — scripts inside landing.html don't execute via innerHTML
        var fadeObserver = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              if (e.isIntersecting) {
                e.target.classList.add('visible');
                fadeObserver.unobserve(e.target);
              }
            });
          },
          { threshold: 0.12 }
        );
        root.querySelectorAll('.fade-in').forEach(function (el) {
          fadeObserver.observe(el);
        });

        // Back-to-top button scroll handler (hover is handled by landing.css)
        var backBtn = document.getElementById('backToTop');
        if (backBtn) {
          window.addEventListener('scroll', function () {
            backBtn.style.display = window.scrollY > 400 ? 'flex' : 'none';
          });
          backBtn.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }

        // Apply saved language
        applyLandingTranslation(_landingLang);

        var landingLangBtn = document.getElementById('landingLangBtn');
        if (landingLangBtn) {
          landingLangBtn.addEventListener('click', function () {
            if (typeof window._toggleLandingLang === 'function') window._toggleLandingLang();
          });
        }
        ['landingLoginBtn', 'landingHeroStartBtn', 'landingCtaBtn', 'landingFooterSignin'].forEach(
          function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('click', function (e) {
              e.preventDefault();
              if (typeof window._googleAuth === 'function') window._googleAuth();
            });
          }
        );
        var seeHowBtn = document.getElementById('landingSeeHowBtn');
        if (seeHowBtn) {
          seeHowBtn.addEventListener('click', function (e) {
            e.preventDefault();
            var section = document.querySelector('.section');
            if (section) section.scrollIntoView({ behavior: 'smooth' });
          });
        }
      })
      .catch(function (err) {
        console.error('✗ Could not load landing.html:', err);
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

  var SECTIONS = [
    'pages/auth.html',
    'pages/signup.html',
    'features/toast/toast.html',
    'pages/portal.html',
    'pages/modals.html'
  ];

  var FEATURE_SECTIONS = [
    { id: 'psec-profile', file: 'features/profile/profile.html' },
    { id: 'psec-settings', file: 'features/settings/settings.html' },
    { id: 'psec-subscription', file: 'features/subscription/subscription.html' }
  ];

  // Inject feature CSS
  (function () {
    [
      'features/toast/toast.css',
      'features/chatbot/chatbot.css',
      'features/chatbot/ai-bubble.css',
      'features/chat/chat.css',
      'features/dashboard/dashboard.css',
      'features/practice/practice.css',
      'features/flashcards/flashcards.css',
      'features/quiz/quiz.css',
      'features/lecturenotes/lecturenotes.css',
      'features/profile/profile.css',
      'features/settings/settings.css',
      'features/subscription/subscription.css',
      'features/editor/editor.css',
      'features/games/games.css',
      'features/notes/notes-panel.css'
    ].forEach(function (href) {
      var link = document.createElement('link');
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
    var _v = Date.now();
    if (SS) SS.emit('loader:app-script:start', {});

    function loadScript(src, readyKey, options) {
      return new Promise(function (resolve, reject) {
        options = options || {};
        var script = document.createElement('script');
        if (options.type) script.type = options.type;
        script.src = src + '?v=' + _v;
        script.onload = function () {
          if (SS && readyKey) SS.markReady(readyKey, { file: src });
          resolve();
        };
        script.onerror = function () {
          reject(new Error('Failed to load ' + src));
        };
        document.body.appendChild(script);
      });
    }

    // Load dependency helpers and early feature globals first, then app/router.
    loadScript('js/dependencies.js', 'dependencies-script')
      .then(function () {
        return loadScript('features/subscription/subscription.js', 'subscription-script');
      })
      .then(function () {
        // app-data.js must load before app.js — it declares SEMS, COLORS, MAJOR_LIST, SUBJECT_LIST
        return loadScript('js/app-data.js', 'app-data-script');
      })
      .then(function () {
        return loadScript('js/main.js', 'app-script', { type: 'module' });
      })
      .then(function () {
        // app-storage.js and app-pdf.js extend app.js globals — load after app.js
        return Promise.all([
          loadScript('js/app-storage.js', 'app-storage-script'),
          loadScript('js/app-pdf.js', 'app-pdf-script')
        ]);
      })
      .then(function () {
        console.log('app.js + modules loaded');
        return loadScript('js/router.js', 'router-script');
      })
      .then(function () {
        // Feature scripts load AFTER app.js so _init() can safely call app globals.
        // Track all loads so ss-ready only fires after every feature script is done.
        // Game sub-modules (tetris/solitaire/bird/chess) must load before games.js (hub)
        // so their window.* functions are defined when games.js _init() wires the buttons.
        var featureSrcs = [
          'features/toast/toast.js',
          'features/chatbot/chatbot.js?v=2',
          'features/chatbot/ai-bubble.js?v=2',
          'features/chat/chat.js',
          'features/dashboard/dashboard-widget.js',
          'features/dashboard/dashboard-calendar.js',
          'js/utils/db-helpers.js',
          'features/practice/practice.js',
          'features/flashcards/flashcards.js',
          'features/quiz/quiz.js',
          'features/lecturenotes/lecturenotes.js',
          'features/profile/profile.js',
          'features/settings/settings.js',
          'features/editor/editor.js',
          'features/editor/merger.js',
          'features/editor/writer.js',
          'features/notes/notes-panel.js',
          'features/games/games-tetris.js',
          'features/games/games-solitaire-shared.js',
          'features/games/games-solitaire-klondike.js',
          'features/games/games-solitaire-spider.js',
          'features/games/games-solitaire-scorpion.js',
          'features/games/games-solitaire-freecell.js',
          'features/games/games-solitaire-pyramid.js',
          'features/games/games-solitaire-tripeaks.js',
          'features/games/games-solitaire-vegas.js',
          'features/games/games-solitaire-dispatcher.js',
          'features/games/games-bird.js',
          'features/games/games-chess.js',
          'features/games/games.js'
        ];
        var featurePromises = featureSrcs.map(function (src) {
          return new Promise(function (res) {
            var s = document.createElement('script');
            s.src = src + '?v=' + _v;
            s.onload = res;
            s.onerror = function () {
              console.error('Failed to load feature script:', src);
              res();
            };
            document.body.appendChild(s);
          });
        });

        Promise.all(featurePromises).then(function () {
          var aiScript = document.createElement('script');
          aiScript.src = 'ai/ai.js?v=' + _v;
          aiScript.onload = function () {
            console.log('ai/ai.js loaded');
            if (SS) {
              SS.markReady('ai', { file: 'ai/ai.js' });
              SS.markReady('app', {});
            }
            window.dispatchEvent(new Event('ss-ready'));
          };
          aiScript.onerror = function () {
            console.error('Failed to load ai/ai.js — falling back');
            if (SS) SS.markReady('app', { ai: false });
            window.dispatchEvent(new Event('ss-ready'));
          };
          document.body.appendChild(aiScript);
        });
      })
      .catch(function (err) {
        console.error('Failed to load app scripts:', err);
        if (SS) SS.emit('loader:app-script:error', { error: err });
        window.dispatchEvent(new Event('ss-ready'));
      });
  }

  function loadFeatureSections() {
    return Promise.all(
      FEATURE_SECTIONS.map(function (section) {
        return fetch(section.file)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + section.file);
            return r.text();
          })
          .then(function (html) {
            var target = document.getElementById(section.id);
            if (!target) {
              console.warn('Missing feature section #' + section.id);
              return;
            }
            target.innerHTML = html;
            if (SS) SS.emit('feature:html-loaded', { id: section.id, file: section.file });
          })
          .catch(function (err) {
            console.error('Error loading ' + section.file + ':', err);
          });
      })
    );
  }

  // Fetch all sections in parallel, inject in order
  Promise.all(
    SECTIONS.map(function (filename) {
      return fetch(filename)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + filename);
          return r.text();
        })
        .catch(function (err) {
          console.error('Error loading ' + filename + ':', err);
          return '';
        });
    })
  ).then(function (htmls) {
    htmls.forEach(function (html, i) {
      if (!html) return;
      var wrapper = document.createElement('div');
      wrapper.setAttribute('data-section', SECTIONS[i].replace('.html', ''));
      wrapper.innerHTML = html;
      while (wrapper.firstChild) root.appendChild(wrapper.firstChild);
    });
    if (SS) SS.markReady('sections', { count: htmls.length });
    loadFeatureSections().then(function () {
      if (SS) SS.markReady('feature-sections', { count: FEATURE_SECTIONS.length });
      loadAppScript();
    });
  });
})();
