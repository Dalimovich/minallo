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
      logo: { tag: 'Study smarter' },
      nav: {
        features: 'Features',
        paths: 'Paths',
        tutor: 'Tutor',
        workflow: 'Workflow',
        pricing: 'Pricing',
        signIn: 'Sign in',
        startFree: 'Start free'
      },
      hero: {
        badge: 'A course-aware AI study platform',
        title: 'Turn lecture chaos into clear, cited answers.',
        subtitle: 'Minallo helps students upload course files, ask questions, solve exercises, edit PDFs, learn German, focus with Pomodoro, play study games, and enjoy their favorite playlists while working.',
        buildCta: 'Build my study space',
        watchCta: 'Watch preview',
        stats: {
          pdf: 'Editor, uploads, notes, and course files in one place',
          ai: 'Grounded tutor that uses student materials as context',
          focusLabel: 'Focus',
          focus: 'Pomodoro, playlists, games, and streaks for consistency'
        }
      },
      tutorPreview: {
        workspace: 'Workspace',
        courseMaterials: 'Course materials',
        synced: 'Synced',
        tabs: { lecture: 'Lecture PDF', exercise: 'Exercise', formula: 'Formula sheet' },
        smartRetrieval: 'Smart retrieval',
        tutorName: 'Minallo AI Tutor',
        mode: 'Grounded answer mode',
        userMsg: 'Explain exercise 6 using only my lecture notes and cite the formula.',
        aiMsg: 'First, we use the lecture definition of equilibrium and then substitute the values from the exercise. The relevant formula is found in your formula sheet.',
        cite1: 'Citation: Lecture 03 · page 12',
        cite2: 'Citation: Formula sheet · page 2',
        miniSources: 'Sources',
        miniVerified: 'Verified',
        miniGuessing: 'Guessing'
      },
      features: {
        eyebrow: 'Features',
        title: 'Everything a serious student needs, without the clutter.',
        lead: 'The design is built around one idea: the student should always know what to study next, where the answer came from, and how to stay focused.',
        cards: [
          { title: 'AI tutor trained around your course', text: 'Minallo answers from your uploaded lectures, exercises, and formula sheets instead of giving generic internet-style explanations.' },
          { title: 'Cited PDF answers', text: 'Every important claim can point back to the exact document and page, so students can verify the answer instantly.' },
          { title: 'Focus tools built in', text: 'Pomodoro sessions, study streaks, and progress signals keep the student working instead of just collecting files.' },
          { title: 'Honest when context is missing', text: 'When the uploaded material is not enough, Minallo should say what is missing instead of hallucinating a confident answer.' },
          { title: 'Multi-source synthesis', text: 'It can combine an exercise, a lecture explanation, and a formula sheet into one clean step-by-step answer.' },
          { title: 'Fast repeated answers', text: 'Common repeated questions can be cached, reducing token cost and making the experience feel instant.' },
          { title: 'German learner mode', text: 'A separate path for vocabulary, grammar, examples, and playful German revision.' },
          { title: 'Playlists while studying', text: 'Students can keep their favorite playlists close, making focus sessions feel more personal and enjoyable.' },
          { title: 'Games for motivation', text: 'Quick games and challenges give students relaxing breaks while keeping the learning mood alive.' }
        ]
      },
      paths: {
        eyebrow: 'Choose your space',
        title: 'One platform, two clear journeys.',
        lead: 'Minallo should not feel confusing. New users choose whether they are here to manage studies or learn German, then the dashboard adapts to the tools they actually need.',
        studentCard: {
          eyebrow: 'Courses',
          title: "I'm a student",
          desc: 'For students who upload lectures, solve exercises, edit PDFs, and want AI help based on their own study material.',
          items: [
            'Course dashboard and file organization',
            'Lecture-aware AI tutor with citations',
            'PDF editor, notes, Pomodoro, and streaks'
          ]
        },
        germanCard: {
          eyebrow: 'Language',
          title: "I'm learning German",
          desc: 'For learners who want German vocabulary, grammar, useful examples, and playful practice in a separate area.',
          items: [
            'Vocabulary and grammar practice',
            'Simple examples and sentence practice',
            'Mini-games for revision and motivation'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Study vibe',
        title: 'Productive does not have to feel boring.',
        lead: 'Playlists and games are worth showing because they make Minallo feel like a complete student environment, not just another serious dashboard.',
        cards: [
          { title: 'Favorite playlists', text: 'Let users listen while studying, focusing, or practicing German.' },
          { title: 'Study games', text: 'Use quick games for revision breaks, vocabulary, and motivation.' },
          { title: 'Streak rewards', text: 'Turn consistency into visible progress and small wins.' }
        ]
      },
      tutor: {
        eyebrow: 'AI Tutor',
        title: 'Not just chat. A study engine.',
        lead: "A generic chatbot can explain topics. Minallo should explain your topic the way your professor's material presents it, with citations and controlled confidence.",
        items: [
          'Search across lectures, exercises, and formula sheets',
          'Answer with page-level citations',
          'Use active document as a ranking hint, not a hard limit',
          'Cache repeated questions to reduce API cost'
        ]
      },
      pipeline: {
        eyebrow: 'Answer pipeline',
        title: 'From upload to verified response',
        steps: [
          { title: 'Upload', text: 'Lecture PDFs, exercise sheets, notes, and formulas are added to the student workspace.' },
          { title: 'Index', text: 'The system extracts pages, chunks, formulas, exercises, and metadata for smarter retrieval.' },
          { title: 'Retrieve', text: 'Minallo selects the best context instead of sending the whole file every time.' },
          { title: 'Answer', text: 'The AI gives a step-by-step answer with citations and missing-context warnings.' }
        ]
      },
      workflow: {
        eyebrow: 'Workflow',
        title: 'A landing page that sells the whole experience.',
        lead: 'The page should immediately show that Minallo is more than a pretty chatbot. It is a student dashboard, German learner space, course tutor, PDF workspace, focus system, playlist companion, and study-game hub.',
        cards: [
          { title: 'Ask', text: 'Students ask questions in natural language.' },
          { title: 'Solve', text: 'Exercises become guided step-by-step explanations.' },
          { title: 'Learn', text: 'German learners practice vocabulary, grammar, examples, and revision games.' },
          { title: 'Enjoy', text: 'Playlists and study games keep the experience motivating.' }
        ]
      },
      quote: {
        title: '"Minallo should feel like a private tutor who has actually read the student\'s lecture files."',
        text: 'That message is the core of the landing page: accurate, calm, beautiful, and focused on real student outcomes.'
      },
      pricing: {
        eyebrow: 'Pricing',
        title: 'Simple student-friendly plans.',
        lead: 'Keep the pricing section clean. Students and German learners should understand immediately what they get: documents, AI help, PDF tools, language practice, playlists, games, and focus features.',
        free: {
          name: 'Free',
          sub: 'For trying the workspace.',
          items: ['Limited AI questions', 'Basic Pomodoro', 'Upload sample documents'],
          cta: 'Start free'
        },
        pro: {
          popular: 'Popular',
          name: 'Student Pro',
          sub: 'For serious study sessions.',
          per: '/month',
          items: [
            'More AI tutor usage',
            'Course-aware citations',
            'PDF editor workspace',
            'German learner mode',
            'Playlists, games, and focus dashboard'
          ],
          cta: 'Upgrade study flow'
        }
      },
      ctaBanner: {
        title: 'Ready to make studying feel clear?',
        text: 'Choose your path. Upload course files or practice German. Ask questions, get explanations, listen to your playlists, play quick study games, and stay focused until the work is done.',
        cta: 'Launch Minallo'
      },
      footer: {
        copyPre: '© ',
        copyPost: ' Minallo. Built for focused students and German learners.',
        tutor: 'AI Tutor'
      }
    },
    de: {
      logo: { tag: 'Klüger studieren' },
      nav: {
        features: 'Funktionen',
        paths: 'Bereiche',
        tutor: 'Tutor',
        workflow: 'Ablauf',
        pricing: 'Preise',
        signIn: 'Anmelden',
        startFree: 'Kostenlos starten'
      },
      hero: {
        badge: 'Eine kursbasierte KI-Lernplattform',
        title: 'Mach aus Vorlesungschaos klare, belegte Antworten.',
        subtitle: 'Minallo hilft dir, Kursdateien hochzuladen, Fragen zu stellen, Übungen zu lösen, PDFs zu bearbeiten, Deutsch zu lernen, dich mit Pomodoro zu fokussieren, Lernspiele zu spielen und deine Lieblings-Playlists beim Lernen zu genießen.',
        buildCta: 'Meinen Lernbereich aufbauen',
        watchCta: 'Vorschau ansehen',
        stats: {
          pdf: 'Editor, Uploads, Notizen und Kursdateien an einem Ort',
          ai: 'Verankerter Tutor, der deine Materialien als Kontext nutzt',
          focusLabel: 'Fokus',
          focus: 'Pomodoro, Playlists, Spiele und Lernserien für mehr Beständigkeit'
        }
      },
      tutorPreview: {
        workspace: 'Arbeitsbereich',
        courseMaterials: 'Kursmaterialien',
        synced: 'Synchronisiert',
        tabs: { lecture: 'Vorlesungs-PDF', exercise: 'Übung', formula: 'Formelsammlung' },
        smartRetrieval: 'Intelligente Suche',
        tutorName: 'Minallo KI-Tutor',
        mode: 'Belegter Antwortmodus',
        userMsg: 'Erkläre Übung 6 nur anhand meiner Vorlesungsnotizen und gib die Formel mit Quellenangabe an.',
        aiMsg: 'Zuerst nutzen wir die Definition des Gleichgewichts aus der Vorlesung und setzen dann die Werte aus der Übung ein. Die relevante Formel findest du in deiner Formelsammlung.',
        cite1: 'Quellenangabe: Vorlesung 03 · Seite 12',
        cite2: 'Quellenangabe: Formelsammlung · Seite 2',
        miniSources: 'Quellen',
        miniVerified: 'Geprüft',
        miniGuessing: 'Geraten'
      },
      features: {
        eyebrow: 'Funktionen',
        title: 'Alles, was ernsthafte Studierende brauchen — ohne Ballast.',
        lead: 'Das Design folgt einer Idee: Du sollst immer wissen, was als Nächstes zu lernen ist, woher die Antwort kommt und wie du fokussiert bleibst.',
        cards: [
          { title: 'KI-Tutor, trainiert auf deinen Kurs', text: 'Minallo antwortet auf Basis deiner hochgeladenen Vorlesungen, Übungen und Formelsammlungen — statt mit generischen Internet-Erklärungen.' },
          { title: 'PDF-Antworten mit Quellenangabe', text: 'Jede wichtige Aussage verweist zurück auf das genaue Dokument und die Seite — so kannst du die Antwort sofort überprüfen.' },
          { title: 'Fokus-Werkzeuge eingebaut', text: 'Pomodoro-Sitzungen, Lernserien und Fortschrittssignale halten dich am Arbeiten — statt nur Dateien zu sammeln.' },
          { title: 'Ehrlich, wenn Kontext fehlt', text: 'Wenn das Material nicht ausreicht, sagt Minallo, was fehlt — statt eine selbstsichere Antwort zu halluzinieren.' },
          { title: 'Synthese aus mehreren Quellen', text: 'Übung, Vorlesungserklärung und Formelsammlung werden zu einer sauberen Schritt-für-Schritt-Antwort kombiniert.' },
          { title: 'Schnelle wiederholte Antworten', text: 'Häufige Fragen werden zwischengespeichert — das senkt Token-Kosten und fühlt sich sofort an.' },
          { title: 'Deutsch-Lernmodus', text: 'Ein eigener Bereich für Vokabeln, Grammatik, Beispiele und spielerische Wiederholung.' },
          { title: 'Playlists beim Lernen', text: 'Behalte deine Lieblings-Playlists in Reichweite — so fühlen sich Fokus-Sessions persönlicher und angenehmer an.' },
          { title: 'Spiele für Motivation', text: 'Schnelle Spiele und Mini-Challenges geben dir entspannte Pausen — und halten die Lernlaune am Leben.' }
        ]
      },
      paths: {
        eyebrow: 'Wähle deinen Bereich',
        title: 'Eine Plattform, zwei klare Wege.',
        lead: 'Minallo soll nicht verwirrend wirken. Neue Nutzer:innen entscheiden, ob sie hier ihr Studium organisieren oder Deutsch lernen wollen — das Dashboard passt sich dann an die wirklich nötigen Werkzeuge an.',
        studentCard: {
          eyebrow: 'Kurse',
          title: 'Ich studiere',
          desc: 'Für Studierende, die Vorlesungen hochladen, Übungen lösen, PDFs bearbeiten und KI-Hilfe basierend auf eigenen Materialien möchten.',
          items: [
            'Kurs-Dashboard und Dateiorganisation',
            'Vorlesungsbewusster KI-Tutor mit Quellenangaben',
            'PDF-Editor, Notizen, Pomodoro und Lernserien'
          ]
        },
        germanCard: {
          eyebrow: 'Sprache',
          title: 'Ich lerne Deutsch',
          desc: 'Für Lernende, die deutsche Vokabeln, Grammatik, nützliche Beispiele und spielerisches Üben in einem eigenen Bereich möchten.',
          items: [
            'Vokabel- und Grammatikübungen',
            'Einfache Beispiele und Satzübungen',
            'Mini-Spiele zur Wiederholung und Motivation'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Lernstimmung',
        title: 'Produktiv muss sich nicht langweilig anfühlen.',
        lead: 'Playlists und Spiele gehören dazu, weil sie Minallo zu einer kompletten Lernumgebung machen — und nicht nur zu einem weiteren ernsten Dashboard.',
        cards: [
          { title: 'Lieblings-Playlists', text: 'Höre Musik beim Lernen, Fokussieren oder Deutschüben.' },
          { title: 'Lernspiele', text: 'Schnelle Spiele für Pausen, Vokabeln und Motivation.' },
          { title: 'Lernserien-Belohnungen', text: 'Mache Beständigkeit sichtbar — in Form von Fortschritt und kleinen Erfolgen.' }
        ]
      },
      tutor: {
        eyebrow: 'KI-Tutor',
        title: 'Kein bloßer Chat. Ein Lern-Motor.',
        lead: 'Ein generischer Chatbot kann Themen erklären. Minallo erklärt dein Thema so, wie es im Material deiner Professorin oder deines Professors steht — mit Quellenangaben und kontrollierter Sicherheit.',
        items: [
          'Suche über Vorlesungen, Übungen und Formelsammlungen',
          'Antworten mit Quellenangabe auf Seitenebene',
          'Das aktive Dokument als Ranking-Hinweis nutzen — nicht als harte Grenze',
          'Wiederholte Fragen zwischenspeichern, um API-Kosten zu sparen'
        ]
      },
      pipeline: {
        eyebrow: 'Antwort-Pipeline',
        title: 'Vom Upload bis zur geprüften Antwort',
        steps: [
          { title: 'Hochladen', text: 'Vorlesungs-PDFs, Übungsblätter, Notizen und Formeln landen im Lernbereich.' },
          { title: 'Indexieren', text: 'Das System extrahiert Seiten, Abschnitte, Formeln, Übungen und Metadaten für eine smartere Suche.' },
          { title: 'Abrufen', text: 'Minallo wählt den besten Kontext aus — statt jedes Mal die ganze Datei zu schicken.' },
          { title: 'Antworten', text: 'Die KI gibt eine Schritt-für-Schritt-Antwort mit Quellenangaben und Hinweisen auf fehlenden Kontext.' }
        ]
      },
      workflow: {
        eyebrow: 'Ablauf',
        title: 'Eine Landingpage, die das ganze Erlebnis verkauft.',
        lead: 'Die Seite soll sofort zeigen: Minallo ist mehr als ein hübscher Chatbot. Es ist Studi-Dashboard, Deutsch-Lernbereich, Kurs-Tutor, PDF-Arbeitsplatz, Fokus-System, Playlist-Begleiter und Lernspiel-Hub.',
        cards: [
          { title: 'Fragen', text: 'Stelle Fragen in natürlicher Sprache.' },
          { title: 'Lösen', text: 'Übungen werden zu geführten Schritt-für-Schritt-Erklärungen.' },
          { title: 'Lernen', text: 'Deutschlernende üben Vokabeln, Grammatik, Beispiele und Wiederholungsspiele.' },
          { title: 'Genießen', text: 'Playlists und Lernspiele halten das Erlebnis motivierend.' }
        ]
      },
      quote: {
        title: '„Minallo soll sich anfühlen wie ein privater Tutor, der die Vorlesungsdateien wirklich gelesen hat."',
        text: 'Genau das ist der Kern der Landingpage: präzise, ruhig, schön — und auf echten Lernerfolg ausgerichtet.'
      },
      pricing: {
        eyebrow: 'Preise',
        title: 'Einfache, studierendenfreundliche Pläne.',
        lead: 'Der Preisbereich bleibt schlank. Studierende und Deutschlernende verstehen sofort, was sie bekommen: Dokumente, KI-Hilfe, PDF-Werkzeuge, Sprachpraxis, Playlists, Spiele und Fokus-Funktionen.',
        free: {
          name: 'Kostenlos',
          sub: 'Zum Ausprobieren des Arbeitsbereichs.',
          items: ['Begrenzte KI-Fragen', 'Einfacher Pomodoro', 'Beispieldokumente hochladen'],
          cta: 'Kostenlos starten'
        },
        pro: {
          popular: 'Beliebt',
          name: 'Student Pro',
          sub: 'Für ernsthafte Lernsitzungen.',
          per: '/Monat',
          items: [
            'Mehr KI-Tutor-Nutzung',
            'Kursbasierte Quellenangaben',
            'PDF-Editor-Arbeitsbereich',
            'Deutsch-Lernmodus',
            'Playlists, Spiele und Fokus-Dashboard'
          ],
          cta: 'Lernfluss upgraden'
        }
      },
      ctaBanner: {
        title: 'Bereit, Lernen klar anfühlen zu lassen?',
        text: 'Wähle deinen Weg. Lade Kursdateien hoch oder übe Deutsch. Stelle Fragen, erhalte Erklärungen, höre deine Playlists, spiele kurze Lernspiele und bleib fokussiert, bis die Arbeit erledigt ist.',
        cta: 'Minallo starten'
      },
      footer: {
        copyPre: '© ',
        copyPost: ' Minallo. Gebaut für fokussierte Studierende und Deutschlernende.',
        tutor: 'KI-Tutor'
      }
    }
  };

  // ---- PATH_CONTENT (language-keyed) -----------------------------------
  // Read at render time by _renderActivePath() via PATH_CONTENT[currentLang][selectedPath].
  var PATH_CONTENT = {
    en: {
      student: {
        title: 'Student dashboard',
        subtitle: 'For university and school work',
        description: 'A focused dashboard for courses, lecture PDFs, exercises, AI explanations, PDF editing, Pomodoro sessions, streaks, and study progress.',
        icon: 'layout-dashboard',
        items: [
          'Course pages for lectures, exercises, notes, and formula sheets',
          'AI tutor answers grounded in uploaded course documents',
          'PDF editor for highlighting, writing, signing, saving, and exporting',
          'Pomodoro timer, study streaks, dashboard stats, and progress tracking'
        ],
        preview: [
          ['file-text', 'Course library', 'Organize every subject and file in one clean place.'],
          ['brain-circuit', 'AI study help', 'Ask questions and get cited, course-aware answers.'],
          ['timer', 'Focus mode', 'Study with Pomodoro sessions and visible streaks.']
        ]
      },
      german: {
        title: 'German learner',
        subtitle: 'For language practice',
        description: 'A dedicated German-learning space with vocabulary, grammar help, simple explanations, examples, and playful revision.',
        icon: 'languages',
        items: [
          'German vocabulary practice with simple examples and translations',
          'Grammar explanations in beginner-friendly language',
          'Simple sentence examples for daily German situations',
          'Mini-games and revision challenges to make practice less boring'
        ],
        preview: [
          ['languages', 'German coach', 'Learn words, grammar, sentences, and everyday phrases.'],
          ['book-open', 'Examples & phrases', 'Practice German with simple examples and everyday sentences.'],
          ['gamepad-2', 'Language games', 'Review vocabulary through quick challenges and games.']
        ]
      }
    },
    de: {
      student: {
        title: 'Studierenden-Dashboard',
        subtitle: 'Für Uni- und Schularbeit',
        description: 'Ein fokussiertes Dashboard für Kurse, Vorlesungs-PDFs, Übungen, KI-Erklärungen, PDF-Bearbeitung, Pomodoro-Sitzungen, Lernserien und Lernfortschritt.',
        icon: 'layout-dashboard',
        items: [
          'Kursseiten für Vorlesungen, Übungen, Notizen und Formelsammlungen',
          'KI-Tutor-Antworten verankert in hochgeladenen Kursdokumenten',
          'PDF-Editor zum Markieren, Schreiben, Unterschreiben, Speichern und Exportieren',
          'Pomodoro-Timer, Lernserien, Dashboard-Statistiken und Fortschrittsverfolgung'
        ],
        preview: [
          ['file-text', 'Kursbibliothek', 'Organisiere jedes Fach und jede Datei an einem klaren Ort.'],
          ['brain-circuit', 'KI-Lernhilfe', 'Stelle Fragen und erhalte belegte, kursbasierte Antworten.'],
          ['timer', 'Fokus-Modus', 'Lerne mit Pomodoro-Sitzungen und sichtbaren Lernserien.']
        ]
      },
      german: {
        title: 'Deutsch-Lernbereich',
        subtitle: 'Für Sprachpraxis',
        description: 'Ein eigener Bereich zum Deutschlernen — mit Vokabeln, Grammatikhilfe, einfachen Erklärungen, Beispielen und spielerischer Wiederholung.',
        icon: 'languages',
        items: [
          'Vokabelübungen mit einfachen Beispielen und Übersetzungen',
          'Grammatikerklärungen in anfängerfreundlicher Sprache',
          'Einfache Satzbeispiele für alltägliche Situationen auf Deutsch',
          'Mini-Spiele und Wiederholungs-Challenges, damit Üben nicht langweilig wird'
        ],
        preview: [
          ['languages', 'Deutsch-Coach', 'Lerne Wörter, Grammatik, Sätze und Alltagsphrasen.'],
          ['book-open', 'Beispiele & Phrasen', 'Übe Deutsch mit einfachen Beispielen und Alltagssätzen.'],
          ['gamepad-2', 'Sprachspiele', 'Wiederhole Vokabeln mit kurzen Challenges und Spielen.']
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

    function update() {
      ticking = false;
      var doc = document.documentElement;
      var max = Math.max(1, (doc.scrollHeight || 0) - (window.innerHeight || 0));
      var ratio = Math.min(1, Math.max(0, (window.scrollY || window.pageYOffset || 0) / max));
      var y = MAX_TRANSLATE * ratio;
      halo.style.transform = 'translate3d(-50%, ' + y + 'px, 0)';
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    update();
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
    var ids = ['nlNavSignIn', 'nlNavStartFree', 'nlHeroBuild', 'nlPricingFreeCta', 'nlPricingProCta', 'nlCtaLaunch'];
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
