// ============================================================
//  BSCS1B TaskHub — app.js
//  Supabase backend + realtime sync
//  ✅ Done state is LOCAL (per-device) — each user tracks their own
// ============================================================

// ─── SUPABASE CONFIG ────────────────────────────────────────
const SUPABASE_URL = 'https://znoveznysqwmolhftxfy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpub3Zlem55c3F3bW9saGZ0eGZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MjM3MjQsImV4cCI6MjA4NzE5OTcyNH0.1jlJuRk-7vAVtEZFDvwdV2ZH3UkqUYwlyK-w2PSbl-A'; 

const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── CONSTANTS ──────────────────────────────────────────────
const CAT_LABELS = {
  quiz:'Quiz', project:'Project', assignment:'Assignment', exam:'Exam',
  study:'Study', review:'Review', output:'Output', online:'Online Class',
  other:'Other', info:'Info', fees:'Fees', suspension:'Suspension',
  noclasses:'No Classes', event:'Event', fillup:'Fill Up', learning:'Learning Task'
};

let ADMINS = [];
let ADMIN_TITLES = {};

async function loadAdmins() {
  try {
    const { data, error } = await _sb.from('admins').select('*');
    if (error) throw error;
    
    ADMINS = data.map(admin => ({
      username: admin.username,
      password: admin.password
    }));
    
    ADMIN_TITLES = {};
    data.forEach(admin => {
      ADMIN_TITLES[admin.username] = admin.display_name || admin.username;
    });
    
    console.log('[Admins] Loaded from Supabase:', ADMINS.length);
  } catch (err) {
    console.error('[Admins] Failed to load from Supabase:', err);
    // No fallback - admins must be loaded from database
    ADMINS = [];
    ADMIN_TITLES = {};
    setSyncStatus('error', 'Admin load failed');
  }
}

// ─── FILTER CONFIG ───────────────────────────────────────────
// Labels and badge colors for the dynamic "All Tasks" header
const FILTER_META = {
  all:       { label: 'All Tasks',        badgeBg: 'var(--accent)',  badgeColor: '#fff' },
  active:    { label: 'Active Tasks',     badgeBg: '#0ea5e9',        badgeColor: '#fff' },
  soon:      { label: 'Soon Tasks',       badgeBg: 'var(--amber)',   badgeColor: '#fff' },
  today:     { label: 'Today Tasks',      badgeBg: '#ea6b0e',        badgeColor: '#fff' },
  overdue:   { label: 'Overdue Tasks',    badgeBg: 'var(--red)',     badgeColor: '#fff' },
  done:      { label: 'Done Tasks',       badgeBg: 'var(--green)',   badgeColor: '#0f1a12' },
  cancelled: { label: 'Cancelled Tasks',  badgeBg: '#6b7280',        badgeColor: '#fff' }, 
};


// ─── STATE ──────────────────────────────────────────────────
let tasks = [], notes = [], editId = null, uploadTargetId = null;
let activeFilter = 'active', currentRole = 'user', currentAdminName = null, isDark = false;
let _statusCache = null;
let _filterBtns = null;
let _searchTimer = null;
let pendingDeleteId = null;
let _lbTaskId = null, _lbIdx = 0;
let _realtimeChannel = null;
let _isLoading = true;

// ─── LOCAL DONE STATE ────────────────────────────────────────
// Done state is stored per-device in localStorage.
// Each user/device independently tracks what they've completed.
const LOCAL_DONE_KEY = 'taskhub-done-v1';

function getLocalDone() {
  try {
    const s = localStorage.getItem(LOCAL_DONE_KEY);
    return s ? JSON.parse(s) : {};
  } catch(e) { return {}; }
}

function setLocalDone(id, isDoneVal) {
  const done = getLocalDone();
  if (isDoneVal) {
    done[id] = true;
  } else {
    delete done[id];
  }
  try { localStorage.setItem(LOCAL_DONE_KEY, JSON.stringify(done)); } catch(e) {}

  // Sync done IDs to Supabase so push notifications skip completed tasks
  _syncDoneToSupabase();
}

async function _syncDoneToSupabase() {
  // Only sync if user has an active push subscription
  if (!_pushSubscription) return;
  const doneIds = Object.keys(getLocalDone());
  // Also include cancelled task IDs so the server skips them in reminders
  const cancelledIds = tasks.filter(t => t.cancelled).map(t => t.id);
  const excludeIds = [...new Set([...doneIds, ...cancelledIds])];
  try {
    await _sb.from('push_subscriptions')
      .update({ done_task_ids: excludeIds })
      .eq('endpoint', _pushSubscription.endpoint);
  } catch(e) {
    console.warn('[Done sync] Could not sync done state:', e);
  }
}

function applyLocalDone(taskList) {
  const done = getLocalDone();
  taskList.forEach(t => { t.done = !!done[t.id]; });
  return taskList;
}

// ─── SYNC INDICATOR ─────────────────────────────────────────
function setSyncStatus(status, label) {
  const el = document.getElementById('syncIndicator');
  const lb = document.getElementById('syncLabel');
  if (!el || !lb) return;
  el.className = 'sync-indicator ' + status;
  lb.textContent = label;
}

// ─── SUPABASE: LOAD DATA ─────────────────────────────────────
async function loadFromSupabase() {
  setSyncStatus('syncing', 'Loading…');
  try {
    const [{ data: taskData, error: tErr }, { data: noteData, error: nErr }] =
      await Promise.all([
        _sb.from('tasks').select('*').order('created_at', { ascending: true }),
        _sb.from('notes').select('*').order('created_at', { ascending: true }),
      ]);

    if (tErr) throw tErr;
    if (nErr) throw nErr;

    tasks = applyLocalDone((taskData || []).map(dbToTask));
    notes = (noteData || []).map(dbToNote);
    pruneExpiredNotes();
    _isLoading = false;
    setSyncStatus('connected', 'Live');
    renderAll();
    subscribeRealtime();
  } catch (err) {
    console.error('Supabase load error:', err);
    setSyncStatus('error', 'Offline');
    _isLoading = false;
    // Fallback to localStorage
    loadFromLocalStorage();
    renderAll();
  }
}

// ─── SUPABASE: REALTIME ──────────────────────────────────────
function subscribeRealtime() {
  if (_realtimeChannel) _sb.removeChannel(_realtimeChannel);

  _realtimeChannel = _sb
    .channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, handleTaskChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes' }, handleNoteChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setSyncStatus('connected', 'Live');
      if (status === 'CLOSED' || status === 'CHANNEL_ERROR') setSyncStatus('error', 'Reconnecting…');
    });
}

function handleTaskChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') {
    if (!tasks.find(t => t.id === newRow.id)) {
      const t = dbToTask(newRow);
      // Preserve local done state for newly synced tasks
      t.done = !!getLocalDone()[t.id];
      tasks.push(t);
    }
  } else if (eventType === 'UPDATE') {
    const idx = tasks.findIndex(t => t.id === newRow.id);
    if (idx !== -1) {
      const expanded = tasks[idx]._expanded;
      const localDone = tasks[idx].done; // preserve local done state
      tasks[idx] = { ...dbToTask(newRow), _expanded: expanded, done: localDone };
    }
  } else if (eventType === 'DELETE') {
    tasks = tasks.filter(t => t.id !== oldRow.id);
  }
  _invalidateCache();
  updateCounts();
  renderFeatured();
  renderTasks();
}

function handleNoteChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') {
    if (!notes.find(n => n.id === newRow.id)) {
      notes.push(dbToNote(newRow));
    }
  } else if (eventType === 'DELETE') {
    notes = notes.filter(n => n.id !== oldRow.id);
  }
  pruneExpiredNotes();
  renderFeatured();
}

// ─── DB ↔ APP MAPPERS ────────────────────────────────────────
function dbToTask(row) {
  return {
    id:         row.id,
    name:       row.name,
    category:   row.category,
    date:       row.date || '',
    time:       row.time || '',
    notes:      row.notes || '',
    done:       false,
    cancelled:  row.cancelled || false, 
    images:     Array.isArray(row.images) ? row.images : [],
    createdBy:  row.created_by || null,
    created:    row.created_at || Date.now(),
    _expanded:  false,
  };
}

function taskToDb(t) {
  return {
    id:         t.id,
    name:       t.name,
    category:   t.category,
    date:       t.date || null,
    time:       t.time || null,
    notes:      t.notes || null,
    cancelled:  t.cancelled || false, 
    images:     t.images || [],
    created_by: t.createdBy || null,
    created_at: t.created || Date.now(),
  };
}

function dbToNote(row) {
  return {
    id:        row.id,
    text:      row.text,
    author:    row.author,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// ─── LOCAL STORAGE FALLBACK ──────────────────────────────────
const LS_KEY = 'taskhub-v4';
const LS_NOTES_KEY = 'taskhub-notes-v1';

function loadFromLocalStorage() {
  try { const s = localStorage.getItem(LS_KEY); if (s) tasks = JSON.parse(s); } catch(e) { tasks = []; }
  try { const n = localStorage.getItem(LS_NOTES_KEY); if (n) notes = JSON.parse(n); } catch(e) { notes = []; }
  // Still apply local done state even in offline mode
  applyLocalDone(tasks);
}

function persistToLocalStorage() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); } catch(e) {}
  try { localStorage.setItem(LS_NOTES_KEY, JSON.stringify(notes)); } catch(e) {}
}

// ─── PERSIST (Supabase + localStorage backup) ────────────────
async function persistTask(task, isNew = false) {
  setSyncStatus('syncing', 'Saving…');
  try {
    if (isNew) {
      const { error } = await _sb.from('tasks').insert(taskToDb(task));
      if (error) throw error;
    } else {
      const { error } = await _sb.from('tasks').update(taskToDb(task)).eq('id', task.id);
      if (error) throw error;
    }
    setSyncStatus('connected', 'Live');
  } catch (err) {
    console.error('Save task error:', err);
    setSyncStatus('error', 'Sync failed');
    persistToLocalStorage();
  }
}

async function deleteTaskFromDb(id) {
  // Also clean up local done state when a task is deleted
  setLocalDone(id, false);
  setSyncStatus('syncing', 'Deleting…');
  try {
    const { error } = await _sb.from('tasks').delete().eq('id', id);
    if (error) throw error;
    setSyncStatus('connected', 'Live');
  } catch (err) {
    console.error('Delete task error:', err);
    setSyncStatus('error', 'Sync failed');
    tasks = tasks.filter(t => t.id !== id);
    persistToLocalStorage();
    renderAll();
  }
}

async function persistNote(note) {
  setSyncStatus('syncing', 'Saving…');
  try {
    const { error } = await _sb.from('notes').insert({
      id:         note.id,
      text:       note.text,
      author:     note.author,
      created_at: note.createdAt,
      expires_at: note.expiresAt,
    });
    if (error) throw error;
    setSyncStatus('connected', 'Live');
  } catch (err) {
    console.error('Save note error:', err);
    setSyncStatus('error', 'Sync failed');
    persistToLocalStorage();
  }
}

async function deleteNoteFromDb(id) {
  try {
    const { error } = await _sb.from('notes').delete().eq('id', id);
    if (error) throw error;
  } catch (err) {
    console.error('Delete note error:', err);
    notes = notes.filter(n => n.id !== id);
    persistToLocalStorage();
    renderFeatured();
  }
}

// ─── STATUS CACHE ────────────────────────────────────────────
function _invalidateCache() { _statusCache = null; }
function _getStatus(t) {
  if (!_statusCache) _buildCache();
  return _statusCache.get(t.id) || { over:false, today:false, soon:false };
}
function _buildCache() {
  _statusCache = new Map();
  const now = new Date();
  const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
  const nowMs = now.getTime();
  const nowDay = new Date(todayY, todayM, todayD).getTime();
  tasks.forEach(t => {
    if (t.cancelled) { _statusCache.set(t.id, { over:false, today:false, soon:false }); return; }
    if (!t.date) { _statusCache.set(t.id, { over:false, today:false, soon:false }); return; }
    const dueMs = new Date(t.date + 'T' + (t.time || '23:59')).getTime();
    const over = !t.done && dueMs < nowMs;
    const due0 = new Date(t.date + 'T00:00');
    const sameDay = !t.done && !over && due0.getFullYear() === todayY && due0.getMonth() === todayM && due0.getDate() === todayD;
    let soon = false;
    if (!t.done && !over && !sameDay) {
      const dueDay = new Date(due0.getFullYear(), due0.getMonth(), due0.getDate()).getTime();
      const diff = Math.round((dueDay - nowDay) / 86400000);
      soon = diff >= 1 && diff <= 3;
    }
    _statusCache.set(t.id, { over, today:sameDay, soon });
  });
}

// ─── HELPERS ─────────────────────────────────────────────────
function _getFilterBtns() {
  if (!_filterBtns) _filterBtns = document.querySelectorAll('.filter-btn');
  return _filterBtns;
}
function getAdminTitle(name) { return ADMIN_TITLES[name] || name; }
function getAdminChipClass(name) { return name ? 'chip-' + name.toLowerCase() : ''; }

function getAdminIcon(name, size = 10) {
  if (name === 'Kandiaru') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon points="3,6 5.5,1 8,6 5.5,9" fill="currentColor"/>
      <line x1="2" y1="2" x2="9" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <polygon points="16,6 18.5,1 21,6 18.5,9" fill="currentColor"/>
      <line x1="15" y1="2" x2="22" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M 0,13 Q 5,9 12,9 Q 19,9 24,13 Q 22,30 12,30 Q 2,30 0,13 Z" fill="currentColor" opacity="0.13"/>
      <path d="M 0,13 Q 5,9 12,9 Q 19,9 24,13" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M 0,13 Q 2,30 12,30 Q 22,30 24,13" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <polyline points="1,13 3,20 5,13 7,21 9,13 11,22.5 13,13 15,21 17,13 19,20 21,13 23,13"
        stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="miter" stroke-linecap="square"/>
    </svg>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M20 21a8 8 0 1 0-16 0"/></svg>`;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function isOverdue(t) { return _getStatus(t).over; }
function isToday(t) { return _getStatus(t).today; }
function isDueSoon(t) { return _getStatus(t).soon; }

function fmtDue(date, time) {
  if (!date) return null;
  const lbl = new Date(date + 'T00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });
  if (!time) return lbl;
  const [h, m] = time.split(':'); const hr = +h;
  return `${lbl} ${(hr % 12) || 12}:${m}${hr >= 12 ? 'pm' : 'am'}`;
}

function pruneExpiredNotes() {
  const now = Date.now();
  notes = notes.filter(n => n.expiresAt > now);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// ─── ROLE / AUTH ─────────────────────────────────────────────
function clickAdminBtn() { if (currentRole !== 'admin') openLoginModal(); }
function userBtnClick() { if (currentRole === 'admin') openLogoutModal(); }

function openLogoutModal() {
  lockScroll();
  document.getElementById('logoutOverlay').classList.add('open');
}
function closeLogoutModal() {
  document.getElementById('logoutOverlay').classList.remove('open');
  unlockScroll();
}
function confirmLogout() {
  closeLogoutModal();
  currentRole = 'user';
  currentAdminName = null;
  updateRoleUI();
  renderAll();
}

function updateRoleUI() {
  const isAdmin = currentRole === 'admin';
  const adminBtn = document.getElementById('adminBtn');
  if (isAdmin) {
    const title = getAdminTitle(currentAdminName);
    const icon = getAdminIcon(currentAdminName, 11);
    adminBtn.innerHTML = `${icon}<span style="margin-left:4px;">${currentAdminName}</span>`;
    adminBtn.className = `role-btn admin-active admin-${currentAdminName.toLowerCase()}`;
    adminBtn.style.opacity = '1';
  } else {
    adminBtn.innerHTML = 'Admin';
    adminBtn.className = 'role-btn admin';
    adminBtn.style.opacity = '0.4';
  }
  const userBtn = document.getElementById('userBtn');
  if (isAdmin) {
    userBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
    userBtn.className = 'role-btn logout';
  } else {
    userBtn.textContent = 'User';
    userBtn.className = 'role-btn user';
    userBtn.style.opacity = '1';
  }
  document.getElementById('addBtn').style.display = isAdmin ? 'block' : 'none';
  // document.getElementById('addNoteBtn').classList.toggle('visible', isAdmin);
}

// ─── SCROLL LOCK ─────────────────────────────────────────────
function lockScroll() { document.body.classList.add('modal-open'); }
function unlockScroll() {
  const anyOpen = ['overlay','noteOverlay','loginOverlay','delOverlay','lightbox','logoutOverlay','photoDelOverlay','cancelOverlay','helpOverlay']
    .some(id => { const el = document.getElementById(id); return el && el.classList.contains('open'); });
  if (!anyOpen) document.body.classList.remove('modal-open');
}

// ─── LOGIN ───────────────────────────────────────────────────
function openLoginModal() {
  lockScroll();
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').classList.remove('show');
  document.getElementById('loginOverlay').classList.add('open');
  setTimeout(() => document.getElementById('loginUser').focus(), 120);
}
function closeLoginModal() {
  document.getElementById('loginOverlay').classList.remove('open');
  unlockScroll();
}
function handleLoginOverlay(e) {
  if (e.target === document.getElementById('loginOverlay')) closeLoginModal();
}
function attemptLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const match = ADMINS.find(a => a.username === u && a.password === p);
  if (match) {
    currentRole = 'admin';
    currentAdminName = match.username;
    closeLoginModal();
    updateRoleUI();
    renderAll();
  } else {
    const errEl = document.getElementById('loginError');
    errEl.classList.add('show');
    document.getElementById('loginErrorMsg').textContent = 'Invalid username or password.';
    document.getElementById('loginModal').classList.add('shake');
    setTimeout(() => document.getElementById('loginModal').classList.remove('shake'), 400);
    document.getElementById('loginPass').value = '';
    document.getElementById('loginPass').focus();
  }
}

// ─── FULLSCREEN ──────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}
document.addEventListener('fullscreenchange', () => {
  const icon = document.getElementById('fsIcon');
  if (document.fullscreenElement) {
    icon.innerHTML = `<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>`;
  } else {
    icon.innerHTML = `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`;
  }
});

// ─── THEME ───────────────────────────────────────────────────
function toggleTheme() {
  isDark = !isDark;
  document.body.classList.toggle('dark', isDark);
  const icon = document.getElementById('themeIcon');
  if (isDark) {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  } else {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
}

// ─── FILTER / SEARCH ─────────────────────────────────────────
function setFilter(f) {
  activeFilter = f;
  _getFilterBtns().forEach(b => b.classList.remove('active'));
  document.querySelector('.f-' + f).classList.add('active');
  updateCounts();
  renderTasks();
}
function toggleSearch() {
  document.getElementById('searchBar').classList.toggle('open');
  if (document.getElementById('searchBar').classList.contains('open'))
    setTimeout(() => document.getElementById('searchInput').focus(), 50);
}

// ─── RENDER ──────────────────────────────────────────────────
function renderAll() { _invalidateCache(); updateCounts(); renderFeatured(); renderTasks(); }

function debouncedSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(renderTasks, 120);
}

function updateCounts() {
  _buildCache();
  let cAll = 0, cActive = 0, cToday = 0, cSoon = 0, cOver = 0, cDone = 0, cCancelled = 0;
  tasks.forEach(t => {
    if (t.cancelled) {
      cCancelled++;
      return; // Don't count in any other category
    }
    
    cAll++;
    const s = _getStatus(t);
    if (t.done) cDone++;
    if (s.over) cOver++;
    if (s.today) cToday++;
    if (s.soon) cSoon++;
    if (!t.done && !s.over) cActive++;
  });
  const setBadge = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.style.display = val > 0 ? '' : 'none';
  };
  setBadge('cnt-all', cAll);
  setBadge('cnt-active', cActive);
  setBadge('cnt-today', cToday);
  setBadge('cnt-soon', cSoon);
  setBadge('cnt-overdue', cOver);
  setBadge('cnt-done', cDone);
  setBadge('cnt-cancelled', cCancelled); 
  document.querySelector('.f-overdue').classList.toggle('has-overdue', cOver > 0);

  // ── Dynamic header title + badge color ──────────────────────
  const meta = FILTER_META[activeFilter] || FILTER_META.all;
  const titleEl = document.getElementById('taskAreaTitle');
  const badgeEl = document.getElementById('taskCountBadge');
  if (titleEl) titleEl.textContent = meta.label;
  if (badgeEl) {
    badgeEl.style.background = meta.badgeBg;
    badgeEl.style.color = meta.badgeColor;
  }
}

function renderFeatured() {
  pruneExpiredNotes();
  const notesEl = document.getElementById('notesList');
  if (notes.length) {
    let notesHTML = `<div class="feat-section-divider"><div class="feat-section-divider-line"></div><span class="feat-section-divider-label">📌 Notes (${notes.length})</span><div class="feat-section-divider-line"></div></div>`;
    notesHTML += [...notes].reverse().map(n => {
      const now = Date.now();
      const msLeft = n.expiresAt - now;
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      const expiryLabel = daysLeft <= 1 ? 'Expires today' : `Expires in ${daysLeft}d`;
      const canDel = currentRole === 'admin' && currentAdminName === n.author;
      const delBtn = canDel
        ? `<button class="note-del-btn" onclick="deleteNote('${n.id}')" title="Delete note"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>`
        : '';
      return `<div class="note-card">
        <div class="note-card-top"><div class="note-card-text">${esc(n.text)}</div>${delBtn}</div>
        <div class="note-card-meta">
          <span class="note-author ${getAdminChipClass(n.author)}">${getAdminIcon(n.author, 9)}${esc(getAdminTitle(n.author))}</span>
        </div>
      </div>`;
    }).join('');
    notesEl.innerHTML = notesHTML;
  } else {
    notesEl.innerHTML = '';
  }

  const el = document.getElementById('featuredList');
  const feat = tasks
    .filter(t => { 
      if (t.cancelled) return false;
      if (t.done) return false; 
      const s = _getStatus(t); 
      return s.over || s.today || s.soon; 
    })
    .sort((a, b) => {
      const da = a.date ? new Date(a.date + 'T' + (a.time || '23:59')) : new Date('9999');
      const db = b.date ? new Date(b.date + 'T' + (b.time || '23:59')) : new Date('9999');
      return da - db;
    });

  // ── Featured badge: shows "featCount / totalActive" ──────────
  const featBadge = document.getElementById('featCount');
  if (featBadge) {
    // Total active = not done, not overdue (same as cnt-active)
    const totalActive = tasks.filter(t => !t.cancelled && !t.done && !_getStatus(t).over).length;
    const featuredCount = feat.length;
    const totalFeatCount = featuredCount + notes.length; // for show/hide decision

    if (totalFeatCount > 0) {
      // Show as "featuredTaskCount/totalActive" ratio (notes don't count toward active ratio)
      if (featuredCount > 0 && totalActive > 0) {
        featBadge.textContent = `${featuredCount} of ${totalActive}`;
      } else if (notes.length > 0) {
        featBadge.textContent = notes.length;
      } else {
        featBadge.textContent = featuredCount;
      }
      featBadge.style.display = '';
    } else {
      featBadge.style.display = 'none';
    }
  }

  const featSlice = feat.slice(0, 4);
  if (!feat.length && !notes.length) {
  el.innerHTML = `<div class="no-featured"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><p>No urgent tasks here — but scroll down, there may still be active tasks without a close due date.</p></div>`;    return;
  }
if (!feat.length) { el.innerHTML = '<div class="no-featured"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><p>No urgent tasks here — but scroll down, there may still be active tasks without a close due date.</p></div>'; return; }

  const fOverdue = featSlice.filter(t => _getStatus(t).over);
  const fToday   = featSlice.filter(t => _getStatus(t).today);
  const fSoon    = featSlice.filter(t => _getStatus(t).soon);

  const buildFeatCards = (arr, labelText, labelColor) => {
    if (!arr.length) return '';
    let out = `<div class="feat-section-divider"><div class="feat-section-divider-line" style="background:${labelColor}33"></div><span class="feat-section-divider-label" style="color:${labelColor}">${labelText}</span><div class="feat-section-divider-line" style="background:${labelColor}33"></div></div>`;
    out += arr.map(t => {
      const due = fmtDue(t.date, t.time);
      const s = _getStatus(t);
      return `<div class="featured-card ${s.over ? 'urgent' : s.today ? 'soon' : ''}" onclick="expandCard('${t.id}')">
        <div class="fc-top"><span class="fc-name">${esc(t.name)}</span><span class="badge cat-${t.category}">${CAT_LABELS[t.category]}</span></div>
        <div class="fc-meta">${due ? `<span>${s.over ? '<span class="due-dot"></span>' : ''} ${esc(due)}</span>` : ''}</div>
      </div>`;
    }).join('');
    return out;
  };

  let html = '';
  html += buildFeatCards(fOverdue, 'Overdue', '#dc2626');
  html += buildFeatCards(fToday,   'Today',   '#ea6b0e');
  html += buildFeatCards(fSoon,    'Soon',    '#c47a0a');
  el.innerHTML = html;
}

function renderTasks() {
  const el = document.getElementById('taskArea');

  if (_isLoading) {
    el.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p style="font-size:13px;color:var(--sub);">Loading tasks…</p></div>`;
    return;
  }

  const search = (document.getElementById('searchInput').value || '').toLowerCase();
  _buildCache();
  let list = tasks.filter(t => {
    const s = _getStatus(t);
    
    if (activeFilter === 'cancelled' && !t.cancelled) return false;
    
    if (activeFilter !== 'cancelled' && t.cancelled) return false;
    
    if (activeFilter === 'done'    && !t.done) return false;
    if (activeFilter === 'today'   && (!s.today || t.done)) return false;
    if (activeFilter === 'soon'    && (!s.soon  || t.done)) return false;
    if (activeFilter === 'overdue' && (!s.over  || t.done)) return false;
    if (activeFilter === 'active'  && (t.done || s.over)) return false;
    if (search && !t.name.toLowerCase().includes(search) && !(t.notes || '').toLowerCase().includes(search)) return false;
    return true;
  });


  const sortByDate = (a, b) => {
    const da = a.date ? new Date(a.date + 'T' + (a.time || '23:59')) : new Date('9999');
    const db = b.date ? new Date(b.date + 'T' + (b.time || '23:59')) : new Date('9999');
    return da - db;
  };
  const upcoming = list.filter(t => !t.done && !_getStatus(t).over).sort(sortByDate);
  const overdue  = list.filter(t => !t.done &&  _getStatus(t).over).sort(sortByDate);
  const done     = list.filter(t =>  t.done).sort(sortByDate);

  const tb = document.getElementById('taskCountBadge');
  tb.textContent = list.length;
  tb.style.display = list.length > 0 ? '' : 'none';

  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12h6M12 9v6"/></svg><h3>${tasks.length ? 'No tasks match' : 'Nothing here yet'}</h3><p>${tasks.length ? 'Try a different filter.' : 'Tap + to add your first task.'}</p></div>`;
    return;
  }

  let html = upcoming.map(t => buildCard(t)).join('');
  if (done.length) {
    html += `<div class="done-divider"><div class="done-divider-line"></div><span class="done-divider-label">Completed (${done.length})</span><div class="done-divider-line"></div></div>`;
    html += done.map(t => buildCard(t)).join('');
  }
  if (overdue.length) {
    html += `<div class="done-divider overdue-divider"><div class="done-divider-line" style="background:rgba(220,38,38,0.3)"></div><span class="done-divider-label" style="color:var(--red)">⚠ Overdue (${overdue.length})</span><div class="done-divider-line" style="background:rgba(220,38,38,0.3)"></div></div>`;
    html += overdue.map(t => buildCard(t)).join('');
  }
  el.innerHTML = html;
  setTimeout(initStripNavs, 0);
}

// ─── BUILD CARD ──────────────────────────────────────────────
function buildCard(t) {
  const s = _getStatus(t);
  const over = s.over, tod = s.today, soon = s.soon;
  const due = fmtDue(t.date, t.time);
  const notesText = t.notes || '';
  const imgs = t.images || [];

  let statusChip = '';
  if (t.cancelled) statusChip = `<span class="status-chip cancelled">Cancelled</span>`;
  else if (t.done)      statusChip = `<span class="status-chip done">Done</span>`;
  else if (over)   statusChip = `<span class="status-chip overdue">Overdue</span>`;
  else if (tod)    statusChip = `<span class="status-chip today">Today</span>`;
  else if (soon)   statusChip = `<span class="status-chip soon">Soon</span>`;

  const creatorChip = t.createdBy
    ? `<span class="footer-creator ${getAdminChipClass(t.createdBy)}">${getAdminIcon(t.createdBy, 10)}${esc(getAdminTitle(t.createdBy))}</span>`
    : '';

  const imgHTML = imgs.map((src, i) =>
    `<div class="card-img-thumb" onclick="openLightbox('${t.id}',${i})"><img src="${esc(src)}" alt="" loading="lazy"/></div>`
  ).join('');

  const addImgBtn = currentRole === 'admin'
    ? `<button class="add-img-btn" onclick="triggerImgUpload('${t.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add</button>`
    : '';

  let collapsedFooter, expandedFooter;
  if (currentRole === 'admin') {
    const adminBtns = t.cancelled 
      ? `
        <button class="cfb-icon edit" onclick="event.stopPropagation();openModal('${t.id}')" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="cfb-icon restore" onclick="event.stopPropagation();uncancelTask('${t.id}')" title="Restore task">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        </button>
        <button class="cfb-icon del" onclick="event.stopPropagation();deleteTask('${t.id}')" title="Delete permanently">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
        <button class="cfb-icon copy" id="copy-c-${t.id}" onclick="event.stopPropagation();copyDesc('${t.id}','copy-c-${t.id}')" title="Copy description">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>`
      : `
        <button class="cfb-icon edit" onclick="event.stopPropagation();openModal('${t.id}')" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="cfb-icon cancel" onclick="event.stopPropagation();cancelTask('${t.id}')" title="Cancel task">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </button>
        <button class="cfb-icon del" onclick="event.stopPropagation();deleteTask('${t.id}')" title="Delete permanently">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
        <button class="cfb-icon copy" id="copy-c-${t.id}" onclick="event.stopPropagation();copyDesc('${t.id}','copy-c-${t.id}')" title="Copy description">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>`;
    
    collapsedFooter = `<div class="card-footer">${adminBtns}<span class="cfb-spacer"></span>${creatorChip}<button class="cfb view" onclick="event.stopPropagation();expandCard('${t.id}')" title="View"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>`;
    const adminBtnsExp = adminBtns.replace('copy-c-', 'copy-e-');
    expandedFooter = `<div class="card-footer-exp">${adminBtnsExp}<span class="cfb-spacer"></span>${creatorChip}<button class="cfb view" onclick="event.stopPropagation();collapseCard('${t.id}')" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button></div>`;
  } else {
    const doneBtn = t.done
      ? `<button class="cfb undo-done" onclick="event.stopPropagation();toggleDone('${t.id}')">↩ Undo</button>`
      : `<button class="cfb mark-done" onclick="event.stopPropagation();toggleDone('${t.id}')">✓ Mark Done</button>`;
    collapsedFooter = `<div class="card-footer">${doneBtn}<span class="cfb-spacer"></span>${creatorChip}<button class="cfb view" onclick="event.stopPropagation();expandCard('${t.id}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></div>`;
    const doneBtnExp = t.done
      ? `<button class="cfb undo-done" onclick="event.stopPropagation();toggleDone('${t.id}')">↩ Undo Done</button>`
      : `<button class="cfb mark-done" onclick="event.stopPropagation();toggleDone('${t.id}')">✓ Mark Done</button>`;
    expandedFooter = `<div class="card-footer-exp">${doneBtnExp}<span class="cfb-spacer"></span>${creatorChip}<button class="cfb view" onclick="event.stopPropagation();collapseCard('${t.id}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button></div>`;
  }

  return `
  <div class="task-card ${t.done ? 'done-card' : ''} ${t.cancelled ? 'cancelled-card' : ''} ${over && !t.done && !t.cancelled ? 'overdue-card' : ''} ${t._expanded ? 'expanded' : ''}" id="card-${t.id}" data-id="${t.id}">
    <div class="card-top">
      <div class="card-name">${esc(t.name)}</div>
      <span class="badge cat-${t.category}">${CAT_LABELS[t.category] || t.category}</span>
    </div>
    ${due || statusChip ? `<div class="card-due-meta">${due ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span>${esc(due)}</span>` : ''} ${statusChip}</div>` : ''}
    <div class="card-desc-collapsed ${!notesText ? 'no-desc' : ''}" onclick="expandCard('${t.id}')">
      ${esc(notesText) || 'No description — click to view.'}
    </div>
    ${collapsedFooter}
    <div class="card-expanded-body">
      <div class="card-desc-full">${esc(notesText) || '<em style="opacity:0.5">No description.</em>'}</div>
      ${(imgHTML || addImgBtn) ? `<div class="card-images-wrap" id="imgwrap-${t.id}">
        <button class="strip-nav prev" onclick="event.stopPropagation();stripScroll('${t.id}',-1)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>
        <div class="card-images" id="imgstrip-${t.id}">${imgHTML}${addImgBtn}</div>
        <button class="strip-nav next" onclick="event.stopPropagation();stripScroll('${t.id}',1)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div>` : ''}
      ${expandedFooter}
    </div>
  </div>`;
}

// ─── EXPAND / COLLAPSE ───────────────────────────────────────
function expandCard(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (activeFilter !== 'all') {
    const s = _getStatus(t);
    const visible = (activeFilter === 'today' && s.today) || (activeFilter === 'soon' && s.soon) ||
                    (activeFilter === 'overdue' && s.over) || (activeFilter === 'done' && t.done) ||
                    (activeFilter === 'active' && !t.done && !s.over);
    if (!visible) {
      activeFilter = 'all';
      _getFilterBtns().forEach(b => b.classList.remove('active'));
      document.querySelector('.f-all').classList.add('active');
    }
  }
  tasks.forEach(x => x._expanded = false);
  t._expanded = true;
  renderTasks();
  setTimeout(() => {
    const el = document.getElementById('card-' + id);
    if (!el) return;
    const topbar  = document.querySelector('.topbar')?.offsetHeight || 57;
    const datebar = document.querySelector('.date-bar')?.offsetHeight || 43;
    const taskhdr = document.querySelector('.all-task-header')?.offsetHeight || 44;
    const offset  = topbar + datebar + taskhdr + 8;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }, 60);
}

function collapseCard(id) {
  const t = tasks.find(x => x.id === id);
  if (t) t._expanded = false;
  renderTasks();
}

// ─── COPY & TOGGLE DONE ──────────────────────────────────────
function copyDesc(id, btnId) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const text = (t.notes || '').trim() || t.name;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {});
}

async function toggleDone(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (!t.done) {
    const card = document.getElementById('card-' + id);
    playCompletion(card, () => {
      t.done = true;
      setLocalDone(id, true);   // ✅ Save to localStorage only — NOT Supabase
      renderAll();
    });
  } else {
    t.done = false;
    setLocalDone(id, false);    // ✅ Remove from localStorage only
    renderAll();
  }
}

// ─── DELETE TASK ─────────────────────────────────────────────
function deleteTask(id) {
  if (currentRole !== 'admin') return;
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  lockScroll();
  pendingDeleteId = id;
  document.getElementById('delSubText').textContent = `"${t.name}" will be permanently removed.`;
  document.getElementById('delOverlay').classList.add('open');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  tasks = tasks.filter(t => t.id !== id);
  pendingDeleteId = null;
  closeDelModal();
  renderAll();
  await deleteTaskFromDb(id);
}

function closeDelModal() {
  document.getElementById('delOverlay').classList.remove('open');
  pendingDeleteId = null;
  unlockScroll();
}

// ─── CANCEL TASK ─────────────────────────────────────────────
let pendingCancelId = null;

async function cancelTask(id) {
  if (currentRole !== 'admin') return;
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  lockScroll();
  pendingCancelId = id;
  document.getElementById('cancelSubText').textContent = `"${t.name}" will be moved to Cancelled.`;
  document.getElementById('cancelOverlay').classList.add('open');
}

async function confirmCancel() {
  if (!pendingCancelId) return;
  const id = pendingCancelId;
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  // Mark as cancelled in memory
  task.cancelled = true;
  pendingCancelId = null;
  closeCancelModal();
  renderAll();

  // Update in Supabase
  await persistTask(task, false);

  // 🔔 Notify all subscribed users about the cancellation
  _notifyCancelledTask(task);
}

/**
 * Calls the Supabase Edge Function to push a cancellation notification
 * to all subscribed users (skipping those who already marked it done).
 */
async function _notifyCancelledTask(task) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/notify-cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          taskId:   task.id,
          taskName: task.name,
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '(no body)');
      console.error(`[Cancel Notif] Edge Function returned ${res.status}: ${errText}`);
      return;
    }

    const data = await res.json();
    console.log(`[Cancel Notif] sent=${data.sent} failed=${data.failed} skipped=${data.skipped ?? 0}`);
  } catch (err) {
    console.warn('[Cancel Notif] Network error — could not reach Edge Function:', err);
  }
}

function closeCancelModal() {
  document.getElementById('cancelOverlay').classList.remove('open');
  pendingCancelId = null;
  unlockScroll();
}

async function uncancelTask(id) {
  if (currentRole !== 'admin') return;
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  task.cancelled = false;
  renderAll();
  await persistTask(task, false);
}


// ─── IMAGES ──────────────────────────────────────────────────
function triggerImgUpload(id) { uploadTargetId = id; document.getElementById('imgUpload').click(); }

function stripScroll(id, dir) {
  const strip = document.getElementById('imgstrip-' + id);
  if (!strip) return;
  strip.scrollBy({ left: dir * 180, behavior: 'smooth' });
  setTimeout(() => stripUpdateNav(id), 320);
}
function stripUpdateNav(id) {
  const strip = document.getElementById('imgstrip-' + id);
  const wrap  = document.getElementById('imgwrap-' + id);
  if (!strip || !wrap) return;
  const prev = wrap.querySelector('.strip-nav.prev');
  const next = wrap.querySelector('.strip-nav.next');
  if (prev) prev.classList.toggle('hidden', strip.scrollLeft <= 4);
  if (next) next.classList.toggle('hidden', strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4);
}
function initStripNavs() {
  document.querySelectorAll('[id^="imgstrip-"]').forEach(strip => {
    const id = strip.id.replace('imgstrip-', '');
    stripUpdateNav(id);
    strip.addEventListener('scroll', () => stripUpdateNav(id), { passive: true });
  });
}

async function handleImgUpload(e) {
  const files = [...e.target.files];
  const t = tasks.find(x => x.id === uploadTargetId);
  if (!t) return;
  if (!t.images) t.images = [];
  let loaded = 0;
  files.forEach(f => {
    const reader = new FileReader();
    reader.onload = async ev => {
      t.images.push(ev.target.result);
      loaded++;
      if (loaded === files.length) {
        renderTasks();
        await persistTask(t, false);
      }
    };
    reader.readAsDataURL(f);
  });
  e.target.value = '';
}

// ─── LIGHTBOX ────────────────────────────────────────────────
function openLightbox(id, idx) {
  const t = tasks.find(x => x.id === id);
  if (!t || !t.images[idx]) return;
  lockScroll();
  _lbTaskId = id; _lbIdx = idx;
  _lbUpdate();
  document.getElementById('lightbox').classList.add('open');
}
function _lbUpdate() {
  const t = tasks.find(x => x.id === _lbTaskId);
  if (!t) return;
  const imgs = t.images || [];
  document.getElementById('lightboxImg').src = imgs[_lbIdx] || '';
  const ctr = document.getElementById('lbCounter');
  ctr.textContent = imgs.length > 1 ? `${_lbIdx + 1} / ${imgs.length}` : '';
  document.getElementById('lbPrev').style.display = imgs.length > 1 ? 'flex' : 'none';
  document.getElementById('lbNext').style.display = imgs.length > 1 ? 'flex' : 'none';
  const wrap = document.getElementById('lbDelWrap');
  wrap.className = 'lb-del-wrap' + (currentRole === 'admin' ? ' admin-visible' : '');
}
function lbNav(dir) {
  const t = tasks.find(x => x.id === _lbTaskId);
  if (!t) return;
  const total = (t.images || []).length;
  _lbIdx = (_lbIdx + dir + total) % total;
  _lbUpdate();
}
function lbDeleteImg() {
  lockScroll();
  document.getElementById('photoDelOverlay').classList.add('open');
}
function closePhotoDelModal() {
  document.getElementById('photoDelOverlay').classList.remove('open');
  unlockScroll();
}
async function confirmPhotoDelete() {
  closePhotoDelModal();
  const t = tasks.find(x => x.id === _lbTaskId);
  if (!t) return;
  t.images.splice(_lbIdx, 1);
  if (t.images.length === 0) { closeLightbox(); renderTasks(); }
  else { _lbIdx = Math.min(_lbIdx, t.images.length - 1); _lbUpdate(); renderTasks(); }
  await persistTask(t, false);
}
function handleLightboxClick(e) {
  if (e.target === document.getElementById('lightbox') || e.target === document.getElementById('lightboxImg'))
    closeLightbox();
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  unlockScroll();
  _lbTaskId = null;
}

// ─── COMPLETION ANIMATION ────────────────────────────────────
function playCompletion(el, cb) {
  if (!el) { cb(); return; }
  el.classList.add('task-completing');
  const chk = document.createElement('div');
  chk.className = 'completion-chk';
  chk.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
  el.appendChild(chk);
  const cols = ['var(--green)', 'var(--amber)', 'var(--accent)', 'var(--red)'];
  for (let i = 0; i < 7; i++) {
    const p = document.createElement('div');
    p.className = 'conf-p';
    p.style.background = cols[Math.floor(Math.random() * cols.length)];
    p.style.left = `${50 + (Math.random() - .5) * 60}%`;
    p.style.top = '50%';
    el.appendChild(p);
  }
  setTimeout(() => {
    chk.remove();
    el.querySelectorAll('.conf-p').forEach(p => p.remove());
    el.classList.remove('task-completing');
    cb();
  }, 580);
}

// ─── ADD/EDIT MODAL ──────────────────────────────────────────
function openModal(id) {
  if (currentRole !== 'admin') return;
  lockScroll();
  editId = id || null;
  document.getElementById('modalTitle').textContent = editId ? 'Edit Task' : 'Add Task';
  if (editId) {
    const t = tasks.find(x => x.id === editId);
    document.getElementById('fName').value  = t.name;
    document.getElementById('fCat').value   = t.category;
    document.getElementById('fDate').value  = t.date || '';
    document.getElementById('fTime').value  = t.time || '';
    document.getElementById('fNotes').value = t.notes || '';
  } else {
    ['fName','fDate','fTime','fNotes'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('fCat').value = 'quiz';
  }
  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('fName').focus(), 100);
}
function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  editId = null;
  unlockScroll();
}
function handleOverlay(e) { if (e.target === document.getElementById('overlay')) closeModal(); }

async function saveTask() {
  const name = document.getElementById('fName').value.trim();
  if (!name) {
    document.getElementById('fName').style.borderColor = 'var(--red)';
    document.getElementById('fName').focus();
    return;
  }
  document.getElementById('fName').style.borderColor = '';

  const data = {
    name,
    category: document.getElementById('fCat').value,
    date:     document.getElementById('fDate').value,
    time:     document.getElementById('fTime').value,
    notes:    document.getElementById('fNotes').value.trim(),
  };

  let isNew = false;
  let taskObj;

  if (editId) {
    const idx = tasks.findIndex(t => t.id === editId);
    tasks[idx] = { ...tasks[idx], ...data };
    taskObj = tasks[idx];
  } else {
    isNew = true;
    taskObj = {
      id:        genId(),
      created:   Date.now(),
      images:    [],
      done:      false,
      _expanded: false,
      createdBy: currentAdminName,
      ...data,
    };
    tasks.push(taskObj);
  }

  closeModal();
  renderAll();
  await persistTask(taskObj, isNew);
}

// ─── NOTES ───────────────────────────────────────────────────
function openNoteModal() {
  if (currentRole !== 'admin') return;
  lockScroll();
  document.getElementById('nText').value = '';
  document.getElementById('nExpiry').value = '3';
  document.getElementById('noteOverlay').classList.add('open');
  setTimeout(() => document.getElementById('nText').focus(), 100);
}
function closeNoteModal() {
  document.getElementById('noteOverlay').classList.remove('open');
  unlockScroll();
}
function handleNoteOverlay(e) { if (e.target === document.getElementById('noteOverlay')) closeNoteModal(); }

async function saveNote() {
  const text = document.getElementById('nText').value.trim();
  if (!text) {
    document.getElementById('nText').style.borderColor = 'var(--red)';
    document.getElementById('nText').focus();
    return;
  }
  document.getElementById('nText').style.borderColor = '';
  const days = parseInt(document.getElementById('nExpiry').value) || 3;
  const note = {
    id:        genId(),
    text,
    author:    currentAdminName,
    createdAt: Date.now(),
    expiresAt: Date.now() + (days * 24 * 60 * 60 * 1000),
  };
  notes.push(note);
  closeNoteModal();
  renderFeatured();
  await persistNote(note);
}

async function deleteNote(id) {
  notes = notes.filter(n => n.id !== id);
  renderFeatured();
  await deleteNoteFromDb(id);
}

// ─── KEYBOARD SHORTCUTS ──────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeModal(); closeLightbox(); closeLoginModal();
    closeDelModal(); closeNoteModal(); closeLogoutModal(); closePhotoDelModal(); closeCancelModal(); closeHelp();
    closeUnsubChallenge();
  }

  if (document.getElementById('lightbox').classList.contains('open')) {
    if (e.key === 'ArrowLeft')  lbNav(-1);
    if (e.key === 'ArrowRight') lbNav(+1);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (document.getElementById('overlay').classList.contains('open'))      saveTask();
    if (document.getElementById('loginOverlay').classList.contains('open')) attemptLogin();
    if (document.getElementById('noteOverlay').classList.contains('open'))  saveNote();
  }
});

// ─── MOBILE KEYBOARD ─────────────────────────────────────────
(function () {
  const SHEET_OVERLAYS = ['overlay', 'noteOverlay'];
  function applyViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    SHEET_OVERLAYS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.top = vv.offsetTop + 'px'; el.style.left = vv.offsetLeft + 'px';
      el.style.right = '0px'; el.style.height = vv.height + 'px'; el.style.bottom = 'auto';
      const modal = el.querySelector('.modal');
      if (modal) modal.style.maxHeight = Math.floor(vv.height * 0.9) + 'px';
    });
  }
  function resetViewport() {
    SHEET_OVERLAYS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.top = '0'; el.style.left = '0'; el.style.right = '0';
      el.style.height = ''; el.style.bottom = '0';
      const modal = el.querySelector('.modal');
      if (modal) modal.style.maxHeight = '';
    });
  }
  function applyLoginViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const el = document.getElementById('loginOverlay');
    if (!el) return;
    el.style.position = 'fixed'; el.style.top = vv.offsetTop + 'px'; el.style.left = vv.offsetLeft + 'px';
    el.style.width = vv.width + 'px'; el.style.height = vv.height + 'px';
    el.style.bottom = 'auto'; el.style.right = 'auto';
    const lm = el.querySelector('.login-modal');
    if (lm) { lm.style.maxHeight = Math.floor(vv.height * 0.92) + 'px'; lm.style.overflowY = 'auto'; }
  }
  function resetLoginViewport() {
    const el = document.getElementById('loginOverlay');
    if (!el) return;
    el.style.position = ''; el.style.top = ''; el.style.left = '';
    el.style.width = ''; el.style.height = ''; el.style.bottom = ''; el.style.right = '';
    const lm = el.querySelector('.login-modal');
    if (lm) { lm.style.maxHeight = ''; lm.style.overflowY = ''; }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { applyViewport(); applyLoginViewport(); });
    window.visualViewport.addEventListener('scroll', () => { applyViewport(); applyLoginViewport(); });
  }
  const _openModal = window.openModal;
  window.openModal = function (...args) { if (_openModal) _openModal(...args); setTimeout(applyViewport, 50); };
  const _openNoteModal = window.openNoteModal;
  window.openNoteModal = function (...args) { if (_openNoteModal) _openNoteModal(...args); setTimeout(applyViewport, 50); };
  const _openLoginModal = window.openLoginModal;
  window.openLoginModal = function (...args) { if (_openLoginModal) _openLoginModal(...args); setTimeout(applyLoginViewport, 50); };
  const _closeModal = window.closeModal;
  window.closeModal = function (...args) { if (_closeModal) _closeModal(...args); resetViewport(); };
  const _closeNoteModal = window.closeNoteModal;
  window.closeNoteModal = function (...args) { if (_closeNoteModal) _closeNoteModal(...args); resetViewport(); };
  const _closeLoginModal = window.closeLoginModal;
  window.closeLoginModal = function (...args) { if (_closeLoginModal) _closeLoginModal(...args); resetLoginViewport(); };
})();

// ─── INIT ────────────────────────────────────────────────────
document.getElementById('dateBarText').innerHTML =
  `<span>${new Date().toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', year:'numeric' })}</span>`;

currentRole = 'user';
updateRoleUI();

loadAdmins().then(() => {
  loadFromSupabase();
});

// ─── DAILY TIP (changes at 8am, 12pm, 6pm PHT) ───────────────
(function () {
  const TIPS = [
    // Navigation & Filters
    "Tap 'View' on any card to see the full description and images.",
    "Use the 🔍 search icon to find tasks by name or description.",
    "'Active' filter shows tasks you should be working on right now.",
    "'Soon' shows tasks due within 3 days — check it every morning!",
    "'Today' filter is your daily priority list. Start there!",
    "Overdue tasks are highlighted in red — deal with them first!",
    "'All' filter shows everything: active, done, and overdue together.",
    "The 'Done' filter lets you review everything you've completed.",
    "Tap any Featured card to jump straight to that task in the list.",

    // Featured Panel
    "Featured panel shows your most urgent tasks — overdue, today, and soon.",
    "The badge next to 'Featured' shows how many urgent tasks need attention.",
    "Notes posted by admins expire automatically after 1–7 days.",
    "The featured carousel auto-scrolls — swipe it manually too!",
    "Pinned notes from admins appear at the top of the Featured panel.",

    // Done & Progress
    "Your 'Done' progress is saved only on your device — it's yours alone.",
    "Each classmate tracks their own progress independently.",
    "Marked something done by mistake? Tap '↩ Undo' to revert it.",
    "Completing a task plays a small animation — satisfying, right? ✅",
    "Clearing your browser data will reset your done state — be careful!",

    // Notifications
    "Tap the bell 🔔 to get notified before deadlines — even when closed.",
    "Once the bell is enabled, it hides itself — it's still working!",
    "Push notifications remind you about tasks due today, tomorrow, or in 3 days.",
    "You only need to enable notifications once. They persist across visits.",
    "Notifications still work when your phone screen is locked. 🔒",

    // UI & Display
    "Tap the 🌙 moon icon to switch to dark mode — easier on the eyes at night.",
    "Expand icon (top-left) hides the browser UI for a cleaner view during class.",
    "The sync dot turns green 🟢 when live and orange 🟡 when saving.",
    "Red sync dot means you're offline — tasks are still visible from cache.",
    "Add this app to your home screen for a full app-like experience!",
    "Dark mode + fullscreen = distraction-free studying. Try it! 🌙",

    // Task Cards
    "Each card shows name, category, due date, and status at a glance.",
    "Status chips — Soon, Today, Overdue, Done — update automatically.",
    "Tap the description preview to expand the full card.",
    "Expanded cards show full notes, images, and action buttons.",
    "Tap 'Close' on an expanded card to collapse it back.",
    "Images attached to tasks can be tapped to view in full-screen lightbox.",

    // Study Habits & Reminders
    "Check the app every morning to see what's due today or soon!",
    "Don't wait for Overdue — set a goal to always clear 'Today' first.",
    "Review 'Soon' tasks the night before to plan your next day.",
    "Exams and quizzes show up here — never miss one again. 📚",
    "Treat 'Today' tasks as your to-do list for the day.",
    "Reviewing tasks regularly helps you stay ahead, not just catch up.",
    "If you see red, act fast — overdue tasks don't disappear on their own!",
    "Bookmark or install this app so you always have quick access.",
    "Share the app link with classmates who might not know about it yet!",
    "Good luck on your studies, BSCS1B! You've got this. 💪",
  ];

  // Slot labels shown in the tip box
const SLOT_LABELS = {
    0: 'Morning Tip',
    1: 'Afternoon Tip',
    2: 'Evening Tip',
  };

  // Returns { slotIndex, msUntilNext } based on current PHT time
  function getPHTSlot() {
    const now = new Date();
    // PHT = UTC+8
    const phtOffset = 8 * 60; // minutes
    const localOffset = now.getTimezoneOffset(); // minutes behind UTC
    const phtMs = now.getTime() + (phtOffset + localOffset) * 60000;
    const pht = new Date(phtMs);

    const h = pht.getHours();
    const m = pht.getMinutes();
    const s = pht.getSeconds();
    const ms = pht.getMilliseconds();

    // Slot boundaries: 8:00, 12:00, 18:00
    let slot;
    let nextHour;
if (h >= 18) {
      slot = 2;
      nextHour = 24; // next midnight = new day
    } else if (h >= 12) {
      slot = 1;
      nextHour = 18;
    } else {
      slot = 0;
      nextHour = 12;
    }

    // ms until next slot change
    const msUntilNext =
      ((nextHour - h - 1) * 3600 + (60 - m - 1) * 60 + (60 - s)) * 1000 +
      (1000 - ms);

    // Unique slot count: day * 3 + slot (PHT day)
    const phtDayNum = Math.floor(phtMs / 86400000);
    const slotCount = phtDayNum * 3 + slot;

    return { slot, slotCount, msUntilNext };
  }

  function renderTip() {
    const el = document.getElementById('dailyTip');
    if (!el) return;
    const { slot, slotCount, msUntilNext } = getPHTSlot();
    const tipIdx = slotCount % TIPS.length;
    el.innerHTML =
      `<span class="daily-tip-label">${SLOT_LABELS[slot]}</span>${TIPS[tipIdx]}`;

    // Schedule next update exactly when the slot changes
    clearTimeout(el._tipTimer);
    el._tipTimer = setTimeout(renderTip, msUntilNext);
  }

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTip);
  } else {
    renderTip();
  }
})();

// ─── HELP MODAL ──────────────────────────────────────────────
function openHelp() {
  lockScroll();
  document.getElementById('helpOverlay').classList.add('open');
}
function closeHelp() {
  document.getElementById('helpOverlay').classList.remove('open');
  unlockScroll();
}
function handleHelpOverlay(e) {
  if (e.target === document.getElementById('helpOverlay')) closeHelp();
}
