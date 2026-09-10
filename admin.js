import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import { getFirestore, doc, onSnapshot, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, writeBatch, serverTimestamp, getDoc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const db = getFirestore(initializeApp(firebaseConfig));
const q = id => document.getElementById(id);

let currentSession = q('sessionInput').value.trim();
let unsub = null;
let unsubHistory = null;
let unsubWords = null;
let activeCloudRound = null;
let unsubAgenda = null;
let agendaItems = [];
let selectedAgendaId = null;
let currentSessionData = null;
let imageDataUrl = '';

const sessionRef = () => doc(db,'sessions',currentSession);
const roundRef = roundId => doc(db,'sessions',currentSession,'rounds',roundId);
const roundsRef = () => collection(db,'sessions',currentSession,'rounds');
const agendaRef = () => collection(db,'sessions',currentSession,'agenda');
const agendaItemRef = id => doc(db,'sessions',currentSession,'agenda',id);
const options = () => q('optionsInput').value.split('\n').map(x=>x.trim()).filter(Boolean);

function typeUI() {
  const type = q('typeInput').value;
  const isChoice = type === 'choice';
  const isCloud = type === 'wordcloud';
  const isImage = type === 'image';

  q('optionsWrap').style.display = isChoice ? 'block' : 'none';
  q('wordCloudHelp').style.display = isCloud ? 'block' : 'none';
  q('imageUploadWrap').classList.toggle('hidden', !isImage);
  q('revealToggleWrap').classList.toggle('hidden', isImage);
  q('resetBtn').classList.toggle('hidden', isImage);

  q('questionLabel').textContent = isImage ? 'Titolo in scaletta' : 'Domanda';
  q('openBtn').textContent = isImage ? 'Mostra' : 'Apri';
  q('closeBtn').textContent = isImage ? 'Nascondi' : 'Chiudi';
}

q('typeInput').onchange = typeUI;
typeUI();

const titleFontSizeInput = q('titleFontSizeInput');
const titleFontSizeValue = q('titleFontSizeValue');

function updateTitleFontSizeLabel() {
  if (titleFontSizeInput && titleFontSizeValue) {
    titleFontSizeValue.textContent = `${titleFontSizeInput.value} px`;
  }
}
if (titleFontSizeInput) {
  titleFontSizeInput.addEventListener('input', updateTitleFontSizeLabel);
  updateTitleFontSizeLabel();
}

function setImagePreview(dataUrl='') {
  imageDataUrl = dataUrl || '';
  q('imagePreview').innerHTML = imageDataUrl
    ? `<img src="${imageDataUrl}" alt="Anteprima immagine">`
    : '<span class="muted">Nessuna immagine selezionata</span>';
}

q('imageInput').onchange = async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    setAgendaStatus('Preparazione immagine…');
    const dataUrl = await compressImage(file);
    setImagePreview(dataUrl);
    setAgendaStatus('Immagine pronta.');
  } catch (err) {
    console.error(err);
    setAgendaStatus('Impossibile elaborare l’immagine.', true);
  }
};

async function compressImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('File non immagine');

  const bitmap = await createImageBitmap(file);
  const MAX_SIDE = 1600;
  const ratio = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,w,h);
  ctx.drawImage(bitmap,0,0,w,h);
  bitmap.close?.();

  let quality = 0.84;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);

  while (dataUrl.length > 700000 && quality > 0.48) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  if (dataUrl.length > 850000) {
    const scale = Math.sqrt(700000 / dataUrl.length);
    const w2 = Math.max(1, Math.round(w * scale));
    const h2 = Math.max(1, Math.round(h * scale));
    const c2 = document.createElement('canvas');
    c2.width = w2;
    c2.height = h2;
    const x2 = c2.getContext('2d');
    x2.fillStyle = '#ffffff';
    x2.fillRect(0,0,w2,h2);
    x2.drawImage(canvas,0,0,w2,h2);
    dataUrl = c2.toDataURL('image/jpeg', 0.72);
  }

  if (dataUrl.length > 900000) throw new Error('Immagine ancora troppo grande');
  return dataUrl;
}

function subscribe() {
  if (unsub) unsub();
  if (unsubHistory) unsubHistory();
  if (unsubWords) { unsubWords(); unsubWords = null; activeCloudRound = null; }
  if (unsubAgenda) { unsubAgenda(); unsubAgenda = null; }

  unsub = onSnapshot(sessionRef(), async snap => {
    if (!snap.exists()) return render(null,[]);
    const d = snap.data();
    currentSessionData = d;

    if (d.type !== 'image') {
      q('questionInput').value = d.question || '';
      q('typeInput').value = d.type || 'choice';
      if (d.options?.length) q('optionsInput').value = d.options.join('\n');
      q('showResults').checked = !!d.showResults;
      typeUI();
    }

    if (d.type === 'wordcloud') subscribeWords(d.roundId);
    else {
      if (unsubWords) { unsubWords(); unsubWords = null; activeCloudRound = null; }
      render(d,[]);
    }
    renderAgenda();
  });

  unsubHistory = onSnapshot(roundsRef(), snap => {
    const rounds = snap.docs.map(x => ({id:x.id,...x.data()}));
    rounds.sort((a,b) => timeMs(b.openedAt || b.createdAt) - timeMs(a.openedAt || a.createdAt));
    renderHistory(rounds);
  });

  unsubAgenda = onSnapshot(agendaRef(), snap => {
    agendaItems = snap.docs.map(x => ({id:x.id,...x.data()}));
    agendaItems.sort((a,b) => (Number(a.order)||0) - (Number(b.order)||0) || timeMs(a.createdAt)-timeMs(b.createdAt));
    renderAgenda();
    setAgendaStatus('');
  }, err => {
    console.error('Errore scaletta Firestore:', err);
    setAgendaStatus('Errore Firebase: ' + (err?.message || 'impossibile leggere la scaletta'), true);
  });

  updateUrls();
}

q('sessionInput').onchange = () => {
  currentSession = q('sessionInput').value.trim() || 'processo-ai-2026';
  subscribe();
};

async function saveDraft() {
  const type = q('typeInput').value;

  if (type === 'image') {
    const data = currentInteractionPayload();
    if (!validateInteraction(data)) return;
    await setDoc(sessionRef(),{
      question:data.question,
      type:'image',
      imageData:data.imageData,
      titleFontSize:Number(data.titleFontSize || 54),
      options:[],
      counts:[],
      isOpen:false,
      showResults:false,
      roundId:null,
      agendaId:null,
      updatedAt:serverTimestamp()
    },{merge:true});
    return;
  }

  const opts = type === 'choice' ? options() : [];
  await setDoc(sessionRef(),{
    question:q('questionInput').value.trim(),
    type,
    options:opts,
    imageData:'',
    isOpen:false,
    showResults:false,
    updatedAt:serverTimestamp()
  },{merge:true});
}

async function openRound(agendaId=null) {
  const type = q('typeInput').value;
  if (type === 'image') {
    await showImage({
      id: agendaId || null,
      question:q('questionInput').value.trim(),
      imageData:imageDataUrl,
      titleFontSize:Number(q('titleFontSizeInput')?.value || 54)
    });
    return;
  }

  const opts = type === 'choice' ? options() : [];
  const roundId = crypto.randomUUID();
  const payload = {
    question:q('questionInput').value.trim(),
    type,
    options:opts,
    imageData:'',
    titleFontSize:null,
    counts:opts.map(()=>0),
    isOpen:true,
    showResults:false,
    roundId,
    agendaId: agendaId || null,
    openedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };

  await setDoc(sessionRef(),payload,{merge:true});
  await setDoc(roundRef(roundId),{
    roundId,
    agendaId: agendaId || null,
    question:payload.question,
    type,
    options:opts,
    counts:payload.counts,
    total:0,
    status:'open',
    openedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  });
}

async function showImage(item) {
  if (!item?.imageData) {
    alert('Questa voce non contiene un’immagine.');
    return;
  }
  await setDoc(sessionRef(),{
    question:item.question || 'Immagine',
    type:'image',
    imageData:item.imageData,
    titleFontSize:Number(item.titleFontSize || 54),
    options:[],
    counts:[],
    isOpen:false,
    showResults:true,
    roundId:null,
    agendaId:item.id || null,
    updatedAt:serverTimestamp()
  },{merge:true});
}

async function closeRound() {
  const snap = await getDoc(sessionRef());
  if (!snap.exists()) return;
  const d = snap.data();

  if (d.type === 'image') {
    await updateDoc(sessionRef(),{
      showResults:false,
      isOpen:false,
      updatedAt:serverTimestamp()
    });
    return;
  }

  if (!d.roundId) {
    await updateDoc(sessionRef(),{isOpen:false,updatedAt:serverTimestamp()});
    return;
  }

  let historyData = {
    question:d.question || '',
    type:d.type || 'choice',
    options:d.options || [],
    counts:d.counts || [],
    total:(d.counts || []).reduce((a,b)=>a+b,0),
    status:'closed',
    closedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };

  if (d.type === 'wordcloud') {
    const words = await getRoundWords(d.roundId);
    const freq = wordFrequencies(words);
    historyData = {...historyData, total:words.length, wordCounts:freq};
  }

  await setDoc(roundRef(d.roundId),historyData,{merge:true});
  await updateDoc(sessionRef(),{isOpen:false,updatedAt:serverTimestamp()});
}

q('saveBtn').onclick = saveDraft;
q('openBtn').onclick = () => openRound(null);
q('closeBtn').onclick = closeRound;
q('showResults').onchange = () => updateDoc(sessionRef(),{showResults:q('showResults').checked,updatedAt:serverTimestamp()});

async function resetResponses() {
  const snap = await getDoc(sessionRef());
  if (!snap.exists()) return;
  const d = snap.data();
  if (d.type === 'image') return;

  const oldRoundId = d.roundId;
  if (oldRoundId) {
    let archived = {
      question:d.question || '', type:d.type || 'choice', options:d.options || [],
      counts:d.counts || [], total:(d.counts || []).reduce((a,b)=>a+b,0),
      status:'reset', closedAt:serverTimestamp(), updatedAt:serverTimestamp()
    };
    if (d.type === 'wordcloud') {
      const words = await getRoundWords(oldRoundId);
      archived.total = words.length;
      archived.wordCounts = wordFrequencies(words);
    }
    await setDoc(roundRef(oldRoundId),archived,{merge:true});
  }

  const newRoundId = crypto.randomUUID();
  const opts = d.type === 'choice' ? (d.options || options()) : [];
  await updateDoc(sessionRef(),{
    counts:opts.map(()=>0),
    showResults:false,
    roundId:newRoundId,
    isOpen:!!d.isOpen,
    openedAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  });
  await setDoc(roundRef(newRoundId),{
    roundId:newRoundId, agendaId:d.agendaId || null, question:d.question || '', type:d.type || 'choice', options:opts,
    counts:opts.map(()=>0), total:0, status:d.isOpen?'open':'draft',
    openedAt:serverTimestamp(), updatedAt:serverTimestamp()
  });
}
q('resetBtn').onclick = resetResponses;

function setAgendaStatus(message, isError=false) {
  const el = q('agendaStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
  el.classList.toggle('hidden', !message);
}

function currentInteractionPayload() {
  const type = q('typeInput').value;
  return {
    question:q('questionInput').value.trim(),
    type,
    options:type === 'choice' ? options() : [],
    imageData:type === 'image' ? imageDataUrl : '',
    titleFontSize:type === 'image' ? Number(q('titleFontSizeInput')?.value || 54) : null
  };
}

function validateInteraction(data) {
  if (!data.question) {
    alert(data.type === 'image' ? 'Inserisci un titolo per l’immagine.' : 'Inserisci prima la domanda.');
    return false;
  }
  if (data.type === 'choice' && data.options.length < 2) {
    alert('Inserisci almeno due opzioni di risposta.');
    return false;
  }
  if (data.type === 'image' && !data.imageData) {
    alert('Seleziona prima un’immagine.');
    return false;
  }
  return true;
}

q('agendaAddBtn').onclick = async () => {
  const data = currentInteractionPayload();
  if (!validateInteraction(data)) return;
  const btn = q('agendaAddBtn');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Salvataggio…';
  setAgendaStatus('Salvataggio nella scaletta…');

  try {
    const id = crypto.randomUUID();
    const maxOrder = agendaItems.reduce((m,x)=>Math.max(m,Number(x.order)||0),0);
    await setDoc(agendaItemRef(id),{
      ...data,
      order:maxOrder + 10,
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
    setAgendaStatus(data.type === 'image' ? 'Immagine aggiunta alla scaletta.' : 'Interazione aggiunta alla scaletta.');
  } catch (err) {
    console.error('Errore aggiunta scaletta:', err);
    setAgendaStatus('Errore Firebase: ' + (err?.message || 'elemento non salvato'), true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
};

q('agendaUpdateBtn').onclick = async () => {
  if (!selectedAgendaId) return;
  const data = currentInteractionPayload();
  if (!validateInteraction(data)) return;
  await setDoc(agendaItemRef(selectedAgendaId),{...data,updatedAt:serverTimestamp()},{merge:true});
  clearAgendaSelection();
};

q('agendaCancelBtn').onclick = clearAgendaSelection;

function clearAgendaSelection() {
  selectedAgendaId = null;
  q('agendaEditBar').classList.add('hidden');
  setImagePreview('');
  renderAgenda();
}

function loadAgendaItem(item, markSelected=true, scrollToEditor=true) {
  q('questionInput').value = item.question || '';
  q('typeInput').value = item.type || 'choice';
  q('optionsInput').value = (item.options || []).join('\n');
  setImagePreview(item.type === 'image' ? (item.imageData || '') : '');
  q('imageInput').value = '';
  if (q('titleFontSizeInput')) {
    q('titleFontSizeInput').value = String(item.titleFontSize || 54);
    updateTitleFontSizeLabel();
  }
  typeUI();

  if (markSelected) {
    selectedAgendaId = item.id;
    q('agendaEditBar').classList.remove('hidden');
  }

  renderAgenda();
  const editor = q('newInteractionSection');
  if (editor && scrollToEditor) {
    editor.open = true;
    editor.scrollIntoView({behavior:'smooth',block:'start'});
  }
}

async function openAgendaItem(item) {
  if (item.type === 'image') {
    selectedAgendaId = null;
    q('agendaEditBar').classList.add('hidden');
    await showImage(item);
    return;
  }
  loadAgendaItem(item,false,false);
  selectedAgendaId = null;
  q('agendaEditBar').classList.add('hidden');
  await openRound(item.id);
}

async function moveAgenda(index, direction) {
  const otherIndex = index + direction;
  if (otherIndex < 0 || otherIndex >= agendaItems.length) return;
  const a = agendaItems[index], b = agendaItems[otherIndex];
  const ao = Number(a.order)||((index+1)*10);
  const bo = Number(b.order)||((otherIndex+1)*10);
  const batch = writeBatch(db);
  batch.update(agendaItemRef(a.id),{order:bo,updatedAt:serverTimestamp()});
  batch.update(agendaItemRef(b.id),{order:ao,updatedAt:serverTimestamp()});
  await batch.commit();
}

async function deleteAgendaItem(item) {
  if (!confirm(`Eliminare dalla scaletta “${item.question || 'Senza titolo'}”?`)) return;
  await deleteDoc(agendaItemRef(item.id));
  if (selectedAgendaId === item.id) clearAgendaSelection();
}

async function setReveal(value) {
  await updateDoc(sessionRef(),{showResults:value,updatedAt:serverTimestamp()});
}

function isCurrentAgendaItem(item) {
  return !!currentSessionData && currentSessionData.agendaId === item.id;
}

function renderAgenda() {
  const el = q('agenda');
  if (!el) return;

  if (!agendaItems.length) {
    el.innerHTML = '<p class="muted agenda-empty">La scaletta è vuota. Apri “NUOVA Interazione” in fondo alla pagina per crearne una.</p>';
    return;
  }

  el.innerHTML = agendaItems.map((item,i) => {
    const current = isCurrentAgendaItem(item);
    const isImage = item.type === 'image';
    const revealLabel = currentSessionData?.showResults ? 'Nascondi' : 'Rivela';
    const stateLabel = current
      ? (isImage ? (currentSessionData?.showResults ? 'IN PROIEZIONE' : 'CARICATA') : (currentSessionData?.isOpen ? 'IN CORSO' : 'CARICATA'))
      : '';

    const typeLabel = isImage ? 'IMMAGINE' : item.type === 'wordcloud' ? 'WORD CLOUD' : 'VOTAZIONE';

    const imageThumb = isImage && item.imageData
      ? `<img class="agenda-image-thumb" src="${item.imageData}" alt="">`
      : '';

    const actionButtons = isImage
      ? `
        <button class="agenda-open" data-action="open">Mostra</button>
        <button class="secondary agenda-small" data-action="close" ${current?'':'disabled'}>Nascondi</button>
        <button class="secondary agenda-small" data-action="load">Modifica</button>`
      : `
        <button class="agenda-open" data-action="open">Apri</button>
        <button class="secondary agenda-small" data-action="close" ${current?'':'disabled'}>Chiudi</button>
        <button class="agenda-reveal agenda-small" data-action="reveal" ${current?'':'disabled'}>${revealLabel}</button>
        <button class="danger agenda-small" data-action="reset" ${current?'':'disabled'}>Azzera</button>
        <button class="secondary agenda-small" data-action="load">Modifica</button>`;

    return `
    <article class="agenda-item${selectedAgendaId===item.id?' selected':''}${current?' current':''}" data-id="${esc(item.id)}">
      <div class="agenda-num">${i+1}</div>
      <div class="agenda-main">
        <div class="agenda-topline">
          <div class="agenda-type">${typeLabel}</div>
          ${current?`<span class="agenda-live-badge">${stateLabel}</span>`:''}
        </div>
        <strong>${esc(item.question || 'Senza titolo')}</strong>
        ${item.type==='choice' ? `<div class="agenda-options">${(item.options||[]).map(x=>`<span>${esc(x)}</span>`).join('')}</div>` : ''}
        ${imageThumb}
      </div>
      <div class="agenda-actions">
        ${actionButtons}
        <div class="agenda-order">
          <button class="secondary agenda-icon" data-action="up" aria-label="Sposta su" ${i===0?'disabled':''}>↑</button>
          <button class="secondary agenda-icon" data-action="down" aria-label="Sposta giù" ${i===agendaItems.length-1?'disabled':''}>↓</button>
          <button class="danger agenda-icon" data-action="delete" aria-label="Elimina">×</button>
        </div>
      </div>
    </article>`;
  }).join('');

  el.querySelectorAll('.agenda-item').forEach((node,index) => {
    const item = agendaItems[index];
    node.querySelector('[data-action="open"]').onclick = () => openAgendaItem(item);
    node.querySelector('[data-action="close"]').onclick = () => isCurrentAgendaItem(item) && closeRound();

    const reveal = node.querySelector('[data-action="reveal"]');
    if (reveal) reveal.onclick = () => isCurrentAgendaItem(item) && setReveal(!currentSessionData?.showResults);

    const reset = node.querySelector('[data-action="reset"]');
    if (reset) reset.onclick = () => isCurrentAgendaItem(item) && resetResponses();

    node.querySelector('[data-action="load"]').onclick = () => loadAgendaItem(item,true);
    node.querySelector('[data-action="up"]').onclick = () => moveAgenda(index,-1);
    node.querySelector('[data-action="down"]').onclick = () => moveAgenda(index,1);
    node.querySelector('[data-action="delete"]').onclick = () => deleteAgendaItem(item);
  });
}

async function getRoundWords(roundId) {
  if (!roundId) return [];
  const snap = await getDocs(query(collection(db,'responses'),where('sessionId','==',currentSession),where('roundId','==',roundId)));
  return snap.docs.flatMap(x=>wordsFromResponse(x.data()));
}

function subscribeWords(roundId) {
  if (!roundId) {
    if (unsubWords) { unsubWords(); unsubWords = null; activeCloudRound = null; }
    render({type:'wordcloud'},[]);
    return;
  }
  if (activeCloudRound === roundId && unsubWords) return;
  if (unsubWords) unsubWords();
  activeCloudRound = roundId;
  const qq = query(collection(db,'responses'),where('sessionId','==',currentSession),where('roundId','==',roundId));
  unsubWords = onSnapshot(qq, snap => {
    const words = snap.docs.flatMap(x=>wordsFromResponse(x.data()));
    render({type:'wordcloud'},words);
  });
}

function wordsFromResponse(data) {
  if (Array.isArray(data?.texts)) return data.texts.map(x=>String(x||'').trim()).filter(Boolean);
  const one = String(data?.text || '').trim();
  return one ? [one] : [];
}

function canonicalAdminWord(raw) {
  const label = String(raw || '')
    .normalize('NFC')
    .replace(/^[\s"'“”‘’.,;:!?()\[\]{}]+|[\s"'“”‘’.,;:!?()\[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const key = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it');
  return {label,key};
}

function wordFrequencies(words) {
  const grouped = {};
  words.forEach(w => {
    const {label,key} = canonicalAdminWord(w);
    if (!key) return;
    if (!grouped[key]) grouped[key] = {label,count:0};
    if (/[^\x00-\x7F]/.test(label)) grouped[key].label = label;
    grouped[key].count++;
  });
  return Object.fromEntries(Object.values(grouped).map(x => [x.label, x.count]));
}

function render(d,words) {
  if (d?.type === 'image') {
    q('totalVotes').textContent = '—';
    q('results').innerHTML = d.imageData
      ? `<div class="admin-image-live"><img src="${d.imageData}" alt="Immagine in proiezione"></div>`
      : '<p class="muted">Nessuna immagine caricata.</p>';
    return;
  }

  if (d?.type === 'wordcloud') {
    const freq = wordFrequencies(words);
    const arr = Object.entries(freq).sort((a,b)=>b[1]-a[1]);
    q('totalVotes').textContent = words.length;
    const maxCount = Math.max(1,...arr.map(([,n])=>n));
    q('results').innerHTML = arr.length
      ? `<div class="cloud">${arr.map(([w,n],i)=>`<span class="cloud-word rank-${Math.min(i,5)}" style="--weight:${(n/maxCount).toFixed(3)}" title="${n} ${n===1?'risposta':'risposte'}">${esc(w)}${n>1?`<sup>${n}</sup>`:''}</span>`).join('')}</div>`
      : '<p class="muted">In attesa delle prime parole…</p>';
    return;
  }

  const counts = d?.counts || [];
  const opts = d?.options || [];
  const total = counts.reduce((a,b)=>a+b,0);
  q('totalVotes').textContent = total;
  const max = Math.max(0,...counts);

  q('results').innerHTML = opts.map((o,i) => {
    const n = counts[i] || 0;
    const p = total ? Math.round(n*100/total) : 0;
    const lead = total > 0 && n === max ? ' leader' : '';
    return `<div class="result-row${lead}"><div class="result-meta"><strong>${esc(o)}</strong><span>${n} voti · ${p}%</span></div><div class="bar"><i style="width:${p}%"></i></div></div>`;
  }).join('');
}

function renderHistory(rounds) {
  const el = q('history');
  if (!rounds.length) {
    el.innerHTML = '<p class="muted">Nessuna votazione archiviata. La prima comparirà qui appena apri una tornata.</p>';
    return;
  }

  el.innerHTML = rounds.map((r,index) => {
    const status = r.status === 'open' ? 'IN CORSO' : r.status === 'reset' ? 'AZZERATA' : 'CONCLUSA';
    const date = formatDate(r.closedAt || r.openedAt);
    const total = Number.isFinite(r.total) ? r.total : (r.counts || []).reduce((a,b)=>a+b,0);
    let detail = '';

    if (r.type === 'wordcloud') {
      const top = Object.entries(r.wordCounts || {}).sort((a,b)=>b[1]-a[1]).slice(0,12);
      detail = top.length
        ? `<div class="history-cloud">${top.map(([w,n])=>`<span>${esc(w)} <b>${n}</b></span>`).join('')}</div>`
        : '<p class="muted compact">Nessuna parola registrata.</p>';
    } else {
      detail = (r.options || []).map((o,i) => {
        const n = (r.counts || [])[i] || 0;
        const p = total ? Math.round(n*100/total) : 0;
        return `<div class="history-result"><span>${esc(o)}</span><strong>${n} · ${p}%</strong></div>`;
      }).join('');
    }

    return `<details class="history-item" ${index===0?'open':''}>
      <summary>
        <span><span class="history-badge ${r.status==='open'?'live':''}">${status}</span><strong>${esc(r.question || 'Senza titolo')}</strong></span>
        <span class="history-summary">${total} ${total===1?'risposta':'risposte'} · ${esc(date)}</span>
      </summary>
      <div class="history-detail">
        <div class="history-meta">${r.type==='wordcloud'?'Word Cloud':'Scelta / voto'} · ID ${esc(r.id.slice(0,8))}</div>
        ${detail}
      </div>
    </details>`;
  }).join('');
}

function timeMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds) return v.seconds*1000;
  return 0;
}

function formatDate(v) {
  const ms = timeMs(v);
  if (!ms) return 'adesso';
  return new Intl.DateTimeFormat('it-IT',{
    day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'
  }).format(new Date(ms));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function updateUrls() {
  const base = location.href.replace(/admin\.html.*$/,'');
  const suffix = `?s=${encodeURIComponent(currentSession)}`;
  q('participantUrl').textContent = `${base}${suffix}`;
  q('displayUrl').textContent = `${base}display.html${suffix}`;
  q('screenLink').href = `${base}display.html${suffix}`;
}

subscribe();
