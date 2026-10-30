'use strict';
let revisionEditor=null;
function updateEditorDirty(state){
  state.textDirty=state.words.some((word,i)=>word!==state.data.words[i].word);
  state.dirty=state.textDirty||state.omit.size!==state.data.omit.length||state.data.omit.some(i=>!state.omit.has(i))||(state.durationMode??state.data.settings.duration_mode)!==state.data.settings.duration_mode;
}
function mountEditor(){
  const job=jobs.find(j=>j.id===detailId);
  const actions=document.querySelector('.actions');
  if(job?.status!=='completed'||!actions)return;
  if(caps?.features?.transcript_editor===false&&caps?.features?.telegram_delivery===false)return;
  const button=document.createElement('button');button.textContent='Исправить текст и монтаж';button.id='open-editor';
  actions.append(button);
  if(supportsShortform()&&job.result.duration>60){
    const shorten=document.createElement('button');shorten.id='shorten-60';shorten.textContent='Собрать версию до 60 секунд';actions.append(shorten);
    shorten.onclick=async()=>{
      shorten.disabled=true;
      try{
        const data=await api(`/api/jobs/${job.id}/editor`);
        const result=await api(`/api/jobs/${job.id}/revise`,{method:'POST',data:{request_id:crypto.randomUUID(),revision:{words:data.words.map(w=>w.word),omit:data.omit},settings:{...data.settings,duration_mode:'short60'}}});
        detailId=result.id;await refresh(true);toast('ИИ соберёт короткую версию. Исходник и предыдущий монтаж сохранены.');
      }catch(err){toast(err.message);shorten.disabled=false;}
    };
  }
  const send=document.createElement('button');send.textContent='Отправить в Telegram';send.id='send-telegram';actions.append(send);
  send.onclick=async()=>{send.disabled=true;try{await api(`/api/jobs/${job.id}/deliver`,{method:'POST'});toast('Отправка поставлена в очередь. Бот пришлёт видео в личный чат.');}catch(err){toast(err.message);}finally{send.disabled=false;}};
  button.onclick=async()=>{button.disabled=true;try{const data=await api(`/api/jobs/${job.id}/editor`);revisionEditor={jobId:job.id,data,words:data.words.map(w=>w.word),omit:new Set(data.omit),dirty:false,textDirty:false,review:data.semantic_review};showEditor();}catch(err){toast(err.message);}finally{button.disabled=false;}};
}
function closeEditor(){
  if(revisionEditor?.dirty&&!confirm('Не сохранять внесённые правки?'))return;
  clearTimeout(revisionEditor?.reviewTimer);revisionEditor=null;document.querySelector('#revision-dialog')?.remove();
}
function showEditor(){
  const state=revisionEditor,data=state.data;
  document.querySelector('#revision-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='revision-dialog';dialog.className='revision-dialog';
  dialog.innerHTML=`<div class="page-head"><div><div class="eyebrow">Новая версия ролика</div><h2>Проверь каждое слово</h2></div><button id="close-editor" aria-label="Закрыть редактор">✕</button></div><p>Правка меняет только субтитры, не произнесённую речь. Галочка «Убрать» удаляет соответствующий фрагмент видео и звука. Исходник и предыдущая версия сохраняются.</p><div class="editor-grid"><div class="editor-source"><video controls playsinline preload="metadata" src="/api/jobs/${state.jobId}/source" id="editor-video"></video><p>Исходник · таймкоды до сокращения</p><div id="revision-summary" role="status"></div><button class="primary" id="render-revision">Собрать новую версию</button><label class="toggle"><span>Применить текущие настройки из вкладки «Монтаж»</span><input id="revision-style" type="checkbox"></label><button id="clear-omitted">Вернуть все фрагменты</button></div><div><section class="card"><h3>Что можно проверить</h3>${data.suggestions.length?data.suggestions.map((s,i)=>`<div class="suggestion"><p><b>${e(s.reason)}</b><br>${e(s.text)}</p><button data-suggestion="${i}">Отметить для удаления</button></div>`).join(''):'<p>Очевидных монтажных ремарок не найдено. Это не означает, что в ролике нет лишних фраз.</p>'}<small>Это подсказки по текстовым правилам, а не гарантированное понимание смысла. Решение принимаешь ты.</small></section><div class="word-editor">${data.words.map((w,i)=>`<div class="word-row ${state.omit.has(i)?'omitted':''}" data-word-row="${i}"><button class="word-time" data-seek="${i}" title="Прослушать слово">${w.start.toFixed(2)} с</button><input type="text" data-word-index="${i}" aria-label="Слово ${i+1}" maxlength="120" value="${e(state.words[i])}"><label><input type="checkbox" data-omit="${i}" ${state.omit.has(i)?'checked':''}> Убрать</label></div>`).join('')}</div></div></div>`;
  document.body.append(dialog);dialog.showModal();
  state.durationMode=supportsShortform()?(state.durationMode??data.settings.duration_mode):'original';
  if(supportsShortform()){
    const duration=document.createElement('label');duration.className='field';
    duration.innerHTML=`<span>Длительность новой версии</span><select id="revision-duration" aria-label="Длительность новой версии"><option value="original" ${state.durationMode!=='short60'?'selected':''}>Без лимита · только мои вырезки</option><option value="short60" ${state.durationMode==='short60'?'selected':''}>До 60 секунд · ИИ может убрать ещё фразы</option></select>`;
    dialog.querySelector('#render-revision').before(duration);
    duration.querySelector('select').onchange=ev=>{state.durationMode=ev.target.value;updateEditorDirty(state);};
  }
  dialog.addEventListener('cancel',ev=>{ev.preventDefault();closeEditor();});
  dialog.querySelector('#close-editor').onclick=closeEditor;
  dialog.querySelectorAll('[data-word-index]').forEach(input=>input.oninput=()=>{state.words[Number(input.dataset.wordIndex)]=input.value;updateEditorDirty(state);});
  function select(index,checked){if(checked)state.omit.add(index);else state.omit.delete(index);updateEditorDirty(state);dialog.querySelector(`[data-omit="${index}"]`).checked=checked;dialog.querySelector(`[data-word-row="${index}"]`).classList.toggle('omitted',checked);summary();}
  dialog.querySelectorAll('[data-omit]').forEach(input=>input.onchange=()=>select(Number(input.dataset.omit),input.checked));
  dialog.querySelectorAll('[data-suggestion]').forEach(button=>button.onclick=()=>data.suggestions[Number(button.dataset.suggestion)].indices.forEach(i=>select(i,true)));
  dialog.querySelectorAll('[data-seek]').forEach(button=>button.onclick=()=>{state.audition=null;const video=dialog.querySelector('video');video.currentTime=Math.max(0,data.words[Number(button.dataset.seek)].start-.2);video.play().catch(()=>toast('Нажми воспроизведение в плеере.'));});
  dialog.querySelector('#clear-omitted').onclick=()=>[...state.omit].forEach(i=>select(i,false));
  function summary(){dialog.querySelector('#revision-summary').textContent=`Отмечено для удаления: ${state.omit.size} из ${state.words.length} слов. Точная длительность будет рассчитана по кадрам при сборке.`;}
  summary();
  mountSemanticReview(state,dialog,select);
  dialog.querySelector('#render-revision').onclick=async()=>{
    const button=dialog.querySelector('#render-revision');button.disabled=true;
    try{const result=await api(`/api/jobs/${state.jobId}/revise`,{method:'POST',data:{request_id:crypto.randomUUID(),revision:{words:state.words,omit:[...state.omit].sort((a,b)=>a-b)},settings:{...(dialog.querySelector('#revision-style').checked?draft:data.settings),duration_mode:state.durationMode}}});state.dirty=false;closeEditor();detailId=result.id;await refresh(true);toast('Новая версия в очереди. Распознавание повторно не запускается.');}catch(err){toast(err.message);button.disabled=false;}
  };
}
window.addEventListener('beforeunload',ev=>{if(revisionEditor?.dirty){ev.preventDefault();ev.returnValue='';}});

function mountSemanticReview(state,dialog,select){
  if(localNoLLM()||caps?.features?.semantic_cut_suggestions===false)return;
  const section=document.createElement('section');section.className='card semantic-review';section.id='semantic-review';
  dialog.querySelector('.word-editor').parentElement.querySelector('h3').textContent='Подсказки по правилам';
  dialog.querySelector('.word-editor').parentElement.prepend(section);
  const video=dialog.querySelector('video');
  video.addEventListener('timeupdate',()=>{const a=state.audition;if(!a)return;if(a.skip&&video.currentTime>=a.skip[0]&&video.currentTime<a.skip[1]){video.currentTime=a.skip[1];a.skip=null;}if(video.currentTime>=a.end){video.pause();state.audition=null;}});
  function audition(start,end,skip=null){state.audition={end,skip};video.currentTime=Math.max(0,start);video.play().catch(()=>toast('Нажми воспроизведение в плеере.'));}
  function draw(){
    const r=state.review||{status:'not_started'},active=['queued','running','cancelling'].includes(r.status);
    const status={not_started:'Анализ ещё не запускался.',queued:'В очереди: монтаж и ИИ-анализ выполняются по одному.',running:'Qwen читает расшифровку. Можно закрыть редактор и вернуться позже.',cancelling:'Останавливаем анализ…',cancelled:'Анализ отменён. Видео не изменено.',failed:r.error||'Анализ не завершён.',completed:`Анализ завершён · ${r.elapsed_seconds?.toFixed(1)||'—'} с.`}[r.status];
    section.innerHTML=`<h3>ИИ: смысловой монтаж</h3><p>Локальная Qwen ищет дубли, неудачные начала и монтажные ремарки. Анализирует только текст сохранённой версии, не интонацию и изображение. Ничего не удаляет сама.</p><p role="status">${e(status)}</p>${(r.warnings||[]).map(w=>`<p class="notice">${e(w)}</p>`).join('')}${r.status==='completed'?`<p>Предложений: ${(r.suggestions||[]).length}. Это не гарантия, что найдены все лишние фразы.</p>`:`<button id="start-analysis" ${active||!caps.qwen?'disabled':''}>${caps.qwen?'Найти лишние фразы':'Нужна установленная Qwen'}</button>`}${active?'<button id="cancel-analysis">Отменить анализ</button>':''}<div class="semantic-proposals">${(r.suggestions||[]).map((s,i)=>`<article class="semantic-proposal"><div class="eyebrow">${e({aside:'Монтажная ремарка',restart:'Возможный неудачный дубль',duplicate:'Возможный повтор'}[s.kind])} · ${s.start.toFixed(1)}–${s.end.toFixed(1)} с</div><p><b>Предлагается убрать:</b> ${e(s.text)}</p><p>${e(s.reason)}</p>${s.keep_text?`<p><b>Останется:</b> ${e(s.keep_text)}</p>`:''}<p><b>Стык по тексту:</b> ${e(s.join_preview)}</p>${(s.warnings||[]).map(w=>`<p class="notice">${e(w)}</p>`).join('')}<div class="actions"><button data-audition="${i}">Слушать фрагмент</button>${s.keep_text?`<button data-keep-audition="${i}">Слушать оставляемое</button>`:''}<button data-join-audition="${i}">Послушать черновой стык</button><button data-accept-cut="${i}">Отметить для удаления</button></div><small>Вырезка ≈ ${s.cut_seconds?.toFixed(1)||'—'} с. Черновой стык — просмотр с пропуском; точная склейка создаётся при сборке новой версии.</small></article>`).join('')}</div>`;
    const run=section.querySelector('#start-analysis');if(run)run.onclick=async()=>{
      if(state.textDirty){toast('Сначала собери версию с исправленным текстом: анализ использует сохранённую расшифровку.');return;}
      run.disabled=true;try{state.review=await api(`/api/jobs/${state.jobId}/analysis`,{method:'POST'});draw();schedule();}catch(err){toast(err.message);run.disabled=false;}
    };
    const cancel=section.querySelector('#cancel-analysis');if(cancel)cancel.onclick=async()=>{cancel.disabled=true;try{state.review=await api(`/api/jobs/${state.jobId}/analysis/cancel`,{method:'POST'});draw();}catch(err){toast(err.message);cancel.disabled=false;}};
    section.querySelectorAll('[data-audition]').forEach(b=>b.onclick=()=>{const s=r.suggestions[Number(b.dataset.audition)];audition(s.start-.2,s.end+.2);});
    section.querySelectorAll('[data-keep-audition]').forEach(b=>b.onclick=()=>{const s=r.suggestions[Number(b.dataset.keepAudition)];audition(s.keep_start-.2,state.data.words[s.keep_indices.at(-1)].end+.2);});
    section.querySelectorAll('[data-join-audition]').forEach(b=>b.onclick=()=>{const s=r.suggestions[Number(b.dataset.joinAudition)];audition(Math.max(0,s.cut_start-1.5),Math.min(state.data.source_duration,s.cut_end+1.5),[s.cut_start,s.cut_end]);});
    section.querySelectorAll('[data-accept-cut]').forEach(b=>b.onclick=()=>{
      if(state.textDirty){toast('Текст изменён: рекомендация относится к сохранённой расшифровке.');return;}
      const s=r.suggestions[Number(b.dataset.acceptCut)];
      if(s.keep_indices.some(i=>state.omit.has(i))){toast('Фраза, которую нужно оставить, уже отмечена для удаления. Сначала верни её.');return;}
      if(s.indices.every(i=>state.omit.has(i))){s.indices.forEach(i=>select(i,false));b.textContent='Отметить для удаления';}
      else{s.indices.forEach(i=>select(i,true));b.textContent='Вернуть фрагмент';toast('Отмечено. Проверь и нажми «Собрать новую версию» — исходник сохранится.');}
    });
  }
  function schedule(){
    clearTimeout(state.reviewTimer);
    if(!['queued','running','cancelling'].includes(state.review?.status))return;
    state.reviewTimer=setTimeout(async()=>{if(revisionEditor!==state||!dialog.isConnected)return;try{state.review=await api(`/api/jobs/${state.jobId}/analysis`);draw();}catch(err){toast(err.message);}schedule();},3000);
  }
  draw();schedule();
}
