// ─────────────────────────────────────────────────────────────────────────────
// INDEX.HTML PATCHES
// Apply these changes manually to your index.html
// All changes are clearly labelled with // CHANGE: comments
// ─────────────────────────────────────────────────────────────────────────────


// ── 1. MODEL STRING UPDATE ─────────────────────────────────────────────────
// Find all occurrences of the old model string and replace:
//   OLD: claude-sonnet-4-20250514
//   NEW: claude-sonnet-4-6
//
// There are 7 occurrences in index.html — in generateHooks(), generateCaption(),
// generateSlideTexts(), generateSlide(), bulkGenerate(), generateCharacter(),
// and addToQueue().
// Do a global find+replace in your editor.


// ── 2. BLACKLIST INTEGRATION IN PERFORMANCE LOG ────────────────────────────
// Replace the logPerformance() function with this version.
// Adds: auto-blacklist hooks under 1K views via /api/blacklist endpoint.

async function logPerformance() {
  const hook    = document.getElementById('log-hook').value.trim();
  const views   = parseInt(document.getElementById('log-views').value) || 0;
  const lesson  = document.getElementById('log-lesson').value.trim();
  if (!hook) { showToast('Enter a hook', 'error'); return; }

  performanceLogs.unshift({ hook, views, lesson, date: new Date().toLocaleDateString() });
  localStorage.setItem('larry_logs', JSON.stringify(performanceLogs));

  // CHANGE: Auto-blacklist hooks that performed poorly (under 1K views)
  // Prevents them being reused in future hook generation
  if (views > 0 && views < 1000) {
    try {
      await fetch('/api/blacklist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'add', hook, reason: `${views} views` }),
      });
      showToast(`Logged + blacklisted (${views} views — won't be reused)`, 'success');
    } catch (e) {
      showToast('Result logged', 'success');
    }
  } else {
    showToast('Result logged', 'success');
  }

  document.getElementById('log-hook').value    = '';
  document.getElementById('log-views').value   = '';
  document.getElementById('log-lesson').value  = '';
  renderPerfTable();
}


// ── 3. PERFORMANCE TABLE — show blacklist badge ────────────────────────────
// Replace renderPerfTable() with this version.
// Adds: blacklisted badge on low-performing hooks, unblacklist button.

function renderPerfTable() {
  const tbody = document.getElementById('perf-tbody');
  if (performanceLogs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);font-size:13px;text-align:center;padding:20px;">No posts logged yet</td></tr>';
    return;
  }
  tbody.innerHTML = performanceLogs.map((l, i) => {
    const cls        = l.views >= 100000 ? 'high' : l.views >= 10000 ? 'mid' : 'low';
    const hasFormula = /dermatologist|mum|mom|partner|flatmate|friend|sister|boyfriend|girlfriend|wife|husband|showed|stopped/i.test(l.hook);
    // CHANGE: show blacklisted badge for low-view hooks
    const isBlacklisted = l.views > 0 && l.views < 1000;
    return `<tr>
      <td>
        <div class="hook-preview">${l.hook}</div>
        ${l.lesson ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">→ ${l.lesson}</div>` : ''}
        ${isBlacklisted
          ? `<div style="font-size:10px;color:var(--error);font-family:'DM Mono',monospace;margin-top:2px;">⊘ blacklisted
              <button onclick="unblacklistHook('${l.hook.replace(/'/g,"\\'")}', ${i})"
                style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:10px;text-decoration:underline;padding:0 4px;">
                remove
              </button>
            </div>`
          : ''}
      </td>
      <td><span class="view-count ${cls}">${l.views.toLocaleString()}</span></td>
      <td style="font-size:11px;color:${hasFormula ? 'var(--success)' : 'var(--muted)'}">${hasFormula ? '✓ formula' : '—'}</td>
      <td><button class="btn btn-danger" onclick="deleteLog(${i})">×</button></td>
    </tr>`;
  }).join('');
}

// CHANGE: new function — remove a hook from the blacklist
async function unblacklistHook(hook, logIndex) {
  try {
    await fetch('/api/blacklist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'remove', hook }),
    });
    showToast('Removed from blacklist', 'success');
    renderPerfTable();
  } catch (e) {
    showToast('Could not remove from blacklist: ' + e.message, 'error');
  }
}


// ── 4. HOOK GENERATION — filter blacklisted hooks ─────────────────────────
// In generateHooks(), after parsing the hooks array, add this filter
// before calling renderHooks():
//
//   const hooks = JSON.parse(text.replace(/```json|```/g, '').trim());
//
//   // CHANGE: filter out any hooks that match blacklisted ones
//   const filtered = await filterBlacklistedHooks(hooks);
//   renderHooks(filtered);
//
// And add this helper function:

async function filterBlacklistedHooks(hooks) {
  try {
    const res  = await fetch('/api/blacklist');
    const data = await res.json();
    const blacklisted = new Set((data.items || []).map(item => item.hook?.slice(0, 100)));
    return hooks.filter(h => !blacklisted.has(h.slice(0, 100)));
  } catch (e) {
    return hooks; // if blacklist fetch fails, show all hooks
  }
}


// ── 5. SCHEDULER — per-account queue namespacing ──────────────────────────
// In addToQueue(), replace the fetch call with this version that uses
// the account-namespaced endpoint. This prevents jobs from different
// accounts mixing in the same queue.
//
// The /api/queue endpoint already handles this if you pass accountLabel.
// Just add accountLabel to the job object (it's already there) and the
// queue endpoint will namespace it server-side once you update api/queue.js.
//
// The job object already includes accountLabel — no change needed in the
// frontend. The fix is in api/queue.js (see queue.js patch below).


// ── SUMMARY OF MANUAL EDITS NEEDED IN index.html ──────────────────────────
// 1. Global find+replace: claude-sonnet-4-20250514 → claude-sonnet-4-6
// 2. Replace logPerformance() with version above
// 3. Replace renderPerfTable() with version above
// 4. Add unblacklistHook() function
// 5. Add filterBlacklistedHooks() function
// 6. In generateHooks(), replace renderHooks(hooks) with:
//      const filtered = await filterBlacklistedHooks(hooks);
//      renderHooks(filtered);
