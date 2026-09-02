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
  results.innerHTML = '<div class="display-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');
  const bounds = cloud.getBoundingClientRect();
  const W = Math.max(320, bounds.width);
  const H = Math.max(260, bounds.height);
  const cx = W / 2;
  const cy = H / 2;
  const placed = [];
  const counts = arr.map(x => x.count);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);

  const items = arr.slice(0, 80).map((x, i) => {
    // Contrasto molto più netto: la parola più citata domina davvero la nuvola.
    let score;
    if (maxCount === minCount) score = 0.58;
    else score = (x.count - minCount) / (maxCount - minCount);
    score = Math.pow(score, .68);

    const el = document.createElement('span');
    el.className = `display-cloud-word rank-${Math.min(i,7)}`;
    el.textContent = x.label;
    el.title = `${x.count}`;

    const base = Math.min(W, H);
    const minPx = Math.max(20, base * 0.038);
    const maxPx = Math.max(82, Math.min(150, base * 0.23));
    const fontPx = minPx + (maxPx - minPx) * score;
    el.style.fontSize = `${fontPx}px`;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    cloud.appendChild(el);
    return {el, x, i};
  });

  const overlaps = (a,b,pad=5) => !(
    a.r + pad < b.l || a.l - pad > b.r || a.b + pad < b.t || a.t - pad > b.b
  );

  // Direzioni iniziali distribuite tutt'attorno al centro, così con poche parole
  // non si forma mai una semplice riga orizzontale.
  const preferredAngles = [
    0,
    -Math.PI/3,
    2*Math.PI/3,
    Math.PI/3,
    -2*Math.PI/3,
    Math.PI,
    -Math.PI/2,
    Math.PI/2
  ];

  items.forEach(({el,i}) => {
    let ew = el.offsetWidth;
    let eh = el.offsetHeight;
    let best = null;

    if (i === 0) {
      best = {l:cx-ew/2, t:cy-eh/2, r:cx+ew/2, b:cy+eh/2};
    } else {
      const startAngle = preferredAngles[(i-1) % preferredAngles.length] + Math.floor((i-1)/preferredAngles.length)*0.21;
      const baseRadius = Math.max(40, Math.min(W,H) * (0.105 + Math.min(i,10)*0.016));

      for (let ring=0; ring<18 && !best; ring++) {
        const radius = baseRadius + ring * Math.min(W,H) * 0.030;
        for (let aTry=0; aTry<24; aTry++) {
          const angle = startAngle + (aTry===0 ? 0 : Math.ceil(aTry/2) * (aTry%2 ? 1 : -1) * 0.16);
          const x = cx + Math.cos(angle)*radius - ew/2;
          const y = cy + Math.sin(angle)*radius*0.88 - eh/2;
          const box = {l:x,t:y,r:x+ew,b:y+eh};
          if (box.l < 8 || box.t < 8 || box.r > W-8 || box.b > H-8) continue;
          if (placed.every(p => !overlaps(box,p))) { best=box; break; }
        }
      }
    }

    // Se manca spazio, riduce soltanto le parole periferiche.
    if (!best) {
      let size = parseFloat(el.style.fontSize);
      for (let shrink=0; shrink<8 && !best; shrink++) {
        size *= .86;
        el.style.fontSize = `${Math.max(16,size)}px`;
        ew = el.offsetWidth; eh = el.offsetHeight;
        const startAngle = preferredAngles[(i-1) % preferredAngles.length];
        for (let step=0; step<900; step++) {
          const angle = startAngle + step * .29;
          const radius = 14 + 3.3*Math.sqrt(step)*Math.min(W,H)/36;
          const x = cx + Math.cos(angle)*radius - ew/2;
          const y = cy + Math.sin(angle)*radius*.82 - eh/2;
          const box = {l:x,t:y,r:x+ew,b:y+eh};
          if (box.l < 8 || box.t < 8 || box.r > W-8 || box.b > H-8) continue;
          if (placed.every(p => !overlaps(box,p,3))) { best=box; break; }
        }
      }
    }

    if (best) {
      el.style.left = `${best.l}px`;
      el.style.top = `${best.t}px`;
      el.style.visibility = 'visible';
      el.style.animationDelay = `${Math.min(i*24,360)}ms`;
      placed.push(best);
    } else {
      el.remove();
    }
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
