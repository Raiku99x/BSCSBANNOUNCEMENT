// ============================================================
//  featured-patch.js — Ping-Pong Carousel (Fixed Mobile)
//  Overrides renderFeatured cleanly — no dividers in strip
//  ✅ FIXED: Excludes cancelled tasks from active count
// ============================================================

(function () {
  let autoTimer   = null;
  let resumeTimer = null;
  let currentIdx  = 0;
  let direction   = 1;
  let isPaused    = false;
  let scrollTimeout = null;
  const SPEED     = 800;

  // ── HELPERS ─────────────────────────────────────────────────
  function getCards() {
    return Array.from(document.querySelectorAll('#featuredList .featured-card'));
  }
  function getStrip() { return document.getElementById('featuredList'); }

  // ── SCROLL TO IDX ────────────────────────────────────────────
  function goTo(idx) {
    const strip = getStrip();
    const cards = getCards();
    if (!strip || !cards.length) return;
    
    cards.forEach(card => card.classList.remove('fc-active'));
    
    currentIdx = ((idx % cards.length) + cards.length) % cards.length;
    const gap   = 10;
    const cardW = cards[0].offsetWidth + gap;
    strip.scrollTo({ left: currentIdx * cardW, behavior: 'smooth' });
    
    // Add active class to current card
    if (cards[currentIdx]) {
      cards[currentIdx].classList.add('fc-active');
    }
    
    updateDots(currentIdx, cards.length);
  }

  // ── PING-PONG TICK ───────────────────────────────────────────
  function tick() {
    if (isPaused) return;
    const total = getCards().length;
    if (total <= 1) return;
    let next = currentIdx + direction;
    if (next >= total)  { direction = -1; next = total - 2; }
    else if (next < 0)  { direction =  1; next = 1; }
    goTo(next);
  }

  // ── DOTS ────────────────────────────────────────────────────
  function updateDots(idx, total) {
    document.querySelectorAll('.fc-dot').forEach(function(d, i) {
      d.classList.toggle('active', i === idx);
    });
  }
  function buildDots(total) {
    let dotsEl = document.getElementById('fcDotsEl');
    if (!dotsEl) {
      dotsEl = document.createElement('div');
      dotsEl.id = 'fcDotsEl';
      const fl = getStrip();
      if (fl && fl.parentNode) fl.parentNode.insertBefore(dotsEl, fl.nextSibling);
    }
    if (total <= 1) { dotsEl.innerHTML = ''; return; }
    dotsEl.innerHTML = '<div class="fc-dots">' +
      Array.from({ length: total }, function(_, i) {
        return '<span class="fc-dot' + (i === 0 ? ' active' : '') +
               '" data-idx="' + i + '"></span>';
      }).join('') + '</div>';
    dotsEl.querySelectorAll('.fc-dot').forEach(function(dot) {
      dot.addEventListener('click', function() { goTo(+dot.dataset.idx); pause(); });
    });
  }

  // ── PAUSE / RESUME ───────────────────────────────────────────
  function pause() {
    isPaused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(function() { isPaused = false; }, 5000);
  }

  // ── START / STOP ─────────────────────────────────────────────
  function startCarousel() {
    stopCarousel();
    if (getCards().length <= 1) return;
    currentIdx = 0; direction = 1;
    autoTimer  = setInterval(tick, SPEED);
  }
  function stopCarousel() { clearInterval(autoTimer); autoTimer = null; }

  // ── EVENTS ───────────────────────────────────────────────────
  function attachEvents() {
    const strip = getStrip();
    if (!strip || strip._fcAttached) return;
    strip._fcAttached = true;
    
    strip.addEventListener('touchstart', pause, { passive: true });
    strip.addEventListener('touchend',   pause, { passive: true });
    strip.addEventListener('mouseenter', pause);
    
    strip.addEventListener('scroll', function() {
      clearTimeout(scrollTimeout);
      
      scrollTimeout = setTimeout(function() {
        const cards = getCards();
        if (!cards.length) return;
        
        const newIdx = Math.round(strip.scrollLeft / (cards[0].offsetWidth + 10));
        
        if (newIdx !== currentIdx) {
          cards.forEach(card => card.classList.remove('fc-active'));
          currentIdx = newIdx;
          if (cards[currentIdx]) {
            cards[currentIdx].classList.add('fc-active');
          }
          updateDots(currentIdx, cards.length);
        }
        
        pause();
      }, 150); 
      
    }, { passive: true });
  }

  // ── OVERRIDE renderFeatured ──────────────────────────────────
  function installOverride() {
    if (typeof pruneExpiredNotes === 'undefined' ||
        typeof tasks === 'undefined'             ||
        typeof CAT_LABELS === 'undefined') {
      setTimeout(installOverride, 100);
      return;
    }

    window.renderFeatured = function () {
      pruneExpiredNotes();

      // ── Notes (unchanged logic) ─────────────────────────────
      var notesEl = document.getElementById('notesList');
      if (notes.length) {
        var nh = '<div class="feat-section-divider">' +
          '<div class="feat-section-divider-line"></div>' +
          '<span class="feat-section-divider-label">📌 Notes (' + notes.length + ')</span>' +
          '<div class="feat-section-divider-line"></div></div>';
        nh += [].slice.call(notes).reverse().map(function(n) {
          var canDel = currentRole === 'admin' && currentAdminName === n.author;
          var delBtn = canDel
            ? '<button class="note-del-btn" onclick="deleteNote(\'' + n.id + '\')" title="Delete note">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
              '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
              '<path d="M10 11v6"/><path d="M14 11v6"/>' +
              '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>'
            : '';
          return '<div class="note-card"><div class="note-card-top">' +
            '<div class="note-card-text">' + esc(n.text) + '</div>' + delBtn +
            '</div><div class="note-card-meta">' +
            '<span class="note-author ' + getAdminChipClass(n.author) + '">' +
            getAdminIcon(n.author, 9) + esc(getAdminTitle(n.author)) + '</span>' +
            '</div></div>';
        }).join('');
        notesEl.innerHTML = nh;
      } else {
        notesEl.innerHTML = '';
      }

      // ── Featured cards ──────────────────────────────────────
      var el = document.getElementById('featuredList');
      var feat = tasks.filter(function(t) {
        if (t.cancelled) return false; // ✅ FIXED: Exclude cancelled tasks
        if (t.done) return false;
        var s = _getStatus(t);
        return s.over || s.today || s.soon;
      }).sort(function(a, b) {
        var da = a.date ? new Date(a.date + 'T' + (a.time || '23:59')) : new Date('9999');
        var db = b.date ? new Date(b.date + 'T' + (b.time || '23:59')) : new Date('9999');
        return da - db;
      });

      // Featured badge
      var featBadge = document.getElementById('featCount');
      if (featBadge) {
        // ✅ FIXED: Exclude cancelled tasks from active count
        var totalActive = tasks.filter(function(t) { 
          return !t.cancelled && !t.done && !_getStatus(t).over; 
        }).length;
        var totalFeat   = feat.length + notes.length;
        if (totalFeat > 0) {
          featBadge.textContent = feat.length > 0 && totalActive > 0
            ? feat.length + ' of ' + totalActive
            : notes.length > 0 ? notes.length : feat.length;
          featBadge.style.display = '';
        } else {
          featBadge.style.display = 'none';
        }
      }

      // Empty
      if (!feat.length && !notes.length) {
        el.innerHTML = '<div class="no-featured">' +
          '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3">' +
          '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' +
      '</svg><p>No urgent tasks here — but scroll down, there may still be active tasks without a close due date.</p></div>';        var d = document.getElementById('fcDotsEl');
        if (d) d.innerHTML = '';
        stopCarousel();
        return;
      }

      if (!feat.length) {
        el.innerHTML = '';
        var d2 = document.getElementById('fcDotsEl');
        if (d2) d2.innerHTML = '';
        stopCarousel();
        return;
      }

      // Build carousel cards — NO section dividers inside strip
      var slice = feat.slice(0, 8);
      el.innerHTML = slice.map(function(t, i) {
        var s    = _getStatus(t);
        var due  = fmtDue(t.date, t.time);
        var cls  = s.over ? 'fc-overdue' : s.today ? 'fc-today' : 'fc-soon';
        var icon = s.over ? '⚠️ Overdue'  : s.today ? '🔥 Today'  : '⏳ Soon';
        return '<div class="featured-card ' + cls + '" onclick="expandCard(\'' + t.id + '\')" ' +
               'style="animation-delay:' + (i * 55) + 'ms">' +
          '<div class="fc-status-pill">' + icon + '</div>' +
          '<div class="fc-card-name">' + esc(t.name) + '</div>' +
          '<span class="badge cat-' + t.category + '">' + (CAT_LABELS[t.category] || t.category) + '</span>' +
          (due ? '<div class="fc-card-meta">' +
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="4" width="18" height="18" rx="2"/>' +
            '<line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>' +
            '<line x1="3" y1="10" x2="21" y2="10"/></svg>' +
            '<span>' + esc(due) + '</span></div>' : '') +
          '</div>';
      }).join('');

      // Reset scroll position
      el.scrollLeft = 0;
      currentIdx = 0;
      direction  = 1;

      // Attach events & start
      el._fcAttached = false;
      attachEvents();
      buildDots(slice.length);
      stopCarousel();
      clearTimeout(window._fcStartDelay);
      window._fcStartDelay = setTimeout(startCarousel, 400);
    };

    console.log('[featured-patch] renderFeatured override installed ✓ (cancelled tasks excluded)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installOverride);
  } else {
    installOverride();
  }
})();
