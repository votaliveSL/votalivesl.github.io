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
  results.innerHTML = '<div class="wordcloud2-host" id="displayCloud"></div>';
  const cloud = document.getElementById('displayCloud');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (typeof window.WordCloud !== 'function') {
      cloud.innerHTML = '<div class="cloud-empty">Motore Word Cloud non disponibile. Ricarica la pagina.</div>';
      return;
    }

    const rect = cloud.getBoundingClientRect();
    const W = Math.max(480, rect.width);
    const H = Math.max(300, rect.height);
    const maxCount = Math.max(...arr.map(x => x.count));
    const minCount = Math.min(...arr.map(x => x.count));
    const palette = ['#087f89','#326fbd','#7254b6','#4d678a','#bd2788','#d66a00','#27843d'];

    // Colore stabile per parola: non cambia quando arrivano nuove risposte.
    function stableColor(word) {
      const key = canonicalWord(word).key;
      let h = 2166136261;
      for (let i=0; i<key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return palette[Math.abs(h) % palette.length];
    }

    // Font-size compresso: frequenze alte ben evidenti, ma senza "mangiare" la nuvola.
    function sizeForCount(count, scale) {
      if (maxCount === minCount) return 42 * scale;
      const t = (count - minCount) / (maxCount - minCount);
      const eased = Math.pow(t, 0.58);
      const minPx = Math.max(20, Math.min(28, W * 0.016));
      const maxPx = Math.max(54, Math.min(94, W * 0.055, H * 0.145));
      return (minPx + (maxPx - minPx) * eased) * scale;
    }

    // WordCloud2 lavora con [parola, peso]. Passiamo il conteggio reale e
    // trasformiamo il peso in pixel con weightFactor.
    const list = arr.map(x => [x.label, x.count]);

    let scale = 1;
    let attempt = 0;
    const maxAttempts = 7;

    function draw() {
      attempt++;
      cloud.innerHTML = '';

      const onStop = () => {
        const drawn = cloud.querySelectorAll('span').length;
        // Se per mancanza di spazio la libreria non è riuscita a collocare tutto,
        // rifacciamo la nuvola più piccola. Non accettiamo parole mancanti.
        if (drawn < arr.length && attempt < maxAttempts) {
          scale *= 0.88;
          setTimeout(draw, 20);
        }
      };
      cloud.addEventListener('wordcloudstop', onStop, { once: true });

      window.WordCloud(cloud, {
        list,
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontWeight: (word, weight) => weight >= maxCount * 0.72 ? 900 : 800,
        color: (word) => stableColor(word),

        // Spazi piccoli = nuvola compatta.
        gridSize: Math.max(4, Math.round(Math.min(W,H) / 125)),

        // Dimensioni proporzionali alla frequenza.
        weightFactor: (weight) => sizeForCount(weight, scale),
        minSize: 10,

        // Mai fuori dallo schermo; se un singolo termine è enorme, riducilo.
        drawOutOfBound: false,
        shrinkToFit: true,

        // Forma richiesta: rombo irregolare, leggermente schiacciato in verticale.
        shape: 'diamond',
        ellipticity: 0.76,

        // Alcune parole verticali. Le altre restano orizzontali.
        // min=max=90° significa che, quando ruota, ruota davvero in verticale.
        rotateRatio: arr.length >= 18 ? 0.14 : 0.10,
        minRotation: Math.PI / 2,
        maxRotation: Math.PI / 2,
        rotationSteps: 1,

        // Mantiene l'ordine per frequenza: le parole principali partono dal centro.
        shuffle: false,

        // Nessuna maschera/legenda: solo la nuvola.
        clearCanvas: true,
        backgroundColor: 'transparent',
        drawMask: false,

        // Centro reale dell'area disponibile.
        origin: [W / 2, H / 2],

        wait: 0
      });
    }

    draw();
  }));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
