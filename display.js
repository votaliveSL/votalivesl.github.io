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
  results.innerHTML = '<div class="display-cloud packed-cloud organic-cloud cloud-v793" id="displayCloud"></div>';
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

    // Profilo volutamente più "a nuvola/rombo": punte strette e corpo centrale largo.
    let rowCount = n >= 24 ? 9 : (n >= 14 ? 7 : 5);
    if (H < 420 && rowCount > 7) rowCount = 7;
    const center = Math.floor(rowCount / 2);

    const profiles = {
      5: [0.40, 0.72, 0.98, 0.75, 0.43],
      7: [0.29, 0.50, 0.77, 0.99, 0.82, 0.54, 0.32],
      9: [0.23, 0.39, 0.59, 0.81, 0.99, 0.84, 0.63, 0.43, 0.25]
    };
    const wobble = [0.96, 1.03, 0.98, 1.02, 1.00, 0.97, 1.04, 0.98, 1.01];
    const rowTargets = profiles[rowCount].map((p,r) => W * p * wobble[r]);

    // Distribuzione dal centro verso l'esterno, ma non sempre nello stesso verso:
    // evita l'effetto "righe perfette".
    const rowPriority = [center];
    for (let d=1; d<=center; d++) {
      if (d % 2) {
        if (center-d >= 0) rowPriority.push(center-d);
        if (center+d < rowCount) rowPriority.push(center+d);
      } else {
        if (center+d < rowCount) rowPriority.push(center+d);
        if (center-d >= 0) rowPriority.push(center-d);
      }
    }

    const baseMax = Math.min(86, Math.max(54, W * 0.052), H * 0.145);
    const baseMin = Math.max(19, Math.min(30, baseMax * 0.36));
    const gapX = Math.max(8, Math.min(18, W * 0.008));
    const gapY = Math.max(3, Math.min(9, H * 0.012));

    function weightFor(x) {
      if (maxCount === minCount) return 0.70;
      const ratio = (x.count-minCount)/(maxCount-minCount);
      return 0.16 + 0.84 * Math.pow(ratio, 0.62);
    }

    // Sceglie davvero alcune parole verticali (non "forse").
    // Mai le 5 più frequenti; preferisce termini brevi e medio-piccoli.
    const eligible = arr
      .map((x,idx)=>({x,idx,weight:weightFor(x)}))
      .filter(o => o.idx >= 5 && o.x.label.length <= 12 && o.weight <= 0.58);

    const verticalWanted = n >= 24 ? 4 : (n >= 14 ? 3 : (n >= 8 ? 2 : 0));
    const verticalIndexes = new Set(
      eligible
        .sort((a,b) => {
          // stabile ma irregolare
          const ha = canonicalWord(a.x.label).key.split('').reduce((s,c)=>((s*33)+c.charCodeAt(0))>>>0,5381);
          const hb = canonicalWord(b.x.label).key.split('').reduce((s,c)=>((s*33)+c.charCodeAt(0))>>>0,5381);
          return (ha % 997) - (hb % 997);
        })
        .slice(0, verticalWanted)
        .map(o => o.idx)
    );

    function tryLayout(scale) {
      const items = arr.map((x, idx) => {
        const weight = weightFor(x);
        const size = (baseMin + (baseMax-baseMin)*weight) * scale;
        const fw = idx < 4 ? 900 : 850;
        ctx.font = `${fw} ${size}px ${fontFamily}`;
        const textW = ctx.measureText(x.label).width + size*0.10;
        const vertical = verticalIndexes.has(idx);
        // writing-mode verticale partecipa davvero al layout: niente sovrapposizioni.
        const width = vertical ? size * 1.02 : textW;
        const height = vertical ? textW : size * 0.94;
        return {...x, idx, weight, size, fw, textW, width, height, vertical};
      });

      const rows = Array.from({length: rowCount}, () => []);
      const used = Array(rowCount).fill(0);

      for (const item of items) {
        let candidates = rowPriority.filter(r =>
          used[r] + (rows[r].length ? gapX : 0) + item.width <= rowTargets[r]
        );

        if (!candidates.length) return null;

        candidates.sort((a,b) => {
          // Le parole grandi hanno priorità verso il centro; quelle piccole
          // riempiono anche le punte per dare la forma a rombo.
          const centralBiasA = item.weight > 0.55 ? Math.abs(a-center)*0.28 : 0;
          const centralBiasB = item.weight > 0.55 ? Math.abs(b-center)*0.28 : 0;
          const fillA = used[a] / rowTargets[a] + centralBiasA;
          const fillB = used[b] / rowTargets[b] + centralBiasB;
          return fillA - fillB;
        });

        const r = candidates[0];
        rows[r].push(item);
        used[r] += (rows[r].length > 1 ? gapX : 0) + item.width;
      }

      // Pretendiamo che le righe estreme siano realmente utilizzate quando ci sono
      // molte parole, altrimenti il profilo torna ovale.
      if (n >= 24 && (!rows[0].length || !rows[rowCount-1].length)) return null;

      const heights = rows.map(row => row.length ? Math.max(...row.map(x=>x.height)) : 0);
      const totalH = heights.reduce((a,b)=>a+b,0) + gapY * Math.max(0,rowCount-1);
      if (totalH > H * 0.93) return null;
      return {rows, heights, totalH};
    }

    let scale = 1;
    let layout = tryLayout(scale);
    while (!layout && scale > 0.34) {
      scale -= scale > 0.60 ? 0.035 : 0.022;
      layout = tryLayout(scale);
    }

    if (!layout) {
      // Fallback sicuro: nessuna parola sparisce.
      cloud.classList.add('packed-cloud-fallback');
      cloud.innerHTML = arr.map((x,i) =>
        `<span class="packed-word color-${i%7}" style="font-size:clamp(15px,1.3vw,24px)">${esc(x.label)}</span>`
      ).join('');
      return;
    }

    const staggerPattern = [-10, 16, -22, 9, 0, -13, 20, -7, 12];
    cloud.innerHTML = layout.rows.map((row,r) => {
      const dist = Math.abs(r-center);
      const stagger = staggerPattern[r] * Math.min(1, W/1450);
      const words = row.map((x,j) => {
        const cls = `display-cloud-word packed-word color-${x.idx%7}${x.vertical?' word-vertical':''}`;
        const lift = x.vertical ? 0 : (((x.idx*5 + j*7) % 5)-2) * Math.min(1.7, x.size*0.018);
        const style = x.vertical
          ? `font-size:${x.size.toFixed(1)}px;font-weight:${x.fw}`
          : `font-size:${x.size.toFixed(1)}px;font-weight:${x.fw};transform:translateY(${lift.toFixed(1)}px)`;
        return `<span class="${cls}" title="${x.count}" style="${style}">${esc(x.label)}</span>`;
      }).join('');

      return `<div class="packed-row cloud-row-${r} cloud-row-dist-${dist}" style="width:${rowTargets[r].toFixed(0)}px;transform:translateX(${stagger.toFixed(1)}px)">${words}</div>`;
    }).join('');
  }));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
