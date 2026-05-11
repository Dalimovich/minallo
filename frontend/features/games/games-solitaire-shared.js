// â”€â”€ Shared solitaire card-flight animator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// fromRect : DOMRect of the source card (snapshot BEFORE render destroys it)
// html     : innerHTML of source card (to display rank/suit on the flying clone)
// cls      : className of source card
// destSel  : CSS selector to find destination element AFTER render (queried inside rAF)
//            Pass null to make the card shrink-and-fade (for removals)
// dur      : animation duration ms
function _solFly(fromRect, html, cls, destSel, dur) {
  if (!fromRect) return;
  dur = dur || 200;
  var fly = document.createElement('div');
  fly.className = cls || 'sol-card';
  fly.innerHTML = html || '';
  fly.style.cssText =
    'position:fixed;left:' +
    fromRect.left +
    'px;top:' +
    fromRect.top +
    'px;width:' +
    fromRect.width +
    'px;height:' +
    fromRect.height +
    'px;margin:0;z-index:9999;pointer-events:none;transition:left ' +
    dur +
    'ms cubic-bezier(.22,1,.36,1),top ' +
    dur +
    'ms cubic-bezier(.22,1,.36,1),width ' +
    dur +
    'ms,height ' +
    dur +
    'ms,opacity ' +
    dur +
    'ms,transform ' +
    dur +
    'ms;';
  document.body.appendChild(fly);
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      if (destSel) {
        var dst = document.querySelector(destSel);
        if (dst) {
          var r = dst.getBoundingClientRect();
          fly.style.left = r.left + 'px';
          fly.style.top = r.top + 'px';
          fly.style.width = r.width + 'px';
          fly.style.height = r.height + 'px';
        }
      } else {
        fly.style.opacity = '0';
        fly.style.transform = 'scale(0.25) rotate(12deg)';
      }
    });
  });
  setTimeout(function () {
    fly.remove();
  }, dur + 80);
}

function _solPlayWinSound() {
  try {
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    var notes = [523, 659, 784, 1047];
    notes.forEach(function (freq, ni) {
      setTimeout(function () {
        var osc = ac.createOscillator(),
          g = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, ac.currentTime);
        g.gain.linearRampToValueAtTime(0.35, ac.currentTime + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.45);
        osc.connect(g);
        g.connect(ac.destination);
        osc.start();
        osc.stop(ac.currentTime + 0.5);
      }, ni * 130);
    });
  } catch (e) {}
}

function _solWinOverlay(moves, newGameFn) {
  var table = document.getElementById('solTable');
  if (!table) return;
  if (table.querySelector('.sol-gameover-overlay')) return;
  table.style.position = 'relative';
  var ov = document.createElement('div');
  ov.className = 'sol-gameover-overlay';
  ov.innerHTML =
    '<div class="sol-gameover-title" style="color:#4ade80;font-size:2.8rem">\uD83C\uDF89 You Win!</div><div class="sol-gameover-sub">Completed in ' +
    moves +
    ' moves</div>';
  var playAgainBtn = document.createElement('button');
  playAgainBtn.className = 'sol-gameover-btn';
  playAgainBtn.textContent = 'Play Again';
  playAgainBtn.addEventListener('click', function () {
    if (typeof newGameFn === 'function') {
      newGameFn();
      return;
    }
    if (typeof newGameFn === 'string') {
      var fn = newGameFn.split('.').reduce(function (ctx, key) {
        return ctx && ctx[key];
      }, window);
      if (typeof fn === 'function') fn();
    }
  });
  ov.appendChild(playAgainBtn);
  table.appendChild(ov);
  _solPlayWinSound();
  for (var i = 0; i < 32; i++) {
    (function (i2) {
      setTimeout(function () {
        var c = document.createElement('div');
        c.style.cssText =
          'position:fixed;left:' +
          Math.random() * 100 +
          'vw;top:-20px;width:' +
          (8 + Math.random() * 8) +
          'px;height:' +
          (8 + Math.random() * 8) +
          'px;background:hsl(' +
          Math.random() * 360 +
          ',80%,60%);border-radius:2px;pointer-events:none;z-index:9999;animation:confettiDrop ' +
          (1.2 + Math.random() * 1.2) +
          's ease forwards';
        document.body.appendChild(c);
        setTimeout(function () {
          c.remove();
        }, 2600);
      }, i2 * 55);
    })(i);
  }
}

