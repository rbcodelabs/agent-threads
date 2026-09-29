(function () {
  'use strict';

  var SHOTS = { pricing: 'assets/shot-pricing.svg', login: 'assets/shot-login.svg' };
  var TTL = 30;

  var I = {
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8"/><path d="M18 8a2 2 0 014 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.4 16a2 2 0 013-2.8L8 15"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>',
    kbd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0112 20c-7 0-11-8-11-8a18.5 18.5 0 015.1-5.9M9.9 4.2A9 9 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.2 3.2M14.1 14.1a3 3 0 11-4.2-4.2M1 1l22 22"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'
  };

  var SKEL = '<div class="bc-skel" aria-hidden="true"><div class="b" style="width:38%"></div><div class="b" style="width:78%"></div><div class="b" style="width:58%"></div><div class="r"><div class="c"></div><div class="c h"></div><div class="c"></div></div></div>';

  var BASE_STEPS = [['ok', 'navigate', 'acme.io', '1.2s'], ['ok', 'click', '"Sign in" button', '0.9s']];

  var STATES = {
    navigating: {
      group: 'a', label: 'Navigating', cls: 'is-navigating', status: 'Loading',
      url: 'acme.io/pricing', verb: 'navigate', target: 'acme.io/pricing', shot: false,
      steps: [['now', 'navigate', 'acme.io/pricing', '']],
      say: 'Claude is opening acme.io/pricing.'
    },
    live: {
      group: 'a', label: 'Acting', cls: 'is-live', status: 'Live',
      url: 'acme.io/pricing', verb: 'click', target: '"Pricing" nav link', shot: 'pricing',
      steps: [['ok', 'navigate', 'acme.io', '1.2s'], ['now', 'click', '"Pricing" nav link', '']],
      say: 'Claude is browsing acme.io.'
    },
    done: {
      group: 'a', label: 'Finished', cls: 'is-done', status: 'Done', collapsed: true,
      url: 'acme.io/pricing', verb: 'finished', target: '4 steps · 6.8s', shot: 'pricing', tag: 'Last capture',
      chip: ['Browsed acme.io', 'acme.io/pricing · 4 steps · 6.8s'],
      steps: [['ok', 'navigate', 'acme.io', '1.2s'], ['ok', 'click', '"Pricing" nav link', '0.9s'], ['ok', 'read', 'page text', '0.4s'], ['ok', 'screenshot', 'acme.io/pricing', '0.3s']],
      say: 'Browser session finished.'
    },
    error: {
      group: 'a', label: 'Error', cls: 'is-error', status: 'Failed',
      url: 'acme.io/pricing', verb: 'navigate failed', target: 'timed out after 30s', shot: false,
      error: ['Page did not finish loading', 'The request to acme.io/pricing timed out after 30 seconds.'],
      steps: [['ok', 'navigate', 'acme.io', '1.2s'], ['bad', 'click', '"Pricing" — timed out', '30s']],
      say: 'Browser action failed: page timed out.'
    },
    closed: {
      group: 'a', label: 'Ended', cls: 'is-closed', status: 'Ended', collapsed: true,
      url: 'acme.io/pricing', verb: 'session ended', target: 'browser closed', shot: 'pricing', tag: 'Session ended',
      chip: ['Session ended', 'acme.io/pricing · 5 steps · 9.1s'],
      steps: [['ok', 'navigate', 'acme.io', '1.2s'], ['ok', 'click', '"Pricing" nav link', '0.9s'], ['ok', 'read', 'page text', '0.4s'], ['ok', 'screenshot', 'acme.io/pricing', '0.3s'], ['ok', 'close', 'session', '0.1s']],
      say: 'Browser session ended.'
    },

    // ---- handoff: the human drives ----
    request: {
      group: 'h', label: 'Requested', cls: 'is-request has-mode', status: 'Waiting',
      url: 'acme.io/pricing', verb: 'waiting', target: 'for you to sign in', shot: 'pricing', ring: true,
      mode: { ico: 'user', title: 'Sign-in needed', sub: 'acme.io wants you to sign in' },
      overlay: { ico: 'lock', title: 'Sign in on a separate page', text: 'Opens accounts.acme.io in a temporary browser page you control.' },
      privacy: "Claude can't see the sign-in page or what you type.",
      actions: 'request',
      steps: BASE_STEPS.concat([['wait', 'sign in', 'waiting for you', '']]),
      say: 'Action needed: acme.io wants you to sign in. You have 30 seconds to take control.'
    },
    control: {
      group: 'h', label: "You're in control", cls: 'is-control has-mode', status: 'Manual',
      url: 'accounts.acme.io/login', verb: 'you', target: 'signing in to accounts.acme.io', shot: 'login', noopen: true,
      mode: { ico: 'hand', title: "You're in control", sub: 'Signing in to accounts.acme.io' },
      cue: 'Your input is being sent to this page',
      privacy: "Claude can't see this page or what you type.",
      actions: 'control',
      steps: BASE_STEPS.concat([['human', 'sign in', 'you · accounts.acme.io', '']]),
      say: "You're in control. Claude is waiting and can't see this page."
    },
    returned: {
      group: 'h', label: 'Returned', cls: 'is-returned has-mode', status: 'Live',
      url: 'acme.io/pricing', verb: 'resumed', target: 'signed in to acme.io', shot: 'pricing',
      mode: { ico: 'check', title: 'Signed in to acme.io', sub: 'Claude resumed' },
      steps: BASE_STEPS.concat([['ok', 'sign in', 'you · 14s', '14s'], ['now', 'read', 'page text', '']]),
      say: 'Control returned. Signed in to acme.io. Claude resumed.'
    },
    resumed: {
      hidden: true, label: 'Resumed', cls: 'is-live', status: 'Live',
      url: 'acme.io/pricing', verb: 'read', target: 'page text', shot: 'pricing',
      steps: BASE_STEPS.concat([['ok', 'sign in', 'you · 14s', '14s'], ['now', 'read', 'page text', '']]),
      say: 'Claude is browsing acme.io.'
    },
    expired: {
      group: 'h', label: 'Expired', cls: 'is-expired has-mode', status: 'Expired',
      url: 'acme.io/pricing', verb: 'sign-in', target: 'request expired', shot: 'pricing',
      mode: { ico: 'clock', title: 'Sign-in request expired', sub: 'Ask Claude to try again' },
      hint: 'Nothing was sent. <b>Ask Claude to retry</b> and click sign-in again.',
      steps: BASE_STEPS.concat([['bad', 'sign in', 'expired after 30s', '30s']]),
      say: 'The sign-in request expired. Ask Claude to try again.'
    }
  };

  var uid = 0;

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function stepRow(s) {
    return '<li class="bc-step ' + s[0] + '"><i></i><span class="v">' + s[1] + '</span><span class="t">' + s[2] + '</span>' + (s[3] ? '<span class="d">' + s[3] + '</span>' : '') + '</li>';
  }
  function host(u) { return u.split('/')[0]; }
  function esc(s) { return s.replace(/"/g, '&quot;'); }

  var C = 2 * Math.PI * 12;
  function ringHtml(rem) {
    return '<span class="bc-ring" aria-hidden="true"><svg viewBox="0 0 32 32"><circle class="track" cx="16" cy="16" r="12"/><circle class="val" cx="16" cy="16" r="12" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + (C * (1 - rem / TTL)).toFixed(2) + '"/></svg><b>' + rem + '</b></span>';
  }
  function setRing(card, rem) {
    var v = card.querySelector('.bc-ring .val');
    var b = card.querySelector('.bc-ring b');
    if (v) v.setAttribute('stroke-dashoffset', (C * (1 - rem / TTL)).toFixed(2));
    if (b) b.textContent = rem;
    var sr = card.querySelector('.bc-mode-text span');
    if (sr && card.classList.contains('is-request')) sr.textContent = 'acme.io wants you to sign in · ' + rem + 's left';
  }

  function card(key, opts) {
    opts = opts || {};
    var s = STATES[key];
    var id = 'bc' + (++uid);
    var collapsed = opts.collapsed !== undefined ? opts.collapsed : !!s.collapsed;
    var path = s.url.slice(host(s.url).length);
    var rem = opts.remaining !== undefined ? opts.remaining : 24;

    var view = s.shot ? '<img src="' + SHOTS[s.shot] + '" alt="' + (s.shot === 'login' ? 'Temporary sign-in page for accounts.acme.io' : 'Latest screenshot of ' + s.url) + '">' : SKEL;
    var overlay = '';
    if (s.error) overlay = '<div class="bc-overlay scrim" role="alert">' + I.alert + '<strong>' + s.error[0] + '</strong><span>' + s.error[1] + '</span></div>';
    if (s.overlay) overlay = '<div class="bc-overlay scrim">' + I[s.overlay.ico] + '<strong>' + s.overlay.title + '</strong><span>' + s.overlay.text + '</span></div>';
    var tag = s.tag ? '<span class="bc-tag">' + s.tag + '</span>' : '';
    var cue = s.cue ? '<span class="bc-cue">' + I.kbd + s.cue + '</span>' : '';
    var noOpen = !s.shot || s.noopen || s.overlay;
    var viewLabel = s.noopen ? "Temporary sign-in page. Your clicks and typing are sent here." : (s.shot && !s.overlay ? 'Open screenshot larger' : (s.shot ? 'Page waiting for sign-in' : 'No screenshot yet'));

    var thumb = s.shot ? '<img src="' + SHOTS[s.shot] + '" alt="">' : '';
    var chip = s.chip
      ? '<button class="bc-chip" type="button" aria-expanded="false" aria-label="Expand browser session: ' + s.chip[0] + '"><span class="bc-thumb">' + thumb + '</span><span class="main"><span class="l1">' + s.chip[0] + '</span><span class="l2">' + s.chip[1] + '</span></span>' + I.chev + '</button>'
      : '';

    var mode = s.mode
      ? '<div class="bc-mode"><span class="bc-mode-ico" aria-hidden="true">' + I[s.mode.ico] + '</span><span class="bc-mode-text"><strong>' + s.mode.title + '</strong><span>' + (s.ring ? s.mode.sub + ' · ' + rem + 's left' : s.mode.sub) + '</span></span>' + (s.ring ? ringHtml(rem) : '') + '</div>'
      : '';

    var privacy = s.privacy ? '<div class="bc-privacy">' + I.eyeoff + '<span>' + s.privacy + '</span></div>' : '';

    var actions = '';
    if (s.actions === 'request') {
      actions = '<div class="bc-actions"><button class="bc-btn primary" type="button" data-act="take">Take control</button><button class="bc-btn" type="button" data-act="notnow">Not now</button><span class="bc-agent">' + I.pause + 'Claude is waiting</span></div>';
    } else if (s.actions === 'control') {
      actions = '<div class="bc-actions"><span class="bc-agent">' + I.pause + 'Claude is waiting</span><button class="bc-btn primary big" type="button" data-act="return">Return control</button></div>';
    } else if (s.hint) {
      actions = '<div class="bc-actions"><span class="bc-hint">' + s.hint + '</span></div>';
    }

    var html =
      '<article class="bc ' + s.cls + (collapsed ? ' is-collapsed' : '') + (opts.stepsOpen ? ' steps-open' : '') + '" data-url="' + esc(s.url) + '" data-cap="' + esc(s.verb + ' ' + s.target) + '" aria-label="Browser session: ' + esc(s.label) + '">' +
        chip + mode +
        '<header class="bc-chrome">' +
          '<span class="bc-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<span class="bc-url" title="' + esc(s.url) + '">' + I.lock + '<span>' + host(s.url) + '<b>' + path + '</b></span></span>' +
          '<span class="bc-status"><i aria-hidden="true"></i>' + s.status + '</span>' +
        '</header>' +
        '<div class="bc-progress" aria-hidden="true"></div>' +
        '<button class="bc-view" type="button"' + (noOpen ? ' data-empty' : '') + ' aria-label="' + esc(viewLabel) + '">' + view + overlay + tag + cue + '<span class="bc-zoom" aria-hidden="true">' + I.zoom + '</span></button>' +
        '<div class="bc-side">' +
          privacy +
          '<div class="bc-caption">' +
            '<span class="grow"><span class="bc-verb">' + s.verb + '</span><span class="bc-target">' + s.target + '</span></span>' +
            '<button class="bc-toggle bc-collapse" type="button" data-act="collapse">Collapse</button>' +
            '<button class="bc-toggle" type="button" data-act="steps" aria-expanded="' + (opts.stepsOpen ? 'true' : 'false') + '" aria-controls="' + id + '-steps">' + s.steps.length + ' step' + (s.steps.length > 1 ? 's' : '') + I.chev + '</button>' +
          '</div>' +
          actions +
          '<ol class="bc-steps" id="' + id + '-steps" aria-label="Actions in this session">' + s.steps.map(stepRow).join('') + '</ol>' +
        '</div>' +
      '</article>';
    var node = el(html);
    node.dataset.key = key;
    return node;
  }

  function mount(target, key, opts) {
    var node = card(key, opts);
    target.replaceChildren(node);
    return node;
  }

  // ---- hero ----
  var heroMount = document.getElementById('hero-mount');
  var heroShell = document.getElementById('hero-shell');
  var heroInput = document.getElementById('hero-input');
  var heroAnswer = document.getElementById('hero-answer');
  var chipEl = document.getElementById('control-chip');
  var announcer = document.getElementById('announcer');
  var segA = document.getElementById('hero-seg');
  var segH = document.getElementById('hero-seg-h');
  var heroTimer = null;

  function clearTimer() { if (heroTimer) { clearInterval(heroTimer); clearTimeout(heroTimer); heroTimer = null; } }

  function setHero(key) {
    clearTimer();
    var node = mount(heroMount, key);
    var s = STATES[key];
    heroAnswer.hidden = !(key === 'done' || key === 'closed');
    var human = key === 'control';
    heroShell.classList.toggle('is-human', human);
    chipEl.classList.toggle('on', human);
    heroInput.placeholder = human ? 'Claude is waiting while you sign in…' : 'Reply to Claude…';
    announcer.textContent = s.say || '';
    [segA, segH].forEach(function (seg) {
      Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.key === key || (key === 'resumed' && b.dataset.key === 'returned'))); });
    });
    if (key === 'request') {
      var rem = TTL;
      setRing(node, rem);
      heroTimer = setInterval(function () {
        rem -= 1;
        var n = heroMount.querySelector('.bc');
        if (n) setRing(n, rem);
        if (rem <= 0) setHero('expired');
      }, 1000);
    } else if (key === 'returned') {
      heroTimer = setTimeout(function () { setHero('resumed'); }, 3500);
    }
  }

  function seg(container, group) {
    Object.keys(STATES).forEach(function (k) {
      var s = STATES[k];
      if (s.hidden || s.group !== group) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.label;
      b.dataset.key = k;
      b.addEventListener('click', function () { setHero(k); });
      container.appendChild(b);
    });
  }
  seg(segA, 'a');
  seg(segH, 'h');
  setHero('control');

  // ---- state sheet ----
  var sheet = document.getElementById('sheet');
  [
    ['navigating', 'Navigating', 'progress bar + skeleton', {}],
    ['live', 'Actively acting', 'scan shimmer + status dot', {}],
    ['done', 'Finished · collapsed', 'default', {}],
    ['done', 'Finished · expanded', 'on click', { collapsed: false, stepsOpen: true }],
    ['error', 'Error / timeout', 'stays expanded', { stepsOpen: true }],
    ['closed', 'Session ended', 'muted, collapsed', {}],
    ['request', 'Handoff · requested', '30s to respond', { remaining: 24 }],
    ['control', "Handoff · you're in control", 'strongest mode', { stepsOpen: true }],
    ['returned', 'Handoff · returned', 'folds back to teal', {}],
    ['expired', 'Handoff · expired', 'muted, dashed', {}]
  ].forEach(function (c) {
    var cell = document.createElement('div');
    cell.className = 'sheet-cell';
    cell.innerHTML = '<h3>' + c[1] + '<em>' + c[2] + '</em></h3><div class="bc-host"></div>';
    sheet.appendChild(cell);
    mount(cell.lastChild, c[0], c[3]);
  });

  // ---- mode comparison ----
  mount(document.getElementById('modes-d-a'), 'live');
  mount(document.getElementById('modes-d-h'), 'control');
  mount(document.getElementById('modes-l-a'), 'live');
  mount(document.getElementById('modes-l-h'), 'control');

  // ---- layouts ----
  mount(document.getElementById('narrow-mount'), 'live');
  mount(document.getElementById('wide-mount'), 'live');
  mount(document.getElementById('wide-mount-h'), 'control');

  // ---- light theme ----
  var lightRow = document.getElementById('light-row');
  [['live', {}], ['request', {}], ['done', { collapsed: false }], ['error', {}]].forEach(function (c) {
    var w = document.createElement('div');
    w.className = 'bc-host';
    lightRow.appendChild(w);
    mount(w, c[0], c[1]);
  });

  // ---- interactions (delegated) ----
  var dlg = document.getElementById('lightbox');
  var lbImg = document.getElementById('lb-img');
  var lbUrl = document.getElementById('lb-url');
  var lbCap = document.getElementById('lb-cap');
  var lastFocus = null;

  function go(bc, key) {
    var hostEl = bc.parentNode;
    if (hostEl === heroMount) { setHero(key); return; }
    mount(hostEl, key);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var chip = t.closest('.bc-chip');
    if (chip) { chip.closest('.bc').classList.remove('is-collapsed'); return; }

    var ret = t.closest('[data-act="return-chip"]');
    if (ret) { setHero('returned'); return; }

    var act = t.closest('[data-act]');
    if (act) {
      var bc = act.closest('.bc');
      var a = act.dataset.act;
      if (a === 'collapse') {
        bc.classList.add('is-collapsed');
        bc.classList.remove('steps-open');
        var ch = bc.querySelector('.bc-chip');
        if (ch) ch.focus();
      } else if (a === 'steps') {
        var open = bc.classList.toggle('steps-open');
        act.setAttribute('aria-expanded', String(open));
      } else if (a === 'take') { go(bc, 'control'); focusMain(bc); }
      else if (a === 'return') { go(bc, 'returned'); }
      else if (a === 'notnow') { go(bc, 'live'); }
      return;
    }
    var view = t.closest('.bc-view');
    if (view && !view.hasAttribute('data-empty')) {
      var card = view.closest('.bc');
      lastFocus = view;
      lbImg.src = view.querySelector('img').getAttribute('src');
      lbUrl.textContent = card.dataset.url;
      lbCap.textContent = card.dataset.cap;
      dlg.showModal();
    }
  });

  // after "Take control" the new card replaces the old one; keep keyboard focus on the mode's primary action
  function focusMain() {
    requestAnimationFrame(function () {
      var b = heroMount.querySelector('[data-act="return"]');
      if (b && document.activeElement === document.body) b.focus();
    });
  }

  document.getElementById('lb-close').addEventListener('click', function () { dlg.close(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { if (lastFocus) lastFocus.focus(); });
})();
