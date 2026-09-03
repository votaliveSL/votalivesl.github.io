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
  results.innerHTML = '<div class="display-cloud spiral-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rect = cloud.getBoundingClientRect();
    const W = Math.max(320, rect.width);
    const H = Math.max(220, rect.height);
    const maxCount = Math.max(...arr.map(x => x.count));
    const minCount = Math.min(...arr.map(x => x.count));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = getComputedStyle(document.body).fontFamily || 'Arial, sans-serif';

    const pad = Math.max(6, Math.min(18, W * 0.01));
    const gapPx = Math.max(3, Math.min(9, W * 0.004));
    // Le dimensioni tengono conto anche di quante parole ci sono: con più
    // parole, ciascuna deve essere proporzionalmente più piccola.
    const baseMax = Math.min(150, Math.max(30, Math.sqrt(W*H) * 0.62 / Math.sqrt(Math.max(arr.length,4))), H * 0.34);
    const baseMin = Math.max(11, baseMax * 0.14);
    // La spirale segue le proporzioni reali del contenitore, così sfrutta
    // bene anche schermi molto larghi (16:9) invece di restare "tonda".
    const squashY = Math.max(0.45, Math.min(1, H / W));

    function hashOf(label) {
      let hash = 0;
      const key = canonicalWord(label).key;
      for (let i=0; i<key.length; i++) hash = ((hash * 31) + key.charCodeAt(i)) >>> 0;
      return hash;
    }

    function weightFor(x) {
      if (maxCount === minCount) return 0.70;
      const ratio = (x.count-minCount)/(maxCount-minCount);
      return 0.10 + 0.90 * Math.pow(ratio, 1.7);
    }

    function isVertical(item, idx) {
      // La parola più frequente resta sempre orizzontale (leggibilità del
      // "titolo" della nuvola). Per le altre, ~20% in verticale, scelta
      // deterministica in base alla parola stessa.
      if (idx === 0 || item.label.length > 16) return false;
      return (hashOf(item.label) % 100) < 20;
    }

    // Rettangolo di ingombro effettivo (dopo rotazione), usato per il
    // posizionamento e il controllo delle collisioni.
    function effBox(naturalW, naturalH, angleDeg) {
      const rad = angleDeg * Math.PI/180;
      const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
      return { w: naturalW*c + naturalH*s, h: naturalW*s + naturalH*c };
    }

    function collides(cx, cy, w, h, placed) {
      const halfW = w/2 + gapPx/2, halfH = h/2 + gapPx/2;
      for (const p of placed) {
        const pHalfW = p.effW/2 + gapPx/2, pHalfH = p.effH/2 + gapPx/2;
        if (Math.abs(cx-p.cx) < halfW+pHalfW && Math.abs(cy-p.cy) < halfH+pHalfH) return true;
      }
      return false;
    }

    // Posiziona le parole una alla volta (dalla più frequente) lungo una
    // spirale che parte dal centro, cercando il primo punto libero.
    function placeWords(items) {
      const placed = [];
      const cx0 = W/2, cy0 = H/2;
      const angleStep = 0.26;
      const radiusStep = 2.6;
      const maxSteps = 1400;

      for (const item of items) {
        let theta = (hashOf(item.label) % 628) / 100; // punto di partenza variabile per parola
        let radius = 0;
        let placedAt = null;

        for (let step=0; step<maxSteps; step++) {
          const cx = cx0 + radius*Math.cos(theta);
          const cy = cy0 + radius*Math.sin(theta)*squashY;
          const fitsBounds = cx-item.effW/2 >= pad && cx+item.effW/2 <= W-pad &&
                              cy-item.effH/2 >= pad && cy+item.effH/2 <= H-pad;
          if (fitsBounds && !collides(cx, cy, item.effW, item.effH, placed)) {
            placedAt = {cx, cy};
            break;
          }
          theta += angleStep;
          radius += radiusStep;
        }
        if (!placedAt) return null;
        placed.push({...item, cx: placedAt.cx, cy: placedAt.cy});
      }
      return placed;
    }

    function tryLayout(scale) {
      const items = arr.map((x, idx) => {
        const weight = weightFor(x);
        const size = (baseMin + (baseMax-baseMin)*weight) * scale;
        const fw = idx === 0 ? 900 : (idx < 4 ? 870 : 800);
        ctx.font = `${fw} ${size}px ${fontFamily}`;
        const naturalW = ctx.measureText(x.label).width + size*0.06;
        const naturalH = size * 0.92;
        const vertical = isVertical(x, idx);
        const angleDeg = vertical ? 90 : 0;
        const {w: effW, h: effH} = effBox(naturalW, naturalH, angleDeg);
        return {...x, idx, weight, size, fw, naturalW, naturalH, vertical, angleDeg, effW, effH};
      });
      return placeWords(items);
    }

    let scale = 1;
    let placed = tryLayout(scale);
    while (!placed && scale > 0.28) {
      scale -= scale > 0.55 ? 0.05 : 0.03;
      placed = tryLayout(scale);
    }

    if (!placed) {
      // Fallback sicuro: tutte le parole, mai tagliate o eliminate.
      cloud.classList.add('packed-cloud-fallback','packed-cloud','organic-cloud');
      cloud.innerHTML = arr.map((x,i) =>
        `<span class="packed-word color-${i%7}" style="font-size:clamp(15px,1.35vw,25px)">${esc(x.label)}</span>`
      ).join('');
      return;
    }

    cloud.innerHTML = placed.map(x => {
      const cls = `spiral-word color-${x.idx%7}${x.vertical?' word-vertical':''}`;
      const transform = `translate(-50%,-50%) rotate(${x.angleDeg}deg)`;
      return `<span class="${cls}" title="${x.count}" style="left:${x.cx.toFixed(1)}px;top:${x.cy.toFixed(1)}px;font-size:${x.size.toFixed(1)}px;font-weight:${x.fw};transform:${transform}">${esc(x.label)}</span>`;
    }).join('');
  }));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
