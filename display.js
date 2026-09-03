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

  // Usa ESCLUSIVAMENTE le dimensioni effettive della nuvola: in questo modo
  // il centro geometrico usato dal calcolo coincide sempre con il centro
  // visibile del contenitore sul proiettore.
  W = cloud.clientWidth || W;
  H = cloud.clientHeight || H;
  const cx = W / 2;
  const cy = H / 2;
  const maxCount = Math.max(1, ...arr.map(x => x.count));
  const base = Math.min(W, H);
  const marginX = Math.max(24, W * .025);
  const marginY = Math.max(20, H * .035);
  const halfW = Math.max(1, W / 2 - marginX);
  const halfH = Math.max(1, H / 2 - marginY);

  const items = arr.map((x, i) => {
    const ratio = x.count / maxCount;
    const score = Math.pow(ratio, .72);
    const minPx = Math.max(18, base * .030);
    const maxPx = Math.max(70, Math.min(150, base * .18));
    const naturalPx = minPx + (maxPx - minPx) * score;
    // Rotazioni solo per parole periferiche quando la nuvola è davvero ricca.
    const rotate = arr.length >= 12 && i >= 9 && i % 8 === 7 && x.label.length <= 10;

    const el = document.createElement('span');
    el.className = `display-cloud-word rank-${Math.min(i,7)}${rotate ? ' vertical' : ''}`;
    el.textContent = x.label;
    el.title = `${x.count}`;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.margin = '0';
    el.style.padding = '0';
    // Durante il calcolo niente animazioni/trasformazioni: misuriamo il testo
    // reale, non una sua versione scalata dall'animazione CSS.
    el.style.animation = 'none';
    if (!rotate) el.style.transform = 'none';
    cloud.appendChild(el);
    return {el, x, i, rotate, naturalPx};
  });

  const boxesOverlap = (a, b, pad) => !(
    a.r + pad <= b.l || a.l - pad >= b.r ||
    a.b + pad <= b.t || a.t - pad >= b.b
  );

  // Controlla tutti e quattro gli angoli rispetto al rombo. È più rigoroso
  // del vecchio controllo sul solo centro e impedisce sovrapposizioni visive.
  function insideDiamond(box) {
    if (box.l < marginX || box.r > W-marginX || box.t < marginY || box.b > H-marginY) return false;
    const corners = [
      [box.l,box.t],[box.r,box.t],[box.l,box.b],[box.r,box.b]
    ];
    return corners.every(([x,y]) => Math.abs(x-cx)/halfW + Math.abs(y-cy)/halfH <= .985);
  }

  // Spirale ellittica dal centro: produce una nuvola compatta, simmetrica e
  // soprattutto non dipende dall'ordine casuale dei punti di una griglia.
  function makeCandidates(stepPx) {
    const pts = [{x:cx,y:cy}];
    const maxR = Math.hypot(halfW, halfH);
    for (let r = stepPx; r <= maxR; r += stepPx) {
      const n = Math.max(18, Math.round((2*Math.PI*r)/stepPx));
      for (let k=0;k<n;k++) {
        const a = (k/n)*Math.PI*2;
        // leggermente più largo che alto = rombo morbido sul proiettore
        const x = cx + Math.cos(a)*r;
        const y = cy + Math.sin(a)*r*.72;
        if (x >= marginX && x <= W-marginX && y >= marginY && y <= H-marginY) {
          const d = Math.abs(x-cx)/halfW + Math.abs(y-cy)/halfH;
          if (d <= .97) pts.push({x,y});
        }
      }
    }
    return pts;
  }
  const candidates = makeCandidates(Math.max(7, Math.min(14, base*.014)));

  function attempt(globalScale) {
    const placed = [];
    const positions = [];

    for (const item of items) {
      const fontPx = Math.max(12, item.naturalPx * globalScale);
      item.el.style.fontSize = `${fontPx}px`;
      // Forza il layout dopo il cambio dimensione prima della misura.
      const ew = Math.ceil(item.el.getBoundingClientRect().width);
      const eh = Math.ceil(item.el.getBoundingClientRect().height);
      const visualW = item.rotate ? eh : ew;
      const visualH = item.rotate ? ew : eh;
      let found = null;

      // Spazio reale fra parole: evita l'effetto 'lettere che si toccano'.
      const pad = Math.max(7, Math.round(fontPx*.09));
      for (const c of candidates) {
        const box = {
          l:c.x-visualW/2, t:c.y-visualH/2,
          r:c.x+visualW/2, b:c.y+visualH/2
        };
        if (!insideDiamond(box)) continue;
        if (placed.some(p => boxesOverlap(box,p,pad))) continue;
        found = {box, left:c.x-ew/2, top:c.y-eh/2};
        break;
      }
      if (!found) return null;
      placed.push(found.box);
      positions.push(found);
    }
    return positions;
  }

  // Se tutte non entrano, si ridimensiona l'INTERA nuvola e si ricalcola da
  // zero. Nessuna parola viene mai sovrapposta o sacrificata.
  let positions = null;
  const scales = [1,.94,.88,.82,.76,.70,.64,.58,.52,.46,.40,.34,.28,.24,.20];
  for (const scale of scales) {
    positions = attempt(scale);
    if (positions) break;
  }

  // Fallback garantito per quantità eccezionali: griglia centrata e ordinata,
  // senza sovrapposizioni. Normalmente non viene mai raggiunto.
  if (!positions) {
    const cols = Math.max(2, Math.ceil(Math.sqrt(items.length * W/H)));
    const rows = Math.ceil(items.length/cols);
    const cellW = (W-2*marginX)/cols;
    const cellH = (H-2*marginY)/rows;
    positions = items.map((item,i) => {
      item.el.style.fontSize = `${Math.max(11, Math.min(cellH*.32, cellW/(Math.max(4,item.x.label.length)*.58)))}px`;
      const ew = Math.ceil(item.el.getBoundingClientRect().width);
      const eh = Math.ceil(item.el.getBoundingClientRect().height);
      const col=i%cols, row=Math.floor(i/cols);
      const x=marginX+cellW*(col+.5), y=marginY+cellH*(row+.5);
      return {left:x-ew/2, top:y-eh/2, box:{l:x-ew/2,t:y-eh/2,r:x+ew/2,b:y+eh/2}};
    });
  }

  items.forEach((item,i) => {
    const pos = positions[i];
    item.el.style.left = `${Math.round(pos.left)}px`;
    item.el.style.top = `${Math.round(pos.top)}px`;
    item.el.style.visibility = 'visible';
    // Riattiva solo la trasformazione necessaria alle rare parole verticali.
    if (item.rotate) item.el.style.transform = 'rotate(90deg)';
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
