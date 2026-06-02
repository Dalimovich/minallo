/* new-landing.js — interactivity layer for the standalone Minallo landing page.
 * Single self-contained IIFE. No imports, no globals beyond a single init flag.
 * Behaviors:
 *   A. Mobile nav toggle           (initMobileNav)
 *   B. Path picker swap            (initPathPicker)
 *   C. Tutor preview tab highlight (initTutorPreviewTabs)
 *   D. Scroll-triggered fade-in    (initRevealOnScroll)
 *   E. Hero halo parallax          (initHeroParallax)
 *   F. Footer current year         (initFooterYear)
 *   G. CTA wiring                  (initCtaButtons)
 *   H. EN/DE language toggle       (initLangToggle + applyLang)
 * Honors prefers-reduced-motion.
 */
(function () {
  'use strict';

  if (window.__nlLandingInited) return;
  window.__nlLandingInited = true;

  var prefersReducedMotion = (function () {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_e) {
      return false;
    }
  })();

  // ---- i18n dictionary --------------------------------------------------
  // German tone: informal "du" / imperative, gender-neutral plural ("Studierende")
  // where group is referenced. Mirrors the old landing's voice.
  var I18N = {
    en: {
      logo: { tag: 'Study with clarity' },
      nav: {
        features: 'Features',
        paths: 'Paths',
        tutor: 'Tutor',
        workflow: 'Workspace',
        pricing: 'Pricing',
        signIn: 'Sign in',
        startFree: 'Start free trial'
      },
      hero: {
        badge: 'AI study workspace for real course material',
        title: 'Study from your own lectures, not generic answers.',
        subtitle: 'Upload PDFs, lecture notes, exercises, and formula sheets. Minallo helps you understand the material, solve problems step by step, cite the source pages, and keep your study routine organized.',
        buildCta: 'Start studying with Minallo',
        watchCta: 'Watch preview',
        stats: {
          pdf: 'Upload, annotate, summarize, and organize course PDFs',
          ai: 'AI answers grounded in your uploaded study material',
          focusLabel: 'Focus',
          focus: 'Pomodoro, playlists, games, and streaks to keep momentum'
        }
      },
      tutorPreview: {
        workspace: 'Workspace',
        courseMaterials: 'Course materials',
        synced: 'Synced',
        tabs: { lecture: 'Lecture PDF', exercise: 'Exercise', formula: 'Formula sheet' },
        smartRetrieval: 'Smart retrieval',
        tutorName: 'Minallo AI Tutor',
        mode: 'Course-grounded answer',
        userMsg: 'Solve exercise 6 using my lecture method and cite the formula.',
        aiMsg: 'The exercise uses the equilibrium method from your lecture. Start with the force balance, then substitute the values from the exercise sheet. The formula is confirmed in your formula sheet.',
        cite1: 'Citation: Lecture 03 · page 12',
        cite2: 'Citation: Formula sheet · page 2',
        miniSources: 'Sources',
        miniVerified: 'Verified',
        miniGuessing: 'Unsupported claims'
      },
      features: {
        eyebrow: 'Features',
        title: 'A cleaner way to study with your course files.',
        lead: 'Minallo turns scattered PDFs, exercises, notes, and revision tools into one focused workspace for understanding, practice, and exam preparation.',
        cards: [
          { title: 'AI tutor for your course', text: 'Ask questions about uploaded lectures, exercises, and formula sheets and get answers shaped around the material your professor gave you.' },
          { title: 'Sources you can verify', text: 'Important answers include document and page references, so you can check the original PDF instead of trusting a black-box explanation.' },
          { title: 'Focus tools built in', text: 'Pomodoro sessions, study streaks, and progress signals help you keep working instead of only collecting files.' },
          { title: 'Honest when context is missing', text: 'If the uploaded material is incomplete, Minallo explains what is missing and asks for the right file, page, or exercise number.' },
          { title: 'Connect lectures, exercises, and formulas', text: 'Minallo can bring together the task, the professor’s method, and the formula sheet in one structured explanation.' },
          { title: 'Faster repeated study help', text: 'When the same course question comes back, Minallo can reuse a verified answer instead of starting from zero.' },
          { title: 'German learner mode', text: 'Practice vocabulary, grammar, examples, and revision games in a dedicated language-learning space.' },
          { title: 'Playlists while studying', text: 'Keep your favorite playlists close so long study sessions feel more personal and easier to stay with.' },
          { title: 'Study games for momentum', text: 'Use quick challenges and revision games for short breaks that still keep you connected to learning.' }
        ]
      },
      paths: {
        eyebrow: 'Choose your space',
        title: 'Start with the path that fits your goal.',
        lead: 'Minallo adapts around the way you study: course work for lectures and exams, or a separate German-learning space for daily practice.',
        studentCard: {
          eyebrow: 'Courses',
          title: "I'm a student",
          desc: 'For students who want one place for lecture files, exercises, PDF work, focus sessions, and course-aware AI support.',
          items: [
            'Organize every course, file, and study note',
            'Get AI help with citations from your materials',
            'Edit PDFs, take notes, and stay focused'
          ]
        },
        germanCard: {
          eyebrow: 'Language',
          title: "I'm learning German",
          desc: 'For learners who want vocabulary, grammar explanations, examples, and playful revision without mixing it into course work.',
          items: [
            'Vocabulary and grammar practice',
            'Simple examples and sentence practice',
            'Mini-games for revision and motivation'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Study vibe',
        title: 'A study space you actually want to return to.',
        lead: 'Minallo combines serious study tools with small moments of motivation, so your workspace feels useful, personal, and sustainable.',
        cards: [
          { title: 'Favorite playlists', text: 'Study, revise, or practice German with the music that helps you concentrate.' },
          { title: 'Study games', text: 'Use quick games for vocabulary, revision breaks, and motivation between focused sessions.' },
          { title: 'Streak rewards', text: 'Turn consistent work into visible progress, small wins, and a reason to keep going.' }
        ]
      },
      tutor: {
        eyebrow: 'AI Tutor',
        title: 'An AI tutor that studies the same material you do.',
        lead: 'Minallo starts with the PDF in front of you, searches the wider course when needed, and explains answers using your uploaded lectures, exercises, and formula sheets.',
        items: [
          'Search across lectures, exercises, notes, and formula sheets',
          'Show page-level citations for important answers',
          'Use the open PDF first, then expand to the course',
          'Flag missing context instead of guessing'
        ]
      },
      pipeline: {
        eyebrow: 'How it works',
        title: 'From uploaded PDF to grounded answer',
        steps: [
          { title: 'Upload', text: 'Add lecture PDFs, exercise sheets, notes, and formula collections to your workspace.' },
          { title: 'Understand', text: 'Minallo reads the files into searchable pages, formulas, exercises, and useful metadata.' },
          { title: 'Retrieve', text: 'For each question, Minallo selects the most relevant course context instead of treating every file the same.' },
          { title: 'Answer', text: 'You get a clear explanation with source pages and honest warnings when the material is incomplete.' }
        ]
      },
      workflow: {
        eyebrow: 'Workspace',
        title: 'Everything important stays in one flow.',
        lead: 'Move from course files to explanations, notes, focused work, German practice, and revision without jumping between disconnected tools.',
        cards: [
          { title: 'Ask', text: 'Ask in natural language, even when you only know the page, topic, or exercise.' },
          { title: 'Solve', text: 'Turn difficult exercises into structured steps you can follow and review.' },
          { title: 'Learn', text: 'Practice German vocabulary, grammar, examples, and revision games in a separate space.' },
          { title: 'Stay with it', text: 'Use focus sessions, playlists, games, and streaks to make studying easier to continue.' }
        ]
      },
      quote: {
        title: '"The answer finally matches the way my course explains it."',
        text: 'That is the point of Minallo: course-aware explanations, clear sources, and a workspace that helps students keep going.'
      },
      pricing: {
        eyebrow: 'Pricing',
        title: 'Try the full workspace before you commit.',
        lead: 'Start with a 7-day free trial. Continue with one simple subscription for AI tutoring, document tools, German practice, focus features, playlists, and study games.',
        pro: {
          popular: '7-day free trial',
          name: 'Student Pro',
          sub: 'Everything you need for a focused study routine.',
          per: '/month after trial',
          items: [
            'Course-aware AI tutor with citations',
            'Uploads, notes, summaries, quizzes, and flashcards',
            'PDF editor and study workspace',
            'German learner mode and revision games',
            'Pomodoro, playlists, streaks, and focus dashboard'
          ],
          cta: 'Start 7-day free trial'
        }
      },
      ctaBanner: {
        title: 'Build a study space that understands your material.',
        text: 'Upload your course files, ask better questions, solve exercises with sources, and keep your routine moving with focus tools and revision features.',
        cta: 'Start studying now'
      },
      footer: {
        copyPre: '© ',
        copyPost: ' Minallo. Built for clearer studying and better routines.',
        tutor: 'AI Tutor',
        imprint: 'Impressum',
        privacy: 'Privacy',
        terms: 'Terms',
        withdrawal: 'Withdrawal'
      }
    },
    de: {
      logo: { tag: 'Klarer studieren' },
      nav: {
        features: 'Funktionen',
        paths: 'Bereiche',
        tutor: 'Tutor',
        workflow: 'Workspace',
        pricing: 'Preise',
        signIn: 'Anmelden',
        startFree: 'Kostenlos testen'
      },
      hero: {
        badge: 'KI-Lernworkspace für echte Kursmaterialien',
        title: 'Lerne mit deinen eigenen Vorlesungen, nicht mit generischen Antworten.',
        subtitle: 'Lade PDFs, Vorlesungsnotizen, Übungen und Formelsammlungen hoch. Minallo hilft dir, Inhalte zu verstehen, Aufgaben Schritt für Schritt zu lösen, Quellen zu prüfen und deinen Lernalltag zu organisieren.',
        buildCta: 'Mit Minallo lernen',
        watchCta: 'Vorschau ansehen',
        stats: {
          pdf: 'Kurs-PDFs hochladen, markieren, zusammenfassen und organisieren',
          ai: 'KI-Antworten auf Basis deiner hochgeladenen Materialien',
          focusLabel: 'Fokus',
          focus: 'Pomodoro, Playlists, Spiele und Lernserien für mehr Momentum'
        }
      },
      tutorPreview: {
        workspace: 'Arbeitsbereich',
        courseMaterials: 'Kursmaterialien',
        synced: 'Synchronisiert',
        tabs: { lecture: 'Vorlesungs-PDF', exercise: 'Übung', formula: 'Formelsammlung' },
        smartRetrieval: 'Intelligente Suche',
        tutorName: 'Minallo KI-Tutor',
        mode: 'Kursbasierte Antwort',
        userMsg: 'Löse Übung 6 mit der Methode aus meiner Vorlesung und zitiere die Formel.',
        aiMsg: 'Die Aufgabe nutzt die Gleichgewichtsmethode aus deiner Vorlesung. Beginne mit der Kräftebilanz und setze dann die Werte aus dem Übungsblatt ein. Die Formel ist in deiner Formelsammlung bestätigt.',
        cite1: 'Quellenangabe: Vorlesung 03 · Seite 12',
        cite2: 'Quellenangabe: Formelsammlung · Seite 2',
        miniSources: 'Quellen',
        miniVerified: 'Geprüft',
        miniGuessing: 'Unbelegte Aussagen'
      },
      features: {
        eyebrow: 'Funktionen',
        title: 'Kursdateien lernen sich leichter, wenn alles an einem Ort ist.',
        lead: 'Minallo verwandelt verstreute PDFs, Übungen, Notizen und Wiederholungstools in einen klaren Workspace für Verstehen, Üben und Prüfungsvorbereitung.',
        cards: [
          { title: 'KI-Tutor für deinen Kurs', text: 'Stelle Fragen zu hochgeladenen Vorlesungen, Übungen und Formelsammlungen und erhalte Antworten, die zu deinem Kursmaterial passen.' },
          { title: 'Quellen, die du überprüfen kannst', text: 'Wichtige Antworten enthalten Dokument- und Seitenangaben, damit du direkt im Original-PDF nachsehen kannst.' },
          { title: 'Fokus-Werkzeuge eingebaut', text: 'Pomodoro-Sitzungen, Lernserien und Fortschrittssignale helfen dir, wirklich weiterzuarbeiten statt nur Dateien zu sammeln.' },
          { title: 'Ehrlich, wenn Kontext fehlt', text: 'Wenn hochgeladenes Material unvollständig ist, erklärt Minallo, welche Datei, Seite oder Aufgabennummer fehlt.' },
          { title: 'Vorlesungen, Aufgaben und Formeln verbinden', text: 'Minallo kombiniert Aufgabenstellung, Vorlesungsmethode und Formelsammlung zu einer strukturierten Erklärung.' },
          { title: 'Schnellere Hilfe bei wiederholten Fragen', text: 'Wenn dieselbe Kursfrage erneut auftaucht, kann Minallo eine geprüfte Antwort wiederverwenden.' },
          { title: 'Deutsch-Lernmodus', text: 'Übe Vokabeln, Grammatik, Beispiele und Wiederholungsspiele in einem eigenen Sprachbereich.' },
          { title: 'Playlists beim Lernen', text: 'Behalte deine Lieblings-Playlists in Reichweite, damit lange Lernsessions persönlicher und leichter durchzuhalten sind.' },
          { title: 'Lernspiele für Momentum', text: 'Nutze kurze Challenges und Wiederholungsspiele für Pausen, die dich trotzdem im Lernmodus halten.' }
        ]
      },
      paths: {
        eyebrow: 'Wähle deinen Bereich',
        title: 'Starte mit dem Bereich, der zu deinem Ziel passt.',
        lead: 'Minallo passt sich deinem Lernweg an: Kursarbeit für Vorlesungen und Prüfungen oder ein separater Deutschbereich für tägliche Übung.',
        studentCard: {
          eyebrow: 'Kurse',
          title: 'Ich studiere',
          desc: 'Für Studierende, die einen Ort für Vorlesungsdateien, Übungen, PDF-Arbeit, Fokus-Sessions und kursbasierte KI-Hilfe möchten.',
          items: [
            'Jeden Kurs, jede Datei und jede Lernnotiz organisieren',
            'KI-Hilfe mit Quellenangaben aus deinen Materialien erhalten',
            'PDFs bearbeiten, Notizen schreiben und fokussiert bleiben'
          ]
        },
        germanCard: {
          eyebrow: 'Sprache',
          title: 'Ich lerne Deutsch',
          desc: 'Für Lernende, die Vokabeln, Grammatikerklärungen, Beispiele und spielerische Wiederholung getrennt von Kursarbeit nutzen möchten.',
          items: [
            'Vokabel- und Grammatikübungen',
            'Einfache Beispiele und Satzübungen',
            'Mini-Spiele zur Wiederholung und Motivation'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Lernstimmung',
        title: 'Ein Lernraum, zu dem du gern zurückkommst.',
        lead: 'Minallo kombiniert ernsthafte Lernwerkzeuge mit kleinen Motivationsmomenten, damit dein Workspace nützlich, persönlich und langfristig angenehm bleibt.',
        cards: [
          { title: 'Lieblings-Playlists', text: 'Lerne, wiederhole oder übe Deutsch mit Musik, die dir beim Konzentrieren hilft.' },
          { title: 'Lernspiele', text: 'Nutze kurze Spiele für Vokabeln, Wiederholungspausen und Motivation zwischen Fokus-Sessions.' },
          { title: 'Lernserien-Belohnungen', text: 'Mache regelmäßiges Lernen sichtbar: mit Fortschritt, kleinen Erfolgen und einem Grund weiterzumachen.' }
        ]
      },
      tutor: {
        eyebrow: 'KI-Tutor',
        title: 'Ein KI-Tutor, der mit deinem Material lernt.',
        lead: 'Minallo beginnt mit dem PDF vor dir, durchsucht bei Bedarf den gesamten Kurs und erklärt Antworten anhand deiner hochgeladenen Vorlesungen, Übungen und Formelsammlungen.',
        items: [
          'Über Vorlesungen, Übungen, Notizen und Formelsammlungen suchen',
          'Wichtige Antworten mit Seitenquellen anzeigen',
          'Mit dem geöffneten PDF beginnen und dann auf den Kurs erweitern',
          'Fehlenden Kontext markieren statt zu raten'
        ]
      },
      pipeline: {
        eyebrow: 'So funktioniert es',
        title: 'Vom hochgeladenen PDF zur belegten Antwort',
        steps: [
          { title: 'Hochladen', text: 'Füge Vorlesungs-PDFs, Übungsblätter, Notizen und Formelsammlungen zu deinem Workspace hinzu.' },
          { title: 'Verstehen', text: 'Minallo macht Dateien als Seiten, Formeln, Aufgaben und nützliche Metadaten durchsuchbar.' },
          { title: 'Abrufen', text: 'Für jede Frage wählt Minallo den relevantesten Kurskontext, statt jede Datei gleich zu behandeln.' },
          { title: 'Antworten', text: 'Du bekommst eine klare Erklärung mit Quellen und ehrlichen Hinweisen, wenn Material fehlt.' }
        ]
      },
      workflow: {
        eyebrow: 'Workspace',
        title: 'Alles Wichtige bleibt in einem Fluss.',
        lead: 'Wechsle von Kursdateien zu Erklärungen, Notizen, Fokusarbeit, Deutschübungen und Wiederholung, ohne zwischen getrennten Tools zu springen.',
        cards: [
          { title: 'Fragen', text: 'Frage in natürlicher Sprache, auch wenn du nur Seite, Thema oder Aufgabe kennst.' },
          { title: 'Lösen', text: 'Verwandle schwierige Übungen in strukturierte Schritte, die du nachvollziehen kannst.' },
          { title: 'Lernen', text: 'Übe deutsche Vokabeln, Grammatik, Beispiele und Wiederholungsspiele in einem separaten Bereich.' },
          { title: 'Dranbleiben', text: 'Nutze Fokus-Sessions, Playlists, Spiele und Lernserien, damit Lernen leichter weitergeht.' }
        ]
      },
      quote: {
        title: '„Die Antwort passt endlich zu der Art, wie mein Kurs es erklärt."',
        text: 'Genau darum geht es bei Minallo: kursbasierte Erklärungen, klare Quellen und ein Workspace, der Studierende beim Weitermachen unterstützt.'
      },
      pricing: {
        eyebrow: 'Preise',
        title: 'Teste den ganzen Workspace, bevor du dich festlegst.',
        lead: 'Starte mit 7 Tagen kostenloser Testphase. Danach nutzt du ein einfaches Abo für KI-Tutor, Dokumentwerkzeuge, Deutschübungen, Fokusfunktionen, Playlists und Lernspiele.',
        pro: {
          popular: '7 Tage kostenlos testen',
          name: 'Student Pro',
          sub: 'Alles, was du für eine klare Lernroutine brauchst.',
          per: '/Monat nach der Testphase',
          items: [
            'Kursbasierter KI-Tutor mit Quellenangaben',
            'Uploads, Notizen, Zusammenfassungen, Quizze und Karteikarten',
            'PDF-Editor und Lernworkspace',
            'Deutsch-Lernmodus und Wiederholungsspiele',
            'Pomodoro, Playlists, Lernserien und Fokus-Dashboard'
          ],
          cta: '7 Tage kostenlos starten'
        }
      },
      ctaBanner: {
        title: 'Baue einen Lernraum, der dein Material versteht.',
        text: 'Lade deine Kursdateien hoch, stelle bessere Fragen, löse Aufgaben mit Quellen und halte deine Routine mit Fokuswerkzeugen und Wiederholungsfeatures in Bewegung.',
        cta: 'Jetzt mit Minallo lernen'
      },
      footer: {
        copyPre: '© ',
        copyPost: ' Minallo. Gebaut für klareres Lernen und bessere Routinen.',
        tutor: 'KI-Tutor',
        imprint: 'Impressum',
        privacy: 'Datenschutz',
        terms: 'AGB',
        withdrawal: 'Widerruf'
      }
    }
  };

  // ---- PATH_CONTENT (language-keyed) -----------------------------------
  // Read at render time by _renderActivePath() via PATH_CONTENT[currentLang][selectedPath].
  var PATH_CONTENT = {
    en: {
      student: {
        title: 'Course workspace',
        subtitle: 'For university and school study',
        description: 'A focused workspace for course files, lecture PDFs, exercises, AI explanations, PDF editing, notes, Pomodoro sessions, streaks, and study progress.',
        icon: 'layout-dashboard',
        items: [
          'Organized course pages for lectures, exercises, notes, and formula sheets',
          'AI tutor answers grounded in uploaded course documents',
          'PDF tools for highlighting, writing, signing, saving, and exporting',
          'Pomodoro sessions, study streaks, dashboard stats, and progress tracking'
        ],
        preview: [
          ['file-text', 'Course library', 'Keep every subject, file, and note in one clean place.'],
          ['brain-circuit', 'Course-aware AI', 'Ask questions and get answers with source pages.'],
          ['timer', 'Focus mode', 'Study with Pomodoro sessions, progress, and visible streaks.']
        ]
      },
      german: {
        title: 'German practice space',
        subtitle: 'For daily language progress',
        description: 'A dedicated German-learning space for vocabulary, grammar help, simple explanations, everyday examples, and playful revision.',
        icon: 'languages',
        items: [
          'German vocabulary practice with simple examples and translations',
          'Grammar explanations written for real understanding',
          'Sentence examples for everyday German situations',
          'Mini-games and revision challenges that make practice easier to repeat'
        ],
        preview: [
          ['languages', 'German coach', 'Build vocabulary, grammar, sentences, and everyday phrases.'],
          ['book-open', 'Examples & phrases', 'Practice with simple examples and useful daily sentences.'],
          ['gamepad-2', 'Language games', 'Review vocabulary through quick challenges.']
        ]
      }
    },
    de: {
      student: {
        title: 'Kurs-Workspace',
        subtitle: 'Für Studium, Uni und Schule',
        description: 'Ein fokussierter Workspace für Kursdateien, Vorlesungs-PDFs, Übungen, KI-Erklärungen, PDF-Bearbeitung, Notizen, Pomodoro-Sitzungen, Lernserien und Fortschritt.',
        icon: 'layout-dashboard',
        items: [
          'Organisierte Kursseiten für Vorlesungen, Übungen, Notizen und Formelsammlungen',
          'KI-Tutor-Antworten verankert in hochgeladenen Kursdokumenten',
          'PDF-Werkzeuge zum Markieren, Schreiben, Unterschreiben, Speichern und Exportieren',
          'Pomodoro-Sitzungen, Lernserien, Dashboard-Statistiken und Fortschrittsverfolgung'
        ],
        preview: [
          ['file-text', 'Kursbibliothek', 'Behalte jedes Fach, jede Datei und jede Notiz an einem klaren Ort.'],
          ['brain-circuit', 'Kursbasierte KI', 'Stelle Fragen und erhalte Antworten mit Seitenquellen.'],
          ['timer', 'Fokus-Modus', 'Lerne mit Pomodoro-Sitzungen, Fortschritt und sichtbaren Lernserien.']
        ]
      },
      german: {
        title: 'Deutsch-Übungsbereich',
        subtitle: 'Für täglichen Sprachfortschritt',
        description: 'Ein eigener Bereich zum Deutschlernen mit Vokabeln, Grammatikhilfe, einfachen Erklärungen, Alltagsbeispielen und spielerischer Wiederholung.',
        icon: 'languages',
        items: [
          'Vokabelübungen mit einfachen Beispielen und Übersetzungen',
          'Grammatikerklärungen für echtes Verständnis',
          'Satzbeispiele für alltägliche Situationen auf Deutsch',
          'Mini-Spiele und Wiederholungs-Challenges, damit Üben leichter zur Routine wird'
        ],
        preview: [
          ['languages', 'Deutsch-Coach', 'Baue Vokabeln, Grammatik, Sätze und Alltagsphrasen auf.'],
          ['book-open', 'Beispiele & Phrasen', 'Übe mit einfachen Beispielen und nützlichen Alltagssätzen.'],
          ['gamepad-2', 'Sprachspiele', 'Wiederhole Vokabeln mit kurzen Challenges.']
        ]
      }
    }
  };

  // ---- helpers ----------------------------------------------------------

  /** Build an <svg><use href="#i-name"/></svg> node without using innerHTML. */
  function buildSvgUse(iconName, size) {
    var svgNS = 'http://www.w3.org/2000/svg';
    var xlinkNS = 'http://www.w3.org/1999/xlink';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', '#i-' + iconName);
    use.setAttributeNS(xlinkNS, 'xlink:href', '#i-' + iconName);
    svg.appendChild(use);
    return svg;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function _resolveKey(dict, dotted) {
    return dotted.split('.').reduce(function (obj, k) {
      if (obj == null) return undefined;
      return (k in obj) ? obj[k] : undefined;
    }, dict);
  }

  // ---- Language state ---------------------------------------------------

  var _currentLang = 'en';
  var _selectedPath = 'student';

  function _getInitialLang() {
    try {
      var saved = localStorage.getItem('ss_lang');
      if (saved === 'de' || saved === 'en') return saved;
    } catch (_e) { /* localStorage may be unavailable */ }
    try {
      if (navigator.language && navigator.language.toLowerCase().indexOf('de') === 0) return 'de';
    } catch (_e) {}
    return 'en';
  }

  function applyLang(lang) {
    _currentLang = (lang === 'de') ? 'de' : 'en';
    var dict = I18N[_currentLang];
    try { document.documentElement.lang = _currentLang; } catch (_e) {}

    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      if (!key) continue;
      var val = _resolveKey(dict, key);
      if (typeof val === 'string') el.textContent = val;
    }

    // Update lang button labels — show the OTHER language.
    var otherLabel = _currentLang === 'de' ? 'EN' : 'DE';
    var btn = document.getElementById('nlLangBtn');
    if (btn) btn.textContent = otherLabel;
    var btnM = document.getElementById('nlLangBtnMobile');
    if (btnM) btnM.textContent = otherLabel;

    try { localStorage.setItem('ss_lang', _currentLang); } catch (_e) {}

    // Re-render path picker detail panel in active language.
    _renderActivePath();
  }

  // ---- A. Mobile navigation toggle --------------------------------------

  function initMobileNav() {
    var nav = document.querySelector('.nl-nav');
    var btn = document.querySelector('[data-nl-menu-btn]');
    var dropdown = document.querySelector('[data-nl-mobile-menu]');
    if (!nav || !btn || !dropdown) return;

    function setOpen(open) {
      if (open) {
        nav.classList.add('is-open');
        btn.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        dropdown.hidden = false;
      } else {
        nav.classList.remove('is-open');
        btn.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        dropdown.hidden = true;
      }
    }

    btn.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });

    var links = dropdown.querySelectorAll('[data-nl-mobile-link]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        setOpen(false);
      });
    }
  }

  // ---- B. Path picker ---------------------------------------------------

  // Module-level references so applyLang() can re-render via _renderActivePath().
  var _pathRefs = null;

  function _renderActivePath() {
    if (!_pathRefs) return;
    var data = (PATH_CONTENT[_currentLang] || PATH_CONTENT.en)[_selectedPath];
    if (!data) return;
    var refs = _pathRefs;

    // Toggle active state on path cards.
    for (var i = 0; i < refs.cards.length; i++) {
      var c = refs.cards[i];
      var isActive = c.getAttribute('data-nl-path') === _selectedPath;
      if (isActive) c.classList.add('is-active');
      else c.classList.remove('is-active');
      c.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }

    refs.detail.setAttribute('data-nl-path-detail', _selectedPath);
    if (refs.iconHost) {
      clearChildren(refs.iconHost);
      refs.iconHost.appendChild(buildSvgUse(data.icon, 26));
    }
    if (refs.subEl) refs.subEl.textContent = data.subtitle;
    if (refs.titleEl) refs.titleEl.textContent = data.title;
    if (refs.descEl) refs.descEl.textContent = data.description;

    // Items
    if (refs.itemsEl) {
      clearChildren(refs.itemsEl);
      for (var j = 0; j < data.items.length; j++) {
        var row = document.createElement('div');
        row.className = 'nl-paths__hero-item';
        var check = document.createElement('span');
        check.className = 'nl-check';
        check.appendChild(buildSvgUse('check-circle-2', 19));
        row.appendChild(check);
        var text = document.createElement('span');
        text.textContent = data.items[j];
        row.appendChild(text);
        refs.itemsEl.appendChild(row);
      }
    }

    // Preview
    if (refs.previewEl) {
      clearChildren(refs.previewEl);
      for (var k = 0; k < data.preview.length; k++) {
        var entry = data.preview[k];
        var card = document.createElement('div');
        card.className = 'nl-paths__preview-card';

        var badge = document.createElement('span');
        badge.className = 'nl-icon-badge';
        badge.appendChild(buildSvgUse(entry[0], 23));
        card.appendChild(badge);

        var h4 = document.createElement('h4');
        h4.className = 'nl-paths__preview-title';
        h4.textContent = entry[1];
        card.appendChild(h4);

        var p = document.createElement('p');
        p.className = 'nl-paths__preview-text';
        p.textContent = entry[2];
        card.appendChild(p);

        refs.previewEl.appendChild(card);
      }
    }
  }

  function initPathPicker() {
    var cards = document.querySelectorAll('[data-nl-path]');
    var detail = document.querySelector('[data-nl-path-detail]');
    if (!cards.length || !detail) return;

    _pathRefs = {
      cards: cards,
      detail: detail,
      iconHost: detail.querySelector('[data-nl-path-icon]'),
      subEl: detail.querySelector('[data-nl-path-subtitle]'),
      titleEl: detail.querySelector('[data-nl-path-title]'),
      descEl: detail.querySelector('[data-nl-path-desc]'),
      itemsEl: detail.querySelector('[data-nl-path-items]'),
      previewEl: detail.querySelector('[data-nl-path-preview]')
    };

    // Initial selected path: whichever card has is-active, else 'student'.
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].classList.contains('is-active')) {
        var k = cards[i].getAttribute('data-nl-path');
        if (k) _selectedPath = k;
        break;
      }
    }

    for (var j = 0; j < cards.length; j++) {
      (function (card) {
        card.addEventListener('click', function () {
          var key = card.getAttribute('data-nl-path');
          if (key) {
            _selectedPath = key;
            _renderActivePath();
          }
        });
      })(cards[j]);
    }

    // Force initial render so detail panel always matches active language and path.
    _renderActivePath();
  }

  // ---- C. Tutor preview tabs -------------------------------------------

  function initTutorPreviewTabs() {
    var tabs = document.querySelectorAll('[data-nl-tab]');
    if (!tabs.length) return;
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          for (var k = 0; k < tabs.length; k++) {
            var t = tabs[k];
            var isActive = t === tab;
            if (isActive) t.classList.add('is-active');
            else t.classList.remove('is-active');
            t.setAttribute('aria-selected', isActive ? 'true' : 'false');
          }
        });
      })(tabs[i]);
    }
  }

  // ---- D. Scroll-triggered fade-in -------------------------------------

  function initRevealOnScroll() {
    var revealEls = document.querySelectorAll('.nl-reveal');
    if (!revealEls.length) return;

    if (prefersReducedMotion || typeof window.IntersectionObserver !== 'function') {
      for (var i = 0; i < revealEls.length; i++) revealEls[i].classList.add('is-visible');
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: '-80px 0px' }
    );

    for (var j = 0; j < revealEls.length; j++) observer.observe(revealEls[j]);
  }

  // ---- E. Hero halo parallax -------------------------------------------

  function initHeroParallax() {
    if (prefersReducedMotion) return;
    var halo = document.querySelector('[data-nl-parallax]');
    if (!halo) return;

    var ticking = false;
    var MAX_TRANSLATE = -130;
    // Cache scrollHeight/innerHeight so the scroll-rAF path never reads
    // layout-invalidating properties. Recomputed only on resize and on
    // a coarse mutation timer — the LCP-time forced reflow Lighthouse
    // flagged came from calling update() right after the landing partial
    // was injected, when layout was still dirty.
    var cachedMax = 1;
    function recalcMax() {
      var doc = document.documentElement;
      cachedMax = Math.max(1, (doc.scrollHeight || 0) - (window.innerHeight || 0));
    }

    function update() {
      ticking = false;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      var ratio = Math.min(1, Math.max(0, scrollY / cachedMax));
      var y = MAX_TRANSLATE * ratio;
      halo.style.transform = 'translate3d(-50%, ' + y + 'px, 0)';
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    function onResize() {
      recalcMax();
      onScroll();
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    // Defer the initial layout read + paint to the next frame so it runs
    // after the just-injected landing partial has had a chance to settle.
    // Synchronous reads here cost ~21ms of forced-reflow on cold loads.
    window.requestAnimationFrame(function () {
      recalcMax();
      update();
    });
  }

  // ---- F. Footer year ---------------------------------------------------

  function initFooterYear() {
    var el = document.getElementById('nlYear');
    if (!el) return;
    el.textContent = String(new Date().getFullYear());
  }

  // ---- G. CTA buttons ---------------------------------------------------

  function initCtaButtons() {
    var auth = function (e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      try {
        if (typeof window._googleAuth === 'function') window._googleAuth();
      } catch (_err) { /* swallow */ }
    };
    var ids = ['nlNavSignIn', 'nlNavStartFree', 'nlHeroBuild', 'nlPricingProCta', 'nlCtaLaunch'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.addEventListener('click', auth);
    }
    var watch = document.getElementById('nlHeroWatch');
    if (watch) {
      watch.addEventListener('click', function (e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        var tgt = document.getElementById('tutor');
        if (tgt && typeof tgt.scrollIntoView === 'function') {
          tgt.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
        }
      });
    }
  }

  // ---- H. Language toggle -----------------------------------------------

  function initLangToggle() {
    function toggle() {
      applyLang(_currentLang === 'de' ? 'en' : 'de');
    }
    var btn = document.getElementById('nlLangBtn');
    if (btn) btn.addEventListener('click', toggle);
    var btnM = document.getElementById('nlLangBtnMobile');
    if (btnM) btnM.addEventListener('click', toggle);
  }

  // ---- bootstrap --------------------------------------------------------

  function init() {
    // 1. Apply chosen language FIRST so first paint is correct,
    //    before path picker does its initial render.
    try { applyLang(_getInitialLang()); } catch (e) { /* noop */ }
    try { initLangToggle(); } catch (e) { /* noop */ }
    try { initCtaButtons(); } catch (e) { /* noop */ }
    try { initMobileNav(); } catch (e) { /* noop */ }
    try { initPathPicker(); } catch (e) { /* noop */ }
    try { initTutorPreviewTabs(); } catch (e) { /* noop */ }
    try { initRevealOnScroll(); } catch (e) { /* noop */ }
    try { initHeroParallax(); } catch (e) { /* noop */ }
    try { initFooterYear(); } catch (e) { /* noop */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
