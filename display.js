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

let cloudRenderToken = 0;

function renderCloud(arr) {
  const token = ++cloudRenderToken;
  results.innerHTML = '<div class="display-cloud diamond-cloud" id="displayCloud"></div>';

  // Il contenitore della nuvola viene creato nello stesso ciclo in cui cambia
  // la modalità del display. In alcuni browser/monitor il primo layout non è
  // ancora assestato e getBoundingClientRect() può restituire 0 (o valori
  // troppo piccoli). In quel caso la vecchia versione costruiva la nuvola in
  // un'area fittizia 420x280: ecco perché alcune parole, anche frequenti,
  // sparivano mentre altre restavano visibili.
  // Attendiamo quindi il layout reale prima di iniziare il posizionamento.
  const waitForRealSize = (attempt = 0) => {
    if (token !== cloudRenderToken) return;
    const cloud = document.getElementById('displayCloud');
    if (!cloud) return;
    const r = cloud.getBoundingClientRect();
    const parent = results.getBoundingClientRect();
    const W = Math.max(r.width, cloud.clientWidth, parent.width);
    const H = Math.max(r.height, cloud.clientHeight, parent.height);

    // Su uno schermo di proiezione la zona utile è molto più grande di questi
    // valori; se non lo è ancora aspettiamo un altro frame (max ~0,3 s).
    if ((W < 700 || H < 300) && attempt < 20) {
      requestAnimationFrame(() => waitForRealSize(attempt + 1));
      return;
    }
    placeCloudWords(arr, cloud, Math.max(420, W), Math.max(280, H), token);
  };

  requestAnimationFrame(() => requestAnimationFrame(() => waitForRealSize(0)));
}

function placeCloudWords(arr, cloud, W, H, token) {
  if (token !== cloudRenderToken || !cloud.isConnected) return;
  cloud.innerHTML = '';

  const cx = W / 2;
  const cy = H / 2;
  const maxCount = Math.max(1, ...arr.map(x => x.count));
  const base = Math.min(W, H);
  const marginX = Math.max(18, W * .018);
  const marginY = Math.max(14, H * .025);
  const halfW = W / 2 - marginX;
  const halfH = H / 2 - marginY;

  // Griglia a rombo, ordinata SEMPRE dal centro verso l'esterno.
  // La posizione non dipende dalla lunghezza della parola o dal suo numero
  // di voti: la priorità è determinata esclusivamente dall'ordine di arr,
  // che è già ordinato per frequenza decrescente.
  const candidates = [{x:cx, y:cy, d:0}];
  const step = Math.max(5, Math.min(10, base * .011));
  for (let y = marginY; y <= H - marginY; y += step) {
    for (let x = marginX; x <= W - marginX; x += step) {
      const d = Math.abs(x - cx) / halfW + Math.abs(y - cy) / halfH;
      if (d <= .985) candidates.push({x,y,d});
    }
  }
  candidates.sort((a,b) => (a.d-b.d) || (((a.x*19+a.y*37)%101)-((b.x*19+b.y*37)%101)));

  const items = arr.map((x, i) => {
    const ratio = x.count / maxCount;
    const score = Math.pow(ratio, .72);
    const minPx = Math.max(15, base * .024);
    const maxPx = Math.max(64, Math.min(142, base * .19));
    const naturalPx = minPx + (maxPx - minPx) * score;
    const rotate = i >= 10 && i % 9 === 7 && x.label.length <= 11;

    const el = document.createElement('span');
    el.className = `display-cloud-word rank-${Math.min(i,7)}${rotate ? ' vertical' : ''}`;
    el.textContent = x.label;
    el.title = `${x.count}`;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    cloud.appendChild(el);
    return {el, x, i, rotate, naturalPx};
  });

  const overlaps = (a,b,pad=2) => !(
    a.r + pad < b.l || a.l - pad > b.r || a.b + pad < b.t || a.t - pad > b.b
  );

  function insideDiamond(box, slack=.995) {
    const ccx = (box.l + box.r) / 2;
    const ccy = (box.t + box.b) / 2;
    const bw = box.r - box.l;
    const bh = box.b - box.t;
    const projected = Math.abs(ccx-cx)/halfW + Math.abs(ccy-cy)/halfH + (bw/2)/halfW + (bh/2)/halfH;
    return projected <= slack && box.l >= marginX && box.r <= W-marginX && box.t >= marginY && box.b <= H-marginY;
  }

  function tryLayout(globalScale) {
    const placed = [];
    const positions = [];

    for (const item of items) {
      // Riduzione globale: se anche UNA sola parola non entra, l'intera
      // nuvola viene ricalcolata un po' più piccola. In questo modo non può
      // accadere che una parola meno frequente resti visibile mentre una più
      // frequente venga scartata per una collisione casuale.
      const fontPx = Math.max(11, item.naturalPx * globalScale);
      item.el.style.fontSize = `${fontPx}px`;
      const ew = item.el.offsetWidth;
      const eh = item.el.offsetHeight;
      const visualW = item.rotate ? eh : ew;
      const visualH = item.rotate ? ew : eh;
      let found = null;

      for (const c of candidates) {
        const box = {
          l:c.x-visualW/2, t:c.y-visualH/2,
          r:c.x+visualW/2, b:c.y+visualH/2
        };
        if (!insideDiamond(box)) continue;
        const pad = item.i < 8 ? 3 : 1;
        if (placed.some(p => overlaps(box,p,pad))) continue;
        found = {box, left:c.x-ew/2, top:c.y-eh/2};
        break;
      }

      if (!found) return null;
      placed.push(found.box);
      positions.push(found);
    }
    return positions;
  }

  // Prima tentiamo le dimensioni naturali. Se la disposizione non contiene
  // TUTTE le parole, ricalcoliamo da zero riducendo uniformemente la nuvola.
  let positions = null;
  const scales = [1,.94,.88,.82,.76,.70,.64,.58,.52,.46,.40,.34,.28,.22];
  for (const scale of scales) {
    positions = tryLayout(scale);
    if (positions) break;
  }

  // Fallback estremo: deve comparire ogni parola. Con dimensione minima
  // ripetiamo il posizionamento su una griglia ancora più fitta e con margine
  // di collisione nullo. È preferibile una nuvola più compatta a una parola
  // mancante.
  if (!positions) {
    const placed = [];
    positions = [];
    for (const item of items) {
      item.el.style.fontSize = '10px';
      const ew = item.el.offsetWidth;
      const eh = item.el.offsetHeight;
      const visualW = item.rotate ? eh : ew;
      const visualH = item.rotate ? ew : eh;
      let found = null;
      for (const c of candidates) {
        const box = {l:c.x-visualW/2,t:c.y-visualH/2,r:c.x+visualW/2,b:c.y+visualH/2};
        if (!insideDiamond(box,1.01)) continue;
        if (placed.some(p => overlaps(box,p,0))) continue;
        found = {box,left:c.x-ew/2,top:c.y-eh/2};
        break;
      }
      if (!found) {
        // Ultima garanzia: non rimuovere mai la parola. La disponiamo lungo
        // il bordo inferiore in carattere minimo; questo caso riguarda solo
        // quantità eccezionali di parole distinte.
        const slot = positions.length;
        const cols = Math.max(1, Math.floor((W - 2*marginX) / Math.max(70, ew + 4)));
        const row = Math.floor(slot / cols);
        const col = slot % cols;
        found = {
          box:{l:marginX + col*((W-2*marginX)/cols), t:H-marginY-12-row*12, r:marginX + (col+1)*((W-2*marginX)/cols), b:H-marginY-row*12},
          left:marginX + col*((W-2*marginX)/cols),
          top:H-marginY-12-row*12
        };
      }
      placed.push(found.box);
      positions.push(found);
    }
  }

  items.forEach((item,i) => {
    const pos = positions[i];
    item.el.style.left = `${pos.left}px`;
    item.el.style.top = `${pos.top}px`;
    item.el.style.visibility = 'visible';
    item.el.style.animationDelay = `${Math.min(i*18,300)}ms`;
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
