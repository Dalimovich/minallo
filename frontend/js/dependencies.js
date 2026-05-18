// Shared lazy dependency loaders for feature code.
(function () {
  var scriptPromises = {};
  var stylePromises = {};
  var SRI = {
    jsPdf: 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
    html2Canvas: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
    pdfJs: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
    katexCss: 'sha384-wcIxkf4k558AjM3Yz3BBFQUbk/zgIYC2R0QpeeYb+TwlBVMrlgLqwRjRtGZiK7ww',
    katexJs: 'sha384-hIoBPJpTUs74ddyc4bFZSM1TVlQDA60VBbJS0oA934VSz82sBx1X7kSx2ATBDIyd',
    katexAutoRender: 'sha384-43gviWU0YVjaDtb/GhzOouOXtZMP/7XUzwPTstBeZFe/+rCMvRwr4yROQP43s0Xk'
  };

  function sriAttrs(integrity) {
    return integrity ? { integrity: integrity, crossorigin: 'anonymous' } : {};
  }

  function loadScriptOnce(src, attrs) {
    if (!src) return Promise.reject(new Error('Missing script URL'));
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src.replace(/"/g, '\\"') + '"]');
      if (existing) {
        if (existing.dataset.loaded === '1') {
          resolve();
          return;
        }
        existing.addEventListener(
          'load',
          function () {
            resolve();
          },
          { once: true }
        );
        existing.addEventListener(
          'error',
          function () {
            reject(new Error('Failed to load ' + src));
          },
          { once: true }
        );
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      Object.keys(attrs || {}).forEach(function (k) {
        s.setAttribute(k, attrs[k]);
      });
      s.onload = function () {
        s.dataset.loaded = '1';
        resolve();
      };
      s.onerror = function () {
        reject(new Error('Failed to load ' + src));
      };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  function loadStyleOnce(href, attrs) {
    if (!href) return Promise.reject(new Error('Missing stylesheet URL'));
    if (stylePromises[href]) return stylePromises[href];
    stylePromises[href] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('link[href="' + href.replace(/"/g, '\\"') + '"]');
      if (existing) {
        if (existing.dataset.loaded === '1') {
          resolve();
          return;
        }
        existing.addEventListener(
          'load',
          function () {
            resolve();
          },
          { once: true }
        );
        existing.addEventListener(
          'error',
          function () {
            reject(new Error('Failed to load ' + href));
          },
          { once: true }
        );
        return;
      }
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      Object.keys(attrs || {}).forEach(function (k) {
        l.setAttribute(k, attrs[k]);
      });
      l.onload = function () {
        l.dataset.loaded = '1';
        resolve();
      };
      l.onerror = function () {
        reject(new Error('Failed to load ' + href));
      };
      document.head.appendChild(l);
    });
    return stylePromises[href];
  }

  function ensureJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    return loadScriptOnce(
      'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
      sriAttrs(SRI.jsPdf)
    );
  }

  function ensureHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve();
    return loadScriptOnce(
      'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      sriAttrs(SRI.html2Canvas)
    );
  }

  function ensurePdfJs() {
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      return Promise.resolve();
    }
    return loadScriptOnce(
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      sriAttrs(SRI.pdfJs)
    ).then(function () {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      });
  }

  function ensurePdfExportDeps() {
    return ensureJsPdf().then(ensureHtml2Canvas);
  }

  function ensurePayPalSdk() {
    if (window.paypal) return Promise.resolve();
    var cfg = window.MinalloConfig || {};
    return loadScriptOnce(cfg.paypalSdkUrl, { 'data-sdk-integration-source': 'button-factory' });
  }

  function ensureKatex() {
    if (window.katex && window.renderMathInElement) return Promise.resolve();
    return loadStyleOnce(
      'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css',
      sriAttrs(SRI.katexCss)
    )
      .then(function () {
        if (window.katex) return;
        return loadScriptOnce(
          'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.js',
          sriAttrs(SRI.katexJs)
        );
      })
      .then(function () {
        if (window.renderMathInElement) return;
        return loadScriptOnce(
          'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/contrib/auto-render.min.js',
          sriAttrs(SRI.katexAutoRender)
        );
      });
  }

  window._ssLoadScriptOnce = loadScriptOnce;
  window._ssLoadStyleOnce = loadStyleOnce;
  window._ssEnsureJsPdf = ensureJsPdf;
  window._ssEnsureHtml2Canvas = ensureHtml2Canvas;
  window._ssEnsurePdfJs = ensurePdfJs;
  window._ssEnsurePdfExportDeps = ensurePdfExportDeps;
  window._ssEnsurePayPalSdk = ensurePayPalSdk;
  window._ssEnsureKatex = ensureKatex;

  // Pre-load KaTeX immediately so math renders without delay on first answer
  ensureKatex().catch(function () {});
})();
