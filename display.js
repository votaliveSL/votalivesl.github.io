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
  results.innerHTML = '<div class="display-cloud diamond-cloud packed-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rect = cloud.getBoundingClientRect();
    const W = Math.max(320, rect.width);
    const H = Math.max(220, rect.height);
    const n = arr.length;
    const maxCount = Math.max(...arr.map(x => x.count));
    const minCount = Math.min(...arr.map(x => x.count));

    // Canvas indipendente dal DOM: misura le parole prima di disporle.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily || 'Arial, sans-serif';

    // Più righe quando aumentano i termini, ma sempre numero dispari per avere un cuore centrale.
    let rowCount = Math.max(5, Math.min(11, Math.round(Math.sqrt(n) * 1.45)));
    if (rowCount % 2 === 0) rowCount++;
    const center = Math.floor(rowCount / 2);

    // Forma a rombo morbido: le righe centrali possono occupare quasi tutta la larghezza,
    // quelle periferiche sono progressivamente più corte.
    const rowTargets = Array.from({length: rowCount}, (_, r) => {
      const d = center ? Math.abs(r-center)/center : 0;
      const factor = 0.50 + 0.46 * Math.pow(1-d, 0.62); // 50% ai bordi, 96% al centro
      return W * factor;
    });

    // Ordine di riempimento centro -> esterno per tenere i termini più frequenti nel cuore.
    const rowPriority = [center];
    for (let d=1; d<=center; d++) {
      if (center-d >= 0) rowPriority.push(center-d);
      if (center+d < rowCount) rowPriority.push(center+d);
    }

    const baseMax = Math.min(86, Math.max(54, W * 0.055), H * 0.145);
    const baseMin = Math.max(22, Math.min(34, baseMax * 0.40));
    const gapX = Math.max(10, Math.min(22, W * 0.010));
    const gapY = Math.max(3, Math.min(10, H * 0.012));

    function weightFor(x) {
      if (maxCount === minCount) return 0.72;
      const ratio = (x.count-minCount)/(maxCount-minCount);
      return 0.20 + 0.80 * Math.pow(ratio, 0.66);
    }

    function tryLayout(scale) {
      const items = arr.map((x, idx) => {
        const weight = weightFor(x);
        const size = (baseMin + (baseMax-baseMin)*weight) * scale;
        const fw = idx < 3 ? 900 : 850;
        ctx.font = `${fw} ${size}px ${fontFamily}`;
        const width = ctx.measureText(x.label).width + size*0.10;
        return {...x, idx, weight, size, fw, width};
      });

      const rows = Array.from({length: rowCount}, () => []);
      const used = Array(rowCount).fill(0);

      // Ogni termine DEVE trovare una riga. Se non entra, il tentativo fallisce e si ridimensiona tutto.
      for (const item of items) {
        let candidates = rowPriority
          .filter(r => used[r] + (rows[r].length ? gapX : 0) + item.width <= rowTargets[r])
          .sort((a,b) => {
            // Prima vicinanza al centro, poi riga meno piena in proporzione alla propria capacità.
            const ca = Math.abs(a-center), cb = Math.abs(b-center);
            if (ca !== cb) return ca-cb;
            return (used[a]/rowTargets[a])-(used[b]/rowTargets[b]);
          });
        if (!candidates.length) return null;
        const r = candidates[0];
        rows[r].push(item);
        used[r] += (rows[r].length > 1 ? gapX : 0) + item.width;
      }

      // Altezza reale stimata di ogni riga.
      const heights = rows.map(row => row.length ? Math.max(...row.map(x=>x.size))*0.94 : 0);
      const totalH = heights.reduce((a,b)=>a+b,0) + gapY * rows.filter(r=>r.length).length;
      if (totalH > H * 0.95) return null;
      return {rows, used, heights, totalH};
    }

    let scale = 1;
    let layout = tryLayout(scale);
    while (!layout && scale > 0.48) {
      scale -= 0.035;
      layout = tryLayout(scale);
    }
    // Fallback estremo: continua a ridurre finché tutto entra. Nessun termine viene eliminato.
    while (!layout && scale > 0.28) {
      scale -= 0.025;
      layout = tryLayout(scale);
    }
    if (!layout) {
      // Con quantità eccezionali, usa più righe visibili senza scartare termini.
      cloud.classList.add('packed-cloud-fallback');
      cloud.innerHTML = arr.map(x => `<span class="packed-word" style="font-size:clamp(16px,1.45vw,27px)">${esc(x.label)}</span>`).join('');
      return;
    }

    // Righe vuote non vengono renderizzate. Piccoli offset deterministici rendono il profilo meno "tabellare".
    const active = layout.rows.map((row,r)=>({row,r})).filter(x=>x.row.length);
    cloud.innerHTML = active.map(({row,r}, activeIndex) => {
      const dist = Math.abs(r-center);
      const maxRowW = rowTargets[r];
      const stagger = ((r % 3) - 1) * Math.min(14, W*0.008);
      const words = row.map((x,j) => {
        const lift = ((x.idx * 7 + j * 3) % 5 - 2) * Math.min(2.2, x.size*0.025);
        return `<span class="display-cloud-word packed-word" title="${x.count}" style="font-size:${x.size.toFixed(1)}px;font-weight:${x.fw};transform:translateY(${lift.toFixed(1)}px)">${esc(x.label)}</span>`;
      }).join('');
      return `<div class="packed-row packed-row-${dist}" style="max-width:${maxRowW.toFixed(0)}px;transform:translateX(${stagger.toFixed(1)}px)">${words}</div>`;
    }).join('');
  }));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
