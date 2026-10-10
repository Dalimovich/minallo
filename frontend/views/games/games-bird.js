// ── FLAPPY BIRD ────────────────────────────────────────────────────────────
(function () {
  var W = 360,
    H = 540;
  var GRAVITY = 0.45,
    JUMP = -8.5,
    PIPE_W = 52,
    PIPE_GAP = 145,
    PIPE_SPEED = 2.4,
    PIPE_INTERVAL = 90;
  var canvas, ctx, raf, running, started, dead;
  var bird, pipes, score, bestScore, frame, particles;

  // Fixed-timestep accumulator. Without this, update() ran once per
  // requestAnimationFrame tick — fine on 60Hz monitors but on 120/144/240Hz
  // displays the bird, pipes, and particles all moved at 2×–4× speed and
  // the game became unplayable. We now step physics at a constant 60Hz
  // (TARGET_DT_MS), and just render whatever the monitor wants.
  var TARGET_DT_MS = 1000 / 60;
  var MAX_FRAME_DT_MS = 100;   // cap so a backgrounded tab doesn't fast-forward
  var MAX_STEPS_PER_FRAME = 5; // belt-and-braces spiral-of-death guard
  var _lastTs = 0;
  var _accumulator = 0;

  // ── Sound ──
  function beep(freq, dur, vol, type) {
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      var o = ac.createOscillator(),
        g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.15, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + dur);
    } catch (e) {}
  }
  function sfxFlap() {
    beep(520, 0.08, 0.12, 'square');
  }
  function sfxScore() {
    beep(880, 0.1, 0.12, 'sine');
    setTimeout(function () {
      beep(1100, 0.1, 0.1, 'sine');
    }, 80);
  }
  function sfxDie() {
    beep(200, 0.3, 0.2, 'sawtooth');
    beep(150, 0.4, 0.15, 'sawtooth');
  }

  // ── Stars background ──
  var stars = [];
  function initStars() {
    stars = [];
    for (var i = 0; i < 60; i++)
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.5 + 0.3,
        s: Math.random() * 0.5 + 0.3
      });
  }

  function initBird() {
    bird = { x: 80, y: H / 2, vy: 0, r: 14, rot: 0, trail: [] };
  }

  function initGame() {
    pipes = [];
    score = 0;
    frame = 0;
    particles = [];
    bestScore = parseInt(localStorage.getItem('ss_bird_best') || '0');
    initBird();
    running = true;
    started = false;
    dead = false;
    document.getElementById('birdScore').textContent = '0';
    document.getElementById('birdBest').textContent = bestScore;
  }

  // ── Particles ──
  function spawnParticles(x, y, color) {
    for (var i = 0; i < 12; i++)
      particles.push({
        x: x,
        y: y,
        vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6,
        life: 1,
        color: color || '#3b82f6'
      });
  }

  function updateParticles() {
    particles = particles.filter(function (p) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life -= 0.04;
      return p.life > 0;
    });
  }

  function drawParticles() {
    particles.forEach(function (p) {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // ── Draw helpers ──
  function drawBg() {
    // Sky gradient
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#06020f');
    grad.addColorStop(0.5, '#100830');
    grad.addColorStop(1, '#0a0520');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Stars
    stars.forEach(function (s) {
      ctx.globalAlpha = 0.4 + 0.3 * Math.sin(frame * s.s * 0.05);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    // Ground
    var gGrad = ctx.createLinearGradient(0, H - 40, 0, H);
    gGrad.addColorStop(0, '#1a0d40');
    gGrad.addColorStop(1, '#0d0820');
    ctx.fillStyle = gGrad;
    ctx.fillRect(0, H - 40, W, 40);
    ctx.strokeStyle = 'rgba(59,130,246,.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, H - 40);
    ctx.lineTo(W, H - 40);
    ctx.stroke();
  }

  function drawPipe(pipe) {
    var topH = pipe.topH,
      botY = topH + PIPE_GAP;
    // Top pipe
    var tGrad = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_W, 0);
    tGrad.addColorStop(0, '#1a0d3e');
    tGrad.addColorStop(0.4, '#2d1a5c');
    tGrad.addColorStop(1, '#180b32');
    ctx.fillStyle = tGrad;
    ctx.fillRect(pipe.x, 0, PIPE_W, topH);
    // Top cap
    ctx.fillStyle = '#3d2070';
    ctx.fillRect(pipe.x - 4, topH - 16, PIPE_W + 8, 16);
    // Bottom pipe
    ctx.fillStyle = tGrad;
    ctx.fillRect(pipe.x, botY, PIPE_W, H - botY - 40);
    // Bottom cap
    ctx.fillStyle = '#3d2070';
    ctx.fillRect(pipe.x - 4, botY, PIPE_W + 8, 16);
    // Edge highlight
    ctx.strokeStyle = 'rgba(59,130,246,.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pipe.x, 0, PIPE_W, topH);
    ctx.strokeRect(pipe.x, botY, PIPE_W, H - botY - 40);
  }

  function drawBird() {
    var b = bird;
    // Trail
    b.trail.forEach(function (t, i) {
      var a = (i / b.trail.length) * 0.3;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#0ea5e9';
      ctx.beginPath();
      ctx.arc(t.x, t.y, b.r * (i / b.trail.length) * 0.7, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(Math.max(-0.5, Math.min(Math.PI / 2, b.rot)));

    // Glow
    ctx.shadowColor = 'rgba(59,130,246,.8)';
    ctx.shadowBlur = 18;

    // Body gradient
    var bg = ctx.createRadialGradient(-3, -3, 2, 0, 0, b.r);
    bg.addColorStop(0, '#e0aaff');
    bg.addColorStop(0.5, '#3b82f6');
    bg.addColorStop(1, '#2563eb');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(0, 0, b.r, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Eye
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(5, -3, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a0a2e';
    ctx.beginPath();
    ctx.arc(6, -3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(7, -4, 0.8, 0, Math.PI * 2);
    ctx.fill();

    // Beak
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.moveTo(10, -1);
    ctx.lineTo(18, 1);
    ctx.lineTo(10, 4);
    ctx.closePath();
    ctx.fill();

    // Wing
    ctx.fillStyle = 'rgba(167,139,250,.7)';
    ctx.beginPath();
    ctx.ellipse(-2, 5, 8, 4, 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function drawScore() {
    ctx.save();
    ctx.textAlign = 'center';
    if (started && !dead) {
      ctx.font = 'bold 36px "Fredoka One", cursive';
      ctx.shadowColor = 'rgba(59,130,246,.6)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillText(score, W / 2, 60);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  function drawOverlay() {
    // Semi-dark bg
    ctx.fillStyle = 'rgba(6,2,15,.75)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';

    if (dead) {
      ctx.font = 'bold 42px "Fredoka One", cursive';
      var grad = ctx.createLinearGradient(0, H / 2 - 60, 0, H / 2 - 20);
      grad.addColorStop(0, '#0ea5e9');
      grad.addColorStop(1, '#3b82f6');
      ctx.fillStyle = grad;
      ctx.fillText('Game Over', W / 2, H / 2 - 30);

      ctx.font = 'bold 18px Nunito, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      ctx.fillText('Score: ' + score + '   Best: ' + bestScore, W / 2, H / 2 + 10);
    } else {
      ctx.font = 'bold 40px "Fredoka One", cursive';
      var grad2 = ctx.createLinearGradient(0, H / 2 - 80, 0, H / 2 - 30);
      grad2.addColorStop(0, '#3b82f6');
      grad2.addColorStop(1, '#0ea5e9');
      ctx.fillStyle = grad2;
      ctx.fillText('Flappy Bird', W / 2, H / 2 - 30);

      ctx.font = 'bold 16px Nunito, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.fillText('Best: ' + bestScore, W / 2, H / 2 + 5);
    }

    // Play button
    var bx = W / 2,
      by = dead ? H / 2 + 70 : H / 2 + 55;
    var btnGrad = ctx.createLinearGradient(bx - 60, by - 22, bx + 60, by + 22);
    btnGrad.addColorStop(0, '#3b82f6');
    btnGrad.addColorStop(1, '#0ea5e9');
    ctx.fillStyle = btnGrad;
    ctx.beginPath();
    ctx.roundRect(bx - 60, by - 22, 120, 44, 22);
    ctx.fill();
    ctx.font = 'bold 16px Nunito, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(dead ? 'Play Again \u25B6' : 'Start \u25B6', bx, by + 6);
  }

  // ── Game loop ──
  function update() {
    frame++;
    if (!started || dead) return;

    // Bird physics
    bird.vy += GRAVITY;
    bird.y += bird.vy;
    bird.rot = bird.vy * 0.06;
    bird.trail.push({ x: bird.x, y: bird.y });
    if (bird.trail.length > 8) bird.trail.shift();

    // Spawn pipes
    if (frame % PIPE_INTERVAL === 0) {
      var minTop = 60,
        maxTop = H - 40 - PIPE_GAP - 60;
      pipes.push({ x: W + 10, topH: minTop + Math.random() * (maxTop - minTop), scored: false });
    }

    // Move pipes
    pipes.forEach(function (p) {
      p.x -= PIPE_SPEED * (1 + score * 0.02);
    });
    pipes = pipes.filter(function (p) {
      return p.x > -PIPE_W - 10;
    });

    // Score
    pipes.forEach(function (p) {
      if (!p.scored && p.x + PIPE_W < bird.x) {
        p.scored = true;
        score++;
        document.getElementById('birdScore').textContent = score;
        sfxScore();
        spawnParticles(bird.x, bird.y, '#0ea5e9');
        if (score > bestScore) {
          bestScore = score;
          localStorage.setItem('ss_bird_best', score);
          document.getElementById('birdBest').textContent = bestScore;
        }
      }
    });

    updateParticles();

    // Collisions
    if (bird.y + bird.r > H - 40 || bird.y - bird.r < 0) {
      die();
      return;
    }
    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      if (bird.x + bird.r - 4 > p.x && bird.x - bird.r + 4 < p.x + PIPE_W) {
        if (bird.y - bird.r + 4 < p.topH || bird.y + bird.r - 4 > p.topH + PIPE_GAP) {
          die();
          return;
        }
      }
    }
  }

  function die() {
    dead = true;
    running = false;
    sfxDie();
    spawnParticles(bird.x, bird.y, '#ef4444');
    spawnParticles(bird.x, bird.y, '#0ea5e9');
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem('ss_bird_best', score);
      document.getElementById('birdBest').textContent = bestScore;
    }
  }

  function draw() {
    drawBg();
    pipes.forEach(drawPipe);
    drawParticles();
    drawBird();
    drawScore();
    if (!started || dead) drawOverlay();
  }

  function loop(ts) {
    if (!canvas) return;
    if (!_lastTs) _lastTs = ts || performance.now();
    var now = ts || performance.now();
    var frameDt = Math.min(now - _lastTs, MAX_FRAME_DT_MS);
    _lastTs = now;
    _accumulator += frameDt;
    // Fixed-timestep physics: run update() one or more times until we've
    // caught up to the elapsed wall time, then render once. Identical
    // motion on 60Hz, 120Hz, 144Hz, 240Hz displays.
    var steps = 0;
    while (_accumulator >= TARGET_DT_MS && steps < MAX_STEPS_PER_FRAME) {
      update();
      _accumulator -= TARGET_DT_MS;
      steps++;
    }
    // If we hit the step cap (e.g. the tab was inactive for several seconds),
    // drop the leftover so the bird doesn't fast-forward through a wall of
    // pipes the moment focus returns.
    if (steps >= MAX_STEPS_PER_FRAME) _accumulator = 0;
    draw();
    raf = requestAnimationFrame(loop);
  }

  function flap() {
    if (dead) {
      initGame();
      started = true;
      sfxFlap();
      return;
    }
    if (!started) {
      started = true;
    }
    bird.vy = JUMP;
    bird.rot = -0.4;
    sfxFlap();
    spawnParticles(bird.x, bird.y + bird.r, '#60a5fa');
  }

  window._birdInit = function () {
    canvas = document.getElementById('birdCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    initStars();
    initGame();
    if (raf) cancelAnimationFrame(raf);
    // Reset the fixed-timestep clock so re-entering the game (e.g. closing
    // and reopening the modal) doesn't dump accumulated wall time into the
    // first frame and instantly skip the bird halfway across the screen.
    _lastTs = 0;
    _accumulator = 0;
    loop();
    if (!canvas._birdWired) {
      canvas._birdWired = true;
      canvas.addEventListener('click', flap);
      canvas.addEventListener(
        'touchstart',
        function (e) {
          e.preventDefault();
          flap();
        },
        { passive: false }
      );
    }
  };

  window._birdStop = function () {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    running = false;
  };

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      var screen = document.getElementById('gamesPlayBird');
      if (screen && screen.style.display !== 'none') {
        e.preventDefault();
        flap();
      }
    }
  });
})();
