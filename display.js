import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import { getFirestore, doc, onSnapshot, collection, query, where } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const db = getFirestore(initializeApp(firebaseConfig));
const sessionId = new URLSearchParams(location.search).get('s') || 'processo-ai-2026';
const ref = doc(db,'sessions',sessionId);
const question = document.getElementById('displayQuestion');
const message = document.getElementById('displayMessage');
const results = document.getElementById('displayResults');
let lastRound = null;
let unsubCloud = null;
let cloudRound = null;

onSnapshot(ref, snap => {
  if (!snap.exists()) {
    setMode('holding');
    question.textContent = 'Sessione non configurata';
    message.textContent = 'Controlla il codice della sessione.';
    results.innerHTML = '';
    return;
  }
  const d = snap.data();
  lastRound = d.roundId;
  question.textContent = d.question || 'Interazione';

  if (d.type === 'wordcloud') {
    if (!d.showResults) {
      stopCloud();
      setMode('holding');
      showHolding(d);
      return;
    }
    setMode('cloud-mode');
    subscribeCloud(d.roundId);
    return;
  }

  stopCloud();
  if (!d.showResults) {
    setMode('holding');
    showHolding(d);
    return;
  }
  setMode('show-results');
  renderChoice(d);
});

function setMode(mode) {
  document.body.classList.remove('holding','show-results','cloud-mode');
  document.body.classList.add(mode);
}

function showHolding(d) {
  results.innerHTML = '';
  if (d.isOpen) message.innerHTML = '<span class="live-dot"></span> Votazione in corso';
  else message.textContent = 'Votazione conclusa. Il responso sarà rivelato tra poco.';
}

function renderChoice(d) {
  const counts = d.counts || [];
  const opts = d.options || [];
  const total = counts.reduce((a,b)=>a+b,0);
  const max = Math.max(0,...counts);
  message.innerHTML = `<strong class="voter-total">${total}</strong> votanti`;
  results.innerHTML = opts.map((o,i) => {
    const n = counts[i] || 0;
    const p = total ? Math.round(n*100/total) : 0;
    const winner = total > 0 && n === max;
    return `<div class="verdict-row${winner?' winner':''}">
      <div class="verdict-top">
        <div class="verdict-label">${esc(o)}</div>
        <div class="verdict-number"><strong>${p}%</strong><span>${n} ${n===1?'voto':'voti'}</span></div>
      </div>
      <div class="verdict-bar"><i data-width="${p}"></i></div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('.verdict-bar i').forEach(el => el.style.width = `${el.dataset.width}%`);
  }));
}

function stopCloud() {
  if (unsubCloud) unsubCloud();
  unsubCloud = null;
  cloudRound = null;
}

function wordsFromDoc(data) {
  if (Array.isArray(data.texts)) return data.texts.map(x=>String(x||'').trim()).filter(Boolean);
  const one = String(data.text || '').trim();
  return one ? [one] : [];
}

// Raggruppa anche varianti come "Curiosità", "curiosita" e spazi/punteggiatura finali.
function canonicalWord(raw) {
  const label = String(raw || '')
    .normalize('NFC')
    .replace(/^[\s"'“”‘’.,;:!?()\[\]{}]+|[\s"'“”‘’.,;:!?()\[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const key = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it');
  return { label, key };
}

function subscribeCloud(roundId) {
  if (!roundId) return;
  if (cloudRound === roundId && unsubCloud) return;
  stopCloud();
  cloudRound = roundId;
  const qq = query(collection(db,'responses'),where('sessionId','==',sessionId),where('roundId','==',roundId));
  unsubCloud = onSnapshot(qq, snap => {
    if (roundId !== lastRound) return;
    const freq = {};
    let wordTotal = 0;
    snap.docs.forEach(x => {
      wordsFromDoc(x.data()).forEach(raw => {
        const {label,key} = canonicalWord(raw);
        if (!key) return;
        wordTotal++;
        if (!freq[key]) freq[key] = {label,count:0};
        // Preferisce la grafia accentata se compare almeno una volta.
        if (/[^\x00-\x7F]/.test(label)) freq[key].label = label;
        freq[key].count++;
      });
    });
    const arr = Object.values(freq).sort((a,b)=>b.count-a.count || a.label.localeCompare(b.label,'it'));
    const participants = snap.size;
    message.innerHTML = `<strong class="voter-total">${participants}</strong> ${participants===1?'partecipante':'partecipanti'} · <strong>${wordTotal}</strong> ${wordTotal===1?'parola':'parole'}`;
    if (!arr.length) {
      results.innerHTML = '<div class="cloud-empty">In attesa delle prime parole…</div>';
      return;
    }
    renderCloud(arr);
  });
}

function renderCloud(arr) {
  results.innerHTML = '<div class="display-cloud diamond-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  // Aspetta un frame: in questo modo il contenitore ha già le dimensioni reali.
  requestAnimationFrame(() => {
    const rect = cloud.getBoundingClientRect();
    const W = Math.max(320, rect.width);
    const H = Math.max(220, rect.height);
    const cx = W / 2;
    const cy = H / 2;
    const maxCount = Math.max(...arr.map(x => x.count));
    const base = Math.min(W, H);

    // Misura il testo senza dipendere dall'offsetWidth degli elementi ancora nascosti.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily || 'Arial, sans-serif';

    const source = arr.slice(0, 90).map((x, i) => {
      const ratio = Math.max(.01, x.count / maxCount);
      const score = Math.pow(ratio, .70);
      const minPx = Math.max(15, base * .027);
      const maxPx = Math.max(72, Math.min(150, base * .215));
      let size = minPx + (maxPx - minPx) * score;
      if (i > 24) size *= .90;
      if (i > 48) size *= .86;
      const rotate = i >= 9 && i % 9 === 7 && x.label.length <= 11;
      return {x, i, size, rotate};
    });

    const pad = Math.max(5, base * .008);
    const safeX = Math.max(14, W * .018);
    const safeY = Math.max(12, H * .025);
    const usableHalfW = W/2 - safeX;
    const usableHalfH = H/2 - safeY;

    function measure(label, fontPx, rotate) {
      ctx.font = `900 ${fontPx}px ${fontFamily}`;
      const m = ctx.measureText(label);
      const rawW = Math.max(1, m.width);
      const rawH = fontPx * .92;
      return rotate ? {w: rawH, h: rawW, rawW, rawH} : {w: rawW, h: rawH, rawW, rawH};
    }

    function overlaps(a, b) {
      return !(a.r + pad <= b.l || a.l >= b.r + pad || a.b + pad <= b.t || a.t >= b.b + pad);
    }

    function inside(box) {
      if (box.l < safeX || box.r > W-safeX || box.t < safeY || box.b > H-safeY) return false;
      // Losanga morbida: controlla i quattro vertici dell'ingombro.
      const pts = [[box.l,box.t],[box.r,box.t],[box.l,box.b],[box.r,box.b]];
      return pts.every(([x,y]) => Math.abs(x-cx)/usableHalfW + Math.abs(y-cy)/usableHalfH <= 1.08);
    }

    // Tenta l'intera nuvola a scale progressivamente minori finché TUTTE le parole entrano.
    let finalPlaced = null;
    for (let globalScale = 1; globalScale >= .30 && !finalPlaced; globalScale -= .045) {
      const placed = [];
      let failed = false;

      for (let idx=0; idx<source.length; idx++) {
        const item = source[idx];
        const fontPx = Math.max(13, item.size * globalScale);
        const m = measure(item.x.label, fontPx, item.rotate);
        let found = null;

        // Prima parola esattamente al centro; le successive percorrono una spirale.
        const maxSteps = idx === 0 ? 1 : 7000;
        for (let k=0; k<maxSteps; k++) {
          let x, y;
          if (idx === 0) {
            x = cx; y = cy;
          } else {
            const angle = k * 0.31 + idx * 0.83;
            const radius = 2.2 * Math.sqrt(k) * (1 + Math.min(idx,20)*.012);
            // La spirale è leggermente più larga in orizzontale, poi la losanga la rifinisce.
            x = cx + Math.cos(angle) * radius * 1.28;
            y = cy + Math.sin(angle) * radius;
          }
          const box = {l:x-m.w/2, r:x+m.w/2, t:y-m.h/2, b:y+m.h/2};
          if (!inside(box)) continue;
          if (placed.some(p => overlaps(box,p.box))) continue;
          found = {item, fontPx, m, x, y, box};
          break;
        }

        if (!found) { failed = true; break; }
        placed.push(found);
      }

      if (!failed && placed.length === source.length) finalPlaced = placed;
    }

    // Fallback estremo: non elimina mai parole. Se necessario usa una disposizione a righe centrata.
    if (!finalPlaced) {
      finalPlaced = [];
      const fontPx = Math.max(12, base * .026);
      let y = cy - ((source.length-1) * fontPx * .62);
      source.forEach(item => {
        const m = measure(item.x.label, fontPx, false);
        const x = cx;
        finalPlaced.push({item:{...item, rotate:false}, fontPx, m, x, y,
          box:{l:x-m.w/2,r:x+m.w/2,t:y-m.h/2,b:y+m.h/2}});
        y += fontPx * 1.25;
      });
    }

    // Ricentra l'ingombro REALE della nuvola nel contenitore.
    const minL = Math.min(...finalPlaced.map(p=>p.box.l));
    const maxR = Math.max(...finalPlaced.map(p=>p.box.r));
    const minT = Math.min(...finalPlaced.map(p=>p.box.t));
    const maxB = Math.max(...finalPlaced.map(p=>p.box.b));
    const shiftX = cx - (minL + maxR)/2;
    const shiftY = cy - (minT + maxB)/2;

    cloud.innerHTML = '';
    finalPlaced.forEach((p, n) => {
      const el = document.createElement('span');
      el.className = `display-cloud-word rank-${Math.min(p.item.i,7)}` + (p.item.rotate ? ' vertical' : '');
      el.textContent = p.item.x.label;
      el.title = `${p.item.x.count}`;
      el.style.position = 'absolute';
      el.style.fontSize = `${p.fontPx}px`;
      el.style.left = `${p.x + shiftX - p.m.rawW/2}px`;
      el.style.top = `${p.y + shiftY - p.m.rawH/2}px`;
      el.style.animationDelay = `${Math.min(n*18,300)}ms`;
      cloud.appendChild(el);
    });
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
