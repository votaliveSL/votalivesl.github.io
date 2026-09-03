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
  results.innerHTML = '<div class="display-cloud diamond-cloud packed-cloud organic-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rect = cloud.getBoundingClientRect();
    const W = Math.max(320, rect.width);
    const H = Math.max(220, rect.height);
    const n = arr.length;
    const maxCount = Math.max(...arr.map(x => x.count));
    const minCount = Math.min(...arr.map(x => x.count));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily || 'Arial, sans-serif';

    // Più righe per ottenere un profilo romboide irregolare, senza perdere parole.
    let rowCount = Math.max(5, Math.min(13, Math.round(Math.sqrt(n) * 1.65)));
    if (rowCount % 2 === 0) rowCount++;
    const center = Math.floor(rowCount / 2);

    // Profilo: stretto sopra/sotto, largo al centro. Una piccola irregolarità
    // deterministica evita l'effetto ovale/tabellare.
    const rowTargets = Array.from({length: rowCount}, (_, r) => {
      const d = center ? Math.abs(r-center)/center : 0;
      const diamond = 0.34 + 0.62 * Math.pow(1-d, 0.82);
      const wobble = [0.96,1.03,0.99,1.04,0.97][r % 5];
      return W * diamond * wobble;
    });

    const rowPriority = [center];
    for (let d=1; d<=center; d++) {
      // Alternanza sopra/sotto per rendere il profilo meno simmetrico.
      if (d % 2) {
        if (center-d >= 0) rowPriority.push(center-d);
        if (center+d < rowCount) rowPriority.push(center+d);
      } else {
        if (center+d < rowCount) rowPriority.push(center+d);
        if (center-d >= 0) rowPriority.push(center-d);
      }
    }

    const baseMax = Math.min(88, Math.max(55, W * 0.056), H * 0.15);
    const baseMin = Math.max(20, Math.min(32, baseMax * 0.38));
    const gapX = Math.max(4, Math.min(12, W * 0.005));
    const gapY = Math.max(2, Math.min(6, H * 0.006));
    // Frazione di sovrapposizione verticale tra righe adiacenti (effetto più "compatto").
    const overlapFactor = 0.16;

    function hashOf(label) {
      let hash = 0;
      const key = canonicalWord(label).key;
      for (let i=0; i<key.length; i++) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0;
      return hash;
    }

    function weightFor(x) {
      if (maxCount === minCount) return 0.70;
      const ratio = (x.count-minCount)/(maxCount-minCount);
      return 0.18 + 0.82 * Math.pow(ratio, 0.64);
    }

    function isVertical(item) {
      // Circa 22% dei termini, soltanto piccoli/medi e preferibilmente brevi.
      // Scelta deterministica: non cambia mentre arrivano nuove risposte.
      if (n < 8 || item.weight > 0.68 || item.label.length > 15) return false;
      return (hashOf(item.label) % 100) < 22;
    }

    // Piccola inclinazione deterministica per le parole orizzontali, per rompere
    // l'effetto "a righe" senza compromettere la leggibilità.
    function tiltFor(item) {
      if (item.weight > 0.55) return 0; // le parole grandi restano dritte
      return ((hashOf(item.label) % 9) - 4) * 0.9; // circa -3.6°..+3.6°
    }

    // Sovrapposizione (in px) tra due righe adiacenti, in base alla più
    // piccola delle due altezze. Capata per restare leggibile.
    function rowOverlap(hA, hB) {
      const h = Math.min(hA, hB);
      return Math.min(h * overlapFactor, h * 0.30);
    }

    function tryLayout(scale) {
      const items = arr.map((x, idx) => {
        const weight = weightFor(x);
        const size = (baseMin + (baseMax-baseMin)*weight) * scale;
        const fw = idx < 3 ? 900 : 850;
        ctx.font = `${fw} ${size}px ${fontFamily}`;
        const textW = ctx.measureText(x.label).width + size*0.10;
        const vertical = isVertical({...x, weight});
        // Per una parola ruotata l'ingombro orizzontale è circa la sua altezza.
        const width = vertical ? size * 1.03 : textW;
        const height = vertical ? textW : size * 0.94;
        return {...x, idx, weight, size, fw, textW, width, height, vertical};
      });

      const rows = Array.from({length: rowCount}, () => []);
      const used = Array(rowCount).fill(0);

      for (const item of items) {
        const candidates = rowPriority
          .filter(r => used[r] + (rows[r].length ? gapX : 0) + item.width <= rowTargets[r])
          .sort((a,b) => {
            const ca = Math.abs(a-center), cb = Math.abs(b-center);
            if (ca !== cb) return ca-cb;
            return (used[a]/rowTargets[a])-(used[b]/rowTargets[b]);
          });
        if (!candidates.length) return null;
        const r = candidates[0];
        rows[r].push(item);
        used[r] += (rows[r].length > 1 ? gapX : 0) + item.width;
      }

      const heights = rows.map(row => row.length ? Math.max(...row.map(x=>x.height)) : 0);
      const activeHeights = rows.map((row,r)=>heights[r]).filter((h,r)=>rows[r].length);
      let totalH = activeHeights.length ? activeHeights[0] : 0;
      for (let i=1; i<activeHeights.length; i++) {
        totalH += gapY + activeHeights[i] - rowOverlap(activeHeights[i-1], activeHeights[i]);
      }
      if (totalH > H * 0.94) return null;
      return {rows, heights, totalH};
    }

    let scale = 1;
    let layout = tryLayout(scale);
    while (!layout && scale > 0.30) {
      scale -= scale > 0.55 ? 0.035 : 0.025;
      layout = tryLayout(scale);
    }

    if (!layout) {
      // Fallback sicuro: tutte le parole, mai tagliate o eliminate.
      cloud.classList.add('packed-cloud-fallback');
      cloud.innerHTML = arr.map((x,i) =>
        `<span class="packed-word color-${i%7}" style="font-size:clamp(15px,1.35vw,25px)">${esc(x.label)}</span>`
      ).join('');
      return;
    }

    const active = layout.rows.map((row,r)=>({row,r})).filter(x=>x.row.length);
    cloud.innerHTML = active.map(({row,r},i) => {
      const dist = Math.abs(r-center);
      const staggerPattern = [0, -18, 11, -8, 16, -12, 7];
      const stagger = staggerPattern[r % staggerPattern.length] * Math.min(1, W/1500);
      const marginTop = i === 0 ? 0 : gapY - rowOverlap(layout.heights[active[i-1].r], layout.heights[r]);
      const words = row.map((x,j) => {
        const lift = x.vertical ? 0 : (((x.idx * 7 + j * 3) % 5 - 2) * Math.min(2.0, x.size*0.022));
        const tilt = x.vertical ? 0 : tiltFor(x);
        const cls = `display-cloud-word packed-word color-${x.idx%7}${x.vertical?' word-vertical':''}`;
        const transform = x.vertical ? 'rotate(-90deg)' : `translateY(${lift.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg)`;
        return `<span class="${cls}" title="${x.count}" style="font-size:${x.size.toFixed(1)}px;font-weight:${x.fw};transform:${transform}">${esc(x.label)}</span>`;
      }).join('');
      return `<div class="packed-row packed-row-${dist}" style="max-width:${rowTargets[r].toFixed(0)}px;margin-top:${marginTop.toFixed(1)}px;transform:translateX(${stagger.toFixed(1)}px)">${words}</div>`;
    }).join('');
  }));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
