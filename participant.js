import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import { getFirestore, doc, onSnapshot, runTransaction, serverTimestamp, collection, setDoc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const db = getFirestore(initializeApp(firebaseConfig));
const sessionId = new URLSearchParams(location.search).get('s') || 'processo-ai-2026';
const ref = doc(db,'sessions',sessionId);
const box = document.getElementById('interaction');
const question = document.getElementById('question');
const status = document.getElementById('status');
const thanks = document.getElementById('thanks');
const key = r => `answered:${sessionId}:${r}`;

onSnapshot(ref, s => {
  if (!s.exists()) {
    showQuestion('Sessione non configurata');
    status.textContent = 'Controlla il link.';
    box.innerHTML = '';
    return;
  }
  render(s.data());
});

function showQuestion(text) {
  question.textContent = text || '';
  question.classList.toggle('hidden', !text);
}

function waiting() {
  showQuestion('');
  box.innerHTML = '';
  box.className = 'interaction';
  thanks.classList.add('hidden');
  status.textContent = 'In attesa della prossima domanda…';
}

function render(d) {
  box.innerHTML = '';
  box.className = 'interaction';
  thanks.classList.add('hidden');

  if (!d.isOpen) {
    waiting();
    return;
  }

  if (localStorage.getItem(key(d.roundId))) {
    waiting();
    return;
  }

  showQuestion(d.question || 'Interazione');

  if (d.type === 'wordcloud') {
    status.textContent = 'Scrivi fino a 3 parole o brevi espressioni.';
    box.innerHTML = `
      <div class="word-entry word-entry-three">
        <input class="word-input" maxlength="40" autocomplete="off" autocapitalize="sentences" placeholder="Parola 1">
        <input class="word-input" maxlength="40" autocomplete="off" autocapitalize="sentences" placeholder="Parola 2 (facoltativa)">
        <input class="word-input" maxlength="40" autocomplete="off" autocapitalize="sentences" placeholder="Parola 3 (facoltativa)">
        <button id="sendWord">Invia</button>
        <div class="word-hint">Fino a 3 parole · massimo 40 caratteri ciascuna · un invio per partecipante</div>
      </div>`;
    document.getElementById('sendWord').onclick = () => sendWords(d.roundId);
    document.querySelectorAll('.word-input').forEach((input,idx,all) => {
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (idx < all.length - 1 && input.value.trim()) all[idx+1].focus();
        else sendWords(d.roundId);
      });
    });
    return;
  }

  status.textContent = 'Seleziona una risposta.';
  box.classList.add('choice-list');
  (d.options || []).forEach((o,i) => {
    const b = document.createElement('button');
    b.className = 'choice';
    b.textContent = o;
    b.onclick = () => vote(i,d.roundId);
    box.appendChild(b);
  });
}

async function vote(i,r) {
  box.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    await runTransaction(db, async tx => {
      const s = await tx.get(ref);
      if (!s.exists()) throw Error('Sessione non trovata');
      const d = s.data();
      if (!d.isOpen || d.roundId !== r) throw Error('Votazione chiusa');
      const c = [...(d.counts || [])];
      c[i] = (c[i] || 0) + 1;
      tx.update(ref,{counts:c,updatedAt:serverTimestamp()});
      const rr = doc(db,'sessions',sessionId,'rounds',r);
      tx.set(rr,{counts:c,total:c.reduce((a,b)=>a+b,0),updatedAt:serverTimestamp()},{merge:true});
    });
    done(r);
  } catch(e) {
    status.textContent = e.message;
  }
}

async function sendWords(r) {
  const inputs = [...document.querySelectorAll('.word-input')];
  const texts = inputs.map(input => input.value.trim().replace(/\s+/g,' ')).filter(Boolean);
  if (!texts.length) {
    inputs[0]?.focus();
    return;
  }
  document.getElementById('sendWord').disabled = true;
  try {
    const voter = getVoter();
    await setDoc(doc(collection(db,'responses'),`${sessionId}_${r}_${voter}`),{
      sessionId,
      roundId:r,
      texts:texts.slice(0,3),
      createdAt:serverTimestamp()
    });
    done(r);
  } catch(e) {
    status.textContent = 'Errore durante l’invio.';
    document.getElementById('sendWord').disabled = false;
  }
}

function getVoter() {
  let v = localStorage.getItem('processo-ai-voter');
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem('processo-ai-voter',v);
  }
  return v;
}

function done(r) {
  localStorage.setItem(key(r),'1');
  waiting();
}
