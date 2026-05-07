// Flashcards feature module.
//
// Phase 1 scaffold — exposes a single mount function used by course-files.js
// to populate a course's flashcards tab. Subsequent phases will fill in:
//   - real deck list from /api/decks/list
//   - AI generation via /api/decks/generate (which uses indexed chunks)
//   - study state persistence
//
// Right now this is a deterministic stub so the new file structure is
// loaded and rendered without breaking anything; real wiring lands next phase.

(function () {
  var TEMPLATE_URL = 'features/flashcards/flashcards.html';
  var _templatePromise = null;

  function _loadTemplate() {
    if (_templatePromise) return _templatePromise;
    _templatePromise = fetch(TEMPLATE_URL)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var root = tmp.querySelector('[data-flashcards-root]');
        return root ? root.outerHTML : html;
      })
      .catch(function (err) {
        console.error('flashcards template load error:', err);
        return '<div class="fc-empty">Failed to load flashcards UI.</div>';
      });
    return _templatePromise;
  }

  // Public API: render flashcards into a target element for a given course.
  // Phase 1 just injects the template; later phases hydrate it with real data.
  window.mountFlashcards = function (target, course) {
    if (!target) return Promise.resolve();
    return _loadTemplate().then(function (html) {
      target.innerHTML = html;
      var root = target.querySelector('[data-flashcards-root]');
      if (!root) return;
      _initShell(root, course);
    });
  };

  function _initShell(root, course) {
    // Tiny placeholder behavior — real deck list arrives in Phase 3.
    var grid = root.querySelector('#fcDeckGrid');
    if (grid) {
      grid.innerHTML =
        '<div class="fc-empty">' +
        'No decks yet. Click <strong>Generate cards</strong> to make a deck from this course\'s indexed PDFs.' +
        '</div>';
    }
    var generateBtn = root.querySelector('#fcGenerateBtn');
    if (generateBtn) {
      generateBtn.addEventListener('click', function () {
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Generation coming next',
            'Deck generation hooks up in the next deploy.'
          );
        }
      });
    }
    // View toggle (cosmetic for now)
    root.querySelectorAll('.fc-view-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        root.querySelectorAll('.fc-view-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });
    // Reference course so eslint doesn't complain — used in later phases.
    if (course && course.id) root.dataset.courseId = course.id;
  }
})();
