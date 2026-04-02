// Replace the generateHooks() function in index.html with this version.
// Key changes:
//   - Prompt stripped from ~50 lines of rules down to ~20
//   - Leads with 5 concrete examples instead of abstract formula breakdown
//   - Removes the "CRITICAL RULES" / "HIGH-PERFORMING PATTERNS" scaffolding
//     that causes Claude to produce formula-correct but lifeless hooks
//   - Model updated to claude-sonnet-4-6

async function generateHooks() {
  const btn   = document.getElementById('hook-btn');
  const inner = document.getElementById('hook-btn-inner');
  btn.disabled = true;
  inner.innerHTML = '<div class="spinner spinner-sm"></div> Generating...';

  const count   = document.getElementById('hook-count').value;
  const appName = document.getElementById('app-name').value || 'Aureya';
  const audience = document.getElementById('app-audience').value || 'women with sensitive skin';

  const prompt = `You write TikTok hooks for a skincare app called ${appName}.
The audience: ${audience}.

Here are 5 hooks that got 100K–600K views. Write hooks that sound exactly like these — same energy, same specificity, same casual tone:

1. "I spent 6 months avoiding mirrors because of my rosacea until a random girl at Sephora told me about this"
2. "I turned down a girls holiday because I was too embarrassed about my skin until my flatmate showed me what she'd been using"
3. "I wore foundation to the gym every day for two years to hide my eczema until a woman in the changing room said something that changed everything"
4. "I cancelled a first date three times because my skin was flaring so badly until a coworker noticed and sent me a link"
5. "I spent £300 on products that made my rosacea worse until a stranger at the pharmacy told me to stop"

Notice what makes them work:
- A specific time period or amount (6 months, £300, two years, three times)
- A specific embarrassing thing the person was doing because of their skin
- A real ordinary person who helped — not a doctor, not an ad, not a brand
- Ends on an open loop — the viewer has to keep watching to find out what it was

Write ${count} new hooks in the same style. Vary the embarrassing behaviour, the time period, the person who helped, and the setting. Keep them under 25 words. Natural conversational English — sounds like a text message not a marketing brief.

Return ONLY a JSON array of strings. No preamble, no markdown.`;

  try {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-anthropic-key': getAnthropicKey()
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text  = data.content?.[0]?.text || '[]';
    const hooks = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Filter blacklisted hooks before rendering
    const filtered = await filterBlacklistedHooks(hooks);
    renderHooks(filtered);
  } catch (e) {
    showToast('Error generating hooks: ' + e.message, 'error');
  }

  btn.disabled    = false;
  inner.innerHTML = '✦ Generate hooks with Claude';
}


// Also replace filterBlacklistedHooks() — or add it if it doesn't exist yet:

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
