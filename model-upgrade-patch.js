// ─────────────────────────────────────────────────────────────────────────────
// MODEL UPGRADE PATCH
// Replace these two functions in index.html:
//   1. buildRVBody()     — FLUX.1 Dev → FLUX.2 Dev LoRA
//   2. generateSlide()   — crystal-upscaler → FLUX.2 Realism LoRA
//
// Everything else (prompts, story planning, text overlay) stays identical.
// ─────────────────────────────────────────────────────────────────────────────


// ── FUNCTION 1: buildRVBody ───────────────────────────────────────────────────
// CHANGE: endpoint is now fal-ai/flux-2/lora (FLUX.2 Dev) instead of fal-ai/flux-lora (FLUX.1 Dev)
// CHANGE: guidance_scale bumped from 1.8 → 3.5 (FLUX.2 responds better at 3.5–4.5)
// CHANGE: num_inference_steps bumped from 28 → 35 (FLUX.2 benefits from more steps)
// CHANGE: image_size uses named preset "portrait_9_16" — cleaner than custom width/height
// Everything else (negative prompt, LoRA injection, realism suffixes) unchanged

function buildRVBody(prompt, charUrl, hasLoRA, loraPath, loraTrigger, slideIndex) {
  const realismSuffixes = [
    ', ugly badly lit phone selfie, slightly motion blurred, harsh overhead light, cheap home, skin looks sore and reactive, NOT cinematic, NOT beautiful',
    ', dim cheap lamp light, slightly grainy, ordinary messy home, skin still irritated, candid unaware, NOT staged, NOT moody',
    ', flat indoor light, slightly washed out, ordinary bedroom, phone front camera, slightly off-centre, NOT professional',
    ', natural window light flat and grey, slightly underexposed, ordinary home, real skin texture visible, NOT cinematic, NOT glowing',
    ', flat daylight through window, slightly grainy, real home not staged, normal person not a model, NOT editorial, NOT magazine',
    ', slightly overexposed daylight, phone camera, ordinary car or home, real person not a model, NOT cinematic, NOT golden hour',
  ];
  const realismSuffix = realismSuffixes[Math.min(slideIndex || 0, 5)];

  let finalPrompt = prompt + realismSuffix;

  if (hasLoRA && loraTrigger) {
    finalPrompt = `${loraTrigger}, ${finalPrompt}`;
  }

  const input = {
    prompt:               finalPrompt,
    negative_prompt:      RV_NEGATIVE,
    // CHANGE: named preset instead of custom dimensions — FLUX.2 handles this cleaner
    image_size:           'portrait_9_16',
    // CHANGE: 35 steps (was 28) — FLUX.2 Dev benefits from more steps for skin detail
    num_inference_steps:  35,
    // CHANGE: 3.5 guidance (was 1.8) — FLUX.2 optimal range is 3.5–4.5
    guidance_scale:       3.5,
    num_images:           1,
    output_format:        'jpeg',
    enable_safety_checker: false,
    loras:                [],
  };

  if (hasLoRA && loraPath) {
    input.loras.push({ path: loraPath, scale: 0.9 });
  }

  // CHANGE: endpoint is fal-ai/flux-2/lora (FLUX.2 Dev) instead of fal-ai/flux-lora (FLUX.1 Dev)
  return JSON.stringify({ endpoint: 'fal-ai/flux-2/lora', input });
}


// ── FUNCTION 2: generateSlide ─────────────────────────────────────────────────
// CHANGE: Pass 2 swapped from crystal-upscaler → fal-ai/flux-2-lora-gallery/realism
// The realism LoRA is trained specifically on skin texture and natural lighting —
// much more appropriate than a generic upscaler for UGC skincare content.
// Everything else (Pass 1, text overlay, error handling) is identical.

async function generateSlide(i, hook, arch, falKey, acc, charUrl, hasLoRA) {
  const cell = document.getElementById(`slide-cell-${i}`);
  cell.classList.add('generating');
  cell.innerHTML = `<div class="slide-n">${i + 1}</div><div class="spinner-wrap"><div class="spinner"></div><div style="font-size:9px;color:var(--muted);margin-top:6px;font-family:'DM Mono',monospace;">generating...</div></div>`;

  const variant   = styleVariants[i];
  const planEntry = slidePlan[i] || {
    type:       'selfie',
    scene:      'casual everyday home environment',
    skin_state: variant.style,
    text:       i === 0 ? hook : variant.label,
  };
  const { prompt: fullPrompt } = buildSlidePrompt(planEntry, variant.style, arch, hook, i);
  const isHumanShot = ['selfie','mirror','lifestyle','skin_close','face','skin','before_after','app','product'].includes(planEntry.type);

  setLog(`Slide ${i + 1}: ${planEntry.type} — ${(planEntry.scene || '').slice(0, 50)}...`);

  try {
    const falKey2    = getFalKey();
    const rvBodyStr  = buildRVBody(fullPrompt, isHumanShot ? charUrl : null, hasLoRA, acc?.loraPath, acc?.loraTrigger, i);
    const rvBodyParsed = JSON.parse(rvBodyStr);

    // ── PASS 1: FLUX.2 Dev LoRA ───────────────────────────────────────────
    setLog(`Slide ${i + 1} · Pass 1: FLUX.2 generating...`);
    const rvData = await callFal(rvBodyParsed.endpoint, rvBodyParsed.input, falKey);

    if (rvData.error || !rvData.images?.[0]) {
      const errMsg = rvData.error
        ? (typeof rvData.error === 'object' ? JSON.stringify(rvData.error) : rvData.error)
        : 'No image returned';
      setLog(`Slide ${i + 1} error: ${errMsg}`, 'err');
      cell.classList.remove('generating');
      cell.innerHTML = `<div class="slide-n">${i + 1}</div><div style="color:var(--error);font-size:10px;text-align:center;padding:8px;">${errMsg}</div>`;
      generatedImages[i] = null;
      return;
    }

    let currentUrl = rvData.images[0].url;
    setLog(`Slide ${i + 1} · Pass 1 done ✓`);

    // Show pass 1 result while pass 2 runs
    cell.innerHTML = `
      <div class="slide-n">${i + 1}</div>
      <img src="${currentUrl}" style="width:100%;height:100%;object-fit:cover;opacity:0.5;" />
      <div class="spinner-wrap" style="position:absolute;"><div class="spinner"></div></div>`;

    // ── PASS 2: FLUX.2 Realism LoRA ───────────────────────────────────────
    // CHANGE: was crystal-upscaler, now fal-ai/flux-2-lora-gallery/realism
    // Trained specifically on skin texture + natural lighting — far better than
    // a generic upscaler for UGC skincare portrait content.
    if (isHumanShot) {
      setLog(`Slide ${i + 1} · Pass 2: Realism enhancement...`);
      try {
        const realismData = await callFal('fal-ai/flux-2-lora-gallery/realism', {
          // Feed Pass 1 output as the reference image
          image_url:            currentUrl,
          // Keep the same prompt for coherent enhancement
          prompt:               fullPrompt,
          // Low strength — we want enhancement not regeneration
          // 0.3 = subtle skin texture improvement, preserves composition
          strength:             0.3,
          num_inference_steps:  20,
          guidance_scale:       3.5,
          output_format:        'jpeg',
          enable_safety_checker: false,
        }, falKey2);

        const realismUrl = realismData?.images?.[0]?.url;
        if (realismUrl) {
          currentUrl = realismUrl;
          setLog(`Slide ${i + 1} · Pass 2 done ✓`);
        } else {
          setLog(`Slide ${i + 1} · Pass 2 no result — using Pass 1`, '');
        }
      } catch (e2) {
        // Non-fatal — fall back to Pass 1 result
        setLog(`Slide ${i + 1} · Pass 2 failed: ${e2.message} — using Pass 1`, '');
      }
    }

    // ── Text overlay ──────────────────────────────────────────────────────
    const storyFallbacks = [
      hook,
      'I tried everything for years',
      'then I found this app',
      'week 2 — something finally shifted',
      'week 4 — I cannot believe the difference',
      'this is what my skin looks like now',
    ];
    const slideText = planEntry?.text || storyFallbacks[i] || '';
    const finalUrl  = await compositeTextOnImage(currentUrl, slideText, i, variant.label);

    generatedImages[i] = finalUrl;
    cell.classList.remove('generating');
    cell.innerHTML = `
      <div class="slide-n">${i + 1}</div>
      <img src="${finalUrl}" alt="slide ${i + 1}" style="width:100%;height:100%;object-fit:cover;" />
      <div class="style-tag">${variant.label}</div>`;

    setLog(`Slide ${i + 1} complete ✓`, 'ok');
    setProgress(
      Math.round((generatedImages.filter(Boolean).length / 6) * 100),
      `${generatedImages.filter(Boolean).length}/6 slides complete`
    );

  } catch (e) {
    setLog(`Slide ${i + 1} failed: ${e.message}`, 'err');
    cell.classList.remove('generating');
    cell.innerHTML = `<div class="slide-n">${i + 1}</div><div style="color:var(--error);font-size:10px;text-align:center;padding:8px;">Failed — try regenerating</div>`;
    generatedImages[i] = null;
  }
}


// ── Also update runCrystalUpscaler — keep the function but it's no longer called
// in the main generateSlide pipeline. It's still used in generateCharacter()
// for the account character photo, where a generic upscale is fine.
// No change needed there.


// ── SUMMARY ───────────────────────────────────────────────────────────────────
// 1. Find buildRVBody() in index.html → replace with version above
// 2. Find generateSlide() in index.html → replace with version above
// 3. No other changes needed — prompts, story planning, captions all unchanged
