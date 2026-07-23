function _subT(key, fallback) {
  // `_t` returns the key itself when a translation is missing, which would
  // otherwise short-circuit `||` and leak the raw key into the UI. Detect
  // that case and use the English fallback instead.
  var v = window._t && window._t(key);
  if (!v || v === key) return fallback;
  return v;
}

/** One-time retention modal — shown once per user after they confirm
 * cancellation. Resolves to true if the user accepts the discount,
 * false if they want to continue cancelling. Matches the rest of the
 * app's modal chrome and adapts to light/dark mode via body.night. */
/** Two-step cancel flow:
 *   Step 1: confirmation ("Are you sure you want to cancel?")
 *   Step 2 (if user confirms): retention discount offer
 * Resolves with one of:
 *   'accept'   → user took the discount → stay on Pro, apply coupon
 *   'cancel'   → user declined the discount → continue cancellation flow
 *   'dismiss'  → user backed out at step 1 → do nothing
 */
function _showRetentionOffer() {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'sub-retention-overlay';
    overlay.innerHTML =
      '<div class="sub-retention-modal" role="dialog" aria-modal="true">' +
        '<div class="sub-retention-step" data-step="confirm">' +
          '<div class="sub-retention-emoji" aria-hidden="true">&#x1F914;</div>' +
          '<h2 class="sub-retention-title">' +
            _subT('sub_confirm_cancel_title', 'Are you sure you want to cancel?') +
          '</h2>' +
          '<p class="sub-retention-sub">' +
            _subT('sub_confirm_cancel_sub', 'You will lose access to Pro features at the end of your billing period.') +
          '</p>' +
          '<div class="sub-retention-actions">' +
            '<button type="button" class="sub-retention-decline" data-action="keep">' +
              _subT('sub_confirm_keep', 'Keep my subscription') +
            '</button>' +
            '<button type="button" class="sub-retention-danger" data-action="continue">' +
              _subT('sub_confirm_continue', 'Yes, cancel') +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sub-retention-step" data-step="offer" style="display:none">' +
          '<div class="sub-retention-emoji" aria-hidden="true">&#x1F389;</div>' +
          '<h2 class="sub-retention-title">' +
            _subT('sub_retention_title', 'Wait — one-time offer just for you') +
          '</h2>' +
          '<p class="sub-retention-sub">' +
            _subT('sub_retention_sub', 'Before you go, here is a special discount.') +
          '</p>' +
          '<div class="sub-retention-price-row">' +
            '<span class="sub-retention-price-old">&euro;11.99</span>' +
            '<svg class="sub-retention-arrow" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/></svg>' +
            '<span class="sub-retention-price-new">&euro;8.99</span>' +
            '<span class="sub-retention-per">/' +
              _subT('sub_retention_per', 'month') +
            '</span>' +
          '</div>' +
          '<p class="sub-retention-note">' +
            _subT('sub_retention_note', '€8.99 for your next billing cycle, then back to €11.99. This offer is only shown once.') +
          '</p>' +
          '<div class="sub-retention-actions">' +
            '<button type="button" class="sub-retention-decline" data-action="decline">' +
              _subT('sub_retention_decline', 'No thanks, cancel anyway') +
            '</button>' +
            '<button type="button" class="sub-retention-accept" data-action="accept">' +
              _subT('sub_retention_accept', 'Keep Pro for €8.99/month') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function finish(result) {
      overlay.classList.add('is-closing');
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 180);
    }

    function showStep(name) {
      overlay.querySelectorAll('.sub-retention-step').forEach(function (el) {
        el.style.display = el.getAttribute('data-step') === name ? '' : 'none';
      });
    }

    overlay.querySelector('[data-action="keep"]').addEventListener('click', function () { finish('dismiss'); });
    overlay.querySelector('[data-action="continue"]').addEventListener('click', function () { showStep('offer'); });
    overlay.querySelector('[data-action="accept"]').addEventListener('click', function () { finish('accept'); });
    overlay.querySelector('[data-action="decline"]').addEventListener('click', function () { finish('cancel'); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) finish('dismiss');
    });
  });
}
(function () {
  var feature = {
    sectionId: 'psec-subscription',
    html: 'views/subscription/subscription.html',
    css: 'views/subscription/subscription.css'
  };
  if (window.Minallo) {
    window.Minallo.registerFeature('subscription', feature);
  } else {
    window.MinalloFeatures = window.MinalloFeatures || {};
    window.MinalloFeatures.subscription = feature;
  }

  var section = document.getElementById('psec-subscription');
  if (section) section.dataset.feature = 'subscription';
})();

var _userIsPro = false;
var _userIsPaused = false;
var _stripeCustomerId = null;
var _paypalSubscriptionId = null;
var _hadTrial = false;
var _deviceHadTrial = false;
var _pauseResumesAt = null;
var _lastSubscription = {};
var _paypalRendered = false;
var _paywallPaypalRendered = false;
var _paypalRenderPending = false;
var _paywallPaypalRenderPending = false;
var _paypalPlanId = '';
var _ppConsentTs = '';
var _billingConfigPromise = null;
var _lastPaywallFeatureMsg = '';

// subscription.js loads EARLY in the boot chain (before app-data.js/main.js),
// while window._subService is only assigned at the end of main.js. On a hard
// refresh landing directly on #portal=subscription, _initPayPalButton can
// therefore run before the service exists — rejecting immediately here threw
// "[paypal-init] failed: Subscription service not ready" plus a spurious
// "Payment unavailable" toast on every such refresh. Wait for the service
// instead; it arrives within a moment of main.js finishing.
function _waitForSubService(timeoutMs) {
  if (window._subService) return Promise.resolve(window._subService);
  return new Promise(function (resolve, reject) {
    var waited = 0;
    var iv = setInterval(function () {
      if (window._subService) {
        clearInterval(iv);
        resolve(window._subService);
        return;
      }
      waited += 200;
      if (waited >= (timeoutMs || 15000)) {
        clearInterval(iv);
        reject(new Error('Subscription service not ready'));
      }
    }, 200);
  });
}

function _loadBillingConfig() {
  if (_billingConfigPromise) return _billingConfigPromise;
  _billingConfigPromise = _waitForSubService(15000)
    .then(function (svc) {
      return svc.loadBillingConfig();
    })
    .catch(function (err) {
      // Don't cache the failure — clear it so the next call (e.g. on
      // hashchange) retries instead of erroring forever.
      _billingConfigPromise = null;
      throw err;
    });
  return _billingConfigPromise;
}

function _trialDeviceId() {
  var key = 'minallo_trial_device_id';
  try {
    var existing = localStorage.getItem(key);
    if (existing) return existing;
    var id = (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    localStorage.setItem(key, id);
    return id;
  } catch (e) {
    return '';
  }
}

function _deviceTrialUsed() {
  try {
    return localStorage.getItem('minallo_trial_used') === '1';
  } catch (e) {
    return false;
  }
}

function _markDeviceTrialUsed() {
  _deviceHadTrial = true;
  try {
    localStorage.setItem('minallo_trial_used', '1');
  } catch (e) { /* ignore */ }
}

function _ensurePayPalPlanId() {
  if (_paypalPlanId) return Promise.resolve(_paypalPlanId);
  var cfg = window.MinalloConfig || {};
  if (cfg.paypalPlanId) {
    _paypalPlanId = String(cfg.paypalPlanId);
    return Promise.resolve(_paypalPlanId);
  }
  return _loadBillingConfig().then(function (payload) {
    _paypalPlanId = String((payload && payload.paypalPlanId) || '').trim();
    if (!_paypalPlanId) throw new Error('Missing PayPal plan configuration');
    window.MinalloConfig = Object.assign({}, window.MinalloConfig || {}, {
      paypalPlanId: _paypalPlanId
    });
    return _paypalPlanId;
  });
}

async function _activatePayPalSubscription(data, closePaywall, consent) {
  if (!_currentUser) return;
  await window._subService.activatePayPalSubscription(
    data && data.subscriptionID,
    _trialDeviceId(),
    consent || { consentWiderrufVerzicht: false, consentTimestamp: '' }
  );
  applySubscription({ plan: 'pro', status: 'active' });
  if (closePaywall) {
    var modal = document.getElementById('paywallModal');
    if (modal) modal.style.display = 'none';
  }
  showToast(_subT('sub_pro_activated', 'Pro activated!'), _subT('sub_pro_enjoy', 'Enjoy unlimited access.'));
}

function applySubscription(sub) {
  _lastSubscription = sub || {};
  var expiresAt = sub && sub.expires_at ? Date.parse(sub.expires_at) : null;
  var isPaused = !!(sub && sub.status === 'paused');
  var isExpired = !isPaused && Number.isFinite(expiresAt) && expiresAt <= Date.now();
  var status = sub && sub.status ? String(sub.status) : '';
  var hasBillingProvider = !!(sub && (sub.stripe_subscription_id || sub.stripe_customer_id || sub.paypal_subscription_id));
  var managedAccess = !!(sub && (sub.admin_managed || sub.affiliate_managed));
  var dbManagedPro =
    !!(sub && sub.plan === 'pro' && !hasBillingProvider && ['cancelled', 'expired', 'past_due', 'paused'].indexOf(status) === -1);
  _userIsPro = !!(
    sub &&
    sub.plan === 'pro' &&
    ((status === 'active' || status === 'trialing') || dbManagedPro) &&
    !isExpired
  );
  _userIsPaused = isPaused;
  _pauseResumesAt = sub && sub.pause_resumes_at ? sub.pause_resumes_at : null;
  if (sub && sub.stripe_customer_id) _stripeCustomerId = sub.stripe_customer_id;
  if (sub && sub.paypal_subscription_id) _paypalSubscriptionId = sub.paypal_subscription_id;
  if (sub && sub.had_trial) _hadTrial = true;
  if (_deviceTrialUsed()) _deviceHadTrial = true;
  var proStatus = document.getElementById('subProStatus');
  var upgradeBtn = document.getElementById('subUpgradeBtn');
  var manageBtn = document.getElementById('subManageBtn');
  var cancelBtn = document.getElementById('subCancelBtn');
  var pausePanel = document.getElementById('subPausePanel');
  var resumePanel = document.getElementById('subResumePanel');
  var pausedUntil = document.getElementById('subPausedUntil');
  var payMethods = document.getElementById('subPayMethods');
  var paypalCont = document.getElementById('paypalButtonContainer');
  if (_userIsPro) {
    var scheduledCancel = !!(sub && sub.cancel_at_period_end);
    var hasStripeSub = !!(sub && (sub.stripe_subscription_id || _stripeCustomerId));
    var hasPaypalSub = !!(sub && sub.paypal_subscription_id);
    // Resubscribe-via-PayPal: the original PayPal sub was /cancel'd at PayPal's
    // end (one-way) so reactivation isn't possible — but we can let them
    // create a fresh PayPal sub. Show the upgrade UI in that case only.
    var paypalResubscribe = scheduledCancel && hasPaypalSub && !hasStripeSub;
    var reactivateBtn = document.getElementById('subReactivateBtn');
    var legalBlock = document.getElementById('subLegalBlock');
    if (proStatus) {
      if (scheduledCancel && expiresAt) {
        var endStr = new Date(expiresAt).toLocaleDateString();
        proStatus.textContent =
          _subT('sub_status_ends_pre', '⏳ Pro access until ') + endStr;
      } else {
        proStatus.textContent = managedAccess
          ? _subT('sub_status_included', '✓ Pro access included')
          : _subT('sub_status_active', '✓ Active subscription');
      }
      proStatus.style.display = '';
    }
    if (upgradeBtn) {
      upgradeBtn.style.display = paypalResubscribe ? '' : 'none';
      if (paypalResubscribe) {
        // Resubscribe copy — the user already used their trial, and a new
        // subscription created while Pro is still active starts billing
        // immediately, so don't promise a trial in the label.
        upgradeBtn.textContent = _subT('sub_resubscribe', 'Resubscribe — €11.99/month');
      }
    }
    if (manageBtn) manageBtn.style.display = _stripeCustomerId ? '' : 'none';
    // Hide the standalone Cancel button when a Stripe customer exists OR when
    // cancellation is already scheduled — there's nothing more to cancel.
    if (cancelBtn) cancelBtn.style.display = (_stripeCustomerId || scheduledCancel || managedAccess) ? 'none' : '';
    // Reactivate: only meaningful for Stripe (one-call un-cancel). PayPal goes
    // through the resubscribe flow with the existing PayPal button instead.
    if (reactivateBtn) reactivateBtn.style.display = (scheduledCancel && hasStripeSub) ? '' : 'none';
    // No vacation pause when a cancellation is already pending.
    if (pausePanel) pausePanel.style.display = (scheduledCancel || managedAccess) ? 'none' : '';
    if (resumePanel) resumePanel.style.display = 'none';
    // Hide the upgrade-only chrome when Pro is uninterrupted. For PayPal
    // scheduled-cancel we expose it so the user can resubscribe before the
    // current period ends.
    if (legalBlock) legalBlock.style.display = paypalResubscribe ? '' : 'none';
    if (payMethods) payMethods.style.display = paypalResubscribe ? '' : 'none';
    if (paypalCont) paypalCont.style.display = paypalResubscribe ? '' : 'none';
  } else if (_userIsPaused) {
    if (proStatus) {
      proStatus.style.display = '';
      proStatus.textContent = _subT('sub_paused_status', 'Paused subscription');
    }
    if (upgradeBtn) upgradeBtn.style.display = 'none';
    if (manageBtn) manageBtn.style.display = _stripeCustomerId ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = _stripeCustomerId ? 'none' : '';
    if (pausePanel) pausePanel.style.display = 'none';
    if (resumePanel) resumePanel.style.display = '';
    if (pausedUntil) {
      var dt = _pauseResumesAt ? new Date(_pauseResumesAt) : null;
      pausedUntil.textContent =
        dt && Number.isFinite(dt.getTime())
          ? _subT('sub_paused_until_pre', 'Pro access is paused until ') + dt.toLocaleDateString() + '.'
          : _subT('sub_paused_copy', 'Pro access is paused during your vacation.');
    }
    if (payMethods) payMethods.style.display = 'none';
    if (paypalCont) paypalCont.style.display = 'none';
  } else {
    if (proStatus) proStatus.style.display = 'none';
    if (upgradeBtn) {
      upgradeBtn.textContent = (_hadTrial || _deviceHadTrial)
        ? _subT('sub_subscribe', 'Subscribe — €11.99/month')
        : _subT('sub_start_trial', 'Start free 7-day trial');
      upgradeBtn.disabled = false;
      upgradeBtn.style.display = '';
      upgradeBtn.style.opacity = '';
    }
    if (manageBtn) manageBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (pausePanel) pausePanel.style.display = 'none';
    if (resumePanel) resumePanel.style.display = 'none';
    if (payMethods) payMethods.style.display = '';
    if (paypalCont) paypalCont.style.display = '';
  }
  _bindSubscriptionControls();
}

async function _refreshSubscriptionState() {
  if (!_currentUser || !_currentUser.id) return;
  var sub = null;
  try {
    if (window._sb && window._sb.from) {
      sub = await window._sb.from('subscriptions').select('*').eq('user_id', _currentUser.id).single();
    }
  } catch (e) {
    sub = null;
  }

  if (sub && sub.status !== 'paused' && sub.expires_at && Date.parse(sub.expires_at) <= Date.now()) {
    sub = Object.assign({}, sub, { status: 'expired' });
  }

  var status = sub && sub.status ? String(sub.status) : '';
  var hasBillingProvider = !!(sub && (sub.stripe_subscription_id || sub.stripe_customer_id || sub.paypal_subscription_id));
  var dbManagedPro =
    !!(sub && sub.plan === 'pro' && !hasBillingProvider && ['cancelled', 'expired', 'past_due', 'paused'].indexOf(status) === -1);
  if (sub && sub.plan === 'pro' && (['active', 'trialing', 'paused'].indexOf(status) !== -1 || dbManagedPro)) {
    applySubscription(dbManagedPro ? Object.assign({}, sub, { status: status || 'active' }) : sub);
    return;
  }

  try {
    var adminRes = await fetch('/api/admin-users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (window._sbToken || '')
      },
      body: JSON.stringify({ action: 'status' })
    });
    var adminData = adminRes.ok ? await adminRes.json().catch(function () { return null; }) : null;
    if (adminData && adminData.isAdmin) {
      applySubscription(Object.assign({}, sub || {}, {
        plan: 'pro',
        status: sub && sub.status === 'paused' ? 'paused' : 'active',
        admin_managed: true
      }));
      return;
    }
  } catch (e) {
    // Local Vite without Netlify dev can fail this route; the DB row above is
    // still enough for normal subscribed accounts.
  }

  applySubscription(sub || {});
}

function _initPayPalButton(attempt) {
  if (_paypalRendered || _paypalRenderPending) return;
  var container = document.getElementById('paypalButtonContainer');
  if (!container) {
    // subscription.html may not be injected yet; retry briefly.
    if ((attempt || 0) < 25) setTimeout(function () { _initPayPalButton((attempt || 0) + 1); }, 200);
    return;
  }
  if (typeof paypal === 'undefined') {
    _ssEnsurePayPalSdk()
      .then(function () {
        // Reset the pending flag in case a prior attempt silently bailed,
        // then schedule a fresh call so the render actually runs.
        _paypalRenderPending = false;
        setTimeout(function () { _initPayPalButton((attempt || 0) + 1); }, 50);
      })
      .catch(function (err) {
        console.warn('PayPal SDK failed to load:', err);
      });
    return;
  }
  _paypalRenderPending = true;
  _ensurePayPalPlanId()
    .then(function (planId) {
      _paypalRendered = true;
      return paypal
        .Buttons({
          style: {
            layout: 'horizontal',
            color: 'blue',
            shape: 'rect',
            label: 'subscribe',
            height: 40
          },
          createSubscription: function (data, actions) {
            // Same § 312j Abs. 3 BGB consent gate as Stripe. Refuse to open
            // PayPal at all when the Widerruf checkbox is not ticked — this
            // is the only point where we can stop a PayPal subscription
            // before money moves.
            var box = document.getElementById('subConsentWiderruf');
            if (!box || !box.checked) {
              showToast(
                _subT('sub_consent_required', 'Hinweis'),
                _subT('sub_consent_required_sub', 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.')
              );
              return Promise.reject(new Error('consent_required'));
            }
            _ppConsentTs = new Date().toISOString();
            return actions.subscription.create({
              plan_id: planId,
              custom_id: _currentUser && _currentUser.id
            });
          },
          onApprove: async function (data) {
            showToast(_subT('sub_payment_received', 'Payment received'), _subT('sub_activating', 'Activating your Pro plan...'));
            try {
              await _activatePayPalSubscription(data, false, {
                consentWiderrufVerzicht: true,
                consentTimestamp: _ppConsentTs || new Date().toISOString()
              });
              return;
            } catch (e) {
              console.error('[paypal-activate] failed:', e);
              showToast(
                _subT('sub_activation_error', 'Activation error'),
                (e && e.message) || _subT('sub_activation_error_sub', 'Contact support.')
              );
            }
          },
          onError: function (err) {
            console.error('PayPal error:', err);
            showToast(
              _subT('sub_paypal_error', 'PayPal error'),
              typeof err === 'string'
                ? err
                : (err && err.message) || _subT('sub_paypal_error_default', 'Please try again or use card.')
            );
          }
        })
        .render('#paypalButtonContainer');
    })
    .catch(function (err) {
      // Render or plan-config failure: log the real reason and reset the
      // rendered flag so a later trigger (hashchange, ss-ready) can retry.
      // Without this reset, a transient failure (PayPal SDK blip, missing
      // plan id on first load) leaves the container silently empty forever.
      _paypalRendered = false;
      console.error('[paypal-init] failed:', err);
      var msg = (err && err.message) || _subT('sub_payment_unavailable_sub', 'Subscription configuration is missing.');
      showToast(_subT('sub_payment_unavailable', 'Payment unavailable'), msg);
    })
    .finally(function () {
      _paypalRenderPending = false;
    });
}

function _paywallFeatureCopy(featureMsg) {
  var raw = String(featureMsg || '').toLowerCase();
  var lang = window._lang === 'de' ? 'de' : 'en';
  var fallback = lang === 'de'
    ? {
        name: 'Minallo Pro',
        context: 'Du moechtest Pro nutzen',
        title: 'Starte Pro und schalte Minallo frei',
        desc: 'Teste Pro 7 Tage kostenlos und schalte Minallos kompletten Pruefungsworkflow frei: AI Tutor, Cheatsheet, Flashcards, Quiz, ExamForge und Deep Learn.'
      }
    : {
        name: 'Minallo Pro',
        context: 'You’re trying to use Pro',
        title: 'Start Pro and unlock Minallo',
        desc: 'Try Pro free for 7 days and unlock Minallo’s full exam-prep workflow: AI Tutor, Cheatsheet, Flashcards, Quiz, ExamForge, and Deep Learn.'
      };
  var map = [
    ['cheatsheet', 'Cheatsheet',
      'Start Pro and turn this file into a compact revision Cheatsheet.',
      'Starte Pro und verwandle diese Datei in ein kompaktes Wiederholungs-Cheatsheet.'],
    ['examforge', 'ExamForge',
      'Start Pro and create exam-style practice from this course.',
      'Starte Pro und erstelle pruefungsnahe Uebungen aus diesem Kurs.'],
    ['deep learn', 'Deep Learn',
      'Start Pro and learn this topic step by step with your AI tutor.',
      'Starte Pro und lerne dieses Thema Schritt fuer Schritt mit deinem KI-Tutor.'],
    ['quiz', 'Quiz',
      'Start Pro and create practice questions from your course material.',
      'Starte Pro und erstelle Uebungsfragen aus deinem Kursmaterial.'],
    ['flashcard', 'Flashcards',
      'Start Pro and revise your course material with active recall.',
      'Starte Pro und wiederhole dein Kursmaterial mit Active Recall.'],
    ['multi-pdf', 'Summaries',
      'Start Pro and summarize multiple course files in one study flow.',
      'Starte Pro und fasse mehrere Kursdateien in einem Lernfluss zusammen.'],
    ['summary', 'Summaries',
      'Start Pro and summarize your course material for faster revision.',
      'Starte Pro und fasse dein Kursmaterial fuer schnellere Wiederholung zusammen.'],
    ['ai tutor', 'AI Tutor',
      'Start Pro and get course-based help from your AI tutor.',
      'Starte Pro und bekomme kursbasierte Hilfe von deinem KI-Tutor.']
  ];
  for (var i = 0; i < map.length; i++) {
    if (raw.indexOf(map[i][0]) !== -1) {
      var name = map[i][1];
      return {
        name: name,
        context: lang === 'de' ? 'Du moechtest ' + name + ' nutzen' : 'You’re trying to use ' + name,
        title: lang === 'de' ? 'Starte Pro und schalte ' + name + ' frei' : 'Start Pro and unlock ' + name,
        desc: lang === 'de' ? map[i][3] : map[i][2]
      };
    }
  }
  return fallback;
}

function _showPaywall(featureMsg) {
  if (featureMsg) _lastPaywallFeatureMsg = String(featureMsg);
  var copy = _paywallFeatureCopy(featureMsg || _lastPaywallFeatureMsg);
  var btn = document.getElementById('paywallUpgradeBtn');
  if (btn)
    btn.textContent = (_hadTrial || _deviceHadTrial)
      ? _subT('sub_subscribe', 'Subscribe — €11.99/month')
      : _subT('pw_start_trial_cta', 'Start 7-day free trial');
  var modal = document.getElementById('paywallModal');
  if (modal) {
    var ctx = modal.querySelector('[data-paywall-context]');
    if (ctx) ctx.textContent = copy.context;
    var title = modal.querySelector('[data-paywall-title]');
    if (title) {
      title.textContent = copy.title;
      title.removeAttribute('data-i18n');
    }
    var descDefault = modal.querySelector('[data-paywall-desc]');
    if (descDefault) {
      descDefault.textContent = copy.desc;
      descDefault.removeAttribute('data-i18n');
    }
    var priceToday = modal.querySelector('[data-paywall-price-today]');
    if (priceToday) priceToday.textContent = window._lang === 'de' ? '0 € heute' : '€0 today';
    var afterDefault = modal.querySelector('[data-after-trial]');
    if (afterDefault) {
      afterDefault.textContent = window._lang === 'de' ? 'Danach 11,99 €/Monat nach der Testphase' : 'Then €11.99/month after the trial';
      afterDefault.removeAttribute('data-i18n');
    }
    var cancelDefault = modal.querySelector('[data-cancel-note]');
    if (cancelDefault) {
      cancelDefault.textContent = window._lang === 'de' ? 'Jederzeit vor Ende der Testphase kuendbar.' : 'Cancel anytime before the trial ends.';
      cancelDefault.removeAttribute('data-i18n');
    }
  }
  if ((_hadTrial || _deviceHadTrial) && modal) {
    var trialBadge = modal.querySelector('.sub-trial-badge');
    if (trialBadge) trialBadge.style.display = 'none';
    var desc = modal.querySelector('[data-paywall-desc]');
    if (desc) {
      desc.textContent = _subT('pw_desc_trialed', 'Subscribe to access all Minallo features for €11.99/month.');
      desc.removeAttribute('data-i18n');
    }
    var afterTrial = modal.querySelector('[data-after-trial]');
    if (afterTrial) {
      afterTrial.textContent = window._lang === 'de' ? '11,99 €/Monat' : '€11.99/month';
      afterTrial.removeAttribute('data-i18n');
    }
    var cancelNote = modal.querySelector('[data-cancel-note]');
    if (cancelNote) {
      cancelNote.textContent = window._lang === 'de' ? 'Jederzeit kündbar.' : 'Cancel anytime.';
      cancelNote.removeAttribute('data-i18n');
    }
  }
  if (modal) modal.style.display = 'flex';
  if (!_paywallPaypalRendered && typeof paypal === 'undefined') {
    _ssEnsurePayPalSdk()
      .then(function () {
        _showPaywall(_lastPaywallFeatureMsg);
      })
      .catch(function (err) {
        console.warn('PayPal SDK failed to load:', err);
      });
    return;
  }
  if (!_paywallPaypalRendered && !_paywallPaypalRenderPending && typeof paypal !== 'undefined') {
    var container = document.getElementById('paywallPaypal');
    if (container) {
      _paywallPaypalRenderPending = true;
      _ensurePayPalPlanId()
        .then(function (planId) {
          _paywallPaypalRendered = true;
          return paypal
            .Buttons({
              style: {
                layout: 'horizontal',
                color: 'blue',
                shape: 'rect',
                label: 'subscribe',
                height: 38
              },
              createSubscription: function (data, actions) {
                // The paywall has no inline Widerruf consent box. Refuse to
                // start PayPal here and route the user to the full
                // subscription view where the checkbox lives — same rule as
                // the paywall Stripe button. Without this, PayPal would
                // bypass the § 312j Abs. 3 BGB consent that Stripe enforces.
                showToast(
                  _subT('sub_consent_required', 'Hinweis'),
                  _subT('sub_consent_required_sub', 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.')
                );
                var modal = document.getElementById('paywallModal');
                if (modal) modal.style.display = 'none';
                if (typeof window.showPortalSection === 'function') {
                  window.showPortalSection('subscription');
                }
                return Promise.reject(new Error('consent_required'));
              },
              onApprove: async function (data) {
                // Unreachable in normal flow because createSubscription rejects,
                // but kept as a defensive no-op so we never activate without
                // server-side consent verification.
                showToast(
                  _subT('sub_consent_required', 'Hinweis'),
                  _subT('sub_consent_required_sub', 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.')
                );
                return;
              },
              onError: function (err) {
                console.error('PayPal error:', err);
                showToast(_subT('sub_paypal_error', 'PayPal error'), _subT('sub_paypal_error_default', 'Please try again or use card.'));
              }
            })
            .render('#paywallPaypal');
        })
        .catch(function (err) {
          _paywallPaypalRendered = false;
          console.warn('PayPal plan config failed to load:', err);
          showToast(_subT('sub_payment_unavailable', 'Payment unavailable'), _subT('sub_payment_unavailable_sub', 'Subscription configuration is missing.'));
        })
        .finally(function () {
          _paywallPaypalRenderPending = false;
        });
    }
  }
}

function _requirePro(featureMsg) {
  if (_userIsPro) return true;
  _showPaywall(featureMsg);
  return false;
}

function _bindSubscriptionControls() {
  var manageBtn = document.getElementById('subManageBtn');
  if (manageBtn && !manageBtn.dataset.bound) {
    manageBtn.dataset.bound = '1';
    manageBtn.addEventListener('click', async function () {
      if (!_stripeCustomerId) {
        showToast(_subT('sub_not_available', 'Not available'), _subT('sub_no_stripe', 'No Stripe account found.'));
        return;
      }
      // Intercept the portal launch ONCE per user to offer the retention
      // discount. If they accept → apply discount and stay; if they
      // decline → open the Stripe portal as normal (where they can do
      // anything else, including cancel through Stripe).
      if (_currentUser) {
        var _retentionKey = 'ms_retention_offer_seen_' + (_currentUser.id || 'anon');
        var _alreadyOffered = false;
        try { _alreadyOffered = localStorage.getItem(_retentionKey) === '1'; } catch (_e) {}
        // If the popup has been shown before, skip it and go straight to
        // the portal. Otherwise show the 2-step flow: any close other than
        // explicit 'accept' should just dismiss, NOT auto-open the portal.
        var _result = _alreadyOffered ? null : await _showRetentionOffer();
        // 'dismiss' (kept subscription / backdrop close) → stop here.
        // 'cancel' (No thanks, cancel anyway) → fall through to the Stripe
        // portal so the user can complete the cancellation.
        // 'accept' → apply the discount and stop.
        if (_result === 'dismiss') return;
        if (_result === 'accept') {
          try {
            await window._subService.applyRetentionDiscount();
            try { localStorage.setItem(_retentionKey, '1'); } catch (_e) {}
            applySubscription({
              plan: 'pro',
              status: 'active',
              cancel_at_period_end: false,
              stripe_customer_id: _stripeCustomerId,
              paypal_subscription_id: _paypalSubscriptionId,
              had_trial: _hadTrial
            });
            showToast(
              _subT('sub_discount_applied_title', 'Discount applied!'),
              _subT('sub_discount_applied_body', '€8.99 for your next billing cycle, then back to €11.99.')
            );
          } catch (e) {
            showToast(
              _subT('sub_error', 'Error'),
              e.message || _subT('sub_discount_failed', 'Could not apply discount.')
            );
          }
          return;
        }
        // 'cancel' → fall through to the Stripe portal so the user can cancel
        try { localStorage.setItem(_retentionKey, '1'); } catch (_e) {}
      }
      this.textContent = _subT('sub_loading', 'Loading...');
      this.disabled = true;
      try {
        var data = await window._subService.createPortalSession();
        if (data.url) location.href = data.url;
        else showToast(_subT('sub_error', 'Error'), data.error || _subT('sub_portal_failed', 'Could not open portal.'));
      } catch (e) {
        showToast(_subT('sub_error', 'Error'), e.message);
      }
      this.textContent = _subT('sub_manage', '⚙️ Manage / Cancel subscription');
      this.disabled = false;
    });
  }

  var upgradeBtn = document.getElementById('subUpgradeBtn');
  var consentBox = document.getElementById('subConsentWiderruf');
  if (consentBox && upgradeBtn && !consentBox.dataset.bound) {
    consentBox.dataset.bound = '1';
    var syncEnabled = function () {
      // Button stays disabled until the user actively ticks the Widerruf-Verzicht
      // consent. We capture this client-side and the create-checkout function
      // then records the choice in Stripe metadata so we have evidence of consent
      // per § 312j Abs. 3 / § 356 Abs. 5 BGB.
      upgradeBtn.disabled = !consentBox.checked;
    };
    consentBox.addEventListener('change', syncEnabled);
    syncEnabled();
  }

  if (upgradeBtn && !upgradeBtn.dataset.bound) {
    upgradeBtn.dataset.bound = '1';
    upgradeBtn.addEventListener('click', async function () {
      if (!_currentUser) {
        showToast(_subT('sub_signin_required', 'Sign in required'), _subT('sub_login_first', 'Please log in first.'));
        return;
      }
      if (consentBox && !consentBox.checked) {
        showToast('Hinweis', 'Bitte bestaetige die Widerrufs-Information, bevor du fortfaehrst.');
        return;
      }
      this.textContent = _subT('sub_redirecting', 'Redirecting...');
      this.disabled = true;
      try {
        var data = await window._subService.createCheckoutSession(_hadTrial || _deviceHadTrial, {
          consentWiderrufVerzicht: !!(consentBox && consentBox.checked),
          consentTimestamp: new Date().toISOString()
        }, _trialDeviceId());
        if (data.url) {
          location.href = data.url;
        } else {
          showToast(_subT('sub_error', 'Error'), data.error || _subT('sub_checkout_failed', 'Could not start checkout.'));
          this.textContent = _subT('sub_upgrade', 'Upgrade to Pro');
          this.disabled = false;
        }
      } catch (e) {
        showToast(_subT('sub_error', 'Error'), e.message);
        this.textContent = _subT('sub_upgrade', 'Upgrade to Pro');
        this.disabled = false;
      }
    });
  }

  var pauseDate = document.getElementById('subPauseResumeAt');
  if (pauseDate && !pauseDate.dataset.initialized) {
    pauseDate.dataset.initialized = '1';
    var now = new Date();
    var min = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    var max = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    var toDateValue = function (d) {
      return d.toISOString().slice(0, 10);
    };
    pauseDate.min = toDateValue(min);
    pauseDate.max = toDateValue(max);
    pauseDate.value = toDateValue(min);
  }

  var pauseBtn = document.getElementById('subPauseBtn');
  if (pauseBtn && !pauseBtn.dataset.bound) {
    pauseBtn.dataset.bound = '1';
    pauseBtn.addEventListener('click', async function () {
      if (!_currentUser) return;
      var dateInput = document.getElementById('subPauseResumeAt');
      var resumeAt = dateInput && dateInput.value ? dateInput.value + 'T12:00:00.000Z' : '';
      if (!resumeAt) {
        showToast(_subT('sub_error', 'Error'), 'Choose a resume date.');
        return;
      }
      this.textContent = _subT('sub_pausing', 'Pausing...');
      this.disabled = true;
      try {
        var data = await window._subService.pauseSubscription(resumeAt, 'Vacation pause');
        applySubscription({
          plan: 'pro',
          status: 'paused',
          pause_resumes_at: data.pause_resumes_at || null,
          stripe_customer_id: _stripeCustomerId,
          paypal_subscription_id: _paypalSubscriptionId,
          had_trial: _hadTrial
        });
        // Backend signals auto_resumes=false for PayPal — PayPal /suspend has
        // no scheduled resume, so tell the user they must manually press
        // Resume on the chosen date instead of promising it happens for them.
        if (data && data.auto_resumes === false) {
          showToast(
            _subT('sub_paused_toast_title', 'Subscription paused'),
            _subT(
              'sub_paused_manual_resume',
              'Your Pro access is paused. PayPal subscriptions do not auto-resume — come back here on your return date and tap Resume.'
            )
          );
        } else {
          showToast(
            _subT('sub_paused_toast_title', 'Subscription paused'),
            _subT('sub_paused_toast_body', 'Your Pro access is paused until the selected date.')
          );
        }
      } catch (e) {
        showToast(_subT('sub_error', 'Error'), e.message || _subT('sub_pause_failed', 'Could not pause subscription.'));
      }
      this.textContent = _subT('sub_pause_btn', 'Pause subscription');
      this.disabled = false;
    });
  }

  var resumeBtn = document.getElementById('subResumeBtn');
  if (resumeBtn && !resumeBtn.dataset.bound) {
    resumeBtn.dataset.bound = '1';
    resumeBtn.addEventListener('click', async function () {
      if (!_currentUser) return;
      this.textContent = _subT('sub_resuming', 'Resuming...');
      this.disabled = true;
      try {
        var data = await window._subService.resumeSubscription();
        applySubscription({
          plan: 'pro',
          status: 'active',
          expires_at: data.expires_at || null,
          stripe_customer_id: _stripeCustomerId,
          paypal_subscription_id: _paypalSubscriptionId,
          had_trial: _hadTrial
        });
        showToast(
          _subT('sub_resumed_toast_title', 'Subscription resumed'),
          _subT('sub_resumed_toast_body', 'Your Pro access is active again.')
        );
      } catch (e) {
        showToast(_subT('sub_error', 'Error'), e.message || _subT('sub_resume_failed', 'Could not resume subscription.'));
      }
      this.textContent = _subT('sub_resume_btn', 'Resume now');
      this.disabled = false;
    });
  }

  var cancelBtn = document.getElementById('subCancelBtn');
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = '1';
    cancelBtn.addEventListener('click', async function () {
      if (!_currentUser) return;
      // Two-step modal: confirm cancel → then offer the discount (once per
      // user). Replaces the old native confirm() so the whole flow is in
      // a styled popup that respects light/dark mode.
      var _retentionKey = 'ms_retention_offer_seen_' + (_currentUser.id || 'anon');
      var _alreadyOffered = false;
      try { _alreadyOffered = localStorage.getItem(_retentionKey) === '1'; } catch (_e) {}
      var _result = await _showRetentionOffer();
      // 'dismiss' (kept subscription / backdrop close) → stop here.
      // 'cancel' (No thanks, cancel anyway) → proceed to actual cancellation.
      // 'accept' → apply discount (handled in the next branch) and stop.
      if (_result === 'dismiss') return;
      if (_result === 'accept' && !_alreadyOffered) {
        try {
          await window._subService.applyRetentionDiscount();
          try { localStorage.setItem(_retentionKey, '1'); } catch (_e) {}
          applySubscription({
            plan: 'pro',
            status: 'active',
            cancel_at_period_end: false,
            stripe_customer_id: _stripeCustomerId,
            paypal_subscription_id: _paypalSubscriptionId,
            had_trial: _hadTrial
          });
          showToast(
            _subT('sub_discount_applied_title', 'Discount applied!'),
            _subT('sub_discount_applied_body', '€8.99 for your next billing cycle, then back to €11.99.')
          );
        } catch (e) {
          showToast(
            _subT('sub_error', 'Error'),
            e.message || _subT('sub_discount_failed', 'Could not apply discount.')
          );
        }
        return;
      }
      // 'cancel' (or 'accept' after already used) → proceed to cancellation
      try { localStorage.setItem(_retentionKey, '1'); } catch (_e) {}
      this.textContent = _subT('sub_cancelling', 'Cancelling...');
      this.disabled = true;
      try {
        var data = await window._subService.cancelSubscription();
        if (data && data.status === 'scheduled' && data.expires_at) {
          // Stripe cancel-at-period-end — user still has Pro until expires_at.
          applySubscription({
            plan: 'pro',
            status: 'active',
            expires_at: data.expires_at,
            cancel_at_period_end: true,
            stripe_customer_id: _stripeCustomerId,
            paypal_subscription_id: _paypalSubscriptionId,
            had_trial: _hadTrial
          });
          var endDate = new Date(data.expires_at);
          var endStr = Number.isFinite(endDate.getTime()) ? endDate.toLocaleDateString() : '';
          showToast(
            _subT('sub_cancelled_scheduled_title', 'Cancellation scheduled'),
            _subT('sub_cancelled_scheduled_body_pre', 'You will keep Pro access until ') + endStr + '.'
          );
        } else {
          applySubscription({ plan: 'free', status: 'cancelled', had_trial: _hadTrial });
          showToast(
            _subT('sub_cancelled_title', 'Subscription cancelled'),
            _subT('sub_cancelled_body', 'Your subscription has been cancelled.')
          );
        }
      } catch (e) {
        showToast(_subT('sub_error', 'Error'), e.message || _subT('sub_cancel_failed', 'Could not cancel subscription.'));
      }
      this.textContent = _subT('sub_cancel_btn', 'Cancel subscription');
      this.disabled = false;
    });
  }

  var reactivateBtn = document.getElementById('subReactivateBtn');
  if (reactivateBtn && !reactivateBtn.dataset.bound) {
    reactivateBtn.dataset.bound = '1';
    reactivateBtn.addEventListener('click', async function () {
      if (!_currentUser) return;
      this.textContent = _subT('sub_reactivating', 'Reactivating...');
      this.disabled = true;
      try {
        var data = await window._subService.reactivateSubscription();
        applySubscription({
          plan: 'pro',
          status: 'active',
          expires_at: data && data.expires_at ? data.expires_at : null,
          cancel_at_period_end: false,
          stripe_customer_id: _stripeCustomerId,
          paypal_subscription_id: _paypalSubscriptionId,
          had_trial: _hadTrial
        });
        showToast(
          _subT('sub_reactivated_title', 'Subscription reactivated'),
          _subT('sub_reactivated_body', 'Your Pro access continues with no interruption.')
        );
      } catch (e) {
        showToast(
          _subT('sub_error', 'Error'),
          (e && e.message) || _subT('sub_reactivate_failed', 'Could not reactivate subscription.')
        );
      }
      this.textContent = _subT('sub_reactivate_btn', 'Reactivate subscription');
      this.disabled = false;
    });
  }

  var paywallBtn = document.getElementById('paywallUpgradeBtn');
  if (paywallBtn && !paywallBtn.dataset.bound) {
    paywallBtn.dataset.bound = '1';
    paywallBtn.addEventListener('click', async function () {
      if (!_currentUser) return;
      // Paywall has no inline consent block — route the user to the full
      // subscription view where the consent checkbox lives. This ensures the
      // Widerruf-Verzicht is captured before checkout in every flow.
      var modal = document.getElementById('paywallModal');
      if (modal) modal.style.display = 'none';
      if (typeof window.showPortalSection === 'function') {
        window.showPortalSection('subscription');
      }
    });
  }

  var paywallNotNowBtn = document.getElementById('paywallNotNowBtn');
  if (paywallNotNowBtn && !paywallNotNowBtn.dataset.bound) {
    paywallNotNowBtn.dataset.bound = '1';
    paywallNotNowBtn.addEventListener('click', function () {
      var modal = document.getElementById('paywallModal');
      if (modal) modal.style.display = 'none';
    });
  }

  var paywallLogoutBtn = document.getElementById('paywallLogoutBtn');
  if (paywallLogoutBtn && !paywallLogoutBtn.dataset.bound) {
    paywallLogoutBtn.dataset.bound = '1';
    paywallLogoutBtn.addEventListener('click', function () {
      if (typeof window._sbSignOut === 'function') window._sbSignOut();
      else if (typeof window._obLogout === 'function') window._obLogout();
      else {
        localStorage.removeItem('sb_token');
        localStorage.removeItem('sb_refresh');
        sessionStorage.clear();
        window.location.reload();
      }
    });
  }
}

function _renderAiUsage() {
  if (typeof window.refreshAiUsage !== 'function') return;
  window.refreshAiUsage().then(function (u) {
    if (!u) return;
    var wrap = document.getElementById('subUsage');
    if (!wrap) return;
    var interactive = u.interactive || { used: u.used, limit: u.limit, percentUsed: u.percentUsed };
    var generation = u.generation || { used: 0, limit: 0, percentUsed: 0 };

    var fill = document.getElementById('subUsageFill');
    var count = document.getElementById('subUsageCount');
    if (fill && count) {
      fill.style.width = Math.min(100, interactive.percentUsed) + '%';
      count.textContent = interactive.used + ' / ' + interactive.limit + ' chat calls';
    }
    var fillGen = document.getElementById('subUsageFillGen');
    var countGen = document.getElementById('subUsageCountGen');
    if (fillGen && countGen) {
      fillGen.style.width = Math.min(100, generation.percentUsed) + '%';
      countGen.textContent = generation.used + ' / ' + generation.limit + ' generations';
    }
    wrap.hidden = false;
    var peak = Math.max(interactive.percentUsed, generation.percentUsed);
    wrap.classList.toggle('sub-usage--warn', peak >= 80 && peak < 100);
    wrap.classList.toggle('sub-usage--cap', peak >= 100);
  });
}

document.addEventListener('click', function (e) {
  if (e.target.closest('#psbSubscription'))
    setTimeout(function () {
      _bindSubscriptionControls();
      _initPayPalButton();
      _renderAiUsage();
    }, 400);
});

// Also initialise when the user lands on the subscription view directly
// (hash like #portal=subscription, or a page refresh while already there).
// The click handler above only fires when the menu item is actually clicked.
//
// Two timing problems to handle:
//   1. subscription.html is injected lazily by loader.js, so #subUsage may
//      not exist when our module first runs. We poll briefly until it does.
//   2. ss-ready (fired by loader.js when all features are loaded) is the
//      best one-shot signal — listen for it too.
function _initSubscriptionViewIfActive() {
  var hash = String(window.location.hash || '');
  if (!/portal=subscription/.test(hash)) return;
  var tries = 0;
  function attempt() {
    var el = document.getElementById('subUsage');
    if (el) {
      applySubscription(_lastSubscription);
      _bindSubscriptionControls();
      _initPayPalButton();
      _renderAiUsage();
      _refreshSubscriptionState().then(function () {
        _bindSubscriptionControls();
      });
      return;
    }
    if (tries++ < 20) setTimeout(attempt, 200);
  }
  attempt();
}
window.addEventListener('ss-ready', _initSubscriptionViewIfActive);
window.addEventListener('hashchange', _initSubscriptionViewIfActive);
window.addEventListener('ss-profile-updated', _initSubscriptionViewIfActive);
// Re-apply translated button labels + paywall override text when the user
// switches language; data-i18n covers static text but the upgrade button
// label is set imperatively by applySubscription().
window.addEventListener('minallo:lang-changed', function () {
  try {
    if (typeof applySubscription === 'function' && _userIsPro !== undefined) {
      var current = Object.assign({}, _lastSubscription || {}, {
        plan: _userIsPro || _userIsPaused ? 'pro' : ((_lastSubscription || {}).plan || 'free'),
        status: _userIsPaused ? 'paused' : (_userIsPro ? 'active' : ((_lastSubscription || {}).status || 'inactive')),
        had_trial: _hadTrial
      });
      applySubscription(current);
    }
  } catch (e) { /* ignore */ }
});
if (document.readyState !== 'loading') _initSubscriptionViewIfActive();
else document.addEventListener('DOMContentLoaded', _initSubscriptionViewIfActive);

document.addEventListener(
  'keydown',
  function (e) {
    if (e.key === 'Escape' && !_userIsPro) e.stopImmediatePropagation();
  },
  true
);

(function () {
  var params = new URLSearchParams(location.search);
  if (params.get('payment') === 'success') {
    var sessionId = params.get('session_id');
    history.replaceState(null, '', location.pathname);
    showToast(_subT('sub_payment_success', 'Payment successful!'), _subT('sub_activating', 'Activating your Pro plan...'));
    var attempts = 0;
    var verify = setInterval(async function () {
      attempts++;
      if (!_currentUser && attempts < 20) return;
      clearInterval(verify);
      if (!_currentUser || !sessionId) return;
      try {
        // _currentUser (supabase.js, early) can be ready long before
        // window._subService (end of main.js) — wait for the service so a
        // fast boot can't drop the post-checkout verification.
        var svc = await _waitForSubService(15000);
        var data = await svc.verifyPayment(sessionId);
        if (data.ok) {
          if (data.had_trial) _markDeviceTrialUsed();
          applySubscription({ plan: 'pro', status: 'active', expires_at: data.expires_at || null });
          var modal = document.getElementById('paywallModal');
          if (modal) modal.style.display = 'none';
          showToast(_subT('sub_pro_activated', '✅ Pro activated!'), _subT('sub_pro_enjoy', 'Enjoy unlimited access.'));
        }
      } catch (e) {
        console.warn('Verify payment error:', e);
      }
    }, 500);
  } else if (params.get('payment') === 'cancelled') {
    history.replaceState(null, '', location.pathname);
  }
})();
