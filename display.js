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
  results.innerHTML = '<div class="display-cloud diamond-cloud stable-cloud" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  requestAnimationFrame(() => {
    const maxCount = Math.max(...arr.map(x => x.count));
    const minCount = Math.min(...arr.map(x => x.count));
    const n = arr.length;

    // Numero di righe dispari, così esiste sempre una riga centrale.
    let rowCount = Math.max(1, Math.ceil(Math.sqrt(n * 1.45)));
    if (rowCount % 2 === 0) rowCount++;
    rowCount = Math.min(rowCount, 13);
    const center = Math.floor(rowCount / 2);

    // Capacità delle righe: massima al centro, progressivamente minore verso alto/basso.
    const capacities = Array.from({length: rowCount}, (_, r) => {
      const dist = Math.abs(r - center);
      return Math.max(1, (center + 1) - dist);
    });
    while (capacities.reduce((a,b)=>a+b,0) < n) {
      capacities[center]++;
      for (let d=1; d<=center && capacities.reduce((a,b)=>a+b,0)<n; d++) {
        capacities[center-d]++;
        if (capacities.reduce((a,b)=>a+b,0)<n) capacities[center+d]++;
      }
    }

    // Riempie dal centro verso l'esterno per tenere le parole più frequenti nel cuore della nuvola.
    const order = [center];
    for (let d=1; d<=center; d++) {
      order.push(center-d);
      order.push(center+d);
    }
    const rows = Array.from({length: rowCount}, () => []);
    let cursor = 0;
    for (const r of order) {
      for (let k=0; k<capacities[r] && cursor<n; k++) rows[r].push(arr[cursor++]);
    }

    // Nelle singole righe mette il termine più importante vicino al centro.
    rows.forEach(row => {
      const ranked = row.splice(0);
      const slots = new Array(ranked.length);
      const centerPos = (ranked.length - 1) / 2;
      const slotOrder = Array.from({length: ranked.length}, (_,i)=>i)
        .sort((a,b)=>Math.abs(a-centerPos)-Math.abs(b-centerPos));
      ranked.forEach((item,i)=>slots[slotOrder[i]]=item);
      row.push(...slots);
    });

    cloud.innerHTML = rows.map((row, r) => {
      const dist = Math.abs(r-center);
      const rowClass = `cloud-row cloud-row-${dist}`;
      return `<div class="${rowClass}">${row.map((x) => {
        const ratio = maxCount === minCount ? 1 : (x.count-minCount)/(maxCount-minCount);
        const weight = .18 + .82*Math.pow(ratio,.68);
        return `<span class="display-cloud-word stable-cloud-word" style="--weight:${weight.toFixed(4)}" title="${x.count}">${esc(x.label)}</span>`;
      }).join('')}</div>`;
    }).join('');

    // Riduce l'intera nuvola solo se necessario: nessuna parola viene eliminata o posizionata fuori area.
    const rowsEl = [...cloud.querySelectorAll('.cloud-row')];
    let scale = 1;
    const fits = () => {
      const cr = cloud.getBoundingClientRect();
      return rowsEl.every(row => {
        const rr = row.getBoundingClientRect();
        return rr.width <= cr.width - 8 && rr.left >= cr.left - 1 && rr.right <= cr.right + 1;
      }) && cloud.scrollHeight <= cloud.clientHeight + 2;
    };

    while (!fits() && scale > .48) {
      scale -= .04;
      cloud.style.setProperty('--cloud-scale', scale.toFixed(2));
    }
  });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
