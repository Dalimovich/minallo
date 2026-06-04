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
      },
      preview: {
        title: 'Minallo · Product preview',
        closingLine: 'Minallo reads your course files, finds the right source pages, and explains the answer the way your material teaches it.',
        controls: {
          next: 'Next', back: 'Back', replay: 'Replay',
          start: 'Start studying with Minallo',
          switchTrack: 'Switch track', close: 'Close preview'
        },
        chooser: {
          title: 'What do you want to see?',
          sub: 'Pick a track — the preview plays a short, interactive walkthrough.',
          course: 'Studying a course',
          courseSub: 'Lectures, exercises, AI answers with sources, and focus tools.',
          german: 'Learning German',
          germanSub: 'Vocabulary, grammar, everyday sentences, and practice games.'
        },
        labels: {
          synced: 'Synced', sources: 'Sources', verified: 'Verified',
          given: 'Given', required: 'Required', formula: 'Formula',
          steps: 'Steps', finalAnswer: 'Final answer',
          annotate: 'Annotate', annotateSub: 'Highlight & sign PDFs',
          flashcards: 'Flashcards', flashcardsSub: 'Auto-built from your files',
          quiz: 'Quiz', quizSub: 'Practice with scoring',
          summary: 'Summary', summarySub: 'Key points from lectures',
          focus: 'Focus', streak: 'Streak', dayStreak: '7-day streak',
          askPlaceholder: 'Ask about your course…', tapToFlip: 'Tap to flip'
        },
        mock: {
          src1: 'Lecture 03 · p.12', src2: 'Exercise Sheet 06 · p.2', src3: 'Formula Sheet · p.1',
          ansGiven: 'Beam in equilibrium, load F = 120 N',
          ansRequired: 'Support reaction Aᵧ',
          ansSteps: 'Moment balance about A, then solve',
          ansFinal: 'Aᵧ = 72 N',
          trustMsg: 'That isn’t in your uploaded files yet. Upload Exercise Sheet 07 and I’ll solve it with your lecture method.',
          vocabFront: 'die Übung', vocabBack: 'the exercise / practice',
          grammarTip: 'Separable verbs split: “Ich rufe dich an.”',
          sentence1: 'Können Sie mir bitte helfen?', sentence1Gloss: 'Could you help me, please?',
          sentence2: 'Ich hätte gern einen Kaffee.', sentence2Gloss: 'I would like a coffee.',
          gameQ: 'der / die / das  Apfel?', gameA: 'der'
        },
        course: {
          shell: { chapter: 'Shell', eyebrow: 'Step 1 · App shell', headline: 'Start from the real Minallo sidebar.', body: 'The preview opens on an empty dashboard and uses the same sidebar order and icons students see in the app.' },
          setup: { chapter: 'Course', eyebrow: 'Step 2 · Course setup', headline: 'Create the course first.', body: 'Open Courses, type the subject name, add it, and Minallo places the new course card in front of you.' },
          upload: { chapter: 'Upload', eyebrow: 'Step 3 · Upload files', headline: 'Open the course and add a file.', body: 'Inside the Files tab, click Upload files, choose the material you need, and Minallo shows the upload progress modal.' },
          ask: { chapter: 'Ask', eyebrow: 'Step 4 · Ask AI', headline: 'Ask in your own words.', body: 'Type a normal course question. Minallo sends it like the real chat, shows the thinking state, then streams a grounded answer with sources.' },
          sources: { chapter: 'Sources', eyebrow: 'Step 3 · Retrieve', headline: 'It finds the exact pages.', body: 'Minallo searches your files and pulls the passages that actually answer the question.' },
          answer: { chapter: 'Answer', eyebrow: 'Step 4 · Explain', headline: 'A structured answer you can trust.', body: 'Worked the way your course teaches it — with page citations you can open and verify.' },
          trust: { chapter: 'Trust', eyebrow: 'Step 5 · Honesty', headline: 'Honest when something is missing.', body: 'If the answer is not in your files, Minallo says so and asks for the right file or page instead of guessing.' },
          tools: { chapter: 'Tools', eyebrow: 'Step 6 · Revise', headline: 'Turn material into practice.', body: 'Annotate PDFs, generate flashcards and quizzes, and get lecture summaries — all from the same files.' },
          focus: { chapter: 'Focus', eyebrow: 'Step 7 · Momentum', headline: 'Then keep your momentum.', body: 'Run a Pomodoro, play a focus playlist, and watch your study streak grow.' }
        },
        german: {
          intro: { chapter: 'Start', eyebrow: 'Step 1 · German', headline: 'A space just for German.', body: 'Build vocabulary, grammar, and everyday phrases with simple explanations and playful revision.' },
          vocab: { chapter: 'Vocab', eyebrow: 'Step 2 · Vocabulary', headline: 'Learn words that stick.', body: 'Flip cards with translations and example sentences for real situations.' },
          grammar: { chapter: 'Grammar', eyebrow: 'Step 3 · Grammar', headline: 'Grammar explained simply.', body: 'Clear rules written for understanding, not memorizing — with examples you can reuse.' },
          sentences: { chapter: 'Sentences', eyebrow: 'Step 4 · Everyday', headline: 'Speak everyday German.', body: 'Practice useful sentences for daily situations, from shopping to small talk.' },
          games: { chapter: 'Games', eyebrow: 'Step 5 · Practice', headline: 'Review with quick games.', body: 'Short challenges turn revision into something you actually want to repeat.' },
          streak: { chapter: 'Progress', eyebrow: 'Step 6 · Momentum', headline: 'See your progress build.', body: 'Daily streaks and progress signals keep your practice going.' },
          cta: { chapter: 'Start', eyebrow: 'Ready', headline: 'Start learning German.', body: 'Your daily German practice space is one click away.' }
        }
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
      },
      preview: {
        title: 'Minallo · Produktvorschau',
        closingLine: 'Minallo liest deine Kursdateien, findet die richtigen Quellenseiten und erklärt die Antwort so, wie dein Material es lehrt.',
        controls: {
          next: 'Weiter', back: 'Zurück', replay: 'Erneut abspielen',
          start: 'Mit Minallo lernen',
          switchTrack: 'Bereich wechseln', close: 'Vorschau schließen'
        },
        chooser: {
          title: 'Was möchtest du sehen?',
          sub: 'Wähle einen Bereich — die Vorschau spielt eine kurze, interaktive Tour.',
          course: 'Kurs lernen',
          courseSub: 'Vorlesungen, Übungen, KI-Antworten mit Quellen und Fokuswerkzeuge.',
          german: 'Deutsch lernen',
          germanSub: 'Vokabeln, Grammatik, Alltagssätze und Übungsspiele.'
        },
        labels: {
          synced: 'Synchronisiert', sources: 'Quellen', verified: 'Geprüft',
          given: 'Gegeben', required: 'Gesucht', formula: 'Formel',
          steps: 'Schritte', finalAnswer: 'Endergebnis',
          annotate: 'Markieren', annotateSub: 'PDFs markieren & signieren',
          flashcards: 'Karteikarten', flashcardsSub: 'Automatisch aus deinen Dateien',
          quiz: 'Quiz', quizSub: 'Üben mit Bewertung',
          summary: 'Zusammenfassung', summarySub: 'Kernpunkte aus Vorlesungen',
          focus: 'Fokus', streak: 'Serie', dayStreak: '7-Tage-Serie',
          askPlaceholder: 'Frag zu deinem Kurs…', tapToFlip: 'Zum Umdrehen tippen'
        },
        mock: {
          src1: 'Vorlesung 03 · S. 12', src2: 'Übungsblatt 06 · S. 2', src3: 'Formelsammlung · S. 1',
          ansGiven: 'Balken im Gleichgewicht, Last F = 120 N',
          ansRequired: 'Auflagerreaktion Aᵧ',
          ansSteps: 'Momentengleichgewicht um A, dann lösen',
          ansFinal: 'Aᵧ = 72 N',
          trustMsg: 'Das steht noch nicht in deinen Dateien. Lade Übungsblatt 07 hoch und ich löse es mit deiner Vorlesungsmethode.',
          vocabFront: 'die Übung', vocabBack: 'das Üben, die Aufgabe',
          grammarTip: 'Trennbare Verben trennen sich: „Ich rufe dich an.“',
          sentence1: 'Können Sie mir bitte helfen?', sentence1Gloss: 'Höfliche Bitte um Hilfe',
          sentence2: 'Ich hätte gern einen Kaffee.', sentence2Gloss: 'Etwas höflich bestellen',
          gameQ: 'der / die / das  Apfel?', gameA: 'der'
        },
        course: {
          shell: { chapter: 'Shell', eyebrow: 'Schritt 1 · App-Shell', headline: 'Starte mit der echten Minallo-Seitenleiste.', body: 'Die Vorschau öffnet ein leeres Dashboard und nutzt dieselbe Reihenfolge und dieselben Icons wie die App.' },
          setup: { chapter: 'Kurs', eyebrow: 'Schritt 2 · Kurs einrichten', headline: 'Erstelle zuerst den Kurs.', body: 'Öffne Kurse, tippe den Fachnamen ein, füge ihn hinzu und Minallo zeigt dir direkt die neue Kurskarte.' },
          upload: { chapter: 'Upload', eyebrow: 'Schritt 3 · Dateien hochladen', headline: 'Öffne den Kurs und füge eine Datei hinzu.', body: 'Im Dateien-Tab klickst du auf Upload files, wählst dein Material aus und Minallo zeigt den Upload-Fortschritt.' },
          ask: { chapter: 'Fragen', eyebrow: 'Schritt 4 · KI fragen', headline: 'Frag in deinen eigenen Worten.', body: 'Tippe eine normale Kursfrage. Minallo sendet sie wie im echten Chat, zeigt den Denkzustand und schreibt dann eine Antwort mit Quellen.' },
          sources: { chapter: 'Quellen', eyebrow: 'Schritt 3 · Finden', headline: 'Es findet die genauen Seiten.', body: 'Minallo durchsucht deine Dateien und zieht die Stellen heraus, die die Frage wirklich beantworten.' },
          answer: { chapter: 'Antwort', eyebrow: 'Schritt 4 · Erklären', headline: 'Eine strukturierte Antwort, der du vertrauen kannst.', body: 'Gelöst, wie es dein Kurs lehrt — mit Seitenquellen, die du öffnen und prüfen kannst.' },
          trust: { chapter: 'Vertrauen', eyebrow: 'Schritt 5 · Ehrlichkeit', headline: 'Ehrlich, wenn etwas fehlt.', body: 'Wenn die Antwort nicht in deinen Dateien steht, sagt Minallo das und fragt nach der richtigen Datei oder Seite, statt zu raten.' },
          tools: { chapter: 'Werkzeuge', eyebrow: 'Schritt 6 · Wiederholen', headline: 'Mach aus Material echtes Üben.', body: 'Markiere PDFs, erstelle Karteikarten und Quizze und erhalte Vorlesungs-Zusammenfassungen — alles aus denselben Dateien.' },
          focus: { chapter: 'Fokus', eyebrow: 'Schritt 7 · Schwung', headline: 'Und halte deinen Schwung.', body: 'Starte eine Pomodoro-Sitzung, spiele eine Fokus-Playlist und sieh deine Lernserie wachsen.' }
        },
        german: {
          intro: { chapter: 'Start', eyebrow: 'Schritt 1 · Deutsch', headline: 'Ein Bereich nur für Deutsch.', body: 'Baue Vokabeln, Grammatik und Alltagsphrasen mit einfachen Erklärungen und spielerischer Wiederholung auf.' },
          vocab: { chapter: 'Vokabeln', eyebrow: 'Schritt 2 · Vokabeln', headline: 'Lerne Wörter, die hängen bleiben.', body: 'Drehe Karten mit Übersetzungen und Beispielsätzen für echte Situationen.' },
          grammar: { chapter: 'Grammatik', eyebrow: 'Schritt 3 · Grammatik', headline: 'Grammatik einfach erklärt.', body: 'Klare Regeln zum Verstehen statt Auswendiglernen — mit Beispielen, die du wiederverwenden kannst.' },
          sentences: { chapter: 'Sätze', eyebrow: 'Schritt 4 · Alltag', headline: 'Sprich alltägliches Deutsch.', body: 'Übe nützliche Sätze für den Alltag, vom Einkaufen bis zum Small Talk.' },
          games: { chapter: 'Spiele', eyebrow: 'Schritt 5 · Üben', headline: 'Wiederhole mit kurzen Spielen.', body: 'Kurze Challenges machen aus Wiederholung etwas, das du gern wiederholst.' },
          streak: { chapter: 'Fortschritt', eyebrow: 'Schritt 6 · Schwung', headline: 'Sieh deinen Fortschritt wachsen.', body: 'Tägliche Serien und Fortschrittssignale halten dein Üben am Laufen.' },
          cta: { chapter: 'Start', eyebrow: 'Bereit', headline: 'Starte mit Deutsch.', body: 'Dein täglicher Deutsch-Übungsbereich ist nur einen Klick entfernt.' }
        }
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

    // Re-render the preview modal if it's open, so a mid-preview language
    // switch updates every scene string live.
    if (_pvApi && _pvApi.relang) _pvApi.relang();
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
    var halo = document.querySelector('[data-nl-parallax]');
    if (!halo) return;
    halo.style.transform = 'none';
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
        if (_pvApi && _pvApi.open) {
          _pvApi.open();
        } else {
          // Fallback: if the preview failed to init, scroll to the live mock.
          var tgt = document.getElementById('tutor');
          if (tgt && typeof tgt.scrollIntoView === 'function') {
            tgt.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
          }
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

  // ---- I. Product preview modal -----------------------------------------
  // Scene-based, data-driven walkthrough. Two tracks (course / german),
  // chapter dots, autoplay with countdown, full keyboard + a11y support.
  // _pvApi is read by the Watch button handler and applyLang (live relang).

  var _pvApi = null;

  function initPreviewModal() {
    var modal = document.getElementById('nlPreviewModal');
    if (!modal) return;

    var els = {
      dialog:  modal.querySelector('.nl-pv__dialog'),
      chooser: document.getElementById('nlPvChooser'),
      player:  document.getElementById('nlPvPlayer'),
      stage:   document.getElementById('nlPvStage'),
      visual:  document.getElementById('nlPvVisual'),
      eyebrow: document.getElementById('nlPvEyebrow'),
      headline:document.getElementById('nlPvHeadline'),
      body:    document.getElementById('nlPvBody'),
      cta:     document.getElementById('nlPvCta'),
      prev:    document.getElementById('nlPvPrev'),
      next:    document.getElementById('nlPvNext'),
      dots:    document.getElementById('nlPvDots'),
      live:    document.getElementById('nlPvLive'),
      sw:      document.getElementById('nlPvSwitch'),
      close:   document.getElementById('nlPvClose')
    };

    var state = { track: null, index: 0, playing: false, timer: null, shellTimer: null, courseTimer: null, uploadTimer: null, lastFocus: null, hover: false };

    // -- i18n resolvers (fall back to EN if a key is missing) --
    function t(key) {
      var v = _resolveKey(I18N[_currentLang] || I18N.en, 'preview.' + key);
      if (v == null) v = _resolveKey(I18N.en, 'preview.' + key);
      return v == null ? '' : v;
    }
    function tFull(key) {
      var v = _resolveKey(I18N[_currentLang] || I18N.en, key);
      if (v == null) v = _resolveKey(I18N.en, key);
      return v == null ? '' : v;
    }
    function L(k) { return t('labels.' + k); }
    function M(k) { return t('mock.' + k); }

    // -- DOM helpers --
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function mock(extraClass) { return el('div', 'nl-pv__mock' + (extraClass ? ' ' + extraClass : '')); }
    function row(icon, name, meta) {
      var r = el('div', 'nl-pv-row');
      var i = el('span', 'nl-pv-row__icon'); i.appendChild(buildSvgUse(icon, 16)); r.appendChild(i);
      r.appendChild(el('span', 'nl-pv-row__name', name));
      if (meta != null && meta !== '') r.appendChild(el('span', 'nl-pv-row__meta', meta));
      return r;
    }
    function bar(pct) {
      var b = el('div', 'nl-pv-bar'); var f = el('span', 'nl-pv-bar__fill'); f.style.width = pct + '%'; b.appendChild(f); return b;
    }
    function chip(icon, text) {
      var c = el('span', 'nl-pv-chip'); c.appendChild(buildSvgUse(icon, 12)); c.appendChild(el('span', null, text)); return c;
    }
    function badge(icon, text) {
      var b = el('span', 'nl-pv-badge'); b.appendChild(buildSvgUse(icon, 12)); b.appendChild(el('span', null, text)); return b;
    }
    function ansLine(label, val) {
      var l = el('div', 'nl-pv-ans__line');
      l.appendChild(el('span', 'nl-pv-ans__label', label));
      l.appendChild(el('span', 'nl-pv-ans__val', val));
      return l;
    }
    function tile(icon, name, sub) {
      var ti = el('div', 'nl-pv-tile');
      var ic = el('span', 'nl-pv-tile__icon'); ic.appendChild(buildSvgUse(icon, 18)); ti.appendChild(ic);
      ti.appendChild(el('span', 'nl-pv-tile__name', name));
      ti.appendChild(el('span', 'nl-pv-tile__sub', sub));
      return ti;
    }
    function navIcon(label, icon, active) {
      var item = el('div', 'nl-mini-nav__item' + (active ? ' is-active' : ''));
      item.setAttribute('title', label);
      item.setAttribute('aria-label', label);
      item.setAttribute('data-tour-page', label);
      var wrap = el('span', 'nl-mini-nav__icon');
      wrap.appendChild(buildSvgUse(icon, 24));
      item.appendChild(wrap);
      item.appendChild(el('b', null, label));
      return item;
    }
    function appShell(active, main) {
      var frame = el('div', 'nl-tour nl-tour--shell');
      var screen = el('div', 'nl-tour__screen');
      var shell = el('div', 'nl-mini-shell');
      var aside = el('aside', 'nl-mini-nav');
      var list = el('div', 'nl-mini-nav-list');
      [
        ['Home', 'sb-home'],
        ['Courses', 'sb-courses'],
        ['Lecture Notes', 'sb-notes'],
        ['Editor', 'sb-editor'],
        ['Chatbot', 'sb-chatbot'],
        ['Chat', 'sb-chat'],
        ['__divider__', ''],
        ['Notifications', 'bell']
      ].forEach(function (p) {
        if (p[0] === '__divider__') list.appendChild(el('i', 'nl-mini-divider'));
        else list.appendChild(navIcon(p[0], p[1], p[0] === active));
      });
      aside.appendChild(list);
      shell.appendChild(aside);
      var content = el('section', 'nl-mini-main');
      var top = el('div', 'nl-mini-top');
      top.appendChild(el('strong', null, active === 'Home' ? 'Dashboard' : active));
      top.appendChild(el('span', null, tFull('logo.tag')));
      content.appendChild(top);
      var scroll = el('div', 'nl-mini-scroll');
      scroll.appendChild(main);
      content.appendChild(scroll);
      shell.appendChild(content);
      screen.appendChild(shell);
      frame.appendChild(screen);
      return frame;
    }
    function clearShellCursor() {
      if (state.shellTimer) {
        clearTimeout(state.shellTimer);
        state.shellTimer = null;
      }
    }
    function startShellCursor() {
      clearShellCursor();
      var frame = els.visual.querySelector('.nl-tour--shell');
      if (!frame || prefersReducedMotion) return;
      var cursor = frame.querySelector('.nl-shell-cursor');
      var pop = frame.querySelector('.nl-shell-popover');
      var title = el('strong');
      var body = el('span');
      clearChildren(pop);
      pop.appendChild(title);
      pop.appendChild(body);
      var pages = [
        ['Home', 'Dashboard', 'Your starting place: the empty overview before opening any course or study tool.'],
        ['Courses', 'Courses', 'Course workspaces for subjects, folders, uploaded PDFs, exercises, and formulas.'],
        ['Lecture Notes', 'Lecture Notes', 'The note area for lecture material and coming note workflows.'],
        ['Editor', 'Editor', 'The PDF and writing workspace for marking, editing, and saving documents.'],
        ['Chatbot', 'Chatbot', 'The full AI chat page for wider course-grounded study conversations.'],
        ['Chat', 'Chat', 'Rooms and classmates for study conversations outside the AI tutor.']
      ];
      function step(i) {
        var page = pages[i % pages.length];
        var target = frame.querySelector('[data-tour-page="' + page[0] + '"]');
        if (!target) return;
        frame.querySelectorAll('.nl-mini-nav__item.is-tour-hover').forEach(function (node) {
          node.classList.remove('is-tour-hover');
        });
        target.classList.add('is-tour-hover');
        var fr = frame.getBoundingClientRect();
        var tr = target.getBoundingClientRect();
        var cx = tr.left - fr.left + (tr.width / 2);
        var cy = tr.top - fr.top + (tr.height / 2);
        cursor.style.transform = 'translate(' + Math.round(cx + 20) + 'px, ' + Math.round(cy + 10) + 'px)';
        pop.style.transform = 'translate(' + Math.round(cx + 48) + 'px, ' + Math.round(cy - 18) + 'px)';
        title.textContent = page[1];
        body.textContent = page[2];
        state.shellTimer = setTimeout(function () { step(i + 1); }, 1600);
      }
      requestAnimationFrame(function () { step(0); });
    }
    function clearCourseSetupCursor() {
      if (state.courseTimer) {
        clearTimeout(state.courseTimer);
        state.courseTimer = null;
      }
    }
    function courseSetupScene() {
      var frame = appShell('Courses', el('div', 'nl-mini-studip'));
      frame.classList.add('nl-tour--course-setup');
      var root = frame.querySelector('.nl-mini-studip');
      var shell = el('div', 'sd-shell');
      root.appendChild(shell);

      var hero = el('section', 'sd-hero');
      hero.appendChild(el('div', 'sd-hero-glow'));
      var heroGrid = el('div', 'sd-hero-grid');
      var heroLeft = el('div', 'sd-hero-left');
      var eyebrow = el('div', 'sd-hero-eyebrow');
      eyebrow.appendChild(buildSvgUse('plus', 14));
      eyebrow.appendChild(el('span', null, 'AI-ready course workspace'));
      heroLeft.appendChild(eyebrow);
      var title = el('h1', 'sd-hero-title');
      title.appendChild(el('span', 'sd-hero-emoji', '📚'));
      title.appendChild(el('span', null, 'My Courses'));
      heroLeft.appendChild(title);
      heroLeft.appendChild(el('p', 'sd-hero-sub', 'Organize your semester, upload lecture files, and open AI, notes, or summaries directly from each subject.'));
      var stats = el('div', 'sd-hero-stats');
      [['semester', 'SS 2026'], ['courses', '0 courses'], ['files', '0 files'], ['progress', '0% avg progress']].forEach(function (s, idx) {
        var stat = el('span', 'sd-hero-stat');
        if (idx === 0) stat.appendChild(el('span', 'sd-hero-stat-dot'));
        stat.appendChild(el('span', null, s[1]));
        stat.setAttribute('data-mini-stat', s[0]);
        stats.appendChild(stat);
      });
      heroLeft.appendChild(stats);
      heroGrid.appendChild(heroLeft);
      var actions = el('div', 'sd-hero-actions');
      var semWrap = el('div', 'sd-hero-sem');
      var semBtn = el('button', 'sem-btn sd-sem-btn');
      semBtn.type = 'button';
      semBtn.appendChild(el('span', 'sem-btn-l', '● SS 2026'));
      semBtn.appendChild(el('span', 'sem-chev', '▼'));
      semWrap.appendChild(semBtn);
      actions.appendChild(semWrap);
      var addBtn = el('button', 'sd-add-btn');
      addBtn.type = 'button';
      addBtn.setAttribute('data-course-target', 'add');
      addBtn.appendChild(buildSvgUse('plus', 16));
      addBtn.appendChild(el('span', null, 'Add Subject'));
      actions.appendChild(addBtn);
      heroGrid.appendChild(actions);
      hero.appendChild(heroGrid);
      shell.appendChild(hero);

      var controls = el('div', 'sd-controls');
      var searchWrap = el('div', 'sd-search-wrap');
      searchWrap.appendChild(buildSvgUse('search', 16));
      searchWrap.querySelector('svg').classList.add('sd-search-icon');
      var input = el('div', 'sd-search-input');
      input.setAttribute('data-course-target', 'search');
      input.appendChild(el('span', 'nl-mini-type-placeholder', 'Search subjects...'));
      input.appendChild(el('span', 'nl-mini-type-value'));
      searchWrap.appendChild(input);
      var drop = el('div', 'sd-search-drop');
      drop.appendChild(el('div', 'nl-mini-search-option', 'Ingenieurmathematik A'));
      searchWrap.appendChild(drop);
      controls.appendChild(searchWrap);
      var layoutBtn = el('button', 'sd-layout-btn', 'Manage layout');
      layoutBtn.type = 'button';
      controls.appendChild(layoutBtn);
      shell.appendChild(controls);

      var list = el('div', 'sd-course-grid');
      var empty = el('div', 'sd-empty-state');
      empty.setAttribute('data-course-target', 'empty');
      empty.appendChild(el('div', 'sd-empty-icon', '📚'));
      empty.appendChild(el('div', 'sd-empty-title', 'No subjects yet'));
      empty.appendChild(el('div', 'sd-empty-sub', "Use the search above to add the courses you're taking this semester."));
      list.appendChild(empty);
      var card = el('article', 'sd-course-card sd-course-card-empty');
      card.setAttribute('data-course-target', 'card');
      card.style.setProperty('--sd-card-accent', '#2563eb');
      card.innerHTML =
        '<div class="sd-course-bar"></div>' +
        '<button type="button" class="sd-del-btn" aria-label="Remove course" title="Remove"></button>' +
        '<header class="sd-course-head"><div class="sd-course-icon" aria-hidden="true">📊</div><div class="sd-course-head-text"><h3 class="sd-course-name">Ingenieurmathematik A</h3><div class="sd-course-chips"><span class="sd-course-chip sd-course-chip-files">0 files</span><span class="sd-course-chip sd-course-chip-time">just now</span></div></div></header>' +
        '<div class="sd-course-empty-msg"><svg class="sd-course-empty-icon" width="20" height="20"><use href="#i-upload-cloud"></use></svg><div><div class="sd-course-empty-msg-title">No files yet</div><div class="sd-course-empty-msg-sub">Upload lectures, exercises, or formula sheets to start.</div></div></div>' +
        '<button type="button" class="sd-course-open-btn" data-course-target="open">Open course</button>';
      list.appendChild(card);
      shell.appendChild(list);

      frame.appendChild(el('span', 'nl-shell-cursor nl-course-cursor'));
      frame.appendChild(el('div', 'nl-shell-popover nl-course-popover'));
      return frame;
    }
    function startCourseSetupCursor() {
      clearCourseSetupCursor();
      var frame = els.visual.querySelector('.nl-tour--course-setup');
      if (!frame || prefersReducedMotion) return;
      var cursor = frame.querySelector('.nl-course-cursor');
      var pop = frame.querySelector('.nl-course-popover');
      var title = el('strong');
      var body = el('span');
      clearChildren(pop);
      pop.appendChild(title);
      pop.appendChild(body);
      var value = frame.querySelector('.nl-mini-type-value');
      var placeholder = frame.querySelector('.nl-mini-type-placeholder');
      var drop = frame.querySelector('.sd-search-drop');
      var empty = frame.querySelector('[data-course-target="empty"]');
      var card = frame.querySelector('[data-course-target="card"]');
      var courseStat = frame.querySelector('[data-mini-stat="courses"] span:last-child');
      var typingToken = 0;
      var steps = [
        { target: '[data-tour-page="Courses"]', title: 'Courses', body: 'Click Courses in the real sidebar.', typed: '', phase: 'empty' },
        { target: '[data-course-target="search"]', title: 'Course name', body: 'Type the subject name into the course search field.', typed: 'Ingenieurmathematik A', phase: 'typing' },
        { target: '[data-course-target="add"]', title: 'Add Subject', body: 'Click Add Subject to create the course.', typed: 'Ingenieurmathematik A', phase: 'ready' },
        { target: '[data-course-target="open"]', title: 'Ingenieurmathematik A', body: 'The new course card appears in front of you, ready to open.', typed: 'Ingenieurmathematik A', phase: 'created' }
      ];
      function applyPhase(step) {
        typingToken++;
        if (value) value.textContent = '';
        if (placeholder) placeholder.hidden = !!step.typed;
        if (drop) drop.style.display = step.phase === 'typing' ? 'block' : 'none';
        if (empty) empty.hidden = step.phase === 'created';
        if (card) card.classList.toggle('is-created', step.phase === 'created');
        if (courseStat) courseStat.textContent = step.phase === 'created' ? '1 course' : '0 courses';
        if (!value || !step.typed) return;
        if (step.phase !== 'typing') {
          value.textContent = step.typed;
          return;
        }
        var token = typingToken;
        var chars = step.typed.split('');
        chars.forEach(function (_ch, idx) {
          setTimeout(function () {
            if (token !== typingToken) return;
            value.textContent = step.typed.slice(0, idx + 1);
          }, idx * 58);
        });
      }
      function moveTo(selector, step) {
        var target = frame.querySelector(selector);
        if (!target) return;
        frame.querySelectorAll('.is-tour-hover').forEach(function (node) {
          node.classList.remove('is-tour-hover');
        });
        target.classList.add('is-tour-hover');
        var fr = frame.getBoundingClientRect();
        var tr = target.getBoundingClientRect();
        var cx = tr.left - fr.left + (tr.width / 2);
        var cy = tr.top - fr.top + (tr.height / 2);
        cursor.style.transform = 'translate(' + Math.round(cx + 10) + 'px, ' + Math.round(cy) + 'px)';
        var popW = 310;
        var rightSide = cx > fr.width * 0.62;
        var px = rightSide ? Math.max(92, cx - popW - 56) : Math.min(cx + 44, fr.width - popW - 12);
        var py = step.phase === 'ready' ? Math.max(72, cy + 32) : Math.max(72, cy - 22);
        pop.style.transform = 'translate(' + Math.round(px) + 'px, ' + Math.round(py) + 'px)';
        title.textContent = step.title;
        body.textContent = step.body;
      }
      function step(i) {
        var s = steps[i % steps.length];
        applyPhase(s);
        moveTo(s.target, s);
        state.courseTimer = setTimeout(function () { step(i + 1); }, i === 1 ? 2300 : 1800);
      }
      requestAnimationFrame(function () { step(0); });
    }
    function clearUploadCursor() {
      if (state.uploadTimer) {
        clearTimeout(state.uploadTimer);
        state.uploadTimer = null;
      }
    }
    function courseUploadScene() {
      var frame = appShell('Courses', el('div', 'nl-mini-course-view'));
      frame.classList.add('nl-tour--upload-flow');
      var root = frame.querySelector('.nl-mini-course-view');
      var inner = el('div', 'co-inner co-inner-v2');
      inner.style.setProperty('--co-hero-accent', '#2563eb');
      root.appendChild(inner);

      var top = el('div', 'co-topnav');
      var back = el('button', 'co-back-btn');
      back.type = 'button';
      back.appendChild(buildSvgUse('chevron-right', 14));
      back.appendChild(el('span', null, 'Back'));
      top.appendChild(back);
      top.appendChild(el('div', 'co-topnav-title', 'Ingenieurmathematik A'));
      var study = el('button', 'co-study-btn');
      study.type = 'button';
      study.appendChild(el('span', null, 'Study'));
      top.appendChild(study);
      inner.appendChild(top);

      var hero = el('section', 'co-hero');
      hero.appendChild(el('div', 'co-hero-glow'));
      var grid = el('div', 'co-hero-grid');
      var left = el('div', 'co-hero-left');
      var body = el('div', 'co-hero-body');
      body.appendChild(el('h1', 'co-hero-title', 'Ingenieurmathematik A'));
      body.appendChild(el('p', 'co-hero-sub', 'Manage files, generate quizzes, study flashcards, and open AI or notes inside this course.'));
      left.appendChild(body);
      grid.appendChild(left);
      var progress = el('aside', 'co-hero-progress');
      progress.innerHTML = '<div class="co-hero-progress-head"><span class="co-hero-progress-label">Study progress</span><span class="co-hero-progress-value">0%</span></div><div class="co-hero-progress-track"><div class="co-hero-progress-fill" style="width:0%"></div></div><div class="co-hero-progress-stats"><span class="co-hero-stat-pill">Read 0%</span><span class="co-hero-stat-pill">Notes 0%</span><span class="co-hero-stat-pill">Practice 0%</span><span class="co-hero-stat-pill">AI 0%</span></div>';
      grid.appendChild(progress);
      hero.appendChild(grid);
      inner.appendChild(hero);

      var card = el('div', 'co-card co-card-v2');
      card.innerHTML =
        '<div class="co-course-tabs" role="tablist" aria-label="Course sections">' +
          '<button class="co-course-tab active" type="button" data-upload-target="files-tab"><span>Files</span></button>' +
          '<button class="co-course-tab" type="button"><span>Quiz</span></button>' +
          '<button class="co-course-tab" type="button"><span>Flashcards</span></button>' +
        '</div>' +
        '<div class="co-course-panel active" data-course-panel="files">' +
          '<div class="co-files-inner-card">' +
            '<div class="co-panel-header co-panel-header-v2">' +
              '<div class="co-panel-header-text"><h2 class="co-panel-title">Files</h2><p class="co-panel-sub">Folders and course documents · <b data-upload-count>0</b> total · <b>0</b> studied · <b>0</b> unread</p></div>' +
              '<div class="co-files-toolbar co-files-actions">' +
                '<button class="co-select-toggle co-tool-btn"><span>Select multiple</span></button>' +
                '<button class="co-new-folder-btn co-tool-btn"><span>New folder</span></button>' +
                '<button class="co-upload-btn co-tool-btn co-tool-btn-primary" data-upload-target="upload"><svg width="13" height="13"><use href="#i-upload-cloud"></use></svg><span>Upload files</span></button>' +
                '<button class="co-tool-btn"><span>Update AI index</span></button>' +
              '</div>' +
            '</div>' +
            '<div class="co-files-search-row"><div class="co-files-search-wrap"><svg class="co-files-search-icon" width="14" height="14"><use href="#i-search"></use></svg><div class="co-files-search-input">Search files, folders, formulas, exercises...</div></div></div>' +
            '<div class="co-files-list"><div class="co-separate-files"><div class="co-separate-files-head"><div><div class="co-separate-files-title">Separate files</div><div class="co-separate-files-sub">Files that are not inside a folder</div></div></div><div class="co-files-loading" data-upload-empty>No files yet - click Upload files to add some</div><div class="co-file co-file-uploaded" data-upload-target="file-row"><span class="co-file-icon">📄</span><span class="co-file-name">Ingenieurmathematik_A_Skript.pdf</span><span class="co-file-meta">2.4 MB · Uploaded</span></div></div></div>' +
          '</div>' +
        '</div>';
      inner.appendChild(card);

      var chooser = el('div', 'nl-file-picker');
      chooser.setAttribute('data-upload-target', 'picker');
      chooser.innerHTML = '<div class="nl-file-picker__bar"><b>Choose file</b><span>Minallo upload</span></div><div class="nl-file-picker__row is-selected"><span>📄</span><strong>Ingenieurmathematik_A_Skript.pdf</strong><em>PDF · 2.4 MB</em></div><button type="button">Open</button>';
      frame.appendChild(chooser);

      var modal = el('div', 'co-upmodal-overlay nl-mini-upload-modal');
      modal.setAttribute('data-upload-target', 'modal');
      modal.innerHTML =
        '<div class="co-upmodal" role="dialog" aria-modal="true" aria-labelledby="coUpModalTitle">' +
          '<div class="co-upmodal-head"><div class="co-upmodal-head-icon"><svg width="22" height="22"><use href="#i-upload-cloud"></use></svg></div><div class="co-upmodal-head-text"><h3 class="co-upmodal-head-title">Upload Files</h3><p class="co-upmodal-head-sub">Add PDFs, documents, images, and more</p></div><button class="co-upmodal-close" type="button" aria-label="Close">×</button></div>' +
          '<div class="co-upmodal-body"><div class="co-upmodal-hero"><div class="nl-mini-upload-file">📄 Ingenieurmathematik_A_Skript.pdf</div><h2>Preparing Your Materials</h2><p>We are analyzing your content and creating smart study materials.</p></div>' +
          '<div class="co-upmodal-stages"><div class="co-upmodal-stage" data-stage="upload" data-state="active"><div class="co-upmodal-stage-icon">⬆</div><p class="co-upmodal-stage-title">Upload</p><p class="co-upmodal-stage-status">In Progress</p></div><div class="co-upmodal-stage" data-stage="processing" data-state="pending"><div class="co-upmodal-stage-icon">📖</div><p class="co-upmodal-stage-title">Processing</p><p class="co-upmodal-stage-status">Pending...</p></div><div class="co-upmodal-stage" data-stage="ready" data-state="pending"><div class="co-upmodal-stage-icon">🎓</div><p class="co-upmodal-stage-title">Ready for AI</p><p class="co-upmodal-stage-status">Pending...</p></div></div>' +
          '<div class="co-upmodal-bars"><div class="co-upmodal-bar-row" data-bar="upload"><div class="co-upmodal-bar-label"><strong>Uploading</strong><span class="co-upmodal-bar-pct">0%</span></div><div class="co-upmodal-bar-track"><div class="co-upmodal-bar-fill"></div></div></div><div class="co-upmodal-bar-row" data-bar="processing"><div class="co-upmodal-bar-label"><strong>Processing Progress</strong><span class="co-upmodal-bar-pct">0%</span></div><div class="co-upmodal-bar-track"><div class="co-upmodal-bar-fill"></div></div></div></div></div>' +
          '<div class="co-upmodal-foot"><p>We are processing your materials with AI to create the best study experience</p></div>' +
        '</div>';
      frame.appendChild(modal);
      frame.appendChild(el('span', 'nl-shell-cursor nl-upload-cursor'));
      frame.appendChild(el('div', 'nl-shell-popover nl-upload-popover'));
      return frame;
    }
    function startUploadCursor() {
      clearUploadCursor();
      var frame = els.visual.querySelector('.nl-tour--upload-flow');
      if (!frame || prefersReducedMotion) return;
      var cursor = frame.querySelector('.nl-upload-cursor');
      var pop = frame.querySelector('.nl-upload-popover');
      var title = el('strong');
      var body = el('span');
      clearChildren(pop);
      pop.appendChild(title);
      pop.appendChild(body);
      var picker = frame.querySelector('[data-upload-target="picker"]');
      var modal = frame.querySelector('[data-upload-target="modal"]');
      var empty = frame.querySelector('[data-upload-empty]');
      var row = frame.querySelector('[data-upload-target="file-row"]');
      var count = frame.querySelector('[data-upload-count]');
      var steps = [
        { target: '[data-course-target="open"], [data-upload-target="files-tab"]', title: 'Open course', body: 'Open Ingenieurmathematik A and land on the Files tab.', phase: 'course' },
        { target: '[data-upload-target="upload"]', title: 'Upload files', body: 'Click Upload files in the real course toolbar.', phase: 'button' },
        { target: '[data-upload-target="picker"] .is-selected', title: 'Choose file', body: 'Select the PDF you need for this course.', phase: 'picker' },
        { target: '[data-upload-target="modal"] .co-upmodal-stage[data-stage="upload"]', title: 'Upload Files', body: 'The upload modal opens and shows progress.', phase: 'modal-upload' },
        { target: '[data-upload-target="modal"] .co-upmodal-stage[data-stage="processing"]', title: 'Processing', body: 'Minallo processes the file so AI can use it.', phase: 'modal-processing' },
        { target: '[data-upload-target="file-row"]', title: 'File ready', body: 'The uploaded file appears in the course files list.', phase: 'done' }
      ];
      function setBar(kind, pct) {
        var rowEl = frame.querySelector('.co-upmodal-bar-row[data-bar="' + kind + '"]');
        if (!rowEl) return;
        var fill = rowEl.querySelector('.co-upmodal-bar-fill');
        var label = rowEl.querySelector('.co-upmodal-bar-pct');
        if (fill) fill.style.width = pct + '%';
        if (label) label.textContent = pct + '%';
      }
      function setStage(name, stateName, status) {
        var st = frame.querySelector('.co-upmodal-stage[data-stage="' + name + '"]');
        if (!st) return;
        st.setAttribute('data-state', stateName);
        var statusEl = st.querySelector('.co-upmodal-stage-status');
        if (statusEl && status) statusEl.textContent = status;
      }
      function applyPhase(phase) {
        if (picker) picker.classList.toggle('is-visible', phase === 'picker');
        if (modal) modal.classList.toggle('is-visible', phase === 'modal-upload' || phase === 'modal-processing');
        if (empty) empty.hidden = phase === 'done';
        if (row) row.classList.toggle('is-visible', phase === 'done');
        if (count) count.textContent = phase === 'done' ? '1' : '0';
        setBar('upload', phase === 'modal-processing' || phase === 'done' ? 100 : phase === 'modal-upload' ? 72 : 0);
        setBar('processing', phase === 'done' ? 100 : phase === 'modal-processing' ? 58 : 0);
        setStage('upload', phase === 'modal-processing' || phase === 'done' ? 'complete' : phase === 'modal-upload' ? 'active' : 'pending', phase === 'modal-processing' || phase === 'done' ? 'Complete' : phase === 'modal-upload' ? 'In Progress' : 'Pending...');
        setStage('processing', phase === 'done' ? 'complete' : phase === 'modal-processing' ? 'active' : 'pending', phase === 'done' ? 'Complete' : phase === 'modal-processing' ? 'In Progress' : 'Pending...');
        setStage('ready', phase === 'done' ? 'complete' : 'pending', phase === 'done' ? 'Ready' : 'Pending...');
      }
      function moveTo(selector, step) {
        var target = frame.querySelector(selector);
        if (!target) return;
        frame.querySelectorAll('.is-tour-hover').forEach(function (node) { node.classList.remove('is-tour-hover'); });
        target.classList.add('is-tour-hover');
        var fr = frame.getBoundingClientRect();
        var tr = target.getBoundingClientRect();
        var cx = tr.left - fr.left + tr.width / 2;
        var cy = tr.top - fr.top + tr.height / 2;
        cursor.style.transform = 'translate(' + Math.round(cx + 10) + 'px, ' + Math.round(cy) + 'px)';
        var popW = 310;
        var px = cx > fr.width * 0.58 ? Math.max(92, cx - popW - 54) : Math.min(cx + 44, fr.width - popW - 12);
        var py = Math.max(72, Math.min(cy - 22, fr.height - 108));
        pop.style.transform = 'translate(' + Math.round(px) + 'px, ' + Math.round(py) + 'px)';
        title.textContent = step.title;
        body.textContent = step.body;
      }
      function step(i) {
        var s = steps[i % steps.length];
        applyPhase(s.phase);
        moveTo(s.target, s);
        state.uploadTimer = setTimeout(function () { step(i + 1); }, s.phase.indexOf('modal') === 0 ? 1900 : 1700);
      }
      requestAnimationFrame(function () { step(0); });
    }

    // -- scene visual builders (each returns a DOM node) --
    var builders = {
      shell: function () {
        var frame = appShell('Home', el('div', 'nl-mini-empty-dashboard'));
        frame.appendChild(el('span', 'nl-shell-cursor'));
        frame.appendChild(el('div', 'nl-shell-popover'));
        return frame;
      },
      courseSetup: function () {
        return courseSetupScene();
      },
      courseUpload: function () {
        return courseUploadScene();
      },
      ask: function () {
        var m = mock('nl-pv-ask-scene');
        var top = el('div', 'nl-pv-ask-head');
        var title = el('div', 'nl-pv-ask-title');
        title.appendChild(buildSvgUse('sparkles', 16));
        title.appendChild(el('span', null, 'Minallo AI'));
        top.appendChild(title);
        top.appendChild(el('span', 'nl-pv-ask-context', 'Engineering Mechanics 2'));
        m.appendChild(top);

        var chat = el('div', 'nl-pv-ask-chat');
        var composer = el('div', 'nl-pv-ask-composer');
        composer.appendChild(buildSvgUse('search', 14));
        composer.appendChild(el('span', 'nl-pv-ask-typed', 'Solve exercise 6 using my lecture method and cite the formula.'));
        var send = el('span', 'nl-pv-ask-send');
        send.appendChild(buildSvgUse('arrow-right', 13));
        composer.appendChild(send);
        chat.appendChild(composer);

        chat.appendChild(el('div', 'nl-pv-bubble nl-pv-bubble--user nl-pv-ask-user', 'Solve exercise 6 using my lecture method and cite the formula.'));

        var thinking = el('div', 'nl-pv-ask-thinking');
        thinking.appendChild(el('span'));
        thinking.appendChild(el('span'));
        thinking.appendChild(el('span'));
        chat.appendChild(thinking);

        var answer = el('div', 'nl-pv-bubble nl-pv-bubble--ai nl-pv-ask-answer');
        answer.appendChild(el('p', null, 'I found the matching exercise and formula sheet. Use the equilibrium equations, substitute the given force and distances, then check the signs with force balance.'));
        answer.appendChild(el('div', 'nl-pv-formula', 'ΣF = 0  ·  ΣM = 0'));
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('file-text', 'Lecture 03 · p.12'));
        chips.appendChild(chip('pen-tool', 'Exercise Sheet 06 · p.2'));
        answer.appendChild(chips);
        chat.appendChild(answer);

        m.appendChild(chat);
        return m;
      },
      sources: function () {
        var m = mock();
        m.appendChild(row('search', t('course.sources.chapter'), ''));
        m.appendChild(bar(82)); m.appendChild(bar(96)); m.appendChild(bar(68));
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('file-text', M('src1')));
        chips.appendChild(chip('pen-tool', M('src2')));
        chips.appendChild(chip('book-open', M('src3')));
        m.appendChild(chips);
        return m;
      },
      answer: function () {
        var m = mock();
        m.appendChild(ansLine(L('given'), M('ansGiven')));
        m.appendChild(ansLine(L('required'), M('ansRequired')));
        m.appendChild(el('div', 'nl-pv-formula', 'ΣF = 0   ·   ΣM = 0'));
        m.appendChild(ansLine(L('steps'), M('ansSteps')));
        m.appendChild(ansLine(L('finalAnswer'), M('ansFinal')));
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('file-text', tFull('tutorPreview.cite1')));
        chips.appendChild(chip('book-open', tFull('tutorPreview.cite2')));
        m.appendChild(chips);
        return m;
      },
      trust: function () {
        var m = mock();
        m.appendChild(el('div', 'nl-pv-bubble nl-pv-bubble--ai', M('trustMsg')));
        m.appendChild(badge('shield-check', L('verified')));
        return m;
      },
      tools: function () {
        var m = mock();
        var t2 = el('div', 'nl-pv-tiles');
        t2.appendChild(tile('pen-tool', L('annotate'), L('annotateSub')));
        t2.appendChild(tile('layers-3', L('flashcards'), L('flashcardsSub')));
        t2.appendChild(tile('check-circle-2', L('quiz'), L('quizSub')));
        t2.appendChild(tile('file-text', L('summary'), L('summarySub')));
        m.appendChild(t2);
        return m;
      },
      focus: function () {
        var m = mock();
        m.appendChild(el('div', 'nl-pv-ring', '25:00'));
        var sr = el('div', 'nl-pv-streak');
        sr.appendChild(buildSvgUse('trophy', 16));
        sr.appendChild(el('span', null, L('dayStreak')));
        m.appendChild(sr);
        m.appendChild(row('music-2', L('focus'), '♪'));
        return m;
      },
      gIntro: function () {
        var m = mock();
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('languages', 'der · die · das'));
        chips.appendChild(chip('book-open', 'A1 – B2'));
        m.appendChild(chips);
        m.appendChild(row('languages', t('german.intro.chapter'), ''));
        return m;
      },
      gVocab: function () {
        var m = mock();
        var card = el('div', 'nl-pv-flip');
        var inner = el('div');
        inner.appendChild(el('div', 'nl-pv-flip__front', M('vocabFront')));
        inner.appendChild(el('div', 'nl-pv-flip__back', M('vocabBack')));
        card.appendChild(inner);
        m.appendChild(card);
        m.appendChild(el('p', 'nl-pv-tile__sub', L('tapToFlip')));
        return m;
      },
      gGrammar: function () {
        var m = mock();
        m.appendChild(badge('graduation-cap', t('german.grammar.chapter')));
        m.appendChild(el('div', 'nl-pv-bubble nl-pv-bubble--ai', M('grammarTip')));
        return m;
      },
      gSentences: function () {
        var m = mock();
        m.appendChild(row('quote', M('sentence1'), ''));
        m.appendChild(el('p', 'nl-pv-tile__sub', M('sentence1Gloss')));
        m.appendChild(row('quote', M('sentence2'), ''));
        m.appendChild(el('p', 'nl-pv-tile__sub', M('sentence2Gloss')));
        return m;
      },
      gGames: function () {
        var m = mock();
        m.appendChild(el('div', 'nl-pv-flip__front', M('gameQ')));
        var chips = el('div', 'nl-pv-chips');
        ['der', 'die', 'das'].forEach(function (opt) {
          var c = chip('gamepad-2', opt);
          if (opt === M('gameA')) c.style.borderColor = 'rgba(110,231,183,0.55)';
          chips.appendChild(c);
        });
        m.appendChild(chips);
        return m;
      },
      gStreak: function () {
        var m = mock();
        var sr = el('div', 'nl-pv-streak');
        sr.appendChild(buildSvgUse('trophy', 16));
        sr.appendChild(el('span', null, L('dayStreak')));
        m.appendChild(sr);
        m.appendChild(bar(72));
        return m;
      },
      gCta: function () {
        var m = mock();
        var ic = el('div', 'nl-pv-tile__icon'); ic.appendChild(buildSvgUse('sparkles', 26)); m.appendChild(ic);
        m.appendChild(el('div', 'nl-pv-flip__front', 'Deutsch'));
        return m;
      }
    };

    // -- track definitions (single source of truth) --
    var TRACKS = {
      course: [
        { keyBase: 'course.shell',   build: 'shell',   ms: 10400 },
        { keyBase: 'course.setup',   build: 'courseSetup', ms: 8400 },
        { keyBase: 'course.upload',  build: 'courseUpload', ms: 11200 },
        { keyBase: 'course.ask',     build: 'ask',     ms: 7600 },
        { keyBase: 'course.sources', build: 'sources', ms: 4200 },
        { keyBase: 'course.answer',  build: 'answer',  ms: 6000 },
        { keyBase: 'course.trust',   build: 'trust',   ms: 5000 },
        { keyBase: 'course.tools',   build: 'tools',   ms: 4600 },
        { keyBase: 'course.focus',   build: 'focus',   ms: 4600 }
      ],
      german: [
        { keyBase: 'german.intro',     build: 'gIntro',     ms: 4200 },
        { keyBase: 'german.vocab',     build: 'gVocab',     ms: 4200 },
        { keyBase: 'german.grammar',   build: 'gGrammar',   ms: 4600 },
        { keyBase: 'german.sentences', build: 'gSentences', ms: 4600 },
        { keyBase: 'german.games',     build: 'gGames',     ms: 4400 },
        { keyBase: 'german.streak',    build: 'gStreak',    ms: 4200 },
        { keyBase: 'german.cta',       build: 'gCta',       ms: 4600 }
      ]
    };

    function scenes() { return TRACKS[state.track] || TRACKS.course; }
    function isLast() { return state.index >= scenes().length - 1; }

    // -- autoplay timer --
    function clearTimer() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }
    function armTimer() {
      clearTimer();
      if (!state.playing || prefersReducedMotion || state.hover || isLast()) return;
      var ms = scenes()[state.index].ms || 4000;
      state.timer = setTimeout(function () { goto(state.index + 1, true); }, ms);
    }

    // -- render --
    function renderDots() {
      clearChildren(els.dots);
      var list = scenes();
      for (var i = 0; i < list.length; i++) {
        (function (idx) {
          var sc = list[idx];
          var label = t(sc.keyBase + '.chapter') || '';
          var d = el('button', 'nl-pv__dot'); d.type = 'button';
          d.setAttribute('role', 'tab');
          d.setAttribute('aria-label', label);
          d.appendChild(el('span', 'nl-pv__dot-pip'));
          d.appendChild(el('span', 'nl-pv__dot-label', label));
          if (idx === state.index) {
            d.classList.add('is-active');
            d.setAttribute('aria-current', 'true');
            if (state.playing && !prefersReducedMotion) d.classList.add('is-playing');
          } else if (idx < state.index) {
            d.classList.add('is-done');
          }
          d.addEventListener('click', function () { state.playing = false; goto(idx, false); });
          els.dots.appendChild(d);
        })(i);
      }
    }

    function paint() {
      var sc = scenes()[state.index];
      clearShellCursor();
      clearCourseSetupCursor();
      clearUploadCursor();
      clearChildren(els.visual);
      if (builders[sc.build]) els.visual.appendChild(builders[sc.build]());
      if (sc.build === 'shell') startShellCursor();
      if (sc.build === 'courseSetup') startCourseSetupCursor();
      if (sc.build === 'courseUpload') startUploadCursor();
      els.eyebrow.textContent = t(sc.keyBase + '.eyebrow');
      els.headline.textContent = t(sc.keyBase + '.headline');
      els.body.textContent = t(sc.keyBase + '.body');
      els.dialog.style.setProperty('--nl-pv-dwell', (sc.ms || 4000) + 'ms');

      clearChildren(els.cta);
      if (isLast()) {
        els.cta.hidden = false;
        els.cta.appendChild(el('p', 'nl-pv__closing', t('closingLine')));
        var start = el('button', 'nl-btn nl-btn--primary', t('controls.start')); start.type = 'button';
        start.addEventListener('click', function () { try { if (typeof window._googleAuth === 'function') window._googleAuth(); } catch (e) {} });
        els.cta.appendChild(start);
        var replay = el('button', 'nl-pv__replay', t('controls.replay')); replay.type = 'button';
        replay.addEventListener('click', function () { state.playing = !prefersReducedMotion; goto(0, false); });
        els.cta.appendChild(replay);
        els.next.hidden = true;
      } else {
        els.cta.hidden = true;
        els.next.hidden = false;
      }
      els.prev.disabled = state.index === 0;
      renderDots();
      els.live.textContent = t(sc.keyBase + '.headline');
      armTimer();
    }

    function goto(i, fromAuto) {
      var list = scenes();
      if (i < 0) i = 0;
      if (i > list.length - 1) i = list.length - 1;
      if (fromAuto && state.index >= list.length - 1) return;
      state.index = i;
      if (state.index >= list.length - 1 && fromAuto) state.playing = false;
      els.stage.classList.remove('is-leaving');
      paint();
    }

    // -- chooser --
    function renderChooser() {
      clearChildren(els.chooser);
      els.chooser.appendChild(el('h3', 'nl-pv__chooser-title', t('chooser.title')));
      els.chooser.appendChild(el('p', 'nl-pv__chooser-sub', t('chooser.sub')));
      var grid = el('div', 'nl-pv__choices');
      [['course', 'layout-dashboard'], ['german', 'languages']].forEach(function (pair) {
        var key = pair[0];
        var btn = el('button', 'nl-pv__choice'); btn.type = 'button';
        var b = el('span', 'nl-icon-badge'); b.appendChild(buildSvgUse(pair[1], 22)); btn.appendChild(b);
        btn.appendChild(el('span', 'nl-pv__choice-title', t('chooser.' + key)));
        btn.appendChild(el('span', 'nl-pv__choice-sub', t('chooser.' + key + 'Sub')));
        btn.addEventListener('click', function () { chooseTrack(key); });
        grid.appendChild(btn);
      });
      els.chooser.appendChild(grid);
    }
    function showChooser() {
      clearTimer();
      clearShellCursor();
      clearCourseSetupCursor();
      clearUploadCursor();
      els.player.hidden = true;
      els.sw.hidden = true;
      els.chooser.hidden = false;
      renderChooser();
    }
    function chooseTrack(track) {
      state.track = track;
      state.index = 0;
      state.playing = !prefersReducedMotion;
      els.chooser.hidden = true;
      els.player.hidden = false;
      els.sw.hidden = false;
      paint();
    }

    // -- open / close --
    function open() {
      state.lastFocus = document.activeElement;
      modal.hidden = false;
      document.documentElement.classList.add('nl-pv-open');
      document.body.classList.add('nl-pv-open');
      state.track = null;
      showChooser();
      if (els.close && els.close.focus) els.close.focus();
    }
    function close() {
      clearTimer();
      modal.hidden = true;
      document.documentElement.classList.remove('nl-pv-open');
      document.body.classList.remove('nl-pv-open');
      if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) {} }
    }

    // -- events --
    els.close.addEventListener('click', close);
    els.sw.addEventListener('click', showChooser);
    var closers = modal.querySelectorAll('[data-nl-pv-close]');
    for (var ci = 0; ci < closers.length; ci++) closers[ci].addEventListener('click', close);

    els.next.addEventListener('click', function () { if (!isLast()) { state.playing = false; goto(state.index + 1, false); } });
    els.prev.addEventListener('click', function () { state.playing = false; goto(state.index - 1, false); });

    els.dialog.addEventListener('mouseenter', function () { state.hover = true; clearTimer(); });
    els.dialog.addEventListener('mouseleave', function () { state.hover = false; armTimer(); });
    els.dialog.addEventListener('focusin', function () { state.hover = true; clearTimer(); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimer();
      else if (!modal.hidden && !els.player.hidden) armTimer();
    });

    document.addEventListener('keydown', function (e) {
      if (modal.hidden) return;
      if (e.key === 'Escape') { close(); return; }
      if (els.player.hidden) return;
      if (e.key === 'ArrowRight') { state.playing = false; goto(state.index + 1, false); }
      else if (e.key === 'ArrowLeft') { state.playing = false; goto(state.index - 1, false); }
      else if (e.key === 'Tab') { trapFocus(e); }
    });

    function trapFocus(e) {
      var f = modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
      var list = [];
      for (var i = 0; i < f.length; i++) { if (f[i].offsetParent !== null && !f[i].disabled) list.push(f[i]); }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    _pvApi = {
      open: open,
      relang: function () {
        if (modal.hidden) return;
        if (!els.chooser.hidden) renderChooser();
        else paint();
      }
    };
  }

  function initProductTourModal() {
    if (!_pvApi) initPreviewModal();
    return;

    var modal = document.getElementById('nlPreviewModal');
    if (!modal) return;

    var els = {
      dialog:  modal.querySelector('.nl-pv__dialog'),
      chooser: document.getElementById('nlPvChooser'),
      player:  document.getElementById('nlPvPlayer'),
      visual:  document.getElementById('nlPvVisual'),
      eyebrow: document.getElementById('nlPvEyebrow'),
      headline:document.getElementById('nlPvHeadline'),
      body:    document.getElementById('nlPvBody'),
      cta:     document.getElementById('nlPvCta'),
      prev:    document.getElementById('nlPvPrev'),
      next:    document.getElementById('nlPvNext'),
      dots:    document.getElementById('nlPvDots'),
      live:    document.getElementById('nlPvLive'),
      play:    document.getElementById('nlPvSwitch'),
      close:   document.getElementById('nlPvClose')
    };

    var state = { index: 0, playing: false, timer: null, lastFocus: null, hover: false };
    var SCENES = [
      {
        key: 'pages', ms: 8400, icon: 'layout-dashboard', cursor: 'tour-cursor-pages',
        eyebrow: 'Step 1 · Product map',
        title: 'Start from the real Minallo shell.',
        body: 'The preview opens on an empty dashboard so the tour focuses on the actual sidebar and the next useful action.',
        calls: [['Home', 6.5, 10.9, 0], ['Courses', 6.5, 23, 1200], ['Lecture Notes', 6.5, 35, 2400], ['Editor', 6.5, 47.1, 3600], ['Chatbot', 6.5, 59.1, 4800], ['Chat', 6.5, 71.2, 6000]],
        build: buildPagesOverview
      },
      {
        key: 'courses', ms: 7600, icon: 'folder-plus', cursor: 'tour-cursor-courses',
        eyebrow: 'Step 2 · Course setup',
        title: 'Create a course, organize folders, then upload files.',
        body: 'Students see exactly how to add a course, create lecture/exercise/formula folders, and drop PDFs into the right place before asking Minallo for help.',
        calls: [['Add course', 77, 17, 0], ['Create Engineering Mechanics 2', 43, 39, 1200], ['Open the course', 29, 65, 2500], ['Create folders', 58, 55, 3800], ['Upload PDFs', 71, 73, 5200]],
        build: buildCoursesSetup
      },
      {
        key: 'rail', ms: 7600, icon: 'sparkles', cursor: 'tour-cursor-rail',
        eyebrow: 'Step 3 · AI side rail',
        title: 'Open the AI rail without leaving the PDF.',
        body: 'The preview shows the right rail sections: AI, Problem, Notes, and Summary. The answer preview includes the source pages used from the course files.',
        calls: [['Open AI', 93.5, 24, 0], ['Problem Solver', 93.5, 30.7, 1400], ['Notes', 93.5, 37.2, 2800], ['Summary', 93.5, 43.7, 4200], ['Cited answer', 79, 61, 5400]],
        build: buildAiSideRail
      },
      {
        key: 'practice', ms: 6800, icon: 'layers-3', cursor: 'tour-cursor-practice',
        eyebrow: 'Step 4 · Practice tools',
        title: 'Generate quizzes and flashcards from the same material.',
        body: 'The preview makes it clear that a request for 10 questions creates 10 questions, and that flashcards come from the uploaded lecture and formula files.',
        calls: [['Choose Quiz', 17, 31, 0], ['Set 10 questions', 40, 33, 1300], ['Generate', 75, 32, 2600], ['Review Flashcards', 29, 72, 4200]],
        build: buildQuizFlashcards
      },
      {
        key: 'chatbot', ms: 7200, icon: 'message-circle', cursor: 'tour-cursor-chatbot',
        eyebrow: 'Step 5 · Chatbot page',
        title: 'Use the full chatbot when you need a wider study conversation.',
        body: 'The final chapter shows the standalone chatbot page selecting course context, answering a broad study question, and citing course sources when documents are involved.',
        calls: [['Select course context', 22, 19, 0], ['Ask a study question', 63, 75, 1800], ['Answer with sources', 57, 45, 3400], ['Start free trial', 76, 18, 5200]],
        build: buildChatbotPage
      }
    ];

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function clearTimer() {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    function isLast() { return state.index >= SCENES.length - 1; }
    function iconUse(name, size) {
      var s = document.createElement('span');
      s.appendChild(buildSvgUse(name, size || 16));
      return s.innerHTML;
    }
    function callouts(scene) {
      return scene.calls.map(function (c) {
        return '<span class="nl-tour-call" style="left:' + c[1] + '%;top:' + c[2] + '%;animation-delay:' + c[3] + 'ms">' + c[0] + '</span>' +
          '<span class="nl-tour-click" style="left:' + c[1] + '%;top:' + c[2] + '%;animation-delay:' + c[3] + 'ms"></span>';
      }).join('');
    }
    function tourFrame(scene, screenHtml) {
      var frame = el('div', 'nl-tour nl-tour--' + scene.key);
      frame.innerHTML =
        '<div class="nl-tour__screen">' + screenHtml + '</div>' +
        '<span class="nl-tour-cursor ' + scene.cursor + '" aria-hidden="true"></span>' +
        callouts(scene);
      return frame;
    }
    function miniShell(active, mainHtml, extraClass) {
      var pages = [
        ['Home', 'sb-home'], ['Courses', 'sb-courses'], ['Lecture Notes', 'sb-notes'],
        ['Editor', 'sb-editor'], ['Chatbot', 'sb-chatbot'], ['Chat', 'sb-chat'],
        ['__divider__', '']
      ];
      var nav = pages.map(function (p) {
        if (p[0] === '__divider__') return '<i class="nl-mini-divider"></i>';
        var on = p[0] === active ? ' is-active' : '';
        return '<div class="nl-mini-nav__item' + on + '" title="' + p[0] + '"><span class="nl-mini-nav__icon">' + iconUse(p[1], 24) + '</span><b>' + p[0] + '</b></div>';
      }).join('');
      return '<div class="nl-mini-shell ' + (extraClass || '') + '">' +
        '<aside class="nl-mini-nav"><div class="nl-mini-nav-list">' + nav + '</div></aside>' +
        '<section class="nl-mini-main"><div class="nl-mini-top"><strong>' + active + '</strong><span>Study with clarity</span></div><div class="nl-mini-scroll">' + mainHtml + '</div></section>' +
        '</div>';
    }
    function buildPagesOverview(scene) {
      var main = '<div class="nl-mini-empty-dashboard" aria-hidden="true"></div>';
      return tourFrame(scene, miniShell('Chat', main));
    }
    function buildCoursesSetup(scene) {
      var main = '<section class="nl-mini-sd-hero"><div><span>AI-ready course workspace</span><h4>📚 My Courses</h4><p>Organize your semester, upload lecture files, and open AI, notes, or summaries directly from each subject.</p><div class="nl-mini-sd-stats"><b>SS 2026</b><b>1 course</b><b>6 files</b><b>42% avg progress</b></div></div><aside><button class="nl-mini-sem">● SS 2026 ▾</button><button class="nl-mini-add">+ Add Subject</button></aside></section>' +
        '<div class="nl-mini-sd-controls"><div>⌕ Search subjects...</div><button>Manage layout</button></div>' +
        '<div class="nl-mini-course-layout nl-mini-course-layout--real">' +
        '<article class="nl-mini-course-card is-hot"><div class="nl-mini-course-icon">📘</div><b>Engineering Mechanics 2</b><span>Created subject · SS 2026</span><div class="nl-mini-progress"><i style="width:42%"></i></div><div class="nl-mini-statrow"><em>Read 4</em><em>Notes 2</em><em>Practice 10</em><em>AI 8</em></div><strong>Open course</strong></article>' +
        '<div class="nl-mini-modal"><span>Create subject</span><b>Engineering Mechanics 2</b><small>Semester: SS 2026 · Accent: blue</small></div>' +
        '<div class="nl-mini-course-opened"><div class="nl-mini-course-opened-head"><b>Engineering Mechanics 2</b><span>Course workspace opened</span></div><div class="nl-mini-folder-grid">' +
        '<div><b>Lectures</b><span>Mechanics_lecture_03.pdf uploaded</span></div>' +
        '<div><b>Exercises</b><span>Exercise_sheet_06.pdf uploaded</span></div>' +
        '<div><b>Formula Sheets</b><span>Formula_collection.pdf uploaded</span></div>' +
        '</div><div class="nl-mini-upload-drop">Drop PDFs here or choose files</div></div></div>';
      return tourFrame(scene, miniShell('Courses', main, 'nl-mini-shell--courses'));
    }
    function buildAiSideRail(scene) {
      var main = '<div class="nl-mini-pdf">' +
        '<div class="nl-mini-pdf__toolbar"><span>EM2_Seminar_04_Solutions.pdf</span><b>Page 2 / 8</b></div>' +
        '<div class="nl-mini-pdf__page"><h4>Engineering Mechanics 2</h4><p>Archimedes spiral (cat) · circular motion (mouse)</p><div class="nl-mini-formula">v<sub>c</sub>dt = R/π √(1 + φ²)dφ</div></div>' +
        '<aside class="nl-mini-rail"><button class="is-active">AI</button><button>Problem</button><button>Notes</button><button>Summary</button></aside>' +
        '<div class="nl-mini-ai-drawer"><span>Minallo AI · course context</span><p>Solve the mouse and cat problem using the professor’s method.</p><div><b>Given</b><br>r(φ)=Rφ/π, mouse speed a</div><div><b>Sources</b><br>EM2_Seminar_04_Solutions.pdf, p.2<br>Formula sheet, p.1</div></div>' +
        '</div>';
      return tourFrame(scene, miniShell('PDF Workspace', main, 'nl-mini-shell--pdf'));
    }
    function buildQuizFlashcards(scene) {
      var main = '<div class="nl-mini-practice">' +
        '<div class="nl-mini-practice__panel"><span>Quiz generator</span><h4>10 questions from Engineering Mechanics 2</h4><div class="nl-mini-step is-active">1. Concept check</div><div class="nl-mini-step">2. Formula substitution</div><div class="nl-mini-step">3. Calculation problem</div><div class="nl-mini-step">... 10 total questions</div><button>Generate quiz</button><div class="nl-mini-quiz-ready">10-question quiz ready</div></div>' +
        '<div class="nl-mini-flashcards"><span>Flashcards</span><div class="nl-mini-flashcard"><b>Q</b><p>What does the work-energy theorem compare?</p></div><div class="nl-mini-flashcard"><b>A</b><p>Kinetic and potential energy changes using course notation.</p></div><small>Sources: Lecture 03 p.12 · Formula sheet p.2</small></div>' +
        '</div>';
      return tourFrame(scene, miniShell('AI Tutor', main, 'nl-mini-shell--practice'));
    }
    function buildChatbotPage(scene) {
      var main = '<div class="nl-mini-chatbot">' +
        '<aside><b>Course context</b><button class="is-active">Engineering Mechanics 2</button><button>German B1 Practice</button><button>General study help</button></aside>' +
        '<section><div class="nl-mini-chat-top"><b>Minallo Chatbot</b><span>Course-aware conversation</span></div><div class="nl-mini-msg user">Explain how I should prepare for the dynamics exam using my files.</div><div class="nl-mini-msg bot">Start with Seminar 04 for point-mass kinematics, then use Seminar 07 for rigid-body dynamics. I found the key method in your uploaded pages below.<br><small>Sources: EM2_Seminar_04_Solutions.pdf p.1, p.5 · EngMec2_Seminar_07_Sol.pdf p.1</small></div><div class="nl-mini-composer">Ask about your course...</div></section>' +
        '</div>';
      return tourFrame(scene, miniShell('Chatbot', main, 'nl-mini-shell--chatbot'));
    }
    function renderDots() {
      clearChildren(els.dots);
      SCENES.forEach(function (sc, idx) {
        var d = el('button', 'nl-pv__dot');
        d.type = 'button';
        d.setAttribute('aria-label', sc.title);
        d.appendChild(el('span', 'nl-pv__dot-pip'));
        d.appendChild(el('span', 'nl-pv__dot-label', sc.eyebrow.replace('Step ', '')));
        if (idx === state.index) {
          d.classList.add('is-active');
          if (state.playing && !prefersReducedMotion) d.classList.add('is-playing');
        } else if (idx < state.index) {
          d.classList.add('is-done');
        }
        d.addEventListener('click', function () { state.playing = false; goto(idx); });
        els.dots.appendChild(d);
      });
    }
    function updatePlayButton() {
      if (!els.play) return;
      els.play.hidden = false;
      els.play.innerHTML = '<span>' + (state.playing ? 'Pause' : 'Play') + '</span>';
      els.play.setAttribute('aria-label', state.playing ? 'Pause preview' : 'Play preview');
    }
    function armTimer() {
      clearTimer();
      if (!state.playing || prefersReducedMotion || isLast()) return;
      state.timer = setTimeout(function () { goto(state.index + 1, true); }, SCENES[state.index].ms);
    }
    function paint() {
      var sc = SCENES[state.index];
      clearChildren(els.visual);
      els.visual.appendChild(sc.build(sc));
      els.eyebrow.textContent = sc.key === 'pages' ? 'Step 1 - App shell' : sc.eyebrow;
      els.headline.textContent = sc.title;
      els.body.textContent = sc.body;
      els.dialog.style.setProperty('--nl-pv-dwell', sc.ms + 'ms');
      clearChildren(els.cta);
      els.next.hidden = isLast();
      els.prev.disabled = state.index === 0;
      if (isLast()) {
        els.cta.hidden = false;
        els.cta.appendChild(el('p', 'nl-pv__closing', 'Minallo brings courses, PDFs, AI help, practice tools, and study chat into one workspace.'));
        var start = el('button', 'nl-btn nl-btn--primary', 'Start free trial');
        start.type = 'button';
        start.addEventListener('click', function () { try { if (typeof window._googleAuth === 'function') window._googleAuth(); } catch (e) {} });
        els.cta.appendChild(start);
        var replay = el('button', 'nl-pv__replay', 'Replay tour');
        replay.type = 'button';
        replay.addEventListener('click', function () { state.playing = !prefersReducedMotion; goto(0); });
        els.cta.appendChild(replay);
      } else {
        els.cta.hidden = true;
      }
      renderDots();
      updatePlayButton();
      els.live.textContent = sc.title;
      armTimer();
    }
    function goto(i) {
      if (i < 0) i = 0;
      if (i > SCENES.length - 1) i = SCENES.length - 1;
      state.index = i;
      if (isLast()) state.playing = false;
      paint();
    }
    function open() {
      state.lastFocus = document.activeElement;
      modal.hidden = false;
      document.documentElement.classList.add('nl-pv-open');
      document.body.classList.add('nl-pv-open');
      if (els.chooser) els.chooser.hidden = true;
      els.player.hidden = false;
      state.index = 0;
      state.playing = !prefersReducedMotion;
      paint();
      if (els.close && els.close.focus) els.close.focus();
    }
    function close() {
      clearTimer();
      clearShellCursor();
      clearCourseSetupCursor();
      clearUploadCursor();
      modal.hidden = true;
      document.documentElement.classList.remove('nl-pv-open');
      document.body.classList.remove('nl-pv-open');
      if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) {} }
    }
    function trapFocus(e) {
      var f = modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
      var list = [];
      for (var i = 0; i < f.length; i++) { if (f[i].offsetParent !== null && !f[i].disabled) list.push(f[i]); }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    els.close.addEventListener('click', close);
    if (els.play) els.play.addEventListener('click', function () { state.playing = !state.playing; updatePlayButton(); armTimer(); renderDots(); });
    modal.querySelectorAll('[data-nl-pv-close]').forEach(function (x) { x.addEventListener('click', close); });
    els.next.addEventListener('click', function () { state.playing = false; goto(state.index + 1); });
    els.prev.addEventListener('click', function () { state.playing = false; goto(state.index - 1); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimer();
      else if (!modal.hidden) armTimer();
    });
    document.addEventListener('keydown', function (e) {
      if (modal.hidden) return;
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowRight') { state.playing = false; goto(state.index + 1); }
      else if (e.key === 'ArrowLeft') { state.playing = false; goto(state.index - 1); }
      else if (e.key === 'Tab') { trapFocus(e); }
    });

    _pvApi = {
      open: open,
      relang: function () { if (!modal.hidden) paint(); }
    };
  }

  // ---- bootstrap --------------------------------------------------------

  function init() {
    // 1. Apply chosen language FIRST so first paint is correct,
    //    before path picker does its initial render.
    try { applyLang(_getInitialLang()); } catch (e) { /* noop */ }
    try { initLangToggle(); } catch (e) { /* noop */ }
    try { initCtaButtons(); } catch (e) { /* noop */ }
    try { initPreviewModal(); } catch (e) { console.error('initPreviewModal failed:', e); }
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
