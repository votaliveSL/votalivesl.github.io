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
  const bounds = cloud.getBoundingClientRect();
  const W = Math.max(420, bounds.width);
  const H = Math.max(280, bounds.height);
  const cx = W / 2;
  const cy = H / 2;
  const placed = [];
  const maxCount = Math.max(...arr.map(x => x.count));
  const base = Math.min(W, H);
  const marginX = Math.max(12, W * .012);
  const marginY = Math.max(10, H * .018);
  const halfW = W / 2 - marginX;
  const halfH = H / 2 - marginY;

  // Candidati ordinati dal centro verso l'esterno secondo distanza "a rombo".
  // Una griglia fitta consente di compattare le parole senza produrre righe regolari.
  const candidates = [{x:cx,y:cy,d:0}];
  const step = Math.max(12, Math.min(22, base * .026));
  for (let y = marginY; y <= H - marginY; y += step) {
    for (let x = marginX; x <= W - marginX; x += step) {
      const nx = Math.abs(x - cx) / halfW;
      const ny = Math.abs(y - cy) / halfH;
      const d = nx + ny;
      if (d <= 1.02) candidates.push({x,y,d});
    }
  }
  // Piccola variazione deterministica per evitare l'effetto "griglia".
  candidates.sort((a,b) => (a.d-b.d) || (((a.x*17+a.y*31)%97)-((b.x*17+b.y*31)%97)));

  const overlaps = (a,b,pad=4) => !(
    a.r + pad < b.l || a.l - pad > b.r || a.b + pad < b.t || a.t - pad > b.b
  );

  function insideDiamond(box, slack=1.02) {
    // Considera l'ingombro dell'intera parola, non soltanto il suo centro.
    const ccx = (box.l + box.r) / 2;
    const ccy = (box.t + box.b) / 2;
    const bw = box.r - box.l;
    const bh = box.b - box.t;
    const projected = Math.abs(ccx-cx)/halfW + Math.abs(ccy-cy)/halfH + (bw/2)/halfW + (bh/2)/halfH;
    return projected <= slack && box.l >= marginX && box.r <= W-marginX && box.t >= marginY && box.b <= H-marginY;
  }

  const items = arr.slice(0, 90).map((x, i) => {
    const ratio = Math.max(.01, x.count / maxCount);
    // Frequenza ben percepibile: le parole dominanti restano chiaramente più grandi.
    const score = Math.pow(ratio, .70);
    const minPx = Math.max(15, base * .027);
    const maxPx = Math.max(76, Math.min(154, base * .225));
    let fontPx = minPx + (maxPx - minPx) * score;
    if (i > 24) fontPx *= .90;
    if (i > 48) fontPx *= .86;

    const el = document.createElement('span');
    el.className = `display-cloud-word rank-${Math.min(i,7)}`;
    el.textContent = x.label;
    el.title = `${x.count}`;

    // Solo poche parole periferiche verticali: circa 10–12%, mai tra le principali.
    const rotate = i >= 9 && i % 9 === 7 && x.label.length <= 11;
    if (rotate) el.classList.add('vertical');

    el.style.fontSize = `${fontPx}px`;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    cloud.appendChild(el);
    return {el, x, i, rotate};
  });

  items.forEach(({el,i,rotate}) => {
    let fontSize = parseFloat(el.style.fontSize);
    let best = null;

    for (let shrink=0; shrink<11 && !best; shrink++) {
      if (shrink) {
        fontSize *= .90;
        el.style.fontSize = `${Math.max(14,fontSize)}px`;
      }
      const ew = el.offsetWidth;
      const eh = el.offsetHeight;
      const visualW = rotate ? eh : ew;
      const visualH = rotate ? ew : eh;

      // Le prime parole devono stare molto vicine al centro; le altre possono
      // progressivamente occupare tutta la losanga.
      const rankLimit = i === 0 ? .08 : Math.min(1.02, .24 + Math.sqrt(i) * .105);

      for (const c of candidates) {
        if (c.d > rankLimit) break;
        const box = {
          l:c.x-visualW/2,
          t:c.y-visualH/2,
          r:c.x+visualW/2,
          b:c.y+visualH/2
        };
        if (!insideDiamond(box, 1.025)) continue;
        const pad = i < 8 ? 5 : 3;
        if (!placed.every(p => !overlaps(box,p,pad))) continue;
        best = {box, centerX:c.x, centerY:c.y, ew, eh};
        break;
      }
    }

    if (!best) {
      el.remove();
      return;
    }

    // Il centro visuale resta quello scelto anche per le poche parole ruotate.
    el.style.left = `${best.centerX - best.ew/2}px`;
    el.style.top = `${best.centerY - best.eh/2}px`;
    el.style.visibility = 'visible';
    el.style.animationDelay = `${Math.min(i*18,300)}ms`;
    placed.push(best.box);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
