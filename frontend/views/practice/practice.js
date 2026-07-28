// ── GERMAN LEARNER PRACTICE ──────────────────────────────────────────────────
(function () {
  var container = document.getElementById('psec-german');
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
  _ssFetchText('views/practice/practice.html', 2)
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
          if (home) home.style.display = '';
          if (detail) detail.style.display = 'none';
          // Also collapse the Schreibtrainer detail view — otherwise it
          // stays visible underneath the cards when the user navigates
          // away mid-session and clicks Practice again.
          if (wcView) wcView.style.display = 'none';
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
      if (!detail || detail.style.display === 'none') return;
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

    window._glOpenSkill = function (skill) {
      _glActiveSkill = skill;
      var home = document.getElementById('glHome');
      var detail = document.getElementById('glSkillView');
      if (home) home.style.display = 'none';
      if (detail) detail.style.display = '';
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
      if (home) home.style.display = '';
      if (detail) detail.style.display = 'none';
      // Also collapse the Schreibtrainer detail view — otherwise it
      // stays visible underneath the cards when the user navigates
      // away mid-session and clicks Practice again.
      if (wcView) wcView.style.display = 'none';
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

    function _dbSaveQuiz(courseId, items) {
      var uid = _userId();
      if (!uid) return Promise.resolve(null);
      var sk = _glActiveSkill || 'general';
      var name = (_glSkillNames[sk] || sk) + ' Quiz';
      return fetch(_supaUrl() + '/rest/v1/quiz_runs', {
        method: 'POST',
        headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=representation' }),
        body: JSON.stringify({ user_id: uid, course_id: courseId, name: name, items: items })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { return rows && rows[0] ? rows[0].id : null; })
        .catch(function () { return null; });
    }

    function _dbLoadQuiz(courseId) {
      var url = _supaUrl() + '/rest/v1/quiz_runs?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=1';
      return fetch(url, { headers: _supaHeaders() })
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; });
    }

    function _dbSaveCards(courseId, items) {
      var uid = _userId();
      if (!uid) return Promise.resolve(null);
      var sk = _glActiveSkill || 'general';
      var name = (_glSkillNames[sk] || sk) + ' Flashcards';
      return fetch(_supaUrl() + '/rest/v1/flashcard_decks', {
        method: 'POST',
        headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=representation' }),
        body: JSON.stringify({ user_id: uid, course_id: courseId, name: name, cards: items })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { return rows && rows[0] ? rows[0].id : null; })
        .catch(function () { return null; });
    }

    function _dbLoadCards(courseId) {
      var url = _supaUrl() + '/rest/v1/flashcard_decks?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=1';
      return fetch(url, { headers: _supaHeaders() })
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
      var token = window._sbToken || '';
      try {
        var r = await fetch(BACKEND_URL + '/api/documents/list?courseId=' + encodeURIComponent(course.id), {
          headers: { Authorization: 'Bearer ' + token }
        });
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

        var resp = await fetch(BACKEND_URL + '/api/ai/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (window._sbToken || '') },
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
        var resp = await fetch(BACKEND_URL + '/api/ai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (window._sbToken || '')
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

    // Re-apply hero badge after profile loads (app.js fires this when profile is ready)
    window.addEventListener('ss-profile-updated', _glRefreshHero);
  } // end _init
})();
