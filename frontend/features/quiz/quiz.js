// Quiz feature module — Phase 1 scaffold.
// Mirrors flashcards.js. Real backend wiring + AI generation in Phase 2.

(function () {
  var TEMPLATE_URL = 'features/quiz/quiz.html';
  var _templatePromise = null;

  function _loadTemplate() {
    if (_templatePromise) return _templatePromise;
    _templatePromise = fetch(TEMPLATE_URL)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var root = tmp.querySelector('[data-quiz-root]');
        return root ? root.outerHTML : html;
      })
      .catch(function (err) {
        console.error('quiz template load error:', err);
        return '<div class="qz-empty">Failed to load quiz UI.</div>';
      });
    return _templatePromise;
  }

  window.mountQuiz = function (target, course) {
    if (!target) return Promise.resolve();
    return _loadTemplate().then(function (html) {
      target.innerHTML = html;
      var root = target.querySelector('[data-quiz-root]');
      if (!root) return;
      _initShell(root, course);
    });
  };

  function _initShell(root, course) {
    var list = root.querySelector('#qzList');
    if (list) {
      list.innerHTML =
        '<div class="qz-empty">' +
        'No quizzes yet. Click <strong>Generate quiz</strong> to make one from this course\'s indexed PDFs.' +
        '</div>';
    }
    var generateBtn = root.querySelector('#qzGenerateBtn');
    if (generateBtn) {
      generateBtn.addEventListener('click', function () {
        if (typeof window.showToast === 'function') {
          window.showToast(
            'Generation coming next',
            'Quiz generation hooks up in the next deploy.'
          );
        }
      });
    }
    if (course && course.id) root.dataset.courseId = course.id;
  }
})();
