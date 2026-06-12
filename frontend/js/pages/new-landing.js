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
        badge: 'Exam prep from your real course files',
        title: 'Upload Your Course. Let Minallo Build Your Exam Prep.',
        subtitle: 'Upload lecture PDFs, scripts, formula sheets, and exercises. Minallo turns your real course material into summaries, quizzes, flashcards, explanations, cheatsheets, and exam-style practice.',
        buildCta: 'Start your 7-day free trial',
        watchCta: 'See how it works',
        trialNote: 'Try Pro free for 7 days. Then \u20ac11.99/month. Cancel anytime.',
        trust: [
          'Built for real university courses',
          'Your files stay in your workspace',
          'Course-based study help, not random answers'
        ],
        stats: {
          understandLabel: 'Understand',
          pdf: 'Ask questions and get explanations from your lecture slides, scripts, notes, and exercises',
          practiceLabel: 'Practice',
          ai: 'Generate active recall, exam-style questions, and revision material from the same files',
          focusLabel: 'Organize',
          focus: 'Keep each course, file, answer, and study tool in one exam-prep workspace'
        }
      },
      tutorPreview: {
        workspace: 'Course workspace',
        courseMaterials: 'Files in this course',
        synced: 'Synced',
        tabs: { lecture: 'Lecture notes', exercise: 'Exercises', formula: 'Exam topics' },
        smartRetrieval: 'Exam prep tools',
        tutorName: '24/7 AI Tutor',
        mode: 'Step-by-step study help',
        userMsg: 'My exam is in 5 days. Turn these PDFs into a study plan.',
        aiMsg: 'Start with the topics your professor repeats, review the formulas from the exercise sheets, then practice actively. I can turn this course into summaries, flashcards, quizzes, and exam-style questions.',
        cite1: 'Cheatsheet: key points for revision',
        cite2: 'ExamForge: exam-style practice ready',
        miniSources: 'Study tools',
        miniVerified: 'Ready',
        miniGuessing: 'Stress'
      },
      workflowPlan: {
        eyebrow: 'How it works',
        title: 'Upload course files. Study with a plan.',
        lead: 'The whole product follows one simple journey: upload the material, let Minallo understand it, then revise with study tools built from that course.',
        compact: ['Upload course files', 'Minallo understands them', 'Generate exam prep', 'Practice and improve'],
        explain: 'Built for real university courses: lecture slides, scripts, exercise sheets, formula collections, diagrams, and professor material can become a clear revision path instead of a pile of files.',
        steps: [
          { title: 'Upload your course files', text: 'Add lecture slides, exercise sheets, scripts, formula sheets, handwritten notes, and professor material to one course workspace.' },
          { title: 'Minallo understands your material', text: 'Your uploaded sources become the context for explanations, summaries, and study tools built around your actual course.' },
          { title: 'Generate exam prep instantly', text: 'Create summaries, quizzes, flashcards, cheatsheets, topic lessons, and exam-style questions from the same files.' },
          { title: 'Practice and improve', text: 'Study with AI explanations, active recall, weak-topic review, and organized course progress before the exam.' }
        ]
      },
      features: {
        eyebrow: 'Three simple benefits',
        title: 'Understand. Practice. Organize.',
        lead: 'Minallo has many tools, but they all serve one goal: helping you turn real course material into focused exam preparation.',
        cards: [
          { kicker: 'Understand', title: 'Get unstuck from your own course material', text: 'Ask the AI tutor about lecture slides, scripts, formulas, diagrams, and exercise sheets. Get explanations tied to the material your exam is actually based on.' },
          { kicker: 'Practice', title: 'Turn reading into active exam prep', text: 'Generate flashcards, quizzes, cheatsheets, and exam-style practice so you stop rereading PDFs and start checking what you really know.' },
          { kicker: 'Organize', title: 'Keep every course in one study workspace', text: 'Create courses, upload files, group folders, save generated notes, and keep your AI tutor, revision tools, and exam practice together.' }
        ]
      },
      trust: {
        eyebrow: 'Built for exam reality',
        title: 'For students staring at a pile of lecture material.',
        lead: 'Minallo helps you turn messy course files into a clearer plan, without spending hours organizing everything manually.',
        privacy: 'Your uploaded materials stay in your workspace and are used to generate your study content.',
        cards: [
          { q: 'Does it work with my lecture PDFs?', a: 'Yes. Upload course files like PDFs, scripts, slides, formula sheets, and exercises, then generate study material from them.' },
          { q: 'Is it just a normal chatbot?', a: 'No. Minallo is built around your course workspace, so the study help starts from the documents you upload.' },
          { q: 'Can it help before exams?', a: 'Yes. Create quizzes, flashcards, cheatsheets, explanations, and exam-style practice from your actual course.' },
          { q: 'Do I need to set everything up manually?', a: 'No. Upload your files, choose what you need, and start studying with generated material inside your course workspace.' }
        ]
      },
      paths: {
        eyebrow: 'Study flow',
        title: 'From course files to exam confidence.',
        lead: 'Upload your material once, then move through the study tools that help you understand, revise, test yourself, and practice before the exam.',
        studentCard: {
          eyebrow: 'Exam preparation',
          title: 'I need to prepare for an exam',
          desc: 'For students with lecture notes, PDFs, exercises, and too much material to review manually.',
          items: [
            'Upload your course files',
            'Generate Cheatsheet, Flashcards, Quiz, and ExamForge',
            'Ask your 24/7 AI Tutor when a topic does not make sense'
          ]
        },
        germanCard: {
          eyebrow: 'Active study',
          title: 'I want to stop rereading PDFs',
          desc: 'For students who want to turn passive reading into active recall, practice, and step-by-step learning.',
          items: [
            'Turn notes into quizzes and flashcards',
            'Use Deep Learn for difficult topics',
            'Practice exam-style questions before the real exam'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Why students use it',
        title: 'Built for the moments before exams.',
        lead: 'Minallo is designed for the questions students actually ask: what should I study, how do I understand it, and how can I check if I am ready?',
        cards: [
          { title: 'Exam coming soon?', text: 'Upload the material and start with a clearer plan instead of staring at a long PDF.' },
          { title: 'Too many lecture slides?', text: 'Create a cheatsheet, build flashcards, and test yourself with Quiz.' },
          { title: 'Stuck on a topic?', text: 'Ask your 24/7 AI tutor or use Deep Learn for a guided explanation.' }
        ]
      },
      tutor: {
        eyebrow: '24/7 AI Tutor',
        title: 'Study help whenever you get stuck.',
        lead: 'Your Minallo tutor helps you understand difficult topics, solve study questions step by step, and turn your uploaded course materials into revision tools.',
        items: [
          'Ask questions about your lectures, PDFs, notes, and exercises',
          'Get step-by-step explanations when a topic feels confusing',
          'Use Deep Learn for guided understanding before you memorize',
          'Turn the same material into Quiz, Flashcards, Cheatsheet, and ExamForge'
        ]
      },
      pipeline: {
        eyebrow: 'How it works',
        title: 'Upload, generate, practice, repeat.',
        steps: [
          { title: 'Upload your course files', text: 'Add lecture notes, PDFs, exercises, slides, and course materials.' },
          { title: 'Generate a Cheatsheet', text: 'Create compact revision notes from the most important material.' },
          { title: 'Learn with Deep Learn', text: 'Break difficult topics into clear, guided explanations.' },
          { title: 'Practice for the exam', text: 'Revise with Flashcards, test yourself with Quiz, and train with ExamForge.' }
        ]
      },
      workflow: {
        eyebrow: 'One course. One study system.',
        title: 'Everything you need to study one course in one place.',
        lead: 'Files, Quiz, Flashcards, ExamForge, Cheatsheet, Deep Learn, and your 24/7 AI Tutor stay together so exam prep feels less scattered.',
        cards: [
          { title: 'Upload Files', text: 'Bring your lecture notes, PDFs, exercises, and course material into Minallo.' },
          { title: 'Get a Cheatsheet', text: 'Condense long material into focused revision notes.' },
          { title: 'Revise and test', text: 'Use Flashcards for active recall and Quiz to check what you know.' },
          { title: 'Practice with ExamForge', text: 'Train with exam-style questions before the real exam.' }
        ]
      },
      quote: {
        title: '"Stop rereading PDFs for hours. Turn them into exam prep."',
        text: 'Minallo helps students study from the exact materials they already have, with tools built for understanding, revision, and practice.'
      },
      pricing: {
        eyebrow: 'Pricing',
        title: 'Unlock the complete Minallo exam-prep system',
        lead: 'Try Pro free for 7 days. Then \u20ac11.99/month.',
        trust: ['7-day free trial', 'Then \u20ac11.99/month', 'Cancel anytime', 'No hidden feature upsells', 'Pro study tools included'],
        pro: {
          popular: '7-day free trial',
          name: 'Student Pro',
          sub: 'Course-based exam prep with Minallo\'s connected study tools.',
          today: '\u20ac0 today',
          per: 'Then \u20ac11.99/month after the trial',
          items: ['AI Tutor', 'Course Workspace', 'Files', 'Cheatsheet', 'Deep Learn', 'Flashcards', 'Quiz', 'ExamForge', 'Summaries', 'Course-based study help'],
          cta: 'Start your 7-day free trial'
        },
        legal: {
          title: 'Small billing details',
          text: 'Your trial starts at \u20ac0 today. If you continue after the trial, the plan renews monthly at \u20ac11.99 and can be cancelled anytime.'
        }
      },
      faq: {
        eyebrow: 'Frequently Asked Questions',
        title: 'Questions Students Ask Before Trying Minallo',
        lead: 'Clear answers about course files, study guidance, uploaded materials, pricing, and exam preparation.',
        questions: [
          'Is Minallo just another AI chatbot?',
          'Does Minallo answer from my uploaded course files?',
          'Does Minallo cite where the answer comes from?',
          'What happens if Minallo does not have enough context?',
          'Can Minallo help me know what to study next?',
          'Can Minallo prepare me for an exam?',
          'Can Minallo identify weak topics?',
          'Can Minallo handle scanned slides, handwritten notes, or diagrams?',
          'What should I upload to Minallo?',
          'Can I upload multiple files for one course?',
          'What is Cheatsheet?',
          'What is ExamForge?',
          'What is Deep Learn?',
          'What are Flashcards for?',
          'What is Quiz for?',
          'Can Minallo replace studying?',
          'Are AI answers always correct?',
          'Can Minallo help if I only have a few days before the exam?',
          'Does the €11.99/month Pro plan include everything?',
          'Can I cancel anytime?',
          'Is there a free trial?',
          'Is my course material private?',
          'Who is Minallo for?'
        ]
      },
      ctaBanner: {
        title: 'Ready to turn your course files into exam prep?',
        text: 'Upload your lecture notes, create a Cheatsheet, revise with Flashcards, test yourself with Quiz, practice with ExamForge, and learn difficult topics with Deep Learn.',
        line: 'Your course. Your study tools. Your exam-prep workspace.',
        cta: 'Start your 7-day free trial',
        secondary: 'Explore study features'
      },
      footer: {
        copyPre: '© ',
        copyPost: ' Minallo. Your 24/7 AI tutor for exam prep.',
        tutor: 'AI Tutor',
        imprint: 'Impressum',
        privacy: 'Privacy',
        terms: 'Terms',
        withdrawal: 'Withdrawal'
      },
      preview: {
        title: 'Minallo · Product preview',
        closingLine: 'Minallo turns your course files into quizzes, flashcards, cheatsheets, exam practice, and step-by-step study help.',
        controls: {
          next: 'Next', back: 'Back', replay: 'Replay',
          start: 'Start studying with Minallo',
          switchTrack: 'Switch track', close: 'Close preview'
        },
        chooser: {
          title: 'What do you want to see?',
          sub: 'Pick a track — the preview plays a short, interactive walkthrough.',
          course: 'Studying a course',
          courseSub: 'Lectures, exercises, quizzes, flashcards, and exam practice.',
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
          examforge: 'ExamForge', examforgeSub: 'Generate exam-style practice',
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
          ask: { chapter: 'Ask', eyebrow: 'Step 4 - Ask AI', headline: 'Ask in your own words.', body: 'Type a normal course question and get step-by-step study help from your 24/7 AI tutor.' },
          sources: { chapter: 'Plan', eyebrow: 'Step 5 - Focus', headline: 'Know what to study next.', body: 'Minallo helps you move from too many files to the topics, exercises, and study tools that matter for revision.' },
          answer: { chapter: 'Learn', eyebrow: 'Step 6 - Explain', headline: 'A structured answer you can use.', body: 'Get step-by-step explanations that help difficult topics feel easier to review.' },
          tools: { chapter: 'Practice', eyebrow: 'Step 7 - Exam prep', headline: 'Turn material into exam practice.', body: 'Generate flashcards and quizzes, create a cheatsheet, and use ExamForge for exam-style practice from the same course files.' },
          focus: { chapter: 'Focus', eyebrow: 'Step 8 · Momentum', headline: 'Then keep your momentum.', body: 'Run a Pomodoro, play a focus playlist, and watch your study streak grow.' }
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
      logo: { tag: 'Klarer fuer die Pruefung lernen' },
      nav: {
        features: 'Funktionen',
        paths: 'Lernfluss',
        tutor: 'Tutor',
        workflow: 'Workspace',
        pricing: 'Preise',
        signIn: 'Anmelden',
        startFree: 'Kostenlos testen'
      },
      hero: {
        badge: 'Pruefungsvorbereitung aus deinen echten Kursdateien',
        title: 'Lade deinen Kurs hoch. Minallo baut deine Pruefungsvorbereitung.',
        subtitle: 'Lade Vorlesungs-PDFs, Skripte, Formelsammlungen und Uebungen hoch. Minallo verwandelt dein echtes Kursmaterial in Zusammenfassungen, Quizze, Karteikarten, Erklaerungen, Cheatsheets und pruefungsnahe Uebung.',
        buildCta: '7 Tage kostenlos testen',
        watchCta: 'So funktioniert es',
        trialNote: 'Teste Pro 7 Tage kostenlos. Danach \u20ac11.99/Monat. Jederzeit kuendbar.',
        trust: [
          'Gebaut fuer echte Unikurse',
          'Deine Dateien bleiben in deinem Workspace',
          'Kursbasierte Lernhilfe statt zufaelliger Antworten'
        ],
        stats: {
          understandLabel: 'Verstehen',
          pdf: 'Stelle Fragen und bekomme Erklaerungen aus Folien, Skripten, Notizen und Uebungen',
          practiceLabel: 'Ueben',
          ai: 'Erstelle Active Recall, pruefungsnahe Fragen und Wiederholungsmaterial aus denselben Dateien',
          focusLabel: 'Organisieren',
          focus: 'Halte jeden Kurs, jede Datei, jede Antwort und jedes Lerntool in einem Pruefungs-Workspace'
        }
      },
      tutorPreview: {
        workspace: 'Kurs-Workspace',
        courseMaterials: 'Dateien in diesem Kurs',
        synced: 'Bereit',
        tabs: { lecture: 'Vorlesungsnotizen', exercise: 'Uebungen', formula: 'Pruefungsthemen' },
        smartRetrieval: 'Lernwerkzeuge',
        tutorName: '24/7 KI-Tutor',
        mode: 'Schritt-fuer-Schritt-Lernhilfe',
        userMsg: 'Meine Pruefung ist in 5 Tagen. Mach aus diesen PDFs einen Lernplan.',
        aiMsg: 'Starte mit den Themen, die dein Professor wiederholt, wiederhole die Formeln aus den Uebungsblaettern und uebe danach aktiv. Ich kann daraus Zusammenfassungen, Karteikarten, Quizze und pruefungsnahe Fragen machen.',
        cite1: 'Cheatsheet: wichtigste Punkte fuer die Wiederholung',
        cite2: 'ExamForge: pruefungsnahe Uebung bereit',
        miniSources: 'Lernwerkzeuge',
        miniVerified: 'Bereit',
        miniGuessing: 'Stress'
      },
      workflowPlan: {
        eyebrow: 'So funktioniert es',
        title: 'Kursdateien hochladen. Mit Plan lernen.',
        lead: 'Das ganze Produkt folgt einem einfachen Weg: Material hochladen, Minallo versteht es, danach wiederholst du mit Lerntools aus genau diesem Kurs.',
        compact: ['Kursdateien hochladen', 'Minallo versteht sie', 'Pruefungsvorbereitung erstellen', 'Ueben und verbessern'],
        explain: 'Gebaut fuer echte Unikurse: Vorlesungsfolien, Skripte, Uebungsblaetter, Formelsammlungen, Diagramme und Professorenmaterial werden zu einem klaren Wiederholungsweg statt zu einem Stapel Dateien.',
        steps: [
          { title: 'Kursdateien hochladen', text: 'Fuege Folien, Uebungsblaetter, Skripte, Formelsammlungen, handschriftliche Notizen und Professorenmaterial in einen Kurs-Workspace ein.' },
          { title: 'Minallo versteht dein Material', text: 'Deine hochgeladenen Quellen werden zum Kontext fuer Erklaerungen, Zusammenfassungen und Lerntools rund um deinen echten Kurs.' },
          { title: 'Pruefungsvorbereitung sofort erstellen', text: 'Erstelle Zusammenfassungen, Quizze, Karteikarten, Cheatsheets, Themenlektionen und pruefungsnahe Fragen aus denselben Dateien.' },
          { title: 'Ueben und verbessern', text: 'Lerne mit KI-Erklaerungen, Active Recall, Schwachstellen-Wiederholung und organisiertem Kursfortschritt vor der Pruefung.' }
        ]
      },
      features: {
        eyebrow: 'Drei einfache Vorteile',
        title: 'Verstehen. Ueben. Organisieren.',
        lead: 'Minallo hat viele Werkzeuge, aber sie dienen einem Ziel: echtes Kursmaterial in fokussierte Pruefungsvorbereitung zu verwandeln.',
        cards: [
          { kicker: 'Verstehen', title: 'Komm mit deinem eigenen Kursmaterial weiter', text: 'Frag den KI-Tutor zu Folien, Skripten, Formeln, Diagrammen und Uebungsblaettern. Bekomme Erklaerungen zu dem Material, auf dem deine Pruefung wirklich basiert.' },
          { kicker: 'Ueben', title: 'Mach aus Lesen aktive Pruefungsvorbereitung', text: 'Erstelle Karteikarten, Quizze, Cheatsheets und pruefungsnahe Uebungen, damit du PDFs nicht nur wieder liest, sondern pruefst, was du wirklich kannst.' },
          { kicker: 'Organisieren', title: 'Halte jeden Kurs in einem Lern-Workspace', text: 'Erstelle Kurse, lade Dateien hoch, gruppiere Ordner, speichere generierte Notizen und halte KI-Tutor, Wiederholungstools und Pruefungsuebung zusammen.' }
        ]
      },
      trust: {
        eyebrow: 'Gebaut fuer echte Pruefungsphasen',
        title: 'Fuer Studierende, die vor einem Stapel Vorlesungsmaterial sitzen.',
        lead: 'Minallo hilft dir, chaotische Kursdateien in einen klareren Plan zu verwandeln, ohne stundenlang alles manuell zu sortieren.',
        privacy: 'Deine hochgeladenen Materialien bleiben in deinem Workspace und werden genutzt, um deine Lerninhalte zu erstellen.',
        cards: [
          { q: 'Funktioniert es mit meinen Vorlesungs-PDFs?', a: 'Ja. Lade Kursdateien wie PDFs, Skripte, Folien, Formelsammlungen und Uebungen hoch und erstelle daraus Lernmaterial.' },
          { q: 'Ist es nur ein normaler Chatbot?', a: 'Nein. Minallo ist um deinen Kurs-Workspace gebaut, sodass die Lernhilfe bei den Dokumenten startet, die du hochlaedst.' },
          { q: 'Hilft es kurz vor Pruefungen?', a: 'Ja. Erstelle Quizze, Karteikarten, Cheatsheets, Erklaerungen und pruefungsnahe Uebungen aus deinem echten Kurs.' },
          { q: 'Muss ich alles manuell einrichten?', a: 'Nein. Lade deine Dateien hoch, waehle was du brauchst und lerne mit generiertem Material in deinem Kurs-Workspace.' }
        ]
      },
      paths: {
        eyebrow: 'Lernfluss',
        title: 'Von Kursdateien zu Pruefungssicherheit.',
        lead: 'Lade dein Material einmal hoch und nutze danach die Werkzeuge, die dir beim Verstehen, Wiederholen, Testen und Ueben helfen.',
        studentCard: {
          eyebrow: 'Pruefungsvorbereitung',
          title: 'Ich muss fuer eine Pruefung lernen',
          desc: 'Fuer Studierende mit Vorlesungsnotizen, PDFs, Uebungen und zu viel Material zum manuellen Wiederholen.',
          items: [
            'Kursdateien hochladen',
            'Cheatsheet, Karteikarten, Quiz und ExamForge erstellen',
            'Den 24/7 KI-Tutor fragen, wenn ein Thema nicht sitzt'
          ]
        },
        germanCard: {
          eyebrow: 'Aktiv lernen',
          title: 'Ich will PDFs nicht nur wieder lesen',
          desc: 'Fuer Studierende, die aus passivem Lesen aktives Erinnern, Ueben und Verstehen machen wollen.',
          items: [
            'Notizen in Quizze und Karteikarten verwandeln',
            'Deep Learn fuer schwierige Themen nutzen',
            'Pruefungsnahe Fragen vor der echten Pruefung ueben'
          ]
        }
      },
      lifestyle: {
        eyebrow: 'Warum Studierende es nutzen',
        title: 'Gebaut fuer die Momente vor der Pruefung.',
        lead: 'Minallo beantwortet die Fragen, die in der Pruefungsphase zaehlen: Was soll ich lernen, wie verstehe ich es und bin ich wirklich bereit?',
        cards: [
          { title: 'Pruefung bald?', text: 'Lade dein Material hoch und starte mit einem klareren Plan statt mit einem langen PDF.' },
          { title: 'Zu viele Folien?', text: 'Erstelle ein Cheatsheet, baue Karteikarten und teste dich mit Quiz.' },
          { title: 'Thema unklar?', text: 'Frag deinen 24/7 KI-Tutor oder nutze Deep Learn fuer eine gefuehrte Erklaerung.' }
        ]
      },
      tutor: {
        eyebrow: '24/7 KI-Tutor',
        title: 'Lernhilfe, sobald du festhaengst.',
        lead: 'Dein Minallo Tutor hilft dir, schwierige Themen zu verstehen, Lernfragen Schritt fuer Schritt zu loesen und aus hochgeladenem Kursmaterial Wiederholungswerkzeuge zu machen.',
        items: [
          'Fragen zu Vorlesungen, PDFs, Notizen und Uebungen stellen',
          'Schritt-fuer-Schritt-Erklaerungen bekommen, wenn ein Thema verwirrend ist',
          'Deep Learn nutzen, bevor du nur auswendig lernst',
          'Dasselbe Material in Quiz, Karteikarten, Cheatsheet und ExamForge verwandeln'
        ]
      },
      pipeline: {
        eyebrow: 'So funktioniert es',
        title: 'Hochladen, erstellen, ueben, wiederholen.',
        steps: [
          { title: 'Kursdateien hochladen', text: 'Fuege Vorlesungsnotizen, PDFs, Uebungen, Folien und Kursmaterialien hinzu.' },
          { title: 'Cheatsheet erstellen', text: 'Erstelle kompakte Wiederholungsnotizen aus den wichtigsten Inhalten.' },
          { title: 'Mit Deep Learn verstehen', text: 'Zerlege schwierige Themen in klare, gefuehrte Erklaerungen.' },
          { title: 'Fuer die Pruefung ueben', text: 'Wiederhole mit Flashcards, teste dich mit Quiz und trainiere mit ExamForge.' }
        ]
      },
      workflow: {
        eyebrow: 'Ein Kurs. Ein Lernsystem.',
        title: 'Alles, was du fuer einen Kurs brauchst, an einem Ort.',
        lead: 'Files, Quiz, Flashcards, ExamForge, Cheatsheet, Deep Learn und dein 24/7 KI-Tutor bleiben zusammen, damit Pruefungsvorbereitung weniger chaotisch wird.',
        cards: [
          { title: 'Files hochladen', text: 'Bringe Vorlesungsnotizen, PDFs, Uebungen und Kursmaterial in Minallo.' },
          { title: 'Cheatsheet bekommen', text: 'Verdichte langes Material zu fokussierten Wiederholungsnotizen.' },
          { title: 'Wiederholen und testen', text: 'Nutze Flashcards fuer Active Recall und Quiz, um dein Wissen zu pruefen.' },
          { title: 'Mit ExamForge ueben', text: 'Trainiere mit pruefungsnahen Fragen vor der echten Pruefung.' }
        ]
      },
      quote: {
        title: '"Hoer auf, PDFs stundenlang neu zu lesen. Mach daraus Pruefungsvorbereitung."',
        text: 'Minallo hilft Studierenden, mit den Materialien zu lernen, die sie schon haben: zum Verstehen, Wiederholen und Ueben.'
      },
      pricing: {
        eyebrow: 'Preise',
        title: 'Schalte das komplette Minallo-Pruefungssystem frei',
        lead: 'Teste Pro 7 Tage kostenlos. Danach 11,99 \u20ac/Monat.',
        trust: ['7 Tage kostenlos testen', 'Danach 11,99 \u20ac/Monat', 'Jederzeit kuendbar', 'Keine versteckten Feature-Upsells', 'Pro-Lerntools inklusive'],
        pro: {
          popular: '7 Tage kostenlos testen',
          name: 'Student Pro',
          sub: 'Kursbasierte Pruefungsvorbereitung mit Minallos verbundenen Lerntools.',
          today: '0 \u20ac heute',
          per: 'Danach 11,99 \u20ac/Monat nach der Testphase',
          items: ['AI Tutor', 'Course Workspace', 'Files', 'Cheatsheet', 'Deep Learn', 'Flashcards', 'Quiz', 'ExamForge', 'Summaries', 'Kursbasierte Lernhilfe'],
          cta: '7 Tage kostenlos testen'
        },
        legal: {
          title: 'Kurze Zahlungsdetails',
          text: 'Deine Testphase startet heute mit 0 \u20ac. Wenn du nach der Testphase weitermachst, verlaengert sich Pro monatlich fuer 11,99 \u20ac und kann jederzeit gekuendigt werden.'
        }
      },
      faq: {
        eyebrow: 'H\u00e4ufige Fragen',
        title: 'Fragen, die Studierende vor Minallo stellen',
        lead: 'Klare Antworten zu Kursdateien, Lernhilfe, hochgeladenen Materialien, Preisen und Pruefungsvorbereitung.',
        questions: [
          'Ist Minallo nur ein weiterer KI-Chatbot?',
          'Antwortet Minallo aus meinen hochgeladenen Kursdateien?',
          'Zeigt Minallo, woher eine Antwort kommt?',
          'Was passiert, wenn Minallo nicht genug Kontext hat?',
          'Kann Minallo mir helfen zu wissen, was ich als N\u00e4chstes lernen soll?',
          'Kann Minallo mich auf eine Pr\u00fcfung vorbereiten?',
          'Kann Minallo schwache Themen erkennen?',
          'Kann Minallo gescannte Folien, handschriftliche Notizen oder Diagramme verarbeiten?',
          'Was sollte ich in Minallo hochladen?',
          'Kann ich mehrere Dateien f\u00fcr einen Kurs hochladen?',
          'Was ist Cheatsheet?',
          'Was ist ExamForge?',
          'Was ist Deep Learn?',
          'Wof\u00fcr sind Flashcards gedacht?',
          'Wof\u00fcr ist Quiz gedacht?',
          'Kann Minallo das Lernen ersetzen?',
          'Sind KI-Antworten immer richtig?',
          'Kann Minallo helfen, wenn ich nur noch wenige Tage bis zur Pr\u00fcfung habe?',
          'Ist im Pro-Abo f\u00fcr 11,99 \u20ac/Monat alles enthalten?',
          'Kann ich jederzeit k\u00fcndigen?',
          'Gibt es eine kostenlose Testphase?',
          'Ist mein Kursmaterial privat?',
          'F\u00fcr wen ist Minallo gedacht?'
        ]
      },
      ctaBanner: {
        title: 'Bereit, deine Kursdateien in Pruefungsvorbereitung zu verwandeln?',
        text: 'Lade Vorlesungsnotizen hoch, erstelle ein Cheatsheet, wiederhole mit Flashcards, teste dich mit Quiz, uebe mit ExamForge und lerne schwierige Themen mit Deep Learn.',
        line: 'Dein Kurs. Deine Lerntools. Dein Pruefungs-Workspace.',
        cta: '7 Tage kostenlos testen',
        secondary: 'Lernfeatures ansehen'
      },
      footer: {
        copyPre: '? ',
        copyPost: ' Minallo. Dein 24/7 KI-Tutor fuer Pruefungsvorbereitung.',
        tutor: 'KI-Tutor',
        imprint: 'Impressum',
        privacy: 'Datenschutz',
        terms: 'AGB',
        withdrawal: 'Widerruf'
      },
      preview: {
        title: 'Minallo · Produktvorschau',
        closingLine: 'Minallo verwandelt deine Kursdateien in Quizze, Karteikarten, Cheatsheets, Pruefungspraxis und Schritt-fuer-Schritt-Lernhilfe.',
        controls: {
          next: 'Weiter', back: 'Zurück', replay: 'Erneut abspielen',
          start: 'Mit Minallo lernen',
          switchTrack: 'Bereich wechseln', close: 'Vorschau schließen'
        },
        chooser: {
          title: 'Was möchtest du sehen?',
          sub: 'Wähle einen Bereich — die Vorschau spielt eine kurze, interaktive Tour.',
          course: 'Kurs lernen',
          courseSub: 'Vorlesungen, Uebungen, Quizze, Karteikarten und Pruefungspraxis.',
          german: 'Deutsch lernen',
          germanSub: 'Vokabeln, Grammatik, Alltagssätze und Übungsspiele.'
        },
        labels: {
          synced: 'Bereit', sources: 'Lernwerkzeuge', verified: 'Geprueft',
          given: 'Gegeben', required: 'Gesucht', formula: 'Formel',
          steps: 'Schritte', finalAnswer: 'Endergebnis',
          annotate: 'Markieren', annotateSub: 'PDFs markieren & signieren',
          flashcards: 'Karteikarten', flashcardsSub: 'Automatisch aus deinen Dateien',
          quiz: 'Quiz', quizSub: 'Üben mit Bewertung',
          examforge: 'ExamForge', examforgeSub: 'Pruefungsnahe Uebung erstellen',
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
          ask: { chapter: 'Fragen', eyebrow: 'Schritt 4 - KI fragen', headline: 'Frag in deinen eigenen Worten.', body: 'Stelle eine normale Kursfrage und bekomme Schritt-fuer-Schritt-Hilfe von deinem 24/7 KI-Tutor.' },
          sources: { chapter: 'Plan', eyebrow: 'Schritt 5 - Fokus', headline: 'Wisse, was du als Naechstes lernen solltest.', body: 'Minallo hilft dir, aus zu vielen Dateien die Themen, Uebungen und Lernwerkzeuge fuer die Wiederholung zu machen.' },
          answer: { chapter: 'Lernen', eyebrow: 'Schritt 6 - Erklaeren', headline: 'Eine strukturierte Antwort, die du nutzen kannst.', body: 'Bekomme Schritt-fuer-Schritt-Erklaerungen, damit schwierige Themen leichter zu wiederholen sind.' },
          tools: { chapter: 'Ueben', eyebrow: 'Schritt 7 - Pruefungsvorbereitung', headline: 'Mach aus Material echte Pruefungsvorbereitung.', body: 'Erstelle Karteikarten und Quizze, generiere ein Cheatsheet und nutze ExamForge fuer pruefungsnahe Uebung.' },
          focus: { chapter: 'Fokus', eyebrow: 'Schritt 8 · Schwung', headline: 'Und halte deinen Schwung.', body: 'Starte eine Pomodoro-Sitzung, spiele eine Fokus-Playlist und sieh deine Lernserie wachsen.' }
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
        title: 'Exam prep workspace',
        subtitle: 'Upload files, generate study tools, prepare faster',
        description: 'Upload lecture notes, PDFs, exercises, and course materials, then turn them into Quiz, Flashcards, ExamForge, Cheatsheet, Deep Learn, and 24/7 AI tutor help.',
        icon: 'layout-dashboard',
        items: [
          'Files, Quiz, Flashcards, ExamForge, Cheatsheet, and Deep Learn',
          'Step-by-step explanations from your 24/7 AI Tutor',
          'Active recall instead of passive rereading',
          'A clearer plan when exam week feels messy'
        ],
        preview: [
          ['file-text', 'Upload files', 'Add lecture notes, PDFs, slides, exercises, and course materials.'],
          ['brain-circuit', 'AI tutor', 'Ask questions anytime and get step-by-step study help.'],
          ['trophy', 'Exam prep', 'Generate quizzes, flashcards, cheatsheets, lessons, and ExamForge practice.']
        ]
      },
      german: {
        title: 'Active study mode',
        subtitle: 'Stop rereading and start practicing',
        description: 'Use Minallo to move from long course files to active study: learn difficult topics, revise important concepts, and check your readiness before the exam.',
        icon: 'languages',
        items: [
          'Deep Learn for difficult topics',
          'Flashcards for definitions, formulas, and concepts',
          'Quiz for quick knowledge checks',
          'ExamForge for exam-style practice'
        ],
        preview: [
          ['languages', 'Understand', 'Break confusing topics into simpler steps.'],
          ['book-open', 'Revise', 'Turn long material into cheatsheets and flashcards.'],
          ['gamepad-2', 'Practice', 'Use Quiz and ExamForge before the real exam.']
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
          ['brain-circuit', 'KI-Tutor', 'Stelle Fragen und bekomme Schritt-fuer-Schritt-Lernhilfe.'],
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
        var tgt = document.getElementById('study-flow');
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

    var state = {
      track: null,
      index: 0,
      playing: false,
      timer: null,
      shellTimer: null,
      courseTimer: null,
      uploadTimer: null,
      askTimers: [],
      lastFocus: null,
      hover: false
    };

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

    function clearAskSceneLoop() {
      if (!state.askTimers || !state.askTimers.length) return;
      state.askTimers.forEach(function (timer) { clearTimeout(timer); });
      state.askTimers = [];
    }
    function queueAsk(fn, delay) {
      var timer = setTimeout(fn, delay);
      state.askTimers.push(timer);
      return timer;
    }
    function setAskVisible(node, visible) {
      if (!node) return;
      node.style.opacity = visible ? '1' : '0';
      node.style.transform = visible ? 'translateY(0)' : 'translateY(8px)';
      var max = '4rem';
      if (node.classList.contains('nl-pv-ask-answer')) max = '12rem';
      else if (node.classList.contains('nl-pv-ask-status')) max = '3.4rem';
      node.style.maxHeight = visible ? max : '0';
      node.style.pointerEvents = visible ? 'auto' : 'none';
    }
    function typeInto(node, text, stepMs, done) {
      if (!node) {
        if (done) done();
        return;
      }
      node.textContent = '';
      var chars = text.split('');
      chars.forEach(function (_ch, idx) {
        queueAsk(function () {
          node.textContent = text.slice(0, idx + 1);
          if (idx === chars.length - 1 && done) done();
        }, idx * stepMs);
      });
    }
    function startAskSceneLoop() {
      clearAskSceneLoop();
      var frame = els.visual.querySelector('.nl-pv-ask-scene');
      if (!frame) return;

      var typed = frame.querySelector('.nl-pv-ask-typed');
      var send = frame.querySelector('.nl-pv-ask-send');
      var user = frame.querySelector('.nl-pv-ask-user');
      var thinking = frame.querySelector('.nl-pv-ask-thinking');
      var status = frame.querySelector('.nl-pv-ask-status');
      var answer = frame.querySelector('.nl-pv-ask-answer');
      var answerText = frame.querySelector('.nl-pv-ask-answer-text');
      var formula = frame.querySelector('.nl-pv-formula');
      var chips = frame.querySelectorAll('.nl-pv-ask-answer .nl-pv-chip');
      var question = 'Solve exercise 6 using my lecture method and cite the formula.';
      var answerFull = answerText ? answerText.getAttribute('data-full-text') || '' : '';

      function reset() {
        if (typed) typed.textContent = '';
        if (send) send.classList.remove('is-live');
        setAskVisible(user, false);
        setAskVisible(thinking, false);
        setAskVisible(status, false);
        setAskVisible(answer, false);
        if (answerText) answerText.textContent = '';
        if (formula) formula.style.opacity = '0';
        chips.forEach(function (chipNode) {
          chipNode.style.opacity = '0';
          chipNode.style.transform = 'translateY(6px)';
        });
      }

      function loop() {
        clearAskSceneLoop();
        reset();
        queueAsk(function () {
          typeInto(typed, question, 24, function () {
            if (send) send.classList.add('is-live');
          });
        }, 180);
        queueAsk(function () { setAskVisible(user, true); }, 1780);
        queueAsk(function () { setAskVisible(thinking, true); }, 2360);
        queueAsk(function () { setAskVisible(status, true); }, 3180);
        queueAsk(function () {
          setAskVisible(thinking, false);
          setAskVisible(status, false);
          setAskVisible(answer, true);
          typeInto(answerText, answerFull, 13, function () {
            if (formula) formula.style.opacity = '1';
            chips.forEach(function (chipNode, idx) {
              queueAsk(function () {
                chipNode.style.opacity = '1';
                chipNode.style.transform = 'translateY(0)';
              }, 260 + idx * 180);
            });
          });
        }, 4300);
        queueAsk(loop, 7600);
      }

      if (prefersReducedMotion) {
        reset();
        if (typed) typed.textContent = question;
        setAskVisible(user, true);
        setAskVisible(answer, true);
        if (answerText) answerText.textContent = answerFull;
        if (formula) formula.style.opacity = '1';
        chips.forEach(function (chipNode) {
          chipNode.style.opacity = '1';
          chipNode.style.transform = 'translateY(0)';
        });
        return;
      }
      loop();
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

        var status = el('div', 'nl-pv-ask-status');
        status.appendChild(el('span', null, 'Searching course files...'));
        var statusBar = el('i');
        status.appendChild(statusBar);
        chat.appendChild(status);

        var answer = el('div', 'nl-pv-bubble nl-pv-bubble--ai nl-pv-ask-answer');
        var answerText = el('p', 'nl-pv-ask-answer-text');
        answerText.setAttribute('data-full-text', 'I found the matching exercise and formula sheet. Use the equilibrium equations, substitute the given force and distances, then check the signs with force balance.');
        answer.appendChild(answerText);
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
      tools: function () {
        var m = mock();
        var t2 = el('div', 'nl-pv-tiles');
        t2.appendChild(tile('pen-tool', L('annotate'), L('annotateSub')));
        t2.appendChild(tile('layers-3', L('flashcards'), L('flashcardsSub')));
        t2.appendChild(tile('check-circle-2', L('quiz'), L('quizSub')));
        t2.appendChild(tile('graduation-cap', L('examforge'), L('examforgeSub')));
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
        var m = mock('nl-pv-german-scene nl-pv-german-intro');
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('languages', 'A2 German'));
        chips.appendChild(chip('book-open', 'Today: articles + cafe phrases'));
        m.appendChild(chips);
        var plan = el('div', 'nl-pv-german-plan');
        plan.appendChild(row('layers-3', '12 words', '8 min'));
        plan.appendChild(row('graduation-cap', 'Dative case', '5 min'));
        plan.appendChild(row('quote', 'Order politely', '4 min'));
        m.appendChild(plan);
        return m;
      },
      gVocab: function () {
        var m = mock('nl-pv-german-scene');
        var card = el('div', 'nl-pv-flip nl-pv-german-card');
        var inner = el('div', 'nl-pv-german-card__inner');
        var front = el('div', 'nl-pv-german-card__face');
        front.appendChild(el('span', 'nl-pv-german-article', 'die'));
        front.appendChild(el('strong', null, 'Rechnung'));
        front.appendChild(el('small', null, 'tap / wait to reveal'));
        var back = el('div', 'nl-pv-german-card__face nl-pv-german-card__face--back');
        back.appendChild(el('strong', null, 'the bill'));
        back.appendChild(el('span', null, 'Kann ich bitte die Rechnung haben?'));
        inner.appendChild(front);
        inner.appendChild(back);
        card.appendChild(inner);
        m.appendChild(card);
        var saved = el('div', 'nl-pv-chips nl-pv-german-card__chips');
        saved.appendChild(chip('languages', 'listen'));
        saved.appendChild(chip('check-circle-2', 'saved'));
        m.appendChild(saved);
        return m;
      },
      gGrammar: function () {
        var m = mock('nl-pv-german-scene nl-pv-german-chat');
        m.appendChild(badge('graduation-cap', 'Dative after "mit"'));
        m.appendChild(el('div', 'nl-pv-bubble nl-pv-bubble--user nl-pv-german-question', 'Why is it "mit dem Mann" and not "mit der Mann"?'));
        var answer = el('div', 'nl-pv-bubble nl-pv-bubble--ai nl-pv-german-answer');
        answer.appendChild(el('p', null, '"mit" always takes dative. Masculine "der Mann" changes to "dem Mann".'));
        var rule = el('div', 'nl-pv-german-rule');
        rule.appendChild(el('span', null, 'der Mann'));
        rule.appendChild(el('strong', null, 'mit dem Mann'));
        answer.appendChild(rule);
        m.appendChild(answer);
        return m;
      },
      gSentences: function () {
        var m = mock('nl-pv-german-scene nl-pv-german-sentences');
        m.appendChild(row('quote', 'I would like a coffee.', 'translate'));
        var typed = el('div', 'nl-pv-german-input');
        typed.appendChild(el('span', null, 'Ich hätte gern einen Kaffee.'));
        m.appendChild(typed);
        m.appendChild(row('check-circle-2', 'Natural and polite', 'B1'));
        var chips = el('div', 'nl-pv-chips');
        chips.appendChild(chip('quote', 'Könnten Sie...?'));
        chips.appendChild(chip('quote', 'Ich suche...'));
        m.appendChild(chips);
        return m;
      },
      gGames: function () {
        var m = mock('nl-pv-german-scene nl-pv-german-game');
        m.appendChild(el('div', 'nl-pv-german-game__q', 'Choose the article: Apfel'));
        var chips = el('div', 'nl-pv-chips');
        ['der', 'die', 'das'].forEach(function (opt) {
          var c = chip('gamepad-2', opt);
          if (opt === 'der') c.classList.add('is-correct');
          chips.appendChild(c);
        });
        m.appendChild(chips);
        m.appendChild(el('div', 'nl-pv-german-feedback', 'Correct: der Apfel'));
        return m;
      },
      gStreak: function () {
        var m = mock('nl-pv-german-scene nl-pv-german-progress');
        var sr = el('div', 'nl-pv-streak');
        sr.appendChild(buildSvgUse('trophy', 16));
        sr.appendChild(el('span', null, L('dayStreak')));
        m.appendChild(sr);
        m.appendChild(row('languages', 'Vocabulary', '84%'));
        m.appendChild(bar(84));
        m.appendChild(row('graduation-cap', 'Grammar', '68%'));
        m.appendChild(bar(68));
        return m;
      },
      gCta: function () {
        var m = mock('nl-pv-german-scene nl-pv-german-cta');
        var ic = el('div', 'nl-pv-tile__icon'); ic.appendChild(buildSvgUse('sparkles', 26)); m.appendChild(ic);
        m.appendChild(el('div', 'nl-pv-german-cta__word', 'Deutsch'));
        m.appendChild(el('div', 'nl-pv-german-cta__line', '10 minutes today: words, grammar, speaking'));
        var ctaChips = el('div', 'nl-pv-chips');
        ctaChips.appendChild(chip('check-circle-2', 'ready'));
        ctaChips.appendChild(chip('trophy', 'next streak'));
        m.appendChild(ctaChips);
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
      clearAskSceneLoop();
      clearChildren(els.visual);
      if (builders[sc.build]) els.visual.appendChild(builders[sc.build]());
      if (sc.build === 'shell') startShellCursor();
      if (sc.build === 'courseSetup') startCourseSetupCursor();
      if (sc.build === 'courseUpload') startUploadCursor();
      if (sc.build === 'ask') startAskSceneLoop();
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
      clearAskSceneLoop();
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
        eyebrow: 'Step 3 - 24/7 AI Tutor',
        title: 'Ask for help while you study.',
        body: 'The preview shows how Minallo can explain a topic, help with a problem, create notes, or summarize material while you keep preparing for the exam.',
        calls: [['Ask AI', 93.5, 24, 0], ['Problem help', 93.5, 30.7, 1400], ['Notes', 93.5, 37.2, 2800], ['Summary', 93.5, 43.7, 4200], ['Study answer', 79, 61, 5400]],
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
        eyebrow: 'Step 5 - AI tutor',
        title: 'Use your 24/7 AI tutor for bigger study questions.',
        body: 'The final chapter shows a longer study conversation where Minallo helps you plan, understand, revise, and prepare for the next exam.',
        calls: [['Choose a course', 22, 19, 0], ['Ask a study question', 63, 75, 1800], ['Get study help', 57, 45, 3400], ['Start free trial', 76, 18, 5200]],
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
      clearAskSceneLoop();
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
