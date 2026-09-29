/* ═══════════════ CONFIG ═══════════════ */
const API_KEY = "AQ.Ab8RN6L8t4JC4cJYjRJRpcavSZHCnjNrBwvcCRlNzHi27YlUSw"; // prototype only — replace & restrict this key
const BASE    = "https://generativelanguage.googleapis.com/v1beta";

const MODEL_PREFERENCE = [
  "gemini-3.1-flash-lite",
  "gemini-3-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash"
];
let ACTIVE_MODEL = "gemini-flash-lite-latest";

/* ═══════════════ STATE ═══════════════ */
let imageData = null;
let fullPreviewURL = null;
let cropHint  = "other";
let lastResult = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ═══════════════ STORAGE ABSTRACTION ═══════════════
   Uses window.storage when running inside a Claude artifact preview,
   falls back to localStorage everywhere else (own hosting, local file, etc). */
const hasClaudeStorage = typeof window !== 'undefined' && !!window.storage;

async function storageGet(key) {
  if (hasClaudeStorage) {
    try { const res = await window.storage.get(key); return res ? res.value : null; }
    catch { return null; }
  }
  try { return localStorage.getItem(key); } catch { return null; }
}

async function storageSet(key, value) {
  if (hasClaudeStorage) {
    try { await window.storage.set(key, value); return true; }
    catch (err) { console.error('Claude storage save failed:', err); return false; }
  }
  try { localStorage.setItem(key, value); return true; }
  catch (err) { console.error('localStorage save failed:', err); return false; }
}

async function storageDelete(key) {
  if (hasClaudeStorage) {
    try { await window.storage.delete(key); return true; } catch { return false; }
  }
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

/* ═══════════════ TOAST ═══════════════ */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ═══════════════ THEME ═══════════════ */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('pd_theme', t); // per-viewer convenience, plain localStorage is fine here
}
applyTheme(localStorage.getItem('pd_theme') || 'light');
$('themeBtn').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? '🌙 Dark mode on' : '☀️ Light mode on');
};

/* ═══════════════ MODEL RESOLUTION ═══════════════ */
async function resolveModel() {
  try {
    const res = await fetch(`${BASE}/models?key=${encodeURIComponent(API_KEY)}&pageSize=100`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const available = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    const chosen = MODEL_PREFERENCE.find(p => available.includes(p))
                || available.find(n => n.includes('flash-lite'))
                || available.find(n => n.includes('flash'))
                || ACTIVE_MODEL;
    ACTIVE_MODEL = chosen;
  } catch { /* keep default alias */ }
  $('modelName').textContent = ACTIVE_MODEL;
  $('modelDot').classList.add('live');
}
resolveModel();

/* ═══════════════ EXPERT PROMPT ═══════════════ */
const SYSTEM_PROMPT = `You are "Plant Doctor AI" — a senior plant pathologist and agricultural extension specialist with 20+ years of experience diagnosing crop diseases from field photographs.

TASK: Analyze the attached plant image and return a diagnosis as JSON conforming EXACTLY to the given schema.

DIAGNOSTIC PROCEDURE (follow in order):
1. IMAGE CHECK: Confirm this is a photo of a plant. If it is not a plant, is a drawing/illustration, or is too blurry/poorly lit to assess, set health_status to "uncertain" and explain why in summary.
2. IDENTIFICATION: Identify the plant to species level (common name + scientific name). If a crop hint is provided below, treat it as the grower's claim — verify it against visible features rather than blindly trusting it. If the hint says AUTO-DETECT, identify the plant purely from its visible features with no assumptions.
3. EXAMINATION: Systematically look for: leaf spots (color, shape, margin, concentric rings, yellow halo), powdery or rusty coatings, chlorosis patterns, necrosis, wilting, stem lesions, rot, insect damage, and viral mosaic patterns.
4. DIAGNOSIS: Name the single most likely cause and classify it (fungal, bacterial, viral, oomycete, pest damage, or nutrient/environmental disorder). Also give the best alternative diagnosis you considered. Use the crop hint (if any) to narrow down diseases common to that crop.
5. SEVERITY: Score 0-100 based on estimated percentage of affected tissue and how established the infection appears: 0 = healthy, 1-25 = mild/early stage, 26-60 = moderate/spreading, 61-100 = severe/advanced. Set severity_label to exactly one of: "none", "mild", "moderate", "severe". Briefly describe the risk of it spreading to nearby plants in spread_risk.
6. TREATMENT: Give specific, actionable steps. List organic/biological options first (e.g. neem oil, copper soap, removing infected tissue, watering practices), then chemical options naming typical active ingredients (e.g. chlorothalonil, mancozeb) with generic application guidance. If healthy, lists may be empty.
7. PREVENTION: Provide 2-4 concise preventive measures for the coming weeks.

RULES:
- Be honest and conservative. Never invent a disease to satisfy the user. "No disease detected" is a valid, preferred result when the plant looks healthy.
- If uncertain, lower confidence_percent and say precisely what a better photo would need (close-up of lesions, lighting, both leaf sides).
- confidence_percent (0-100) reflects your overall confidence in the identification + diagnosis.
- All strings must be plain text. No markdown, no asterisks.`;

const CROP_LABELS = {
  chilli:       "CHILLI PEPPER (Capsicum annuum / frutescens)",
  potato:       "POTATO (Solanum tuberosum)",
  tomato:       "TOMATO (Solanum lycopersicum)",
  "bell pepper":"BELL PEPPER / SWEET PEPPER (Capsicum annuum)"
};

function buildUserText() {
  if (cropHint === "other" || !cropHint) {
    return SYSTEM_PROMPT + "\n\nCROP HINT: AUTO-DETECT — the grower does not know the plant type. Identify the species yourself from visible features only, then diagnose it.";
  }
  return SYSTEM_PROMPT +
    `\n\nCROP HINT: The grower indicates the plant is likely: ${CROP_LABELS[cropHint]}. Verify this independently against the image — if the plant is clearly something else, identify the true plant and say so in the summary. Consider common diseases of ${cropHint} when forming your differential diagnosis.`;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    plant_common_name:    { type: "STRING" },
    plant_scientific_name:{ type: "STRING" },
    health_status:        { type: "STRING", description: "Exactly one of: healthy, diseased, uncertain" },
    disease_name:         { type: "STRING", description: "Disease name, or 'None' if healthy" },
    disease_type:         { type: "STRING", description: "fungal / bacterial / viral / oomycete / pest / nutrient-environmental / none" },
    alternative_diagnosis:{ type: "STRING" },
    confidence_percent:   { type: "NUMBER" },
    severity_score:       { type: "NUMBER", description: "0-100" },
    severity_label:       { type: "STRING", description: "Exactly one of: none, mild, moderate, severe" },
    symptoms:             { type: "ARRAY", items: { type: "STRING" } },
    spread_risk:          { type: "STRING" },
    treatments_organic:   { type: "ARRAY", items: { type: "STRING" } },
    treatments_chemical:  { type: "ARRAY", items: { type: "STRING" } },
    prevention:           { type: "ARRAY", items: { type: "STRING" } },
    summary:              { type: "STRING", description: "2-3 sentence plain-language verdict for the grower" }
  },
  required: ["plant_common_name","health_status","disease_name","disease_type","confidence_percent",
             "severity_score","severity_label","symptoms","spread_risk","treatments_organic",
             "treatments_chemical","prevention","summary"]
};

/* ═══════════════ IMAGE HANDLING (file, camera, drag-drop, paste) ═══════════════ */
function downscale(dataURL, maxW, quality, cb) {
  const img = new Image();
  img.onload = () => {
    const s = Math.min(1, maxW / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    cb(c.toDataURL('image/jpeg', quality));
  };
  img.src = dataURL;
}

function setImage(dataURL, mimeType) {
  imageData = { mimeType: mimeType || 'image/jpeg', data: dataURL.split(',')[1] };
  fullPreviewURL = dataURL;
  $('previewBox').innerHTML = `<img src="${dataURL}"><button class="clear-img" id="clearImg">✕ Remove</button>`;
  $('clearImg').onclick = clearImage;
  $('diagnoseBtn').disabled = false;
  toast('🖼️ Image ready — press Diagnose Plant');
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('⚠️ Please choose an image file'); return; }
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result, file.type);
  reader.readAsDataURL(file);
}

function clearImage() {
  imageData = null; fullPreviewURL = null;
  $('previewBox').innerHTML = `<div class="ph-icon">🍃</div><div>No image uploaded yet</div>`;
  $('diagnoseBtn').disabled = true;
}

/* The dropzone now ONLY contains static text/icon — no buttons live inside it,
   so its own click handler and the browse/camera buttons can never collide. */
const dz = $('dropzone');
dz.onclick = () => $('fileInput').click();
dz.ondragover  = e => { e.preventDefault(); dz.classList.add('drag'); };
dz.ondragleave = () => dz.classList.remove('drag');
dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); };

/* Browse and camera buttons sit outside the dropzone, each firing its own
   hidden input directly — clicks can no longer be swallowed or re-routed. */
$('browseBtn').onclick = () => $('fileInput').click();
$('cameraBtn').onclick = () => {
  try {
    $('cameraInput').click();
  } catch (err) {
    toast('⚠️ Camera not available — opening file picker instead');
    $('fileInput').click();
  }
};
$('fileInput').onchange   = () => loadFile($('fileInput').files[0]);
$('cameraInput').onchange = () => loadFile($('cameraInput').files[0]);

document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

/* ═══════════════ CROP CHIPS ═══════════════ */
document.querySelectorAll('.chip').forEach(chip => {
  chip.onclick = () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    cropHint = chip.dataset.crop;
    toast(cropHint === 'other' ? '🔍 Auto-detect mode — species will be identified from the photo'
                               : `🎯 Crop hint set: ${chip.textContent.trim()}`);
  };
});

/* ═══════════════ HISTORY ═══════════════ */
async function getHistory() {
  try {
    const raw = await storageGet('pd_history');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveHistory(h) {
  await storageSet('pd_history', JSON.stringify(h));
}

async function renderHistory() {
  const h = await getHistory();
  const row = $('historyRow');
  if (!h.length) { row.innerHTML = `<div class="empty-hist">No scans yet — your last 8 diagnoses will appear here.</div>`; return; }
  row.innerHTML = '';
  h.forEach((item) => {
    const tag = item.result.health_status === 'healthy' ? ['tag-healthy','✔ Healthy']
              : item.result.health_status === 'diseased' ? ['tag-diseased','🦠 Diseased']
              : ['tag-uncertain','? Uncertain'];
    const card = document.createElement('div');
    card.className = 'hist-card';
    card.innerHTML = `<img src="${item.preview}"><div class="hc-name">${esc(item.result.plant_common_name || 'Plant')}</div>
      <div class="hc-tag ${tag[0]}">${tag[1]} · ${esc(item.result.severity_label || '')}</div>`;
    card.onclick = () => {
      lastResult = item.result;
      setImage(item.preview, 'image/jpeg');
      render(item.result);
      if (window.innerWidth < 980) $('result').scrollIntoView({ behavior:'smooth' });
      toast('📂 Loaded scan from history');
    };
    row.appendChild(card);
  });
}

$('clearHist').onclick = async () => {
  await storageDelete('pd_history');
  await renderHistory();
  toast('🗑️ History cleared');
};

renderHistory();

/* ═══════════════ DIAGNOSE ═══════════════ */
$('diagnoseBtn').onclick = diagnose;

async function diagnose() {
  if (!imageData) return;
  const out = $('result');
  $('diagnoseBtn').disabled = true;
  out.innerHTML = `<div class="loading"><div class="spinner"></div>Analyzing leaf… consulting plant pathology AI</div>`;

  try {
    const res = await fetch(`${BASE}/models/${ACTIVE_MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [ { text: buildUserText() }, { inlineData: imageData } ] }],
        generationConfig: {
          temperature: 0.2, maxOutputTokens: 8192,
          responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA
        }
      })
    });

    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
    if (!raw) throw new Error('Empty response. ' + (data.promptFeedback?.blockReason || ''));
    const parsed = JSON.parse(raw);
    lastResult = parsed;

    if (parsed.health_status === "uncertain") {
      $('result').innerHTML = `<div class="error-box fade-in" style="color: #dc2626; font-weight: bold;">❌ Invalid plant picture! Please upload a valid plant photo.</div>`;
      return;
    }

    await new Promise(resolve => {
      downscale(fullPreviewURL, 320, 0.72, async small => {
        const h = await getHistory();
        h.unshift({ t: Date.now(), crop: cropHint, preview: small, result: parsed });
        await saveHistory(h.slice(0, 8));
        await renderHistory();
        resolve();
      });
    });

    render(parsed);

  } catch (e) {
    out.innerHTML = `<div class="error-box fade-in"><b>Error: Invalid picture</b> ${esc(e.message)}</div>`;
  } finally {
    $('diagnoseBtn').disabled = false;
  }
}

/* ═══════════════ REPORT (copy / download) ═══════════════ */
function buildReport(d) {
  const L = (t, arr) => `\n${t}\n${(arr||[]).map(x=>`  • ${x}`).join('\n') || '  • None'}`;
  return `PLANT DOCTOR — DIAGNOSIS REPORT
${'='.repeat(40)}
Plant: ${d.plant_common_name} (${d.plant_scientific_name || 'n/a'})
Status: ${d.health_status.toUpperCase()} | Confidence: ${d.confidence_percent}%
Diagnosis: ${d.disease_name} [${d.disease_type}]
Alternative considered: ${d.alternative_diagnosis || '-'}
Severity: ${d.severity_label.toUpperCase()} (${d.severity_score}/100)
Spread risk: ${d.spread_risk || '-'}
Summary: ${d.summary}
${L('SYMPTOMS', d.symptoms)}${L('ORGANIC / CULTURAL TREATMENT', d.treatments_organic)}
${L('CHEMICAL TREATMENT', d.treatments_chemical)}${L('PREVENTION', d.prevention)}
Generated: ${new Date().toLocaleString()}`;
}

/* ═══════════════ RENDER ═══════════════ */
const SEV = {
  none:     { color:'#16a34a', label:'Healthy' },
  mild:     { color:'#eab308', label:'Mild' },
  moderate: { color:'#f97316', label:'Moderate' },
  severe:   { color:'#dc2626', label:'Severe' }
};

function countUp(el, target, suffix) {
  let cur = 0;
  const step = Math.max(1, Math.round(target / 28));
  const t = setInterval(() => {
    cur += step; if (cur >= target) { cur = target; clearInterval(t); }
    el.textContent = cur + suffix;
  }, 24);
}

function render(d) {
  const status = (d.health_status || 'uncertain').toLowerCase();
  const sev = SEV[(d.severity_label || 'none').toLowerCase()] || SEV.none;
  const score = Math.max(0, Math.min(100, Number(d.severity_score) || 0));
  const conf = Math.max(0, Math.min(100, Number(d.confidence_percent) || 0));

  const banners = {
    healthy:   ['✅ HEALTHY PLANT', 'healthy', '#16a34a'],
    diseased:  ['🦠 DISEASE DETECTED', 'diseased', '#dc2626'],
    uncertain: ['❓ INCONCLUSIVE IMAGE', 'uncertain', '#d97706']
  };
  const [bText, bClass, bColor] = banners[status] || banners.uncertain;

  const list = arr => (arr && arr.length)
    ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
    : `<ul><li>None needed at this time.</li></ul>`;

  $('result').innerHTML = `
    <div class="fade-in">
      <div class="banner ${bClass}">
        <div class="banner-flags">
          <span>${bText}</span>
          <div class="conf-ring" data-v="0" style="color:${bColor}" title="Model confidence"></div>
        </div>
      </div>

      <div class="res-grid">
        <div class="res-item"><div class="k">🌿 Plant Identified</div>
          <div class="v">${esc(d.plant_common_name)} <small>${esc(d.plant_scientific_name || '')}</small></div></div>
        <div class="res-item"><div class="k">🦠 Diagnosis</div>
          <div class="v">${esc(d.disease_name || 'None')} <small>(${esc(d.disease_type || 'n/a')})</small></div></div>
      </div>

      <div class="sev-wrap">
        <div class="sev-head">
          <span><b>Infection Severity</b></span>
          <span style="color:${sev.color};font-weight:800;"><span id="sevNum">0</span>/100 — ${sev.label.toUpperCase()}</span>
        </div>
        <div class="sev-bar"><div class="sev-fill" id="sevFill" style="--sc:${sev.color}"></div></div>
      </div>

      ${status === 'uncertain' ? '' : `<div class="res-grid">
        <div class="res-item"><div class="k">⚠️ Spread Risk</div><div class="v small-v">${esc(d.spread_risk || '—')}</div></div>
        <div class="res-item"><div class="k">🔁 Also Considered</div><div class="v small-v">${esc(d.alternative_diagnosis || '—')}</div></div>
      </div>`}

      <div class="summary"><b>Summary:</b> ${esc(d.summary)}</div>

      <div class="section"><h4>🔍 Symptoms Observed</h4>${list(d.symptoms)}</div>
      ${status !== 'healthy' ? `
      <div class="section"><h4>🌿 Treatment — Organic / Cultural</h4>${list(d.treatments_organic)}</div>
      <div class="section"><h4>🧪 Treatment — Chemical Options</h4>${list(d.treatments_chemical)}</div>` : ''}
      <div class="section"><h4>🛡️ Prevention</h4>${list(d.prevention)}</div>

      <div class="report-actions">
        <button class="mini-btn" id="copyBtn">📋 Copy Report</button>
        <button class="mini-btn" id="dlBtn">⬇️ Download .txt</button>
      </div>
    </div>`;

  requestAnimationFrame(() => { $('sevFill').style.width = score + '%'; });
  countUp($('sevNum'), score, '');
  const ring = $('result').querySelector('.conf-ring');
  let p = 0;
  const rt = setInterval(() => {
    p = Math.min(conf, p + 3);
    ring.style.setProperty('--p', p);
    ring.setAttribute('data-v', p);
    if (p >= conf) clearInterval(rt);
  }, 22);

  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(buildReport(d)); toast('📋 Report copied to clipboard'); }
    catch { toast('⚠️ Copy failed — use Download instead'); }
  };
  $('dlBtn').onclick = () => {
    const blob = new Blob([buildReport(d)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `plant-report-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('⬇️ Report downloaded');
  };

  if (window.innerWidth >= 980) $('result').scrollIntoView({ behavior:'smooth', block:'nearest' });
}