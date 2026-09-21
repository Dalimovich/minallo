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
      sprachbausteine: 'Sprachbausteine',
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
      sprachbausteine: 'Cloze text with four-option grammar, lexicon, and orthography items',
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
    // Profile-specific transient state (generated part, prepared/prefetched part, TTS, part
    // navigation) lives inside the per-module IIFEs below. Each registers a reset here; the exam
    // workspace runs them all when the learner's resolved exam profile changes. Historical
    // progress is server-side and namespaced by profileId, so it is never touched.
    var _glProfileResetHooks = [];
    window._glRegisterProfileReset = function (fn) { _glProfileResetHooks.push(fn); };
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

    // ── Learner level: ONE source (profile) for every practice module ──────
    // The level selects default to the learner's saved target level
    // (profiles.german_level via getGermanLearnerProfile), never a hard-coded
    // one. Changing a select is a SESSION-ONLY override — it never writes the
    // profile. When the profile itself changes (Profile page save), overrides
    // are dropped and the NEXT generation uses the new level; an exercise that
    // is already on screen is not mutated mid-question.
    function _glProfileLevel() {
      var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
      return p && p.state === 'ready' ? p.targetLevel : '';
    }
    // Only explicitly advanced levels; never guess a CEFR mapping for
    // exam-specific levels (TDN n, DSH-n).
    function _glIsAdvancedLevel(l) {
      return ['C1', 'C1 Hochschule', 'C2', 'DSD II (C1)'].indexOf(l) !== -1;
    }
    function _glLevelOptionsHtml() {
      return window.germanLevelOptionsHtml ? window.germanLevelOptionsHtml() : '<option value="" selected>…</option>';
    }
    var _glLastSyncedLevel = null;
    var _glLevelSelectIds = ['glReadingLevel', 'glGramLevel', 'glVocabLevel', 'glListenLevel'];
    // Modules (Grammatik, Wortschatz) register a callback to re-read their
    // level after every sync; they live in inner scopes this helper can't see.
    var _glOnLevelSync = [];
    function _glSyncLevelSelects() {
      var profileLevel = _glProfileLevel();
      var profileChanged = profileLevel !== _glLastSyncedLevel;
      _glLevelSelectIds.forEach(function (id) {
        var sel = document.getElementById(id);
        if (!sel) return;
        var keep = !profileChanged && sel._glSessionOverride ? sel.value : '';
        sel.innerHTML = _glLevelOptionsHtml();
        if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep;
        else sel._glSessionOverride = false;
        if (!sel._glOverrideWired) {
          sel._glOverrideWired = true;
          sel.addEventListener('change', function () { sel._glSessionOverride = true; });
        }
      });
      _glOnLevelSync.forEach(function (fn) {
        try { fn(profileChanged); } catch (e) { /* module not built yet */ }
      });
      _glLastSyncedLevel = profileLevel;
    }
    window.addEventListener('ss-profile-updated', function () {
      try { _glSyncLevelSelects(); } catch (e) { /* views not built yet */ }
    });

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

    // Writing Coach's real exam-aware workspace lives inside the chatbot
    // shell (#ncbRoot), not this #psec-german grid — _glOpenSkill has no
    // 'writing' branch and would otherwise silently fall through to the
    // generic quiz/cards template (see _glOpenSkill's fallback branch),
    // which is exactly the "generic questions instead of the real exam task"
    // bug for telc learners. Mirrors the sidebar's #psbWritingCoach handler
    // in router.js so every entry point (this grid's card, a deep link via
    // _glSetPendingSkill, etc.) reaches the same real workspace.
    window._glOpenWritingCoachFromPractice = function () {
      if (typeof setNavActive === 'function') setNavActive('psbAIPage');
      if (typeof showPortalSection === 'function') showPortalSection('aipage');
      if (typeof _finalizeNav === 'function') _finalizeNav('aipage');
      if (typeof _ssAfterFeature === 'function') {
        _ssAfterFeature('aipage', function () {
          if (typeof window._ensureWritingCoach === 'function') {
            window._ensureWritingCoach().then(function () {
              if (typeof window._wcOpen === 'function') window._wcOpen();
            }).catch(function () {});
          } else if (typeof window._wcOpen === 'function') {
            window._wcOpen();
          }
        });
      }
    };

    // Hören HV1 prefetch is intent-aware, not "German Practice merely
    // opened": with Lesen now a real generated exercise too, prefetching
    // Hören unconditionally would waste a full generation+semantic-
    // verification call for every learner who came only to read. Fire it
    // only when there's an actual signal the learner wants Hören:
    //   (a) their last-used skill (ss_gl_last_skill, written by the skill-
    //       card click handler below) was listening — after a short idle,
    //       same as before, to avoid firing on a quick pass-through; or
    //   (b) genuine pointer/keyboard intent on the Hören card itself
    //       (hover/focus), which fires immediately regardless of last-used
    //       skill.
    // window._glMaybePrefetchHV1 (defined in the Hören section below) is
    // itself idempotent/one-shot (state !== 'idle' guard) — either trigger
    // is a safe no-op once the other has already fired.
    var lastSkillForPrefetch = '';
    try { lastSkillForPrefetch = localStorage.getItem('ss_gl_last_skill') || ''; } catch (_) {}
    if (lastSkillForPrefetch === 'listening') {
      setTimeout(function () {
        if (typeof window._glMaybePrefetchHV1 === 'function') window._glMaybePrefetchHV1();
      }, 1500);
    }
    var hoerenCard = document.querySelector('.gl-skill-card[data-skill="listening"]');
    if (hoerenCard) {
      var _hoerenPrefetchIntent = function () {
        if (typeof window._glMaybePrefetchHV1 === 'function') window._glMaybePrefetchHV1();
      };
      hoerenCard.addEventListener('pointerenter', _hoerenPrefetchIntent);
      hoerenCard.addEventListener('focus', _hoerenPrefetchIntent);
    }

    // Back button. window._glBackToHome is set here, then fully redefined
    // further down (it additionally clears data-active-skill and, now,
    // stops any Hören audio). Bind a thin wrapper that looks the function up
    // at click time instead of capturing this early definition as a
    // closure, so the button always runs whichever implementation is
    // current rather than this stale one.
    var glBackBtn = document.getElementById('glBackBtn');
    window._glBackToHome = function () {
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
    };
    if (glBackBtn) glBackBtn.addEventListener('click', function () { window._glBackToHome(); });

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

    // Legacy pieces of #glSkillView that Lesen/Grammatik/Wortschatz each
    // replace with their own dedicated workspace (see _glOpenReadingView /
    // _glOpenGrammarView / _glOpenVocabularyView below). Toggled per-skill so
    // any remaining skill without a dedicated workspace yet still falls back
    // to the generic quiz/cards template unchanged.
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

    // Shared "never blank" fallback for exam-only skills whose dedicated
    // workspace controller or view markup failed to load/mount (e.g. a
    // stale cached practice.html missing newer markup, or a controller
    // script that failed to execute). Renders a visible error+Retry inside
    // #glSkillView instead of leaving it empty. Retry reloads the page
    // since a missing controller/markup can't be recovered in-place.
    function _glShowSkillMountError(skillLabel) {
      var detail = document.getElementById('glSkillView');
      if (!detail) return;
      _glSetGenericSkillPiecesVisible(false);
      ['glReadingView', 'glGrammarView', 'glVocabularyView', 'glListeningView', 'glSprachbausteineView'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      var host = document.getElementById('glSkillMountError');
      if (!host) {
        host = document.createElement('div');
        host.id = 'glSkillMountError';
        detail.appendChild(host);
      }
      host.style.display = '';
      host.innerHTML =
        '<div class="gl-listen-error">' +
          '<p class="gl-listen-error-title">' + _glEscape(skillLabel) + ' could not load.</p>' +
          '<p class="gl-listen-error-sub">Please retry.</p>' +
          '<div class="gl-listen-error-actions">' +
            '<button type="button" id="glSkillMountErrorRetry" class="gl-listen-end-btn gl-listen-end-btn-primary">Retry</button>' +
          '</div>' +
        '</div>';
      var retryBtn = document.getElementById('glSkillMountErrorRetry');
      if (retryBtn) retryBtn.addEventListener('click', function () { window.location.reload(); });
    }

    window._glOpenSkill = function (skill) {
      // Exam skills come from the learner's exam manifest: a section the exam lacks, or one
      // that is not generatable yet, never falls through to another exam's view.
      var _glBlockReason = typeof window._glExamSkillBlocked === 'function' ? window._glExamSkillBlocked(skill) : '';
      if (_glBlockReason) {
        if (typeof showToast === 'function') showToast('Not available yet', _glBlockReason);
        return;
      }
      // Leaving Hören (or never having opened it) is a cheap no-op; this
      // guarantees speech never keeps playing invisibly once another skill
      // is opened. See the Hören IIFE below for _glCloseListeningView.
      if (typeof window._glCloseListeningView === 'function') window._glCloseListeningView();
      _glCancelAllGenerations();

      _glActiveSkill = skill;
      var home = document.getElementById('glHome');
      var detail = document.getElementById('glSkillView');
      var readingView = document.getElementById('glReadingView');
      var grammarView = document.getElementById('glGrammarView');
      var vocabView = document.getElementById('glVocabularyView');
      var listenView = document.getElementById('glListeningView');
      var sprachbausteineView = document.getElementById('glSprachbausteineView');
      if (home) home.style.display = 'none';
      if (detail) {
        detail.style.display = '';
        detail.setAttribute('data-active-skill', skill);
      }
      var mountErrorEl = document.getElementById('glSkillMountError');
      if (mountErrorEl) mountErrorEl.style.display = 'none';

      // Schreiben (exam Writing) never has a dedicated view inside this
      // #psec-german grid — redirect to the real workspace instead of
      // falling through to the generic quiz/cards template below (see
      // window._glOpenWritingCoachFromPractice for why).
      if (skill === 'writing') {
        if (typeof window._glOpenWritingCoachFromPractice !== 'function') {
          _glShowSkillMountError('Writing Coach');
          return;
        }
        if (home) home.style.display = '';
        if (detail) detail.style.display = 'none';
        window._glOpenWritingCoachFromPractice();
        return;
      }

      if (skill === 'reading') {
        if (!readingView || typeof window._glOpenReadingView !== 'function') {
          _glShowSkillMountError('Lesen');
          return;
        }
        _glSetGenericSkillPiecesVisible(false);
        if (grammarView) grammarView.style.display = 'none';
        if (vocabView) vocabView.style.display = 'none';
        if (listenView) listenView.style.display = 'none';
        if (sprachbausteineView) sprachbausteineView.style.display = 'none';
        if (readingView) readingView.style.display = '';
        _glOpenReadingView();
        return;
      }

      // Sprachbausteine has its own dedicated cloze workspace (see the
      // Sprachbausteine IIFE below), same pattern as Lesen/Hören —
      // deliberately not the generic quiz/cards template, and no static
      // fallback content exists for it (see window._glOpenSprachbausteineView).
      if (skill === 'sprachbausteine') {
        if (!sprachbausteineView || typeof window._glOpenSprachbausteineView !== 'function') {
          _glShowSkillMountError('Sprachbausteine');
          return;
        }
        _glSetGenericSkillPiecesVisible(false);
        if (readingView) readingView.style.display = 'none';
        if (grammarView) grammarView.style.display = 'none';
        if (vocabView) vocabView.style.display = 'none';
        if (listenView) listenView.style.display = 'none';
        if (sprachbausteineView) sprachbausteineView.style.display = '';
        window._glOpenSprachbausteineView();
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
        if (vocabView) vocabView.style.display = 'none';
        if (listenView) listenView.style.display = 'none';
        if (sprachbausteineView) sprachbausteineView.style.display = 'none';
        if (grammarView) grammarView.style.display = '';
        window._glOpenGrammarView();
        return;
      }

      // Wortschatz has its own dedicated vocabulary-in-context workspace
      // (see the Wortschatz IIFE below), same pattern as Lesen/Grammatik —
      // deliberately not another flashcard/quiz generator.
      if (skill === 'vocab' && typeof window._glOpenVocabularyView === 'function') {
        _glSetGenericSkillPiecesVisible(false);
        if (readingView) readingView.style.display = 'none';
        if (grammarView) grammarView.style.display = 'none';
        if (listenView) listenView.style.display = 'none';
        if (sprachbausteineView) sprachbausteineView.style.display = 'none';
        if (vocabView) vocabView.style.display = '';
        window._glOpenVocabularyView();
        return;
      }

      // Hören has its own dedicated audio-based listening workspace (see the
      // Hören IIFE below), same pattern as Lesen/Grammatik/Wortschatz —
      // deliberately not the generic quiz/cards template, and never
      // flashcards.
      if (skill === 'listening') {
        if (!listenView || typeof window._glOpenListeningView !== 'function') {
          _glShowSkillMountError('Hören');
          return;
        }
        _glSetGenericSkillPiecesVisible(false);
        if (readingView) readingView.style.display = 'none';
        if (grammarView) grammarView.style.display = 'none';
        if (vocabView) vocabView.style.display = 'none';
        if (sprachbausteineView) sprachbausteineView.style.display = 'none';
        if (listenView) listenView.style.display = '';
        window._glOpenListeningView();
        return;
      }

      // Exam-only skills must never reach the generic quiz/cards template
      // below, even if some future change adds a stray call path that skips
      // all the branches above (e.g. a typo'd skill string). General
      // practice tools (vocab/grammar/sentences/games) are unaffected.
      if (['reading', 'listening', 'sprachbausteine', 'writing'].indexOf(skill) !== -1) {
        _glShowSkillMountError(_glSkillNames[skill] || skill);
        return;
      }

      if (readingView) readingView.style.display = 'none';
      if (grammarView) grammarView.style.display = 'none';
      if (vocabView) vocabView.style.display = 'none';
      if (listenView) listenView.style.display = 'none';
      if (sprachbausteineView) sprachbausteineView.style.display = 'none';
      _glSetGenericSkillPiecesVisible(true);

      var titleEl = document.getElementById('glSkillTitle');
      var subEl = document.getElementById('glSkillSub');
      var eyebrowEl = document.getElementById('glSkillEyebrow');
      if (titleEl) titleEl.textContent = _glSkillNames[skill] || 'German Practice';
      if (subEl) subEl.textContent = _glSkillSubs[skill] || 'Practice German with quiz questions and flashcards.';
      if (eyebrowEl) eyebrowEl.textContent = 'German practice';

      _glLoadSampleTools(skill);
      _glRenderStudyTools();

      // Saved practice tools use an internal learner storage key.
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
      if (typeof window._glCloseListeningView === 'function') window._glCloseListeningView();
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

    function _glLearnerFiles() {
      return import('/js/features/german/learner-files.js');
    }

    // General Wortschatz/Grammatik practice — independent of any exam profile.
    // Throws with .status/.userMessage when nothing valid could be produced.
    // Level for generation requests: the learner's profile target (the server
    // re-derives it from the authenticated profile regardless). `fallback` is
    // only used while the profile is not ready.
    function _glLearnerLevel(fallback) {
      return _glProfileLevel() || fallback || '';
    }
    async function _glGeneratePractice(payload, signal) {
      // The server derives the level from the authenticated profile. Only a
      // level that differs from the profile the browser knows is sent, as an
      // explicit session-only override — a stale tab's cached level equals its
      // own stale profile, so it is never mistaken for an override.
      var chosenLevel = payload.level;
      delete payload.level;
      if (chosenLevel && chosenLevel !== _glProfileLevel()) payload.sessionLevelOverride = chosenLevel;
      var resp = await _authFetch(BACKEND_URL + '/api/ai/german-practice/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal
      });
      var data = null;
      try { data = await resp.json(); } catch (e) { /* non-JSON error body */ }
      if (!resp.ok || !data || data.schema !== 'german-practice-v1' || !Array.isArray(data.items) || !data.items.length) {
        var err = new Error('Could not create practice.');
        err.status = (data && data.upstreamStatus) || resp.status;
        err.reference = _glRefFromBody(data);
        err.userMessage = resp.status === 422 && data && (data.error || data.detail) ? String(data.error || data.detail) : '';
        throw err;
      }
      if (data.diagnostics && typeof console !== 'undefined' && console.info) console.info('[german-gen]', data.diagnostics);
      return data;
    }

    // ── Shared generation lifecycle (deadline, cancel, honest progress) ─────
    // Every German AI generation goes through _glRunGeneration so none can sit
    // on a static "Generating…" card. See js/features/german/generation.ts.
    var _glGenLibPromise = null;
    function _glGenerationLib() {
      if (!_glGenLibPromise) _glGenLibPromise = import('/js/features/german/generation.js');
      return _glGenLibPromise;
    }
    var _glLastGenFailure = { code: '', reference: '', status: 0 };
    function _glRefFromBody(b) {
      if (!b) return '';
      if (b.diagnostics && b.diagnostics.requestId) return String(b.diagnostics.requestId);
      if (b.requestId) return String(b.requestId);
      var m = /\(ref ([a-f0-9]{6,32})\)/i.exec(String(b.detail || b.error || ''));
      return m ? m[1] : '';
    }
    // Starts a generation for `holder` (a module state object), cancelling any
    // run it still has in flight. Resolves with the request's value; rejects
    // with a GenerationError ({code: timeout|cancelled|failed, reference}).
    var _glGenHolders = [];
    // Opening another skill drops any generation still in flight elsewhere, so a
    // slow Sprachbausteine request can't keep running (or land) behind Lesen.
    function _glCancelAllGenerations() {
      _glGenHolders.forEach(function (h) {
        if (h._run) { h._run.cancel(); h._run = null; }
      });
    }
    function _glRunGeneration(holder, kind, el, stages, requestFn) {
      if (_glGenHolders.indexOf(holder) === -1) _glGenHolders.push(holder);
      if (holder._run) { holder._run.cancel(); holder._run = null; }
      return _glGenerationLib().then(function (lib) {
        var h = lib.runGeneration({ kind: kind, el: el, stages: stages || undefined, request: requestFn });
        holder._run = h;
        var clear = function () { if (holder._run === h) holder._run = null; };
        h.promise.then(clear, function (err) {
          clear();
          _glLastGenFailure = { code: err && err.code || 'failed', reference: err && err.reference || '', status: err && err.status || 0 };
        });
        return h.promise;
      });
    }
    function _glExamRequest(body) {
      return function (signal) {
        return _authFetch(BACKEND_URL + '/api/ai/german-exam/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal
        }).then(function (resp) {
          if (resp.ok) {
            return resp.json().then(function (env) {
              if (env && env.diagnostics && typeof console !== 'undefined' && console.info) console.info('[german-gen]', env.diagnostics);
              return env;
            });
          }
          return resp.json().catch(function () { return null; }).then(function (b) {
            var e = new Error('generate_http_' + resp.status);
            e.status = (b && b.upstreamStatus) || resp.status;
            e.reference = _glRefFromBody(b);
            throw e;
          });
        });
      };
    }
    // Extra lines for the exam error cards: why it stopped + support reference.
    function _glFailNote() {
      var f = _glLastGenFailure;
      var msg = f.code === 'timeout' || f.status === 504 ? 'Generation took too long. Try again.'
        : f.code === 'cancelled' ? 'You cancelled this generation.' : '';
      return (msg ? '<p class="gl-listen-error-sub">' + msg + '</p>' : '') +
        (f.reference ? '<p class="gl-listen-error-sub">Reference: ' + _glEscape(f.reference) + '</p>' : '');
    }

    // Saved quiz/card keys retain compatibility without changing university course state.
    function _glCourse() {
      var sk = _glActiveSkill || 'general';
      return {
        id: 'german-' + sk,
        short: 'german-' + sk,
        name: 'German ' + (_glSkillNames[sk] || sk)
      };
    }

    function _glEnsurePracticeCourse() {
      return _glCourse();
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
      try {
        var library = await _glLearnerFiles();
        var files = await library.listLearnerFiles();
        var docs = files.filter(function (f) { return f._document && f._document.processing_status === 'ready'; })
          .map(function (f) { return f._document; });
        if (!docs.length) {
          showToast('No indexed files', 'Upload a document in Files and wait for indexing to finish.');
          return;
        }
        _glShowSourcePicker(docs, function (selectedIds) { _glRunGenerate(tool, selectedIds, files); });
      } catch (e) {
        showToast('Could not load files', e.message || String(e));
      }
    }

    async function _glRunGenerate(tool, documentIds, sourceFiles) {
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
        var groups = {};
        (sourceFiles || []).forEach(function (file) {
          if (documentIds.indexOf(file.documentId) === -1) return;
          (groups[file.learnerFileScope] || (groups[file.learnerFileScope] = [])).push(file.documentId);
        });
        var scopes = Object.keys(groups);
        if (!scopes.length) throw new Error('Choose a learner file first.');
        var data = { items: [] };
        // The legacy RAG endpoint requires one storage scope per request.
        for (var scope of scopes) {
          var resp = await _authFetch(BACKEND_URL + '/api/ai/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courseId: scope, documentIds: groups[scope], tool: tool,
              count: Math.max(1, Math.ceil(count / scopes.length)), difficulty: difficulty,
              topic: topic, seenItems: _glSeenItems() })
          });
          if (!resp.ok) throw new Error('Generation failed (' + resp.status + ')');
          var generated = await resp.json();
          data.items = data.items.concat(generated.items || []);
        }

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
      var files;
      try {
        files = await (await _glLearnerFiles()).listLearnerFiles();
      } catch (e) {
        list.textContent = 'Could not load your files. Reopen Files to retry.';
        return;
      }
      if (empty) empty.style.display = files.length ? 'none' : '';
      files.forEach(function (file) {
        var name = file.name || file.file_name || 'German file';
        var row = document.createElement('div');
        row.className = 'gl-file-row';
        row.innerHTML =
          '<span class="gl-file-icon">' + _glFileIcon(name) + '</span>' +
          '<span class="gl-file-name">' + _glEscape(name) + '</span>' +
          '<span class="gl-file-size">' + _glEscape(file.size || '') + '</span>' +
          '<button type="button" class="gl-file-open">Open</button>' +
          '<button type="button" class="gl-file-quiz">Quiz</button>' +
          '<button type="button" class="gl-file-explain">Explain</button>' +
          '<button type="button" class="gl-file-del">Delete</button>';
        var open = row.querySelector('.gl-file-open');
        var quiz = row.querySelector('.gl-file-quiz');
        var explain = row.querySelector('.gl-file-explain');
        var del = row.querySelector('.gl-file-del');
        if (open) open.addEventListener('click', function () { _glOpenFile(uid, file); });
        if (quiz) quiz.addEventListener('click', function () { _glAskAboutFile(uid, file, 'quiz'); });
        if (explain) explain.addEventListener('click', function () { _glAskAboutFile(uid, file, 'explain'); });
        if (del) del.addEventListener('click', function () { _glDeleteFile(uid, file, row); });
        list.appendChild(row);
      });
    }

    async function _glLoadFiles() {
      await _glRenderPracticeFileList();
    }

    async function _glOpenFile(uid, file) {
      try { await (await _glLearnerFiles()).openLearnerFile(file); }
      catch (e) { showToast('Could not open file', e.message || String(e)); }
    }
    window._glOpenFile = _glOpenFile;

    async function _glDeleteFile(uid, file, rowEl) {
      var fname = file.documentName;
      if (!confirm('Delete "' + fname + '"?')) return;
      try {
        await (await _glLearnerFiles()).deleteLearnerFile(file);
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

    async function _glAskAboutFile(uid, file, mode) {
      var fname = file.documentName;
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
        bytes = await (await _glLearnerFiles()).readLearnerFile(file);
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
      var saved = 0;
      for (var i = 0; i < arr.length; i++) {
        var f = arr[i];
        if (status)
          status.textContent = 'Uploading ' + f.name + ' (' + (i + 1) + '/' + arr.length + ')…';
        try {
          var library = await _glLearnerFiles();
          var uploaded = await library.uploadLearnerFile(f, function (pct) {
            if (bar) bar.style.width = pct + '%';
          });
          saved++;
          try { if (/\.pdf$/i.test(uploaded.name)) await library.indexLearnerFile(uploaded, true); }
          catch (e) { showToast('Indexing needs attention', 'Open Files to retry indexing ' + f.name); }
        } catch (e) {
          showToast('Upload failed', f.name + ': ' + (e.message || String(e)));
        }
      }

      if (prog) prog.style.display = 'none';
      if (bar) bar.style.width = '0%';
      if (label) label.style.pointerEvents = '';
      var inp = document.getElementById('glFileInput');
      if (inp) inp.value = '';
      showToast('Upload complete', saved + ' file' + (saved !== 1 ? 's' : '') + ' saved');
      await _glRenderPracticeFileList();
    };

    window._glUploadClick = function () {
      var inp = document.getElementById('glFileInput');
      if (!inp) return;
      inp._glFolder = null;
      inp.click();
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
        genToken: 0,

        // ── German Exam Engine (telc C1 Hochschule Lesen) generated path ──
        usingGenerated: false,
        partId: null, // 'lesen_1' | 'lesen_2' | 'lesen_3'
        examFamily: null, examVariant: null, targetLevel: null,
        profileId: null, profileVersion: null, generationId: null,
        content: null, // raw envelope.content for the active part
        genAnswers: {}, // per-item answer state, shape depends on task_type
        genChecked: false,
        _genRequestToken: 0,
        _lastGenFailed: false,
        // True while Lesen is open and waiting on the profile fetch to
        // resolve (window._germanProfileLoaded still false) — distinct from
        // "loaded and genuinely unsupported". Cleared as soon as generation
        // starts or a definitive unsupported state is reached. See the
        // ss-profile-updated listener below rdOpenGeneratedView.
        _awaitingProfile: false
      };

      function rdEl(id) { return document.getElementById(id); }

      // Toggles the static-mode-only chrome: the Practice/Weak areas/From my
      // files tabs AND the B2/Mixed text-type + level selects (sibling of
      // .gl-reading-tabs inside .gl-reading-header, not a descendant of it —
      // hiding .gl-reading-tabs alone leaves these visible). Neither applies
      // to the generated (real exam profile) path.
      function rdSetStaticHeaderControlsVisible(visible) {
        var tabsWrap = document.querySelector('.gl-reading-tabs');
        if (tabsWrap) tabsWrap.style.display = visible ? '' : 'none';
        var headerControls = document.querySelector('.gl-reading-header-controls');
        if (headerControls) headerControls.style.display = visible ? '' : 'none';
      }

      // Deliberately separate from lsResolveProfileId() (a sibling, private
      // IIFE) rather than sharing it — duplicating this small lookup avoids
      // any risk of touching Hören's code path while adding Lesen. Keep the
      // fallback table in sync with LS_GERMAN_EXAM_PROFILES_FALLBACK (below,
      // in the Hören section), GERMAN_EXAM_PROFILES_CLIENT in user-data.ts,
      // and the backend's GERMAN_EXAM_PROFILES registry.
      // Single source: the shared accessor derives the id from the
      // authoritative (test, level) pair — no per-module resolver/table.
      function rdResolveProfileId() {
        var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
        return (p && p.examProfileId) || null;
      }

      // The part list is the ACTIVE EXAM's, from its manifest (profile decides structure; task type
      // decides behaviour). The telc list below is only the fallback while no manifest is available,
      // so behaviour is unchanged for a telc learner before/without it.
      var RD_FALLBACK_PARTS = [
        { id: 'lesen_1', title: 'Textrekonstruktion', taskType: 'text_reconstruction_sentence_matching', implemented: true, scoring: { pointsPerCorrect: 2 } },
        { id: 'lesen_2', title: 'Selektives Verstehen', taskType: 'section_statement_matching', implemented: true, scoring: { pointsPerCorrect: 2 } },
        { id: 'lesen_3', title: 'Detail- & Globalverstehen', taskType: 'detail_tristate_with_global_heading', implemented: true, scoring: { pointsPerCorrect: 2 } }
      ];
      function rdParts() {
        var st = window._glExamState && window._glExamState();
        var mods = st && st.status === 'ready' && st.manifest ? st.manifest.modules.filter(function (m) { return m.id === 'reading'; }) : [];
        return mods.length ? mods[0].parts : RD_FALLBACK_PARTS;
      }
      function rdPart(partId) {
        return rdParts().filter(function (p) { return p.id === partId; })[0] || null;
      }
      function rdTaskTypeFor(partId) {
        var p = rdPart(partId);
        return p ? p.taskType : null;
      }
      function rdPartLabel(partId) {
        var parts = rdParts();
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].id === partId) return 'Teil ' + (i + 1) + ' · ' + parts[i].title;
        }
        return partId || '';
      }
      function rdFirstPartId() {
        var p = rdParts().filter(function (x) { return x.implemented; })[0];
        return p ? p.id : null;
      }
      function rdPointsPerCorrect() {
        var p = rdPart(rd.partId);
        var v = p && p.scoring && p.scoring.pointsPerCorrect;
        return typeof v === 'number' ? v : 2;
      }
      var RD_LETTERS = 'ABCDEFGHIJKL';

      // Canonical generated-mode header: "<exam> · C1 · Lesen · Teil N" — built from the envelope's
      // own exam fields (never hardcoded), with the part switcher's more descriptive label
      // (e.g. "Textrekonstruktion") shown separately, not folded into this line.
      function rdGeneratedHeader() {
        var teil = (rdPartLabel(rd.partId) || '').split(' · ')[0] || rd.partId || '';
        var examLabel = rd.examDisplayName || [rd.examFamily, rd.examVariant].filter(Boolean).join(' ');
        return [examLabel, rd.targetLevel, 'Lesen', teil].filter(Boolean).join(' · ');
      }

      function rdShowGenerationError(partId) {
        var panel = rdEl('glReadingQuestionPanel');
        var textPanel = rdEl('glReadingTextPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (!panel) return;
        panel.innerHTML =
          '<div class="gl-listen-error">' +
            '<p class="gl-listen-error-title">Couldn’t create your verified exam exercise.</p>' +
            '<p class="gl-listen-error-sub">Generation didn’t complete this time — nothing was recorded. You can retry, or switch to general reading practice instead.</p>' +
            _glFailNote() +
            '<div class="gl-listen-error-actions">' +
              '<button type="button" id="glReadingErrorRetry" class="gl-listen-end-btn gl-listen-end-btn-primary">Retry</button>' +
              '<button type="button" id="glReadingErrorFallback" class="gl-listen-end-btn">Use general reading practice</button>' +
            '</div>' +
          '</div>';
        var retryBtn = rdEl('glReadingErrorRetry');
        var fallbackBtn = rdEl('glReadingErrorFallback');
        if (retryBtn) retryBtn.addEventListener('click', function () { rdGenerateOrLoadPart(partId); });
        if (fallbackBtn) fallbackBtn.addEventListener('click', function () {
          rd.usingGenerated = false;
          rdSetStaticHeaderControlsVisible(true);
          var switcherBar = rdEl('glReadingPartSwitcher');
          if (switcherBar) switcherBar.style.display = 'none';
          rdLoadSet(RD_SETS[rd.setIndex % RD_SETS.length]);
          rdRenderText();
          rdRenderQuestion();
        });
      }

      // Race-safe like lsGenerateOrLoadPart: captures rd._genRequestToken at
      // call time and re-checks it before applying either outcome, so a
      // stale response from a superseded part-switch or retry can never
      // clobber newer state.
      function rdGenerateOrLoadPart(partId) {
        var myToken = ++rd._genRequestToken;
        rd._lastGenFailed = false;
        var profileId = rdResolveProfileId();
        if (!profileId) return Promise.resolve(false);
        rd.usingGenerated = true;
        rd.partId = partId;
        var panel = rdEl('glReadingQuestionPanel');
        if (panel) panel.innerHTML = '<div class="gl-listen-loading">Generating your verified exam exercise…</div>';
        var textPanel = rdEl('glReadingTextPanel');
        if (textPanel) textPanel.innerHTML = '';
        // Never let this race ahead of a just-checked part's results save —
        // weakness computation (which drives adaptive generation) reads from
        // the same table that save writes to.
        return rdEnsureResultsSaved().then(function () {
          if (myToken !== rd._genRequestToken) return null;
          return _glRunGeneration(rd, 'exam', panel,
            { start: 'Creating your reading exercise…' },
            _glExamRequest({ profileId: profileId, module: 'reading', partId: partId, mode: 'adaptive_practice' }));
        }).then(function (envelope) {
          if (envelope === null) return false;
          if (myToken !== rd._genRequestToken) return false;
          rdLoadGeneratedPart(envelope);
          rdRenderGeneratedWorkspace();
          rdUpdateGeneratedPartSwitcher();
          return true;
        }).catch(function (err) {
          if (myToken !== rd._genRequestToken) return false;
          if (typeof console !== 'undefined' && console.warn) console.warn('[Lesen] generation failed.', err);
          rd._lastGenFailed = true;
          rdShowGenerationError(partId);
          return false;
        });
      }

      function rdLoadGeneratedPart(envelope) {
        var part = envelope.part || {};
        var exam = envelope.exam || {};
        rd.content = envelope.content || {};
        rd.examFamily = exam.family || null;
        rd.examVariant = exam.variant || null;
        rd.examDisplayName = exam.displayName || null;
        rd.targetLevel = exam.cefrLevel || exam.variant || null;
        rd.profileId = exam.profileId || null;
        rd.profileVersion = exam.profileVersion || null;
        rd.module = envelope.module || 'reading';
        rd.partId = part.id || rd.partId;
        rd.generationId = envelope.generationId || null;
        rd.topicLabel = (envelope.topic && envelope.topic.label) || '';
        rd.genAnswers = {};
        rd.genChecked = false;
      }

      function rdGapPlaceholder(text) {
        // Turns the LLM's inline "{{gapId}}" markers into a real <select>
        // per gap, populated with all candidates (click-to-assign baseline
        // per spec — a native <select> is the most accessible form of
        // "click to assign"; drag/drop is an enhancement, not built here).
        var candidates = (rd.content && rd.content.candidates) || [];
        var letters = RD_LETTERS;
        return _glEscape(text).replace(/\{\{(g\d+)\}\}/g, function (_m, gapId) {
          var selected = rd.genAnswers[gapId] || '';
          var options = '<option value="">…</option>' + candidates.map(function (c, idx) {
            var sel = c.candidateId === selected ? ' selected' : '';
            return '<option value="' + _glEscape(c.candidateId) + '"' + sel + '>' + (letters[idx] || '?') + '</option>';
          }).join('');
          return '<select class="gl-reading-gap-select" data-gap-id="' + _glEscape(gapId) + '"' +
            (rd.genChecked ? ' disabled' : '') + '>' + options + '</select>';
        });
      }

      function rdRenderTextReconstruction() {
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (!textPanel || !qPanel) return;
        var text = rd.content.text || {};
        var candidates = rd.content.candidates || [];
        var letters = RD_LETTERS;
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(rdGeneratedHeader()) +
          (rd.topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(rd.topicLabel) + '</span>' : '') + '</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(text.title || '') + '</h3>' +
          '<div class="gl-reading-text-body">' +
          (text.paragraphs || []).map(function (p) { return '<p>' + rdGapPlaceholder(p) + '</p>'; }).join('') +
          '</div>' +
          '<div class="gl-reading-candidate-legend"><strong>Candidate sentences:</strong><ul>' +
          candidates.map(function (c, idx) {
            return '<li>' + (letters[idx] || '?') + ') ' + _glEscape(c.text) + '</li>';
          }).join('') + '</ul></div>';
        qPanel.innerHTML = rdCheckButtonHtml();
        rdWireGapSelects();
        rdWireCheckButton();
      }

      function rdWireGapSelects() {
        document.querySelectorAll('.gl-reading-gap-select').forEach(function (sel) {
          if (sel._rdWired) return;
          sel._rdWired = true;
          sel.addEventListener('change', function () {
            rd.genAnswers[sel.getAttribute('data-gap-id')] = sel.value || null;
          });
        });
      }

      function rdRenderSectionMatching() {
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (!textPanel || !qPanel) return;
        var sections = rd.content.sections || [];
        var letters = 'ABCDEFGH';
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(rdGeneratedHeader()) +
          (rd.topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(rd.topicLabel) + '</span>' : '') + '</div>' +
          sections.map(function (s, idx) {
            return '<div class="gl-reading-section"><h4>' + (letters[idx] || '?') + '</h4><p>' + _glEscape(s.text) + '</p></div>';
          }).join('');
        var options = '<option value="">…</option>' + sections.map(function (s, idx) {
          return '<option value="' + _glEscape(s.sectionId) + '">' + (letters[idx] || '?') + '</option>';
        }).join('');
        qPanel.innerHTML =
          (rd.content.questions || []).map(function (q, idx) {
            var selected = rd.genAnswers[q.questionId] || '';
            return '<div class="gl-reading-statement">' +
              '<p><strong>' + (idx + 1) + '.</strong> ' + _glEscape(q.statement) + '</p>' +
              '<select class="gl-reading-section-select" data-question-id="' + _glEscape(q.questionId) + '"' +
              (rd.genChecked ? ' disabled' : '') + '>' +
              options.replace('value="' + selected + '"', 'value="' + selected + '" selected') +
              '</select></div>';
          }).join('') + rdCheckButtonHtml();
        document.querySelectorAll('.gl-reading-section-select').forEach(function (sel) {
          if (sel._rdWired) return;
          sel._rdWired = true;
          sel.addEventListener('change', function () {
            rd.genAnswers[sel.getAttribute('data-question-id')] = sel.value || null;
          });
        });
        rdWireCheckButton();
      }

      function rdRenderDetailGlobal() {
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (!textPanel || !qPanel) return;
        var text = rd.content.text || {};
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(rdGeneratedHeader()) +
          (rd.topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(rd.topicLabel) + '</span>' : '') + '</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(text.title || '') + '</h3>' +
          '<div class="gl-reading-text-body">' +
          (text.paragraphs || []).map(function (p) {
            return '<p data-paragraph-id="' + _glEscape(p.paragraphId) + '">' + _glEscape(p.text) + '</p>';
          }).join('') + '</div>';
        var questions = rd.content.questions || [];
        var details = questions.filter(function (q) { return q.kind === 'detail'; });
        var headingQ = questions.filter(function (q) { return q.kind === 'global_heading'; })[0];
        var tristateLabels = [['richtig', 'Richtig'], ['falsch', 'Falsch'], ['nicht_im_text', 'Nicht im Text']];
        var html = details.map(function (q, idx) {
          var selected = rd.genAnswers[q.questionId] || '';
          return '<div class="gl-reading-statement">' +
            '<p><strong>' + (idx + 1) + '.</strong> ' + _glEscape(q.statement) + '</p>' +
            '<div class="gl-reading-tristate" data-question-id="' + _glEscape(q.questionId) + '">' +
            tristateLabels.map(function (pair) {
              var checked = selected === pair[0] ? ' checked' : '';
              return '<label><input type="radio" name="tristate-' + _glEscape(q.questionId) + '" value="' + pair[0] + '"' +
                checked + (rd.genChecked ? ' disabled' : '') + '> ' + pair[1] + '</label>';
            }).join('') + '</div></div>';
        }).join('');
        if (headingQ) {
          var heading = headingQ.heading || {};
          var headingSelected = rd.genAnswers[headingQ.questionId] || '';
          html += '<div class="gl-reading-statement gl-reading-global-heading">' +
            '<p><strong>Global heading:</strong> which title best summarizes the whole text?</p>' +
            (heading.options || []).map(function (o) {
              var checked = headingSelected === o.headingId ? ' checked' : '';
              return '<label><input type="radio" name="heading-' + _glEscape(headingQ.questionId) + '" value="' +
                _glEscape(o.headingId) + '"' + checked + (rd.genChecked ? ' disabled' : '') + '> ' + _glEscape(o.text) + '</label>';
            }).join('') + '</div>';
        }
        qPanel.innerHTML = html + rdCheckButtonHtml();
        qPanel.querySelectorAll('input[type="radio"]').forEach(function (input) {
          if (input._rdWired) return;
          input._rdWired = true;
          input.addEventListener('change', function () {
            var group = input.closest('[data-question-id]');
            var qid = group ? group.getAttribute('data-question-id') : (input.name.indexOf('heading-') === 0 ? headingQ.questionId : null);
            if (qid) rd.genAnswers[qid] = input.value;
          });
        });
        rdWireCheckButton();
      }

      // reading_detail_mc3 — one article, N three-option comprehension items (renders identically for
      // every exam whose task has this shape; nothing here knows which exam it is).
      function rdRenderDetailMc3() {
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (!textPanel || !qPanel) return;
        var text = rd.content.text || {};
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(rdGeneratedHeader()) +
          (rd.topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(rd.topicLabel) + '</span>' : '') + '</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(text.title || '') + '</h3>' +
          '<div class="gl-reading-text-body">' +
          (text.paragraphs || []).map(function (p) {
            return '<p data-paragraph-id="' + _glEscape(p.paragraphId) + '">' + _glEscape(p.text) + '</p>';
          }).join('') + '</div>';
        var letters = 'abcdefgh';
        qPanel.innerHTML = (rd.content.questions || []).map(function (q, idx) {
          var mc3 = q.mc3 || {};
          var selected = rd.genAnswers[q.questionId];
          return '<div class="gl-reading-statement gl-reading-mc3" data-question-id="' + _glEscape(q.questionId) + '">' +
            '<p><strong>' + (idx + 1) + '.</strong> ' + _glEscape(mc3.stem || '') + '</p>' +
            (mc3.options || []).map(function (opt, i) {
              var cls = '';
              if (rd.genChecked) {
                if (i === mc3.correctIndex) cls = ' gl-reading-opt-correct';
                else if (selected === i) cls = ' gl-reading-opt-wrong';
              }
              return '<label class="gl-reading-mc3-option' + cls + '"><input type="radio" name="mc3-' + _glEscape(q.questionId) + '" value="' + i + '"' +
                (selected === i ? ' checked' : '') + (rd.genChecked ? ' disabled' : '') + '> <span>' + (letters[i] || '?') + ')</span> ' + _glEscape(opt) + '</label>';
            }).join('') + '</div>';
        }).join('') + rdCheckButtonHtml();
        qPanel.querySelectorAll('input[type="radio"]').forEach(function (input) {
          if (input._rdWired) return;
          input._rdWired = true;
          input.addEventListener('change', function () {
            var group = input.closest('[data-question-id]');
            if (group) rd.genAnswers[group.getAttribute('data-question-id')] = parseInt(input.value, 10);
          });
        });
        rdWireCheckButton();
      }

      function rdGradeDetailMc3() {
        var results = {};
        (rd.content.questions || []).forEach(function (q) {
          results[q.questionId] = { correct: rd.genAnswers[q.questionId] === (q.mc3 || {}).correctIndex, skillTags: q.skillTags || [] };
        });
        return results;
      }

      // multi_author_statement_matching_with_none — several short texts by different authors; every statement
      // is matched to exactly one author or to "nobody". The letters and the "no author" choice come from the
      // content (authorId / 'none'), not from any exam.
      function rdRenderMultiAuthor() {
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (!textPanel || !qPanel) return;
        var text = rd.content.text || {};
        var authors = text.authors || [];
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(rdGeneratedHeader()) +
          (rd.topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(rd.topicLabel) + '</span>' : '') + '</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(text.title || '') + '</h3>' +
          '<div class="gl-reading-text-body">' + authors.map(function (a) {
            return '<section class="gl-reading-author" data-author-id="' + _glEscape(a.authorId) + '">' +
              '<h4>' + _glEscape(String(a.authorId || '').toUpperCase()) + ' — ' + _glEscape(a.name || '') + '</h4>' +
              '<p>' + _glEscape(a.text || '') + '</p></section>';
          }).join('') + '</div>';
        var choices = authors.map(function (a) {
          return { id: a.authorId, label: String(a.authorId || '').toUpperCase() };
        }).concat([{ id: 'none', label: 'Keine Person' }]);
        qPanel.innerHTML = (rd.content.questions || []).map(function (q, idx) {
          var selected = rd.genAnswers[q.questionId] || '';
          return '<div class="gl-reading-statement gl-reading-multi-author" data-question-id="' + _glEscape(q.questionId) + '">' +
            '<p><strong>' + (idx + 1) + '.</strong> ' + _glEscape(q.statement) + '</p>' +
            '<div class="gl-reading-author-choices">' + choices.map(function (c) {
              var cls = '';
              if (rd.genChecked) {
                if (c.id === q.correctAuthorId) cls = ' gl-reading-opt-correct';
                else if (selected === c.id) cls = ' gl-reading-opt-wrong';
              }
              return '<label class="gl-reading-mc3-option' + cls + '"><input type="radio" name="author-' + _glEscape(q.questionId) +
                '" value="' + _glEscape(c.id) + '"' + (selected === c.id ? ' checked' : '') + (rd.genChecked ? ' disabled' : '') +
                '> ' + _glEscape(c.label) + '</label>';
            }).join('') + '</div></div>';
        }).join('') + rdCheckButtonHtml();
        qPanel.querySelectorAll('input[type="radio"]').forEach(function (input) {
          if (input._rdWired) return;
          input._rdWired = true;
          input.addEventListener('change', function () {
            var group = input.closest('[data-question-id]');
            if (group) rd.genAnswers[group.getAttribute('data-question-id')] = input.value;
          });
        });
        rdWireCheckButton();
      }

      function rdGradeMultiAuthor() {
        var results = {};
        (rd.content.questions || []).forEach(function (q) {
          results[q.questionId] = { correct: rd.genAnswers[q.questionId] === q.correctAuthorId, skillTags: q.skillTags || [] };
        });
        return results;
      }

      function rdCheckButtonHtml() {
        if (rd.genChecked) {
          return '<div class="gl-reading-result-summary">' + _glEscape(rd._lastGenScoreLabel || '') + '</div>';
        }
        return '<button type="button" id="glReadingCheckGenerated" class="gl-listen-end-btn gl-listen-end-btn-primary">Check answers</button>';
      }

      function rdWireCheckButton() {
        var btn = rdEl('glReadingCheckGenerated');
        if (btn && !btn._rdWired) { btn._rdWired = true; btn.addEventListener('click', rdCheckGeneratedAnswers); }
      }

      var RD_GENERATED_RENDERERS = {
        text_reconstruction_sentence_matching: rdRenderTextReconstruction,
        section_statement_matching: rdRenderSectionMatching,
        detail_tristate_with_global_heading: rdRenderDetailGlobal,
        reading_detail_mc3: rdRenderDetailMc3,
        multi_author_statement_matching_with_none: rdRenderMultiAuthor
      };

      function rdRenderGeneratedWorkspace() {
        var renderer = RD_GENERATED_RENDERERS[rd._activeTaskType];
        if (renderer) renderer();
      }

      // ── Grading (one screen per part, checked all at once — matches the
      // real exam's per-part scoring; no per-item hint/retry loop for v1) ──

      function rdGradeTextReconstruction() {
        var questions = rd.content.questions || [];
        var results = {};
        questions.forEach(function (q) {
          var given = rd.genAnswers[q.gapId];
          results[q.questionId] = { correct: given === q.correctCandidateId, skillTags: q.skillTags || [] };
        });
        return results;
      }

      function rdGradeSectionMatching() {
        var results = {};
        (rd.content.questions || []).forEach(function (q) {
          var given = rd.genAnswers[q.questionId];
          results[q.questionId] = { correct: given === q.correctSectionId, skillTags: q.skillTags || [] };
        });
        return results;
      }

      function rdGradeDetailGlobal() {
        var results = {};
        (rd.content.questions || []).forEach(function (q) {
          var given = rd.genAnswers[q.questionId];
          var expected = q.kind === 'detail' ? (q.tristate || {}).answer : (q.heading || {}).correctHeadingId;
          results[q.questionId] = { correct: given === expected, skillTags: q.skillTags || [] };
        });
        return results;
      }

      var RD_GENERATED_GRADERS = {
        text_reconstruction_sentence_matching: rdGradeTextReconstruction,
        section_statement_matching: rdGradeSectionMatching,
        detail_tristate_with_global_heading: rdGradeDetailGlobal,
        reading_detail_mc3: rdGradeDetailMc3,
        multi_author_statement_matching_with_none: rdGradeMultiAuthor
      };

      function rdCheckGeneratedAnswers() {
        var grader = RD_GENERATED_GRADERS[rd._activeTaskType];
        if (!grader) return;
        var results = grader();
        var ids = Object.keys(results);
        var correctCount = ids.filter(function (id) { return results[id].correct; }).length;
        rd.genChecked = true;
        rd._lastGenScoreLabel = 'Score: ' + correctCount + ' / ' + ids.length;
        rdRenderGeneratedWorkspace();
        rdSaveGeneratedResults(results);
      }

      // Tracked on rd._resultsSavePromise (mirrors ls._resultsSavePromise/
      // lsEnsureResultsSaved) rather than pure fire-and-forget: a learner
      // who checks answers and immediately switches part/weak-areas must
      // never have that generate/weaknesses call race ahead of this save —
      // weakness computation reads from the same table this POST writes to.
      // module='reading', no replay/transcript concept — those fields stay
      // null. Single-attempt model for v1 (no hint/retry loop yet), so
      // firstAttemptCorrect === finalCorrect for every item.
      function rdSaveGeneratedResults(results) {
        var items = Object.keys(results).map(function (id) {
          var r = results[id];
          return {
            profileId: rd.profileId, profileVersion: rd.profileVersion, module: 'reading', partId: rd.partId,
            taskType: rd._activeTaskType, itemId: id, skillTags: r.skillTags, difficulty: 'c1',
            attemptCount: 1, firstAttemptCorrect: r.correct, finalCorrect: r.correct, hintLevel: 0,
            replayCount: null, transcriptRevealed: null,
            scoreValue: r.correct ? rdPointsPerCorrect() : 0, maxScoreValue: rdPointsPerCorrect(), metadata: { generationId: rd.generationId }
          };
        });
        if (!items.length) return Promise.resolve();
        rd._resultsSavePromise = _authFetch(BACKEND_URL + '/api/ai/german-exam/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            examFamily: rd.examFamily, examVariant: rd.examVariant, targetLevel: rd.targetLevel,
            module: 'reading', items: items
          })
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Lesen] failed to save results.', err);
        }).then(function () { rd._resultsSavePromise = null; });
        return rd._resultsSavePromise;
      }

      // Awaited by rdGenerateOrLoadPart/rdShowWeakAreas before firing their
      // own request, so a just-checked part's results are always committed
      // before the next adaptive generation or weakness read can race ahead.
      function rdEnsureResultsSaved() {
        return rd._resultsSavePromise || Promise.resolve();
      }

      // ── Part switcher (dynamically injected — no static markup needed in
      // practice.html, mirrors the spirit of lsWirePartSwitcher/
      // lsUpdatePartSwitcher without depending on pre-existing buttons) ──

      function rdEnsureGeneratedSwitcher() {
        var workspace = rdEl('glReadingWorkspace');
        if (!workspace || rdEl('glReadingPartSwitcher')) return;
        var bar = document.createElement('div');
        bar.className = 'gl-listen-part-switcher';
        bar.id = 'glReadingPartSwitcher';
        bar.innerHTML = rdParts().map(function (p) {
          return '<button type="button" class="gl-listen-part-btn" data-part-id="' + _glEscape(p.id) + '"' +
            (p.implemented ? '' : ' disabled title="Coming soon"') + '>' + _glEscape(rdPartLabel(p.id)) + '</button>';
        }).join('') + '<button type="button" class="gl-listen-part-btn" data-weak-areas="1">Weak areas</button>' +
          '<button type="button" class="gl-listen-part-btn" data-new-test="1">New Test</button>';
        workspace.parentNode.insertBefore(bar, workspace);
        bar.addEventListener('click', function (e) {
          if (e.target.closest('[data-weak-areas]')) { rdShowWeakAreas(); return; }
          if (e.target.closest('[data-new-test]')) { rdStartNewTest(); return; }
          var btn = e.target.closest('[data-part-id]');
          if (!btn) return;
          var partId = btn.getAttribute('data-part-id');
          if (rd.usingGenerated && rd.partId === partId) return;
          if (!rdTaskTypeFor(partId) || (rdPart(partId) && !rdPart(partId).implemented)) return;
          rd._activeTaskType = rdTaskTypeFor(partId);
          rdGenerateOrLoadPart(partId);
        });
      }

      // New Test: discards the current part's envelope/answers/grading
      // state and forces a completely fresh lesen_1 generation, always
      // resetting back to lesen_1 regardless of which part was active —
      // never a re-render of the part that's already loaded.
      // rdGenerateOrLoadPart() already bumps rd._genRequestToken
      // (invalidating any in-flight request) and always calls the backend,
      // which mints a new generationId per call.
      function rdStartNewTest() {
        var oldGenerationId = rd.generationId;
        rd.content = null;
        rd.genAnswers = {};
        rd.genChecked = false;
        rd._lastGenScoreLabel = null;
        rd.generationId = null;
        var firstPartId = rdFirstPartId();
        if (!firstPartId) return;
        rd._activeTaskType = rdTaskTypeFor(firstPartId);
        rdGenerateOrLoadPart(firstPartId).then(function () {
          if (!rd._lastGenFailed && typeof console !== 'undefined' && console.assert) {
            console.assert(rd.generationId !== oldGenerationId, '[Lesen] New Test did not produce a new generationId');
          }
          rdUpdateGeneratedPartSwitcher();
        });
      }

      function rdUpdateGeneratedPartSwitcher() {
        var bar = rdEl('glReadingPartSwitcher');
        if (!bar) return;
        bar.querySelectorAll('[data-part-id]').forEach(function (btn) {
          btn.classList.toggle('active', rd.usingGenerated && rd.partId === btn.getAttribute('data-part-id'));
        });
      }

      // Same endpoint/shape as Hören's Weak Areas tab — module='reading'
      // instead of 'listening'. No separate reading weakness API.
      function rdShowWeakAreas() {
        var profileId = rdResolveProfileId();
        if (!profileId) return;
        var textPanel = rdEl('glReadingTextPanel');
        var qPanel = rdEl('glReadingQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (qPanel) qPanel.innerHTML = '<div class="gl-listen-loading">Loading weak areas…</div>';
        rdEnsureResultsSaved().then(function () {
          return _authFetch(BACKEND_URL + '/api/ai/german-exam/weaknesses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileId: profileId, module: 'reading' })
          });
        }).then(function (resp) {
          if (!resp.ok) throw new Error('weaknesses_http_' + resp.status);
          return resp.json();
        }).then(function (data) {
          if (!qPanel) return;
          var tags = (data && data.tags) || {};
          var rows = Object.keys(tags).map(function (tag) {
            var t = tags[tag];
            return '<li><strong>' + _glEscape(tag) + '</strong>: score ' + Math.round((t.score || 0) * 100) +
              '% (' + (t.nAttempts || 0) + ' attempts, ' + _glEscape(t.confidence || '') + ' confidence)</li>';
          }).join('');
          qPanel.innerHTML = rows
            ? '<div class="gl-reading-weak-areas"><h4>Weak areas (Lesen)</h4><ul>' + rows + '</ul></div>'
            : '<div class="gl-reading-weak-areas"><p>Not enough attempts yet to show weak areas.</p></div>';
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Lesen] failed to load weak areas.', err);
          if (qPanel) qPanel.innerHTML = '<div class="gl-reading-weak-areas"><p>Couldn’t load weak areas right now.</p></div>';
        });
      }

      // Entry point for the generated path — called instead of the static
      // rdLoadSet() flow when a supported exam profile resolves. Never
      // silently substitutes static content for a supported profile whose
      // generation failed (matches Hören's explicit-error convention);
      // static RD_SETS remain the fallback only when no profile resolves.
      window._glReadingDebugState = function () {
        var questions = (rd.content && rd.content.questions) || [];
        return {
          usingGenerated: rd.usingGenerated,
          partId: rd.partId,
          module: rd.module,
          taskType: rd._activeTaskType,
          questionCount: questions.length,
          genRequestToken: rd._genRequestToken,
          genChecked: rd.genChecked,
          generationId: rd.generationId
        };
      };

      function rdOpenGeneratedView(partId) {
        rd._activeTaskType = rdTaskTypeFor(partId);
        rdEnsureGeneratedSwitcher();
        rdSetStaticHeaderControlsVisible(false); // static tabs + B2/Mixed selects don't apply to the generated path
        rdEl('glReadingWorkspace').style.display = '';
        rdEl('glReadingEnd').style.display = 'none';
        var switcherBar = rdEl('glReadingPartSwitcher');
        if (switcherBar) switcherBar.style.display = '';
        rdGenerateOrLoadPart(partId);
      }

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

      // Shown instead of static RD_SETS while the profile fetch is still in
      // flight — never silently falls back to static content just because
      // applyProfile() hasn't run yet. Cleared by rdOpenGeneratedView (once
      // a supported profile resolves) or by the definitive-unsupported path
      // in window._glOpenReadingView.
      function rdShowWaitingForProfile() {
        rd._awaitingProfile = true;
        rdSetStaticHeaderControlsVisible(false);
        var switcherBar = rdEl('glReadingPartSwitcher');
        if (switcherBar) switcherBar.style.display = 'none';
        rdEl('glReadingWorkspace').style.display = '';
        rdEl('glReadingEnd').style.display = 'none';
        var textPanel = rdEl('glReadingTextPanel');
        var panel = rdEl('glReadingQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (panel) panel.innerHTML = '<div class="gl-listen-loading">Loading your exam profile…</div>';
      }

      window._glOpenReadingView = function () {
        try { _glSyncLevelSelects(); } catch (e) { /* non-fatal */ }
        rd.tab = 'practice';
        rdRenderTabs();
        rdRenderFilesPanel(false);
        rdWireHeader();
        var profileId = rdResolveProfileId();
        var _rdExam = window._glExamState && window._glExamState();
        if (profileId && _rdExam && (_rdExam.status === 'loading' || _rdExam.status === 'idle')) {
          // The exam's structure (its parts) is still loading: never open with another exam's part list.
          rdShowWaitingForProfile();
          if (typeof window._glExamOnReady === 'function') {
            window._glExamOnReady(function () { if (_glActiveSkill === 'reading') window._glOpenReadingView(); });
          }
          return;
        }
        if (profileId) {
          rd._awaitingProfile = false;
          var openPartId = rd.partId && rdTaskTypeFor(rd.partId) && rdPart(rd.partId).implemented ? rd.partId : rdFirstPartId();
          if (!openPartId) { rdShowWaitingForProfile(); return; }
          rdOpenGeneratedView(openPartId);
          return;
        }
        if (!window._germanProfileLoaded) {
          // Profile hasn't resolved yet — this is NOT the same as a
          // definitively unsupported profile. Show a loading state and let
          // the ss-profile-updated listener below retry once it resolves.
          rdShowWaitingForProfile();
          return;
        }
        rd._awaitingProfile = false;
        rd.usingGenerated = false;
        rdSetStaticHeaderControlsVisible(true);
        var staleSwitcher = rdEl('glReadingPartSwitcher');
        if (staleSwitcher) staleSwitcher.style.display = 'none';
        rdLoadSet(RD_SETS[rd.setIndex % RD_SETS.length]);
        rdEl('glReadingWorkspace').style.display = '';
        rdEl('glReadingEnd').style.display = 'none';
        rdRenderText();
        rdRenderQuestion();
      };

      // Retries opening Lesen once the profile finishes loading, but only if
      // Lesen is still the open skill and was actually left waiting (never
      // fires for a view that already resolved profileId or already fell
      // back to a definitively-unsupported static state) — so this can
      // never itself trigger a duplicate generation request.
      window.addEventListener('ss-profile-updated', function () {
        if (!rd._awaitingProfile) return;
        rd._awaitingProfile = false;
        if (_glActiveSkill !== 'reading') return;
        window._glOpenReadingView();
      });

      window._glRegisterProfileReset(function (nextProfileId) {
        rd.genToken++; rd._genRequestToken++;
        var _rdSwitcher = rdEl('glReadingPartSwitcher'); // rebuilt from the new exam's manifest on next open
        if (_rdSwitcher && _rdSwitcher.parentNode) _rdSwitcher.parentNode.removeChild(_rdSwitcher);
        if (rd.profileId && rd.profileId !== nextProfileId) {
          rd.usingGenerated = false; rd.profileId = null; rd.profileVersion = null; rd.generationId = null;
          rd.content = null; rd.genAnswers = {}; rd.genChecked = false; rd.partId = null; rd._lastGenFailed = false;
        }
      });

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
        var files;
        try { files = await (await _glLearnerFiles()).listLearnerFiles(); }
        catch (e) { wrap.textContent = 'Could not load your files. Reopen this tab to retry.'; return; }

        var listHtml = files.length
          ? files.map(function (f) {
              return '<label class="gl-rd-file-row" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);margin-bottom:6px">' +
                '<input type="radio" name="glReadingFile" value="' + _glEscape(f.id) + '">' +
                '<span style="flex:1;font-size:.82rem;font-weight:700;color:rgba(255,255,255,.8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _glEscape(f.name || f.file_name || 'German file') + '</span>' +
                '</label>';
            }).join('')
          : '<div class="gl-reading-empty">No German files uploaded yet. Upload a document in Files.</div>';

        wrap.innerHTML =
          '<h3 class="widget-title" style="margin:0 0 10px">Choose a file to turn into a reading exercise</h3>' +
          '<div id="glReadingFileList">' + listHtml + '</div>' +
          '<div class="gl-reading-files-config">' +
          '<label>Questions<select id="glReadingCfgCount"><option>3</option><option selected>5</option><option>8</option></select></label>' +
          '<label>Difficulty<select id="glReadingCfgLevel">' + _glLevelOptionsHtml() + '</select></label>' +
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
        var file = files.find(function (item) { return item.id === chosen.value; });
        if (!file) return;
        var fname = file.documentName;
        var level = rdEl('glReadingCfgLevel') && rdEl('glReadingCfgLevel').value ? rdEl('glReadingCfgLevel').value : _glProfileLevel();
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
          var bytes = await (await _glLearnerFiles()).readLearnerFile(file);
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

    // ── Sprachbausteine (telc C1 Hochschule cloze) ────────────────────────────
    // Dedicated workspace, same shared-German-Exam-Engine pattern as Lesen/
    // Hören (generate -> deterministic+semantic verified content -> render ->
    // check -> save results), but simpler: exactly one part
    // (sprachbausteine_1), one continuous text with inline four-option gap
    // selects (visually identical to Lesen Teil 1's gap-select cloze, reusing
    // its gl-reading-* CSS classes). There is NO static/sample fallback
    // content for this module — a genuinely unsupported profile shows an
    // explicit message instead of silently substituting something else.
    // Lives entirely inside #glSprachbausteineView (see practice.html) and is
    // only mounted when _glOpenSkill('sprachbausteine') runs.
    (function () {
      var sb = {
        tab: 'practice',
        usingGenerated: false,
        partId: 'sprachbausteine_1',
        examFamily: null, examVariant: null, targetLevel: null,
        profileId: null, profileVersion: null, generationId: null,
        content: null, // raw envelope.content
        genAnswers: {}, // gapId -> chosen option index (int) or null
        genChecked: false,
        _genRequestToken: 0,
        _lastGenFailed: false,
        // Mirrors rd._awaitingProfile/ls._awaitingProfile — true while this
        // view is open and waiting on the profile fetch (window.
        // _germanProfileLoaded still false), not yet a definitive
        // "no supported profile" verdict.
        _awaitingProfile: false,
        _resultsSavePromise: null,
        _lastGenScoreLabel: null,
        // Explicit UI state, set by every function that writes into
        // #glSprachbausteineTextPanel/#glSprachbausteineQuestionPanel — see
        // sbWatchdogCheck(), which uses this (and the actual DOM) to catch
        // any code path that leaves the workspace open with neither a
        // loading message, generated content, nor an error/unsupported
        // card: 'profile_loading' | 'generating' | 'ready' | 'unsupported' | 'error'.
        uiState: null
      };

      function sbEl(id) { return document.getElementById(id); }

      // Deliberately separate from rdResolveProfileId()/lsResolveProfileId()
      // (siblings, private IIFEs) rather than sharing them — same rationale
      // as Lesen's copy: isolates any risk of touching another module's code
      // path. Keep this fallback table in sync with the other two, with
      // GERMAN_EXAM_PROFILES_CLIENT in user-data.ts, and with the backend's
      // GERMAN_EXAM_PROFILES registry.
      // Single source: the shared accessor derives the id from the
      // authoritative (test, level) pair — no per-module resolver/table.
      function sbResolveProfileId() {
        var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
        return (p && p.examProfileId) || null;
      }

      function sbGeneratedHeader() {
        return 'telc C1 Hochschule · C1 · Sprachbausteine';
      }

      function sbShowWaitingForProfile() {
        sb.uiState = 'profile_loading';
        sb._awaitingProfile = true;
        var tabs = sbEl('glSprachbausteineTabs');
        if (tabs) tabs.style.display = 'none';
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (qPanel) qPanel.innerHTML = '<div class="gl-listen-loading">Loading your exam profile…</div>';
        sbArmWatchdog();
      }

      // Shown only once the profile has DEFINITIVELY loaded (window.
      // _germanProfileLoaded is true) and is genuinely unsupported — there is
      // no static Sprachbausteine content to fall back to, unlike Lesen/Hören.
      function sbShowUnsupportedProfile() {
        sb.uiState = 'unsupported';
        var tabs = sbEl('glSprachbausteineTabs');
        if (tabs) tabs.style.display = 'none';
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (qPanel) {
          // Neutral product copy, not an error: no exam-format blueprint is
          // registered for this (test, level) pair yet. Wortschatz, Grammatik,
          // Writing Coach and file practice are unaffected.
          var gp = window.getGermanLearnerProfile ? window.getGermanLearnerProfile() : null;
          var gLabel = gp && gp.testFamily ? (gp.testFamily + (gp.targetLevel ? ' ' + gp.targetLevel : '')) : '';
          qPanel.innerHTML = '<div class="gl-listen-weak-empty">' + (gLabel
            ? 'Exam-format practice for ' + _glEscape(gLabel) + ' is not available yet.'
            : 'Choose your exam and target level in Profile to unlock exam-format practice.') + '</div>';
        }
      }

      // Distinct from sbShowUnsupportedProfile(): this fires when the
      // profiles fetch itself failed/timed out (window._profileResolutionState
      // === 'error'), which is not proof the account has no supported exam
      // profile — see user-data.ts's beginProfileResolution/loadUserData.
      // Retry re-triggers the shared profile resolver, not generation.
      function sbShowProfileError() {
        sb.uiState = 'profile_error';
        var tabs = sbEl('glSprachbausteineTabs');
        if (tabs) tabs.style.display = 'none';
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (!qPanel) return;
        qPanel.innerHTML =
          '<div class="gl-listen-error">' +
            '<p class="gl-listen-error-title">Couldn’t load your exam profile.</p>' +
            '<p class="gl-listen-error-sub">We couldn’t confirm your exam profile this time. Nothing was recorded — you can retry.</p>' +
            '<div class="gl-listen-error-actions">' +
              '<button type="button" id="glSprachbausteineProfileRetry" class="gl-listen-end-btn gl-listen-end-btn-primary">Retry</button>' +
            '</div>' +
          '</div>';
        var retryBtn = sbEl('glSprachbausteineProfileRetry');
        if (retryBtn) {
          retryBtn.addEventListener('click', function () {
            sb._awaitingProfile = true;
            sbShowWaitingForProfile();
            if (typeof window._ensureUserProfile === 'function') {
              window._ensureUserProfile({ force: true });
            }
          });
        }
      }

      function sbShowGenerationError() {
        sb.uiState = 'error';
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (!qPanel) return;
        qPanel.innerHTML =
          '<div class="gl-listen-error">' +
            '<p class="gl-listen-error-title">Couldn’t create your verified telc exercise.</p>' +
            '<p class="gl-listen-error-sub">Generation didn’t complete this time — nothing was recorded. You can retry.</p>' +
            _glFailNote() +
            '<div class="gl-listen-error-actions">' +
              '<button type="button" id="glSprachbausteineErrorRetry" class="gl-listen-end-btn gl-listen-end-btn-primary">Retry</button>' +
            '</div>' +
          '</div>';
        var retryBtn = sbEl('glSprachbausteineErrorRetry');
        if (retryBtn) retryBtn.addEventListener('click', function () { sbGenerateOrLoadPart(); });
      }

      // Watches for the one illegal state: the workspace visible with
      // NEITHER a loading message, generated content, NOR an error/
      // unsupported card — i.e. neither of sbShowWaitingForProfile/
      // sbGenerateOrLoadPart's "Generating…"/sbRenderWorkspace/
      // sbShowUnsupportedProfile/sbShowGenerationError actually landed
      // anything visible. This is defense-in-depth for whatever code path
      // produces that (a future bug, an unhandled edge case) — the user
      // must never be left staring at a blank workspace with no way
      // forward. Re-armed on every profile_loading/generating transition;
      // a state that already shows content is self-evidently not blank so
      // nothing re-arms after 'ready'/'unsupported'/'error'.
      var SB_WATCHDOG_DELAY_MS = 2200;
      var sbWatchdogTimer = null;
      function sbArmWatchdog() {
        if (sbWatchdogTimer) clearTimeout(sbWatchdogTimer);
        sbWatchdogTimer = setTimeout(sbWatchdogCheck, SB_WATCHDOG_DELAY_MS);
      }
      function sbWatchdogCheck() {
        sbWatchdogTimer = null;
        if (_glActiveSkill !== 'sprachbausteine') return;
        var view = sbEl('glSprachbausteineView');
        if (!view || view.style.display === 'none') return;
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        var combinedHtml = ((textPanel && textPanel.innerHTML) || '') + ((qPanel && qPanel.innerHTML) || '');
        var hasLegalContent = /gl-listen-loading|gl-listen-generating|gl-listen-weak-empty|gl-listen-error|gl-reading-text-title/.test(combinedHtml);
        if (hasLegalContent) return;
        if (typeof console !== 'undefined' && console.error) {
          console.error('[Sprachbausteine] illegal blank state detected', {
            uiState: sb.uiState,
            profileLoaded: window._germanProfileLoaded,
            profileId: sbResolveProfileId(),
            germanTest: window._germanTest,
            germanLevel: window._germanLevel,
            genRequestToken: sb._genRequestToken
          });
        }
        sbShowGenerationError();
      }

      // Race-safe like rdGenerateOrLoadPart/lsGenerateOrLoadPart: captures
      // sb._genRequestToken at call time and re-checks it before applying
      // either outcome, so a stale response from a superseded retry/leave
      // can never clobber newer state.
      function sbGenerateOrLoadPart() {
        var myToken = ++sb._genRequestToken;
        sb._lastGenFailed = false;
        var profileId = sbResolveProfileId();
        if (!profileId) return Promise.resolve(false);
        sb.usingGenerated = true;
        sb.uiState = 'generating';
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        if (textPanel) textPanel.innerHTML = '';
        if (qPanel) qPanel.innerHTML = '<div class="gl-listen-generating">Generating your verified telc exercise…</div>';
        sbArmWatchdog();
        return _glRunGeneration(sb, 'exam', qPanel,
          { start: 'Creating your Sprachbausteine exercise…' },
          _glExamRequest({ profileId: profileId, module: 'language_elements', partId: sb.partId, mode: 'adaptive_practice' })
        ).then(function (envelope) {
          if (myToken !== sb._genRequestToken) return false;
          // Defensive: a malformed envelope (unexpected shape from a
          // half-broken generation) must surface as the same explicit
          // error+Retry state as a network/HTTP failure, never a blank
          // panel — sbRenderWorkspace() now throws instead of silently
          // returning on missing prerequisites, and that throw is caught
          // below by the same .catch that handles network/HTTP failures.
          sbLoadGeneratedPart(envelope);
          sbRenderWorkspace();
          sb.uiState = 'ready';
          return true;
        }).catch(function (err) {
          if (myToken !== sb._genRequestToken) return false;
          if (typeof console !== 'undefined' && console.warn) console.warn('[Sprachbausteine] generation failed.', err);
          sb._lastGenFailed = true;
          sbShowGenerationError();
          return false;
        });
      }

      function sbLoadGeneratedPart(envelope) {
        var exam = envelope.exam || {};
        sb.content = envelope.content || {};
        sb.examFamily = exam.family || null;
        sb.examVariant = exam.variant || null;
        sb.targetLevel = exam.cefrLevel || exam.variant || null;
        sb.profileId = exam.profileId || null;
        sb.profileVersion = exam.profileVersion || null;
        sb.generationId = envelope.generationId || null;
        sb.genAnswers = {};
        sb.genChecked = false;
      }

      function sbGapPlaceholder(text) {
        var questionsByGap = {};
        (sb.content.questions || []).forEach(function (q) { questionsByGap[q.gapId] = q; });
        var letters = 'ABCD';
        return _glEscape(text).replace(/\{\{(g\d+)\}\}/g, function (_m, gapId) {
          var q = questionsByGap[gapId];
          if (!q) return _m;
          var selected = sb.genAnswers[gapId];
          var options = '<option value="">…</option>' + (q.options || []).map(function (opt, idx) {
            var sel = selected === idx ? ' selected' : '';
            return '<option value="' + idx + '"' + sel + '>' + (letters[idx] || '?') + ') ' + _glEscape(opt) + '</option>';
          }).join('');
          return '<select class="gl-reading-gap-select" data-gap-id="' + _glEscape(gapId) + '"' +
            (sb.genChecked ? ' disabled' : '') + '>' + options + '</select>';
        });
      }

      function sbCheckButtonHtml() {
        if (sb.genChecked) {
          return '<div class="gl-reading-result-summary">' + _glEscape(sb._lastGenScoreLabel || '') + '</div>';
        }
        return '<button type="button" id="glSprachbausteineCheck" class="gl-listen-end-btn gl-listen-end-btn-primary">Check answers</button>';
      }

      function sbWireCheckButton() {
        var btn = sbEl('glSprachbausteineCheck');
        if (btn && !btn._sbWired) { btn._sbWired = true; btn.addEventListener('click', sbCheckGeneratedAnswers); }
      }

      function sbWireGapSelects() {
        document.querySelectorAll('#glSprachbausteineTextPanel .gl-reading-gap-select').forEach(function (sel) {
          if (sel._sbWired) return;
          sel._sbWired = true;
          sel.addEventListener('change', function () {
            var v = sel.value;
            sb.genAnswers[sel.getAttribute('data-gap-id')] = v === '' ? null : parseInt(v, 10);
          });
        });
      }

      function sbRenderWorkspace() {
        var textPanel = sbEl('glSprachbausteineTextPanel');
        var qPanel = sbEl('glSprachbausteineQuestionPanel');
        // A silent `return` here used to be able to leave the workspace
        // exactly as the caller found it — including mid-"Generating…" or
        // even blank — with nothing to signal that render never happened.
        // Throwing routes this through sbGenerateOrLoadPart's existing
        // .catch, which always lands on the explicit Retry/error state.
        if (!textPanel || !qPanel || !sb.content) {
          throw new Error(
            '[Sprachbausteine] render prerequisites missing: textPanel=' + !!textPanel +
            ' qPanel=' + !!qPanel + ' content=' + !!sb.content
          );
        }
        var text = sb.content.text || {};
        textPanel.innerHTML =
          '<div class="gl-reading-text-eyebrow">' + _glEscape(sbGeneratedHeader()) + '</div>' +
          '<h3 class="gl-reading-text-title">' + _glEscape(text.title || '') + '</h3>' +
          '<div class="gl-reading-text-body">' +
          (text.paragraphs || []).map(function (p) { return '<p>' + sbGapPlaceholder(p) + '</p>'; }).join('') +
          '</div>';
        qPanel.innerHTML = sbCheckButtonHtml();
        sbWireGapSelects();
        sbWireCheckButton();
      }

      function sbCheckGeneratedAnswers() {
        var questions = sb.content.questions || [];
        var results = {};
        questions.forEach(function (q) {
          var given = sb.genAnswers[q.gapId];
          results[q.questionId] = { correct: given === q.correctIndex, skillTags: q.skillTags || [] };
        });
        var ids = Object.keys(results);
        var correctCount = ids.filter(function (id) { return results[id].correct; }).length;
        sb.genChecked = true;
        sb._lastGenScoreLabel = 'Score: ' + correctCount + ' / ' + ids.length;
        sbRenderWorkspace();
        sbSaveGeneratedResults(results);
      }

      // Tracked on sb._resultsSavePromise (mirrors rd/ls's own pattern)
      // rather than fire-and-forget: a learner who checks and immediately
      // switches to Weak areas must never have that weaknesses read race
      // ahead of this save. Single-attempt model (no hint/retry loop), so
      // firstAttemptCorrect === finalCorrect for every item.
      function sbSaveGeneratedResults(results) {
        var items = Object.keys(results).map(function (id) {
          var r = results[id];
          return {
            profileId: sb.profileId, profileVersion: sb.profileVersion, module: 'language_elements', partId: sb.partId,
            taskType: 'cloze_mc4_language_elements', itemId: id, skillTags: r.skillTags, difficulty: 'c1',
            attemptCount: 1, firstAttemptCorrect: r.correct, finalCorrect: r.correct, hintLevel: 0,
            replayCount: null, transcriptRevealed: null,
            scoreValue: r.correct ? 1 : 0, maxScoreValue: 1, metadata: { generationId: sb.generationId }
          };
        });
        if (!items.length) return Promise.resolve();
        sb._resultsSavePromise = _authFetch(BACKEND_URL + '/api/ai/german-exam/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            examFamily: sb.examFamily, examVariant: sb.examVariant, targetLevel: sb.targetLevel,
            module: 'language_elements', items: items
          })
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Sprachbausteine] failed to save results.', err);
        }).then(function () { sb._resultsSavePromise = null; });
        return sb._resultsSavePromise;
      }

      function sbEnsureResultsSaved() {
        return sb._resultsSavePromise || Promise.resolve();
      }

      function sbFetchWeaknesses() {
        var panel = sbEl('glSprachbausteineWeakPanel');
        // sb.profileId is only set once a generated part has loaded; a timed-out
        // or still-pending generation leaves it null and the endpoint rejects a
        // null profileId with 400. Fall back to the learner's resolved profile
        // and never fetch without one.
        var weakProfileId = sb.profileId || sbResolveProfileId();
        if (!weakProfileId) {
          if (panel) panel.innerHTML = '<div class="gl-reading-weak-areas"><p>Weak areas appear once you have completed a Sprachbausteine exercise.</p></div>';
          return Promise.resolve();
        }
        if (panel) panel.innerHTML = '<div class="gl-listen-generating">Loading your weak areas…</div>';
        return sbEnsureResultsSaved().then(function () {
          return _authFetch(BACKEND_URL + '/api/ai/german-exam/weaknesses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileId: weakProfileId, module: 'language_elements' })
          });
        }).then(function (resp) {
          if (!resp.ok) throw new Error('weaknesses_http_' + resp.status);
          return resp.json();
        }).then(function (data) {
          if (!panel) return;
          var tags = (data && data.tags) || {};
          var rows = Object.keys(tags).map(function (tag) {
            var t = tags[tag];
            return '<li><strong>' + _glEscape(tag) + '</strong>: score ' + Math.round((t.score || 0) * 100) +
              '% (' + (t.nAttempts || 0) + ' attempts, ' + _glEscape(t.confidence || '') + ' confidence)</li>';
          }).join('');
          panel.innerHTML = rows
            ? '<div class="gl-reading-weak-areas"><h4>Weak areas (Sprachbausteine)</h4><ul>' + rows + '</ul></div>'
            : '<div class="gl-reading-weak-areas"><p>Not enough attempts yet to show weak areas.</p></div>';
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Sprachbausteine] failed to load weak areas.', err);
          if (panel) panel.innerHTML = '<div class="gl-reading-weak-areas"><p>Couldn’t load weak areas right now.</p></div>';
        });
      }

      function sbSetTab(tab) {
        sb.tab = tab;
        document.querySelectorAll('#glSprachbausteineTabs .gl-reading-tab').forEach(function (btn) {
          var active = btn.getAttribute('data-sb-tab') === tab;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        var workspace = sbEl('glSprachbausteineWorkspace');
        var weakPanel = sbEl('glSprachbausteineWeakPanel');
        if (tab === 'weak') {
          if (workspace) workspace.style.display = 'none';
          if (weakPanel) weakPanel.style.display = '';
          sbFetchWeaknesses();
        } else {
          if (weakPanel) weakPanel.style.display = 'none';
          if (workspace) workspace.style.display = '';
        }
      }

      function sbWireHeader() {
        var tabsWrap = sbEl('glSprachbausteineTabs');
        if (tabsWrap && !tabsWrap._sbWired) {
          tabsWrap._sbWired = true;
          tabsWrap.addEventListener('click', function (e) {
            var btn = e.target.closest('.gl-reading-tab');
            if (!btn) return;
            sbSetTab(btn.getAttribute('data-sb-tab'));
          });
        }
        var newTestBtn = sbEl('glSprachbausteineNewTest');
        if (newTestBtn && !newTestBtn._sbWired) {
          newTestBtn._sbWired = true;
          newTestBtn.addEventListener('click', sbStartNewTest);
        }
      }

      // New Test: discards the current envelope/answers/grading state and
      // forces a completely fresh sprachbausteine_1 generation — never a
      // re-render of what's already loaded. sbGenerateOrLoadPart() already
      // bumps sb._genRequestToken (invalidating any in-flight request) and
      // always calls the backend, which mints a new generationId per call;
      // this just guarantees no stale local state (old answers/checked
      // score) survives to be shown alongside the new content.
      function sbStartNewTest() {
        var oldGenerationId = sb.generationId;
        sb.content = null;
        sb.genAnswers = {};
        sb.genChecked = false;
        sb._lastGenScoreLabel = null;
        sb.generationId = null;
        sbSetTab('practice');
        sbGenerateOrLoadPart().then(function (ok) {
          if (ok && typeof console !== 'undefined' && console.assert) {
            console.assert(sb.generationId !== oldGenerationId, '[Sprachbausteine] New Test did not produce a new generationId');
          }
        });
      }

      window._glSprachbausteineDebugState = function () {
        var questions = (sb.content && sb.content.questions) || [];
        return {
          usingGenerated: sb.usingGenerated,
          questionCount: questions.length,
          genRequestToken: sb._genRequestToken,
          genChecked: sb.genChecked,
          generationId: sb.generationId
        };
      };

      window._glOpenSprachbausteineView = function () {
        // Defensive wrapper: this view must always end in exactly one of
        // loading / generated exercise / unsupported-profile / generation-
        // error — never a blank panel, even on an unexpected exception in
        // profile resolution or tab wiring (see sbGenerateOrLoadPart's own
        // catch for exceptions during/after the network call).
        try {
          sb.tab = 'practice';
          sbSetTab('practice');
          sbWireHeader();
          var profileId = sbResolveProfileId();
          if (profileId) {
            sb._awaitingProfile = false;
            sbGenerateOrLoadPart();
            return;
          }
          var resolutionState = window._profileResolutionState;
          if (resolutionState === 'error') {
            // The profiles fetch itself failed — this is NOT a verdict about
            // whether the account has a supported exam profile. Never show
            // "unsupported" here; show a retryable profile-load error.
            sb._awaitingProfile = false;
            sbShowProfileError();
            return;
          }
          if (resolutionState !== 'ready') {
            // Profile hasn't resolved yet — this is NOT the same as a
            // definitively unsupported profile. Show a loading state and let
            // the ss-profile-updated listener below retry once it resolves.
            sbShowWaitingForProfile();
            return;
          }
          sb._awaitingProfile = false;
          sbShowUnsupportedProfile();
        } catch (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Sprachbausteine] failed to open view.', err);
          sbShowGenerationError();
        }
      };

      window._glRegisterProfileReset(function (nextProfileId) {
        sb._genRequestToken++;
        if (sb.profileId && sb.profileId !== nextProfileId) {
          sb.usingGenerated = false; sb.profileId = null; sb.profileVersion = null; sb.generationId = null;
          sb.content = null; sb.genAnswers = {}; sb.genChecked = false; sb._lastGenFailed = false;
          sb._resultsSavePromise = null;
        }
      });

      // Retries opening Sprachbausteine once the profile finishes loading,
      // mirroring Lesen's/Hören's ss-profile-updated listeners. Guarded the
      // same way: only fires if this view was actually left waiting and is
      // still the open skill, so it can never cause a duplicate generate call.
      window.addEventListener('ss-profile-updated', function () {
        // An open "unsupported" card also recovers once a Profile save makes
        // the profile resolve — no hard refresh needed.
        var recoverFromUnsupported = sb.uiState === 'unsupported' && !!sbResolveProfileId();
        if (!sb._awaitingProfile && !recoverFromUnsupported) return;
        sb._awaitingProfile = false;
        if (_glActiveSkill !== 'sprachbausteine') return;
        window._glOpenSprachbausteineView();
      });
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
        tab: 'practice', topic: 'verbPosition', level: _glProfileLevel(),
        queue: [], index: 0, score: 0, answers: {}, hintLevel: {}, tries: {},
        orderBuilt: {}, orderPool: {}, selected: {}, _lastUser: {},
        sample: false, _gen: 0, _busy: false, seen: []
      };

      function gmEl(id) { return document.getElementById(id); }
      _glOnLevelSync.push(function (profileChanged) {
        var sel = gmEl('glGramLevel');
        gm.level = sel && sel.value ? sel.value : _glProfileLevel();
        if (profileChanged && gmEl('glGramTopic')) gmBuildTopicSelect();
      });

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
        var list = GM_TOPICS.concat(/^(C1|C2)/.test(gm.level) ? GM_TOPICS_C1 : []);
        sel.innerHTML = list.map(function (t) {
          return '<option value="' + t.id + '">' + _glEscape(t.label) + '</option>';
        }).join('');
        if (list.some(function (t) { return t.id === prev; })) sel.value = prev;
        else { sel.value = list[0].id; gm.topic = list[0].id; }
      }

      // Offline sample bank — only ever shown behind an explicit "sample practice"
      // label, never as the normal AI-generated path.
      function gmPickExercises(topic, count) {
        return (GM_BANK[topic] || []).slice(0, count);
      }

      function gmTopicLabel(id) {
        return (GM_ALL_TOPICS.filter(function (t) { return t.id === id; })[0] || {}).label || id;
      }

      function gmExPrompt(ex) {
        return ex.promptHtml || ex.answer || ex.sentenceWrong || ex.sentenceA || (ex.originalLines || []).join(' ') || '';
      }

      function gmWeakLabels() {
        var stats = gmStatsLoad();
        return Object.keys(stats).filter(function (t) {
          return stats[t].total >= 2 && stats[t].correct / stats[t].total < 0.6;
        }).map(gmTopicLabel).slice(0, 5);
      }

      function gmBeginQueue(items, sample) {
        gm.queue = items;
        gm.sample = !!sample;
        gm.index = 0;
        gm.score = 0;
        gm.answers = {};
        gm.hintLevel = {};
        gm.tries = {};
        gm.orderBuilt = {};
        gm.orderPool = {};
        gm.selected = {};
        gm._lastUser = {};
        if (!sample) gm.seen = gm.seen.concat(items.map(gmExPrompt)).slice(-40);
        gmEl('glGramEnd').style.display = 'none';
        gmEl('glGramWorkspace').style.display = '';
        gmRenderExercise();
      }

      function gmShowPanel(html) {
        gm.queue = [];
        gmEl('glGramEnd').style.display = 'none';
        gmEl('glGramWorkspace').style.display = '';
        var label = gmEl('glGramProgressLabel');
        var fill = gmEl('glGramProgressFill');
        if (label) label.textContent = '';
        if (fill) fill.style.width = '0%';
        gmEl('glGramExercise').innerHTML = html;
        gmEl('glGramFeedback').innerHTML = '';
      }

      function gmShowStart() {
        gm._gen++;
        gm._busy = false;
        if (gm._run) { gm._run.cancel(); gm._run = null; }
        gmShowPanel('<div class="gl-gram-files-empty"><div class="gl-gram-ex-eyebrow">Grammatik</div>' +
          '<p class="gl-gram-ex-prompt">' + _glEscape(gmTopicLabel(gm.topic)) + ' · ' + _glEscape(gm.level) + '</p>' +
          '<div class="gl-gram-ex-actions"><button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramStartBtn">Start practice</button></div></div>');
        gmEl('glGramStartBtn').addEventListener('click', function () { gmStartQueue(gm.topic, 10); });
      }

      // Generates a fresh AI set. opts.documentIds / opts.topicLabel switch to "From my files".
      async function gmStartQueue(topic, count, opts) {
        var token = ++gm._gen;
        gm._busy = true;
        gmShowPanel('');
        var payload = {
          module: 'grammar', level: gm.level, count: count || 10,
          topic: opts && opts.topicLabel ? opts.topicLabel : gmTopicLabel(topic),
          sourceDocumentIds: opts && opts.documentIds ? opts.documentIds : undefined,
          avoidPrompts: gm.seen.slice(-30), weakAreas: gmWeakLabels()
        };
        try {
          var data = await _glRunGeneration(gm, 'practice', gmEl('glGramExercise'), null,
            function (signal) { return _glGeneratePractice(payload, signal); });
          if (token !== gm._gen) return;
          gmBeginQueue(data.items, false);
        } catch (e) {
          if (token !== gm._gen) return; // superseded: the newer request owns the UI
          if (e && e.code === 'cancelled') { gmShowStart(); return; }
          var timedOut = e && (e.code === 'timeout' || e.status === 504);
          gmShowPanel('<div class="gl-gram-files-empty"><div class="gl-gram-fb-title">' +
            (timedOut ? 'Generation took too long.' : 'Couldn\'t create practice.') + '</div>' +
            (e && e.userMessage ? '<p>' + _glEscape(e.userMessage) + '</p>' : '') +
            (e && e.reference ? '<p>Reference: ' + _glEscape(e.reference) + '</p>' : '') +
            '<div class="gl-gram-ex-actions">' +
            '<button type="button" class="gl-gram-btn gl-gram-btn-primary" id="glGramRetryBtn">' + (timedOut ? 'Try again' : 'Retry') + '</button>' +
            (!opts && GM_BANK[topic] ? '<button type="button" class="gl-gram-btn gl-gram-btn-ghost" id="glGramSampleBtn">Use sample practice</button>' : '') +
            '</div></div>');
          gmEl('glGramRetryBtn').addEventListener('click', function () { gmStartQueue(topic, count, opts); });
          var sb2 = gmEl('glGramSampleBtn');
          if (sb2) sb2.addEventListener('click', function () { gmBeginQueue(gmPickExercises(topic, count || 10), true); });
        } finally {
          if (token === gm._gen) gm._busy = false;
        }
      }

      window._glOpenGrammarView = function () {
        try { _glSyncLevelSelects(); } catch (e) { /* non-fatal */ }
        gm.tab = 'practice';
        gm.level = _glLearnerLevel(gm.level);
        var lvSel = gmEl('glGramLevel');
        if (lvSel) lvSel.value = gm.level;
        gmBuildTopicSelect();
        gmRenderTabs();
        gmSetTabView('practice');
        gmShowStart();
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
            if (gm.tab === 'practice') gmShowStart();
          });
        }
        if (levelSel && !levelSel._gmWired) {
          levelSel._gmWired = true;
          levelSel.addEventListener('change', function () {
            gm.level = levelSel.value;
            gmBuildTopicSelect();
            if (gm.tab === 'practice') gmShowStart();
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
          if (!gm.queue.length && !gm._busy && !gmEl('glGramRetryBtn')) gmShowStart();
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
        gmEl('glGramExercise').innerHTML = (gm.sample ? '<div class="gl-sample-banner">Sample practice — AI generation unavailable</div>' : '') + gmExerciseHtml(ex, answer);
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
        var prompt = 'Explain this German grammar rule in a short, clear way for a ' + (gm.level || 'German') + ' learner: "' + ex.rule.focus + '". ' +
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
        var files;
        try { files = await (await _glLearnerFiles()).listLearnerFiles(); }
        catch (e) { wrap.textContent = 'Could not load your files. Reopen this tab to retry.'; return; }
        if (!files.length) {
          wrap.innerHTML = '<div class="gl-gram-files-empty">No German files uploaded yet. Upload a document in Files.</div>';
          return;
        }
        wrap.innerHTML =
          '<div class="gl-gram-files-title">Choose a file to practice grammar from</div>' +
          '<div id="glGramFileList">' +
          files.map(function (f) {
            var name = f.name || f.file_name || 'German file';
            return '<label class="gl-gram-file-row"><input type="radio" name="glGramFile" value="' + _glEscape(f.id) + '"><span>' + _glEscape(name) + '</span></label>';
          }).join('') +
          '</div>' +
          '<div class="gl-gram-files-detect" id="glGramDetect" style="display:none"></div>' +
          '<div class="gl-gram-files-config">' +
          '<label>Difficulty<select id="glGramCfgLevel">' + _glLevelOptionsHtml() + '</select></label>' +
          '<label>Exercises<select id="glGramCfgCount"><option>5</option><option selected>10</option><option>15</option></select></label>' +
          '<button type="button" class="gl-gram-start-btn" id="glGramFilesStart" disabled>Start practice</button>' +
          '</div>';

        document.querySelectorAll('input[name="glGramFile"]').forEach(function (radio) {
          radio.addEventListener('change', function () {
            var file = files.find(function (item) { return item.id === radio.value; });
            if (file) gmOnFileChosen(file);
          });
        });
      }

      async function gmOnFileChosen(file) {
        var fname = file.documentName;
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
            var bytes = await (await _glLearnerFiles()).readLearnerFile(file);
            detected = gmDetectTopics(new TextDecoder().decode(bytes));
          } catch (e) { /* fall through to default topics */ }
        }
        var selectedFile = document.querySelector('input[name="glGramFile"]:checked');
        if (!selectedFile || selectedFile.value !== file.id) return;
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
          startBtn.onclick = function () { gmStartFromFile(file); };
        }
      }

      // Generation runs server-side from the file Minallo already indexed —
      // the browser only sends the document id, never the file bytes.
      async function gmStartFromFile(file) {
        var level = gmEl('glGramCfgLevel') ? gmEl('glGramCfgLevel').value : gm.level;
        var count = parseInt(gmEl('glGramCfgCount') ? gmEl('glGramCfgCount').value : '10', 10) || 10;
        if (!file.documentId) {
          if (typeof showToast === 'function') showToast('File not indexed yet', 'Open Files and let this file finish indexing first.');
          return;
        }
        gm.level = level;
        var labels = gmChosenTopics.map(gmTopicLabel).join(', ');
        gmSetTabView('practice');
        await gmStartQueue(gm.topic, count, {
          documentIds: [file.documentId],
          topicLabel: labels ? 'Grammar from the learner\'s own document, focusing on: ' + labels : 'Grammar from the learner\'s own document'
        });
      }
    })();

    // ── Wortschatz (vocabulary in context) ────────────────────────────────────
    // Dedicated workspace, distinct from the generic quiz/cards template and
    // from Lesen/Grammatik's layouts. Every exercise requires understanding or
    // actively using a word in context — this is deliberately NOT a flashcard
    // tool: no card flip, no passive recall, no "Generate Cards". Lives
    // entirely inside #glVocabularyView (see practice.html) and is only
    // mounted when _glOpenSkill('vocab') runs.
    (function () {
      var VC_TOPICS = [
        { id: 'everyday', label: 'Alltag & Zuhause' },
        { id: 'university', label: 'Uni & Studium' },
        { id: 'work', label: 'Arbeit & Beruf' },
        { id: 'travel', label: 'Reisen & Verkehr' },
        { id: 'feelings', label: 'Gefühle & Beziehungen' },
        { id: 'health', label: 'Gesundheit' }
      ];
      var VC_TOPICS_C1 = [
        { id: 'media', label: 'Medien & Technik' },
        { id: 'society', label: 'Umwelt & Gesellschaft' }
      ];
      var VC_ALL_TOPICS = VC_TOPICS.concat(VC_TOPICS_C1);

      // Every exercise carries a "note" (focus/think/why/mainRule/example),
      // mirroring Grammatik's "rule" shape, so the feedback/hint rendering
      // functions below can stay structurally identical to gm's.
      var VC_BANK = {
        everyday: [
          { type: 'context', promptHtml: 'Ich muss noch ein paar Sachen ___, bevor wir losfahren.', accepted: ['erledigen'],
            note: { focus: '"erledigen" — to take care of / handle', think: 'What do you do to tasks or errands before leaving?', why: '"erledigen" means to complete or take care of a task — it is the natural verb for chores/errands, not "machen".', mainRule: 'etwas erledigen = to get something done', example: 'Ich muss noch Einkäufe erledigen.' },
            hints: ['Think of "get it done", not just "do it".', 'The verb starts with "er-".'] },
          { type: 'choice', promptHtml: 'Die ___ für die Wohnung ist diesen Monat gestiegen.', options: ['Miete', 'Mitte', 'Mieter', 'Mühe'], answerIndex: 0,
            note: { focus: '"die Miete" — rent', think: 'Which word means the monthly payment for an apartment?', why: '"die Miete" is rent; "die Mitte" (middle), "der Mieter" (tenant) and "die Mühe" (effort) all look similar but mean something else.', mainRule: 'die Miete (rent) ≠ der Mieter (tenant)', example: 'Die Miete muss bis zum 3. bezahlt werden.' },
            hints: ['Not the person who rents — the payment itself.', 'It rhymes with "die Mitte" but means something different.'] }
        ],
        university: [
          { type: 'context', promptHtml: 'Ich muss die Hausarbeit bis Freitag ___.', accepted: ['abgeben'],
            note: { focus: '"abgeben" — to hand in / submit', think: 'What do you do with an assignment when it is finished?', why: '"abgeben" is the standard verb for submitting coursework, not "geben" alone.', mainRule: 'eine Arbeit abgeben = to submit an assignment', example: 'Wir müssen das Referat nächste Woche abgeben.' },
            hints: ['It is a separable verb: "ab-" + "geben".', 'Think "hand something in", not just "give".'] },
          { type: 'use', word: 'die Vorlesung', meaning: 'lecture', promptHtml: 'Write a sentence about your day using "die Vorlesung".',
            note: { focus: '"die Vorlesung" — lecture', think: 'A "Vorlesung" is a large lecture, not a small seminar.', why: '"Vorlesung" (lecture) is distinct from "Seminar" (seminar) and "Übung" (exercise class) in German university structure.', mainRule: 'die Vorlesung besuchen / in der Vorlesung sein', example: 'Ich habe heute um 10 Uhr eine Vorlesung.' },
            hints: ['Try a sentence like "Ich habe eine Vorlesung um ..."', 'It is feminine: "die Vorlesung".'] }
        ],
        work: [
          { type: 'choice', promptHtml: 'Ich möchte mich für die Stelle als Ingenieur ___.', options: ['bewerben', 'beweisen', 'bewahren', 'befragen'], answerIndex: 0,
            note: { focus: '"sich bewerben" — to apply (for a job)', think: 'Which verb means "to apply for a position"?', why: '"sich bewerben (um/für)" is the fixed reflexive verb for job applications.', mainRule: 'sich bewerben für/um + Akkusativ', example: 'Sie bewirbt sich für ein Praktikum.' },
            hints: ['It is reflexive: "sich ___".', 'Related noun: "die Bewerbung" (application).'] },
          { type: 'context', promptHtml: 'Mein Chef hat mir mehr ___ für das Projekt gegeben.', accepted: ['verantwortung'],
            note: { focus: '"die Verantwortung" — responsibility', think: 'What do you gain when your boss trusts you with a bigger project?', why: '"Verantwortung" is the standard noun for professional responsibility.', mainRule: 'Verantwortung übernehmen/geben/tragen', example: 'Sie trägt viel Verantwortung in ihrer neuen Rolle.' },
            hints: ['It is a long compound-feeling noun ending in "-ung".', 'Related verb: "verantworten".'] }
        ],
        travel: [
          { type: 'context', promptHtml: 'Der Zug hat zwanzig Minuten ___.', accepted: ['verspätung'],
            note: { focus: '"die Verspätung" — delay', think: 'What is the word for a train arriving late?', why: '"Verspätung haben" is the fixed expression for being delayed.', mainRule: 'Verspätung haben = to be delayed', example: 'Der Flug hatte eine Stunde Verspätung.' },
            hints: ['The phrase is "... hat ... Verspätung".', 'Related adjective: "verspätet".'] },
          { type: 'choice', promptHtml: 'Wir müssen am Bahnhof ___, um den Anschlusszug zu bekommen.', options: ['umsteigen', 'aussteigen', 'einsteigen', 'umziehen'], answerIndex: 0,
            note: { focus: '"umsteigen" — to change trains/transfer', think: 'Which verb means switching from one train to another?', why: '"umsteigen" specifically means transferring between vehicles; "aussteigen" is just getting off, "umziehen" means moving house.', mainRule: 'umsteigen (in + Akkusativ) = to transfer', example: 'Wir steigen in München um.' },
            hints: ['It is a separable verb: "um-" + "steigen".', 'Not the same as just getting off ("aussteigen").'] }
        ],
        feelings: [
          { type: 'use', word: 'sich freuen auf', meaning: 'to look forward to', promptHtml: 'Write a sentence about something you are looking forward to, using "sich freuen auf".',
            note: { focus: '"sich freuen auf" — to look forward to', think: '"sich freuen auf" is used for something in the future.', why: '"sich freuen auf + Akkusativ" is for anticipating a future event; "sich freuen über" is for something already happened.', mainRule: 'sich freuen auf + Akkusativ (future) vs. über + Akkusativ (past/present)', example: 'Ich freue mich auf die Ferien.' },
            hints: ['Try "Ich freue mich auf ..."', 'Use it for something that has not happened yet.'] },
          { type: 'choice', promptHtml: 'Nach dem Streit war die Stimmung sehr ___.', options: ['angespannt', 'entspannt', 'aufgeregt', 'gelangweilt'], answerIndex: 0,
            note: { focus: '"angespannt" — tense', think: 'What is the mood like right after an argument?', why: '"angespannt" describes a tense, strained atmosphere; "entspannt" (relaxed) would be the opposite.', mainRule: 'die Stimmung ist angespannt/entspannt', example: 'Die Atmosphäre im Büro war angespannt.' },
            hints: ['It is the opposite of "entspannt".', 'Related noun: "die Spannung" (tension).'] }
        ],
        health: [
          { type: 'context', promptHtml: 'Ich habe starke Kopfschmerzen und muss einen Termin beim Arzt ___.', accepted: ['vereinbaren'],
            note: { focus: '"vereinbaren" — to arrange/schedule', think: 'What do you do with a doctor to get an appointment?', why: '"einen Termin vereinbaren" is the fixed collocation for scheduling an appointment.', mainRule: 'einen Termin vereinbaren = to schedule an appointment', example: 'Können wir einen Termin für nächste Woche vereinbaren?' },
            hints: ['Fixed phrase: "einen Termin ___".', 'It means to agree on/arrange, not just "make".'] },
          { type: 'choice', promptHtml: 'Der Arzt hat mir ein ___ gegen die Schmerzen verschrieben.', options: ['Medikament', 'Instrument', 'Dokument', 'Experiment'], answerIndex: 0,
            note: { focus: '"das Medikament" — medication', think: 'What does a doctor prescribe for pain?', why: '"Medikament" is medication; the other options are near-rhyming but unrelated words.', mainRule: 'ein Medikament verschreiben/nehmen/einnehmen', example: 'Sie nimmt jeden Morgen ein Medikament.' },
            hints: ['It rhymes with "Dokument" but means something you take when sick.', 'Related verb: "verschreiben" (to prescribe).'] }
        ],
        media: [
          { type: 'choice', promptHtml: 'Diese Nachricht hat sich sehr schnell in den sozialen Medien ___.', options: ['verbreitet', 'verbessert', 'verhindert', 'verschwunden'], answerIndex: 0,
            note: { focus: '"sich verbreiten" — to spread', think: 'What happens to news that goes viral?', why: '"sich verbreiten" means to spread/circulate — the natural verb for news or information spreading.', mainRule: 'sich verbreiten = to spread (news, information)', example: 'Gerüchte verbreiten sich schnell im Internet.' },
            hints: ['Related to "breit" (wide/broad).', 'Think of information becoming widespread.'] },
          { type: 'context', promptHtml: 'Viele Jugendliche verbringen zu viel Zeit vor dem ___.', accepted: ['bildschirm'],
            note: { focus: '"der Bildschirm" — screen', think: 'What device do people stare at too much?', why: '"Bildschirm" is the general word for a screen (phone, computer, TV).', mainRule: 'vor dem Bildschirm sitzen/sein', example: 'Er sitzt den ganzen Tag vor dem Bildschirm.' },
            hints: ['Compound word: "Bild" (image) + "Schirm" (screen/shield).', 'It is masculine: "der Bildschirm".'] }
        ],
        society: [
          { type: 'use', word: 'nachhaltig', meaning: 'sustainable', promptHtml: 'Write a sentence about protecting the environment using "nachhaltig".',
            note: { focus: '"nachhaltig" — sustainable', think: '"nachhaltig" describes something that does not harm long-term resources.', why: '"nachhaltig" is the standard adjective for environmental/economic sustainability.', mainRule: 'nachhaltig leben/produzieren/handeln', example: 'Wir sollten nachhaltiger leben.' },
            hints: ['Try "Wir sollten nachhaltiger ..."', 'It relates to "halten" (to last/hold).'] },
          { type: 'choice', promptHtml: 'Die Regierung will den CO2-___ deutlich senken.', options: ['Ausstoß', 'Ausflug', 'Ausdruck', 'Ausgang'], answerIndex: 0,
            note: { focus: '"der Ausstoß" — emissions/output', think: 'What does a government want to reduce for climate reasons?', why: '"CO2-Ausstoß" is the fixed term for carbon emissions.', mainRule: 'der Ausstoß (von + Dativ) = emissions/output of', example: 'Der CO2-Ausstoß der Industrie ist stark gestiegen.' },
            hints: ['It is a compound with "CO2-".', 'Related verb: "ausstoßen" (to emit).'] }
        ]
      };

      var vc = {
        tab: 'practice', topic: 'everyday', level: _glProfileLevel(),
        queue: [], index: 0, score: 0, answers: {}, hintLevel: {}, tries: {}, _lastUser: {},
        sample: false, _gen: 0, _busy: false, seen: []
      };

      function vcEl(id) { return document.getElementById(id); }
      _glOnLevelSync.push(function (profileChanged) {
        var sel = vcEl('glVocabLevel');
        vc.level = sel && sel.value ? sel.value : _glProfileLevel();
        if (profileChanged && vcEl('glVocabTopic')) vcBuildTopicSelect();
      });

      function vcNormalize(s) {
        return String(s == null ? '' : s).toLowerCase()
          .replace(/[.,!?;:"„“]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function vcWordCount(s) {
        return vcNormalize(s).split(' ').filter(Boolean).length;
      }

      // ── per-topic accuracy, tracked locally so "Weak areas" reflects real
      // practice history instead of a static mock. ────────────────────────
      function vcStatsLoad() {
        try { return JSON.parse(localStorage.getItem('ss_gl_vocab_stats') || '{}'); } catch (e) { return {}; }
      }
      function vcStatsSave(stats) {
        try { localStorage.setItem('ss_gl_vocab_stats', JSON.stringify(stats)); } catch (e) { /* ignore */ }
      }
      function vcStatsRecord(topic, correct) {
        var stats = vcStatsLoad();
        if (!stats[topic]) stats[topic] = { correct: 0, total: 0 };
        stats[topic].total++;
        if (correct) stats[topic].correct++;
        vcStatsSave(stats);
      }

      function vcBuildTopicSelect() {
        var sel = vcEl('glVocabTopic');
        if (!sel) return;
        var prev = vc.topic;
        var list = VC_TOPICS.concat(_glIsAdvancedLevel(vc.level) ? VC_TOPICS_C1 : []);
        sel.innerHTML = list.map(function (t) {
          return '<option value="' + t.id + '">' + _glEscape(t.label) + '</option>';
        }).join('');
        if (list.some(function (t) { return t.id === prev; })) sel.value = prev;
        else { sel.value = list[0].id; vc.topic = list[0].id; }
      }

      // Offline sample bank — only ever shown behind an explicit "sample practice"
      // label, never as the normal AI-generated path.
      function vcPickExercises(topic, count) {
        return (VC_BANK[topic] || []).slice(0, count);
      }

      function vcTopicLabel(id) {
        return (VC_ALL_TOPICS.filter(function (t) { return t.id === id; })[0] || {}).label || id;
      }

      function vcExPrompt(ex) { return ex.promptHtml || ex.word || ''; }

      function vcWeakLabels() {
        var stats = vcStatsLoad();
        return Object.keys(stats).filter(function (t) {
          return stats[t].total >= 2 && stats[t].correct / stats[t].total < 0.6;
        }).map(vcTopicLabel).slice(0, 5);
      }

      function vcBeginQueue(items, sample) {
        vc.queue = items;
        vc.sample = !!sample;
        vc.index = 0;
        vc.score = 0;
        vc.answers = {};
        vc.hintLevel = {};
        vc.tries = {};
        vc.selected = {};
        vc._lastUser = {};
        if (!sample) vc.seen = vc.seen.concat(items.map(vcExPrompt)).slice(-40);
        vcEl('glVocabEnd').style.display = 'none';
        vcEl('glVocabWorkspace').style.display = '';
        vcRenderExercise();
      }

      function vcShowPanel(html) {
        vc.queue = [];
        vcEl('glVocabEnd').style.display = 'none';
        vcEl('glVocabWorkspace').style.display = '';
        var label = vcEl('glVocabProgressLabel');
        var fill = vcEl('glVocabProgressFill');
        if (label) label.textContent = '';
        if (fill) fill.style.width = '0%';
        vcEl('glVocabExercise').innerHTML = html;
        vcEl('glVocabFeedback').innerHTML = '';
      }

      function vcShowStart() {
        vc._gen++;
        vc._busy = false;
        if (vc._run) { vc._run.cancel(); vc._run = null; }
        vcShowPanel('<div class="gl-vocab-files-empty"><div class="gl-vocab-ex-eyebrow">Wortschatz</div>' +
          '<p class="gl-vocab-ex-prompt">' + _glEscape(vcTopicLabel(vc.topic)) + ' · ' + _glEscape(vc.level) + '</p>' +
          '<div class="gl-vocab-ex-actions"><button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabStartBtn">Start practice</button></div></div>');
        vcEl('glVocabStartBtn').addEventListener('click', function () { vcStartQueue(vc.topic, 10); });
      }

      // Generates a fresh AI set. opts.documentIds switches to "From my files".
      async function vcStartQueue(topic, count, opts) {
        var token = ++vc._gen;
        vc._busy = true;
        vcShowPanel('');
        var payload = {
          module: 'vocabulary', level: vc.level, count: count || 10,
          topic: opts && opts.documentIds ? 'Vocabulary from the learner\'s own document' : vcTopicLabel(topic),
          sourceDocumentIds: opts && opts.documentIds ? opts.documentIds : undefined,
          avoidPrompts: vc.seen.slice(-30), weakAreas: vcWeakLabels()
        };
        try {
          var data = await _glRunGeneration(vc, 'practice', vcEl('glVocabExercise'), null,
            function (signal) { return _glGeneratePractice(payload, signal); });
          if (token !== vc._gen) return;
          vcBeginQueue(data.items, false);
        } catch (e) {
          if (token !== vc._gen) return; // superseded: the newer request owns the UI
          if (e && e.code === 'cancelled') { vcShowStart(); return; }
          var timedOut = e && (e.code === 'timeout' || e.status === 504);
          vcShowPanel('<div class="gl-vocab-files-empty"><div class="gl-vocab-fb-title">' +
            (timedOut ? 'Generation took too long.' : 'Couldn\'t create practice.') + '</div>' +
            (e && e.userMessage ? '<p>' + _glEscape(e.userMessage) + '</p>' : '') +
            (e && e.reference ? '<p>Reference: ' + _glEscape(e.reference) + '</p>' : '') +
            '<div class="gl-vocab-ex-actions">' +
            '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabRetryBtn">' + (timedOut ? 'Try again' : 'Retry') + '</button>' +
            (!opts && VC_BANK[topic] ? '<button type="button" class="gl-vocab-btn gl-vocab-btn-ghost" id="glVocabSampleBtn">Use sample practice</button>' : '') +
            '</div></div>');
          vcEl('glVocabRetryBtn').addEventListener('click', function () { vcStartQueue(topic, count, opts); });
          var sb2 = vcEl('glVocabSampleBtn');
          if (sb2) sb2.addEventListener('click', function () { vcBeginQueue(vcPickExercises(topic, count || 10), true); });
        } finally {
          if (token === vc._gen) vc._busy = false;
        }
      }

      window._glOpenVocabularyView = function () {
        try { _glSyncLevelSelects(); } catch (e) { /* non-fatal */ }
        vc.tab = 'practice';
        vc.level = _glLearnerLevel(vc.level);
        var lvSel = vcEl('glVocabLevel');
        if (lvSel) lvSel.value = vc.level;
        vcBuildTopicSelect();
        vcRenderTabs();
        vcSetTabView('practice');
        vcShowStart();
        vcWireHeader();
      };

      function vcWireHeader() {
        var tabsWrap = document.querySelector('.gl-vocab-tabs');
        if (tabsWrap && !tabsWrap._vcWired) {
          tabsWrap._vcWired = true;
          tabsWrap.addEventListener('click', function (e) {
            var btn = e.target.closest('.gl-vocab-tab');
            if (!btn) return;
            vcSetTabView(btn.getAttribute('data-vocab-tab'));
          });
        }
        var topicSel = vcEl('glVocabTopic');
        var levelSel = vcEl('glVocabLevel');
        if (topicSel && !topicSel._vcWired) {
          topicSel._vcWired = true;
          topicSel.addEventListener('change', function () {
            vc.topic = topicSel.value;
            if (vc.tab === 'practice') vcShowStart();
          });
        }
        if (levelSel && !levelSel._vcWired) {
          levelSel._vcWired = true;
          levelSel.addEventListener('change', function () {
            vc.level = levelSel.value;
            vcBuildTopicSelect();
            if (vc.tab === 'practice') vcShowStart();
          });
        }
      }

      function vcRenderTabs() {
        document.querySelectorAll('.gl-vocab-tab').forEach(function (btn) {
          var active = btn.getAttribute('data-vocab-tab') === vc.tab;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      }

      function vcSetTabView(tab) {
        vc.tab = tab;
        vcRenderTabs();
        vcEl('glVocabPractice').style.display = tab === 'practice' ? '' : 'none';
        vcEl('glVocabWeak').style.display = tab === 'weak' ? '' : 'none';
        vcEl('glVocabFiles').style.display = tab === 'files' ? '' : 'none';
        if (tab === 'practice') {
          if (!vc.queue.length && !vc._busy && !vcEl('glVocabRetryBtn')) vcShowStart();
        } else if (tab === 'weak') {
          vcRenderWeak();
        } else if (tab === 'files') {
          vcRenderFilesPanel();
        }
      }

      function vcCurrentEx() { return vc.queue[vc.index]; }

      function vcProgress() {
        var total = vc.queue.length;
        vcEl('glVocabProgressLabel').textContent = (vc.index + 1) + ' / ' + total;
        var pct = total ? Math.round(((vc.index) / total) * 100) : 0;
        vcEl('glVocabProgressFill').style.width = pct + '%';
      }

      function vcRenderExercise() {
        var ex = vcCurrentEx();
        if (!ex) return;
        vcProgress();
        var answer = vc.answers[vc.index];
        vcEl('glVocabExercise').innerHTML = (vc.sample ? '<div class="gl-sample-banner">Sample practice — AI generation unavailable</div>' : '') + vcExerciseHtml(ex, answer);
        vcWireExercise(ex, answer);
        vcEl('glVocabFeedback').innerHTML = answer ? vcFeedbackAfterHtml(ex, answer) : vcFeedbackBeforeHtml(ex);
        vcWireFeedback(ex, answer);
      }

      function vcExerciseHtml(ex, answer) {
        var locked = !!answer;

        if (ex.type === 'choice') {
          var sel = vc.selected && vc.selected[vc.index];
          return '<div class="gl-vocab-ex-eyebrow">Choose the correct word</div>' +
            '<p class="gl-vocab-ex-prompt">' + ex.promptHtml.replace('___', '<span class="gl-vocab-blank">___</span>') + '</p>' +
            '<div class="gl-vocab-options" id="glVocabOptions">' +
            ex.options.map(function (opt, i) {
              var cls = 'gl-vocab-option';
              if (locked) {
                if (i === ex.answerIndex) cls += ' gl-vocab-opt-correct';
                else if (i === answer.selectedIndex) cls += ' gl-vocab-opt-incorrect';
              } else if (sel === i) cls += ' gl-vocab-opt-selected';
              return '<button type="button" class="' + cls + '" data-i="' + i + '"' + (locked ? ' disabled' : '') + '>' + _glEscape(opt) + '</button>';
            }).join('') +
            '</div>' +
            '<div class="gl-vocab-ex-actions">' +
            '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabCheckBtn"' + (locked || sel == null ? ' disabled' : '') + '>Check answer →</button>' +
            '</div>';
        }

        if (ex.type === 'context') {
          return '<div class="gl-vocab-ex-eyebrow">Fill the gap in context</div>' +
            '<p class="gl-vocab-ex-prompt">' +
            ex.promptHtml.replace('___', '<input type="text" class="gl-vocab-inline-input" id="glVocabFreeInput"' + (locked ? ' disabled value="' + _glEscape(answer.userValue || '') + '"' : '') + '>') +
            '</p>' +
            '<div class="gl-vocab-ex-actions">' +
            '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabCheckBtn"' + (locked ? ' disabled' : '') + '>Check answer →</button>' +
            '</div>';
        }

        // 'use' — write your own sentence using the target word.
        return '<div class="gl-vocab-ex-eyebrow">Use this word in a sentence</div>' +
          '<div class="gl-vocab-target-word">' + _glEscape(ex.word) + ' <span class="gl-vocab-target-meaning">(' + _glEscape(ex.meaning) + ')</span></div>' +
          '<p class="gl-vocab-ex-instruction">' + _glEscape(ex.promptHtml) + '</p>' +
          '<textarea class="gl-vocab-textarea" id="glVocabFreeInput" placeholder="Type your sentence..."' + (locked ? ' disabled' : '') + '>' + (locked ? _glEscape(answer.userValue || '') : '') + '</textarea>' +
          '<div class="gl-vocab-ex-actions">' +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabCheckBtn"' + (locked ? ' disabled' : '') + '>Check answer →</button>' +
          '</div>';
      }

      function vcWireExercise(ex, answer) {
        var idx = vc.index;
        var locked = !!answer;
        if (ex.type === 'choice' && !locked) {
          if (!vc.selected) vc.selected = {};
          var optWrap = vcEl('glVocabOptions');
          if (optWrap) optWrap.querySelectorAll('.gl-vocab-option').forEach(function (btn) {
            btn.addEventListener('click', function () {
              vc.selected[idx] = Number(btn.getAttribute('data-i'));
              vcRenderExercise();
            });
          });
        }
        var checkBtn = vcEl('glVocabCheckBtn');
        if (checkBtn && !checkBtn.disabled) checkBtn.addEventListener('click', vcCheck);
      }

      function vcCheck() {
        var ex = vcCurrentEx();
        var idx = vc.index;
        var correct = false;
        var userDisplay = '';
        var selectedIndex = null;

        if (ex.type === 'choice') {
          selectedIndex = vc.selected && vc.selected[idx];
          if (selectedIndex == null) return;
          userDisplay = ex.options[selectedIndex];
          correct = selectedIndex === ex.answerIndex;
        } else if (ex.type === 'context') {
          var gi = vcEl('glVocabFreeInput');
          userDisplay = gi ? gi.value : '';
          if (!userDisplay.trim()) return;
          correct = ex.accepted.indexOf(vcNormalize(userDisplay)) !== -1;
        } else {
          // 'use': no server-side grader for free-text correctness — accept
          // when the target word appears and it reads as a real sentence,
          // and always surface a model example plus an "Explain this word"
          // AI hook for deeper feedback rather than overclaiming precision.
          var fi = vcEl('glVocabFreeInput');
          userDisplay = fi ? fi.value : '';
          if (!userDisplay.trim()) return;
          var targetWord = vcNormalize(ex.word.replace(/^(der|die|das|sich)\s+/i, ''));
          correct = vcNormalize(userDisplay).indexOf(targetWord) !== -1 && vcWordCount(userDisplay) >= 3;
        }

        vc._lastUser[idx] = userDisplay;

        if (correct) {
          vc.answers[idx] = { status: 'correct', userValue: userDisplay, selectedIndex: selectedIndex };
          vc.score++;
          vcStatsRecord(vc.topic, true);
          vcRenderExercise();
        } else {
          vc.tries[idx] = (vc.tries[idx] || 0) + 1;
          vcRenderPendingWrong(ex, userDisplay);
        }
      }

      function vcRenderPendingWrong(ex, userDisplay) {
        var fbWrap = vcEl('glVocabFeedback');
        fbWrap.innerHTML =
          '<div class="gl-vocab-fb gl-vocab-fb-incorrect">' +
          '<div class="gl-vocab-fb-title">Not quite.</div>' +
          (userDisplay ? '<div class="gl-vocab-fb-line">Your answer:<br><strong>' + _glEscape(userDisplay) + '</strong></div>' : '') +
          '<div class="gl-vocab-fb-actions">' +
          '<button type="button" class="gl-vocab-btn" id="glVocabTryAgain">Try again</button>' +
          '<button type="button" class="gl-vocab-btn" id="glVocabShowSolution">Show solution</button>' +
          '</div>' +
          '<div class="gl-vocab-fb-actions gl-vocab-fb-actions-secondary">' +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-ghost" id="glVocabExplainBtn">Explain this word</button>' +
          '</div>' +
          '</div>';
        vcEl('glVocabTryAgain').addEventListener('click', vcTryAgain);
        vcEl('glVocabShowSolution').addEventListener('click', vcShowSolution);
        vcEl('glVocabExplainBtn').addEventListener('click', function () { vcExplainWord(ex); });
      }

      function vcTryAgain() {
        var idx = vc.index;
        if (vc.selected) vc.selected[idx] = null;
        vcRenderExercise();
      }

      function vcShowSolution() {
        var idx = vc.index;
        vc.answers[idx] = { status: 'revealed', userValue: (vc._lastUser && vc._lastUser[idx]) || '', selectedIndex: vc.selected && vc.selected[idx] };
        vcStatsRecord(vc.topic, false);
        vcRenderExercise();
      }

      function vcFeedbackBeforeHtml(ex) {
        var hLevel = vc.hintLevel[vc.index] || 0;
        var hasHints = ex.hints && ex.hints.length;
        var hintsHtml = '';
        for (var i = 0; i < hLevel; i++) hintsHtml += '<div class="gl-vocab-hint-box">' + _glEscape(ex.hints[i]) + '</div>';
        var hintDisabled = !hasHints || hLevel >= ex.hints.length;
        var hintLabel = hLevel === 0 ? 'Give me a hint' : (hintDisabled ? 'No more hints' : 'Another hint');
        return '<div class="gl-vocab-focus">' +
          '<div class="gl-vocab-focus-eyebrow">Vocabulary focus</div>' +
          '<div class="gl-vocab-focus-title">' + _glEscape(ex.note.focus) + '</div>' +
          '<div class="gl-vocab-focus-think">Think about:<br>' + _glEscape(ex.note.think) + '</div>' +
          hintsHtml +
          '<button type="button" class="gl-vocab-hint-btn" id="glVocabHintBtn"' + (hintDisabled ? ' disabled' : '') + '>' + hintLabel + '</button>' +
          '</div>';
      }

      function vcFeedbackAfterHtml(ex, answer) {
        var isCorrect = answer.status === 'correct';
        var title = isCorrect ? '✓ Correct' : 'Not quite.';
        var cls = isCorrect ? 'gl-vocab-fb-correct' : 'gl-vocab-fb-incorrect';
        var lines = '';

        if (!isCorrect) {
          var better = ex.type === 'use' ? ex.note.example
            : ex.type === 'choice' ? ex.options[ex.answerIndex]
            : (ex.accepted && ex.accepted[0]);
          lines += '<div class="gl-vocab-fb-line">Your answer:<br><strong>' + _glEscape(answer.userValue || '(none)') + '</strong></div>' +
            '<div class="gl-vocab-fb-line">Correct:<br><strong>' + _glEscape(better || '') + '</strong></div>';
        } else if (ex.type === 'use') {
          lines += '<div class="gl-vocab-fb-line">Nice — you used the word. Here is a model example too:<br><strong>' + _glEscape(ex.note.example) + '</strong></div>';
        }

        return '<div class="gl-vocab-fb ' + cls + '">' +
          '<div class="gl-vocab-fb-title">' + title + '</div>' +
          lines +
          '<div class="gl-vocab-fb-why"><strong>Why?</strong><br>' + _glEscape(ex.note.why) +
          '<br><br><span class="gl-vocab-fb-mainrule">' + _glEscape(ex.note.mainRule) + '</span>' +
          '<br><span class="gl-vocab-fb-example">' + _glEscape(ex.note.example) + '</span></div>' +
          '<div class="gl-vocab-fb-actions">' +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-ghost" id="glVocabExplainBtn">Explain this word</button>' +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabNextBtn">Next →</button>' +
          '</div>' +
          '</div>';
      }

      function vcWireFeedback(ex, answer) {
        if (!answer) {
          var hb = vcEl('glVocabHintBtn');
          if (hb) hb.addEventListener('click', function () {
            vc.hintLevel[vc.index] = (vc.hintLevel[vc.index] || 0) + 1;
            vcEl('glVocabFeedback').innerHTML = vcFeedbackBeforeHtml(ex);
            vcWireFeedback(ex, null);
          });
          return;
        }
        var eb = vcEl('glVocabExplainBtn');
        if (eb) eb.addEventListener('click', function () { vcExplainWord(ex); });
        var nb = vcEl('glVocabNextBtn');
        if (nb) nb.addEventListener('click', vcNext);
      }

      function vcExplainWord(ex) {
        var topicLabel = (VC_ALL_TOPICS.filter(function (t) { return t.id === vc.topic; })[0] || {}).label || vc.topic;
        var prompt = 'Explain this German vocabulary item in a short, clear way for a ' + (vc.level || 'German') + ' learner: "' + ex.note.focus + '". ' +
          ex.note.why + ' Usage: ' + ex.note.mainRule + '. Example: ' + ex.note.example;
        window._glAsk(prompt, 'Wortschatz — ' + topicLabel);
      }

      function vcNext() {
        vc.index++;
        if (vc.index >= vc.queue.length) { vcRenderEnd(); return; }
        vcRenderExercise();
      }

      function vcRenderEnd() {
        vcEl('glVocabWorkspace').style.display = 'none';
        var wrap = vcEl('glVocabEnd');
        wrap.style.display = '';
        var total = vc.queue.length;
        var pct = total ? Math.round((vc.score / total) * 100) : 0;
        var stats = vcStatsLoad();
        var rows = Object.keys(stats).map(function (t) {
          var s = stats[t];
          var acc = s.total ? s.correct / s.total : 0;
          var label = (VC_ALL_TOPICS.filter(function (x) { return x.id === t; })[0] || {}).label || t;
          return { topic: t, label: label, acc: acc, total: s.total };
        }).filter(function (r) { return r.total >= 2; });
        var strong = rows.filter(function (r) { return r.acc >= 0.8; }).map(function (r) { return r.label; });
        var weak = rows.filter(function (r) { return r.acc < 0.6; }).sort(function (a, b) { return a.acc - b.acc; });
        var recommend = weak[0] || null;

        wrap.innerHTML =
          '<div class="gl-vocab-end-card">' +
          '<div class="gl-vocab-end-title">Vocabulary practice complete</div>' +
          '<div class="gl-vocab-end-score">' + vc.score + ' / ' + total + '</div>' +
          '<div class="gl-vocab-end-pct">' + pct + '%</div>' +
          (strong.length ? '<div class="gl-vocab-end-row"><b>Strong:</b> ' + strong.map(_glEscape).join(', ') + '</div>' : '') +
          (weak.length ? '<div class="gl-vocab-end-row"><b>Needs practice:</b> ' + weak.map(function (r) { return _glEscape(r.label); }).join(', ') + '</div>' : '') +
          (recommend ? '<div class="gl-vocab-end-recommend">Recommended next: <b>' + _glEscape(recommend.label) + '</b> · 5 min</div>' : '') +
          '<div class="gl-vocab-end-actions">' +
          (recommend ? '<button type="button" class="gl-vocab-btn" id="glVocabEndWeak">Practice weak area</button>' : '') +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabEndNew">New session</button>' +
          '</div>' +
          '</div>';
        var wb = vcEl('glVocabEndWeak');
        if (wb) wb.addEventListener('click', function () {
          vc.topic = recommend.topic;
          var sel = vcEl('glVocabTopic');
          if (sel) sel.value = recommend.topic;
          vcStartQueue(vc.topic, 10);
        });
        var nsBtn = vcEl('glVocabEndNew');
        if (nsBtn) nsBtn.addEventListener('click', function () { vcStartQueue(vc.topic, 10); });
      }

      function vcRenderWeak() {
        var wrap = vcEl('glVocabWeak');
        var stats = vcStatsLoad();
        var rows = VC_ALL_TOPICS.map(function (t) {
          var s = stats[t.id];
          var total = s ? s.total : 0;
          var acc = total ? s.correct / total : null;
          var status = acc == null ? 'Not started' : acc < 0.6 ? 'Needs practice' : acc < 0.85 ? 'Improving' : 'Strong';
          return { id: t.id, label: t.label, total: total, acc: acc, status: status };
        }).filter(function (r) { return r.total > 0; })
          .sort(function (a, b) { return (a.acc == null ? 0 : a.acc) - (b.acc == null ? 0 : b.acc); });

        if (!rows.length) {
          wrap.innerHTML = '<div class="gl-vocab-files-empty">Practice a few exercises first — Minallo will track which vocabulary topics need more work.</div>';
          return;
        }
        var recommend = rows.filter(function (r) { return r.status === 'Needs practice'; })[0] || rows[0];
        wrap.innerHTML =
          '<div class="gl-vocab-weak-title">Your weak areas</div>' +
          '<div class="gl-vocab-weak-list">' +
          rows.map(function (r) {
            var badgeClass = r.status === 'Needs practice' ? 'gl-vocab-badge-weak' : r.status === 'Improving' ? 'gl-vocab-badge-mid' : 'gl-vocab-badge-strong';
            return '<div class="gl-vocab-weak-row"><span>' + _glEscape(r.label) + '</span><span class="gl-vocab-badge ' + badgeClass + '">' + r.status + '</span></div>';
          }).join('') +
          '</div>' +
          '<div class="gl-vocab-weak-recommend">' +
          '<div class="gl-vocab-weak-recommend-title">Recommended practice</div>' +
          '<div class="gl-vocab-weak-recommend-topic">' + _glEscape(recommend.label) + '</div>' +
          '<div class="gl-vocab-weak-recommend-meta">10 exercises · ~5 min</div>' +
          '<button type="button" class="gl-vocab-btn gl-vocab-btn-primary" id="glVocabWeakStart">Start practice</button>' +
          '</div>';
        var wsBtn = vcEl('glVocabWeakStart');
        if (wsBtn) wsBtn.addEventListener('click', function () {
          vc.topic = recommend.id;
          var sel = vcEl('glVocabTopic');
          if (sel) sel.value = recommend.id;
          vcSetTabView('practice');
          vcStartQueue(recommend.id, 10);
        });
      }

      // ── From my files ─────────────────────────────────────────────────────
      async function vcRenderFilesPanel() {
        var wrap = vcEl('glVocabFiles');
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        wrap.innerHTML = '<div class="gl-vocab-files-empty">Loading your files…</div>';
        if (!uid) {
          wrap.innerHTML = '<div class="gl-vocab-files-empty">Sign in to use your uploaded German files.</div>';
          return;
        }
        var files;
        try { files = await (await _glLearnerFiles()).listLearnerFiles(); }
        catch (e) { wrap.textContent = 'Could not load your files. Reopen this tab to retry.'; return; }
        if (!files.length) {
          wrap.innerHTML = '<div class="gl-vocab-files-empty">No German files uploaded yet. Upload a document in Files.</div>';
          return;
        }
        wrap.innerHTML =
          '<div class="gl-vocab-files-title">Choose a file to practice vocabulary from</div>' +
          '<div id="glVocabFileList">' +
          files.map(function (f) {
            var name = f.name || f.file_name || 'German file';
            return '<label class="gl-vocab-file-row"><input type="radio" name="glVocabFile" value="' + _glEscape(f.id) + '"><span>' + _glEscape(name) + '</span></label>';
          }).join('') +
          '</div>' +
          '<div class="gl-vocab-files-config">' +
          '<label>Difficulty<select id="glVocabCfgLevel">' + _glLevelOptionsHtml() + '</select></label>' +
          '<label>Exercises<select id="glVocabCfgCount"><option>5</option><option selected>10</option><option>15</option></select></label>' +
          '<button type="button" class="gl-vocab-start-btn" id="glVocabFilesStart" disabled>Start practice</button>' +
          '</div>';

        document.querySelectorAll('input[name="glVocabFile"]').forEach(function (radio) {
          radio.addEventListener('change', function () {
            var startBtn = vcEl('glVocabFilesStart');
            var file = files.find(function (item) { return item.id === radio.value; });
            if (startBtn && file) { startBtn.disabled = false; startBtn.onclick = function () { vcStartFromFile(file); }; }
          });
        });
      }

      // Generation runs server-side from the file Minallo already indexed —
      // the browser only sends the document id, never the file bytes.
      async function vcStartFromFile(file) {
        var level = vcEl('glVocabCfgLevel') ? vcEl('glVocabCfgLevel').value : vc.level;
        var count = parseInt(vcEl('glVocabCfgCount') ? vcEl('glVocabCfgCount').value : '10', 10) || 10;
        if (!file.documentId) {
          if (typeof showToast === 'function') showToast('File not indexed yet', 'Open Files and let this file finish indexing first.');
          return;
        }
        vc.level = level;
        vcSetTabView('practice');
        await vcStartQueue(vc.topic, count, { documentIds: [file.documentId] });
      }
    })();

    // ── Hören (listening comprehension) ─────────────────────────────────────
    // Dedicated workspace, same pattern as Lesen/Grammatik/Wortschatz above.
    // Audio is real Qwen3-TTS speech generated per segment via /api/ai/tts
    // (see backend/python-ai/app/routers/tts.py), with browser SpeechSynthesis
    // kept only as an automatic emergency fallback when the TTS service is
    // unavailable/unconfigured — see lsPlayer below. Content is still authored
    // as semantic segments ({id, text}) and every question ties its evidence
    // to segment ids rather than timestamps — "Replay evidence" plays exactly
    // that segment's audio. This mirrors Lesen's "Show evidence in text" but
    // for audio.
    (function () {
      var LS_CATEGORIES = ['Main idea', 'Detail comprehension', 'True/False/Not stated', 'Dictation', 'Fill in the gap'];

      var LISTEN_SETS = [
        {
          meta: { title: 'Ein Anruf beim Arzt', level: 'B1', audioType: 'Dialogue', topic: 'Alltag' },
          segments: [
            { id: 's1', text: 'Guten Tag, hier ist Anna Berger. Ich habe am Montag einen Termin bei Doktor Krüger.' },
            { id: 's2', text: 'Leider muss ich diesen Termin absagen, weil ich am Montag beruflich verreisen muss.' },
            { id: 's3', text: 'Kein Problem, Frau Berger. Wir können den Termin auf nächsten Dienstag um vierzehn Uhr verschieben.' },
            { id: 's4', text: 'Das passt mir sehr gut. Vielen Dank für Ihre Hilfe.' },
            { id: 's5', text: 'Gern geschehen. Bis Dienstag, Frau Berger.' }
          ],
          questions: [
            {
              type: 'main-idea', category: 'Main idea',
              prompt: 'Worum geht es in diesem Gespräch?',
              options: { A: 'To cancel the appointment permanently', B: 'To reschedule the appointment', C: 'To complain about the doctor', D: 'To request a refund' },
              answer: 'B', segmentIds: ['s2', 's3'],
              hints: ['Listen for what happens to the Monday appointment.', 'The receptionist offers a new day and time near the end of the call.'],
              explanation: 'Anna cannot make Monday, so the receptionist moves the appointment to Tuesday at 14:00 — it is rescheduled, not cancelled for good.',
              wrongWhy: { A: 'A new time is offered right after — the appointment isn’t dropped.', C: 'Anna never complains about the doctor.', D: 'No money or refund is mentioned.' },
              highlight: 'auf nächsten Dienstag um vierzehn Uhr verschieben'
            },
            {
              type: 'detail', category: 'Detail comprehension',
              prompt: 'Warum kann Anna den Termin am Montag nicht wahrnehmen?',
              options: { A: 'She is ill', B: 'She has a work trip', C: 'Her train was cancelled', D: 'She forgot about it' },
              answer: 'B', segmentIds: ['s2'],
              hints: ['Listen for the reason right after "weil".', 'It has to do with her job, not her health.'],
              explanation: 'Anna says she has to travel for work ("beruflich verreisen") on Monday.',
              wrongWhy: { A: 'Illness is never mentioned.', C: 'No train is mentioned.', D: 'She explicitly gives a reason — she didn’t just forget.' },
              highlight: 'weil ich am Montag beruflich verreisen muss'
            },
            {
              type: 'tf', category: 'True/False/Not stated',
              prompt: '"Der neue Termin ist am Mittwoch."',
              answer: 'False', segmentIds: ['s3'],
              hints: ['Listen carefully to the day the receptionist proposes.', 'It is not Wednesday.'],
              explanation: 'The receptionist proposes Tuesday ("nächsten Dienstag"), not Wednesday.',
              highlight: 'nächsten Dienstag um vierzehn Uhr'
            },
            {
              type: 'tf', category: 'True/False/Not stated',
              prompt: '"Anna arbeitet bei einer Bank."',
              answer: 'Not stated', segmentIds: [],
              hints: ['Think about what Anna’s job actually is — is it ever named?', 'The call only mentions that she has to travel for work, not where she works.'],
              explanation: 'The call never says where Anna works — only that she has a work trip. There isn’t enough information to call this true or false.'
            },
            {
              type: 'dictation', category: 'Dictation',
              prompt: 'Listen and type exactly what you hear.',
              dictationSegmentId: 's4',
              hints: ['It’s a short, polite closing sentence.', 'Starts with "Das passt..."']
            },
            {
              type: 'fill-gap', category: 'Fill in the gap',
              prompt: 'Listen to the sentence and fill in the missing word.',
              blankSegmentId: 's2', blankAnswer: 'absagen',
              displayText: 'Leider muss ich diesen Termin ______, weil ich am Montag beruflich verreisen muss.',
              hints: ['It’s a verb meaning "to cancel".', 'It rhymes with "absagen".']
            }
          ]
        },
        {
          meta: { title: 'Homeoffice-Regelung', level: 'B2', audioType: 'Announcement', topic: 'Arbeit & Beruf' },
          segments: [
            { id: 's1', text: 'Liebe Kolleginnen und Kollegen, ab nächstem Monat gilt eine neue Homeoffice-Regelung.' },
            { id: 's2', text: 'Jeder darf künftig bis zu drei Tage pro Woche von zu Hause arbeiten.' },
            { id: 's3', text: 'Am Dienstag und Donnerstag bitten wir jedoch alle Teams, im Büro anwesend zu sein, damit wichtige Besprechungen persönlich stattfinden können.' },
            { id: 's4', text: 'Diese Änderung wurde eingeführt, weil viele Mitarbeiter mehr Flexibilität gewünscht hatten.' },
            { id: 's5', text: 'Bei Fragen wenden Sie sich bitte an die Personalabteilung.' }
          ],
          questions: [
            {
              type: 'main-idea', category: 'Main idea',
              prompt: 'Was ist der Hauptzweck dieser Ansage?',
              options: { A: 'To announce layoffs', B: 'To introduce a new home-office policy', C: 'To cancel all meetings', D: 'To request employee feedback' },
              answer: 'B', segmentIds: ['s1', 's2'],
              hints: ['Listen for what changes "ab nächstem Monat".', 'It’s about where people are allowed to work.'],
              explanation: 'The announcement introduces a new policy allowing home-office work up to three days a week.',
              wrongWhy: { A: 'No layoffs are mentioned.', C: 'Meetings are mentioned, but not cancelled — the opposite, in fact.', D: 'Feedback isn’t requested here.' },
              highlight: 'gilt eine neue Homeoffice-Regelung'
            },
            {
              type: 'detail', category: 'Detail comprehension',
              prompt: 'Wie viele Tage pro Woche darf man von zu Hause arbeiten?',
              options: { A: 'One', B: 'Two', C: 'Three', D: 'Five' },
              answer: 'C', segmentIds: ['s2'],
              hints: ['Listen for the number right before "Tage pro Woche".'],
              explanation: 'Employees may work from home up to three days per week.',
              wrongWhy: { A: 'The number given is higher.', B: 'The number given is higher.', D: 'That would mean no office days at all — not what’s said.' },
              highlight: 'bis zu drei Tage pro Woche'
            },
            {
              type: 'tf', category: 'True/False/Not stated',
              prompt: '"Am Dienstag müssen alle im Büro sein."',
              answer: 'True', segmentIds: ['s3'],
              hints: ['Listen for which two days are named as office days.'],
              explanation: 'The announcement names Tuesday and Thursday as the days everyone should be in the office.',
              highlight: 'Am Dienstag und Donnerstag'
            },
            {
              type: 'tf', category: 'True/False/Not stated',
              prompt: '"Die neue Regelung gilt sofort ab morgen."',
              answer: 'False', segmentIds: ['s1'],
              hints: ['Listen for when the new rule actually starts.'],
              explanation: 'The rule starts next month ("ab nächstem Monat"), not tomorrow.',
              highlight: 'ab nächstem Monat'
            },
            {
              type: 'dictation', category: 'Dictation',
              prompt: 'Listen and type exactly what you hear.',
              dictationSegmentId: 's5',
              hints: ['It tells employees who to contact with questions.', 'Ends with "...Personalabteilung."']
            },
            {
              type: 'fill-gap', category: 'Fill in the gap',
              prompt: 'Listen to the sentence and fill in the missing word.',
              blankSegmentId: 's4', blankAnswer: 'Flexibilität',
              displayText: 'Diese Änderung wurde eingeführt, weil viele Mitarbeiter mehr ______ gewünscht hatten.',
              hints: ['It’s a noun meaning the freedom to organize your own time/place of work.', 'It starts with "Flex-".']
            }
          ]
        }
      ];

      // ── Audio player: real Qwen3-TTS audio, browser SpeechSynthesis as
      // emergency fallback ─────────────────────────────────────────────────
      // Public API is unchanged from the SpeechSynthesis-only version this
      // replaced (setSegments/setRate/play/pause/restart/prevSegment/
      // nextSegment/replaySegment/pauseForLeave/stopAll/getState/
      // getSegIndex/getSegCount/onChange) — every caller elsewhere in this
      // file (lsRenderPlayerChrome, lsWirePlayerControls, lsWireSupportEvents,
      // _glCloseListeningView, ...) needed zero changes.
      //
      // setSegments() kicks off one /api/ai/tts request per segment in
      // parallel (state becomes 'loading' until all resolve). If EVERY
      // segment's audio generated successfully we play real HTML5 audio for
      // the whole session; if ANY segment failed (TTS service down/
      // unconfigured/timed out), the whole session falls back to browser
      // SpeechSynthesis instead — never a mix of real and robotic voices
      // within one listening clip. Per-segment results are cached server-side
      // (see tts_cache.py), so re-entering Hören on the same set is instant.
      var lsPlayer = (function () {
        var speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
        var segments = [];
        var audioMap = {}; // segId -> { url, status: 'ready' | 'failed' }
        var usingFallback = false;
        var rate = 1;
        var segIndex = 0;
        var state = 'idle'; // idle | loading | playing | paused | clip
        var voice = null;
        var onStateChange = null;
        var genToken = 0; // bumped on every setSegments(); stale generations are ignored
        var audioEl = (typeof window !== 'undefined' && typeof Audio === 'function') ? new Audio() : null;
        if (audioEl) audioEl.preload = 'auto';

        function notify() { if (onStateChange) onStateChange(state, segIndex); }

        // ---- browser SpeechSynthesis (fallback only) ----
        function scoreVoice(v) {
          var s = 0;
          if (/^de-DE$/i.test(v.lang)) s += 10;
          else if (/^de/i.test(v.lang)) s += 4;
          if (v.localService) s += 5;
          if (/natural|online|neural|premium/i.test(v.name)) s += 3;
          if (/google|microsoft/i.test(v.name)) s += 2;
          return s;
        }
        function pickVoice() {
          if (!speechSupported) return null;
          var voices = window.speechSynthesis.getVoices() || [];
          var de = voices.filter(function (v) { return /^de/i.test(v.lang); });
          if (!de.length) return null;
          var savedName = null;
          try { savedName = localStorage.getItem('ls_voice_name'); } catch (e) {}
          if (savedName) {
            var saved = de.filter(function (v) { return v.name === savedName; })[0];
            if (saved) return saved;
          }
          de.sort(function (a, b) { return scoreVoice(b) - scoreVoice(a); });
          var chosen = de[0];
          try { localStorage.setItem('ls_voice_name', chosen.name); } catch (e) {}
          return chosen;
        }
        function ensureVoice() { if (!voice) voice = pickVoice(); }
        if (speechSupported) {
          ensureVoice();
          window.speechSynthesis.addEventListener('voiceschanged', function () { voice = pickVoice(); });
        }

        function speakFallbackFrom(idx) {
          if (!speechSupported) { state = 'idle'; notify(); return; }
          window.speechSynthesis.cancel();
          if (idx < 0 || idx >= segments.length) { state = 'idle'; notify(); return; }
          segIndex = idx;
          state = 'playing';
          notify();
          var u = new SpeechSynthesisUtterance(segments[idx].text);
          u.lang = 'de-DE';
          if (voice) u.voice = voice;
          u.rate = rate;
          u.onend = function () {
            if (state !== 'playing') return;
            if (segIndex + 1 < segments.length) speakFallbackFrom(segIndex + 1);
            else { state = 'idle'; segIndex = 0; notify(); }
          };
          u.onerror = function () { state = 'idle'; notify(); };
          window.speechSynthesis.speak(u);
        }
        function speakFallbackClip(seg) {
          if (!speechSupported) return;
          window.speechSynthesis.cancel();
          state = 'clip';
          notify();
          var u = new SpeechSynthesisUtterance(seg.text);
          u.lang = 'de-DE';
          if (voice) u.voice = voice;
          u.rate = rate;
          u.onend = function () { state = 'idle'; notify(); };
          u.onerror = function () { state = 'idle'; notify(); };
          window.speechSynthesis.speak(u);
        }

        // ---- real audio (Qwen3-TTS via /api/ai/tts-batch) ----
        // One request for the whole lesson, not one per segment: the server
        // (python-ai's /tts/generate-batch) checks the cache for every
        // segment up front and fans out only the misses through its own
        // small bounded concurrency pool — that's what actually protects the
        // single Qwen instance, regardless of how many segments a lesson has
        // or how this client calls it. Never re-introduce N parallel calls
        // to the single-segment endpoint here.
        function prepareSegments(segs, token) {
          _authFetch(BACKEND_URL + '/api/ai/tts-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              segments: segs.map(function (s) { return { id: s.id, text: s.text }; }),
              language: 'German'
            })
          }).then(function (resp) {
            if (!resp.ok) throw new Error('tts_batch_http_' + resp.status);
            return resp.json();
          }).then(function (data) {
            if (token !== genToken) return; // a newer setSegments() superseded this run
            var byId = {};
            (data && data.segments || []).forEach(function (s) { byId[s.id] = s; });
            var allOk = true;
            segs.forEach(function (seg) {
              var r = byId[seg.id];
              if (r && !r.failed && r.audioUrl) audioMap[seg.id] = { url: r.audioUrl, status: 'ready' };
              else { audioMap[seg.id] = { status: 'failed' }; allOk = false; }
            });
            usingFallback = Boolean((data && data.degraded) || !allOk);
            if (usingFallback && typeof console !== 'undefined' && console.warn) {
              console.warn('[Hören] TTS provider degraded to browser fallback.');
            }
            state = 'idle';
            notify();
          }).catch(function () {
            if (token !== genToken) return;
            segs.forEach(function (seg) { audioMap[seg.id] = { status: 'failed' }; });
            usingFallback = true;
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[Hören] TTS provider degraded to browser fallback.');
            }
            state = 'idle';
            notify();
          });
        }

        function playAudioFrom(idx) {
          if (idx < 0 || idx >= segments.length) { state = 'idle'; if (audioEl) audioEl.pause(); notify(); return; }
          var entry = audioMap[segments[idx].id];
          if (!audioEl || !entry || entry.status !== 'ready') {
            // Defensive fallback — shouldn't happen in the normal path since
            // usingFallback is decided for the whole session before playback
            // starts, but never dead-end a segment that has no audio.
            usingFallback = true;
            speakFallbackFrom(idx);
            return;
          }
          segIndex = idx;
          state = 'playing';
          notify();
          audioEl.src = entry.url;
          audioEl.playbackRate = rate;
          audioEl.play().catch(function () { state = 'idle'; notify(); });
        }
        if (audioEl) {
          audioEl.addEventListener('ended', function () {
            if (state === 'clip') { state = 'idle'; notify(); return; }
            if (state !== 'playing') return;
            if (segIndex + 1 < segments.length) playAudioFrom(segIndex + 1);
            else { state = 'idle'; segIndex = 0; notify(); }
          });
          audioEl.addEventListener('error', function () {
            if (state === 'playing' || state === 'clip') { state = 'idle'; notify(); }
          });
        }

        function speakFrom(idx) { if (usingFallback) speakFallbackFrom(idx); else playAudioFrom(idx); }

        return {
          supported: speechSupported || !!audioEl,
          setSegments: function (segs) {
            if (speechSupported) window.speechSynthesis.cancel();
            if (audioEl) { audioEl.pause(); try { audioEl.removeAttribute('src'); } catch (e) {} }
            segments = segs || [];
            audioMap = {};
            usingFallback = false;
            segIndex = 0;
            state = segments.length ? 'loading' : 'idle';
            notify();
            var token = ++genToken;
            if (segments.length) prepareSegments(segments, token);
          },
          setRate: function (r) {
            rate = r;
            if (audioEl) audioEl.playbackRate = r;
            if (state === 'playing' && usingFallback) speakFallbackFrom(segIndex); // real audio applies rate live, no restart needed
          },
          play: function () {
            ensureVoice();
            if (state === 'loading') return; // still generating; UI disables the button meanwhile
            if (state === 'paused') {
              if (usingFallback) { window.speechSynthesis.resume(); state = 'playing'; notify(); }
              else { audioEl.play().catch(function () {}); state = 'playing'; notify(); }
            } else {
              speakFrom(segIndex);
            }
          },
          pause: function () {
            if (usingFallback) { if (speechSupported) window.speechSynthesis.pause(); }
            else if (audioEl) { audioEl.pause(); }
            state = 'paused';
            notify();
          },
          restart: function () { speakFrom(0); },
          prevSegment: function () { speakFrom(Math.max(0, segIndex - 1)); },
          nextSegment: function () { speakFrom(Math.min(segments.length - 1, segIndex + 1)); },
          replaySegment: function (id) {
            ensureVoice();
            var seg = segments.filter(function (s) { return s.id === id; })[0];
            if (!seg) return;
            if (usingFallback) { speakFallbackClip(seg); return; }
            var entry = audioMap[seg.id];
            if (!audioEl || !entry || entry.status !== 'ready') { speakFallbackClip(seg); return; }
            audioEl.pause();
            state = 'clip';
            notify();
            audioEl.src = entry.url;
            audioEl.playbackRate = rate;
            audioEl.play().catch(function () { state = 'idle'; notify(); });
          },
          // Cancels/pauses audio but keeps segIndex, so returning to Hören
          // later resumes from the same segment rather than the start. Used
          // only when navigating away from the view — never a hard reset.
          pauseForLeave: function () {
            if (speechSupported) window.speechSynthesis.cancel();
            if (audioEl) audioEl.pause();
            state = 'idle';
            notify();
          },
          stopAll: function () {
            if (speechSupported) window.speechSynthesis.cancel();
            if (audioEl) audioEl.pause();
            state = 'idle';
            segIndex = 0;
            notify();
          },
          getState: function () { return state; },
          getSegIndex: function () { return segIndex; },
          getSegCount: function () { return segments.length; },
          isUsingFallback: function () { return usingFallback; },
          onChange: function (fn) { onStateChange = fn; }
        };
      })();

      // ── Local grading helpers (no AI call needed for any v1 exercise) ──
      function lsNormalizeWord(w) {
        return (w || '').toLowerCase().replace(/ß/g, 'ss').replace(/[.,!?;:„"“”'’()]/g, '').trim();
      }
      function lsStripPunct(w) { return (w || '').replace(/[.,!?;:„"“”'’()]/g, ''); }
      function lsTokenize(s) { return (s || '').trim().split(/\s+/).filter(Boolean); }

      // Two separate scores — content vs spelling — so a learner who heard
      // every word correctly but missed noun capitalization (e.g. "termin"
      // vs "Termin") isn't shown a flat wrong answer.
      function lsGradeDictation(correctText, userText) {
        var correctWords = lsTokenize(correctText);
        var userWords = lsTokenize(userText);
        var contentCorrect = 0, spellingCorrect = 0;
        var issues = [];
        for (var i = 0; i < correctWords.length; i++) {
          var cw = correctWords[i];
          var uw = userWords[i];
          var contentMatch = uw && lsNormalizeWord(uw) === lsNormalizeWord(cw);
          if (contentMatch) {
            contentCorrect++;
            if (lsStripPunct(uw) === lsStripPunct(cw)) {
              spellingCorrect++;
            } else {
              issues.push('capitalize “' + cw + '”');
            }
          } else {
            issues.push('missed “' + cw + '”' + (uw ? ' (you wrote “' + uw + '”)' : ''));
          }
        }
        return {
          contentCorrect: contentCorrect, contentTotal: correctWords.length,
          spellingCorrect: spellingCorrect,
          contentOk: contentCorrect === correctWords.length,
          spellingOk: spellingCorrect === contentCorrect,
          issues: issues
        };
      }
      function lsGradeFillGap(correctWord, userWord) {
        var contentOk = lsNormalizeWord(userWord) === lsNormalizeWord(correctWord);
        var spellingOk = lsStripPunct((userWord || '').trim()) === lsStripPunct(correctWord);
        return { contentOk: contentOk, spellingOk: contentOk && spellingOk };
      }

      var ls = {
        tab: 'practice',
        setIndex: 0,
        set: null,
        questions: [],
        index: 0,
        answers: {}, // idx -> { attempts, finalStatus: null|'correct'|'review', selected/userText, retrying, replayCount }
        hintLevel: {},
        transcriptRevealed: {},
        fullTranscriptShown: false,
        done: false,
        _wired: false,
        // Bumped at the start of every lsGenerateOrLoadPart() call and on
        // leaving the view; a call only applies its result if this is still
        // the same token when its promise resolves. Guards against a stale
        // generate response (HV1 requested, then HV2 requested before HV1
        // returns) overwriting newer state — see lsGenerateOrLoadPart.
        _genRequestToken: 0,
        // Shared German Exam Engine fields — only meaningful when usingGenerated is true.
        usingGenerated: false,
        examFamily: null,
        examVariant: null,
        targetLevel: null,
        profileId: null,
        profileVersion: null,
        module: 'listening',
        partId: 'hv1',
        generationId: null,
        attemptsBuffer: [],
        _resultsSavePromise: null,
        _speakerOrder: [],
        // Set true only when a SUPPORTED profile's generation call itself
        // failed (network/rate-limit/backend error) — never for the
        // no-supported-profile case, which stays a silent LISTEN_SETS
        // fallback. Callers of lsGenerateOrLoadPart check this before
        // re-rendering the workspace, so the explicit error panel
        // lsShowGenerationError() draws into glListenTaskPanel isn't
        // immediately stomped by a normal render call.
        _lastGenFailed: false,
        // Mirrors rd._awaitingProfile (Lesen) — true while Hören is open and
        // waiting on the profile fetch (window._germanProfileLoaded still
        // false), not yet a definitive "no supported profile" verdict.
        _awaitingProfile: false
      };

      function lsEl(id) { return document.getElementById(id); }
      function lsSeg(id) {
        var found = ls.set && ls.set.segments.filter(function (s) { return s.id === id; })[0];
        return found ? found.text : '';
      }

      function lsScoreSet(set, level, topic) {
        var s = 0;
        if (set.meta.level === level) s += 2;
        if (topic === 'Mixed' || set.meta.topic === topic) s += 1;
        return s;
      }
      function lsPickSetIndex(avoidIdx) {
        var level = lsEl('glListenLevel') && lsEl('glListenLevel').value ? lsEl('glListenLevel').value : _glProfileLevel();
        var topic = lsEl('glListenTopic') ? lsEl('glListenTopic').value : 'Mixed';
        var best = -1, bestScore = -1;
        LISTEN_SETS.forEach(function (set, idx) {
          if (LISTEN_SETS.length > 1 && idx === avoidIdx) return;
          var sc = lsScoreSet(set, level, topic);
          if (sc > bestScore) { bestScore = sc; best = idx; }
        });
        if (best === -1) best = (avoidIdx + 1) % LISTEN_SETS.length;
        return best;
      }

      function lsLoadSet(setIndex, questionsOverride) {
        ls.set = LISTEN_SETS[setIndex];
        ls.setIndex = setIndex;
        ls.questions = questionsOverride || ls.set.questions;
        ls.index = 0;
        ls.answers = {};
        ls.hintLevel = {};
        ls.transcriptRevealed = {};
        ls.fullTranscriptShown = false;
        ls.done = false;
        ls.usingGenerated = false;
        lsPlayer.setSegments(ls.set.segments);
        lsPlayer.setRate(1);
      }

      // ── Shared German Exam Engine integration ───────────────────────────
      // Hören is the first consumer of POST /api/ai/german-exam/generate — a
      // shared backend that also serves Lesen/Schreiben/Sprechen/
      // Sprachbausteine (see backend/python-ai/app/services/german_exam_*.py).
      // This endpoint returns CONTENT ONLY (no audioUrl/durationMs anywhere)
      // — it never calls TTS. lsPlayer.setSegments() (unchanged, below) is the
      // ONLY place /api/ai/tts-batch is ever called from, for both the static
      // and generated content paths, so audio is never requested twice.
      //
      // Canonical resolution: window._germanExamProfileId is set by
      // applyProfile() (frontend/js/features/auth/user-data.ts) from
      // profiles.german_exam_profile_id (or derived + persisted there on
      // first use) — this is the authoritative source now that more than
      // one profile can eventually exist. The table below is only a
      // defensive fallback for the narrow window before that global is set
      // (e.g. Hören opened before user-data finishes loading); it must be
      // kept in sync with GERMAN_EXAM_PROFILES_CLIENT in user-data.ts and
      // the backend's GERMAN_EXAM_PROFILES registry — adding a profile
      // means one entry in each of these three places, not another
      // if-branch.
      // Single source: the shared accessor derives the id from the
      // authoritative (test, level) pair — no per-module resolver/table.
      function lsResolveProfileId() {
        var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
        return (p && p.examProfileId) || null;
      }

      function lsMapGeneratedQuestion(part, q, speakerToSegment, allSegmentIds) {
        var base = {
          questionId: q.questionId, type: part.taskType, category: part.title,
          skillTags: q.skillTags || [], difficulty: q.difficulty || null, hints: []
        };
        if (part.taskType === 'speaker_statement_matching') {
          base.prompt = q.prompt || '';
          base.matching = q.matching || {};
          var spId = base.matching.correctSpeakerId;
          base.segmentIds = (spId && speakerToSegment[spId]) ? [speakerToSegment[spId]] : [];
        } else if (part.taskType === 'sentence_completion_mc3') {
          base.prompt = (q.mc3 && q.mc3.stem) || '';
          base.mc3 = q.mc3 || {};
          base.segmentIds = allSegmentIds;
        } else if (part.taskType === 'structured_note_completion') {
          base.prompt = (q.note && q.note.fieldLabel) || '';
          base.note = q.note || {};
          base.segmentIds = allSegmentIds;
        } else {
          base.prompt = q.prompt || '';
          base.segmentIds = allSegmentIds;
        }
        return base;
      }

      function lsLoadGeneratedPart(envelope) {
        var part = envelope.part || {};
        var exam = envelope.exam || {};
        var content = envelope.content || {};
        var rawSegments = content.segments || [];

        var speakerToSegment = {};
        var speakerOrder = [];
        rawSegments.forEach(function (s) {
          if (s.speakerId && !(s.speakerId in speakerToSegment)) {
            speakerToSegment[s.speakerId] = s.id;
            speakerOrder.push(s.speakerId);
          }
        });
        var allSegmentIds = rawSegments.map(function (s) { return s.id; });

        ls.set = {
          meta: {
            title: part.title || '', level: exam.variant || exam.cefrLevel || '',
            audioType: 'Generated', topic: (envelope.topic && envelope.topic.label) || ''
          },
          // displayText here (transcript/evidence UI reads ls.set.segments via lsSeg());
          // lsPlayer is fed spokenText separately, below.
          segments: rawSegments.map(function (s) { return { id: s.id, text: s.displayText || s.spokenText || '' }; })
        };
        ls.setIndex = 0;
        ls.questions = (content.questions || []).map(function (q) {
          return lsMapGeneratedQuestion(part, q, speakerToSegment, allSegmentIds);
        });
        ls.index = 0;
        ls.answers = {};
        ls.hintLevel = {};
        ls.transcriptRevealed = {};
        ls.fullTranscriptShown = false;
        ls.done = false;

        ls.usingGenerated = true;
        ls.examFamily = exam.family || null;
        ls.examVariant = exam.variant || null;
        ls.targetLevel = exam.cefrLevel || exam.variant || null;
        ls.profileId = exam.profileId || null;
        ls.profileVersion = exam.profileVersion || null;
        ls.module = envelope.module || 'listening';
        ls.partId = part.id || ls.partId;
        // Ties every attempt from this session back to the exact generated
        // task that produced it (server-side: german_exam_attempts.generation_id).
        ls.generationId = envelope.generationId || null;
        ls.attemptsBuffer = [];
        ls._resultsSavePromise = null;
        ls._speakerOrder = speakerOrder;

        lsPlayer.setSegments(rawSegments.map(function (s) { return { id: s.id, text: s.spokenText || s.displayText || '' }; }));
        lsPlayer.setRate(1);
      }

      // ── HV1 prefetch ─────────────────────────────────────────────────────
      // Speculative generation triggered once, early, from the German
      // Practice hub (see window._glMaybePrefetchHV1, called from the
      // #glHome wiring near the top of this file) — so the first Hören open
      // is often instant instead of waiting out a real generation call.
      //
      // Deliberately narrow: HV1 only, exactly one prefetch ever per view
      // load (state starts 'idle' and only lsPrefetchInvalidate() resets
      // it), never re-triggered by repeated navigation/render events. A
      // prefetch call still counts against the same real generation cap and
      // /hour rate limit as any other call (see ai-german-exam-generate.ts)
      // — the one-shot trigger IS the protection against silently chewing
      // through that budget, not a separate unmetered allowance.
      //
      // Never fetches TTS — this only ever calls /german-exam/generate
      // (speculative:true), exactly like a normal generate call; audio is
      // still requested exactly once, later, by lsPlayer.setSegments()
      // inside lsLoadGeneratedPart() when the result is actually consumed.
      var lsPrefetch = { state: 'idle', profileId: null, envelope: null };
      // Bumped by lsPrefetchInvalidate() so an in-flight ('pending') prefetch
      // whose response lands AFTER invalidation (e.g. results were just
      // saved, making its adaptation plan stale) can recognize it's stale
      // and discard itself instead of resurrecting lsPrefetch.state='ready'
      // out from under the invalidation.
      var lsPrefetchEpoch = 0;

      function lsPrefetchInvalidate() {
        lsPrefetchEpoch++;
        lsPrefetch.state = 'idle';
        lsPrefetch.profileId = null;
        lsPrefetch.envelope = null;
      }

      window._glMaybePrefetchHV1 = function () {
        if (lsPrefetch.state !== 'idle') return; // already prefetched/in flight/consumed this view load — never re-trigger
        var profileId = lsResolveProfileId();
        if (!profileId) return; // no supported profile — nothing to prefetch
        // Only prefetch a part the learner's exam actually has and can generate.
        var _avail = typeof window._glExamPartAvailability === 'function' ? window._glExamPartAvailability('listening', 'hv1') : 'yes';
        if (_avail === 'pending') {
          if (typeof window._glExamOnReady === 'function') window._glExamOnReady(function () { window._glMaybePrefetchHV1(); });
          return;
        }
        if (_avail === 'no') return;
        var myEpoch = lsPrefetchEpoch;
        lsPrefetch.state = 'pending';
        lsPrefetch.profileId = profileId;
        _authFetch(BACKEND_URL + '/api/ai/german-exam/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: profileId, module: 'listening', partId: 'hv1', mode: 'adaptive_practice', speculative: true })
        }).then(function (resp) {
          if (!resp.ok) throw new Error('prefetch_http_' + resp.status);
          return resp.json();
        }).then(function (envelope) {
          if (myEpoch !== lsPrefetchEpoch) return; // invalidated while in flight — discard silently
          // The resolved profile may have changed while this was in flight
          // (e.g. onboarding profile edited mid-session) — a stale prefetch
          // for the wrong profile must never be held for later consumption.
          if (lsPrefetch.profileId !== lsResolveProfileId()) { lsPrefetchInvalidate(); return; }
          lsPrefetch.envelope = envelope;
          lsPrefetch.state = 'ready';
        }).catch(function (err) {
          if (myEpoch !== lsPrefetchEpoch) return; // invalidated while in flight
          // Non-fatal: on-demand generation on actual Hören-open still works
          // exactly as before: this is purely an optimization.
          if (typeof console !== 'undefined' && console.warn) console.warn('[Hören] prefetch failed (non-fatal).', err);
          lsPrefetchInvalidate();
        });
      };

      // Marks a consumed prefetch's topic as actually used, now that the
      // learner has really seen it — never called for a normal (non-
      // speculative) generation, which already records this itself
      // server-side. Fire-and-forget: topic history is a soft anti-
      // repetition signal, not load-bearing (matches record_topic_used()'s
      // own swallow-and-continue behavior server-side).
      function lsPrefetchConsume(envelope) {
        lsPrefetch.state = 'consumed';
        var exam = envelope.exam || {}, part = envelope.part || {}, topic = envelope.topic || {};
        if (!topic.topicId) return;
        _authFetch(BACKEND_URL + '/api/ai/german-exam/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: exam.profileId, module: envelope.module || 'listening', partId: part.id || 'hv1',
            topicId: topic.topicId, generationId: envelope.generationId || null
          })
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Hören] failed to mark prefetch consumed.', err);
        });
      }

      // Renders an explicit failure state for a SUPPORTED exam profile whose
      // generation call itself failed (rate limit, verifier exhaustion,
      // backend outage) — deliberately NOT the same as the no-profile case.
      // A learner explicitly preparing for telc C1 Hochschule must never
      // have a real failure silently swapped for generic B1/B2 static
      // content that looks like valid exam practice; they choose the
      // fallback themselves via the second button, or retry.
      function lsShowGenerationError(moduleName, partId) {
        var taskPanel = lsEl('glListenTaskPanel');
        if (!taskPanel) return;
        taskPanel.innerHTML =
          '<div class="gl-listen-error">' +
            '<p class="gl-listen-error-title">Couldn’t create your verified telc exercise.</p>' +
            '<p class="gl-listen-error-sub">Generation didn’t complete this time — nothing was recorded. You can retry, or switch to general listening practice instead.</p>' +
            _glFailNote() +
            '<div class="gl-listen-error-actions">' +
              '<button type="button" id="glListenErrorRetry" class="gl-listen-end-btn gl-listen-end-btn-primary">Retry</button>' +
              '<button type="button" id="glListenErrorFallback" class="gl-listen-end-btn">Use general listening practice</button>' +
            '</div>' +
          '</div>';
        var retryBtn = lsEl('glListenErrorRetry');
        var fallbackBtn = lsEl('glListenErrorFallback');
        if (retryBtn) retryBtn.addEventListener('click', function () {
          lsGenerateOrLoadPart(moduleName, partId).then(function () {
            if (ls._lastGenFailed) return;
            lsRenderPlayerChrome();
            lsRenderWorkspace();
          });
        });
        if (fallbackBtn) fallbackBtn.addEventListener('click', function () {
          // Explicit, user-chosen opt-out — not a silent substitution.
          lsLoadSet(ls.setIndex % LISTEN_SETS.length);
          lsRenderPlayerChrome();
          lsRenderWorkspace();
        });
      }

      // Resolves (never rejects) so callers can always .then() without a
      // .catch. Falls back to static LISTEN_SETS SILENTLY only when no
      // supported exam profile resolves for this learner — a real failure
      // for a supported profile instead sets ls._lastGenFailed and renders
      // an explicit retry/fallback state via lsShowGenerationError(); every
      // caller must check ls._lastGenFailed before its own re-render so it
      // doesn't stomp that error panel.
      //
      // Race-safety: captures ls._genRequestToken at call time and re-checks
      // it before applying either outcome. Whichever call was issued LAST
      // holds the current token by the time its own .then/.catch runs — an
      // earlier call's response arriving after a newer one was already
      // issued is silently dropped instead of overwriting the newer state.
      // This covers: switching HV1->HV2 before HV1's response lands,
      // double-clicking "New listening", and leaving the view mid-generation
      // (window._glCloseListeningView also bumps the token).
      // Shown in glListenTaskPanel while the profile fetch is still in
      // flight — mirrors rdShowWaitingForProfile (Lesen). Never a
      // substitute for the definitive-unsupported LISTEN_SETS fallback.
      function lsShowWaitingForProfile() {
        var taskPanel = lsEl('glListenTaskPanel');
        if (taskPanel) taskPanel.innerHTML = '<div class="gl-listen-generating">Loading your exam profile…</div>';
      }

      function lsGenerateOrLoadPart(moduleName, partId) {
        var myToken = ++ls._genRequestToken;
        ls._lastGenFailed = false;
        var profileId = lsResolveProfileId();
        if (!profileId) {
          if (myToken !== ls._genRequestToken) return Promise.resolve();
          if (!window._germanProfileLoaded) {
            // Profile hasn't resolved yet — this is NOT the same as a
            // definitively unsupported profile. Wait for ss-profile-updated
            // to retry instead of silently loading static LISTEN_SETS.
            ls._awaitingProfile = true;
            ls.module = moduleName;
            ls.partId = partId;
            lsShowWaitingForProfile();
            return Promise.resolve();
          }
          ls._awaitingProfile = false;
          lsLoadSet(ls.setIndex % LISTEN_SETS.length);
          return Promise.resolve();
        }
        ls._awaitingProfile = false;
        ls.module = moduleName;
        ls.partId = partId;

        // Consume a ready HV1 prefetch instead of making a fresh network
        // call — only when it's already fully resolved ('ready'); if it's
        // still 'pending' this falls through to a normal on-demand call
        // rather than making the caller wait on the in-flight prefetch, to
        // keep this fast-path simple and avoid adding a second race surface
        // to an already-guarded flow. A prefetch that finishes after being
        // skipped this way is simply never consumed (its topic is correctly
        // never marked "used" either, since that only happens on consume).
        if (moduleName === 'listening' && partId === 'hv1' && lsPrefetch.state === 'ready' && lsPrefetch.profileId === profileId) {
          var prefetched = lsPrefetch.envelope;
          lsPrefetchConsume(prefetched);
          if (myToken !== ls._genRequestToken) return Promise.resolve();
          lsLoadGeneratedPart(prefetched);
          return Promise.resolve();
        }

        var taskPanel = lsEl('glListenTaskPanel');
        if (taskPanel) taskPanel.innerHTML = '<div class="gl-listen-generating">Generating your listening exercise…</div>';
        // Content generation only; audio is prepared separately by
        // lsPlayer.setSegments() once the content lands.
        return _glRunGeneration(ls, 'exam', taskPanel,
          { start: 'Creating your listening exercise…' },
          _glExamRequest({ profileId: profileId, module: moduleName, partId: partId, mode: 'adaptive_practice' })
        ).then(function (envelope) {
          if (myToken !== ls._genRequestToken) return; // superseded by a newer request — drop silently
          lsLoadGeneratedPart(envelope);
        }).catch(function (err) {
          if (myToken !== ls._genRequestToken) return; // superseded — don't stomp newer state with a stale failure
          if (typeof console !== 'undefined' && console.warn) console.warn('[Hören] generation failed.', err);
          ls._lastGenFailed = true;
          lsShowGenerationError(moduleName, partId);
        });
      }

      // Batches ls.attemptsBuffer into ONE POST at part completion, memoized
      // so a later caller (lsStartWeakRetry) can await the SAME in-flight or
      // already-resolved save instead of assuming it has already landed.
      function lsEnsureResultsSaved() {
        if (ls._resultsSavePromise) return ls._resultsSavePromise;
        if (!ls.usingGenerated || !ls.attemptsBuffer.length) {
          ls._resultsSavePromise = Promise.resolve();
          return ls._resultsSavePromise;
        }
        // A still-held HV1 prefetch reflects an adaptation plan computed
        // BEFORE these results existed — once real attempts are about to be
        // recorded, that plan is stale, so drop any unconsumed prefetch
        // rather than hand it out later as if it still targeted the
        // learner's current weaknesses. Cheap to regenerate on demand.
        if (lsPrefetch.state === 'ready' || lsPrefetch.state === 'pending') lsPrefetchInvalidate();
        ls._resultsSavePromise = _authFetch(BACKEND_URL + '/api/ai/german-exam/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            examFamily: ls.examFamily, examVariant: ls.examVariant || null, targetLevel: ls.targetLevel,
            module: ls.module, items: ls.attemptsBuffer
          })
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Hören] failed to save results.', err);
        });
        return ls._resultsSavePromise;
      }

      function lsRecordAttempt(q, ans, correct) {
        ls.attemptsBuffer.push({
          profileId: ls.profileId, profileVersion: ls.profileVersion, module: ls.module, partId: ls.partId,
          taskType: q.type, itemId: q.questionId, skillTags: q.skillTags || [], difficulty: q.difficulty || null,
          generationId: ls.generationId,
          attemptCount: ans.attempts,
          firstAttemptCorrect: !!ans._firstAttemptCorrect,
          finalCorrect: correct,
          hintLevel: ls.hintLevel[ls.index] || 0,
          replayCount: ans.replayCount || 0,
          transcriptRevealed: !!ls.transcriptRevealed[ls.index]
        });
      }

      window._glOpenListeningView = function () {
        try { _glSyncLevelSelects(); } catch (e) { /* non-fatal */ }
        ls.tab = 'practice';
        lsEl('glListenPractice').style.display = '';
        lsEl('glListenEnd').style.display = 'none';
        lsResetToPracticeTabChrome();
        lsGenerateOrLoadPart('listening', ls.partId || 'hv1').then(function () {
          if (ls._lastGenFailed) return; // lsShowGenerationError() already drew the error panel
          if (ls._awaitingProfile) return; // lsShowWaitingForProfile() already drew the loading panel
          lsRenderPlayerChrome();
          lsRenderWorkspace();
        });
        lsWireHeader();
        lsWirePlayerControls();
        lsWirePartSwitcher();
        lsPlayer.onChange(lsRenderPlayerChrome);
      };

      // Retries opening Hören once the profile finishes loading, mirroring
      // Lesen's ss-profile-updated listener. Guarded the same way: only
      // fires if Hören was actually left waiting and is still the open
      // skill, so it can never cause a duplicate generate/tts-batch call.
      window.addEventListener('ss-profile-updated', function () {
        if (!ls._awaitingProfile) return;
        ls._awaitingProfile = false;
        if (_glActiveSkill !== 'listening') return;
        window._glOpenListeningView();
      });

      // Called whenever the user leaves Hören (switching skill or going back
      // to the German Practice home) — see the _glOpenSkill/_glBackToHome
      // edits below. Must never leave speech playing invisibly elsewhere.
      window._glRegisterProfileReset(function (nextProfileId) {
        lsPlayer.pauseForLeave(); // stop any TTS from the previous exam
        ls._genRequestToken++;
        lsPrefetchInvalidate(); // a prepared part built for the previous exam must never be served
        if (ls.profileId && ls.profileId !== nextProfileId) {
          ls.usingGenerated = false; ls.profileId = null; ls.profileVersion = null; ls.generationId = null;
          ls.set = null; ls.questions = []; ls.index = 0; ls.answers = {}; ls.hintLevel = {}; ls.transcriptRevealed = {};
          ls.attemptsBuffer = []; ls._speakerOrder = []; ls.partId = 'hv1'; ls.done = false;
          ls._lastGenFailed = false; ls._resultsSavePromise = null;
        }
      });

      window._glCloseListeningView = function () {
        lsPlayer.pauseForLeave();
        // Invalidate any in-flight generate request so a response that
        // lands after the user has already left can't silently repaint a
        // workspace they're no longer looking at.
        ls._genRequestToken++;
      };

      // Called anywhere the workspace re-enters the Practice tab's territory
      // (opening Hören, switching parts, weak-retry, new listening) so a
      // learner who was viewing Weak areas doesn't land back on a stale
      // weak-areas view/tab-highlight after one of those actions.
      function lsResetToPracticeTabChrome() {
        var weakPanel = lsEl('glListenWeakPanel');
        var weakTab = lsEl('glListenWeakTab');
        var practiceTab = document.querySelector('#glListeningView .gl-listen-tab[data-listen-tab="practice"]');
        if (weakPanel) weakPanel.style.display = 'none';
        if (weakTab) { weakTab.classList.remove('active'); weakTab.setAttribute('aria-selected', 'false'); }
        if (practiceTab) { practiceTab.classList.add('active'); practiceTab.setAttribute('aria-selected', 'true'); }
      }

      function lsWireHeader() {
        var topicSel = lsEl('glListenTopic');
        var levelSel = lsEl('glListenLevel');
        if (topicSel && !topicSel._lsWired) { topicSel._lsWired = true; topicSel.addEventListener('change', function () { lsNewListening(); }); }
        if (levelSel && !levelSel._lsWired) { levelSel._lsWired = true; levelSel.addEventListener('change', function () { lsNewListening(); }); }
        var practiceTab = document.querySelector('#glListeningView .gl-listen-tab[data-listen-tab="practice"]');
        var weakTab = lsEl('glListenWeakTab');
        if (practiceTab && !practiceTab._lsWired) { practiceTab._lsWired = true; practiceTab.addEventListener('click', function () { lsSwitchListenTab('practice'); }); }
        if (weakTab && !weakTab._lsWired) { weakTab._lsWired = true; weakTab.addEventListener('click', function () { lsSwitchListenTab('weak'); }); }
      }

      // Fetches the real, persisted weakness snapshot for generated
      // (exam-profile-backed) sessions from POST /api/ai/german-exam/weaknesses
      // — the same backend endpoint the adaptation planner itself reads from,
      // so this shows exactly what's driving future generation, not a
      // separate client-computed approximation.
      function lsFetchWeaknesses() {
        return _authFetch(BACKEND_URL + '/api/ai/german-exam/weaknesses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: ls.profileId, module: ls.module || 'listening' })
        }).then(function (resp) {
          if (!resp.ok) throw new Error('weaknesses_http_' + resp.status);
          return resp.json();
        });
      }

      function lsRenderWeakAreasTab() {
        var panel = lsEl('glListenWeakPanel');
        if (!panel) return;
        if (!ls.usingGenerated || !ls.profileId) {
          panel.innerHTML = '<p class="gl-listen-weak-empty">Weak areas need a verified telc C1 Hochschule session — switch out of general listening practice to see your breakdown.</p>';
          return;
        }
        panel.innerHTML = '<div class="gl-listen-generating">Loading your weak areas…</div>';
        lsFetchWeaknesses().then(function (snapshot) {
          var tags = (snapshot && snapshot.tags) || {};
          var tagKeys = Object.keys(tags);
          if (!tagKeys.length) {
            panel.innerHTML = '<p class="gl-listen-weak-empty">Not enough attempts yet to show weak areas — keep practicing and this will fill in.</p>';
            return;
          }
          var sorted = tagKeys.slice().sort(function (a, b) { return (tags[a].score || 0) - (tags[b].score || 0); });
          panel.innerHTML =
            '<p class="gl-listen-weak-confidence">Confidence: <b>' + _glEscape(snapshot.overallConfidence || 'cold_start') + '</b></p>' +
            '<div class="gl-listen-weak-list">' + sorted.map(function (tag) {
              var w = tags[tag] || {};
              var pct = Math.round((w.score || 0) * 100);
              return '<div class="gl-listen-weak-row">' +
                '<span class="gl-listen-weak-tag">' + _glEscape(tag.replace(/_/g, ' ')) + '</span>' +
                '<div class="gl-listen-weak-bar"><div class="gl-listen-weak-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="gl-listen-weak-pct">' + pct + '% <span class="gl-listen-weak-n">(' + (w.nAttempts || 0) + ' attempts)</span></span>' +
              '</div>';
            }).join('') + '</div>';
        }).catch(function (err) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[Hören] failed to load weak areas.', err);
          panel.innerHTML = '<p class="gl-listen-weak-empty">Couldn’t load your weak areas right now. Try again shortly.</p>';
        });
      }

      // Switches between the Practice tab (the normal listening workspace,
      // whichever of glListenPractice/glListenEnd matches ls.done) and the
      // Weak areas tab (glListenWeakPanel). "From my files" stays disabled
      // — out of scope here.
      function lsSwitchListenTab(tab) {
        var practiceTab = document.querySelector('#glListeningView .gl-listen-tab[data-listen-tab="practice"]');
        var weakTab = lsEl('glListenWeakTab');
        var practicePanel = lsEl('glListenPractice');
        var endPanel = lsEl('glListenEnd');
        var weakPanel = lsEl('glListenWeakPanel');
        var switcher = lsEl('glListenPartSwitcher');
        var onWeak = tab === 'weak';
        if (practiceTab) { practiceTab.classList.toggle('active', !onWeak); practiceTab.setAttribute('aria-selected', String(!onWeak)); }
        if (weakTab) { weakTab.classList.toggle('active', onWeak); weakTab.setAttribute('aria-selected', String(onWeak)); }
        if (weakPanel) weakPanel.style.display = onWeak ? '' : 'none';
        if (practicePanel) practicePanel.style.display = (!onWeak && !ls.done) ? '' : 'none';
        if (endPanel) endPanel.style.display = (!onWeak && ls.done) ? '' : 'none';
        if (switcher) switcher.style.display = (!onWeak && ls.usingGenerated) ? '' : 'none';
        if (onWeak) lsRenderWeakAreasTab();
      }

      // Minimal part switcher for the generated (telc C1 Hochschule) path —
      // only 3 flat buttons, no full Exam/Level/Part header treatment yet.
      // Clicking a part that's already active is a no-op (no need to
      // regenerate the same part); clicking a different part goes through
      // the same lsGenerateOrLoadPart() race-safety as everything else.
      function lsWirePartSwitcher() {
        ['hv1', 'hv2', 'hv3'].forEach(function (partId) {
          var btn = lsEl('glListenPart' + partId.toUpperCase());
          if (!btn || btn._lsWired) return;
          btn._lsWired = true;
          btn.addEventListener('click', function () {
            if (ls.usingGenerated && ls.partId === partId) return;
            lsGenerateOrLoadPart('listening', partId).then(function () {
              lsEl('glListenPractice').style.display = '';
              lsEl('glListenEnd').style.display = 'none';
              lsResetToPracticeTabChrome();
              if (ls._lastGenFailed) return; // lsShowGenerationError() already drew the error panel
              lsRenderPlayerChrome();
              lsRenderWorkspace();
            });
          });
        });
        var newTestBtn = lsEl('glListenNewTestBtn');
        if (newTestBtn && !newTestBtn._lsWired) {
          newTestBtn._lsWired = true;
          newTestBtn.addEventListener('click', lsStartNewTest);
        }
      }

      // New Test: discards HV1/HV2/HV3 generated state, answers/results, and
      // any prepared HV1 prefetch, then always resets to a fresh HV1 — never
      // a re-render of the currently loaded part. Audio is stopped first so
      // nothing keeps playing from the discarded test; TTS for the fresh
      // content is only requested later, inside lsLoadGeneratedPart (via
      // lsPlayer.setSegments), and only once that new generation succeeds.
      function lsStartNewTest() {
        var oldGenerationId = ls.generationId;
        lsPlayer.pauseForLeave();
        ls._genRequestToken++; // invalidate any in-flight/prepared response immediately
        lsPrefetchInvalidate(); // a stale prepared HV1 must never be served as "new"
        ls.answers = {};
        ls.hintLevel = {};
        ls.transcriptRevealed = {};
        ls.fullTranscriptShown = false;
        ls.done = false;
        ls.attemptsBuffer = [];
        ls._resultsSavePromise = null;
        ls.generationId = null;
        lsEl('glListenPractice').style.display = '';
        lsEl('glListenEnd').style.display = 'none';
        lsResetToPracticeTabChrome();
        lsGenerateOrLoadPart('listening', 'hv1').then(function () {
          if (ls._lastGenFailed) return; // lsShowGenerationError() already drew the error panel
          if (typeof console !== 'undefined' && console.assert) {
            console.assert(ls.generationId !== oldGenerationId, '[Hören] New Test did not produce a new generationId');
          }
          lsRenderPlayerChrome();
          lsRenderWorkspace();
          lsUpdatePartSwitcher();
        });
      }

      function lsUpdatePartSwitcher() {
        var switcher = lsEl('glListenPartSwitcher');
        if (!switcher) return;
        switcher.style.display = ls.usingGenerated ? '' : 'none';
        ['hv1', 'hv2', 'hv3'].forEach(function (partId) {
          var btn = lsEl('glListenPart' + partId.toUpperCase());
          if (btn) btn.classList.toggle('active', ls.usingGenerated && ls.partId === partId);
        });
      }

      var LS_PART_LABELS = { hv1: 'Teil 1', hv2: 'Teil 2', hv3: 'Teil 3' };

      // Generated (exam-profile-backed) sessions get their real exam
      // identity in the header — "telc C1 Hochschule · C1 · Hören · Teil 1"
      // — instead of the generic Topic/Level selectors, which stay for the
      // static LISTEN_SETS fallback path where there's no real exam profile
      // to name. The generated topic is shown read-only underneath, since
      // it's AI-picked, not user-selected, for this path.
      function lsUpdateHeaderForMode() {
        var staticControls = lsEl('glListenStaticHeaderControls');
        var examContext = lsEl('glListenExamContext');
        if (!staticControls || !examContext) return;
        if (ls.usingGenerated) {
          staticControls.style.display = 'none';
          var parts = [];
          if (ls.examFamily && ls.examVariant) parts.push(ls.examFamily + ' ' + ls.examVariant);
          else if (ls.examVariant) parts.push(ls.examVariant);
          if (ls.targetLevel) parts.push(ls.targetLevel);
          parts.push('Hören');
          parts.push(LS_PART_LABELS[ls.partId] || ls.partId);
          var topicLabel = (ls.set && ls.set.meta && ls.set.meta.topic) || '';
          examContext.innerHTML = _glEscape(parts.join(' · ')) +
            (topicLabel ? '<span class="gl-listen-exam-topic"> — ' + _glEscape(topicLabel) + '</span>' : '');
          examContext.style.display = '';
        } else {
          staticControls.style.display = '';
          examContext.style.display = 'none';
        }
      }

      // Read-only test-introspection hook — `ls` itself is intentionally
      // private to this closure. Exposes only what's already implied by the
      // rendered DOM (part id, task type, generated-vs-static, request
      // token), so a stale-state bug can be asserted directly rather than
      // inferred from titles/classes alone, which can visibly say the right
      // thing while stale data survives underneath.
      window._glListenDebugState = function () {
        var q = ls.questions && ls.questions[ls.index];
        return {
          usingGenerated: ls.usingGenerated,
          partId: ls.partId,
          module: ls.module,
          questionCount: ls.questions ? ls.questions.length : 0,
          currentTaskType: q ? q.type : null,
          genRequestToken: ls._genRequestToken,
          currentIndex: ls.index,
          attemptsBufferLength: ls.attemptsBuffer ? ls.attemptsBuffer.length : 0,
          answeredCount: ls.answers ? Object.keys(ls.answers).filter(function (k) { return ls.answers[k] && ls.answers[k].finalStatus; }).length : 0
        };
      };

      function lsWirePlayerControls() {
        var playBtn = lsEl('glListenPlayBtn');
        if (playBtn && !playBtn._lsWired) {
          playBtn._lsWired = true;
          playBtn.addEventListener('click', function () {
            if (lsPlayer.getState() === 'playing') lsPlayer.pause();
            else lsPlayer.play();
          });
        }
        var prevBtn = lsEl('glListenPrevBtn');
        if (prevBtn && !prevBtn._lsWired) { prevBtn._lsWired = true; prevBtn.addEventListener('click', function () { lsPlayer.prevSegment(); }); }
        var nextBtn = lsEl('glListenNextBtn');
        if (nextBtn && !nextBtn._lsWired) { nextBtn._lsWired = true; nextBtn.addEventListener('click', function () { lsPlayer.nextSegment(); }); }
        var restartBtn = lsEl('glListenRestartBtn');
        if (restartBtn && !restartBtn._lsWired) { restartBtn._lsWired = true; restartBtn.addEventListener('click', function () { lsPlayer.restart(); }); }
        document.querySelectorAll('.gl-listen-speed').forEach(function (btn) {
          if (btn._lsWired) return;
          btn._lsWired = true;
          btn.addEventListener('click', function () {
            document.querySelectorAll('.gl-listen-speed').forEach(function (b) { b.classList.toggle('active', b === btn); });
            lsPlayer.setRate(parseFloat(btn.getAttribute('data-speed')));
          });
        });
      }

      function lsRenderPlayerChrome() {
        lsUpdatePartSwitcher();
        lsUpdateHeaderForMode();
        var setTitle = lsEl('glListenSetTitle');
        if (setTitle && ls.set) setTitle.textContent = ls.set.meta.title + ' · ' + ls.set.meta.level + ' · ' + ls.set.meta.audioType;
        var count = lsPlayer.getSegCount();
        var idx = lsPlayer.getSegIndex();
        var loading = lsPlayer.getState() === 'loading';
        var pos = lsEl('glListenPosition');
        if (pos) pos.textContent = loading ? 'Preparing audio…' : ('Segment ' + (count ? idx + 1 : 0) + ' / ' + count);
        var fill = lsEl('glListenTrackFill');
        if (fill) fill.style.width = (count ? Math.round(((idx + 1) / count) * 100) : 0) + '%';
        var playBtn = lsEl('glListenPlayBtn');
        var playing = lsPlayer.getState() === 'playing';
        if (playBtn) {
          playBtn.disabled = loading;
          playBtn.classList.toggle('is-loading', loading);
          playBtn.textContent = loading ? '…' : (playing ? '⏸' : '▶');
          playBtn.setAttribute('aria-label', loading ? 'Preparing audio' : (playing ? 'Pause audio' : 'Play audio'));
        }
        var wf = lsEl('glListenWaveform');
        if (wf) wf.classList.toggle('is-playing', playing);
      }

      function lsQProgress() {
        var total = ls.questions.length;
        var pct = total ? Math.round(((ls.index + 1) / total) * 100) : 0;
        var label = lsEl('glListenProgressLabel');
        if (label) label.textContent = 'Question ' + (ls.index + 1) + ' / ' + total;
        var fill = lsEl('glListenProgressFill');
        if (fill) fill.style.width = pct + '%';
      }

      // ── Renderer/grader dispatch (keyed by q.type) ──────────────────────
      // Covers the original 5 generic exercise types (main-idea/detail/tf/
      // dictation/fill-gap, used by the static LISTEN_SETS fallback) plus the
      // 3 exam-specific types the shared German Exam Engine can now generate
      // for telc C1 Hochschule Hören. Extending with a new exam-specific type
      // later means adding one entry to each map here, not another if/else
      // branch across three functions.
      var LS_OPTION_TYPES = ['main-idea', 'detail', 'tf', 'speaker_statement_matching', 'sentence_completion_mc3'];

      function lsRenderMcqBody(q, ans, resolved, showingMinimalRetry) {
        var opts = ['A', 'B', 'C', 'D'].filter(function (l) { return q.options[l]; });
        return '<div class="gl-listen-options">' + opts.map(function (letter) {
          var state = '';
          if (resolved) {
            if (letter === q.answer) state = 'gl-correct';
            else if (letter === ans.selected) state = 'gl-incorrect';
          }
          return '<button type="button" class="gl-listen-option ' + state + '" data-opt="' + letter + '"' + (resolved || showingMinimalRetry ? ' disabled' : '') + '>' +
            '<span class="gl-listen-opt-mark">' + letter + '</span><span>' + _glEscape(q.options[letter]) + '</span></button>';
        }).join('') + '</div>';
      }
      function lsRenderTfBody(q, ans, resolved, showingMinimalRetry) {
        var tfOpts = ['True', 'False', 'Not stated'];
        return '<div class="gl-listen-options">' + tfOpts.map(function (opt) {
          var state = '';
          if (resolved) {
            if (opt === q.answer) state = 'gl-correct';
            else if (opt === ans.selected) state = 'gl-incorrect';
          }
          return '<button type="button" class="gl-listen-option ' + state + '" data-opt="' + opt + '"' + (resolved || showingMinimalRetry ? ' disabled' : '') + '>' +
            '<span class="gl-listen-opt-mark"></span><span>' + opt + '</span></button>';
        }).join('') + '</div>';
      }
      function lsRenderDictationBody(q, ans, resolved, showingMinimalRetry) {
        return '<button type="button" class="gl-listen-evidence-btn" id="glListenPlayClipBtn">🎧 Play sentence</button>' +
          '<input type="text" class="gl-listen-text-input" id="glListenDictInput" placeholder="Type exactly what you hear…"' +
          (resolved ? ' disabled value="' + _glEscape(ans.userText || '') + '"' : ' value="' + _glEscape(showingMinimalRetry ? '' : (ans.userText || '')) + '"') + '>';
      }
      function lsRenderFillGapBody(q, ans, resolved, showingMinimalRetry) {
        var displayHtml = _glEscape(q.displayText).replace('______', '<span class="gl-listen-gap-blank">______</span>');
        return '<div class="gl-listen-gap-line">' + displayHtml + '</div>' +
          '<button type="button" class="gl-listen-evidence-btn" id="glListenPlayClipBtn">🎧 Play sentence</button>' +
          '<input type="text" class="gl-listen-text-input" id="glListenGapInput" placeholder="Type the missing word…"' +
          (resolved ? ' disabled value="' + _glEscape(ans.userText || '') + '"' : ' value="' + _glEscape(showingMinimalRetry ? '' : (ans.userText || '')) + '"') + '>';
      }
      function lsRenderSpeakerMatchingBody(q, ans, resolved, showingMinimalRetry) {
        var speakerIds = ls._speakerOrder || [];
        var correct = (q.matching && q.matching.correctSpeakerId) || 'no_match';
        var options = speakerIds.concat(['no_match']);
        return '<div class="gl-listen-options">' + options.map(function (spId, i) {
          var label = spId === 'no_match' ? 'None of the speakers' : ('Speaker ' + (i + 1));
          var state = '';
          if (resolved) {
            if (spId === correct) state = 'gl-correct';
            else if (spId === ans.selected) state = 'gl-incorrect';
          }
          return '<button type="button" class="gl-listen-option ' + state + '" data-opt="' + spId + '"' + (resolved || showingMinimalRetry ? ' disabled' : '') + '>' +
            '<span>' + _glEscape(label) + '</span></button>';
        }).join('') + '</div>';
      }
      function lsRenderMc3Body(q, ans, resolved, showingMinimalRetry) {
        var options = (q.mc3 && q.mc3.options) || [];
        var letters = ['A', 'B', 'C'];
        return '<div class="gl-listen-options">' + options.map(function (text, i) {
          var letter = letters[i] || String(i);
          var state = '';
          if (resolved) {
            if (i === q.mc3.correctIndex) state = 'gl-correct';
            else if (String(i) === ans.selected) state = 'gl-incorrect';
          }
          return '<button type="button" class="gl-listen-option ' + state + '" data-opt="' + i + '"' + (resolved || showingMinimalRetry ? ' disabled' : '') + '>' +
            '<span class="gl-listen-opt-mark">' + letter + '</span><span>' + _glEscape(text) + '</span></button>';
        }).join('') + '</div>';
      }
      function lsRenderNoteCompletionBody(q, ans, resolved, showingMinimalRetry) {
        var context = (q.note && q.note.outlineContext) || '';
        return (context ? '<div class="gl-listen-gap-line">' + _glEscape(context) + '</div>' : '') +
          '<input type="text" class="gl-listen-text-input" id="glListenNoteInput" placeholder="Fill in the missing information…"' +
          (resolved ? ' disabled value="' + _glEscape(ans.userText || '') + '"' : ' value="' + _glEscape(showingMinimalRetry ? '' : (ans.userText || '')) + '"') + '>';
      }

      var LS_RENDERERS = {
        'main-idea': lsRenderMcqBody,
        'detail': lsRenderMcqBody,
        'tf': lsRenderTfBody,
        'dictation': lsRenderDictationBody,
        'fill-gap': lsRenderFillGapBody,
        'speaker_statement_matching': lsRenderSpeakerMatchingBody,
        'sentence_completion_mc3': lsRenderMc3Body,
        'structured_note_completion': lsRenderNoteCompletionBody
      };

      function lsRenderWorkspace() {
        lsQProgress();
        var q = ls.questions[ls.index];
        if (!q) return;
        var ans = ls.answers[ls.index] || (ls.answers[ls.index] = { attempts: 0, finalStatus: null, selected: null, userText: '', replayCount: 0 });
        var resolved = !!ans.finalStatus;
        var showingMinimalRetry = !resolved && ans.attempts >= 1 && !ans.retrying;

        var renderer = LS_RENDERERS[q.type];
        var body = renderer ? renderer(q, ans, resolved, showingMinimalRetry) : '';

        var checkDisabled = resolved || showingMinimalRetry;
        if (!checkDisabled) {
          checkDisabled = LS_OPTION_TYPES.indexOf(q.type) !== -1 ? !ans._pending : false;
        }

        var taskPanel = lsEl('glListenTaskPanel');
        taskPanel.innerHTML =
          '<div class="gl-listen-q-category">' + _glEscape(q.category) + '</div>' +
          '<div class="gl-listen-q-prompt">' + _glEscape(q.prompt) + '</div>' +
          body +
          '<div class="gl-listen-actions">' +
          (resolved ? '' : '<button type="button" class="gl-listen-hint-btn" id="glListenHintBtn">Give me a hint</button>') +
          (showingMinimalRetry
            ? '<button type="button" class="gl-listen-check-btn" id="glListenRetryBtn">Try again</button>'
            : '<button type="button" class="gl-listen-check-btn" id="glListenCheckBtn"' + (checkDisabled ? ' disabled' : '') + '>' + (resolved ? 'Answered' : 'Check answer →') + '</button>') +
          '</div>' +
          '<div class="gl-listen-nav">' +
          '<button type="button" class="gl-listen-nav-btn" id="glListenPrevQBtn"' + (ls.index === 0 ? ' disabled' : '') + '>← Previous</button>' +
          '<span class="gl-listen-nav-count">' + (ls.index + 1) + ' / ' + ls.questions.length + '</span>' +
          '<button type="button" class="gl-listen-nav-btn" id="glListenNextQBtn">' + (ls.index + 1 >= ls.questions.length ? 'Finish' : 'Next →') + '</button>' +
          '</div>';

        lsRenderSupport(q, ans, resolved, showingMinimalRetry);
        lsWireWorkspaceEvents(q, ans, resolved, showingMinimalRetry);
      }

      function lsHintFor(q, level) { return (q.hints && q.hints[level]) || ''; }

      // Resolved-answer feedback body, by type. Kept as one function with a
      // type switch (rather than a dispatch map like the renderers/graders
      // above) because the surrounding evidence/transcript-reveal chrome in
      // lsRenderSupport doesn't vary by type — only this inner block does.
      function lsRenderSupportBody(q, ans, isCorrect) {
        if (q.type === 'dictation') {
          var g = ans.grade;
          return '<div class="gl-listen-feedback-line">Your answer:<br><strong>' + _glEscape(ans.userText || '') + '</strong></div>' +
            '<div class="gl-listen-feedback-line">Correct:<br><strong>' + _glEscape(lsSeg(q.dictationSegmentId)) + '</strong></div>' +
            '<div class="gl-listen-score-line">Content: <span class="' + (g.contentOk ? 'ok' : 'warn') + '">' + g.contentCorrect + '/' + g.contentTotal + ' words</span>' +
            ' · Spelling: <span class="' + (g.spellingOk ? 'ok' : 'warn') + '">' + g.spellingCorrect + '/' + g.contentCorrect + '</span></div>' +
            (g.issues.length ? '<div class="gl-listen-feedback-why">' + _glEscape(g.issues.join(', ')) + '</div>' : '');
        }
        if (q.type === 'fill-gap') {
          return '<div class="gl-listen-feedback-line">Your answer: <strong>' + _glEscape(ans.userText || '') + '</strong> · Correct: <strong>' + _glEscape(q.blankAnswer) + '</strong></div>' +
            '<div class="gl-listen-feedback-line">' + _glEscape(q.displayText.replace('______', q.blankAnswer)) + '</div>';
        }
        if (q.type === 'structured_note_completion') {
          return '<div class="gl-listen-feedback-line">Your answer: <strong>' + _glEscape(ans.userText || '') + '</strong> · Correct: <strong>' + _glEscape((q.note && q.note.correctFill) || '') + '</strong></div>';
        }
        if (q.type === 'sentence_completion_mc3') {
          var mc3Opts = (q.mc3 && q.mc3.options) || [];
          var mc3Correct = q.mc3 && q.mc3.correctIndex;
          var mc3Html = '';
          if (!isCorrect) {
            mc3Html += '<div class="gl-listen-feedback-line">Your answer:<br><strong>' + _glEscape(mc3Opts[ans.selected] || '') + '</strong></div>' +
              '<div class="gl-listen-feedback-line">Correct answer:<br><strong>' + _glEscape(mc3Opts[mc3Correct] || '') + '</strong></div>';
          }
          return mc3Html;
        }
        if (q.type === 'speaker_statement_matching') {
          var correctSpId = (q.matching && q.matching.correctSpeakerId) || 'no_match';
          var speakerOrder = ls._speakerOrder || [];
          var labelFor = function (spId) {
            if (spId === 'no_match') return 'None of the speakers';
            var i = speakerOrder.indexOf(spId);
            return i === -1 ? (spId || '') : ('Speaker ' + (i + 1));
          };
          var matchHtml = '';
          if (!isCorrect) {
            matchHtml += '<div class="gl-listen-feedback-line">Your answer:<br><strong>' + _glEscape(labelFor(ans.selected)) + '</strong></div>' +
              '<div class="gl-listen-feedback-line">Correct answer:<br><strong>' + _glEscape(labelFor(correctSpId)) + '</strong></div>';
          }
          return matchHtml;
        }
        // main-idea / detail / tf
        var html = '';
        if (!isCorrect) {
          html += '<div class="gl-listen-feedback-line">Your answer:<br><strong>' + _glEscape(ans.selected || '') + '</strong></div>' +
            '<div class="gl-listen-feedback-line">Correct answer:<br><strong>' + _glEscape(q.answer) + '</strong></div>';
        }
        html += '<div class="gl-listen-feedback-line">' + _glEscape(q.explanation || '') + '</div>';
        if (!isCorrect && q.wrongWhy && q.wrongWhy[ans.selected]) {
          html += '<div class="gl-listen-feedback-why">Why "' + _glEscape(ans.selected) + '" is wrong: ' + _glEscape(q.wrongWhy[ans.selected]) + '</div>';
        }
        return html;
      }

      function lsRenderSupport(q, ans, resolved, showingMinimalRetry) {
        var panel = lsEl('glListenSupportPanel');
        var html = '<div class="gl-listen-support-title">Listening support</div>';

        if (!resolved) {
          if (showingMinimalRetry) {
            html += '<div class="gl-listen-feedback gl-fb-incorrect">' +
              '<div class="gl-listen-feedback-title">Not quite.</div>' +
              '<div class="gl-listen-feedback-line">Listen to the relevant part again before trying once more.</div>' +
              '<button type="button" class="gl-listen-evidence-btn" id="glListenReplayEvidenceBtn">Replay evidence</button>' +
              '</div>';
          } else {
            var level = ls.hintLevel[ls.index] || 0;
            html += '<div class="gl-listen-feedback-line">Try to work it out from the audio first.</div>' +
              (level > 0 ? '<div class="gl-listen-hint-box">' + _glEscape(lsHintFor(q, 0)) + '</div>' : '') +
              (level > 1 ? '<div class="gl-listen-hint-box">' + _glEscape(lsHintFor(q, 1)) + '</div>' : '');
          }
          panel.innerHTML = html;
          return;
        }

        var isCorrect = ans.finalStatus === 'correct';
        html += '<div class="gl-listen-feedback ' + (isCorrect ? 'gl-fb-correct' : 'gl-fb-incorrect') + '">' +
          '<div class="gl-listen-feedback-title">' + (isCorrect ? '✓ Correct' : 'Here’s the answer') + '</div>';

        html += lsRenderSupportBody(q, ans, isCorrect);

        if (q.segmentIds && q.segmentIds.length) {
          html += '<button type="button" class="gl-listen-evidence-btn" id="glListenReplayEvidenceBtn">Replay evidence</button>';
        }
        if (q.dictationSegmentId || q.blankSegmentId) {
          html += '<button type="button" class="gl-listen-evidence-btn" id="glListenReplayEvidenceBtn" data-seg="' + (q.dictationSegmentId || q.blankSegmentId) + '">Replay sentence</button>';
        }
        html += '<button type="button" class="gl-listen-transcript-btn" id="glListenTranscriptBtn">Show relevant transcript</button>';
        html += '</div>';

        if (ls.transcriptRevealed[ls.index] && q.segmentIds && q.segmentIds.length) {
          var segText = q.segmentIds.map(lsSeg).join(' ');
          var marked = q.highlight ? _glEscape(segText).replace(_glEscape(q.highlight), '<mark>' + _glEscape(q.highlight) + '</mark>') : _glEscape(segText);
          html += '<div class="gl-listen-transcript-box">' + marked + '</div>';
        }

        panel.innerHTML = html;
      }

      function lsWireWorkspaceEvents(q, ans, resolved, showingMinimalRetry) {
        var hintBtn = lsEl('glListenHintBtn');
        if (hintBtn) hintBtn.addEventListener('click', function () {
          var level = ls.hintLevel[ls.index] || 0;
          if (level < (q.hints ? q.hints.length : 0)) ls.hintLevel[ls.index] = level + 1;
          lsRenderSupport(q, ans, resolved, showingMinimalRetry);
        });

        if (!resolved && !showingMinimalRetry && LS_OPTION_TYPES.indexOf(q.type) !== -1) {
          document.querySelectorAll('#glListenTaskPanel .gl-listen-option').forEach(function (btn) {
            btn.addEventListener('click', function () {
              ans._pending = btn.getAttribute('data-opt');
              document.querySelectorAll('#glListenTaskPanel .gl-listen-option').forEach(function (b) { b.classList.toggle('gl-selected', b === btn); });
              var checkBtn = lsEl('glListenCheckBtn');
              if (checkBtn) checkBtn.disabled = false;
            });
          });
        }

        var playClipBtn = lsEl('glListenPlayClipBtn');
        if (playClipBtn) playClipBtn.addEventListener('click', function () {
          ans.replayCount = (ans.replayCount || 0) + 1;
          lsPlayer.replaySegment(q.dictationSegmentId || q.blankSegmentId);
        });

        var checkBtn = lsEl('glListenCheckBtn');
        if (checkBtn && !resolved && !showingMinimalRetry) checkBtn.addEventListener('click', function () { lsCheckAnswer(q, ans); });

        var retryBtn = lsEl('glListenRetryBtn');
        if (retryBtn) retryBtn.addEventListener('click', function () {
          ans.retrying = true;
          lsRenderWorkspace();
        });

        lsWireSupportEvents(q, ans, resolved, showingMinimalRetry);

        var prevQBtn = lsEl('glListenPrevQBtn');
        if (prevQBtn) prevQBtn.addEventListener('click', function () { lsGoTo(-1); });
        var nextQBtn = lsEl('glListenNextQBtn');
        if (nextQBtn) nextQBtn.addEventListener('click', function () { lsGoTo(1); });
      }

      // Wires the buttons lsRenderSupport draws (replay evidence/sentence,
      // transcript reveal). Split out from lsWireWorkspaceEvents because
      // lsRenderSupport can re-render on its own (hint reveal, transcript
      // reveal) without the task panel re-rendering — those buttons need
      // re-wiring every time or they go dead after the first re-render.
      function lsWireSupportEvents(q, ans, resolved, showingMinimalRetry) {
        var replayEvBtn = lsEl('glListenReplayEvidenceBtn');
        if (replayEvBtn) replayEvBtn.addEventListener('click', function () {
          var segId = replayEvBtn.getAttribute('data-seg') || (q.segmentIds && q.segmentIds[0]);
          if (segId) { ans.replayCount = (ans.replayCount || 0) + 1; lsPlayer.replaySegment(segId); }
        });

        var transcriptBtn = lsEl('glListenTranscriptBtn');
        if (transcriptBtn) transcriptBtn.addEventListener('click', function () {
          ls.transcriptRevealed[ls.index] = true;
          lsRenderSupport(q, ans, resolved, showingMinimalRetry);
          lsWireSupportEvents(q, ans, resolved, showingMinimalRetry);
        });
      }

      // Each grader returns true/false when it has enough input to grade, or
      // null when the user hasn't answered yet (mirrors the original early
      // `return;`s — lsCheckAnswer treats null as "not ready, do nothing").
      function lsGradeMcqLikeType(q, ans) {
        if (!ans._pending) return null;
        ans.selected = ans._pending;
        return ans.selected === q.answer;
      }
      function lsGradeDictationType(q, ans) {
        var dInput = lsEl('glListenDictInput');
        ans.userText = dInput ? dInput.value.trim() : '';
        if (!ans.userText) return null;
        ans.grade = lsGradeDictation(lsSeg(q.dictationSegmentId), ans.userText);
        return ans.grade.contentOk;
      }
      function lsGradeFillGapType(q, ans) {
        var gInput = lsEl('glListenGapInput');
        ans.userText = gInput ? gInput.value.trim() : '';
        if (!ans.userText) return null;
        return lsGradeFillGap(q.blankAnswer, ans.userText).contentOk;
      }
      function lsGradeSpeakerMatchingType(q, ans) {
        if (!ans._pending) return null;
        ans.selected = ans._pending;
        var correct = (q.matching && q.matching.correctSpeakerId) || 'no_match';
        return ans.selected === correct;
      }
      function lsGradeMc3Type(q, ans) {
        if (!ans._pending) return null;
        ans.selected = parseInt(ans._pending, 10);
        return ans.selected === (q.mc3 && q.mc3.correctIndex);
      }
      function lsGradeNoteCompletionType(q, ans) {
        var input = lsEl('glListenNoteInput');
        ans.userText = input ? input.value.trim() : '';
        if (!ans.userText) return null;
        var correct = ((q.note && q.note.correctFill) || '').trim();
        return ans.userText.trim().toLowerCase() === correct.toLowerCase();
      }

      var LS_GRADERS = {
        'main-idea': lsGradeMcqLikeType,
        'detail': lsGradeMcqLikeType,
        'tf': lsGradeMcqLikeType,
        'dictation': lsGradeDictationType,
        'fill-gap': lsGradeFillGapType,
        'speaker_statement_matching': lsGradeSpeakerMatchingType,
        'sentence_completion_mc3': lsGradeMc3Type,
        'structured_note_completion': lsGradeNoteCompletionType
      };

      function lsCheckAnswer(q, ans) {
        var grader = LS_GRADERS[q.type];
        var result = grader ? grader(q, ans) : null;
        if (result === null || result === undefined) return;
        var correct = !!result;

        ans.attempts++;
        if (ans.attempts === 1) ans._firstAttemptCorrect = correct;
        ans.retrying = false;
        if (correct || ans.attempts >= 2) {
          ans.finalStatus = correct ? 'correct' : 'review';
          if (ls.usingGenerated) lsRecordAttempt(q, ans, correct);
        }
        lsRenderWorkspace();
      }

      function lsGoTo(delta) {
        var next = ls.index + delta;
        if (next < 0) return;
        if (next >= ls.questions.length) { lsShowEnd(); return; }
        ls.index = next;
        lsRenderWorkspace();
      }

      function lsShowEnd() {
        ls.done = true;
        var total = ls.questions.length;
        var correctCount = 0;
        var byCat = {};
        if (!ls.usingGenerated) LS_CATEGORIES.forEach(function (c) { byCat[c] = { correct: 0, total: 0 }; });
        var weakCats = [];
        ls.questions.forEach(function (q, idx) {
          var a = ls.answers[idx];
          // Generated sessions break down by skill tag (what the shared
          // adaptation engine actually tracks); static sets keep the
          // original fixed-category breakdown.
          var keys = ls.usingGenerated
            ? ((q.skillTags && q.skillTags.length) ? q.skillTags : ['(uncategorized)'])
            : [q.category];
          keys.forEach(function (key) {
            if (!byCat[key]) byCat[key] = { correct: 0, total: 0 };
            byCat[key].total++;
            if (a && a.finalStatus === 'correct') byCat[key].correct++;
          });
          if (a && a.finalStatus === 'correct') correctCount++;
        });
        Object.keys(byCat).forEach(function (cat) {
          var c = byCat[cat];
          if (c.total > 0 && c.correct < c.total) weakCats.push(cat);
        });
        var pct = total ? Math.round((correctCount / total) * 100) : 0;

        // Batched submit point: ONE POST for the whole part's results, fired
        // here (fire-and-forget — the UI doesn't need to block on it).
        // lsStartWeakRetry below awaits the SAME promise before regenerating,
        // so a fast "Practice weak areas" click can't race ahead of this save.
        if (ls.usingGenerated) lsEnsureResultsSaved();

        var end = lsEl('glListenEnd');
        lsEl('glListenPractice').style.display = 'none';
        end.style.display = '';
        end.innerHTML =
          '<h3 class="gl-listen-end-title">Listening complete</h3>' +
          '<div class="gl-listen-end-score">' + correctCount + ' / ' + total + '</div>' +
          '<div class="gl-listen-end-pct">' + pct + '%</div>' +
          '<div class="gl-listen-breakdown">' + Object.keys(byCat).filter(function (c) { return byCat[c].total > 0; }).map(function (cat) {
            var c = byCat[cat];
            return '<div class="gl-listen-breakdown-row"><span>' + _glEscape(cat) + '</span><b>' + c.correct + ' / ' + c.total + '</b></div>';
          }).join('') + '</div>' +
          (ls.fullTranscriptShown
            ? '<div class="gl-listen-transcript-box">' + ls.set.segments.map(function (s) { return _glEscape(s.text); }).join(' ') + '</div>'
            : '<button type="button" class="gl-listen-transcript-btn" id="glListenFullTranscriptBtn">Show full transcript</button>') +
          '<div class="gl-listen-end-actions">' +
          (weakCats.length ? '<button type="button" class="gl-listen-end-btn" id="glListenWeakBtn">Practice weak areas</button>' : '') +
          '<button type="button" class="gl-listen-end-btn gl-listen-end-btn-primary" id="glListenNewBtn">New listening</button>' +
          '</div>';

        var fullBtn = lsEl('glListenFullTranscriptBtn');
        if (fullBtn) fullBtn.addEventListener('click', function () { ls.fullTranscriptShown = true; lsShowEnd(); });
        var weakBtn = lsEl('glListenWeakBtn');
        if (weakBtn) weakBtn.addEventListener('click', function () { lsStartWeakRetry(weakCats); });
        var newBtn = lsEl('glListenNewBtn');
        if (newBtn) newBtn.addEventListener('click', function () { lsNewListening(); });
      }

      function lsStartWeakRetry(weakCats) {
        if (ls.usingGenerated) {
          // Real persisted weakness, not a client-side reshuffle: await the
          // just-triggered results save (lsEnsureResultsSaved in lsShowEnd)
          // before regenerating, so the backend's weakness computation reads
          // this session's attempts rather than racing ahead of the write.
          lsEnsureResultsSaved().then(function () {
            return lsGenerateOrLoadPart(ls.module, ls.partId);
          }).then(function () {
            lsEl('glListenPractice').style.display = '';
            lsEl('glListenEnd').style.display = 'none';
            lsResetToPracticeTabChrome();
            if (ls._lastGenFailed) return; // lsShowGenerationError() already drew the error panel
            lsRenderPlayerChrome();
            lsRenderWorkspace();
          });
          return;
        }
        // Static-set fallback: ephemeral, session-only retry — no persistent
        // Weak Areas store for this path, so this just picks a different
        // static set (when more than one exists) and orders its questions
        // with the categories the student just missed first.
        var idx = LISTEN_SETS.length > 1 ? (ls.setIndex + 1) % LISTEN_SETS.length : ls.setIndex;
        var set = LISTEN_SETS[idx];
        var ordered = set.questions.slice().sort(function (a, b) {
          var aw = weakCats.indexOf(a.category) !== -1 ? 0 : 1;
          var bw = weakCats.indexOf(b.category) !== -1 ? 0 : 1;
          return aw - bw;
        });
        lsLoadSet(idx, ordered);
        lsEl('glListenPractice').style.display = '';
        lsEl('glListenEnd').style.display = 'none';
        lsResetToPracticeTabChrome();
        lsRenderPlayerChrome();
        lsRenderWorkspace();
      }

      function lsNewListening() {
        if (lsResolveProfileId()) {
          // Same "always fresh, always HV1" guarantee as the in-practice New
          // Test button — a learner who just finished HV3 clicking "New
          // listening" must not silently resume on HV3.
          lsStartNewTest();
          return;
        }
        var idx = lsPickSetIndex(ls.setIndex);
        lsLoadSet(idx);
        lsEl('glListenPractice').style.display = '';
        lsEl('glListenEnd').style.display = 'none';
        lsResetToPracticeTabChrome();
        lsRenderPlayerChrome();
        lsRenderWorkspace();
      }
    })();

    // Re-apply hero badge after profile loads (app.js fires this when profile is ready)
    window.addEventListener('ss-profile-updated', _glRefreshHero);

    // Profile-driven exam workspace (manifest -> navigation, profile-switch reset).
    import('/js/features/german-exam/exam-workspace.js').then(function (mod) {
      mod.initExamWorkspace({
        base: typeof BACKEND_URL === 'string' ? BACKEND_URL : '',
        profileReady: function () {
          var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
          return !!p && p.state === 'ready';
        },
        resolveProfileId: function () {
          var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
          return (p && p.examProfileId) || null;
        },
        // The SAVED exam selection is the cache/refresh key; the server resolves which exam profile it maps to,
        // so the workspace follows the saved profile without a client-side exam registry.
        savedProfileKey: function () {
          var p = window.getGermanLearnerProfile && window.getGermanLearnerProfile();
          return p && p.state === 'ready' && p.userType === 'learner' && p.testFamily && p.targetLevel
            ? p.testFamily + '|' + p.targetLevel
            : '';
        },
        onProfileChange: function (prev, next) {
          _glCancelAllGenerations();
          if (typeof window._glCloseListeningView === 'function') window._glCloseListeningView();
          _glProfileResetHooks.forEach(function (fn) { try { fn(next); } catch (e) { /* keep resetting the rest */ } });
          if (prev && _glActiveSkill && typeof window._glBackToHome === 'function') window._glBackToHome();
        },
        activeSkill: function () { return _glActiveSkill; },
        onActiveSkillBlocked: function (skill, reason) {
          if (typeof window._glBackToHome === 'function') window._glBackToHome();
          if (typeof showToast === 'function') showToast('Not available yet', reason);
        }
      });
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[German exam] workspace failed to load.', err);
    });
  } // end _init
})();
