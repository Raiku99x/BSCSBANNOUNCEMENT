// ============================================================
//  unsubscribe-challenge.js
//  Secure unsubscribe challenge — code displayed as plain text
//  using visually confusing lookalike characters (I l 1 | ! O 0)
//  Load AFTER notifications.js
// ============================================================

(function () {

  // ── State (closure only) ──────────────────────────────────
  let _expectedCode = null;
  let _isLoading    = false;

  // ── Confusing lookalike codes ─────────────────────────────
  // Characters used: I l 1 | ! O 0 — all look nearly identical
  const CONFUSING_CODES = [
    'Il1|!O0lI|1!Il0O',
    '1lI|O!0IlI|1!l0O',
    'I|1!lO0Il|1I!0lO',
    '0OIl|1!lI|O0!Il1',
    'l1I|!0OIl1|!I0Ol',
    'Il!|10OIl|!1I0lO',
    '|I1lO!0l|I1!Ol0I',
    '1|Il!O0lI|1!0OlI',
    'O0Il|1!IlO|0!1Il',
    'lI|0O!1Il|!0OI1l',
    'I1|lO!0Il1|I!O0l',
    '0l|I1!OIl0|1!lIO',
    'Il0|!1OlI|0!I1lO',
    '1IO|l!0IlO|1!I0l',
    'l|I0!1OlI|!0l1IO',
    '0I|1lO!Il|0I!1lO',
    'Il1O|!0lI1|!IO0l',
    'I0l|1!OIl|0!1IOl',
    '1lO|I!0lI|1O!I0l',
    'O|Il1!0lI|O!1Il0',
    'l1|IO!0Il|1!O0lI',
    'I|0lO!1Il|0!IO1l',
    '0Il|1O!lI|0!1lIO',
  ];

  // ── Render code as plain styled text ─────────────────────
  function renderCodeAsText(code) {
    const codeEl = document.getElementById('unsubCodeText');
    if (!codeEl) return;
    codeEl.textContent = code;
  }

  // ── Load a code ───────────────────────────────────────────
  // Tries Supabase first, falls back to local confusing codes
  window.loadUnsubChallenge = async function () {
    if (_isLoading) return;
    _isLoading = true;

    _expectedCode = null;

    const codeEl = document.getElementById('unsubCodeText');
    if (codeEl) codeEl.textContent = 'Loading…';

    try {
      const { data, error } = await _sb
        .from('unsubscribe_codes')
        .select('id, code');

      if (error || !data || !data.length) throw new Error('No codes');

      const pick    = data[Math.floor(Math.random() * data.length)];
      _expectedCode = pick.code;

      renderCodeAsText(pick.code);
      resetInput();
    } catch (err) {
      // Fallback to local confusing codes
      const pick = CONFUSING_CODES[Math.floor(Math.random() * CONFUSING_CODES.length)];
      _expectedCode = pick;
      renderCodeAsText(pick);
      resetInput();
    }

    _isLoading = false;
  };

  function resetInput() {
    const input    = document.getElementById('unsubInput');
    const hint     = document.getElementById('unsubHint');
    const confirm  = document.getElementById('unsubConfirmBtn');
    const progress = document.getElementById('unsubProgressBar');
    if (input)    { input.value = ''; input.className = 'unsub-input'; }
    if (hint)     { hint.textContent = ''; hint.className = 'unsub-input-hint'; }
    if (confirm)  confirm.disabled = true;
    if (progress) { progress.style.width = '0%'; progress.className = 'unsub-progress-bar'; }
  }

  // ── Input handler ─────────────────────────────────────────
  function handleInput(e) {
    if (!_expectedCode) return;

    const typed    = e.target.value;
    const expected = _expectedCode;
    const progress = document.getElementById('unsubProgressBar');
    const hint     = document.getElementById('unsubHint');
    const confirm  = document.getElementById('unsubConfirmBtn');

    let matchLen = 0;
    for (let i = 0; i < typed.length; i++) {
      if (typed[i] === expected[i]) matchLen++;
      else break;
    }
    const pct = Math.round((matchLen / expected.length) * 100);

    if (progress) {
      progress.style.width = pct + '%';
      progress.className   = 'unsub-progress-bar' +
        (pct === 100 ? ' done' : pct > 0 ? ' partial' : '');
    }

    if (typed === expected) {
      e.target.className = 'unsub-input valid';
      if (hint)    { hint.textContent = '✓ Code matches'; hint.className = 'unsub-input-hint valid'; }
      if (confirm) confirm.disabled = false;
    } else if (typed.length > 0 && expected.startsWith(typed)) {
      e.target.className = 'unsub-input partial';
      if (hint)    { hint.textContent = `${typed.length} / ${expected.length} chars…`; hint.className = 'unsub-input-hint partial'; }
      if (confirm) confirm.disabled = true;
    } else if (typed.length > 0) {
      e.target.className = 'unsub-input error';
      if (hint)    { hint.textContent = 'Mismatch — look carefully, they look alike!'; hint.className = 'unsub-input-hint error'; }
      if (confirm) confirm.disabled = true;
    } else {
      e.target.className = 'unsub-input';
      if (hint)    { hint.textContent = ''; hint.className = 'unsub-input-hint'; }
      if (confirm) confirm.disabled = true;
    }
  }

  // ── Block paste / context-menu / drag ─────────────────────
  function blockInput(e) {
    e.preventDefault();
    e.stopPropagation();

    const hint = document.getElementById('unsubHint');
    if (hint) {
      hint.textContent  = '⚠ Copy-paste is disabled. Type it manually.';
      hint.className    = 'unsub-input-hint warn';
      clearTimeout(hint._t);
      hint._t = setTimeout(() => {
        if (hint.className.includes('warn')) {
          hint.textContent = '';
          hint.className   = 'unsub-input-hint';
        }
      }, 2000);
    }
    return false;
  }

  // ── Open modal ────────────────────────────────────────────
  window.openUnsubChallenge = function () {
    lockScroll();
    document.getElementById('unsubOverlay').classList.add('open');

    const input = document.getElementById('unsubInput');
    if (input && !input._challengeWired) {
      input._challengeWired = true;
      input.addEventListener('input',       handleInput);
      input.addEventListener('paste',       blockInput);
      input.addEventListener('copy',        blockInput);
      input.addEventListener('cut',         blockInput);
      input.addEventListener('contextmenu', blockInput);
      input.addEventListener('drop',        blockInput);
      input.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
          blockInput(e);
        }
      });
    }

    loadUnsubChallenge();
    setTimeout(() => {
      const input = document.getElementById('unsubInput');
      if (input) input.focus();
    }, 400);
  };

  // ── Close modal ───────────────────────────────────────────
  window.closeUnsubChallenge = function () {
    document.getElementById('unsubOverlay').classList.remove('open');
    _expectedCode = null;
    unlockScroll();
    resetInput();
  };

  // ── Handle overlay backdrop click ─────────────────────────
  window.handleUnsubOverlay = function (e) {
    if (e.target === document.getElementById('unsubOverlay')) {
      closeUnsubChallenge();
    }
  };

  // ── Confirm unsubscribe ───────────────────────────────────
  window.confirmUnsubscribe = async function () {
    const input = document.getElementById('unsubInput');
    if (!input || !_expectedCode) return;

    if (input.value !== _expectedCode) {
      const hint = document.getElementById('unsubHint');
      if (hint) {
        hint.textContent = '✗ Code does not match. Try again.';
        hint.className   = 'unsub-input-hint error';
      }
      return;
    }

    _expectedCode = null;

    closeUnsubChallenge();

    await unsubscribeFromPush();
    showNotifToast('🔕 Notifications disabled.', 'info');
    updateBellUI();
  };

})();
