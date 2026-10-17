(function () {
  'use strict';
  var root = document.getElementById('affiliateRoot');
  var token = localStorage.getItem('sb_sess_token') || sessionStorage.getItem('sb_sess_token') || localStorage.getItem('sb_token');
  var cfg = window.MinalloConfig || {};

  function signInState(message) {
    document.body.classList.remove('af-pending');
    root.innerHTML = '<div class="af-state"><div><p>' + message + '</p><a href="/?auth=signin">Sign in to Minallo</a></div></div>';
  }
  function money(cents) {
    return new Intl.NumberFormat('en-IE', { style:'currency', currency:'EUR' }).format(cents / 100);
  }
  function date(value) {
    return new Intl.DateTimeFormat('en', { day:'2-digit', month:'short', year:'numeric' }).format(new Date(value));
  }
  async function refreshToken() {
    var refresh = localStorage.getItem('sb_sess_refresh') || sessionStorage.getItem('sb_sess_refresh') || localStorage.getItem('sb_refresh');
    if (!refresh || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
    var response = await fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:{'Content-Type':'application/json',apikey:cfg.supabaseAnonKey}, body:JSON.stringify({refresh_token:refresh})
    });
    if (!response.ok) return null;
    var data = await response.json();
    localStorage.setItem('sb_sess_token', data.access_token);
    if (data.refresh_token) localStorage.setItem('sb_sess_refresh', data.refresh_token);
    return data.access_token;
  }
  async function load(retried) {
    if (!token) { window.location.replace('/?auth=signin'); return; }
    var response = await fetch('/api/affiliate-dashboard', { headers:{Authorization:'Bearer ' + token} });
    if (response.status === 401 && !retried) { token = await refreshToken(); return load(true); }
    if (response.status === 403) { window.location.replace('/'); return; }
    if (!response.ok) return signInState('We could not load your dashboard right now.');
    render(await response.json());
  }
  function render(data) {
    document.body.classList.remove('af-pending');
    var s = data.stats;
    root.innerHTML =
      '<section class="af-link-card"><div><span class="af-link-label">Your personal referral link</span><div class="af-link" id="referralLink"></div></div><button class="af-copy" id="copyLink">Copy link</button></section>' +
      '<div class="af-tabs" role="tablist"><button class="af-tab active" data-tab="overview">Overview</button><button class="af-tab" data-tab="revenue">Revenue</button></div>' +
      '<section class="af-overview" id="overviewPanel"><div class="af-grid">' +
      stat('Signed up',s.signups,'People who joined with your link') + stat('Started trial',s.trials,'Activated the 7-day free trial') + stat('Subscribed',s.subscriptions,'Continued with a paid plan') +
      '</div><div class="af-list">' + referralRows(data.recentReferrals) + '</div></section>' +
      '<section class="af-revenue" id="revenuePanel"><span class="af-eyebrow">Commission balance</span><h2>Revenue earned</h2><div class="af-money">' + money(s.revenueCents) + '</div><p class="af-rule">€3.00 is added once for every referred person who becomes a paying subscriber.</p></section>';
    document.getElementById('referralLink').textContent = data.referralLink;
    document.getElementById('copyLink').onclick = function () {
      navigator.clipboard.writeText(data.referralLink);
      this.textContent = 'Copied'; setTimeout(function(){document.getElementById('copyLink').textContent='Copy link';},1400);
    };
    document.querySelectorAll('.af-tab').forEach(function(btn){btn.onclick=function(){
      document.querySelectorAll('.af-tab').forEach(function(b){b.classList.remove('active')}); btn.classList.add('active');
      var revenue=btn.getAttribute('data-tab')==='revenue'; document.getElementById('overviewPanel').classList.toggle('hidden',revenue); document.getElementById('revenuePanel').classList.toggle('active',revenue);
    }});
  }
  function stat(label,value,detail){return '<article class="af-stat"><span class="af-stat-name">'+label+'</span><strong>'+value+'</strong><small>'+detail+'</small></article>'}
  function referralRows(rows){if(!rows.length)return '<div class="af-empty">Your first referral will appear here.</div>';return rows.map(function(r){var stage=r.subscribed_at?'Subscribed':r.trial_started_at?'7-day trial':'Signed up';return '<div class="af-row"><div><strong>'+stage+'</strong><br><span>'+date(r.signed_up_at)+'</span></div><strong>'+(r.subscribed_at?'+ €3.00':'—')+'</strong></div>'}).join('')}
  load(false).catch(function(){signInState('We could not load your dashboard right now.')});
})();
