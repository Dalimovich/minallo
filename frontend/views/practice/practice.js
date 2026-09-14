// ── GERMAN LEARNER PRACTICE ──────────────────────────────────────────────────
(function () {
  var container = document.getElementById('psec-german');
  // Modern entry points can initialize without the legacy portal page.
  if (!container && document.getElementById('ncbRoot')) {
    container = document.createElement('div');
    container.hidden = true;
    document.getElementById('ncbRoot').appendChild(container);
  }
  if (!container) return;

  // Retry the markup fetch a couple of times: this dispatcher only runs once
  // (the loader won't re-inject the script on re-navigation), so a single
  // transient network failure here would leave the page blank until a full
  // reload. Retrying self-heals the common flaky-connection case.
  function _ssFetchText(url, tries) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).catch(function (err) {
      if (tries > 0) {
        return new Promise(function (res) { setTimeout(res, 400); }).then(function () {
          return _ssFetchText(url, tries - 1);
        });
      }
      throw err;
    });
  }
  window._glReady = _ssFetchText('views/practice/practice.html', 2)
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var sec = tmp.querySelector('#psec-german');
      if (sec) {
        // Preserve the live display. practice.html's #psec-german ships with
        // style="display:none", and this fetch resolves AFTER the first click
        // already revealed the section — clobbering cssText would re-hide it,
        // forcing a pointless second click.
        var prevDisplay = container.style.display || 'none';
        container.style.cssText = sec.getAttribute('style') || '';
        container.style.display = prevDisplay;
        while (sec.firstChild) container.appendChild(sec.firstChild);
      }
      _init();
      if (typeof window.applyLanguage === 'function') {
        window.applyLanguage(window._lang || localStorage.getItem('ss_lang') || 'en');
      }
    })
    .catch(function (err) {
      console.error('practice.html load error:', err);
    });

  function _init() {
    var _glSkillNames = {
      reading: 'Leseverstehen',
      listening: 'Hörverstehen',
      writing: 'Schreiben',
      speaking: 'Sprechen',
      vocab: 'Wortschatz',
      grammar: 'Grammatik',
      sentences: 'Satztraining',
      games: 'Artikelspiele'
    };
    var _glSkillSubs = {
      reading: 'Short texts, comprehension questions, and useful phrases',
      listening: 'Transcript-based listening practice',
      writing: 'Writing tasks with structure help',
      speaking: 'Speaking prompts and answer structure',
      vocab: 'Flip cards with article, translation, and example sentence',
      grammar: 'Short rules, examples, and correction practice',
      sentences: 'Everyday sentence practice',
      games: 'der, die, das drills'
    };
    var _glSkillChips = {
      reading: [
        'Practice text + questions',
        'Summarise a text for me',
        'Explain reading strategies'
      ],
      listening: [
        'Give me a listening transcript + questions',
        'Explain listening strategies',
        'Common listening pitfalls'
      ],
      writing: ['Give me a writing prompt', 'Evaluate my writing', 'Explain writing structure'],
      speaking: [
        'Give me speaking prompts',
        'How to structure my answer',
        'Common speaking mistakes'
      ],
      vocab: ['Quiz me on 15 words', 'Words for my exam level', 'Explain these German words'],
      grammar: [
        'Top grammar topics for my exam',
        'Give me grammar exercises',
        'Explain Konjunktiv II'
      ],
      sentences: [
        'Give me useful everyday German sentences',
        'Correct my sentence politely',
        'Show formal and informal versions'
      ],
      games: [
        'Quiz me on der die das',
        'Give me an article game',
        'Explain German article patterns'
      ]
    };
    var _glActiveSkill = '';
    var _glToolMode = 'quiz';
    var _glQuizItems = [];
    var _glQuizIndex = 0;
    var _glSelectedOption = null;
    var _glCards = [];
    var _glCardIndex = 0;
    var _glCardFlipped = false;

    // Refresh hero badges/chips from globals set by app.js profile load.
    // Old layout had #glTestBadge; new v2 hero drops it but keeps the lookup
    // here as a no-op for safety. Level appears in two spots in v2:
    // the level stat-pill (#glLevelChip) and the read-only action chip
    // (#glLevelChipChip).
    function _glRefreshHero() {
      var glSub = document.getElementById('glTestBadge');
      var glChip = document.getElementById('glLevelChip');
      var glChipDup = document.getElementById('glLevelChipChip');
      var lvl = window._germanLevel || '–';
      if (glSub && window._germanTest) glSub.textContent = window._germanTest + ' preparation';
      if (glChip) glChip.textContent = lvl;
      if (glChipDup) glChipDup.textContent = lvl;
    }
    _glRefreshHero();

    // Learner home (the default landing subview for the "Home" sidebar item)
    // greets the user and hands off to the existing Practice/Writing Coach
    // subviews below — kept inside #psec-german alongside them rather than
    // as a separate portal section (see writing-coach.ts header comment on
    // why Practice/Writing Coach are DOM-coupled).
    function _glRefreshLearnerHome() {
      var nameEl = document.getElementById('glHomeGreeting');
      if (!nameEl) return;
      var authName = document.getElementById('authName');
      var name = (authName && authName.textContent && authName.textContent.trim()) || '';
      if (name.indexOf('Loading') === 0) name = '';
      var hour = new Date().getHours();
      var greeting = hour < 12 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
      nameEl.textContent = name ? greeting + ', ' + name : greeting;
    }
    _glRefreshLearnerHome();
    window.addEventListener('ss-profile-updated', _glRefreshLearnerHome);

    var glLearnerHome = document.getElementById('glLearnerHome');
    if (glLearnerHome) {
      glLearnerHome.addEventListener('click', function (e) {
        if (e.target.closest('#glHomePracticeBtn')) {
          window._glBackToHome();
        } else if (e.target.closest('#glHomeWritingCoachBtn')) {
          if (typeof window._wcOpen === 'function') window._wcOpen();
        }
      });
    }

    window._glShowLearnerHome = function () {
      _glActiveSkill = '';
      var home = document.getElementById('glHome');
      var detail = document.getElementById('glSkillView');
      var wcView = document.getElementById('wcView');
      var learnerHome = document.getElementById('glLearnerHome');
      if (home) home.style.display = 'none';
      if (detail) detail.style.display = 'none';
      if (wcView) wcView.style.display = 'none';
      if (learnerHome) learnerHome.style.display = '';
    };

    // Wire skill cards via event delegation. Anchor on the home wrapper so
    // a card click anywhere inside (including the "Open practice" button)
    // resolves to the right skill.
    document.getElementById('glHome').addEventListener('click', function (e) {
      var startBtn = e.target.closest('#glStartPractice');
      if (startBtn) {
        // Open last-used skill, or fall back to vocabulary.
        var last = '';
        try { last = localStorage.getItem('ss_gl_last_skill') || ''; } catch (_) {}
        window._glOpenSkill(last || 'vocab');
        return;
      }
      var card = e.target.closest('.gl-skill-card');
      if (card) {
        var sk = card.getAttribute('data-skill');
        try { localStorage.setItem('ss_gl_last_skill', sk); } catch (_) {}
        window._glOpenSkill(sk);
      }
    });

    // Back button
    var glBackBtn = document.getElementById('glBackBtn');
    if (glBackBtn)
      glBackBtn.addEventListener(
        'click',
        (window._glBackToHome = function () {
          _glActiveSkill = '';
          var home = document.getElementById('glHome');
          var detail = document.getElementById('glSkillView');
          var wcView = document.getElementById('wcView');
          var learnerHome = document.getElementById('glLearnerHome');
          if (home) home.style.display = '';
          if (detail) detail.style.display = 'none';
          // Also collapse the Schreibtrainer detail view — otherwise it
          // stays visible underneath the cards when the user navigates
          // away mid-session and clicks Practice again.
          if (wcView) wcView.style.display = 'none';
          if (learnerHome) learnerHome.style.display = 'none';
          var aiChipsEl = document.querySelector('.ai-chips');
          if (aiChipsEl && aiChipsEl._originalHTML) {
            aiChipsEl.innerHTML = aiChipsEl._originalHTML;
            aiChipsEl._originalHTML = null;
          }
        })
      );

    // Upload button
    var glUploadLabel = document.getElementById('glUploadLabel');
    if (glUploadLabel)
      glUploadLabel.addEventListener('click', function () {
        window._glUploadClick();
      });

    // File input change
    var glFileInput = document.getElementById('glFileInput');
    if (glFileInput)
      glFileInput.addEventListener('change', function () {
        window._glUploadFromInput(this);
      });

    // AI panel close
    var glAIPanelClose = document.getElementById('glAIPanelClose');
    if (glAIPanelClose)
      glAIPanelClose.addEventListener('click', function () {
        var panel = document.getElementById('glAIPanel');
        if (panel) panel.style.display = 'none';
      });

    var glQuizTab = document.getElementById('glQuizTab');
    var glCardsTab = document.getElementById('glCardsTab');
    var glGenerateQuiz = document.getElementById('glGenerateQuiz');
    var glGenerateCards = document.getElementById('glGenerateCards');
    if (glQuizTab)
      glQuizTab.addEventListener('click', function () {
        _glSetToolMode('quiz');
      });
    if (glCardsTab)
      glCardsTab.addEventListener('click', function () {
        _glSetToolMode('cards');
      });
    if (glGenerateQuiz)
      glGenerateQuiz.addEventListener('click', function () {
        _glGenerateStudyTool('quiz');
      });
    if (glGenerateCards)
      glGenerateCards.addEventListener('click', function () {
        _glGenerateStudyTool('flashcards');
      });

    document.addEventListener('keydown', function (e) {
      var detail = document.getElementById('glSkillView');
      if (!detail || detail.style.display === 'none' || !detail.getClientRects().length) return;
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
      if (_glToolMode === 'cards') {
        if (e.key === ' ') {
          e.preventDefault();
          _glFlipCard();
        } else if (e.key === 'ArrowLeft') {
          _glMoveCard(-1);
        } else if (e.key === 'ArrowRight') {
          _glMoveCard(1);
        }
      } else if (
        _glToolMode === 'quiz' &&
        _glSelectedOption &&
        (e.key === 'Enter' || e.key === ' ')
      ) {
        e.preventDefault();
        _glNextQuestion();
      }
    });

    // Legacy pieces of #glSkillView that Lesen replaces with its own
    // dedicated workspace (see _glOpenReadingView below). Toggled per-skill
    // so Wortschatz/Grammatik/etc. keep the generic quiz/cards template
    // exactly as before.
    function _glSetGenericSkillPiecesVisible(visible) {
      var hero = document.querySelector('#glSkillView .gl-detail-hero');
      var studyTools = document.querySelector('#glSkillView .gl-study-tools');
      var filesPanel = document.querySelector('#glSkillView .gl-files-panel');
      var backBtn = document.getElementById('glBackBtn');
      var aiPanel = document.getElementById('glAIPanel');
      [backBtn, hero, studyTools, filesPanel].forEach(function (el) {
        if (el) el.style.display = visible ? '' : 'none';
      });
      // AI panel stays hidden unless a message flow opened it; only force-hide
      // it when leaving the generic template, never force it open.
      if (aiPanel && !visible) aiPanel.style.display = 'none';
    }

    window._glOpenSkill = function (skill) {
      _glActiveSkill = skill;
      var home = document.getElementById('glHome');
      var detail = document.getElementById('glSkillView');
      var readingView = document.getElementById('glReadingView');
      var grammarView = document.getElementById('glGrammarView');
      if (home) home.style.display = 'none';
      if (detail) {
        detail.style.display = '';
        detail.setAttribute('data-active-skill', skill);
      }

      if (skill === 'reading') {
        _glSetGenericSkillPiecesVisible(false);
        if (grammarView) grammarView.style.display = 'none';
        if (readingView) readingView.style.display = '';
        _glOpenReadingView();
        return;
      }

      // Grammatik has its own dedicated sentence-building/correction
      // workspace (see the Grammatik IIFE below), same pattern as Lesen.
      // The typeof guard is defensive only, in case this controller ever
      // fails to load — falls back to the generic template rather than
      // throwing on an undefined function.
      if (skill === 'grammar' && typeof window._glOpenGrammarView === 'function') {
        _glSetGenericSkillPiecesVisible(false);
        if (readingView) readingView.style.display = 'none';
        if (grammarView) grammarView.style.display = '';
        window._glOpenGrammarView();
        return;
      }

      if (readingView) readingView.style.display = 'none';
      if (grammarView) grammarView.style.display = 'none';
      _glSetGenericSkillPiecesVisible(true);

      var titleEl = document.getElementById('glSkillTitle');
      var subEl = document.getElementById('glSkillSub');
      var eyebrowEl = document.getElementById('glSkillEyebrow');
      if (titleEl) titleEl.textContent = _glSkillNames[skill] || 'German Practice';
      if (subEl) subEl.textContent = _glSkillSubs[skill] || 'Practice German with quiz questions and flashcards.';
      if (eyebrowEl) eyebrowEl.textContent = 'German practice';

      _glLoadSampleTools(skill);
      _glRenderStudyTools();

      // Seed activeCourseId/activeCourseRef if not yet set, then load DB tools.
      var _glCourseForSkill = _glEnsurePracticeCourse();
      if (_glCourseForSkill) {
        _glLoadDbTools(_glCourseForSkill.id);
      }

      // Swap AI chips
      var aiChipsEl = document.querySelector('.ai-chips');
      if (aiChipsEl) {
        if (!aiChipsEl._originalHTML) aiChipsEl._originalHTML = aiChipsEl.innerHTML;
        aiChipsEl.innerHTML = '';
        (_glSkillChips[skill] || []).forEach(function (label) {
          var btn = document.createElement('span');
          btn.className = 'ai-tip';
          btn.textContent = label;
          btn.addEventListener('click', function () {
            window._glAsk(label, _glSkillNames[skill]);
          });
          aiChipsEl.appendChild(btn);
        });
      }

      _glRenderPracticeFileList();
    };

    window._glBackToHome = function () {
      _glActiveSkill = '';
      var home = document.getElementById('glHome');
      var detail = document.getElementById('glSkillView');
      var wcView = document.getElementById('wcView');
      var learnerHome = document.getElementById('glLearnerHome');
      if (home) home.style.display = '';
      if (detail) {
        detail.style.display = 'none';
        detail.removeAttribute('data-active-skill');
      }
      // Also collapse the Schreibtrainer detail view — otherwise it
      // stays visible underneath the cards when the user navigates
      // away mid-session and clicks Practice again.
      if (wcView) wcView.style.display = 'none';
      if (learnerHome) learnerHome.style.display = 'none';
      var aiChipsEl = document.querySelector('.ai-chips');
      if (aiChipsEl && aiChipsEl._originalHTML) {
        aiChipsEl.innerHTML = aiChipsEl._originalHTML;
        aiChipsEl._originalHTML = null;
      }
    };

    window._glAsk = function (prompt, title) {
      var test = window._germanTest || 'German test';
      var level = window._germanLevel || 'my level';
      var skill = _glSkillNames[_glActiveSkill] || _glActiveSkill || '';
      var pv = document.getElementById('pdfView');
      var pdfAlreadyOpen = pv && pv.style.display !== 'none' && pdfDoc;
      if (!pdfAlreadyOpen) {
        _showFilesView();
        var ws = document.getElementById('welcomeState');
        var co = document.getElementById('courseOverview');
        if (ws) {
          ws.style.display = 'flex';
          ws.innerHTML =
            '<div style="text-align:center;padding:40px 20px"><div style="font-size:3rem">🇩🇪</div><div style="font-family:\'Fredoka One\',cursive;font-size:1.3rem;color:#e2d9f3;margin-top:12px">' +
            (title || 'German Practice') +
            '</div><div style="font-size:.82rem;color:rgba(255,255,255,.4);margin-top:6px">' +
            test +
            (level ? ' \xB7 ' + level : '') +
            '</div></div>';
        }
        if (co) co.style.display = 'none';
        if (pv) pv.style.display = 'none';
      }
      openAI();
      pinAI();
      function _sendWhenReady(attempts) {
        if (pdfDoc && !pdfFullText && attempts > 0) {
          setTimeout(function () {
            _sendWhenReady(attempts - 1);
          }, 300);
          return;
        }
        var fullPrompt =
          prompt +
          ' (Context: ' +
          test +
          (level ? ', level ' + level : '') +
          (skill ? ', skill: ' + skill : '') +
          ')';
        askAI(fullPrompt, false);
      }
      setTimeout(function () {
        _sendWhenReady(10);
      }, 100);
    };

    function _glAppendMsg(text, role) {
      var msgs = document.getElementById('glAIMessages');
      if (!msgs) return;
      var d = document.createElement('div');
      d.className = 'gl-ai-msg ' + role;
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }

    // ── DB helpers (shared via js/utils/db-helpers.js) ──────────────────────
    function _supaHeaders() { return window._ssDb.supaHeaders(); }
    function _supaUrl()     { return window._ssDb.supaUrl(); }
    function _userId()      { return window._ssDb.userId(); }

    // practice.js is a classic script (no type="module" on its <script> tag
    // in loader.ts), so it can't use a static `import`. authenticatedSupabaseFetch
    // (proactive expiry-skew refresh + coordinated single-flight retry-on-401,
    // same contract already used by workspace-library.ts/study-tool-workflow.ts
    // for exam_sessions/flashcard_decks) is reached via dynamic import() instead,
    // which is valid from any script context. _supaHeaders()/_supaUrl() above
    // stay as-is — they still back window._ssDb for other legacy consumers —
    // but this file's own requests route through the auth-aware transport.
    var _authFetchModulePromise = null;
    function _getAuthFetchModule() {
      if (!_authFetchModulePromise) {
        _authFetchModulePromise = import('/js/services/authenticated-fetch.js');
      }
      return _authFetchModulePromise;
    }
    function _authFetch(url, init) {
      return _getAuthFetchModule().then(function (mod) {
        return mod.authenticatedFetch(url, init, { safeToRetry: true });
      });
    }
    function _authSupaFetch(url, init) {
      return _getAuthFetchModule().then(function (mod) {
        return mod.authenticatedSupabaseFetch(url, init, { safeToRetry: true });
      });
    }

    function _dbSaveQuiz(courseId, items) {
      var uid = _userId();
      if (!uid) return Promise.resolve(null);
      var sk = _glActiveSkill || 'general';
      var name = (_glSkillNames[sk] || sk) + ' Quiz';
      return _authSupaFetch(_supaUrl() + '/rest/v1/quiz_runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ user_id: uid, course_id: courseId, name: name, items: items })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { return rows && rows[0] ? rows[0].id : null; })
        .catch(function () { return null; });
    }

    function _dbLoadQuiz(courseId) {
      var url = _supaUrl() + '/rest/v1/quiz_runs?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=1';
      return _authSupaFetch(url, {})
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }

    function _dbSaveCards(courseId, items) {
      var uid = _userId();
      if (!uid) return Promise.resolve(null);
      var sk = _glActiveSkill || 'general';
      var name = (_glSkillNames[sk] || sk) + ' Flashcards';
      return _authSupaFetch(_supaUrl() + '/rest/v1/flashcard_decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ user_id: uid, course_id: courseId, name: name, cards: items })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { return rows && rows[0] ? rows[0].id : null; })
        .catch(function () { return null; });
    }

    function _dbLoadCards(courseId) {
      var url = _supaUrl() + '/rest/v1/flashcard_decks?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=1';
      return _authSupaFetch(url, {})
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }

    // Used for FILE OPERATIONS (upload/download/delete) — always returns a valid object.
    // Falls back to german-<skill> which is the learner's personal practice storage bucket.
    function _glStorageCourse() {
      var sk = _glActiveSkill || 'general';
      var id = window.activeCourseId ||
        (window.activeCourseRef && window.activeCourseRef.id) ||
        ('german-' + sk);
      return {
        id: id,
        short: id,
        name: (window.activeCourseRef && window.activeCourseRef.name) ||
          'German ' + (_glSkillNames[sk] || sk)
      };
    }

    // Used for RAG GENERATION — returns null when no real course is loaded.
    // Prevents sending fake german-* IDs to the AI pipeline.
    function _glCourse() {
      var realId = window.activeCourseId ||
        (window.activeCourseRef && window.activeCourseRef.id) ||
        null;
      if (!realId) return null;
      var sk = _glActiveSkill || 'general';
      return {
        id: realId,
        short: realId,
        name: (window.activeCourseRef && window.activeCourseRef.name) ||
          'German ' + (_glSkillNames[sk] || sk)
      };
    }

    // Ensures activeCourseId / activeCourseRef are set before generation or DB load.
    // If a real course is already active, returns it unchanged.
    // Otherwise seeds globals from the storage course (german-<skill>) so that
    // learners who upload files under german-* can generate from them immediately.
    function _glEnsurePracticeCourse() {
      if (window.activeCourseId || (window.activeCourseRef && window.activeCourseRef.id)) {
        return _glCourse();
      }
      var sc = _glStorageCourse();
      window.activeCourseId = sc.id;
      window.activeCourseRef = sc;
      return _glCourse(); // will now return sc
    }

    // Render inline KaTeX ($...$) and display KaTeX ($$...$$) if window.katex is available.
    // Falls back to escaped plain text if katex hasn't loaded yet.
    function _glRenderMath(text) {
      if (!text) return '';
      var s = _glEscape(text);
      if (!window.katex) return s;
      try {
        s = s.replace(/\$\$([^$]+?)\$\$/g, function (_, m) {
          try { return window.katex.renderToString(m, { displayMode: true, throwOnError: false }); }
          catch (e) { return _glEscape(m); }
        });
        s = s.replace(/\$([^$\n]+?)\$/g, function (_, m) {
          try { return window.katex.renderToString(m, { displayMode: false, throwOnError: false }); }
          catch (e) { return _glEscape(m); }
        });
      } catch (e) { /* keep escaped fallback */ }
      return s;
    }

    function _glFmtSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function _glEscape(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function _glSampleTools(skill) {
      var sets = {
        vocab: {
          quiz: [
            { category: 'Vocabulary', question: 'What does "die Rechnung" mean in a cafe?', options: { A: 'the reservation', B: 'the bill', C: 'the menu', D: 'the kitchen' }, answer: 'B', explanation: '"Die Rechnung" is the bill. You can say: "Kann ich bitte die Rechnung haben?"' },
            { category: 'Vocabulary', question: 'Which article belongs to "Apfel"?', options: { A: 'der', B: 'die', C: 'das', D: 'den' }, answer: 'A', explanation: 'It is "der Apfel". In accusative it becomes "den Apfel".' },
            { category: 'Vocabulary', question: 'What is the best everyday meaning of "suchen"?', options: { A: 'to search/look for', B: 'to book', C: 'to pay', D: 'to explain' }, answer: 'A', explanation: 'Example: "Ich suche den Bahnhof" means "I am looking for the train station."' }
          ],
          cards: [
            { front: 'die Rechnung', back: 'the bill - Kann ich bitte die Rechnung haben?' },
            { front: 'der Apfel', back: 'the apple - Ich kaufe einen Apfel.' },
            { front: 'suchen', back: 'to search/look for - Ich suche den Bahnhof.' }
          ]
        },
        grammar: {
          quiz: [
            { category: 'Dative after mit', question: 'Which sentence is correct?', options: { A: 'Ich spreche mit der Mann.', B: 'Ich spreche mit dem Mann.', C: 'Ich spreche mit den Mann.', D: 'Ich spreche mit die Mann.' }, answer: 'B', explanation: '"mit" always takes dative. Masculine "der Mann" changes to "dem Mann".' },
            { category: 'Dative after mit', question: 'Complete: Ich fahre mit ___ Bus.', options: { A: 'der', B: 'die', C: 'dem', D: 'das' }, answer: 'C', explanation: 'Bus is masculine: der Bus. After "mit", it becomes "mit dem Bus".' },
            { category: 'Dative after mit', question: 'Which preposition always takes dative?', options: { A: 'ohne', B: 'durch', C: 'mit', D: 'für' }, answer: 'C', explanation: 'Common dative prepositions include mit, nach, bei, seit, von, zu, aus.' }
          ],
          cards: [
            { front: 'mit + dative', back: 'der Mann -> mit dem Mann; die Frau -> mit der Frau; das Kind -> mit dem Kind' },
            { front: 'mit dem Bus', back: 'Use dative because "mit" requires dative.' },
            { front: 'Dative signal', back: 'Ask: With whom? With what? Then choose the dative form.' }
          ]
        },
        sentences: {
          quiz: [
            { category: 'Everyday sentences', question: 'Translate: "I would like a coffee."', options: { A: 'Ich habe einen Kaffee.', B: 'Ich hätte gern einen Kaffee.', C: 'Ich bin ein Kaffee.', D: 'Ich möchte gern Kaffee bin.' }, answer: 'B', explanation: '"Ich hätte gern..." is a natural, polite ordering phrase.' },
            { category: 'Everyday sentences', question: 'Which sentence is the polite request?', options: { A: 'Hilf mir jetzt.', B: 'Können Sie mir bitte helfen?', C: 'Du hilfst.', D: 'Ich helfe bitte.' }, answer: 'B', explanation: '"Können Sie..." plus "bitte" is polite and formal.' },
            { category: 'Everyday sentences', question: 'Choose the natural phrase for asking where the station is.', options: { A: 'Wo ist der Bahnhof?', B: 'Was ist Bahnhof?', C: 'Wie bin Bahnhof?', D: 'Wo Bahnhof ist?' }, answer: 'A', explanation: 'In a main question with a question word, the conjugated verb comes second: "Wo ist..."' }
          ],
          cards: [
            { front: 'Ich hätte gern einen Kaffee.', back: 'I would like a coffee. Use this for polite ordering.' },
            { front: 'Könnten Sie das bitte wiederholen?', back: 'Could you repeat that, please?' },
            { front: 'Ich suche den Bahnhof.', back: 'I am looking for the train station.' }
          ]
        },
        games: {
          quiz: [
            { category: 'Article game', question: 'der, die oder das: ___ Apfel', options: { A: 'der', B: 'die', C: 'das', D: 'eine' }, answer: 'A', explanation: 'Correct: der Apfel.' },
            { category: 'Article game', question: 'der, die oder das: ___ Rechnung', options: { A: 'der', B: 'die', C: 'das', D: 'den' }, answer: 'B', explanation: 'Correct: die Rechnung.' },
            { category: 'Article game', question: 'der, die oder das: ___ Mädchen', options: { A: 'der', B: 'die', C: 'das', D: 'dem' }, answer: 'C', explanation: 'Correct: das Mädchen.' }
          ],
          cards: [
            { front: 'der Apfel', back: 'masculine noun. Accusative: den Apfel.' },
            { front: 'die Rechnung', back: 'feminine noun. Useful phrase: die Rechnung bitte.' },
            { front: 'das Mädchen', back: 'neuter grammatical gender, even though it refers to a girl.' }
          ]
        },
        writing: {
          quiz: [
            { category: 'Writing', question: 'Which opener is best for a formal email?', options: { A: 'Hey du,', B: 'Sehr geehrte Damen und Herren,', C: 'Na?', D: 'Hallo Leute!' }, answer: 'B', explanation: 'Use "Sehr geehrte..." for formal emails and exam writing tasks.' },
            { category: 'Writing', question: 'Which connector adds another point?', options: { A: 'außerdem', B: 'trotzdem', C: 'obwohl', D: 'aber' }, answer: 'A', explanation: '"Außerdem" means "in addition".' }
          ],
          cards: [
            { front: 'Sehr geehrte Damen und Herren,', back: 'Formal email greeting.' },
            { front: 'Meiner Meinung nach...', back: 'In my opinion... Useful for arguments.' },
            { front: 'Außerdem...', back: 'Furthermore / in addition.' }
          ]
        },
        reading: {
          quiz: [
            { category: 'Reading', question: 'In a reading text, what does "Öffnungszeiten" usually mean?', options: { A: 'prices', B: 'opening hours', C: 'directions', D: 'appointments' }, answer: 'B', explanation: '"Öffnungszeiten" tells you when a shop, office, or service is open.' },
            { category: 'Reading', question: 'Which word signals contrast?', options: { A: 'deshalb', B: 'zuerst', C: 'trotzdem', D: 'außerdem' }, answer: 'C', explanation: '"Trotzdem" means nevertheless/even so.' }
          ],
          cards: [
            { front: 'Öffnungszeiten', back: 'opening hours' },
            { front: 'trotzdem', back: 'nevertheless / even so' },
            { front: 'zuerst', back: 'first / at first' }
          ]
        }
      };
      return sets[skill] || sets.vocab;
    }

    function _glLoadSampleTools(skill) {
      var sample = _glSampleTools(skill);
      _glQuizItems = sample.quiz.map(function (q) { return Object.assign({ _sample: true }, q); });
      _glCards = sample.cards.map(function (card) {
        return Object.assign({ bookmarked: false, confidence: null, _sample: true }, card);
      });
      _glQuizIndex = 0;
      _glSelectedOption = null;
      _glCardIndex = 0;
      _glCardFlipped = false;
    }

    async function _glLoadDbTools(courseId) {
      if (!courseId) return;
      try {
        var quizRows = await _dbLoadQuiz(courseId);
        if (quizRows && quizRows[0] && Array.isArray(quizRows[0].items) && quizRows[0].items.length) {
          _glQuizItems = quizRows[0].items;
          _glQuizIndex = 0;
          _glSelectedOption = null;
        }
        var cardRows = await _dbLoadCards(courseId);
        if (cardRows && cardRows[0] && Array.isArray(cardRows[0].cards) && cardRows[0].cards.length) {
          _glCards = cardRows[0].cards.map(function (card) {
            return Object.assign({ bookmarked: false, confidence: null }, card);
          });
          _glCardIndex = 0;
          _glCardFlipped = false;
        }
      } catch (e) {
        // leave state as-is on error
      }
      _glRenderStudyTools();
    }

    function _glSetToolMode(mode) {
      _glToolMode = mode === 'cards' ? 'cards' : 'quiz';
      var quizTab = document.getElementById('glQuizTab');
      var cardsTab = document.getElementById('glCardsTab');
      if (quizTab) {
        quizTab.classList.toggle('active', _glToolMode === 'quiz');
        quizTab.setAttribute('aria-selected', _glToolMode === 'quiz' ? 'true' : 'false');
      }
      if (cardsTab) {
        cardsTab.classList.toggle('active', _glToolMode === 'cards');
        cardsTab.setAttribute('aria-selected', _glToolMode === 'cards' ? 'true' : 'false');
      }
      _glRenderStudyTools();
    }

    function _glNormalizeQuizItem(item, idx) {
      var rawOptions = item.options || {};
      var opts = {};
      if (Array.isArray(rawOptions)) {
        rawOptions.forEach(function (option, i) {
          var letter = option.id || ['A', 'B', 'C', 'D'][i];
          if (letter) opts[letter] = option.text || option.label || String(option);
        });
      } else {
        ['A', 'B', 'C', 'D'].forEach(function (letter) {
          if (rawOptions[letter]) opts[letter] = rawOptions[letter];
        });
      }
      return {
        category: item.category || item.source || _glSkillNames[_glActiveSkill] || 'Practice',
        question: item.question || 'Question ' + (idx + 1),
        options: opts,
        answer: item.answer || item.correctOptionId || 'A',
        explanation: item.explanation || 'Review the correct answer and continue when ready.'
      };
    }

    function _glRenderStudyTools() {
      var body = document.getElementById('glStudyToolBody');
      if (!body) return;
      if (_glToolMode === 'cards') {
        _glRenderFlashcards(body);
      } else {
        _glRenderQuiz(body);
      }
    }

    function _glRenderQuiz(body) {
      if (!_glQuizItems.length) {
        body.innerHTML =
          '<div class="gl-study-empty">No quiz generated yet. Click <strong>Generate Quiz</strong> to create one from your uploaded files.</div>';
        return;
      }
      var isSample = _glQuizItems[0] && _glQuizItems[0]._sample;
      var item = _glNormalizeQuizItem(_glQuizItems[_glQuizIndex], _glQuizIndex);
      var answered = !!_glSelectedOption;
      var optionHtml = ['A', 'B', 'C', 'D']
        .filter(function (letter) {
          return item.options[letter];
        })
        .map(function (letter) {
          var state = '';
          var status = '';
          if (answered && letter === item.answer) {
            state = ' correct';
            status = '<span class="gl-option-status">Correct answer</span>';
          } else if (answered && letter === _glSelectedOption) {
            state = ' incorrect';
            status = '<span class="gl-option-status">Your answer</span>';
          }
          return (
            '<button class="gl-quiz-option' +
            state +
            '" type="button" data-option="' +
            letter +
            '"' +
            (answered ? ' disabled' : '') +
            ' aria-label="' +
            _glEscape(letter + '. ' + item.options[letter]) +
            '">' +
            '<span class="gl-option-letter">' +
            letter +
            '</span>' +
            '<span>' +
            _glRenderMath(item.options[letter]) +
            '</span>' +
            status +
            '</button>'
          );
        })
        .join('');
      body.innerHTML =
        (isSample ? '<div class="gl-sample-banner">Sample practice — generate from your files to replace this.</div>' : '') +
        '<section class="gl-quiz-shell" aria-live="polite">' +
        '<div class="gl-quiz-badge">Question ' +
        (_glQuizIndex + 1) +
        ' / ' +
        _glQuizItems.length +
        '</div>' +
        '<div class="gl-quiz-category">' +
        _glEscape(item.category) +
        '</div>' +
        '<div class="gl-quiz-question">' +
        _glRenderMath(item.question) +
        '</div>' +
        '<div class="gl-quiz-options">' +
        optionHtml +
        '</div>' +
        (answered
          ? '<div class="gl-explanation"><strong>Explanation:</strong> ' +
            _glRenderMath(item.explanation) +
            '</div><button class="gl-continue-btn" id="glContinueQuiz" type="button">Got it, keep going</button>'
          : '') +
        '</section>';

      body.querySelectorAll('.gl-quiz-option').forEach(function (btn) {
        btn.addEventListener('click', function () {
          _glSelectedOption = btn.getAttribute('data-option');
          _glRenderStudyTools();
        });
      });
      var continueBtn = document.getElementById('glContinueQuiz');
      if (continueBtn) continueBtn.addEventListener('click', _glNextQuestion);
    }

    function _glNextQuestion() {
      if (!_glQuizItems.length) return;
      _glQuizIndex = (_glQuizIndex + 1) % _glQuizItems.length;
      _glSelectedOption = null;
      _glRenderStudyTools();
    }

    function _glRenderFlashcards(body) {
      if (!_glCards.length) {
        body.innerHTML =
          '<div class="gl-study-empty">No flashcards generated yet. Click <strong>Generate Cards</strong> to create some from your uploaded files.</div>';
        return;
      }
      var isSample = _glCards[0] && _glCards[0]._sample;
      var card = _glCards[_glCardIndex];
      body.innerHTML =
        (isSample ? '<div class="gl-sample-banner">Sample practice — generate from your files to replace this.</div>' : '') +
        '<section class="gl-flash-shell" aria-live="polite">' +
        '<div class="gl-flash-top">' +
        '<div><div class="gl-flash-label">' +
        (_glCardFlipped ? 'Definition' : 'Begriff') +
        '</div><div class="gl-study-sub">Card ' +
        (_glCardIndex + 1) +
        ' / ' +
        _glCards.length +
        '</div></div>' +
        '<div class="gl-flash-icons" aria-label="Flashcard feedback">' +
        '<button class="gl-flash-icon know' +
        (card.confidence === 'known' ? ' active' : '') +
        '" type="button" data-feedback="known" title="I know this">+</button>' +
        '<button class="gl-flash-icon review' +
        (card.confidence === 'review' ? ' active' : '') +
        '" type="button" data-feedback="review" title="Needs review">-</button>' +
        '<button class="gl-flash-icon bookmark' +
        (card.bookmarked ? ' active' : '') +
        '" type="button" data-feedback="bookmark" title="Bookmark">*</button>' +
        '</div></div>' +
        '<div class="gl-flash-stage">' +
        '<button class="gl-flash-card' +
        (_glCardFlipped ? ' flipped' : '') +
        '" id="glFlashCard" type="button" aria-label="Flashcard, ' +
        (_glCardFlipped ? 'back side visible' : 'front side visible') +
        '">' +
        '<span class="gl-flash-side front"><span class="gl-flash-text">' +
        _glRenderMath(card.front || card.term || 'Card front') +
        '</span></span>' +
        '<span class="gl-flash-side back"><span class="gl-flash-text">' +
        _glRenderMath(card.back || card.definition || 'Card back') +
        '</span></span>' +
        '</button></div>' +
        '<div class="gl-flash-controls">' +
        '<button class="gl-flash-control" type="button" data-move="-1">Back</button>' +
        '<button class="gl-flash-control" type="button" id="glFlipBtn">Flip</button>' +
        '<button class="gl-flash-control" type="button" data-move="1">Next</button>' +
        '</div>' +
        '</section>';
      var flashCard = document.getElementById('glFlashCard');
      var flipBtn = document.getElementById('glFlipBtn');
      if (flashCard) flashCard.addEventListener('click', _glFlipCard);
      if (flipBtn) flipBtn.addEventListener('click', _glFlipCard);
      body.querySelectorAll('[data-move]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          _glMoveCard(parseInt(btn.getAttribute('data-move'), 10));
        });
      });
      body.querySelectorAll('[data-feedback]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var type = btn.getAttribute('data-feedback');
          if (type === 'bookmark') card.bookmarked = !card.bookmarked;
          else card.confidence = card.confidence === type ? null : type;
          _glRenderStudyTools();
        });
      });
    }

    function _glFlipCard() {
      if (!_glCards.length) return;
      _glCardFlipped = !_glCardFlipped;
      _glRenderStudyTools();
    }

    function _glMoveCard(delta) {
      if (!_glCards.length) return;
      _glCardIndex = (_glCardIndex + delta + _glCards.length) % _glCards.length;
      _glCardFlipped = false;
      _glRenderStudyTools();
    }

    function _glSeenItems() {
      return _glQuizItems.map(function (q) { return q.question || ''; })
        .concat(_glCards.map(function (c) { return c.front || ''; }))
        .filter(Boolean).slice(0, 60);
    }

    function _glShowSourcePicker(docs, onConfirm) {
      var existing = document.getElementById('glSourcePickerOverlay');
      if (existing) existing.remove();
      var listHtml = docs.map(function (d) {
        return '<label class="qzsp-item">' +
          '<input type="checkbox" class="qzsp-cb" value="' + _glEscape(d.id) + '" checked>' +
          '<span class="qzsp-name">' + _glEscape(d.file_name || d.fileName || 'Untitled') + '</span>' +
          '</label>';
      }).join('');
      var overlay = document.createElement('div');
      overlay.id = 'glSourcePickerOverlay';
      overlay.className = 'qzsp-overlay';
      overlay.innerHTML =
        '<div class="qzsp-modal">' +
          '<div class="qzsp-head"><span class="qzsp-title">&#x1F4C2; Choose source files</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button></div>' +
          '<p class="qzsp-sub">Select which indexed files to use for generation.</p>' +
          '<div class="qzsp-list">' + listHtml + '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-ghost" id="glspSelectAll" type="button">Select all</button>' +
            '<button class="qzsp-btn-ghost" id="glspClearAll" type="button">Clear</button>' +
            '<button class="qzsp-btn-primary" id="glspConfirm" type="button">&#x2728; Generate</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.qzsp-close').onclick = function () { overlay.remove(); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('#glspSelectAll').onclick = function () {
        overlay.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = true; });
      };
      overlay.querySelector('#glspClearAll').onclick = function () {
        overlay.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = false; });
      };
      overlay.querySelector('#glspConfirm').onclick = function () {
        var ids = [];
        overlay.querySelectorAll('.qzsp-cb:checked').forEach(function (cb) { ids.push(cb.value); });
        overlay.remove();
        if (!ids.length) { if (typeof showToast === 'function') showToast('No files selected', 'Select at least one file.'); return; }
        onConfirm(ids);
      };
    }

    async function _glPickSourcesThenGenerate(tool) {
      var course = _glCourse() || _glEnsurePracticeCourse();
      if (!course || !course.id) {
        if (typeof showToast === 'function')
          showToast('No course selected', 'Open a real course first, then generate quizzes or flashcards from its uploaded files.');
        return;
      }
      try {
        var r = await _authFetch(BACKEND_URL + '/api/documents/list?courseId=' + encodeURIComponent(course.id), {});
        var data = r.ok ? await r.json() : {};
        var docs = (data.documents || []).filter(function (d) { return d.processing_status === 'ready'; });
        if (!docs.length) {
          _glRunGenerate(tool, null);
          return;
        }
        _glShowSourcePicker(docs, function (selectedIds) { _glRunGenerate(tool, selectedIds); });
      } catch (e) {
        _glRunGenerate(tool, null);
      }
    }

    async function _glRunGenerate(tool, documentIds) {
      var course = _glCourse();
      if (!course || !course.id) return;

      var targetMode = tool === 'flashcards' ? 'cards' : 'quiz';
      _glSetToolMode(targetMode);
      var body = document.getElementById('glStudyToolBody');
      if (body)
        body.innerHTML = '<div class="gl-study-empty">Generating from your material...</div>';

      var topic = _glSkillNames[_glActiveSkill] || _glActiveSkill || null;
      var difficulty = 'medium';
      var count = tool === 'quiz' ? 5 : 8;

      try {
        var payload = {
          courseId: course.id,
          tool: tool,
          count: count,
          difficulty: difficulty,
          topic: topic,
          seenItems: _glSeenItems()
        };
        if (documentIds && documentIds.length) payload.documentIds = documentIds;

        var resp = await _authFetch(BACKEND_URL + '/api/ai/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var data = await resp.json();

        if (data && data.items && data.items.length) {
          var meta = {
            courseId: course.id,
            courseName: course.name,
            topic: topic,
            difficulty: difficulty,
            documentIds: documentIds || null,
            count: data.items.length,
            created_at: new Date().toISOString()
          };
          if (tool === 'quiz') {
            _glQuizItems = data.items;
            _glQuizIndex = 0;
            _glSelectedOption = null;
            _dbSaveQuiz(course.id, data.items).then(function () {
              if (typeof showToast === 'function') showToast('Saved', 'Quiz saved to your study tools.');
            });
          } else {
            _glCards = data.items.map(function (card) {
              return { front: card.front, back: card.back, source: card.source || '', bookmarked: false, confidence: null };
            });
            _glCardIndex = 0;
            _glCardFlipped = false;
            _dbSaveCards(course.id, data.items).then(function () {
              if (typeof showToast === 'function') showToast('Saved', 'Flashcards saved to your study tools.');
            });
          }
        } else {
          var errMsg = (data && data.error) ? data.error : 'No indexed documents found for this course.';
          if (typeof showToast === 'function') showToast('Generation failed', errMsg);
        }
      } catch (e) {
        if (typeof showToast === 'function') showToast('Generation failed', e.message || 'Could not reach server.');
      }
      _glRenderStudyTools();
    }

    async function _glGenerateStudyTool(tool) {
      _glPickSourcesThenGenerate(tool);
    }

    function _glFileIcon(name) {
      var ext = (name.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') return '📄';
      if (['doc', 'docx'].includes(ext)) return '📝';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return '🖼️';
      return '📎';
    }

    async function _glRenderPracticeFileList() {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      var list = document.getElementById('glFileList');
      var empty = document.getElementById('glFileEmpty');
      if (!list) return;
      list.innerHTML = '';
      if (!uid) {
        if (empty) empty.style.display = '';
        return;
      }
      var course = _glStorageCourse();
      if (!course.files) course.files = [];
      try {
        await _ufMerge(course);
      } catch (e) {
        console.warn('glRenderPracticeFileList merge error:', e);
      }
      var files = course.files || [];
      if (empty) empty.style.display = files.length ? 'none' : '';
      files.forEach(function (file) {
        var name = file.name || file.file_name || 'German file';
        var row = document.createElement('div');
        row.className = 'gl-file-row';
        row.innerHTML =
          '<span class="gl-file-icon">' + _glFileIcon(name) + '</span>' +
          '<span class="gl-file-name">' + _glEscape(name) + '</span>' +
          '<span class="gl-file-size">' + (file.size ? _glFmtSize(file.size) : '') + '</span>' +
          '<button type="button" class="gl-file-open">Open</button>' +
          '<button type="button" class="gl-file-quiz">Quiz</button>' +
          '<button type="button" class="gl-file-explain">Explain</button>' +
          '<button type="button" class="gl-file-del">Delete</button>';
        var open = row.querySelector('.gl-file-open');
        var quiz = row.querySelector('.gl-file-quiz');
        var explain = row.querySelector('.gl-file-explain');
        var del = row.querySelector('.gl-file-del');
        if (open) open.addEventListener('click', function () { _glOpenFile(uid, name); });
        if (quiz) quiz.addEventListener('click', function () { _glAskAboutFile(uid, name, 'quiz'); });
        if (explain) explain.addEventListener('click', function () { _glAskAboutFile(uid, name, 'explain'); });
        if (del) del.addEventListener('click', function () { _glDeleteFile(uid, name, row); });
        list.appendChild(row);
      });
    }

    async function _glLoadFiles() {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!uid) return;
      var course = _glStorageCourse();
      if (!course.files) course.files = [];
      try {
        await _ufMerge(course);
      } catch (e) {
        console.warn('glLoadFiles merge error:', e);
      }
      activeCourseId = course.id;
      activeCourseRef = course;
      _showFilesView();
      var crumb = document.getElementById('breadcrumb');
      if (crumb) crumb.innerHTML = '<b>' + (course.name || course.id) + '</b>';
      showCourseSection(course, 'files');
    }

    function _glOpenFile(uid, fname) {
      var ext = (fname.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') {
        var course = _glStorageCourse();
        activeCourseId = course.id;
        var fakeFile = { name: fname, _uploaded: true, _course: course };
        _showFilesView();
        openFile(fakeFile, course);
      } else {
        _ufFetchBytes(uid, _glStorageCourse(), fname)
          .then(function (bytes) {
            var blob = new Blob([bytes], { type: 'application/octet-stream' });
            window.open(URL.createObjectURL(blob), '_blank');
          })
          .catch(function (e) {
            showToast('Could not open file', e.message || String(e));
          });
      }
    }
    window._glOpenFile = _glOpenFile;

    async function _glDeleteFile(uid, fname, rowEl) {
      if (!confirm('Delete "' + fname + '"?')) return;
      try {
        await _ufDeleteRemote(uid, _glStorageCourse(), fname);
        rowEl.remove();
        var list = document.getElementById('glFileList');
        if (list && !list.querySelector('.gl-file-row')) {
          var empty = document.getElementById('glFileEmpty');
          if (empty) empty.style.display = '';
        }
        showToast('File deleted', fname);
      } catch (e) {
        showToast('Delete failed', e.message || String(e));
      }
    }
    window._glDeleteFile = _glDeleteFile;

    async function _glAskAboutFile(uid, fname, mode) {
      var panel = document.getElementById('glAIPanel');
      var msgs = document.getElementById('glAIMessages');
      var ptitle = document.getElementById('glAIPanelTitle');
      if (!panel || !msgs) return;
      panel.style.display = '';
      if (ptitle) ptitle.textContent = (mode === 'quiz' ? '🧠 Quiz — ' : '💡 Explain — ') + fname;
      msgs.innerHTML = '';
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      var loadMsg = _glAppendMsg('Loading file…', 'bot');
      var bytes;
      try {
        bytes = await _ufFetchBytes(uid, _glStorageCourse(), fname);
      } catch (e) {
        loadMsg.textContent = '⚠️ Could not load file: ' + (e.message || String(e));
        return;
      }

      var ext = (fname.split('.').pop() || '').toLowerCase();
      var test = window._germanTest || 'German exam';
      var level = window._germanLevel || 'my level';
      var systemCtx =
        'You are a German language tutor helping a student prepare for ' +
        test +
        (level ? ' at level ' + level : '') +
        '. The student has uploaded a study document. Base ALL your responses strictly on its content.';

      var userPrompt =
        mode === 'quiz'
          ? 'Based on this document, create a quiz with 5 questions (multiple choice or short answer) that test understanding of the key content. After each question, provide the correct answer and a brief explanation.'
          : 'Explain the key concepts in this document clearly and concisely. Highlight the most important points a student should understand and remember for their exam.';

      loadMsg.textContent = '⏳ Reading file…';

      var messageContent;
      if (ext === 'pdf') {
        var b64 = '';
        var chunkSize = 8192;
        for (var i = 0; i < bytes.length; i += chunkSize) {
          var chunk = bytes.subarray(i, i + chunkSize);
          b64 += String.fromCharCode.apply(null, chunk);
        }
        b64 = btoa(b64);
        messageContent = [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: b64 }
          },
          { type: 'text', text: userPrompt }
        ];
      } else if (['txt', 'md'].includes(ext)) {
        var textContent = new TextDecoder().decode(bytes);
        messageContent = [
          { type: 'text', text: 'DOCUMENT CONTENT:\n' + textContent + '\n\n' + userPrompt }
        ];
      } else {
        loadMsg.textContent =
          '⚠️ Only PDF and text files can be analysed by the AI. Open the file to view it.';
        return;
      }

      loadMsg.textContent = '⏳ Asking AI…';

      try {
        var resp = await _authFetch(BACKEND_URL + '/api/ai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            system: systemCtx,
            messages: [{ role: 'user', content: messageContent }]
          })
        });
        var data = await resp.json();
        var text = data.error
          ? '❌ ' + (data.error.message || JSON.stringify(data.error))
          : data.content
            ? data.content
                .map(function (b) {
                  return b.text || '';
                })
                .join('')
            : '⚠️ No response';
        loadMsg.textContent = text;
      } catch (e) {
        loadMsg.textContent = '⚠️ Could not reach AI. Check your connection.';
      }
    }
    window._glAskAboutFile = _glAskAboutFile;

    window._glUploadFiles = async function (files, folder) {
      if (!files || !files.length) return;
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!uid) {
        showToast('Not logged in', 'Please sign in first');
        return;
      }
      var prog = document.getElementById('glUploadProgress');
      var bar = document.getElementById('glUploadBar');
      var status = document.getElementById('glUploadStatus');
      var label = document.getElementById('glUploadLabel');
      if (prog) prog.style.display = '';
      if (label) label.style.pointerEvents = 'none';

      var arr = Array.from(files);
      for (var i = 0; i < arr.length; i++) {
        var f = arr[i];
        if (status)
          status.textContent = 'Uploading ' + f.name + ' (' + (i + 1) + '/' + arr.length + ')…';
        try {
          await _ufUpload(
            uid,
            _glStorageCourse(),
            f,
            function (pct) {
              if (bar) bar.style.width = pct + '%';
            },
            folder || null
          );
        } catch (e) {
          showToast('Upload failed', f.name + ': ' + (e.message || String(e)));
        }
      }

      if (prog) prog.style.display = 'none';
      if (bar) bar.style.width = '0%';
      if (label) label.style.pointerEvents = '';
      var inp = document.getElementById('glFileInput');
      if (inp) inp.value = '';
      showToast('Upload complete', arr.length + ' file' + (arr.length > 1 ? 's' : '') + ' saved');
      await _glRenderPracticeFileList();
    };

    window._glUploadClick = function () {
      var inp = document.getElementById('glFileInput');
      if (!inp) return;
      var course = _glStorageCourse();
      var ref = activeCourseRef && activeCourseRef.id === course.id ? activeCourseRef : course;
      var folders = (ref.userFolders || []).map(function (fd) {
        return fd.name;
      });
      var btn = document.getElementById('glUploadLabel');
      if (folders.length === 0) {
        inp._glFolder = null;
        inp.click();
      } else {
        _showFolderPickerPopup(btn || document.body, folders, function (chosen) {
          inp._glFolder = chosen;
          inp.click();
        });
      }
    };

    window._glUploadFromInput = function (inputEl) {
      window._glUploadFiles(inputEl.files, inputEl._glFolder || null);
    };

    // ── Lesen (reading comprehension) ───────────────────────────────────────
    // Dedicated workspace, distinct from the generic quiz/cards template used
    // by every other skill. Lives entirely inside #glReadingView (see
    // practice.html) and is only mounted when _glOpenSkill('reading') runs.
    (function () {
      var RD_CATEGORIES = ['Finding explicit information', 'Meaning in context', 'Inference', 'Author intention'];

      function rdSentences(paragraph) {
        // Split on sentence boundaries while keeping the punctuation, so each
        // clickable "evidence" span still reads naturally.
        var parts = paragraph.match(/[^.!?]+[.!?]+(\s+|$)/g);
        return parts && parts.length ? parts : [paragraph];
      }

      var RD_SETS = [
        {
          passage: {
            title: 'Warum immer mehr Studierende neben dem Studium arbeiten',
            meta: 'B2 · Article · ~4 min',
            paragraphs: [
              'Immer mehr Studierende in Deutschland entscheiden sich dafür, neben dem Studium zu arbeiten. Einer aktuellen Studie zufolge geht fast die Hälfte aller Studierenden einer bezahlten Tätigkeit nach. Die Gründe sind vielfältig. Viele möchten ihre monatlichen Ausgaben selbst finanzieren oder ihre Chancen auf dem Arbeitsmarkt verbessern.',
              'Besonders in Großstädten wie München, Hamburg oder Köln sind die Lebenshaltungskosten hoch. Ein Nebenjob kann helfen, die Miete, das Semesterticket und andere Kosten selbst zu bezahlen. Allerdings kann die Doppelbelastung aus Studium und Arbeit auch stressig sein, deshalb raten Experten, nicht mehr als 20 Stunden pro Woche zu arbeiten.',
              'Ein Beispiel dafür ist Lena, 22, die Betriebswirtschaft in Köln studiert. Seit dem zweiten Semester arbeitet sie zehn Stunden pro Woche in einem Café, weil sie ihre monatlichen Ausgaben selbst finanzieren möchte. "Ich wollte nicht mehr jeden Monat meine Eltern fragen", sagt sie. Für Lena ist der Job außerdem eine gute Gelegenheit, praktische Erfahrung zu sammeln.',
              'Experten empfehlen Studierenden, auf eine gute Balance zwischen Job und Studium zu achten. Wer zu viele Stunden arbeitet, riskiert schlechtere Noten oder eine längere Studienzeit. Trotzdem sind sich die meisten einig: Ein Nebenjob lohnt sich, wenn er zum Studienalltag passt.'
            ]
          },
          questions: [
            {
              type: 'mc', category: 'Finding explicit information',
              prompt: 'Warum entscheidet sich Lena für einen Nebenjob?',
              options: {
                A: 'Sie möchte mehr Freizeit haben.',
                B: 'Sie will ihre monatlichen Ausgaben selbst finanzieren.',
                C: 'Sie möchte nicht mehr studieren.',
                D: 'Sie hat keine andere Möglichkeit.'
              },
              answer: 'B',
              explanation: 'The text says that Lena wants to finance her monthly expenses herself.',
              wrongWhy: { A: 'The text never says that she wants additional free time.', C: 'Lena is still studying — the text never suggests she wants to stop.', D: 'The text frames it as her own choice, not the only option.' },
              evidence: 'weil sie ihre monatlichen Ausgaben selbst finanzieren möchte'
            },
            {
              type: 'tf', category: 'Inference',
              prompt: 'Viele Studierende arbeiten ausschließlich am Wochenende.',
              answer: 'Not stated',
              explanation: 'The text talks about hours per week in general — it never says the work happens only on weekends.',
              evidence: 'nicht mehr als 20 Stunden pro Woche zu arbeiten'
            },
            {
              type: 'evidence', category: 'Finding explicit information',
              prompt: 'Find the sentence that explains why Lena works.',
              evidence: 'weil sie ihre monatlichen Ausgaben selbst finanzieren möchte',
              explanation: 'This clause is the reason Lena gives for working: to cover her own monthly expenses.'
            },
            {
              type: 'meaning', category: 'Meaning in context',
              prompt: 'What does "Ausgaben" mean in paragraph 3?',
              options: { A: 'expenses / costs', B: 'income', C: 'savings', D: 'invoices' },
              answer: 'A',
              explanation: '"Ausgaben" means expenses or costs — money that goes out, the opposite of income.',
              wrongWhy: { B: '"Income" would be "Einnahmen", the opposite word.', C: '"Savings" would be "Ersparnisse".', D: '"Invoices" would be "Rechnungen".' },
              evidence: 'ihre monatlichen Ausgaben selbst finanzieren'
            },
            {
              type: 'short', category: 'Finding explicit information',
              prompt: 'Warum arbeitet Lena neben dem Studium?',
              keywords: ['ausgaben', 'finanzier', 'geld', 'miete', 'kosten'],
              explanation: 'She works so she can finance her own monthly expenses instead of asking her parents.',
              evidence: 'weil sie ihre monatlichen Ausgaben selbst finanzieren möchte'
            },
            {
              type: 'match', category: 'Author intention',
              prompt: 'Match each heading to paragraphs 1–4.',
              headings: ['Warum immer mehr Studierende arbeiten', 'Die Kosten in der Stadt', 'Ein Beispiel: Lena', 'Die richtige Balance finden'],
              answer: [0, 1, 2, 3],
              explanation: 'The article moves from the general trend, to city living costs, to Lena’s personal example, to expert advice on balance.'
            }
          ]
        },
        {
          passage: {
            title: 'Digitale Vorlesungen: Fluch oder Segen?',
            meta: 'B2 · University text · ~3 min',
            paragraphs: [
              'Seit einigen Jahren bieten viele deutsche Universitäten ihre Vorlesungen zusätzlich online an. Studierende können Aufzeichnungen jederzeit ansehen, pausieren und wiederholen. Für manche ist das eine willkommene Flexibilität, besonders wenn sie neben dem Studium arbeiten oder Kinder betreuen.',
              'Kritiker bemängeln jedoch, dass der direkte Kontakt zu Dozierenden und Kommilitonen verloren geht. Fragen werden seltener gestellt, und Diskussionen im Hörsaal finden kaum noch statt. Manche Studierende berichten außerdem, dass sie sich zu Hause schwerer konzentrieren können als im Hörsaal.',
              'Eine Umfrage unter Erstsemestern zeigt ein gemischtes Bild: Etwa 55 Prozent bevorzugen eine Mischung aus Präsenz- und Online-Angeboten. Nur wenige wollen vollständig auf persönliche Vorlesungen verzichten. Die meisten Universitäten planen daher, beide Formate dauerhaft nebeneinander anzubieten.'
            ]
          },
          questions: [
            {
              type: 'mc', category: 'Finding explicit information',
              prompt: 'Was ist ein genannter Vorteil von Online-Vorlesungen?',
              options: {
                A: 'Man kann sie jederzeit ansehen und wiederholen.',
                B: 'Sie ersetzen alle Prüfungen.',
                C: 'Sie sind kürzer als normale Vorlesungen.',
                D: 'Man muss keine Hausaufgaben mehr machen.'
              },
              answer: 'A',
              explanation: 'The text explicitly names flexibility — recordings can be watched, paused and repeated any time.',
              wrongWhy: { B: 'Exams are never mentioned in the text.', C: 'Length is never compared.', D: 'Homework is never mentioned.' },
              evidence: 'Studierende können Aufzeichnungen jederzeit ansehen, pausieren und wiederholen'
            },
            {
              type: 'tf', category: 'Inference',
              prompt: 'Die Mehrheit der Erstsemester möchte komplett auf Präsenzvorlesungen verzichten.',
              answer: 'False',
              explanation: 'The survey says most first-year students prefer a mix, and only a few want to give up in-person lectures entirely — the opposite of "complete verzicht".',
              evidence: 'Nur wenige wollen vollständig auf persönliche Vorlesungen verzichten'
            },
            {
              type: 'meaning', category: 'Meaning in context',
              prompt: 'What does "Kommilitonen" mean in paragraph 2?',
              options: { A: 'fellow students', B: 'professors', C: 'exams', D: 'lecture halls' },
              answer: 'A',
              explanation: '"Kommilitonen" means fellow students / classmates.',
              wrongWhy: { B: 'Professors are "Dozierende", mentioned separately in the same sentence.', C: 'Exams are "Prüfungen".', D: 'Lecture halls are "Hörsäle".' },
              evidence: 'der direkte Kontakt zu Dozierenden und Kommilitonen verloren geht'
            },
            {
              type: 'short', category: 'Author intention',
              prompt: 'Warum planen die meisten Universitäten, beide Formate anzubieten?',
              keywords: ['mischung', 'beide', 'präsenz', 'online', 'umfrage'],
              explanation: 'Because the survey shows most students prefer a mix of in-person and online formats, universities plan to keep offering both.',
              evidence: 'Die meisten Universitäten planen daher, beide Formate dauerhaft nebeneinander anzubieten'
            }
          ]
        }
      ];

      var RD_WEAK_SET = {
        passage: RD_SETS[1].passage,
        questions: RD_SETS[1].questions.filter(function (q) {
          return q.category === 'Inference' || q.category === 'Author intention';
        }).concat([{
          type: 'tf', category: 'Inference',
          prompt: 'Alle Dozierenden lehnen Online-Vorlesungen ab.',
          answer: 'Not stated',
          explanation: 'The text mentions critics of remote learning in general, but never says all lecturers reject online lectures.',
          evidence: 'Kritiker bemängeln jedoch, dass der direkte Kontakt zu Dozierenden und Kommilitonen verloren geht'
        }])
      };

      var rd = {
        tab: 'practice',
        setIndex: 0,
        passage: null,
        questions: [],
        index: 0,
        answers: {}, // idx -> { status: 'answered'|'correct'|'review', selected, evidenceShown }
        hintShown: {},
        matchChoices: {},
        done: false,
        isSample: true,
        // Bumped by every rdLoadSet call. A long-running "from my files"
        // generation captures this before its request and checks it hasn't
        // moved before applying results, so a stale response can never
        // clobber a session the user has since navigated away from or reset.
        genToken: 0
      };

      function rdEl(id) { return document.getElementById(id); }

      function rdLoadSet(set, isSample) {
        rd.genToken++;
        rd.passage = set.passage;
        rd.questions = set.questions;
        rd.index = 0;
        rd.answers = {};
        rd.hintShown = {};
        rd.matchChoices = {};
        rd.done = false;
        rd.isSample = isSample !== false;
      }

      window._glOpenReadingView = function () {
        rd.tab = 'practice';
        rdLoadSet(RD_SETS[rd.setIndex % RD_SETS.length]);
        rdRenderTabs();
        rdRenderFilesPanel(false);
        rdEl('glReadingWorkspace').style.display = '';
        rdEl('glReadingEnd').style.display = 'none';
        rdRenderText();
        rdRenderQuestion();
        rdWireHeader();
      };

      function rdWireHeader() {
        var tabsWrap = document.querySelector('.gl-reading-tabs');
        if (tabsWrap && !tabsWrap._rdWired) {
          tabsWrap._rdWired = true;
          tabsWrap.addEventListener('click', function (e) {
            var btn = e.target.closest('.gl-reading-tab');
            if (!btn) return;
            rdSetTab(btn.getAttribute('data-reading-tab'));
          });
        }
        var typeSel = rdEl('glReadingTextType');
        var levelSel = rdEl('glReadingLevel');
        if (typeSel && !typeSel._rdWired) {
          typeSel._rdWired = true;
          typeSel.addEventListener('change', rdNewText);
        }
        if (levelSel && !levelSel._rdWired) {
          levelSel._rdWired = true;
          levelSel.addEventListener('change', rdNewText);
        }
      }

      function rdSetTab(tab) {
        rd.tab = tab;
        rdRenderTabs();
        if (tab === 'files') {
          rdEl('glReadingWorkspace').style.display = 'none';
          rdEl('glReadingEnd').style.display = 'none';
          rdRenderFilesPanel(true);
          return;
        }
        rdRenderFilesPanel(false);
        rdEl('glReadingWorkspace').style.display = '';
        if (tab === 'weak') {
          rdLoadSet(RD_WEAK_SET);
        } else {
          rdLoadSet(RD_SETS[rd.setIndex % RD_SETS.length]);
        }
        rdEl('glReadingEnd').style.display = 'none';
        rdRenderText();
        rdRenderQuestion();
      }

      function rdRenderTabs() {
        document.querySelectorAll('.gl-reading-tab').forEach(function (btn) {
          var active = btn.getAttribute('data-reading-tab') === rd.tab;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      }

      function rdNewText() {
        if (rd.tab === 'files') return;
        rd.setIndex++;
        if (rd.tab === 'weak') {
          rdLoadSet(RD_WEAK_SET);
        } else {
          rdLoadSet(RD_SETS[rd.setIndex % RD_SETS.length]);
        }
        rdEl('glReadingEnd').style.display = 'none';
        rdEl('glReadingWorkspace').style.display = '';
        rdRenderText();
        rdRenderQuestion();
      }

      function rdRenderText() {
        var panel = rdEl('glReadingTextPanel');
        if (!panel || !rd.passage) return;
        var q = rd.questions[rd.index];
        var evidenceMode = q && q.type === 'evidence' && !rd.answers[rd.index];
        var html =
          '<div class="gl-reading-text-eyebrow">Reading</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(rd.passage.title) + '</h3>' +
          '<p class="gl-reading-text-meta">' + _glEscape(rd.passage.meta) +
          (rd.isSample ? ' <span class="gl-reading-sample-badge">Sample practice</span>' : '') + '</p>' +
          '<div class="gl-reading-text-body">' +
          rd.passage.paragraphs.map(function (para, pIdx) {
            var sentences = rdSentences(para).map(function (s, sIdx) {
              var cls = 'gl-reading-sentence';
              if (evidenceMode) cls += ' gl-evidence-clickable';
              return '<span class="' + cls + '" data-p="' + pIdx + '" data-s="' + sIdx + '">' + _glEscape(s) + '</span>';
            }).join('');
            return '<p data-para="' + pIdx + '">' + sentences + '</p>';
          }).join('') +
          '</div>';
        panel.innerHTML = html;

        if (evidenceMode) {
          panel.querySelectorAll('.gl-reading-sentence').forEach(function (span) {
            span.addEventListener('click', function () {
              rdCheckEvidenceClick(span.textContent);
            });
          });
        }
      }

      function rdFindSentenceSpan(needle) {
        var spans = document.querySelectorAll('#glReadingTextPanel .gl-reading-sentence');
        var target = null;
        spans.forEach(function (span) {
          if (!target && span.textContent.indexOf(needle) !== -1) target = span;
        });
        return target;
      }

      function rdShowEvidence(evidenceText, persistent) {
        var span = rdFindSentenceSpan(evidenceText);
        if (!span) return;
        // Scroll only the reading-text container, never the ancestor page —
        // span.scrollIntoView() would otherwise walk up through every
        // scrollable ancestor (including the portal shell) and yank the
        // whole page along with it.
        var container = rdEl('glReadingTextPanel');
        if (container) {
          var cRect = container.getBoundingClientRect();
          var sRect = span.getBoundingClientRect();
          var delta = (sRect.top - cRect.top) - (container.clientHeight / 2) + (sRect.height / 2);
          container.scrollBy({ top: delta, behavior: 'smooth' });
        }
        // Never accumulate more than one bright/settled highlight at a time.
        container && container.querySelectorAll('.gl-evidence-flash, .gl-evidence-settled').forEach(function (el) {
          if (el !== span) el.classList.remove('gl-evidence-flash', 'gl-evidence-settled');
        });
        span.classList.add('gl-evidence-flash');
        setTimeout(function () {
          span.classList.remove('gl-evidence-flash');
          if (persistent !== false) span.classList.add('gl-evidence-settled');
        }, 900);
      }

      function rdQState(idx) {
        var a = rd.answers[idx];
        if (!a) return 'unanswered';
        return a.status; // 'correct' | 'review' | 'answered'
      }

      function rdCheckEvidenceClick(sentenceText) {
        var q = rd.questions[rd.index];
        if (rd.answers[rd.index]) return;
        var correct = sentenceText.indexOf(q.evidence) !== -1;
        rd.answers[rd.index] = { status: correct ? 'correct' : 'review', selected: sentenceText };
        rdRenderText();
        rdRenderQuestion();
      }

      function rdOptionMark(letter, state) {
        if (state === 'correct') return '✓';
        if (state === 'incorrect') return '✕';
        return letter;
      }

      function rdRenderQuestion() {
        var panel = rdEl('glReadingQuestionPanel');
        if (!panel || !rd.questions.length) return;
        var q = rd.questions[rd.index];
        var answer = rd.answers[rd.index];
        var total = rd.questions.length;
        var pct = Math.round(((rd.index + 1) / total) * 100);
        var stateClass = rdQState(rd.index);

        var body = '';
        if (q.type === 'mc' || q.type === 'meaning') {
          var opts = ['A', 'B', 'C', 'D'].filter(function (l) { return q.options[l]; });
          body =
            '<div class="gl-reading-options">' +
            opts.map(function (letter) {
              var state = '';
              if (answer) {
                if (letter === q.answer) state = 'gl-correct';
                else if (letter === answer.selected) state = 'gl-incorrect';
              }
              return '<button type="button" class="gl-reading-option ' + state + '" data-opt="' + letter + '"' + (answer ? ' disabled' : '') + '>' +
                '<span class="gl-reading-opt-mark">' + rdOptionMark(letter, state === 'gl-correct' ? 'correct' : state === 'gl-incorrect' ? 'incorrect' : '') + '</span>' +
                '<span>' + _glRenderMath(q.options[letter]) + '</span></button>';
            }).join('') +
            '</div>';
        } else if (q.type === 'tf') {
          var tfOpts = ['True', 'False', 'Not stated'];
          body =
            '<div class="gl-reading-options">' +
            tfOpts.map(function (opt) {
              var state = '';
              if (answer) {
                if (opt === q.answer) state = 'gl-correct';
                else if (opt === answer.selected) state = 'gl-incorrect';
              }
              return '<button type="button" class="gl-reading-option ' + state + '" data-opt="' + opt + '"' + (answer ? ' disabled' : '') + '>' +
                '<span class="gl-reading-opt-mark"></span><span>' + opt + '</span></button>';
            }).join('') +
            '</div>';
        } else if (q.type === 'evidence') {
          body = answer
            ? '<div class="gl-reading-evidence-hint">Selected: “' + _glEscape(answer.selected.trim()) + '”</div>'
            : '<div class="gl-reading-evidence-hint">Click the sentence in the reading text that answers this question.</div>';
        } else if (q.type === 'short') {
          body =
            '<input type="text" class="gl-reading-short-input" id="glReadingShortInput" placeholder="Type your answer..."' +
            (answer ? ' disabled value="' + _glEscape(answer.selected || '') + '"' : '') + '>';
        } else if (q.type === 'match') {
          var usedElsewhere = {};
          rd.passage.paragraphs.forEach(function (_, pIdx) {
            var c = rd.matchChoices[pIdx];
            if (c !== undefined && c !== '') usedElsewhere[c] = (usedElsewhere[c] || 0) + 1;
          });
          body =
            '<div class="gl-reading-match-hint">Assign each heading once — already-used headings are marked below.</div>' +
            '<div class="gl-reading-match-list">' +
            rd.passage.paragraphs.map(function (_, pIdx) {
              var chosen = rd.matchChoices[pIdx];
              var isRight = answer && Number(chosen) === q.answer[pIdx];
              return '<div class="gl-reading-match-row">' +
                '<span>P' + (pIdx + 1) + '</span>' +
                '<select data-match-p="' + pIdx + '"' + (answer ? ' disabled' : '') +
                ' style="' + (answer ? (isRight ? 'border-color:#22c55e' : 'border-color:#f87171') : '') + '">' +
                '<option value="">Choose heading…</option>' +
                q.headings.map(function (h, hIdx) {
                  var usedByOther = usedElsewhere[String(hIdx)] && String(chosen) !== String(hIdx);
                  return '<option value="' + hIdx + '"' + (String(chosen) === String(hIdx) ? ' selected' : '') + '>' +
                    _glEscape(h) + (usedByOther ? ' (used)' : '') + '</option>';
                }).join('') +
                '</select></div>';
            }).join('') +
            '</div>';
        }

        var checkDisabled = !!answer;
        if (!answer) {
          if (q.type === 'mc' || q.type === 'tf' || q.type === 'meaning') checkDisabled = true; // enabled once an option is clicked (handled below via re-render)
          if (q.type === 'match') checkDisabled = false;
          if (q.type === 'short' || q.type === 'evidence') checkDisabled = true;
        }
        // mc/tf/meaning: allow check once a pending selection exists
        var pendingSelected = rd._pendingSelected && rd._pendingIndex === rd.index ? rd._pendingSelected : null;
        if (!answer && (q.type === 'mc' || q.type === 'tf' || q.type === 'meaning')) {
          checkDisabled = !pendingSelected;
        }
        if (!answer && q.type === 'short') checkDisabled = false;

        var feedbackHtml = '';
        if (answer) {
          var isCorrect = answer.status === 'correct';
          feedbackHtml =
            '<div class="gl-reading-feedback ' + (isCorrect ? 'gl-fb-correct' : 'gl-fb-incorrect') + '">' +
            '<div class="gl-reading-feedback-title">' + (isCorrect ? '✓ Correct' : 'Not quite.') + '</div>' +
            (!isCorrect && answer.selectedLabel
              ? '<div class="gl-reading-feedback-line">Your answer:<br><strong>' + _glEscape(answer.selectedLabel) + '</strong></div>' +
                '<div class="gl-reading-feedback-line">Correct answer:<br><strong>' + _glEscape(answer.correctLabel || '') + '</strong></div>'
              : '') +
            '<div class="gl-reading-feedback-line">' + _glEscape(q.explanation || '') + '</div>' +
            (!isCorrect && q.wrongWhy && answer.selected && q.wrongWhy[answer.selected]
              ? '<div class="gl-reading-feedback-why">Why ' + _glEscape(answer.selected) + ' is wrong: ' + _glEscape(q.wrongWhy[answer.selected]) + '</div>'
              : '') +
            (q.evidence ? '<button type="button" class="gl-reading-evidence-btn" id="glReadingEvidenceBtn">Show evidence in text</button>' : '') +
            '</div>';
        }

        panel.innerHTML =
          '<div class="gl-reading-q-progress-label">' +
          '<span>Question ' + (rd.index + 1) + ' / ' + total + '</span>' +
          '<span class="gl-reading-q-state ' + stateClass + '">' + stateClass + '</span>' +
          '</div>' +
          '<div class="gl-reading-q-progress-track"><div class="gl-reading-q-progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="gl-reading-q-category">' + _glEscape(q.category) + '</div>' +
          '<div class="gl-reading-q-prompt">' + _glRenderMath(q.prompt) + '</div>' +
          body +
          '<div id="glReadingHintBox"></div>' +
          feedbackHtml +
          '<div class="gl-reading-actions">' +
          '<button type="button" class="gl-reading-hint-btn" id="glReadingHintBtn"' + (answer ? ' disabled' : '') + '>Give me a hint</button>' +
          (q.type === 'evidence' && !answer
            ? ''
            : '<button type="button" class="gl-reading-check-btn" id="glReadingCheckBtn"' + (checkDisabled ? ' disabled' : '') + '>' + (answer ? 'Answered' : 'Check answer →') + '</button>') +
          '</div>' +
          '<div class="gl-reading-nav">' +
          '<button type="button" class="gl-reading-nav-btn" id="glReadingPrevBtn"' + (rd.index === 0 ? ' disabled' : '') + '>← Previous</button>' +
          '<span class="gl-reading-nav-count">' + (rd.index + 1) + ' / ' + total + '</span>' +
          '<button type="button" class="gl-reading-nav-btn" id="glReadingNextBtn">Next →</button>' +
          '</div>';

        if (rd.hintShown[rd.index]) {
          var hb = rdEl('glReadingHintBox');
          if (hb) hb.innerHTML = '<div class="gl-reading-hint-box">' + _glEscape(rdHintFor(q)) + '</div>';
        }

        rdWireQuestionEvents(q, answer);
      }

      function rdHintFor(q) {
        if (q.type === 'match') return 'Read each paragraph’s first sentence — it usually signals the paragraph’s main idea.';
        if (q.evidence) {
          var words = q.evidence.split(' ').filter(function (w) { return w.length > 4; });
          return 'Look for a sentence mentioning "' + (words[0] || q.evidence.split(' ')[0]) + '".';
        }
        return 'Re-read the paragraph that introduces this topic before choosing.';
      }

      function rdWireQuestionEvents(q, answer) {
        var hintBtn = rdEl('glReadingHintBtn');
        if (hintBtn) hintBtn.addEventListener('click', function () {
          rd.hintShown[rd.index] = true;
          var hb = rdEl('glReadingHintBox');
          if (hb) hb.innerHTML = '<div class="gl-reading-hint-box">' + _glEscape(rdHintFor(q)) + '</div>';
        });

        if (!answer && (q.type === 'mc' || q.type === 'tf' || q.type === 'meaning')) {
          document.querySelectorAll('#glReadingQuestionPanel .gl-reading-option').forEach(function (btn) {
            btn.addEventListener('click', function () {
              rd._pendingSelected = btn.getAttribute('data-opt');
              rd._pendingIndex = rd.index;
              document.querySelectorAll('#glReadingQuestionPanel .gl-reading-option').forEach(function (b) {
                b.classList.toggle('gl-selected', b === btn);
              });
              var checkBtn = rdEl('glReadingCheckBtn');
              if (checkBtn) checkBtn.disabled = false;
            });
          });
        }

        if (q.type === 'match' && !answer) {
          document.querySelectorAll('[data-match-p]').forEach(function (sel) {
            sel.addEventListener('change', function () {
              rd.matchChoices[sel.getAttribute('data-match-p')] = sel.value;
              // Re-render so "(used)" markers on other rows' options stay
              // in sync — cheap since only this question's DOM is rebuilt.
              rdRenderQuestion();
            });
          });
        }

        var checkBtn = rdEl('glReadingCheckBtn');
        if (checkBtn && !answer) checkBtn.addEventListener('click', rdCheckAnswer);

        var evBtn = rdEl('glReadingEvidenceBtn');
        if (evBtn) evBtn.addEventListener('click', function () { rdShowEvidence(q.evidence); });

        var prevBtn = rdEl('glReadingPrevBtn');
        if (prevBtn) prevBtn.addEventListener('click', function () { rdGoTo(-1); });
        var nextBtn = rdEl('glReadingNextBtn');
        if (nextBtn) nextBtn.addEventListener('click', function () { rdGoTo(1); });
      }

      async function rdCheckAnswer() {
        var q = rd.questions[rd.index];
        if (q.type === 'short') {
          // Pin which question this grading call belongs to — the AI round
          // trip below can outlive the user clicking Next/Previous, and a
          // late result must land on the question it actually graded, not
          // wherever rd.index happens to be when the response arrives.
          var qIndex = rd.index;
          var input = rdEl('glReadingShortInput');
          var val = input ? input.value.trim() : '';
          if (!val) return;
          var lower = val.toLowerCase();
          var keywordHit = (q.keywords || []).some(function (kw) { return lower.indexOf(kw) !== -1; });
          if (keywordHit) {
            rd.answers[qIndex] = { status: 'correct', selected: val, selectedLabel: val, correctLabel: null };
            rd._pendingSelected = null;
            if (rd.index === qIndex) { rdRenderText(); rdRenderQuestion(); }
            return;
          }
          // No literal keyword overlap — don't fail a semantically correct
          // answer just because it's phrased differently. Reuse the same
          // /api/ai chat endpoint already used elsewhere in this file
          // (_glAskAboutFile, from-my-files generation) rather than building
          // a second grading path.
          var checkBtn = rdEl('glReadingCheckBtn');
          if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = 'Checking…'; }
          if (input) input.disabled = true;
          var isCorrect = false;
          try {
            var resp = await _authFetch(BACKEND_URL + '/api/ai', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 5,
                system: 'You grade a short reading-comprehension answer on meaning, not exact wording or language. Reply with exactly one word: YES or NO.',
                messages: [{
                  role: 'user',
                  content: 'Question: ' + q.prompt +
                    '\nModel answer: ' + (q.explanation || '') +
                    '\nStudent answer: ' + val +
                    '\nDoes the student answer convey the same core meaning as the model answer?'
                }]
              })
            });
            var data = resp.ok ? await resp.json() : null;
            var text = (data && data.content ? data.content.map(function (b) { return b.text || ''; }).join('') : '').trim().toUpperCase();
            isCorrect = text.indexOf('YES') === 0;
          } catch (e) {
            isCorrect = false; // fail closed to "needs review", never silently marks a wrong answer correct
          }
          rd.answers[qIndex] = { status: isCorrect ? 'correct' : 'review', selected: val, selectedLabel: val, correctLabel: null };
          if (rd.index === qIndex) {
            rd._pendingSelected = null;
            rdRenderText();
            rdRenderQuestion();
          }
          return;
        }
        if (q.type === 'mc' || q.type === 'meaning') {
          var sel = rd._pendingSelected;
          if (!sel) return;
          var correct = sel === q.answer;
          rd.answers[rd.index] = {
            status: correct ? 'correct' : 'review',
            selected: sel,
            selectedLabel: sel + ' — ' + q.options[sel],
            correctLabel: q.answer + ' — ' + q.options[q.answer]
          };
        } else if (q.type === 'tf') {
          var selTf = rd._pendingSelected;
          if (!selTf) return;
          var correctTf = selTf === q.answer;
          rd.answers[rd.index] = { status: correctTf ? 'correct' : 'review', selected: selTf, selectedLabel: selTf, correctLabel: q.answer };
        } else if (q.type === 'match') {
          var allRight = rd.passage.paragraphs.every(function (_, pIdx) {
            return Number(rd.matchChoices[pIdx]) === q.answer[pIdx];
          });
          var allFilled = rd.passage.paragraphs.every(function (_, pIdx) { return rd.matchChoices[pIdx] !== undefined && rd.matchChoices[pIdx] !== ''; });
          if (!allFilled) return;
          rd.answers[rd.index] = { status: allRight ? 'correct' : 'review', selected: null, selectedLabel: null, correctLabel: null };
        } else {
          return;
        }
        rd._pendingSelected = null;
        rdRenderText();
        rdRenderQuestion();
      }

      function rdGoTo(delta) {
        var next = rd.index + delta;
        if (next < 0) return;
        rd._pendingSelected = null;
        if (next >= rd.questions.length) {
          rdShowEnd();
          return;
        }
        rd.index = next;
        rdRenderText();
        rdRenderQuestion();
      }

      function rdShowEnd() {
        rd.done = true;
        var total = rd.questions.length;
        var correctCount = 0;
        var byCat = {};
        RD_CATEGORIES.forEach(function (c) { byCat[c] = { correct: 0, total: 0 }; });
        rd.questions.forEach(function (q, idx) {
          var a = rd.answers[idx];
          if (!byCat[q.category]) byCat[q.category] = { correct: 0, total: 0 };
          byCat[q.category].total++;
          if (a && a.status === 'correct') {
            correctCount++;
            byCat[q.category].correct++;
          }
        });
        var pct = total ? Math.round((correctCount / total) * 100) : 0;
        var weakest = null;
        Object.keys(byCat).forEach(function (cat) {
          var c = byCat[cat];
          if (c.total > 0 && (weakest === null || (c.correct / c.total) < (byCat[weakest].correct / byCat[weakest].total))) {
            weakest = cat;
          }
        });

        var end = rdEl('glReadingEnd');
        rdEl('glReadingWorkspace').style.display = 'none';
        end.style.display = '';
        end.innerHTML =
          '<h3 class="gl-reading-end-title">Reading complete</h3>' +
          '<div class="gl-reading-end-score">' + correctCount + ' / ' + total + ' correct</div>' +
          '<div class="gl-reading-end-pct">' + pct + '%</div>' +
          '<div class="gl-reading-breakdown">' +
          Object.keys(byCat).filter(function (c) { return byCat[c].total > 0; }).map(function (cat) {
            var c = byCat[cat];
            return '<div class="gl-reading-breakdown-row"><span>' + _glEscape(cat) + '</span><b>' + c.correct + '/' + c.total + '</b></div>';
          }).join('') +
          '</div>' +
          (weakest ? '<div class="gl-reading-recommend">Recommended next: <b>Practice ' + _glEscape(weakest.toLowerCase()) + ' questions</b></div>' : '') +
          '<div class="gl-reading-end-actions">' +
          '<button type="button" class="gl-reading-end-btn" id="glReadingPracticeWeakBtn">Practice weak area</button>' +
          '<button type="button" class="gl-reading-end-btn gl-reading-end-btn-primary" id="glReadingNewTextBtn">New text</button>' +
          '</div>';

        var weakBtn = rdEl('glReadingPracticeWeakBtn');
        if (weakBtn) weakBtn.addEventListener('click', function () {
          // Target the category that was actually weakest this session
          // (e.g. Inference 0/2) instead of always restarting the same
          // generic weak-areas sample set.
          rd.tab = 'weak';
          rdRenderTabs();
          rdRenderFilesPanel(false);
          rdEl('glReadingWorkspace').style.display = '';
          rdEl('glReadingEnd').style.display = 'none';
          rdLoadSet(rdWeakSetForCategory(weakest), true);
          rdRenderText();
          rdRenderQuestion();
        });
        var newBtn = rdEl('glReadingNewTextBtn');
        if (newBtn) newBtn.addEventListener('click', rdNewText);
      }

      // Pulls the questions matching `category` from whichever sample passage
      // has the most of them, so the follow-up session stays evidence-
      // consistent (every question's `evidence` string must exist in the
      // SAME passage that's loaded). Falls back to the generic weak set if
      // nothing matches.
      function rdWeakSetForCategory(category) {
        if (!category) return RD_WEAK_SET;
        var best = null;
        var bestCount = 0;
        RD_SETS.forEach(function (set) {
          var matches = set.questions.filter(function (q) { return q.category === category; });
          if (matches.length > bestCount) {
            bestCount = matches.length;
            best = { passage: set.passage, questions: matches };
          }
        });
        return best || RD_WEAK_SET;
      }

      // ── From my files ────────────────────────────────────────────────────
      async function rdRenderFilesPanel(active) {
        var wrap = rdEl('glReadingFilesPanel');
        if (!wrap) return;
        wrap.style.display = active ? '' : 'none';
        if (!active) return;

        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        wrap.innerHTML = '<div class="gl-reading-empty">Loading your files…</div>';
        if (!uid) {
          wrap.innerHTML = '<div class="gl-reading-empty">Sign in to use your uploaded German files.</div>';
          return;
        }
        var course = _glStorageCourse();
        if (!course.files) course.files = [];
        try { await _ufMerge(course); } catch (e) { /* ignore */ }
        var files = course.files || [];

        var listHtml = files.length
          ? files.map(function (f) {
              return '<label class="gl-rd-file-row" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);margin-bottom:6px">' +
                '<input type="radio" name="glReadingFile" value="' + _glEscape(f.name || f.file_name) + '">' +
                '<span style="flex:1;font-size:.82rem;font-weight:700;color:rgba(255,255,255,.8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _glEscape(f.name || f.file_name || 'German file') + '</span>' +
                '</label>';
            }).join('')
          : '<div class="gl-reading-empty">No German files uploaded yet. Use Upload German file from another skill, or upload one below.</div>';

        wrap.innerHTML =
          '<h3 class="widget-title" style="margin:0 0 10px">Choose a file to turn into a reading exercise</h3>' +
          '<div id="glReadingFileList">' + listHtml + '</div>' +
          '<div class="gl-reading-files-config">' +
          '<label>Questions<select id="glReadingCfgCount"><option>3</option><option selected>5</option><option>8</option></select></label>' +
          '<label>Difficulty<select id="glReadingCfgLevel"><option>A1</option><option>A2</option><option>B1</option><option selected>B2</option><option>C1</option></select></label>' +
          '<label>Question mix<select id="glReadingCfgMix"><option selected>Mixed</option><option>Multiple choice only</option><option>Focus on inference</option></select></label>' +
          '<button type="button" class="gl-reading-start-btn" id="glReadingStartBtn">Start reading</button>' +
          '</div>';

        var startBtn = rdEl('glReadingStartBtn');
        if (startBtn) startBtn.addEventListener('click', function () { rdStartFromFile(files); });
      }

      async function rdStartFromFile(files) {
        var chosen = document.querySelector('input[name="glReadingFile"]:checked');
        if (!chosen) {
          if (typeof showToast === 'function') showToast('Choose a file', 'Select one of your uploaded German files first.');
          return;
        }
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        var fname = chosen.value;
        var level = rdEl('glReadingCfgLevel') ? rdEl('glReadingCfgLevel').value : 'B2';
        var count = rdEl('glReadingCfgCount') ? rdEl('glReadingCfgCount').value : '5';
        var startBtn = rdEl('glReadingStartBtn');
        // Baseline token: if the user navigates away/resets before this
        // resolves, rd.genToken moves on and the stale result below is
        // discarded instead of clobbering whatever the user is doing now.
        var myToken = rd.genToken;
        if (startBtn) { startBtn.disabled = true; }
        var configRow = document.querySelector('.gl-reading-files-config');
        var loadingEl = document.createElement('div');
        loadingEl.className = 'gl-reading-generating';
        loadingEl.innerHTML = '<span class="gl-reading-spinner" aria-hidden="true"></span><span>Preparing your reading exercise from "' + _glEscape(fname) + '"…</span>';
        if (configRow && configRow.parentNode) configRow.parentNode.appendChild(loadingEl);

        try {
          var bytes = await _ufFetchBytes(uid, _glStorageCourse(), fname);
          var ext = (fname.split('.').pop() || '').toLowerCase();
          var messageContent;
          if (ext === 'pdf') {
            var b64 = '';
            var chunkSize = 8192;
            for (var i = 0; i < bytes.length; i += chunkSize) {
              b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            b64 = btoa(b64);
            messageContent = [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
              { type: 'text', text: rdGeneratePrompt(level, count) }
            ];
          } else if (['txt', 'md'].includes(ext)) {
            var textContent = new TextDecoder().decode(bytes);
            messageContent = [{ type: 'text', text: 'DOCUMENT CONTENT:\n' + textContent + '\n\n' + rdGeneratePrompt(level, count) }];
          } else {
            if (typeof showToast === 'function') showToast('Unsupported file', 'Only PDF and text files can be turned into a reading exercise right now.');
            return;
          }

          var resp = await _authFetch(BACKEND_URL + '/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 2000,
              system: 'You are a German reading-comprehension exercise generator. Reply with ONLY valid JSON, no markdown fences, no commentary.',
              messages: [{ role: 'user', content: messageContent }]
            })
          });
          if (!resp.ok) throw new Error('http-' + resp.status);
          var data = await resp.json();
          var text = data.content ? data.content.map(function (b) { return b.text || ''; }).join('') : '';
          var parsed = rdParseGenerated(text);
          if (!parsed) throw new Error('parse-failed');

          // Someone navigated/reset/started a different generation while we
          // were waiting — this result is stale, drop it silently rather
          // than overwriting whatever session is now live.
          if (myToken !== rd.genToken) return;

          rd.setIndex = -1; // "New text" after a file-based set should fall back to the sample pool
          rdLoadSet(parsed, false);
          rd.tab = 'practice';
          rdRenderTabs();
          rdRenderFilesPanel(false);
          rdEl('glReadingWorkspace').style.display = '';
          rdEl('glReadingEnd').style.display = 'none';
          rdRenderText();
          rdRenderQuestion();
        } catch (e) {
          console.error('Lesen from-my-files generation failed:', e);
          if (myToken === rd.genToken && typeof showToast === 'function') {
            showToast('Couldn’t create a reading exercise', 'Couldn’t create a reading exercise from this file. Try again.');
          }
        } finally {
          if (startBtn) startBtn.disabled = false;
          if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
        }
      }

      function rdGeneratePrompt(level, count) {
        return 'Based on this document, extract or write a German reading passage (preserve the original meaning, do not just summarise) suitable for level ' + level +
          '. Then create ' + count + ' comprehension questions of mixed types. Reply with ONLY this JSON shape, no other text: ' +
          '{"title":"...","meta":"' + level + ' · From your file","paragraphs":["...","..."],' +
          '"questions":[{"type":"mc","category":"Finding explicit information","prompt":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"A","explanation":"...","evidence":"exact sentence fragment copied from a paragraph above"}]}. ' +
          'Valid "type" values: mc, tf (answer one of "True"/"False"/"Not stated"), short (include a "keywords" array instead of options/answer), meaning (same shape as mc). Every question needs an "evidence" field that is an exact, verbatim substring of one of the paragraphs.';
      }

      var RD_VALID_TYPES = { mc: 1, tf: 1, short: 1, meaning: 1, evidence: 1, match: 1 };

      // A generated exercise that's merely valid JSON but structurally broken
      // (missing options, an evidence string that isn't actually in the
      // passage, an unsupported type) would render a half-working quiz
      // instead of failing loudly — reject it here so the caller shows the
      // "couldn't create an exercise" toast instead.
      function rdValidateGenerated(obj) {
        if (!obj || !Array.isArray(obj.paragraphs) || !obj.paragraphs.length) return false;
        if (!Array.isArray(obj.questions) || !obj.questions.length) return false;
        var joined = obj.paragraphs.join(' ');
        return obj.questions.every(function (q) {
          if (!q || !RD_VALID_TYPES[q.type] || typeof q.prompt !== 'string' || !q.prompt.trim()) return false;
          if (q.type === 'mc' || q.type === 'meaning') {
            if (!q.options || !q.answer || !q.options[q.answer]) return false;
          }
          if (q.type === 'tf' && ['True', 'False', 'Not stated'].indexOf(q.answer) === -1) return false;
          if (q.type === 'short' && (!Array.isArray(q.keywords) || !q.keywords.length)) return false;
          if (q.type === 'match' && (!Array.isArray(q.headings) || !Array.isArray(q.answer) || q.headings.length !== obj.paragraphs.length)) return false;
          // Every evidence-bearing question must point at real text, or
          // "Show evidence in text" would silently do nothing.
          if (q.evidence && joined.indexOf(q.evidence) === -1) return false;
          if (q.type === 'evidence' && !q.evidence) return false;
          return true;
        });
      }

      function rdParseGenerated(text) {
        try {
          var cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
          var obj = JSON.parse(cleaned);
          if (!rdValidateGenerated(obj)) return null;
          return { passage: { title: obj.title || 'Reading passage', meta: obj.meta || 'From your file', paragraphs: obj.paragraphs }, questions: obj.questions };
        } catch (e) {
          return null;
        }
      }
    })();

    // ── Grammatik (interactive sentence-building/correction) ─────────────────
    // Dedicated workspace, distinct from the generic quiz/cards template and
    // from Lesen's reading layout — a sentence-builder/corrector, not another
    // quiz generator. Lives entirely inside #glGrammarView (see practice.html)
    // and is only mounted when _glOpenSkill('grammar') runs.
    (function () {
      var GM_TOPICS = [
        { id: 'verbPosition', label: 'Verb position' },
        { id: 'cases', label: 'Cases' },
        { id: 'articles', label: 'Articles' },
        { id: 'prepositions', label: 'Prepositions' },
        { id: 'adjectiveEndings', label: 'Adjective endings' },
        { id: 'konjunktivII', label: 'Konjunktiv II' },
        { id: 'passive', label: 'Passive' },
        { id: 'relativeClauses', label: 'Relative clauses' },
        { id: 'connectors', label: 'Connectors' },
        { id: 'tenses', label: 'Tenses' },
        { id: 'pronouns', label: 'Pronouns' },
        { id: 'verbPrep', label: 'Verb-preposition combinations' }
      ];
      var GM_TOPICS_C1 = [
        { id: 'nominalisation', label: 'Nominalisierung' },
        { id: 'partizip', label: 'Partizipialattribute' },
        { id: 'indirectSpeech', label: 'Indirect speech / Konjunktiv I' },
        { id: 'advConnectors', label: 'Advanced connectors' }
      ];
      var GM_ALL_TOPICS = GM_TOPICS.concat(GM_TOPICS_C1);

      var GM_BANK = {
        verbPosition: [
          { type: 'order', words: ['weil', 'ich', 'heute', 'lernen', 'muss'], answer: 'weil ich heute lernen muss',
            rule: { focus: 'Verb position', think: 'Where does the conjugated verb go after "weil"?', why: '"weil" introduces a subordinate clause, so the conjugated verb moves to the end.', mainRule: 'weil + subject + ... + conjugated verb', example: 'Ich bleibe zu Hause, weil ich morgen arbeiten muss.' },
            hints: ['The word "weil" changes the sentence structure.', 'Look at the position of the conjugated verb — it goes last.'] },
          { type: 'gap', promptHtml: 'Obwohl er sehr müde ___, arbeitet er weiter.', accepted: ['ist'],
            rule: { focus: 'Verb position after obwohl', think: '"obwohl" also introduces a subordinate clause.', why: '"obwohl" introduces a subordinate clause, so the conjugated verb moves to the end of it.', mainRule: 'obwohl + subject + ... + conjugated verb', example: 'Obwohl es regnet, gehen wir spazieren.' },
            hints: ['"obwohl" behaves like "weil" for word order.', 'The verb "sein" (conjugated as "ist") belongs at the end of this clause.'] },
          { type: 'correct', sentenceWrong: 'Ich habe gestern ein neues Buch gekauft, weil ich brauche es für die Universität.',
            accepted: ['ich habe gestern ein neues buch gekauft weil ich es für die universität brauche'],
            highlightCorrect: '...weil ich es für die Universität <strong>brauche</strong>.',
            rule: { focus: 'Verb position', think: 'What is wrong after "weil"?', why: 'In a subordinate clause introduced by "weil", the conjugated verb moves to the end.', mainRule: 'weil + subject + ... + conjugated verb', example: 'Ich bin müde, weil ich schlecht geschlafen habe.' },
            hints: ['Look at where "brauche" sits in the sentence.', 'After "weil", the verb has to move all the way to the end of the clause.'] }
        ],
        cases: [
          { type: 'choice', promptHtml: 'Ich fahre mit ___ neuen Auto meines Bruders.', options: ['der', 'die', 'dem', 'den'], answerIndex: 2,
            logic: ['mit → always Dativ', 'das Auto → Dativ singular = dem Auto', 'adjective: dem neuen Auto'],
            rule: { focus: 'Cases after mit', think: '"mit" always takes which case?', why: '"mit" is a fixed dative preposition, so the article and adjective ending both take the dative form.', mainRule: 'mit + Dativ', example: 'Ich spreche mit dem Mann.' },
            hints: ['"mit" never changes case — it is always the same one.', 'Dative for "das Auto" (neuter) is "dem Auto".'] },
          { type: 'gap', promptHtml: 'Ich helfe ___ Frau (die Frau) mit dem Koffer.', accepted: ['der'],
            rule: { focus: 'Cases after helfen', think: '"helfen" always takes which case?', why: '"helfen" is a fixed dative verb.', mainRule: 'helfen + Dativ', example: 'Ich helfe dem Kind.' },
            hints: ['"helfen" behaves like "mit" — it always takes the same case.', 'Dative for "die Frau" (feminine) is "der Frau".'] }
        ],
        articles: [
          { type: 'choice', promptHtml: 'Ich kaufe ___ Apfel (der Apfel).', options: ['der', 'den', 'dem', 'die'], answerIndex: 1,
            logic: ['kaufen + Akkusativ (direct object)', 'der Apfel → Akkusativ = den Apfel'],
            rule: { focus: 'Articles in the accusative', think: 'What case does a direct object take?', why: 'The thing being bought is the direct object, so it takes the accusative case.', mainRule: 'Subjekt + Verb + Akkusativobjekt', example: 'Ich kaufe den Apfel.' },
            hints: ['Ask: what am I buying? That is the direct object.', 'Masculine "der" becomes "den" in the accusative.'] }
        ],
        prepositions: [
          { type: 'choice', promptHtml: 'Ich interessiere mich ___ deutsche Geschichte.', options: ['an', 'auf', 'für', 'mit'], answerIndex: 2,
            pattern: ['sich interessieren', 'für', 'Akkusativ'],
            rule: { focus: 'Verb-preposition combination', think: '"sich interessieren" is always followed by which preposition?', why: '"sich interessieren für + Akkusativ" is a fixed combination — it has to be learned as a unit.', mainRule: 'sich interessieren für + Akkusativ', example: 'Ich interessiere mich für deutsche Geschichte.' },
            hints: ['This is a fixed expression — the preposition never changes.', 'Think: "interested IN" in English maps to "für" here.'] },
          { type: 'choice', promptHtml: 'Ich warte ___ den Bus.', options: ['auf', 'für', 'mit', 'bei'], answerIndex: 0,
            pattern: ['warten', 'auf', 'Akkusativ'],
            rule: { focus: 'Verb-preposition combination', think: '"warten" is always followed by which preposition?', why: '"warten auf + Akkusativ" is a fixed combination.', mainRule: 'warten auf + Akkusativ', example: 'Wir warten auf den Zug.' },
            hints: ['This is another fixed verb + preposition pair.', 'English "to wait FOR" maps to "auf" in German.'] }
        ],
        adjectiveEndings: [
          { type: 'gap', promptHtml: 'Ich trinke einen ___ Kaffee (stark).', accepted: ['starken'],
            rule: { focus: 'Adjective endings after ein-words', think: 'Masculine, accusative, after "einen" — which ending?', why: 'After ein-words in the accusative masculine, the adjective takes -en.', mainRule: 'einen + adjective-en + masculine noun (Akkusativ)', example: 'Ich trinke einen kalten Kaffee.' },
            hints: ['"Kaffee" is masculine — der Kaffee.', 'Masculine accusative adjective endings after ein-words are always -en.'] },
          { type: 'choice', promptHtml: 'Das ist ein ___ Auto (schnell).', options: ['schnelle', 'schnelles', 'schneller', 'schnellen'], answerIndex: 1,
            logic: ['das Auto → neuter', 'Nominativ after ein-words, neuter → -es', 'ein schnelles Auto'],
            rule: { focus: 'Adjective endings after ein-words', think: 'Neuter, nominative, after "ein" — which ending?', why: 'After ein-words in the nominative neuter, the adjective takes -es, because "ein" itself carries no gender marker there.', mainRule: 'ein + adjective-es + neuter noun (Nominativ)', example: 'Das ist ein schönes Haus.' },
            hints: ['"Auto" is neuter — das Auto.', 'When "ein" does not show the gender itself, the adjective ending has to.'] }
        ],
        konjunktivII: [
          { type: 'transform', originalLines: ['Ich habe kein Auto.', 'Deshalb fahre ich nicht nach Berlin.'], promptPrefix: 'Wenn ich ...',
            accepted: ['wenn ich ein auto hätte würde ich nach berlin fahren'], betterAnswer: 'Wenn ich ein Auto hätte, würde ich nach Berlin fahren.',
            rule: { focus: 'Konjunktiv II word order', think: 'Where does the conjugated verb go in the main clause after a "wenn" clause?', why: 'The subordinate clause takes position 1, so the conjugated verb begins the main clause immediately afterward.', mainRule: 'Wenn + Subjekt + ... + Konjunktiv-II-Verb, Verb + Subjekt + ...', example: 'Wenn ich Zeit hätte, würde ich mehr lesen.' },
            hints: ['Use "hätte" for the "wenn" clause (haben → Konjunktiv II) and "würde + Infinitiv" for the result.', 'After the comma, the verb comes first, then the subject "ich".'] },
          { type: 'transform', originalLines: ['Ich bin krank.', 'Deshalb gehe ich nicht zur Arbeit.'], promptPrefix: 'Wenn ich ...',
            accepted: ['wenn ich nicht krank wäre würde ich zur arbeit gehen'], betterAnswer: 'Wenn ich nicht krank wäre, würde ich zur Arbeit gehen.',
            rule: { focus: 'Konjunktiv II word order', think: 'How do you form Konjunktiv II of "sein"?', why: 'The subordinate clause takes position 1, so the conjugated verb begins the main clause immediately afterward.', mainRule: 'Wenn + Subjekt + ... + Konjunktiv-II-Verb, Verb + Subjekt + ...', example: 'Wenn ich mehr Geld hätte, würde ich reisen.' },
            hints: ['sein → Konjunktiv II is "wäre".', 'Remember the "nicht" and keep "würde + Infinitiv" for the main clause.'] }
        ],
        passive: [
          { type: 'gap', promptHtml: 'Das Auto ___ repariert (werden, Präsens).', accepted: ['wird'],
            rule: { focus: 'Passive with werden', think: 'What is the passive auxiliary verb in the present tense?', why: 'The passive voice is built with a conjugated form of "werden" plus the Partizip II.', mainRule: 'Subjekt + werden + ... + Partizip II', example: 'Die Tür wird geöffnet.' },
            hints: ['The passive auxiliary is "werden", not "sein".', '"Das Auto" is 3rd person singular → "wird".'] }
        ],
        relativeClauses: [
          { type: 'combine', sentenceA: 'Das ist der Mann.', sentenceB: 'Der Mann wohnt neben mir.', connector: '(Relativsatz)',
            accepted: ['das ist der mann der neben mir wohnt'], display: 'Das ist der Mann, der neben mir wohnt.',
            rule: { focus: 'Relative clauses', think: 'Which relative pronoun matches "der Mann"?', why: 'The relative pronoun matches the gender/number of its noun and takes the case of its role inside the relative clause — here it is the subject, so nominative "der".', mainRule: 'Nomen + Relativpronomen + ... + Verb', example: 'Das ist die Frau, die hier arbeitet.' },
            hints: ['"der Mann" is masculine, so the relative pronoun is also "der".', 'The conjugated verb of the relative clause goes to the end, just like after "weil".'] }
        ],
        connectors: [
          { type: 'combine', sentenceA: 'Er ist müde.', sentenceB: 'Er arbeitet weiter.', connector: 'obwohl',
            accepted: ['obwohl er müde ist arbeitet er weiter'], display: 'Obwohl er müde ist, arbeitet er weiter.',
            rule: { focus: 'Connectors: obwohl', think: 'Where does the verb go in each clause?', why: '"obwohl" introduces a subordinate clause, so its conjugated verb moves to the end; when a sentence starts with that subordinate clause, the main-clause verb comes right after the comma.', mainRule: 'Obwohl + Subjekt + ... + Verb, Verb + Subjekt + ...', example: 'Obwohl es regnet, gehen wir spazieren.' },
            hints: ['Start with "Obwohl" and put "ist" at the end of that first clause.', 'After the comma, the verb "arbeitet" comes immediately, before "er".'] },
          { type: 'gap', promptHtml: 'Er ist müde, ___ arbeitet er weiter.', accepted: ['trotzdem'],
            rule: { focus: 'Connectors: trotzdem', think: '"trotzdem" is an adverb, not a subordinating conjunction — what does that do to word order?', why: '"trotzdem" occupies position 1, which pushes the conjugated verb into position 2, directly followed by the subject.', mainRule: 'Satz 1. Trotzdem + Verb + Subjekt + ...', example: 'Es regnet. Trotzdem gehen wir spazieren.' },
            hints: ['This connector starts a new main clause, not a subordinate one.', 'It means "nevertheless" / "despite that".'] }
        ],
        tenses: [
          { type: 'choice', promptHtml: 'Gestern ___ ich ins Kino gegangen.', options: ['habe', 'bin', 'hatte', 'war'], answerIndex: 1,
            logic: ['gehen = verb of motion', 'verbs of motion use sein in the Perfekt', 'ich bin gegangen'],
            rule: { focus: 'Perfekt with sein', think: 'Does "gehen" use haben or sein in the Perfekt?', why: 'Verbs of motion or change of state (gehen, fahren, kommen, werden...) form the Perfekt with "sein".', mainRule: 'Subjekt + sein + ... + Partizip II (verbs of motion)', example: 'Ich bin nach Hause gefahren.' },
            hints: ['"gehen" describes movement from one place to another.', 'Motion verbs take "sein", not "haben".'] }
        ],
        pronouns: [
          { type: 'gap', promptHtml: 'Ich sehe ___ (der Mann) nicht.', accepted: ['ihn'],
            rule: { focus: 'Personal pronouns in the accusative', think: '"der Mann" is the direct object here — which pronoun replaces it?', why: 'Direct objects take the accusative case; the accusative form of "er" is "ihn".', mainRule: 'er → ihn (Akkusativ)', example: 'Ich kenne ihn gut.' },
            hints: ['"sehen" takes a direct object (accusative).', 'er → ihn, sie → sie, es → es in the accusative.'] }
        ],
        verbPrep: [
          { type: 'choice', promptHtml: 'Ich denke oft ___ meine Familie.', options: ['an', 'auf', 'für', 'mit'], answerIndex: 0,
            pattern: ['denken', 'an', 'Akkusativ'],
            rule: { focus: 'Verb-preposition combination', think: '"denken" is always followed by which preposition?', why: '"denken an + Akkusativ" is a fixed combination.', mainRule: 'denken an + Akkusativ', example: 'Ich denke an dich.' },
            hints: ['This is a fixed expression to memorise as a unit.', 'English "to think OF/ABOUT" maps to "an" here.'] }
        ],
        nominalisation: [
          { type: 'choice', promptHtml: 'Er kritisierte das ständige ___ (zu spät kommen).', options: ['Zuspätkommen', 'Zuspätkommt', 'Zuspätgekommen', 'Zuspätkam'], answerIndex: 0,
            logic: ['infinitive → nominalised noun', 'always neuter, always capitalised', 'zu spät kommen → das Zuspätkommen'],
            rule: { focus: 'Nominalisierung', think: 'How do you turn an infinitive into a noun?', why: 'German infinitives can be used as neuter nouns simply by capitalising them.', mainRule: 'Infinitiv → das + Infinitiv (großgeschrieben)', example: 'Das Rauchen ist hier verboten.' },
            hints: ['Nominalised infinitives are always neuter: "das ...".', 'The verb stays in its infinitive form, just capitalised.'] }
        ],
        partizip: [
          { type: 'choice', promptHtml: 'Der ___ Mann (gerade ankommen) wartet am Gleis.', options: ['ankommende', 'ankommender', 'angekommene', 'ankommend'], answerIndex: 0,
            logic: ['ankommen → Partizip I: ankommend', 'used as adjective before "der Mann" (Nominativ, maskulin)', 'der ankommende Mann'],
            rule: { focus: 'Partizipialattribute', think: 'Is the man arriving (ongoing) or already arrived?', why: 'Partizip I (-end) describes an ongoing action, used here as an adjective with regular adjective endings.', mainRule: 'Partizip I + adjective ending + Nomen', example: 'die wartenden Passagiere' },
            hints: ['"Partizip I" is the -end form and describes an action still happening.', 'It takes normal adjective endings — here, masculine nominative -e after "der".'] }
        ],
        indirectSpeech: [
          { type: 'gap', promptHtml: 'Er sagte, er ___ (sein) müde.', accepted: ['sei'],
            rule: { focus: 'Konjunktiv I in indirect speech', think: 'Formal reported speech uses Konjunktiv I, not Konjunktiv II — what is the Konjunktiv I form of "sein"?', why: 'Konjunktiv I marks reported speech in formal/written German, distancing the speaker from the claim.', mainRule: 'er/sie/es + Konjunktiv-I-Verb', example: 'Sie sagte, sie habe keine Zeit.' },
            hints: ['This is formal reported speech, so use Konjunktiv I, not "würde".', 'sein → ich sei, er/sie/es sei.'] }
        ],
        advConnectors: [
          { type: 'combine', sentenceA: 'Die Preise steigen.', sentenceB: 'Die Nachfrage sinkt nicht.', connector: 'obgleich',
            accepted: ['obgleich die preise steigen sinkt die nachfrage nicht'], display: 'Obgleich die Preise steigen, sinkt die Nachfrage nicht.',
            rule: { focus: 'Advanced connectors: obgleich', think: 'This is a more formal, written equivalent of "obwohl" — does word order change?', why: '"obgleich" behaves exactly like "obwohl": it introduces a subordinate clause, so the conjugated verb moves to the end, and the main clause verb follows immediately after the comma.', mainRule: 'Obgleich + Subjekt + ... + Verb, Verb + Subjekt + ...', example: 'Obgleich er wenig Zeit hatte, half er mir.' },
            hints: ['Treat "obgleich" exactly like "obwohl" for word order.', 'It is more common in formal/written German than in speech.'] }
        ]
      };

      var gm = {
        tab: 'practice', topic: 'verbPosition', level: 'B2',
        queue: [], index: 0, score: 0, answers: {}, hintLevel: {}, tries: {},
        orderBuilt: {}, orderPool: {}, selected: {}, _lastUser: {}
      };

      function gmEl(id) { return document.getElementById(id); }

      function gmNormalize(s) {
        return String(s == null ? '' : s).toLowerCase()
          .replace(/[.,!?;:"„“]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function gmShuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      }

      function gmWordOverlap(a, b) {
        var wa = gmNormalize(a).split(' ').filter(Boolean);
        var wb = gmNormalize(b).split(' ').filter(Boolean);
        if (!wa.length || !wb.length) return 0;
        var setB = {};
        wb.forEach(function (w) { setB[w] = (setB[w] || 0) + 1; });
        var hits = 0;
        wa.forEach(function (w) { if (setB[w] > 0) { hits++; setB[w]--; } });
        return hits / Math.max(wa.length, wb.length);
      }

      // ── per-topic accuracy, tracked locally so "Weak areas" reflects real
      // practice history instead of a static mock. ────────────────────────
      function gmStatsLoad() {
        try { return JSON.parse(localStorage.getItem('ss_gl_gram_stats') || '{}'); } catch (e) { return {}; }
      }
      function gmStatsSave(stats) {
        try { localStorage.setItem('ss_gl_gram_stats', JSON.stringify(stats)); } catch (e) { /* ignore */ }
      }
      function gmStatsRecord(topic, correct) {
        var stats = gmStatsLoad();
        if (!stats[topic]) stats[topic] = { correct: 0, total: 0 };
        stats[topic].total++;
        if (correct) stats[topic].correct++;
        gmStatsSave(stats);
      }

      function gmBuildTopicSelect() {
        var sel = gmEl('glGramTopic');
        if (!sel) return;
        var prev = gm.topic;
        var list = GM_TOPICS.concat(gm.level === 'C1' ? GM_TOPICS_C1 : []);
        sel.innerHTML = list.map(function (t) {
          return '<option value="' + t.id + '">' + _glEscape(t.label) + '</option>';
        }).join('');
        if (list.some(function (t) { return t.id === prev; })) sel.value = prev;
        else { sel.value = list[0].id; gm.topic = list[0].id; }
      }

      function gmPickExercises(topic, count) {
        var pool = (GM_BANK[topic] || []).slice();
        if (!pool.length) return [];
        var out = [];
        var i = 0;
        while (out.length < count) { out.push(pool[i % pool.length]); i++; }
        return out;
      }

      function gmStartQueue(topic, count) {
        gm.queue = gmPickExercises(topic, count || 10);
        gm.index = 0;
        gm.score = 0;
        gm.answers = {};
        gm.hintLevel = {};
        gm.tries = {};
        gm.orderBuilt = {};
        gm.orderPool = {};
        gm.selected = {};
        gm._lastUser = {};
        gmEl('glGramEnd').style.display = 'none';
        gmEl('glGramWorkspace').style.display = '';
        gmRenderExercise();
      }

      window._glOpenGrammarView = function () {
        gm.tab = 'practice';
        gmBuildTopicSelect();
        gmRenderTabs();
        gmSetTabView('practice');
        gmStartQueue(gm.topic, 10);
        gmWireHeader();
      };

      function gmWireHeader() {
        var tabsWrap = document.querySelector('.gl-gram-tabs');
        if (tabsWrap && !tabsWrap._gmWired) {
          tabsWrap._gmWired = true;
          tabsWrap.addEventListener('click', function (e) {
            var btn = e.target.closest('.gl-gram-tab');
            if (!btn) return;
            gmSetTabView(btn.getAttribute('data-gram-tab'));
          });
        }
        var topicSel = gmEl('glGramTopic');
        var levelSel = gmEl('glGramLevel');
        if (topicSel && !topicSel._gmWired) {
          topicSel._gmWired = true;
          topicSel.addEventListener('change', function () {
            gm.topic = topicSel.value;
            if (gm.tab === 'practice') gmStartQueue(gm.topic, 10);
          });
        }
        if (levelSel && !levelSel._gmWired) {
          levelSel._gmWired = true;
          levelSel.addEventListener('change', function () {
            gm.level = levelSel.value;
            gmBuildTopicSelect();
            if (gm.tab === 'practice') gmStartQueue(gm.topic, 10);
          });
        }
      }

      function gmRenderTabs() {
        document.querySelectorAll('.gl-gram-tab').forEach(function (btn) {
          var active = btn.getAttribute('data-gram-tab') === gm.tab;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      }

      function gmSetTabView(tab) {
        gm.tab = tab;
        gmRenderTabs();
        gmEl('glGramPractice').style.display = tab === 'practice' ? '' : 'none';
        gmEl('glGramWeak').style.display = tab === 'weak' ? '' : 'none';
        gmEl('glGramFiles').style.display = tab === 'files' ? '' : 'none';
        if (tab === 'practice') {
          if (!gm.queue.length) gmStartQueue(gm.topic, 10);
        } else if (tab === 'weak') {
          gmRenderWeak();
        } else if (tab === 'files') {
          gmRenderFilesPanel();
        }
      }

      function gmCurrentEx() { return gm.queue[gm.index]; }

      function gmProgress() {
        var label = gmEl('glGramProgressLabel');
        var fill = gmEl('glGramProgressFill');
        if (label) label.textContent = Math.min(gm.index + 1, gm.queue.length) + ' / ' + gm.queue.length;
        if (fill) fill.style.width = Math.round(((gm.index + (gm.answers[gm.index] ? 1 : 0)) / gm.queue.length) * 100) + '%';
      }

      function gmRenderExercise() {
        var ex = gmCurrentEx();
        if (!ex) return;
        gmProgress();
        var answer = gm.answers[gm.index];
        gmEl('glGramExercise').innerHTML = gmExerciseHtml(ex, answer);
        gmWireExercise(ex, answer);
        gmEl('glGramFeedback').innerHTML = answer ? gmFeedbackAfterHtml(ex, answer) : gmFeedbackBeforeHtml(ex);
        gmWireFeedback(ex, answer);
      }

      function gmExerciseHtml(ex, answer) {
        var idx = gm.index;
        var locked = !!answer;

        if (ex.type === 'order') {
          if (!gm.orderPool[idx] && !gm.orderBuilt[idx]) {
            gm.orderPool[idx] = gmShuffle(ex.words.slice());
            gm.orderBuilt[idx] = [];
          }
          var pool = locked ? [] : gm.orderPool[idx];
          var built = locked ? ex.answer.split(' ') : gm.orderBuilt[idx];
          var canCheck = !locked && gm.orderBuilt[idx].length === ex.words.length;
          return '<div class="gl-gram-ex-eyebrow">Put the sentence in the correct order</div>' +
            '<p class="gl-gram-ex-instruction">Arrange the words to form a correct sentence.</p>' +
            '<div class="gl-gram-build" id="glGramBuild">' +
            (built.length
              ? built.map(function (w, i) { return '<button type="button" class="gl-gram-chip gl-gram-chip-built" data-i="' + i + '"' + (locked ? ' disabled' : '') + '>' + _glEscape(w) + '</button>'; }).join('')
              : '<span class="gl-gram-build-placeholder">Tap words below to build the sentence</span>') +
            '</div>' +
            '<div class="gl-gram-chips" id="glGramChips">' +
            pool.map(function (w, i) { return '<button type="button" class="gl-gram-chip" data-i="' + i + '">' + _glEscape(w) + '</button>'; }).join('') +
            '</div>' +
            '<div class="gl-gram-ex-actions">' +
            '<button type="button" class="gl-gram-btn" id="glGramResetBtn"' + (locked ? ' disabled' : '') + '>Reset</button>' +
            '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramCheckBtn"' + (locked || !canCheck ? ' disabled' : '') + '>Check answer →</button>' +
            '</div>';
        }

        if (ex.type === 'choice') {
          var sel = gm.selected[idx];
          return '<div class="gl-gram-ex-eyebrow">Choose the correct form</div>' +
            '<p class="gl-gram-ex-prompt">' + ex.promptHtml.replace('___', '<span class="gl-gram-blank">___</span>') + '</p>' +
            '<div class="gl-gram-options" id="glGramOptions">' +
            ex.options.map(function (opt, i) {
              var cls = 'gl-gram-option';
              if (locked) {
                if (i === ex.answerIndex) cls += ' gl-gram-opt-correct';
                else if (i === answer.selectedIndex) cls += ' gl-gram-opt-incorrect';
              } else if (sel === i) cls += ' gl-gram-opt-selected';
              return '<button type="button" class="' + cls + '" data-i="' + i + '"' + (locked ? ' disabled' : '') + '>' + _glEscape(opt) + '</button>';
            }).join('') +
            '</div>' +
            '<div class="gl-gram-ex-actions">' +
            '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramCheckBtn"' + (locked || sel == null ? ' disabled' : '') + '>Check answer →</button>' +
            '</div>';
        }

        var eyebrow = { gap: 'Fill the gap', transform: 'Sentence transformation', combine: 'Combine the sentences', correct: 'Correct the sentence' }[ex.type];
        var body = '';
        if (ex.type === 'gap') {
          body = '<p class="gl-gram-ex-prompt">' +
            ex.promptHtml.replace('___', '<input type="text" class="gl-gram-inline-input" id="glGramFreeInput"' + (locked ? ' disabled value="' + _glEscape(answer.userValue || '') + '"' : '') + '>') +
            '</p>';
        } else if (ex.type === 'transform') {
          body = '<p class="gl-gram-ex-instruction">Original:</p>' +
            '<div class="gl-gram-original">' + ex.originalLines.map(_glEscape).join('<br>') + '</div>' +
            '<p class="gl-gram-ex-prefix">"' + _glEscape(ex.promptPrefix) + '"</p>' +
            '<textarea class="gl-gram-textarea" id="glGramFreeInput" placeholder="Type your answer..."' + (locked ? ' disabled' : '') + '>' + (locked ? _glEscape(answer.userValue || '') : '') + '</textarea>';
        } else if (ex.type === 'combine') {
          var instr = /^\(/.test(ex.connector) ? 'Combine into one sentence using a relative clause.' : 'Combine using "' + ex.connector + '".';
          body = '<p class="gl-gram-ex-instruction">' + _glEscape(instr) + '</p>' +
            '<div class="gl-gram-original">' + _glEscape(ex.sentenceA) + '<br>' + _glEscape(ex.sentenceB) + '</div>' +
            '<textarea class="gl-gram-textarea" id="glGramFreeInput" placeholder="Type your combined sentence..."' + (locked ? ' disabled' : '') + '>' + (locked ? _glEscape(answer.userValue || '') : '') + '</textarea>';
        } else if (ex.type === 'correct') {
          body = '<div class="gl-gram-quote">“' + _glEscape(ex.sentenceWrong) + '”</div>' +
            '<p class="gl-gram-ex-instruction">What is wrong?</p>' +
            '<textarea class="gl-gram-textarea" id="glGramFreeInput" placeholder="Rewrite the sentence correctly..."' + (locked ? ' disabled' : '') + '>' + (locked ? _glEscape(answer.userValue || '') : '') + '</textarea>';
        }
        return '<div class="gl-gram-ex-eyebrow">' + eyebrow + '</div>' + body +
          '<div class="gl-gram-ex-actions">' +
          '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramCheckBtn"' + (locked ? ' disabled' : '') + '>Check answer →</button>' +
          '</div>';
      }

      function gmWireExercise(ex, answer) {
        var idx = gm.index;
        var locked = !!answer;
        if (ex.type === 'order' && !locked) {
          var chipsWrap = gmEl('glGramChips');
          if (chipsWrap) chipsWrap.querySelectorAll('.gl-gram-chip').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var i = Number(btn.getAttribute('data-i'));
              var word = gm.orderPool[idx].splice(i, 1)[0];
              gm.orderBuilt[idx].push(word);
              gmRenderExercise();
            });
          });
          var buildWrap = gmEl('glGramBuild');
          if (buildWrap) buildWrap.querySelectorAll('.gl-gram-chip-built').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var i = Number(btn.getAttribute('data-i'));
              var word = gm.orderBuilt[idx].splice(i, 1)[0];
              gm.orderPool[idx].push(word);
              gmRenderExercise();
            });
          });
          var resetBtn = gmEl('glGramResetBtn');
          if (resetBtn) resetBtn.addEventListener('click', function () {
            gm.orderPool[idx] = gmShuffle(ex.words.slice());
            gm.orderBuilt[idx] = [];
            gmRenderExercise();
          });
        } else if (ex.type === 'choice' && !locked) {
          var optWrap = gmEl('glGramOptions');
          if (optWrap) optWrap.querySelectorAll('.gl-gram-option').forEach(function (btn) {
            btn.addEventListener('click', function () {
              gm.selected[idx] = Number(btn.getAttribute('data-i'));
              gmRenderExercise();
            });
          });
        }
        var checkBtn = gmEl('glGramCheckBtn');
        if (checkBtn && !checkBtn.disabled) checkBtn.addEventListener('click', gmCheck);
      }

      function gmCheck() {
        var ex = gmCurrentEx();
        var idx = gm.index;
        var correct = false;
        var almost = false;
        var userDisplay = '';
        var selectedIndex = null;

        if (ex.type === 'order') {
          userDisplay = (gm.orderBuilt[idx] || []).join(' ');
          correct = gmNormalize(userDisplay) === gmNormalize(ex.answer);
        } else if (ex.type === 'choice') {
          selectedIndex = gm.selected[idx];
          if (selectedIndex == null) return;
          userDisplay = ex.options[selectedIndex];
          correct = selectedIndex === ex.answerIndex;
        } else if (ex.type === 'gap') {
          var gi = gmEl('glGramFreeInput');
          userDisplay = gi ? gi.value : '';
          if (!userDisplay.trim()) return;
          correct = ex.accepted.indexOf(gmNormalize(userDisplay)) !== -1;
        } else {
          var fi = gmEl('glGramFreeInput');
          userDisplay = fi ? fi.value : '';
          if (!userDisplay.trim()) return;
          correct = ex.accepted.indexOf(gmNormalize(userDisplay)) !== -1;
          if (!correct && ex.type === 'transform') {
            if (gmWordOverlap(userDisplay, ex.betterAnswer) >= 0.55) almost = true;
          }
        }

        gm._lastUser[idx] = userDisplay;

        if (correct) {
          gm.answers[idx] = { status: 'correct', userValue: userDisplay, selectedIndex: selectedIndex };
          gm.score++;
          gmStatsRecord(gm.topic, true);
          gmRenderExercise();
        } else if (almost) {
          gm.answers[idx] = { status: 'almost', userValue: userDisplay, selectedIndex: selectedIndex };
          gmStatsRecord(gm.topic, false);
          gmRenderExercise();
        } else {
          gm.tries[idx] = (gm.tries[idx] || 0) + 1;
          gmRenderPendingWrong(ex, userDisplay);
        }
      }

      function gmRenderPendingWrong(ex, userDisplay) {
        var fbWrap = gmEl('glGramFeedback');
        fbWrap.innerHTML =
          '<div class="gl-gram-fb gl-gram-fb-incorrect">' +
          '<div class="gl-gram-fb-title">Not quite.</div>' +
          (userDisplay ? '<div class="gl-gram-fb-line">Your answer:<br><strong>' + _glEscape(userDisplay) + '</strong></div>' : '') +
          '<div class="gl-gram-fb-actions">' +
          '<button type="button" class="gl-gram-btn" id="glGramTryAgain">Try again</button>' +
          '<button type="button" class="gl-gram-btn" id="glGramShowSolution">Show solution</button>' +
          '</div>' +
          '<div class="gl-gram-fb-actions gl-gram-fb-actions-secondary">' +
          '<button type="button" class="gl-gram-btn gl-gram-btn-ghost" id="glGramExplainBtn">Explain this rule</button>' +
          '</div>' +
          '</div>';
        gmEl('glGramTryAgain').addEventListener('click', gmTryAgain);
        gmEl('glGramShowSolution').addEventListener('click', gmShowSolution);
        gmEl('glGramExplainBtn').addEventListener('click', function () { gmExplainRule(ex); });
      }

      function gmTryAgain() {
        var idx = gm.index;
        var ex = gm.queue[idx];
        if (ex.type === 'order') {
          gm.orderPool[idx] = gmShuffle(ex.words.slice());
          gm.orderBuilt[idx] = [];
        }
        gm.selected[idx] = null;
        gmRenderExercise();
      }

      function gmShowSolution() {
        var idx = gm.index;
        gm.answers[idx] = { status: 'revealed', userValue: (gm._lastUser && gm._lastUser[idx]) || '', selectedIndex: gm.selected[idx] };
        gmStatsRecord(gm.topic, false);
        gmRenderExercise();
      }

      function gmFeedbackBeforeHtml(ex) {
        var hLevel = gm.hintLevel[gm.index] || 0;
        var hasHints = ex.hints && ex.hints.length;
        var hintsHtml = '';
        for (var i = 0; i < hLevel; i++) hintsHtml += '<div class="gl-gram-hint-box">' + _glEscape(ex.hints[i]) + '</div>';
        var hintDisabled = !hasHints || hLevel >= ex.hints.length;
        var hintLabel = hLevel === 0 ? 'Give me a hint' : (hintDisabled ? 'No more hints' : 'Another hint');
        return '<div class="gl-gram-focus">' +
          '<div class="gl-gram-focus-eyebrow">Grammar focus</div>' +
          '<div class="gl-gram-focus-title">' + _glEscape(ex.rule.focus) + '</div>' +
          '<div class="gl-gram-focus-think">Think about:<br>' + _glEscape(ex.rule.think) + '</div>' +
          hintsHtml +
          '<button type="button" class="gl-gram-hint-btn" id="glGramHintBtn"' + (hintDisabled ? ' disabled' : '') + '>' + hintLabel + '</button>' +
          '</div>';
      }

      function gmFeedbackAfterHtml(ex, answer) {
        var isCorrect = answer.status === 'correct';
        var isAlmost = answer.status === 'almost';
        var title = isCorrect ? '✓ Correct' : isAlmost ? 'Almost correct.' : 'Not quite.';
        var cls = isCorrect ? 'gl-gram-fb-correct' : isAlmost ? 'gl-gram-fb-almost' : 'gl-gram-fb-incorrect';
        var lines = '';

        if (ex.type === 'correct') {
          lines += isCorrect
            ? '<div class="gl-gram-fb-line">' + ex.highlightCorrect + '</div>'
            : '<div class="gl-gram-fb-line">Your answer:<br><strong>' + _glEscape(answer.userValue || '(none)') + '</strong></div>' +
              '<div class="gl-gram-fb-line">Correct:<br>' + ex.highlightCorrect + '</div>';
        } else if (!isCorrect) {
          var better = ex.type === 'transform' ? ex.betterAnswer
            : ex.type === 'combine' ? ex.display
            : ex.type === 'order' ? ex.answer
            : ex.type === 'choice' ? ex.options[ex.answerIndex]
            : (ex.accepted && ex.accepted[0]);
          lines += '<div class="gl-gram-fb-line">Your answer:<br><strong>' + _glEscape(answer.userValue || '(none)') + '</strong></div>' +
            '<div class="gl-gram-fb-line">' + (isAlmost ? 'Better' : 'Correct') + ':<br><strong>' + _glEscape(better || '') + '</strong></div>';
        } else if (ex.type === 'order') {
          lines += '<div class="gl-gram-fb-line"><strong>' + _glEscape(ex.answer) + '</strong></div>';
        }

        var patternHtml = ex.pattern
          ? '<div class="gl-gram-pattern">' + ex.pattern.map(function (p) { return '<span class="gl-gram-pattern-chip">' + _glEscape(p) + '</span>'; }).join('<span class="gl-gram-pattern-plus">+</span>') + '</div>'
          : '';
        var logicHtml = ex.logic
          ? '<div class="gl-gram-logic">' + ex.logic.map(function (l) { return '<div class="gl-gram-logic-row">' + _glEscape(l) + '</div>'; }).join('<div class="gl-gram-logic-arrow">↓</div>') + '</div>'
          : '';

        return '<div class="gl-gram-fb ' + cls + '">' +
          '<div class="gl-gram-fb-title">' + title + '</div>' +
          lines + patternHtml + logicHtml +
          '<div class="gl-gram-fb-why"><strong>Why?</strong><br>' + _glEscape(ex.rule.why) +
          '<br><br><span class="gl-gram-fb-mainrule">' + _glEscape(ex.rule.mainRule) + '</span>' +
          '<br><span class="gl-gram-fb-example">' + _glEscape(ex.rule.example) + '</span></div>' +
          '<div class="gl-gram-fb-actions">' +
          '<button type="button" class="gl-gram-btn gl-gram-btn-ghost" id="glGramExplainBtn">Explain this rule</button>' +
          '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramNextBtn">Next →</button>' +
          '</div>' +
          '</div>';
      }

      function gmWireFeedback(ex, answer) {
        if (!answer) {
          var hb = gmEl('glGramHintBtn');
          if (hb) hb.addEventListener('click', function () {
            gm.hintLevel[gm.index] = (gm.hintLevel[gm.index] || 0) + 1;
            gmEl('glGramFeedback').innerHTML = gmFeedbackBeforeHtml(ex);
            gmWireFeedback(ex, null);
          });
          return;
        }
        var eb = gmEl('glGramExplainBtn');
        if (eb) eb.addEventListener('click', function () { gmExplainRule(ex); });
        var nb = gmEl('glGramNextBtn');
        if (nb) nb.addEventListener('click', gmNext);
      }

      function gmExplainRule(ex) {
        var topicLabel = (GM_ALL_TOPICS.filter(function (t) { return t.id === gm.topic; })[0] || {}).label || gm.topic;
        var prompt = 'Explain this German grammar rule in a short, clear way for a ' + gm.level + ' learner: "' + ex.rule.focus + '". ' +
          ex.rule.why + ' Rule: ' + ex.rule.mainRule + '. Example: ' + ex.rule.example;
        window._glAsk(prompt, 'Grammatik — ' + topicLabel);
      }

      function gmNext() {
        gm.index++;
        if (gm.index >= gm.queue.length) { gmRenderEnd(); return; }
        gmRenderExercise();
      }

      function gmRenderEnd() {
        gmEl('glGramWorkspace').style.display = 'none';
        var wrap = gmEl('glGramEnd');
        wrap.style.display = '';
        var total = gm.queue.length;
        var pct = total ? Math.round((gm.score / total) * 100) : 0;
        var stats = gmStatsLoad();
        var rows = Object.keys(stats).map(function (t) {
          var s = stats[t];
          var acc = s.total ? s.correct / s.total : 0;
          var label = (GM_ALL_TOPICS.filter(function (x) { return x.id === t; })[0] || {}).label || t;
          return { topic: t, label: label, acc: acc, total: s.total };
        }).filter(function (r) { return r.total >= 2; });
        var strong = rows.filter(function (r) { return r.acc >= 0.8; }).map(function (r) { return r.label; });
        var weak = rows.filter(function (r) { return r.acc < 0.6; }).sort(function (a, b) { return a.acc - b.acc; });
        var recommend = weak[0] || null;

        wrap.innerHTML =
          '<div class="gl-gram-end-card">' +
          '<div class="gl-gram-end-title">Grammar practice complete</div>' +
          '<div class="gl-gram-end-score">' + gm.score + ' / ' + total + '</div>' +
          '<div class="gl-gram-end-pct">' + pct + '%</div>' +
          (strong.length ? '<div class="gl-gram-end-row"><b>Strong:</b> ' + strong.map(_glEscape).join(', ') + '</div>' : '') +
          (weak.length ? '<div class="gl-gram-end-row"><b>Needs practice:</b> ' + weak.map(function (r) { return _glEscape(r.label); }).join(', ') + '</div>' : '') +
          (recommend ? '<div class="gl-gram-end-recommend">Recommended next: <b>' + _glEscape(recommend.label) + '</b> · 6 min</div>' : '') +
          '<div class="gl-gram-end-actions">' +
          (recommend ? '<button type="button" class="gl-gram-btn" id="glGramEndWeak">Practice weak area</button>' : '') +
          '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramEndNew">New session</button>' +
          '</div>' +
          '</div>';
        var wb = gmEl('glGramEndWeak');
        if (wb) wb.addEventListener('click', function () {
          gm.topic = recommend.topic;
          var sel = gmEl('glGramTopic');
          if (sel) sel.value = recommend.topic;
          gmStartQueue(gm.topic, 10);
        });
        var nsBtn = gmEl('glGramEndNew');
        if (nsBtn) nsBtn.addEventListener('click', function () { gmStartQueue(gm.topic, 10); });
      }

      function gmRenderWeak() {
        var wrap = gmEl('glGramWeak');
        var stats = gmStatsLoad();
        var rows = GM_ALL_TOPICS.map(function (t) {
          var s = stats[t.id];
          var total = s ? s.total : 0;
          var acc = total ? s.correct / total : null;
          var status = acc == null ? 'Not started' : acc < 0.6 ? 'Needs practice' : acc < 0.85 ? 'Improving' : 'Strong';
          return { id: t.id, label: t.label, total: total, acc: acc, status: status };
        }).filter(function (r) { return r.total > 0; })
          .sort(function (a, b) { return (a.acc == null ? 0 : a.acc) - (b.acc == null ? 0 : b.acc); });

        if (!rows.length) {
          wrap.innerHTML = '<div class="gl-gram-files-empty">Practice a few exercises first — Minallo will track which grammar topics need more work.</div>';
          return;
        }
        var recommend = rows.filter(function (r) { return r.status === 'Needs practice'; })[0] || rows[0];
        wrap.innerHTML =
          '<div class="gl-gram-weak-title">Your weak areas</div>' +
          '<div class="gl-gram-weak-list">' +
          rows.map(function (r) {
            var badgeClass = r.status === 'Needs practice' ? 'gl-gram-badge-weak' : r.status === 'Improving' ? 'gl-gram-badge-mid' : 'gl-gram-badge-strong';
            return '<div class="gl-gram-weak-row"><span>' + _glEscape(r.label) + '</span><span class="gl-gram-badge ' + badgeClass + '">' + r.status + '</span></div>';
          }).join('') +
          '</div>' +
          '<div class="gl-gram-weak-recommend">' +
          '<div class="gl-gram-weak-recommend-title">Recommended practice</div>' +
          '<div class="gl-gram-weak-recommend-topic">' + _glEscape(recommend.label) + '</div>' +
          '<div class="gl-gram-weak-recommend-meta">10 exercises · ~6 min</div>' +
          '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramWeakStart">Start practice</button>' +
          '</div>';
        var wsBtn = gmEl('glGramWeakStart');
        if (wsBtn) wsBtn.addEventListener('click', function () {
          gm.topic = recommend.id;
          var sel = gmEl('glGramTopic');
          if (sel) sel.value = recommend.id;
          gmSetTabView('practice');
          gmStartQueue(recommend.id, 10);
        });
      }

      // ── From my files ─────────────────────────────────────────────────────
      var GM_DETECT_PATTERNS = [
        { topic: 'verbPosition', re: /\b(weil|obwohl|dass|damit|wenn)\b/i },
        { topic: 'relativeClauses', re: /,\s*(der|die|das|den|dem|deren|dessen)\b/i },
        { topic: 'konjunktivII', re: /\b(würde|hätte|wäre|könnte)\b/i },
        { topic: 'passive', re: /\b(wird|wurde|werden)\s+(\w+\s+)?(ge\w+|\w*t|geworden)\b/i },
        { topic: 'connectors', re: /\b(trotzdem|deshalb|außerdem|allerdings|dennoch)\b/i },
        { topic: 'prepositions', re: /\b(interessiere|warte|denke|freue)\s+(mich\s+)?(an|auf|für|über|von)\b/i },
        { topic: 'tenses', re: /\bge\w+t\b|\bge\w+en\b/i }
      ];

      function gmDetectTopics(text) {
        var found = [];
        GM_DETECT_PATTERNS.forEach(function (p) {
          if (p.re.test(text) && found.indexOf(p.topic) === -1) found.push(p.topic);
        });
        return found.slice(0, 4);
      }

      var gmChosenTopics = [];

      async function gmRenderFilesPanel() {
        var wrap = gmEl('glGramFiles');
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        wrap.innerHTML = '<div class="gl-gram-files-empty">Loading your files…</div>';
        if (!uid) {
          wrap.innerHTML = '<div class="gl-gram-files-empty">Sign in to use your uploaded German files.</div>';
          return;
        }
        var course = _glStorageCourse();
        if (!course.files) course.files = [];
        try { await _ufMerge(course); } catch (e) { /* ignore */ }
        var files = course.files || [];
        if (!files.length) {
          wrap.innerHTML = '<div class="gl-gram-files-empty">No German files uploaded yet. Use Upload German file from another skill, then come back here.</div>';
          return;
        }
        wrap.innerHTML =
          '<div class="gl-gram-files-title">Choose a file to practice grammar from</div>' +
          '<div id="glGramFileList">' +
          files.map(function (f) {
            var name = f.name || f.file_name || 'German file';
            return '<label class="gl-gram-file-row"><input type="radio" name="glGramFile" value="' + _glEscape(name) + '"><span>' + _glEscape(name) + '</span></label>';
          }).join('') +
          '</div>' +
          '<div class="gl-gram-files-detect" id="glGramDetect" style="display:none"></div>' +
          '<div class="gl-gram-files-config">' +
          '<label>Difficulty<select id="glGramCfgLevel"><option>A1</option><option>A2</option><option>B1</option><option selected>B2</option><option>C1</option></select></label>' +
          '<label>Exercises<select id="glGramCfgCount"><option>5</option><option selected>10</option><option>15</option></select></label>' +
          '<button type="button" class="gl-gram-start-btn" id="glGramFilesStart" disabled>Start practice</button>' +
          '</div>';

        document.querySelectorAll('input[name="glGramFile"]').forEach(function (radio) {
          radio.addEventListener('change', function () { gmOnFileChosen(radio.value); });
        });
      }

      async function gmOnFileChosen(fname) {
        var detectWrap = gmEl('glGramDetect');
        var startBtn = gmEl('glGramFilesStart');
        gmChosenTopics = [];
        if (startBtn) startBtn.disabled = true;
        detectWrap.style.display = '';
        detectWrap.innerHTML = 'Scanning file…';
        var ext = (fname.split('.').pop() || '').toLowerCase();
        var detected = [];
        if (['txt', 'md'].indexOf(ext) !== -1) {
          try {
            var uid = _currentUser && (_currentUser.id || _currentUser.sub);
            var bytes = await _ufFetchBytes(uid, _glStorageCourse(), fname);
            detected = gmDetectTopics(new TextDecoder().decode(bytes));
          } catch (e) { /* fall through to default topics */ }
        }
        if (!detected.length) detected = ['verbPosition', 'cases', 'connectors'];
        gmChosenTopics = detected.slice();
        detectWrap.innerHTML =
          '<div class="gl-gram-detect-label">We found:</div>' +
          '<div class="gl-gram-detect-chips" id="glGramDetectChips">' +
          detected.map(function (id) {
            var t = GM_ALL_TOPICS.filter(function (x) { return x.id === id; })[0];
            return '<button type="button" class="gl-gram-detect-chip active" data-topic="' + id + '">' + _glEscape(t ? t.label : id) + '</button>';
          }).join('') +
          '</div>' +
          '<div class="gl-gram-detect-question">What should we practice?</div>';
        detectWrap.querySelectorAll('.gl-gram-detect-chip').forEach(function (chip) {
          chip.addEventListener('click', function () {
            var id = chip.getAttribute('data-topic');
            var i = gmChosenTopics.indexOf(id);
            if (i === -1) { gmChosenTopics.push(id); chip.classList.add('active'); }
            else { gmChosenTopics.splice(i, 1); chip.classList.remove('active'); }
            if (startBtn) startBtn.disabled = !gmChosenTopics.length;
          });
        });
        if (startBtn) {
          startBtn.disabled = !gmChosenTopics.length;
          startBtn.onclick = function () { gmStartFromFile(fname); };
        }
      }

      function gmGeneratePrompt(level, count, topics) {
        return 'Based on this German document, write ' + count + ' grammar practice exercises for a ' + level +
          ' learner, focused on these grammar topics: ' + topics.join(', ') + '. Use sentences or structures inspired by the document where possible, not meaningless copies. ' +
          'Reply with ONLY this JSON array, no other text, no markdown fences: ' +
          '[{"type":"gap","promptHtml":"Sentence with ___ for the gap","accepted":["lowercase accepted answer(s), punctuation-free"],"rule":{"focus":"...","think":"...","why":"...","mainRule":"...","example":"..."},"hints":["hint1","hint2"]}]. ' +
          'Valid "type" values and their extra fields: ' +
          '"order" needs "words" (array of the sentence\'s words, unordered) and "answer" (lowercase, space-joined correct order); ' +
          '"choice" needs "options" (array of 4 short strings) and "answerIndex" (0-based number); ' +
          '"gap" needs "promptHtml" (containing ___) and "accepted" (array); ' +
          '"transform" needs "originalLines" (array of 1-2 sentences), "promptPrefix", "accepted" (array, lowercase punctuation-free), "betterAnswer" (nicely cased sentence); ' +
          '"combine" needs "sentenceA", "sentenceB", "connector", "accepted" (array, lowercase punctuation-free), "display" (nicely cased combined sentence); ' +
          '"correct" needs "sentenceWrong", "accepted" (array, lowercase punctuation-free), "highlightCorrect" (nicely cased corrected sentence with the fixed word wrapped in <strong>). ' +
          'Every exercise object needs "type", "rule" (with focus/think/why/mainRule/example) and "hints" (array of exactly 2 short strings), formatted as in the example above.';
      }

      function gmParseGenerated(text) {
        try {
          var cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
          var arr = JSON.parse(cleaned);
          if (!Array.isArray(arr) || !arr.length) return null;
          return arr.filter(function (ex) { return ex && ex.type && ex.rule; });
        } catch (e) {
          return null;
        }
      }

      async function gmStartFromFile(fname) {
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        var level = gmEl('glGramCfgLevel') ? gmEl('glGramCfgLevel').value : 'B2';
        var count = gmEl('glGramCfgCount') ? gmEl('glGramCfgCount').value : '10';
        var startBtn = gmEl('glGramFilesStart');
        if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Generating…'; }

        try {
          var bytes = await _ufFetchBytes(uid, _glStorageCourse(), fname);
          var ext = (fname.split('.').pop() || '').toLowerCase();
          var messageContent;
          if (ext === 'pdf') {
            var b64 = '';
            var chunkSize = 8192;
            for (var i = 0; i < bytes.length; i += chunkSize) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            b64 = btoa(b64);
            messageContent = [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
              { type: 'text', text: gmGeneratePrompt(level, count, gmChosenTopics) }
            ];
          } else if (['txt', 'md'].indexOf(ext) !== -1) {
            var textContent = new TextDecoder().decode(bytes);
            messageContent = [{ type: 'text', text: 'DOCUMENT CONTENT:\n' + textContent + '\n\n' + gmGeneratePrompt(level, count, gmChosenTopics) }];
          } else {
            if (typeof showToast === 'function') showToast('Unsupported file', 'Only PDF and text files can be turned into grammar exercises right now.');
            if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start practice'; }
            return;
          }

          var resp = await _authFetch(BACKEND_URL + '/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 2200,
              system: 'You are a German grammar exercise generator. Reply with ONLY valid JSON, no markdown fences, no commentary.',
              messages: [{ role: 'user', content: messageContent }]
            })
          });
          var data = await resp.json();
          var text = data.content ? data.content.map(function (b) { return b.text || ''; }).join('') : '';
          var parsed = gmParseGenerated(text);
          if (!parsed) throw new Error('Could not generate grammar exercises from this file.');

          gm.queue = parsed;
          gm.index = 0; gm.score = 0; gm.answers = {}; gm.hintLevel = {}; gm.tries = {};
          gm.orderBuilt = {}; gm.orderPool = {}; gm.selected = {}; gm._lastUser = {};
          gmSetTabView('practice');
          gmEl('glGramEnd').style.display = 'none';
          gmEl('glGramWorkspace').style.display = '';
          gmRenderExercise();
        } catch (e) {
          if (typeof showToast === 'function') showToast('Could not generate exercises', e.message || 'Try a different file.');
        } finally {
          if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start practice'; }
        }
      }
    })();


    // Re-apply hero badge after profile loads (app.js fires this when profile is ready)
    window.addEventListener('ss-profile-updated', _glRefreshHero);
  } // end _init
})();
