// Minallo boot logo animation — plays inside #minalloBootCover while the app
// boots. The "m" is written left to right like a pen stroke, then the dot pops
// in with a little glitter, while the whole logo eases up to its final size.
//
// How the writing works: assets/minallo-boot-timemap.png stores, for every
// pixel of the logo, the moment (0..1 along the pen's path) at which the pen
// reaches it (16-bit: R = high byte, G = low byte; 65535 = not part of the
// "m", e.g. the dot). Each frame reveals the pixels the pen has passed, with a
// short soft edge at the pen tip. The final frame is the logo image exactly.
//
// Fallback: the static <img> in the cover stays visible whenever the animation
// can't run (reduced motion, image/canvas failure, slow image load).
// This file only draws; js/boot-cover.js still decides when the cover hides.
(function () {
  var cover = document.getElementById('minalloBootCover');
  if (!cover) return;
  var box = cover.querySelector('.mn-boot-logo');
  var mc = cover.querySelector('[data-boot-m]');
  var dc = cover.querySelector('[data-boot-dot]');
  var sparkLayer = cover.querySelector('[data-boot-sparks]');
  if (!box || !mc || !dc || !sparkLayer || !mc.getContext) return;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}

  var LOGO = '/assets/minallo-boot-logo.png';
  var TIMEMAP = '/assets/minallo-boot-timemap.png';
  var SIZE = 512;            // both images are 512x512
  var WRITE_MS = 1700;       // pen stroke duration
  var FEATHER = 0.06;        // soft pen-tip length, as a fraction of the path
  var LOAD_GIVE_UP_MS = 1500;
  var DOT_CLIP = [376, 90, 100, 99];  // x, y, w, h of the dot in the 512 image
  var DOT_X = 424, DOT_Y = 138;       // dot centre, sparkle origin
  var doc = document.documentElement;

  // Hide the static logo and show the (still empty) canvases before first paint.
  cover.classList.add('mn-boot-anim');
  var gaveUp = false;
  var giveUpTimer = setTimeout(fallback, LOAD_GIVE_UP_MS);
  function fallback() {
    gaveUp = true;
    cover.classList.remove('mn-boot-anim');
  }

  function load(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }
  function pixels(img) {
    var c = document.createElement('canvas');
    c.width = c.height = SIZE;
    var x = c.getContext('2d');
    x.drawImage(img, 0, 0, SIZE, SIZE);
    return x.getImageData(0, 0, SIZE, SIZE).data;
  }

  Promise.all([load(LOGO), load(TIMEMAP)]).then(function (imgs) {
    if (gaveUp || doc.classList.contains('mn-boot-done')) return;
    clearTimeout(giveUpTimer);
    var logo = imgs[0];
    var src = pixels(logo);
    var t = pixels(imgs[1]);

    // Only pixels that belong to the "m" are animated.
    var list = [], times = [];
    for (var p = 0; p < SIZE * SIZE; p++) {
      if (!src[p * 4 + 3]) continue;
      var v = t[p * 4] * 256 + t[p * 4 + 1];
      if (v === 65535) continue;
      list.push(p);
      times.push(v / 65000);
    }
    var mx = mc.getContext('2d');
    var out = mx.createImageData(SIZE, SIZE);
    var d = out.data;
    for (var i = 0; i < list.length; i++) {
      var q = list[i] * 4;
      d[q] = src[q]; d[q + 1] = src[q + 1]; d[q + 2] = src[q + 2];
    }

    var dx = dc.getContext('2d');
    dx.save();
    dx.beginPath();
    dx.rect(DOT_CLIP[0], DOT_CLIP[1], DOT_CLIP[2], DOT_CLIP[3]);
    dx.clip();
    dx.drawImage(logo, 0, 0, SIZE, SIZE);
    dx.restore();

    function frame(T) {
      for (var j = 0; j < list.length; j++) {
        var k = (T - times[j]) / FEATHER;
        k = k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
        var q2 = list[j] * 4;
        d[q2 + 3] = src[q2 + 3] * k;
      }
      mx.putImageData(out, 0, 0);
    }
    function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

    makeSparks();
    frame(-1);
    void box.offsetWidth;
    box.classList.add('go');

    var start = performance.now();
    function step(now) {
      if (doc.classList.contains('mn-boot-done')) { frame(2); return; }
      var prog = Math.min(1, (now - start) / WRITE_MS);
      frame(ease(prog) * (1 + FEATHER));
      if (prog < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    setTimeout(function () { box.classList.add('done'); }, 2400);
  }).catch(function () {
    clearTimeout(giveUpTimer);
    fallback();
  });

  function makeSparks() {
    var NS = 'http://www.w3.org/2000/svg';
    var cols = ['#ffffff', '#8ff6ff', '#2fe6cf', '#b9a3ff', '#ffffff', '#68dcff', '#eafffb', '#16c9f6'];
    var cx = DOT_X, cy = DOT_Y;
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2 + Math.random() * 0.4;
      var dist = 64 + Math.random() * 48;
      var s = i % 2 ? 9 : 15;
      var el;
      if (i % 2) {
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', cx);
        el.setAttribute('cy', cy);
        el.setAttribute('r', s / 2 + 1.5);
      } else {
        el = document.createElementNS(NS, 'path');
        el.setAttribute('d', 'M' + cx + ' ' + (cy - s) + ' Q' + cx + ' ' + cy + ' ' + (cx + s) + ' ' + cy +
          ' Q' + cx + ' ' + cy + ' ' + cx + ' ' + (cy + s) + ' Q' + cx + ' ' + cy + ' ' + (cx - s) + ' ' + cy +
          ' Q' + cx + ' ' + cy + ' ' + cx + ' ' + (cy - s) + 'Z');
      }
      el.setAttribute('class', 'mn-boot-spark');
      el.setAttribute('fill', cols[i]);
      el.style.setProperty('--dx', (Math.cos(a) * dist).toFixed(1) + 'px');
      el.style.setProperty('--dy', (Math.sin(a) * dist).toFixed(1) + 'px');
      el.style.animationDelay = (1.75 + i * 0.08).toFixed(2) + 's';
      sparkLayer.appendChild(el);
    }
  }
})();
