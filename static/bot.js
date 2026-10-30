(() => {
  'use strict';
  const state={csrf:'',upload:null,captions:null,style:'luxe',captionPosition:'bottom_center',captionColor:'#FFFFFF',quickTypeSpeed:'soft',typingSoundEnabled:true,typingSoundPreset:'iphone_keyboard',typingSoundVolume:35,job:null,poll:null};
  const $=selector=>document.querySelector(selector);
  const styleLabels={luxe:'Люкс-акцент',punch:'Ритм фразы',kinetic_lime:'Лайм-кинетика',quick_type:'Печатная машинка',accent:'Редакция',sticker:'Тёплый стикер',neon:'Ночной свет',magazine:'Обложка',glass:'Мягкая карточка',cinema:'Кино'};
  const positionLabels={bottom_center:'снизу по центру',center:'по центру',top_center:'сверху по центру',bottom_left:'слева снизу',bottom_right:'справа снизу'};
  const colorLabels={'#FFFFFF':'белый','#DFFB00':'лайм','#F6BD50':'золото','#FF7599':'розовый','#8DE8FF':'голубой'};
  const typingSoundLabels={iphone_keyboard:'клавиатура iPhone',game_buttons:'быстрые кнопки',typewriter:'печатная машинка',sound_four:'плотные клавиши',sound_five:'сухие клавиши'};
  const typingSoundSources=Object.freeze({iphone_keyboard:'/static/sounds/iphone_keyboard.mp3',game_buttons:'/static/sounds/game_buttons.mp3',typewriter:'/static/sounds/typewriter.mp3',sound_four:'/static/sounds/sound_four.mp3',sound_five:'/static/sounds/sound_five.mp3'});
  let previewAudio=null;
  const phaseLabels={QUEUED:'В очереди',VALIDATING:'Проверяем видео',PREPROCESSING:'Готовим звук',TRANSCRIBING:'Распознаём речь',RENDERING:'Собираем видео',BURNING_CAPTIONS:'Добавляем субтитры',VERIFYING:'Проверяем результат',EXPORTING:'Готовим файлы',COMPLETED:'Готово'};
  const note=$('#action-note'),button=$('#make-video'),uploadInfo=$('#upload-info'),captionInfo=$('#caption-info'),status=$('#status-card');
  const safeText=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const mib=value=>(Number(value||0)/1024/1024).toFixed(1)+' МБ';
  async function json(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.headers||{}),...(options.method&&options.method!=='GET'?{'X-CSRF-Token':state.csrf}:{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||'Не удалось выполнить действие.');
    return data;
  }
  async function boot(){
    try{const data=await json('/api/bootstrap');state.csrf=data.csrf;}
    catch(error){showProblem(error.message);}
  }
  function setButton(){
    button.disabled=!state.upload;
    const label=styleLabels[state.style]||'Люкс-акцент';
    const position=positionLabels[state.captionPosition]||'снизу по центру';
    const color=colorLabels[state.captionColor]||'свой цвет';
    if(!state.upload){note.textContent='Сначала выбери видео.';return;}
    const typeNote=state.style==='quick_type'
      ?' · Печать: '+({soft:'мягко',normal:'обычно',fast:'быстро'}[state.quickTypeSpeed]||'мягко')+(state.typingSoundEnabled?' · '+(typingSoundLabels[state.typingSoundPreset]||'клавиатура iPhone')+' '+state.typingSoundVolume+'%':' · без звука клавиатуры')
      :'';
    note.textContent=state.captions
      ?'Видео и готовые субтитры готовы. Стиль: '+label+' · '+color+' · '+position+typeNote+'.'
      :'Видео готово. Бот сам распознает речь. Стиль: '+label+' · '+color+' · '+position+typeNote+'.';
  }
  function showProblem(message){
    status.hidden=false;$(' #status-title'.trim()).textContent='Не получилось';$('#status-percent').textContent='';$('#status-copy').textContent=message;$('#status-progress').style.width='0%';
  }
  function setStatus(title,percent,copy){
    status.hidden=false;$('#status-title').textContent=title;$('#status-percent').textContent=percent+'%';$('#status-copy').textContent=copy||'Не закрывай страницу — видео обрабатывается на этом компьютере.';$('#status-progress').style.width=Math.max(2,Math.min(100,percent))+'%';
  }
  function renderUpload(progress,message){
    uploadInfo.hidden=false;uploadInfo.innerHTML='<strong>'+safeText(state.upload?.name||'Загрузка видео')+'</strong><small>'+safeText(message||'Загружаем…')+'</small><progress max="100" value="'+Math.max(0,Math.min(100,progress||0))+'"></progress>';
  }
  function uploadFile(file){
    if(!file)return;
    if(!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)){renderUpload(0,'Выбери видео MP4, MOV, M4V, WebM, MKV или AVI.');return;}
    state.upload=null;setButton();renderUpload(0,'Начинаем загрузку…');
    const request=new XMLHttpRequest();
    request.open('POST','/api/uploads?name='+encodeURIComponent(file.name));
    request.setRequestHeader('Content-Type','application/octet-stream');request.setRequestHeader('X-CSRF-Token',state.csrf);
    request.timeout=60*60*1000;
    request.upload.onprogress=event=>{if(event.lengthComputable)renderUpload(Math.round(event.loaded/event.total*100),'Загрузка '+Math.round(event.loaded/event.total*100)+'%');};
    request.onerror=()=>renderUpload(0,'Не удалось загрузить видео. Повтори ещё раз.');
    request.ontimeout=()=>renderUpload(0,'Загрузка заняла слишком много времени.');
    request.onload=()=>{
      let data={};try{data=JSON.parse(request.responseText||'{}');}catch{}
      if(request.status<200||request.status>=300){renderUpload(0,data.error||'Видео не прошло проверку.');return;}
      state.upload=data;renderUpload(100,'Готово · '+Number(data.media.duration_seconds||0).toFixed(1)+' с · '+mib(data.media.size_bytes));setButton();
    };
    request.send(file);
  }
  function renderCaptions(message,problem=false){
    captionInfo.hidden=false;
    captionInfo.classList.toggle('problem',problem);
    const name=state.captions?.name||'Файл субтитров';
    captionInfo.innerHTML='<strong>'+safeText(name)+'</strong><small>'+safeText(message)+'</small>';
  }
  function uploadCaptions(file){
    if(!file)return;
    if(!/\.(srt|vtt|ass)$/i.test(file.name)){renderCaptions('Выбери файл SRT, VTT или ASS.',true);return;}
    state.captions=null;setButton();renderCaptions('Загружаем готовые субтитры…');
    const request=new XMLHttpRequest();
    request.open('POST','/api/captions?name='+encodeURIComponent(file.name));
    request.setRequestHeader('Content-Type','application/octet-stream');request.setRequestHeader('X-CSRF-Token',state.csrf);
    request.timeout=10*60*1000;
    request.upload.onprogress=event=>{if(event.lengthComputable)renderCaptions('Загрузка '+Math.round(event.loaded/event.total*100)+'%');};
    request.onerror=()=>renderCaptions('Не удалось загрузить файл. Повтори ещё раз.',true);
    request.ontimeout=()=>renderCaptions('Загрузка заняла слишком много времени.',true);
    request.onload=()=>{
      let data={};try{data=JSON.parse(request.responseText||'{}');}catch{}
      if(request.status<200||request.status>=300){renderCaptions(data.error||'Файл субтитров не прошёл проверку.',true);return;}
      state.captions=data.caption||data;
      if(!state.captions?.id){state.captions=null;renderCaptions('Сервер не вернул данные субтитров.',true);return;}
      state.captions.name=state.captions.name||file.name;
      renderCaptions('Готово. Бот возьмёт этот текст и его тайминги.');setButton();
    };
    request.send(file);
  }
  function chooseStyle(style){
    state.style=style;document.querySelectorAll('.style').forEach(item=>{const selected=item.dataset.style===style;item.classList.toggle('selected',selected);item.setAttribute('aria-checked',selected?'true':'false');});updateQuickTypeOptions();setButton();
  }
  function chooseCaptionPosition(position){
    state.captionPosition=position;
    document.querySelectorAll('[data-caption-position]').forEach(item=>{const selected=item.dataset.captionPosition===position;item.classList.toggle('selected',selected);item.setAttribute('aria-checked',selected?'true':'false');});
    setButton();
  }
  function chooseCaptionColor(color,custom=false){
    const normalized=String(color||'').toUpperCase();
    if(!/^#[0-9A-F]{6}$/.test(normalized))return;
    state.captionColor=normalized;
    const picker=$('#caption-color-custom');
    const customLabel=$('#custom-color-label');
    if(picker)picker.value=normalized.toLowerCase();
    if(customLabel){
      customLabel.classList.toggle('selected',custom);
      customLabel.style.setProperty('--picked-color',normalized);
    }
    document.querySelectorAll('[data-caption-color]').forEach(item=>{
      const selected=!custom&&item.dataset.captionColor===normalized;
      item.classList.toggle('selected',selected);
      item.setAttribute('aria-checked',selected?'true':'false');
    });
    setButton();
  }
  function updateQuickTypeOptions(){
    const panel=$('#quick-type-options');
    const sound=$('#typing-sound-enabled');
    const volume=$('#typing-sound-volume');
    const value=$('#typing-sound-volume-value');
    const visible=state.style==='quick_type';
    panel.hidden=!visible;
    sound.checked=state.typingSoundEnabled;
    volume.value=String(state.typingSoundVolume);
    volume.disabled=!state.typingSoundEnabled;
    value.textContent=state.typingSoundVolume+'%';
    panel.classList.toggle('sound-off',!state.typingSoundEnabled);
    document.querySelectorAll('[data-typing-sound-preset]').forEach(item=>{
      const selected=item.dataset.typingSoundPreset===state.typingSoundPreset;
      item.closest('.sound-preset-card')?.classList.toggle('selected',selected);
      item.setAttribute('aria-checked',selected?'true':'false');
      item.disabled=!state.typingSoundEnabled;
    });
    document.querySelectorAll('[data-preview-sound]').forEach(item=>{item.disabled=!state.typingSoundEnabled;});
  }
  function chooseQuickTypeSpeed(speed){
    if(!['soft','normal','fast'].includes(speed))return;
    state.quickTypeSpeed=speed;
    document.querySelectorAll('[data-quick-type-speed]').forEach(item=>{
      const selected=item.dataset.quickTypeSpeed===speed;
      item.classList.toggle('selected',selected);
      item.setAttribute('aria-checked',selected?'true':'false');
    });
    setButton();
  }
  function stopTypingPreview(){
    if(previewAudio){
      previewAudio.pause();
      previewAudio.currentTime=0;
      previewAudio=null;
    }
    document.querySelectorAll('.sound-preview').forEach(item=>{
      item.classList.remove('playing');
      item.textContent='▶';
      item.setAttribute('aria-pressed','false');
    });
  }
  function setTypingSoundEnabled(enabled){
    state.typingSoundEnabled=Boolean(enabled);
    if(!state.typingSoundEnabled)stopTypingPreview();
    updateQuickTypeOptions();
    setButton();
  }
  function setTypingSoundVolume(value){
    const next=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
    state.typingSoundVolume=next;
    if(previewAudio)previewAudio.volume=next/100;
    updateQuickTypeOptions();
    setButton();
  }
  function chooseTypingSoundPreset(preset){
    if(!Object.prototype.hasOwnProperty.call(typingSoundSources,preset))return;
    stopTypingPreview();
    state.typingSoundPreset=preset;
    updateQuickTypeOptions();
    setButton();
  }
  function previewTypingSound(preset,trigger){
    if(!state.typingSoundEnabled||state.typingSoundVolume<=0)return;
    const source=typingSoundSources[preset];
    if(!source)return;
    if(previewAudio?.dataset.preset===preset){
      stopTypingPreview();
      return;
    }
    stopTypingPreview();
    const audio=new Audio(source);
    audio.dataset.preset=preset;
    previewAudio=audio;
    audio.preload='auto';
    audio.volume=state.typingSoundVolume/100;
    const finish=()=>{
      if(previewAudio!==audio)return;
      stopTypingPreview();
    };
    audio.addEventListener('ended',finish,{once:true});
    audio.addEventListener('error',finish,{once:true});
    trigger?.classList.add('playing');
    trigger?.setAttribute('aria-pressed','true');
    if(trigger)trigger.textContent='■';
    audio.play().catch(finish);
  }
  async function start(){
    if(!state.upload||button.disabled)return;
    button.disabled=true;button.textContent='Запускаю…';
    const usingReadyCaptions=Boolean(state.captions?.id);
    const settings={caption_enabled:true,caption_style:state.style,caption_position:state.captionPosition,caption_color:state.captionColor,quick_type_speed:state.quickTypeSpeed,typing_sound_enabled:state.typingSoundEnabled,typing_sound_preset:state.typingSoundPreset,typing_sound_volume:state.typingSoundVolume,style:'Glass',output_resolution:'vertical_1080',video_quality:'high',audio_preset:'clear_speech',noise_reduction:'medium',normalize_audio:true,export_audio:false,video_enhancement:'balanced',color_grade:'natural',trim_start:0,trim_end:null};
    try{state.job=await json('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upload_id:state.upload.id,caption_id:state.captions?.id||null,settings,request_id:crypto.randomUUID()})});setStatus('Видео принято',1,usingReadyCaptions?'Встраиваем твои готовые субтитры в ролик.':'Сейчас бот распознает речь и добавит субтитры.');poll();}
    catch(error){showProblem(error.message);button.disabled=false;button.textContent='Сделать субтитры →';}
  }
  async function poll(){
    clearTimeout(state.poll);if(!state.job)return;
    try{
      const data=await json('/api/jobs');const job=(data.jobs||[]).find(item=>item.id===state.job.id);
      if(!job)throw new Error('Не удалось найти задачу.');state.job=job;
      if(job.status==='completed'){complete(job);return;}
      if(job.status==='failed'||job.status==='cancelled'){throw new Error(job.error||'Обработка остановлена.');}
      const progress=job.progress?.percent||3;setStatus(phaseLabels[job.phase]||'Обрабатываем ролик',progress,'Не закрывай страницу — видео обрабатывается на этом компьютере.');state.poll=setTimeout(poll,1100);
    }catch(error){showProblem(error.message);button.disabled=false;button.textContent='Попробовать ещё раз';}
  }
  function complete(job){
    setStatus('Ролик готов',100,'Субтитры добавлены в видео.');button.textContent='Сделать ещё один';button.disabled=false;
    const base='/api/jobs/'+encodeURIComponent(job.id);$('#result-video').src=base+'/video';$('#download-video').href=base+'/video?download=1';$('#download-srt').href=base+'/subtitles';$('#result').hidden=false;document.querySelectorAll('.steps li').forEach((item,index)=>item.classList.toggle('active',index===2));$('#result').scrollIntoView({behavior:'smooth',block:'start'});
  }
  $('#video-file').addEventListener('change',event=>uploadFile(event.target.files?.[0]));
  $('#caption-file').addEventListener('change',event=>uploadCaptions(event.target.files?.[0]));
  const zone=$('#dropzone');for(const type of ['dragenter','dragover'])zone.addEventListener(type,event=>{event.preventDefault();zone.classList.add('dragging');});for(const type of ['dragleave','drop'])zone.addEventListener(type,event=>{event.preventDefault();zone.classList.remove('dragging');});zone.addEventListener('drop',event=>uploadFile(event.dataTransfer.files?.[0]));
  document.querySelectorAll('.style').forEach(item=>item.addEventListener('click',()=>chooseStyle(item.dataset.style)));
  document.querySelectorAll('[data-caption-position]').forEach(item=>item.addEventListener('click',()=>chooseCaptionPosition(item.dataset.captionPosition)));
  document.querySelectorAll('[data-caption-color]').forEach(item=>item.addEventListener('click',()=>chooseCaptionColor(item.dataset.captionColor)));
  ['input','change'].forEach(type=>$('#caption-color-custom').addEventListener(type,event=>chooseCaptionColor(event.target.value,true)));
  document.querySelectorAll('[data-quick-type-speed]').forEach(item=>item.addEventListener('click',()=>chooseQuickTypeSpeed(item.dataset.quickTypeSpeed)));
  document.querySelectorAll('[data-typing-sound-preset]').forEach(item=>item.addEventListener('click',()=>chooseTypingSoundPreset(item.dataset.typingSoundPreset)));
  document.querySelectorAll('[data-preview-sound]').forEach(item=>item.addEventListener('click',event=>{event.stopPropagation();previewTypingSound(item.dataset.previewSound,item);}));
  $('#typing-sound-enabled').addEventListener('change',event=>setTypingSoundEnabled(event.target.checked));
  $('#typing-sound-volume').addEventListener('input',event=>setTypingSoundVolume(event.target.value));
  updateQuickTypeOptions();
  button.addEventListener('click',start);boot();
})();





