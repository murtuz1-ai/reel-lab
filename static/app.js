'use strict';
const app=document.querySelector('#app');
let csrf='',draft=null,caps=null,jobs=[],upload=null,busy=false,blob=null,saveChain=Promise.resolve(),saveFailed=false;
let page='montage',detailId=null,toastTimer,poll,saveTimer,saveCount=0,linked=null;
let operator=false,usage=null;
let principal='',sessionRecovery=null,selectedFile=null,uploadError='',uploadPercent=0,uploadPhase='';
let creatingJob=false,jobRequest=null,batch=[],queue=null;
let resumeTransfer=null;
let nativeDownloadRequest=null;
const nativeDownloadLinkState=new Map();
let jobProgressListenersMounted=false;
let telegramInit=window.Telegram?.WebApp?.initData||new URLSearchParams(location.hash.slice(1)).get('tgWebAppData')||'';
const telegramMode=document.querySelector('meta[name="reellab-mode"]')?.content==='telegram'||Boolean(telegramInit);
let telegramSDKWait=null,starting=false;
const telegramReadySDKs=new WeakSet(),telegramWindowSDKs=new WeakSet();
const telegramHeaderColors=new WeakMap();
const telegramViewportListeners=new Set();
function clearTelegramLaunchHash(){
  if(new URLSearchParams(location.hash.slice(1)).has('tgWebAppData')){
    try{history.replaceState(null,'',location.pathname);}catch{} // Keep auth data in memory, never in storage.
  }
}
function telegramReady(){
  // A failed API must not leave the error page hidden behind Telegram's loader.
  const sdk=window.Telegram?.WebApp;
  if(!sdk||telegramReadySDKs.has(sdk))return;
  telegramReadySDKs.add(sdk);
  try{sdk.ready();}catch{}
}
function updateTelegramViewport(sdk){
  // Read native state after each event; requesting fullscreen does not mean
  // that the client accepted it. Geometry updates never rebuild the form.
  try{document.documentElement?.classList?.toggle('telegram-fullscreen',sdk.isFullscreen===true);}catch{}
  try{
    const height=Number(sdk.viewportStableHeight);
    if(Number.isFinite(height)&&height>0)document.documentElement?.style?.setProperty('--reel-viewport-height',height+'px');
  }catch{}
  for(const update of telegramViewportListeners){try{update();}catch{}}
}
function syncTelegramHeader(sdk=window.Telegram?.WebApp){
  if(!telegramMode||!sdk)return;
  try{
    const color=document.body?.classList?.contains?.('light')?'#f1f0f5':'#100e16';
    if(telegramHeaderColors.get(sdk)===color)return;
    telegramHeaderColors.set(sdk,color);sdk.setHeaderColor?.(color);
  }catch{}
}
function setupTelegramWindow(sdk=window.Telegram?.WebApp){
  if(!telegramMode||!sdk)return;
  updateTelegramViewport(sdk);syncTelegramHeader(sdk);
  if(telegramWindowSDKs.has(sdk))return;
  telegramWindowSDKs.add(sdk);
  const update=()=>updateTelegramViewport(sdk);
  for(const event of ['fullscreenChanged','fullscreenFailed','safeAreaChanged','contentSafeAreaChanged','viewportChanged']){
    try{sdk.onEvent?.(event,update);}catch{}
  }
  try{
    if(typeof sdk.disableVerticalSwipes==='function'&&
      (typeof sdk.isVersionAtLeast!=='function'||sdk.isVersionAtLeast('7.7')))
      sdk.disableVerticalSwipes();
  }catch{}
  try{sdk.expand();}catch{}
  // Only native mobile clients enter fullscreen automatically. Desktop/Web
  // keep their normal window; request once so a user's later exit is respected.
  try{
    if((sdk.platform==='android'||sdk.platform==='ios')&&
      typeof sdk.requestFullscreen==='function'&&
      (typeof sdk.isVersionAtLeast!=='function'||sdk.isVersionAtLeast('8.0'))&&
      !sdk.isFullscreen)sdk.requestFullscreen();
  }catch{}
  update();
}
function waitTelegramSDK(){
  if(window.Telegram?.WebApp){
    telegramInit=window.Telegram.WebApp.initData||telegramInit;clearTelegramLaunchHash();telegramReady();setupTelegramWindow();
    return Promise.resolve(window.Telegram.WebApp);
  }
  if(!telegramMode)return Promise.resolve(null);
  if(!telegramSDKWait)telegramSDKWait=new Promise(resolve=>{
    let settled=false;
    const finish=()=>{
      const sdk=window.Telegram?.WebApp||null;
      telegramInit=sdk?.initData||telegramInit;clearTelegramLaunchHash();telegramReady();setupTelegramWindow(sdk);
      if(settled)return;settled=true;clearTimeout(timer);resolve(sdk);
    };
    const timer=setTimeout(finish,4000);
    const script=document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]');
    // Retain the once-only load callback after timeout: a late SDK can still
    // reveal the already rendered success/error screen with its official ready().
    script?.addEventListener('load',finish,{once:true});
    script?.addEventListener('error',finish,{once:true});
  });
  return telegramSDKWait;
}
async function currentTelegramInit(){
  await waitTelegramSDK();
  telegramInit=window.Telegram?.WebApp?.initData||telegramInit;
  if(telegramMode&&!telegramInit)throw new Error('Не удалось получить вход Telegram. Закройте Mini App и откройте «Студия ✨» из бота.');
  return telegramInit;
}
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phases={QUEUED:'В очереди',STARTING:'Запускаем обработку',PREPROCESSING:'Подготавливаем звук',TRANSCRIBING:'Распознаём речь',VALIDATING:'Проверяем исходник',PLANNING_SEMANTICS:'Подбираем смысловые акценты',ANALYZING_PAUSES:'Находим тихие паузы',ANALYZING_FRAMES:'Анализируем лица и фон',PLANNING_CAPTIONS:'Создаём титры',RENDERING:'Собираем видео',VERIFYING:'Проверяем результат',COMPLETED:'Этап завершён',INTERRUPTED:'Обработка прервана',FAILED:'Ошибка',CANCELLED:'Отмена'};
const statuses={queued:'В очереди',running:'В работе',completed:'Готово',failed:'Ошибка',cancelled:'Отменено',cancelling:'Останавливаем'};
Object.assign(phases,{PREPARING:'Проверяем исходник',NORMALIZING:'Подготавливаем видео',PREPARING_ANALYSIS:'Подготавливаем копию для анализа',ANALYZING_AUDIO:'Различаем речь, музыку и пение',ANALYZING_CONTENT:'Анализируем содержание и кадр',PUBLISHING:'Сохраняем готовый MP4'});
Object.assign(phases,{RENDERING_CANDIDATE:'Собираем видео',QWEN_REVIEW_INITIAL:'Qwen проверяет готовое видео',RERENDERING_FIRST:'Исправляем монтаж по проверке Qwen',QWEN_REVIEW_FIRST:'Qwen проверяет исправления',RERENDERING_SECOND:'Уточняем монтаж по проверке Qwen',QWEN_REVIEW_SECOND:'Qwen проверяет итоговое видео'});
phases.WAITING_INFERENCE='Ожидаем вычислительные ресурсы';
phases.EXPORTING='Готовим копию для Telegram';
phases.CREATING_ASSETS='Создаём иллюстрации и графику';
phases.PLANNING_CODEX_VISUAL='Анализируем содержание кадров';
phases.PLANNING_CLEANUP='Убираем съёмочные ремарки и повторы';
phases.PLANNING_CODEX='Подбираем заголовок и эмодзи';
phases.SEGMENTING_PERSON='Отделяем человека для объёмных титров';
const labels={small:'Маленький',medium:'Средний',large:'Крупный',auto:'Авто',top:'Сверху',bottom:'Снизу',dynamic:'Динамичное',lines:'Построчно',single:'Пословно',line:'Строки · прежний',word:'Накопление слов',none:'Целиком',rules:'Автоматические правила',qwen:'Qwen',ru:'Русский',en:'English'};
const date=t=>new Date(t*1000).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const mb=n=>(n/1024/1024).toFixed(1)+' МиБ';
function jobProgressText(job){
  if(!job||!['queued','running'].includes(job.status))return '';
  const progress=job.progress;
  if(!progress||progress.basis!=='pipeline-stages'||progress.phase!==job.phase||
      !Number.isInteger(progress.percent)||progress.percent<0||progress.percent>100||
      (job.status==='queued'&&progress.percent!==0))return '';
  // Only a completed job may claim completion. Never interpolate a server
  // stage percentage from elapsed time, a forecast or a client clock.
  return 'Выполнено '+Math.min(99,progress.percent)+'%';
}
function jobProgressMarkup(job,compact=false){
  if(!['queued','running'].includes(job.status))return '';
  const text=jobProgressText(job);
  return '<span class="job-eta'+(compact?' job-eta-compact':'')+'" data-job-progress="'+e(job.id)+'" aria-live="off"'+(!text?' hidden':'')+'><span data-progress-text>'+e(text)+'</span></span>';
}
function updateJobProgressText(){
  if(!document.querySelector('[data-job-progress]'))return;
  document.querySelectorAll('[data-job-progress]').forEach(node=>{
    const text=jobProgressText(jobs.find(job=>job.id===node.dataset.jobProgress));
    node.hidden=!text;
    const child=node.querySelector('[data-progress-text]');
    if(child&&child.textContent!==text)child.textContent=text;
  });
}
function setupJobProgressResume(){
  if(!jobProgressListenersMounted){
    document.addEventListener('visibilitychange',resumeJobProgress);
    window.addEventListener('pageshow',event=>{if(event.persisted)resumeJobProgress();});
    jobProgressListenersMounted=true;
  }
}
function resumeJobProgress(){
  if(document.hidden||!caps)return;
  refresh().catch(()=>{});
}
function jobViewSnapshot(values){
  const visible=detailId?[values.find(job=>job.id===detailId)]:values;
  return JSON.stringify(visible.map(job=>{if(!job)return null;const {eta,progress,updated,...view}=job;return job.status==='completed'?{...view,artifact_revision:jobArtifactRevision(job)}:view;}));
}
function jobArtifactRevision(job){
  // A saved result can be corrected under the same job ID. Keep its URL stable
  // across polls, but distinguish replacements using persisted server values.
  const updated=Number.isFinite(job?.updated)&&job.updated>0?'u'+job.updated:'';
  const size=Number.isSafeInteger(job?.result?.size_bytes)&&job.result.size_bytes>0?'b'+job.result.size_bytes:'';
  return [updated,size].filter(Boolean).join('-')||'unversioned';
}
function jobArtifactUrl(job,kind,download=false){
  return '/api/jobs/'+encodeURIComponent(job.id)+'/'+kind+'?'+(download?'download=1&':'')+'v='+encodeURIComponent(jobArtifactRevision(job));
}
function completedPlayerMarkup(job){
  return '<video class="player" controls playsinline preload="metadata" src="'+e(jobArtifactUrl(job,'video'))+'" poster="'+e(jobArtifactUrl(job,'cover'))+'"></video><div class="actions">'+
    [['video','↓ Скачать MP4'],['subtitles','SRT'],['cover','Скачать обложку']].map(([kind,label])=>'<a data-result-artifact="'+kind+'" data-download-job="'+e(job.id)+'" data-download-kind="'+kind+'" href="'+e(jobArtifactUrl(job,kind,true))+'" download>'+label+'</a>').join('')+'</div>';
}
function updateCompletedPlayer(job,player){
  const video=jobArtifactUrl(job,'video'),cover=jobArtifactUrl(job,'cover');
  const changed=player.getAttribute('src')!==video;
  if(player.getAttribute('poster')!==cover)player.setAttribute('poster',cover);
  document.querySelectorAll('[data-result-artifact]').forEach(link=>{
    const kind=link.dataset.resultArtifact;
    if(!['video','subtitles','cover'].includes(kind))return;
    const url=jobArtifactUrl(job,kind,true);
    if(link.getAttribute('href')!==url)link.setAttribute('href',url);
  });
  if(changed){player.setAttribute('src',video);player.load();}
}
function updateNativeDownloadLinks(){
  if(nativeDownloadRequest){
    document.querySelectorAll('[data-download-job]').forEach(link=>{
      if(!nativeDownloadLinkState.has(link))nativeDownloadLinkState.set(link,link.getAttribute('aria-disabled'));
      link.setAttribute('aria-disabled','true');
    });
  }else{
    for(const [link,previous] of nativeDownloadLinkState){
      if(previous===null)link.removeAttribute('aria-disabled');else link.setAttribute('aria-disabled',previous);
    }
    nativeDownloadLinkState.clear();
  }
}
function nativeDownloadParams(ticket,job,kind){
  const extension={video:'mp4',cover:'jpg',subtitles:'srt'}[kind];
  if(!ticket||typeof ticket.url!=='string'||ticket.url.length>4096||
      ticket.file_name!=='reellab-'+job.id.slice(0,8)+'.'+extension||
      !Number.isFinite(ticket.expires_at)||ticket.expires_at<=0)throw new Error('Invalid download ticket');
  const url=new URL(ticket.url);
  if(url.protocol!=='https:'||url.origin!==location.origin||url.username||url.password||url.search||url.hash||
      !/^\/api\/downloads\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(url.pathname))throw new Error('Invalid download ticket');
  return {url:url.href,file_name:ticket.file_name};
}
async function nativeDownload(link){
  if(nativeDownloadRequest)return;
  const sdk=window.Telegram?.WebApp;
  let supported=false;
  try{supported=typeof sdk?.downloadFile==='function'&&typeof sdk.isVersionAtLeast==='function'&&sdk.isVersionAtLeast('8.0')===true;}catch{}
  if(!supported){toast('Обновите Telegram, чтобы скачивать файлы из студии.');return;}
  const id=link.dataset.downloadJob,kind=link.dataset.downloadKind;
  const current=()=>jobs.find(job=>job.id===id&&job.status==='completed'&&job.result);
  if(!/^[a-f0-9]{32}$/.test(id)||!['video','cover','subtitles'].includes(kind)||!current()){
    toast('Готовый файл недоступен. Обновите список роликов.');return;
  }
  const request={principal,started:performance.now()};nativeDownloadRequest=request;updateNativeDownloadLinks();
  const finish=()=>{if(nativeDownloadRequest!==request)return;nativeDownloadRequest=null;updateNativeDownloadLinks();};
  let params;
  try{
    const ticket=await api('/api/jobs/'+id+'/download',{method:'POST',data:{kind},timeoutMs:6000});
    if(principal!==request.principal||!current())throw new Error('Download selection changed');
    params=nativeDownloadParams(ticket,current(),kind);
  }catch{finish();toast('Не удалось подготовить скачивание. Повторите запрос.');return;}
  // Native clients can require a recent click even after the async ticket mint.
  // An expired gesture requires another explicit click, never an automatic retry.
  const elapsed=performance.now()-request.started;
  if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=8000){finish();toast('Подготовка заняла слишком долго. Нажмите «Скачать» ещё раз.');return;}
  try{
    // Telegram's callback confirms accepting the native request, not that the
    // file was saved. Both acceptance and cancellation simply release controls.
    sdk.downloadFile(params,()=>finish());
  }catch{finish();toast('Telegram не смог открыть скачивание. Обновите приложение и повторите.');}
}
function wireDownloads(){
  document.querySelectorAll('[data-download-job]').forEach(link=>link.onclick=event=>{
    if(!telegramMode)return; // Preserve the normal browser download attribute.
    event.preventDefault();void nativeDownload(link);
  });
  updateNativeDownloadLinks();
}
function toast(text){const box=document.querySelector('#toast');box.textContent=text;box.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.style.display='none',4500);}
function responseError(value,status){return Object.assign(new Error(value.error||`Сервер недоступен (${status}). Повторите запрос.`),{code:value.code,status});}
async function requestJSON(path,{method='GET',data,timeoutMs}={}){
  if(timeoutMs===undefined)timeoutMs=path==='/api/bootstrap'||path==='/api/upload-selection/clear'||
    /^\/api\/upload-transfers(?:\/[a-f0-9]{32}(?:\/finish)?)?$/.test(path)?40000:15000;
  const controller=typeof AbortController==='function'?new AbortController():null;
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    reject(Object.assign(new Error('Сервер не ответил вовремя. Проверьте соединение и повторите запрос.'),{code:'request_timeout'}));controller?.abort();
  },timeoutMs);});
  try{return await Promise.race([deadline,(async()=>{
    const r=await fetch(path,{method,credentials:'same-origin',...(controller?{signal:controller.signal}:{}),headers:method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:method==='POST'?JSON.stringify(data??{}):undefined});
    let value;try{value=await r.json();}catch{throw responseError({},r.status);}
    if(!r.ok)throw responseError(value,r.status);return value;
  })()]);}finally{clearTimeout(timer);}
}
function acceptSession(value){
  if(principal&&principal!==value.principal)throw new Error('Открыт другой аккаунт. Закройте и заново откройте приложение. Старые настройки не отправлены.');
  principal=value.principal;csrf=value.csrf;
}
async function recoverSession(){
  if(!sessionRecovery)sessionRecovery=(async()=>{
    let value;
    try{value=await requestJSON('/api/bootstrap');}
    catch(err){
      if(err.code!=='session_expired')throw err;
      try{value=await requestJSON('/api/session',{method:'POST',data:{init_data:await currentTelegramInit()}});}
      catch(next){if(next.status===400)throw new Error('Вход устарел. Закройте Mini App и откройте «Студия ✨» из бота. Повторная привязка не нужна.');throw next;}
    }
    acceptSession(value);
  })().finally(()=>{sessionRecovery=null;});
  return sessionRecovery;
}
async function api(path,options={}){
  try{return await requestJSON(path,options);}
  catch(err){
    // These responses are emitted before a mutation reads its body. Never retry
    // network failures or ambiguous errors, which may follow a successful write.
    if(path==='/api/session'||!['session_expired','csrf_stale'].includes(err.code))throw err;
    await recoverSession();return requestJSON(path,options);
  }
}
function modelLabel(model){return caps?.model_labels?.[model]||({gigaam:'GigaAM Multilingual 600M',turbo:'Whisper Turbo',small:'Whisper Small'})[model]||model;}
function processingSettings(value){const settings=structuredClone(value);if(!settings.model||settings.model==='small')settings.model=caps?.default_model||'turbo';if(settings.model==='gigaam')settings.vocabulary='';return settings;}
function outputFormat(settings){return ({vertical_1080:['1080','×1920 · Full HD'],vertical_720:['720','×1280 · HD'],horizontal_1080:['1920','×1080 · Full HD'],source:['Исходный','размер кадра']})[settings?.output_resolution]||['1080','×1920 · Full HD'];}
function montagePresetLabel(value){return ({talking_head:'Говорящая голова',podcast:'Подкаст / интервью',dynamic_reel:'Динамичный Reel',original:'Сохранить оригинал'})[value]||'Индивидуальные настройки';}
function options(key,values){if(key==='model')values=values.filter(value=>vpsPipeline()?value==='qwen3':value==='gigaam'||value==='turbo');return `<label class="field"><span>${({font:'Пара шрифтов',size:'Размер текста',position:'Положение',animation:'Появление',model:'Распознавание речи',director:'Смысловые акценты',language:'Язык речи'})[key]}</span><select data-option="${key}" aria-label="${key}">${values.map(v=>`<option value="${e(v)}" ${draft[key]===v?'selected':''}>${e(key==='model'?modelLabel(v):labels[v]||v)}</option>`).join('')}</select></label>`;}
function vocabularyControl(){return draft.model==='gigaam'?'<p class="preview-description">GigaAM Multilingual распознаёт речь автоматически, без словаря названий.</p>':'<label class="field"><span>Имена, места, названия — по одному на строку</span><textarea data-option="vocabulary" maxlength="500" placeholder="Например: Хасавюрт" aria-label="Словарь ролика">'+e(draft.vocabulary)+'</textarea></label><small>Подсказка распознаванию, не принудительная замена слов. Проверь готовый текст.</small>';}
function toggle(key,title,note){return `<label class="toggle"><span><strong>${title}</strong><small>${note}</small></span><input type="checkbox" role="switch" aria-label="${title}" data-option="${key}" ${draft[key]?'checked':''}></label>`;}
let clipFilter='ready', previewStyle=0;
const interfaceHelp={
  animation:['Оформление','Как оформлен текст по ходу речи.',[
    {title:'Динамичное',text:'Текст в композициях с яркими акцентами.',recommended:true},
    {title:'Построчно',text:'Классические субтитры строками: одна строка заменяет предыдущую.'},
    {title:'Пословно',text:'Классические субтитры по одному слову: каждое заменяет предыдущее.'}
  ]],
  size:['Размер текста','Размер субтитров и смысловых акцентов в ролике: на плашках, за спикером и рядом с лицом.'],
  position:['Расположение','Где в кадре находятся субтитры и смысловые акценты: на плашках, за спикером и рядом с лицом.',[
    {title:'Авто',text:'Автоматически выбирает место сверху или снизу с учётом лиц и фона.'},
    {title:'Снизу',text:'Весь ролик в нижней части кадра. Длинные фразы становятся меньше, чтобы оставаться в границах кадра.'},
    {title:'Сверху',text:'Весь ролик в верхней части кадра. Длинные фразы становятся меньше, чтобы оставаться в границах кадра.'}
  ]],
  panels:['Плашки и карточки','Включите, чтобы добавить текстовые плашки-акценты поверх видео — ключевые фразы, цифры.'],
  motion:['Движение камеры','Лёгкое движение/приближение кадра вместо статичной картинки.'],
  opening_zoom:['Наезд камеры в начале','Короткий зум в первую секунду ролика.'],
  sound_effects:['Звуковые эффекты','Короткие звуковые акценты на смену сцен и субтитров.'],
  background_music:['Фоновая музыка','Локальная синтезированная подложка с приглушением под речь. Это не библиотека популярных треков.'],
  emoji:['Эмодзи в субтитрах','Включите, чтобы добавить эмодзи в субтитры — в подходящих по смыслу местах.'],
  media_cards:['Медиа-карточки','Добавляйте кадры исходного видео в виде медиакарточек по смыслу.'],
  hook:['Придумать хук к видео','Включите, чтобы хук генерировался автоматически и добавлялся в начало видео — вместо дословной фразы из первых сказанных слов.'],
  designed_cover:['Обложка','Отдельная вертикальная обложка с кадром твоего видео и крупным заголовком в выбранных шрифтах и цвете. Скачивается отдельно, не добавляет длительность к ролику.'],
  video:['Требования к видео','MP4, MOV, M4V, WebM, MKV или AVI. До 3 минут, со звуковой дорожкой и разборчивой речью. Лимит размера зависит от способа загрузки и указан под кнопкой. Исходники хранятся на компьютере владельца.'],
  cuts:['Умная нарезка',[
    'Включите, чтобы мы отобрали главные фразы и собрали ролик до 60 секунд, сохранив их порядок.',
    'Выключите, если нужно сохранить всю речь без ограничения длительности.'
  ]],
  about:['О сервисе',[
    'Reel Lab — локальная студия автоматического монтажа. Загружайте видео с речью, выбирайте оформление и получайте ролик с субтитрами.',
    'Обработка выполняется на компьютере владельца, который должен оставаться включённым. Участники используют общую очередь и свои лимиты запусков.'
  ]],
  privacy:['Данные и хранение','Речь и видео обрабатываются на компьютере владельца, без платных ИИ API. Загрузки в Mini App проходят через Cloudflare, сообщения бота — через Telegram. Каждый участник видит только свои ролики. Владелец сервиса имеет доступ к файлам. Автоудаление не включено; для удаления обратитесь в поддержку.'],
  language:['Язык приложения','Интерфейс Studio пока доступен на русском. Переключение языка всего приложения ещё не реализовано.']
};
const interfaceHelpIllustrations={
  emoji:{src:'/assets/help-emoji-v1.jpg?v=2',alt:'Пример субтитров: «это полностью его работа» с эмодзи инструментов.',width:1086,height:362},
  // User-supplied screenshots remain unchanged; only the illustration region is displayed.
  hook:{src:'/assets/help-hook-reference-v1.png',alt:'Пример хука: «Бот для монтажа видео».',width:409,height:670,crop:{x:40,y:254,width:324,height:148}},
  panels:{src:'/assets/help-panels-reference-v1.png',alt:'Пример текстовой плашки: «Полностью монтирует готовые ролики».',width:389,height:679,crop:{x:30,y:328,width:324,height:94}},
  media_cards:{src:'/assets/help-media-reference-v1.png',alt:'Пример медиа-карточки: смартфон с горным озером и субтитрами поверх видео.',width:380,height:663,portrait:true,crop:{x:87,y:151,width:196,height:258}}
};
const referenceHelpKeys=new Set(['motion','opening_zoom','hook','panels','media_cards','cuts','about','privacy']);
const fontFaces={
  Widescreen:['Arial Black','Arial Narrow','normal'],Notebook:['Courier New','Courier New','normal'],
  Silk:['Georgia','Arial','italic'],Heavyweight:['Arial Black','Arial','normal'],
  Marble:['Times New Roman','Georgia','normal'],Invitation:['Georgia','Times New Roman','italic'],
  Boardwalk:['Arial Rounded MT Bold','Arial','normal'],'Deco Line':['Arial Narrow','Arial Narrow','normal'],
  Editorial:['Georgia','Arial','normal'],Billboard:['Arial Black','Courier New','normal'],
  Feather:['Arial','Arial Narrow','normal'],Nouveau:['Georgia','Georgia','italic'],
  Modernist:['Arial','Arial','normal'],Chisel:['Times New Roman','Arial Narrow','normal']
};
fontFaces.Modernist=['Reel Lab Display','Reel Lab Text','normal'];
interfaceHelp.spatial_text=['Текст за человеком','Локальная модель сегментации отделяет человека от фона. Отдельные крупные слова могут уходить за край силуэта, но каждая буква остаётся читаемой. Проверяются лицо, вся фраза и появление слова. Небезопасный эффект пропускается. Произвольные предметы и 3D-камера пока не отслеживаются.'];
function icon(name){
  const paths={
    referrals:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M19 7v6m-3-3h6"/>',
    clips:'<rect x="5" y="6" width="16" height="15" rx="3"/><path d="M16 3H6a4 4 0 0 0-4 4v10m10-6 5 3-5 3z"/>',
    montage:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3zm8-2v4m-2-2h4"/>',
    balance:'<ellipse cx="10" cy="6" rx="7" ry="3"/><path d="M3 6v5c0 4 14 4 14 0V6M3 11v5c0 3 7 4 11 2m5-5v8m-4-4h8"/>',
    profile:'<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
    theme:'<path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z"/>',
    support:'<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 12H2v7h4v-7H4zm16 0h2v7h-4v-7h2zm0 7v1a2 2 0 0 1-2 2h-4"/>',
    lifebuoy:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6"/>',
    coins:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 4 16 4 16 0V5M4 11v6c0 4 16 4 16 0v-6"/>',
    arrow:'<path d="m9 5 7 7-7 7"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload:'<path d="M12 17V5m-5 5 5-5 5 5M4 17v4h16v-4"/>',
    scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.5 7.5 12 12m-12-3 12-12M13 12l2-2"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.montage)+'</svg>';
}
function helpButton(key){return '<button type="button" class="help" data-help="'+key+'" aria-label="Подробнее: '+e(interfaceHelp[key][0])+'">?</button>';}
function nav(){return '<nav class="nav" aria-label="Основная навигация"><div class="nav-inner">'+[['referrals','Пригласить'],['clips','Ролики'],['montage','Монтаж'],['balance','Баланс'],['profile','Профиль']].map(([id,text])=>'<button data-page="'+id+'" class="'+(page===id||(page==='support'&&id==='profile')?'active ':'')+(id==='montage'?'nav-create':'')+'" aria-current="'+(page===id?'page':'false')+'"><span class="symbol">'+icon(id)+'</span><span>'+text+'</span></button>').join('')+'</div></nav>';}
function header(){return '<header class="topbar"><button class="brand" data-page="montage" aria-label="Reel Lab — монтаж">reellab<span>.</span></button><div class="top-actions"><button class="icon-btn" id="theme" aria-label="Переключить тему">'+icon('theme')+'</button><button class="balance-pill" data-page="balance">'+icon('balance')+'<span>'+(vpsPipeline()?'Лимиты':'Бесплатно')+'</span></button></div></header>';}
function cycleTile(key,title,values){
  return '<div class="setting-tile"><div class="tile-heading"><span>'+title+'</span>'+helpButton(key)+'</div><button class="cycle-value" data-cycle="'+key+'" data-values="'+values.join(',')+'" aria-label="'+title+': '+e(labels[draft[key]]||draft[key])+'"><span>'+e(labels[draft[key]]||draft[key])+'</span><span aria-hidden="true">↔</span></button></div>';
}
function effectTile(key,title,available=true){
  return '<div class="effect-tile '+(available?'':'unavailable')+'"><span>'+title+'</span><div class="effect-bottom"><label class="switch-label"><input type="checkbox" role="switch" aria-label="'+title+'" '+(available?'data-option="'+key+'"':'disabled')+' '+(available&&draft[key]?'checked':'')+'><span class="switch-track"></span></label>'+helpButton(key)+'</div>'+(available?'':'<small>Скоро</small>')+'</div>';
}
function processingAvailable(){return caps?.processing_enabled!==false;}
function uploadAvailable(){return caps?.upload_enabled===undefined?processingAvailable():caps.upload_enabled!==false;}
function vpsPipeline(){return caps?.pipeline==='vps';}
function localNoLLM(){return caps?.processing_mode==='local-no-llm';}
function codexEditorial(){return caps?.text_ai?.backend==='codex';}
function supportsShortform(){return !localNoLLM()&&caps?.features?.short60!==false;}
function durationControl(){
  if(!supportsShortform())return '';
  return '<label class="field"><span>Длительность результата</span><select data-option="duration_mode" aria-label="Длительность результата"><option value="short60" '+(draft.duration_mode==='short60'?'selected':'')+'>До 60 секунд · ИИ-отбор главного</option><option value="original" '+(draft.duration_mode!=='short60'?'selected':'')+'>Без лимита · сохранить речь</option></select></label>';
}
function uploadPicker(){
  const unavailable=busy||!uploadAvailable();
  return '<div class="upload upload-compact" id="upload-zone"><button type="button" class="upload-pick" id="choose-file" aria-label="'+(upload?'Заменить видео':'Выбрать видео')+'" '+(unavailable?'disabled':'')+'><span class="upload-copy"><strong>'+(!uploadAvailable()?'Загрузка пока недоступна':upload?'Заменить видео':'Загрузите видео')+'</strong><small>'+(vpsPipeline()?'.mp4, .mov, .m4v, .webm, .mkv':'.mp4, .mov, .m4v, .webm, .mkv, .avi')+'</small></span><span class="upload-plus" aria-hidden="true">+</span></button><input id="file" class="sr-only" type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" aria-label="Файл видео" '+(unavailable?'disabled':'')+'></div>'+
    '<small class="picker-status" id="picker-status" role="status"></small><details class="picker-help" hidden><summary>Окно выбора не открылось?</summary><p>Попробуй системную кнопку ниже или перетащи видео из Finder в рамку загрузки. Можно выбрать несколько видео.</p><input id="file-fallback" type="file" multiple accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" aria-label="Системный выбор файла" '+(unavailable?'disabled':'')+'></details>';
}
function smartCutControl(){
  if(caps?.features?.semantic_cuts)return '<div class="smart-cut-row"><span class="smart-cut-icon" aria-hidden="true">'+icon('scissors')+'</span><span class="smart-cut-title">Умная нарезка</span>'+helpButton('cuts')+'<button type="button" class="smart-cut-switch" role="switch" aria-label="Умная нарезка" aria-checked="'+Boolean(draft.smart_cut)+'" data-smart-cut></button></div>'; 
  if(!supportsShortform())return '<p class="notice">'+(draft.cut_pauses?'Сохраняем речь и сокращаем безопасные паузы.':'Сохраняем всю речь.')+' Длительность зависит от исходника.</p>';
  return '<div class="smart-cut-row"><span class="smart-cut-icon" aria-hidden="true">'+icon('scissors')+'</span><span class="smart-cut-title">Умная нарезка</span>'+helpButton('cuts')+'<button type="button" class="smart-cut-switch" role="switch" aria-label="Умная нарезка" aria-checked="'+(draft.duration_mode==='short60')+'" data-cycle="duration_mode" data-values="original,short60"></button></div>';
}
function montageAction(style){
  const hasVideo=Boolean(upload||batch.some(x=>x.upload&&!x.job));
  const label=!processingAvailable()?'Обработка готовится':busy?'Загружаем…':creatingJob?'Создаём задачу…':!style.enabled?'Стиль '+style.id+' пока недоступен':batch.length?'Обработать выбранные видео':'Создать ролик';
  const hint=!processingAvailable()?(uploadAvailable()?'Видео можно загрузить; монтаж временно недоступен':'Загрузка и запуск откроются после подключения обработки'):busy?'Дождитесь завершения загрузки':creatingJob?'Добавляем видео в очередь':!style.enabled?'Выберите доступный стиль':hasVideo?'Запустить автоматический монтаж':'Сначала загрузите видео';
  return '<button class="primary run-action" id="run" '+(!processingAvailable()||!hasVideo||busy||creatingJob||!style.enabled?'disabled':'')+'><span class="run-label">'+e(label)+'</span><small>'+e(hint)+'</small></button>';
}
const captionFontCache=new Map(),captionFontFailures=new Map();
const CAPTION_FONT_TIMEOUT_MS=12000;
let captionFontWarmup=null;
function captionFontRequirements(font=draft?.font,animation=draft?.animation){
  const sample=caps?.typography_motion?.[font]?.[animation]?.words||caps?.typography_profiles?.[font]?.rows||[];
  const families=new Map();
  for(const word of sample){
    if(!word.family)continue;
    if(!families.has(word.family))families.set(word.family,new Set());
    if(word.text)families.get(word.family).add(word.text);
  }
  return [...families].map(([family,text])=>({family,text:[...text].join(' ')||'Каждая твоя история'}));
}
function captionFontState(requirements=captionFontRequirements()){
  if(requirements.length&&requirements.every(({family})=>captionFontCache.get(family)?.status==='ready'))return 'ready';
  return requirements.some(({family})=>captionFontFailures.has(family))?'error':'loading';
}
function captionFontClass(){const state=captionFontState();return state==='ready'?'':' font-'+state;}
function captionFontsRetryable(){
  const failures=captionFontRequirements().map(({family})=>captionFontFailures.get(family)).filter(Boolean);
  return failures.length>0&&failures.every(error=>error.retryable===true);
}
function captionFontStatusText(state){
  return state==='loading'?'Загружаем шрифты…':state==='error'?
    (captionFontsRetryable()?'Шрифты загружаются слишком долго.':'Не удалось загрузить шрифты. Открой Mini App заново.'):'';
}
function captionFontStatusMarkup(){
  if(draft.typography!=='reference')return '';
  const state=captionFontState();
  return '<div class="font-load-status" data-font-load-state="'+state+'"><span data-font-status role="status" aria-live="polite">'+captionFontStatusText(state)+'</span><button type="button" class="text-button" data-font-retry'+(state==='error'&&captionFontsRetryable()?'':' hidden')+'>Повторить</button></div>';
}
function updateCaptionFontState(state,svgs){
  for(const svg of svgs){
    svg.classList.toggle('font-loading',state==='loading');
    svg.classList.toggle('font-error',state==='error');
  }
  const status=document.querySelector('[data-font-load-state]');
  if(status)status.setAttribute('data-font-load-state',state);
  const label=document.querySelector('[data-font-status]');if(label)label.textContent=captionFontStatusText(state);
  const retry=document.querySelector('[data-font-retry]');if(retry)retry.hidden=state!=='error'||!captionFontsRetryable();
}
function loadCaptionFont({family,text}){
  const existing=captionFontCache.get(family);
  if(existing)return existing.promise;
  const failure=captionFontFailures.get(family);
  // A rejected native FontFace stays in the CSS FontFaceSet's error state.
  // Do not promise a retry that would simply reuse that failed face.
  if(failure&&!failure.retryable)return Promise.reject(failure);
  const entry={status:'loading',promise:null};
  captionFontCache.set(family,entry);captionFontFailures.delete(family);
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Font load timed out'),{retryable:true})),CAPTION_FONT_TIMEOUT_MS);});
  entry.promise=Promise.race([deadline,Promise.resolve().then(()=>{
    if(typeof document.fonts?.load!=='function')throw new Error('Font loading is unavailable');
    return document.fonts.load('16px "'+family.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"',text);
  })]).then(faces=>{
    // FontFaceSet.load resolves [] when no declared face matches. That is a
    // fallback font, not proof that the selected Cyrillic face is available.
    if(!Array.isArray(faces)||!faces.length||faces.some(face=>face.status!=='loaded'))throw new Error('Font face is unavailable');
    entry.status='ready';captionFontFailures.delete(family);
  }).catch(error=>{
    if(captionFontCache.get(family)===entry)captionFontCache.delete(family);
    captionFontFailures.set(family,error instanceof Error?error:new Error('Font face is unavailable'));throw error;
  }).finally(()=>clearTimeout(timer));
  return entry.promise;
}
function warmCaptionFonts(){
  if(captionFontWarmup)return;
  const families=new Map();
  const names=new Set([...Object.keys(caps?.typography_profiles||{}),...Object.keys(caps?.typography_motion||{})]);
  for(const font of names){
    for(const item of captionFontRequirements(font,'dynamic'))if(!families.has(item.family))families.set(item.family,item);
  }
  const pending=[...families.values()].filter(({family})=>captionFontCache.get(family)?.status!=='ready');
  let index=0;
  const worker=async()=>{
    while(index<pending.length){
      const item=pending[index++];
      try{await loadCaptionFont(item);}catch{} // Selection reports errors; background work stays quiet.
    }
  };
  // Only background work is queued. Clicking another pair always starts its
  // own loads immediately, even while these two workers are busy.
  captionFontWarmup=Promise.all([worker(),worker()]);
}
function captionDemo(){
  if(draft.typography==='reference'){
    const motion=caps.typography_motion?.[draft.font]?.[draft.animation];
    if(motion)return referenceMotionMarkup(motion);
    const p=caps.typography_profiles[draft.font];
    const factor={small:.8,medium:1,large:1.12}[draft.size];
    return '<svg class="reference-caption'+captionFontClass()+'" viewBox="0 0 '+p.width+' '+p.height+'" style="width:'+(factor*100)+'%" role="img" aria-label="Статический образец пары '+e(draft.font)+'">'+
      p.rows.map(r=>'<text x="'+r.x+'" y="'+r.baseline+'" text-anchor="middle" style="font-family:&quot;'+e(r.family)+'&quot;;font-size:'+r.size+'px;letter-spacing:'+(r.tracking||0)+'px;fill:var(--caption-'+(r.hero?'accent':'context')+')">'+e(r.text)+'</text>').join('')+'</svg>';
  }
  if(draft.animation==='single')return '<div class="demo-replace demo-single"><strong>Твоя</strong><strong>новая</strong><strong>история</strong></div>';
  if(draft.animation==='lines')return '<div class="demo-replace demo-lines"><strong>Каждый кадр —</strong><strong>твоя история</strong></div>';
  return '<span>Каждый кадр —</span><strong>твоя история</strong>';
}
function captionDemoStyle(){
  const palette=draft.typography==='reference'?caps.colors:(caps.legacy_colors||caps.colors);
  const color=palette.find(c=>c.key===draft.color);
  const face=draft.font==='Modernist'&&draft.typography!=='cinema'?['Arial','Arial','normal']:(fontFaces[draft.font]||fontFaces.Modernist);
  return "--caption-accent:"+color.hex+";--caption-context:"+(caps.context_color||'#F6EFD8')+";--hero-font:'"+face[0]+"';--body-font:'"+face[1]+"';--hero-style:"+face[2];
}
function captionDemoClass(){
  const reference=draft.typography==='reference';
  return 'demo-caption '+(reference?'reference-layout ':'')+'caption-'+draft.size+' position-'+draft.position+' '+(!reference&&draft.motion?'moving ':'')+(draft.panels?'backed':'');
}
function refreshMontageAppearance(){
  if(page!=='montage'||detailId||!document.querySelector('.montage-preview .demo-caption')){render();return;}
  // Keep the photograph/video, file inputs, focus and scroll position mounted.
  // The compact observer also keeps watching the same caption element.
  stopCaptionPreview();
  const style=captionDemoStyle(),markup=captionDemo();
  document.querySelectorAll('.montage-preview .portrait-demo,.compact-preview>.portrait-demo').forEach(node=>{const transform=node.style.transform;node.setAttribute('style',style);if(transform)node.style.transform=transform;});
  document.querySelectorAll('.montage-preview .demo-caption,.compact-preview .demo-caption').forEach(node=>{node.className=captionDemoClass();node.innerHTML=markup;});
  document.querySelectorAll('[data-font]').forEach(node=>{const selected=node.dataset.font===draft.font;node.setAttribute('aria-pressed',String(selected));node.classList.toggle('selected',selected);});
  const reference=document.querySelector('.font-reference img');
  if(reference){reference.src='/api/preview?color='+draft.color+'&font='+encodeURIComponent(draft.font)+'&typography='+draft.typography;reference.alt='Образец шрифтов рендера '+draft.font;}
  mountCaptionPreview();
}
function referenceMotionMarkup(spec){
  const factor={small:.8,medium:1,large:1.12}[draft.size];
  return '<svg class="reference-caption reference-motion static-preview'+captionFontClass()+'" viewBox="0 0 '+spec.width+' '+spec.height+'" style="width:'+(factor*100)+'%" role="img" aria-label="Пример появления слов: Каждая твоя история заслуживает внимания">'+
    spec.words.map((w,i)=>'<text class="motion-word" data-motion-word="'+i+'" data-first="'+(spec.mode==='single'?i===0:w.start_ms<2750)+'" x="'+w.x+'" y="'+w.baseline+'" text-anchor="middle" style="transform-origin:'+w.x+'px '+w.y+'px;font-family:&quot;'+e(w.family)+'&quot;;font-size:'+w.size+'px;letter-spacing:'+(w.tracking||0)+'px;fill:var(--caption-'+(w.hero?'accent':'context')+')">'+e(w.text)+'</text>').join('')+'</svg>';
}
function referenceMotionFrames(word,loop,moving){
  const duration=word.end_ms-word.start_ms;
  const scales=moving?word.scales:[[0,1]];
  const times=[0,word.start_ms,word.start_ms+word.fade_in,word.end_ms-word.fade_out,word.end_ms,loop,
    ...scales.map(([t])=>word.start_ms+t)];
  return [...new Set(times)].sort((a,b)=>a-b).map(t=>{
    const local=t-word.start_ms;
    const opacity=local<0||local>=duration?0:Math.min(word.fade_in?local/word.fade_in:1,word.fade_out?(duration-local)/word.fade_out:1,1);
    let scale=scales[0][1];
    for(let i=1;i<scales.length;i++){
      const [a,left]=scales[i-1],[b,right]=scales[i];
      if(local>=b)scale=right;
      else if(local>a){scale=left+(right-left)*(local-a)/(b-a);break;}
    }
    return {offset:t/loop,opacity,transform:'scale('+scale+')',easing:'linear'};
  });
}
let captionAnimations=[],captionMediaCleanup=null,captionGeneration=0;
function stopCaptionPreview(){
  captionGeneration++;
  captionAnimations.forEach(a=>a.cancel());captionAnimations=[];
  if(captionMediaCleanup){captionMediaCleanup();captionMediaCleanup=null;}
}
async function mountCaptionPreview(){
  stopCaptionPreview();
  const generation=captionGeneration;
  const captions=[...document.querySelectorAll('.reference-caption')];
  if(!captions.length)return;
  const requirements=captionFontRequirements();
  const svgs=[...document.querySelectorAll('.reference-motion')];
  const spec=caps.typography_motion?.[draft.font]?.[draft.animation];
  const moving=draft.finishing_version===1||draft.motion,media=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if(media?.addEventListener){const change=()=>mountCaptionPreview();media.addEventListener('change',change);captionMediaCleanup=()=>media.removeEventListener('change',change);}
  svgs.forEach(svg=>svg.classList.add('static-preview'));
  try{
    if(!requirements.length)throw new Error('Caption fonts are unavailable');
    // Markup already hides uncached faces, so a fallback font never flashes.
    // Ready pairs take this path synchronously, without hiding cached text.
    if(captionFontState(requirements)!=='ready'){
      updateCaptionFontState('loading',captions);
      const results=await Promise.allSettled(requirements.map(loadCaptionFont));
      if(results.some(result=>result.status==='rejected'))throw new Error('Caption fonts failed to load');
    }
    if(captions.some(svg=>!svg.isConnected)||generation!==captionGeneration)return;
  }catch{
    if(captions.some(svg=>!svg.isConnected)||generation!==captionGeneration)return;
    updateCaptionFontState('error',captions);
    svgs.forEach(svg=>svg.classList.add('static-preview'));
    return;
  }
  updateCaptionFontState('ready',captions);
  warmCaptionFonts();
  // Static/reduced-motion previews still need the correct fonts; only their
  // animation is optional. The loading/error state never changes the draft.
  if(!spec||media?.matches||svgs.some(svg=>!svg.animate))return;
  const animations=[];
  try{
    for(const el of svgs.flatMap(svg=>[...svg.querySelectorAll('[data-motion-word]')]))animations.push(el.animate(
      referenceMotionFrames(spec.words[Number(el.dataset.motionWord)],spec.duration_ms,moving),
      {duration:spec.duration_ms,iterations:Infinity,fill:'both',easing:'linear'}));
    const start=document.timeline.currentTime;
    animations.forEach(a=>{a.startTime=start;if(document.hidden)a.pause();});
    captionAnimations=animations;svgs.forEach(svg=>svg.classList.remove('static-preview'));
  }catch{
    // Animation support may fail independently of font loading. Keep the
    // correctly loaded static caption and cancel any partially created motion.
    animations.forEach(a=>a.cancel());
    svgs.forEach(svg=>svg.classList.add('static-preview'));
  }
}
document.addEventListener?.('visibilitychange',()=>captionAnimations.forEach(a=>document.hidden?a.pause():a.play()));
let compactPreviewCleanup=null;
function stopCompactPreview(){
  if(compactPreviewCleanup){compactPreviewCleanup();compactPreviewCleanup=null;}
}
function compactPreviewGeometry(portrait,caption,workspace,uploadAction,top,viewportHeight,viewportBottom=viewportHeight){
  if(!portrait.width||!workspace.width||!caption.height)return {visible:false};
  // Crop around the whole caption block, not a fixed point in the photograph:
  // the top/bottom position and every font pair keep their complete text visible.
  const scale=workspace.width/portrait.width;
  const height=Math.ceil(Math.max(92,caption.height*scale+24));
  const offset=Math.max(0,Math.min(portrait.height*scale-height,
    (caption.top-portrait.top+caption.height/2)*scale-height/2));
  // Match the scrolled reference: icon, label and most of the file button are
  // visible above the navigation before the hint fades out.
  const uploadReady=uploadAction.top+uploadAction.height*.8<=viewportBottom;
  return {height,offset,visible:caption.bottom<=top&&!uploadReady&&height<viewportHeight*.35};
}
function mountCompactPreview(){
  stopCompactPreview();
  const compact=document.querySelector('.compact-preview');
  const portrait=document.querySelector('.montage-preview .portrait-demo');
  const caption=portrait?.querySelector('.demo-caption');
  const workspace=document.querySelector('.workspace');
  const uploadAction=document.querySelector('#choose-file');
  const navigation=document.querySelector('.nav');
  if(!compact||!caption||!workspace||!uploadAction)return;
  // An inert, silent mirror of the existing preview: no second demo player,
  // no new settings and no changes to the actual render contract.
  const mirror=portrait.cloneNode(true);
  mirror.inert=true;
  mirror.querySelectorAll('.demo-badge,.demo-sign').forEach(el=>el.remove());
  mirror.querySelectorAll('img').forEach(el=>el.alt='');
  const sourceVideo=portrait.querySelector('video'),mirrorVideo=mirror.querySelector('video');
  if(mirrorVideo){mirrorVideo.removeAttribute('controls');mirrorVideo.removeAttribute('loop');mirrorVideo.muted=true;mirrorVideo.preload='metadata';mirrorVideo.tabIndex=-1;}
  compact.replaceChildren(mirror);
  compact.hidden=false;
  let frame=null,alive=true,visible=false;
  const syncVideo=()=>{if(mirrorVideo&&visible&&Math.abs(mirrorVideo.currentTime-sourceVideo.currentTime)>.2){try{mirrorVideo.currentTime=sourceVideo.currentTime;}catch{}}};
  const update=()=>{
    frame=null;if(!alive)return;
    const top=parseFloat(window.getComputedStyle(compact).top)||0;
    const viewportHeight=window.visualViewport?.height||window.innerHeight;
    const viewportBottom=Math.min(viewportHeight,navigation?.getBoundingClientRect().top??viewportHeight);
    const geometry=compactPreviewGeometry(portrait.getBoundingClientRect(),caption.getBoundingClientRect(),workspace.getBoundingClientRect(),uploadAction.getBoundingClientRect(),top,viewportHeight,viewportBottom);
    if(geometry.height){compact.style.height=geometry.height+'px';mirror.style.transform='translateY(-'+geometry.offset+'px)';}
    // Keep the mirror mounted for the exit transition. CSS reverses an ongoing
    // fade smoothly when scrolling back, without timers or display:none flashes.
    visible=geometry.visible;
    compact.classList.toggle('is-visible',visible);
    syncVideo();
  };
  const schedule=()=>{if(frame===null&&alive)frame=window.requestAnimationFrame(update);};
  telegramViewportListeners.add(schedule);
  window.addEventListener('scroll',schedule,{passive:true});
  window.addEventListener('resize',schedule);
  const viewport=window.visualViewport;
  viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);
  const observer=window.ResizeObserver?new window.ResizeObserver(schedule):null;
  [portrait,caption,workspace,uploadAction,navigation].filter(Boolean).forEach(el=>observer?.observe(el));
  sourceVideo?.addEventListener('timeupdate',syncVideo);mirrorVideo?.addEventListener('loadedmetadata',syncVideo);
  document.fonts?.ready.then(()=>{if(alive)schedule();});
  compactPreviewCleanup=()=>{
    alive=false;if(frame!==null)window.cancelAnimationFrame(frame);
    telegramViewportListeners.delete(schedule);
    window.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);
    viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);
    observer?.disconnect();sourceVideo?.removeEventListener('timeupdate',syncVideo);mirrorVideo?.removeEventListener('loadedmetadata',syncVideo);
    compact.classList.toggle('is-visible',false);compact.hidden=true;
  };
  update();
}
function montage(){
  const reference=draft.typography==='reference';
  const palette=reference?caps.colors:(caps.legacy_colors||caps.colors);
  const style=caps.styles[previewStyle]||caps.styles[0];
  const sampleStyle=captionDemoStyle();
  return '<h1 class="sr-only">Монтаж ролика</h1><div class="compact-preview" hidden aria-hidden="true"></div><section class="montage-preview" aria-label="Предпросмотр оформления">'+
    '<div class="portrait-demo '+(blob?'has-source':'has-presenter')+'" style="'+e(sampleStyle)+'">'+
      (blob?'<video src="'+e(blob)+'" muted loop playsinline controls aria-label="Загруженный исходник"></video>':'<img class="demo-presenter" src="/assets/presenter-v1.jpg?v=2" width="1024" height="1536" alt="ИИ-кадр: ведущий с микрофоном в тёплой студии" decoding="async" fetchpriority="high"><div class="demo-photo-shade" aria-hidden="true"></div>')+
      (blob?'<span class="demo-badge">Твой исходник</span>':'<button type="button" class="demo-badge demo-play" id="show-demo" aria-label="Смотреть видеопример оформления"><span aria-hidden="true">▷</span> Пример</button>')+
      (style.enabled?'<div class="'+captionDemoClass()+'">'+captionDemo()+'</div>':'<div class="style-soon"><b>'+e(style.id)+'</b><span>В разработке</span><small>Пока доступен монтаж в стиле Glass</small></div>')+
      '<span class="demo-sign">REEL LAB · '+e(style.id.toUpperCase())+(blob?'':' · ИИ-КАДР')+'</span></div>'+
    '<div class="style-carousel"><button data-style-cycle="-1" aria-label="Предыдущий стиль">‹</button><strong>'+e(style.id)+'</strong><button data-style-cycle="1" aria-label="Следующий стиль">›</button></div>'+
    '<div class="style-dots" aria-label="Стили">'+caps.styles.map((s,i)=>'<button data-style-index="'+i+'" aria-label="Стиль '+e(s.id)+'" aria-pressed="'+(i===previewStyle)+'" class="'+(i===previewStyle?'selected':'')+'"></button>').join('')+'</div></section>'+
    '<div class="choice-strip" data-strip="fonts" aria-label="Пара шрифтов">'+caps.fonts.map(f=>'<button data-font="'+e(f.name)+'" aria-pressed="'+(draft.font===f.name)+'" class="choice-chip '+(draft.font===f.name?'selected':'')+'" title="'+e(f.description)+'">'+e(f.name)+'</button>').join('')+'</div>'+
    (style.enabled?captionFontStatusMarkup():'')+'<div class="choice-strip" data-strip="colors" aria-label="Цвет акцента">'+palette.map(c=>'<button data-color="'+c.key+'" aria-pressed="'+(c.key===draft.color)+'" class="choice-chip color-chip '+(c.key===draft.color?'selected':'')+'"><i style="background:'+c.hex+'"></i>'+e(c.ru)+'</button>').join('')+'</div>'+
    '<div class="save-line"><span id="save-status"></span><button class="text-button" data-help="position">Об эскизе</button></div>'+
    '<section class="settings-section"><h2>Субтитры</h2><div class="tile-grid">'+
      cycleTile('animation','Оформление',caps.features.caption_modes?['dynamic','lines','single']:['line','word','none'])+
      cycleTile('size','Размер текста',['small','medium','large'])+
      cycleTile('position','Расположение',['auto','top','bottom'])+'</div></section>'+
    '<section class="settings-section"><h2>Параметры</h2><div class="tile-grid effects">'+
      effectTile('emoji','Эмодзи в субтитрах',caps.features.emoji)+effectTile('sound_effects','Звуковые эффекты',caps.features.sound_effects)+effectTile('media_cards','Медиа-карточки',caps.features.media_cards??caps.features.generated_media)+
      effectTile('panels','Плашки и карточки',caps.features.panels)+effectTile('motion','Движение камеры',caps.features.motion)+effectTile('opening_zoom','Наезд камеры в начале',caps.features.opening_zoom)+
      effectTile('hook',localNoLLM()?'Хук к видео':'Придумать хук к видео',caps.features.hook_title??caps.features.hook_rewrite)+'</div></section>'+
    '<section class="settings-section video-section"><div class="section-heading"><h2>Видео</h2><button class="text-button video-requirements" data-help="video">'+icon('info')+'<span>Требования к видео</span></button></div>'+
      uploadPicker()+'<div id="upload-status" role="status">'+uploadStatus()+'</div>'+smartCutControl()+montageAction(style)+'</section>';
}
function featureSummary(job){
  const report=job.result?.feature_results;if(!report)return '';
  const names={smart_cut:'Умная нарезка',cut_pauses:'Сокращение пауз',emoji:'Эмодзи',sound_effects:'Звуковые эффекты',media_cards:'Медиа-карточки',panels:'Плашки',motion:'Движение камеры',opening_zoom:'Начальный наезд',hook:'Хук'};
  return '<section class="card feature-results"><h3>Что выполнено в ролике</h3>'+Object.entries(names).map(([key,name])=>{
    const item=report[key];if(!item)return '';
    const count=Number.isInteger(item.count)&&item.count>=0?item.count:0;
    const cuts=['smart_cut','cut_pauses'].includes(key);
    const status=!item.enabled?'Выключено':item.applied?(cuts?'Сокращено · '+count:'Добавлено'+(['motion','opening_zoom','hook'].includes(key)?'':' · '+count)):
      cuts&&item.evaluated===true?'Не потребовалось':'Пропущено';
    return '<div class="kv"><span>'+name+'</span><b>'+status+'</b></div>'+
      (key==='panels'&&item.applied&&Number.isInteger(item.accent_count)&&item.accent_count>=0&&Number.isInteger(item.readability_count)&&item.readability_count>=0?'<p class="preview-description">Акцентных: '+item.accent_count+'. Подложек для читаемости: '+item.readability_count+'.</p>':'')+
      (item.enabled&&!item.applied&&item.reason?'<p class="preview-description">'+e(item.reason)+'</p>':'');
  }).join('')+'</section>';
}
function clips(){
  const failed=j=>['failed','cancelled'].includes(j.status);
  const visible=jobs.filter(j=>clipFilter==='failed'?failed(j):!failed(j));
  return queueSummary()+'<h1 class="sr-only">Мои ролики</h1><div class="clip-tabs" role="tablist" aria-label="Статус роликов"><button role="tab" data-clip-filter="ready" aria-selected="'+(clipFilter==='ready')+'">Ролики</button><button role="tab" data-clip-filter="failed" aria-selected="'+(clipFilter==='failed')+'">Не получились</button></div>'+
    (visible.length?'<div class="clip-list">'+visible.map(j=>'<article class="clip-row"><button class="clip-thumb" data-job="'+j.id+'" aria-label="Открыть '+e(j.name)+'">'+(j.status==='completed'?'<img src="'+e(jobArtifactUrl(j,'cover'))+'" alt="">':icon('clips'))+'</button><div class="clip-info"><button class="clip-title" data-job="'+j.id+'">'+e(j.settings.style)+' · '+e(caps.colors.find(c=>c.key===j.settings.color)?.ru)+'</button><small>'+date(j.created)+' · '+(j.status==='completed'?(vpsPipeline()?'Готово':'Бесплатно'):e(statuses[j.status]))+'</small><small class="clip-filename">'+e(j.name)+'</small>'+
      (j.status==='completed'?'<small>'+j.result.duration.toFixed(1)+' с · '+(vpsPipeline()?'хранится на сервере':'хранится на компьютере владельца')+'</small><div class="clip-buttons"><a class="pill-light" data-download-job="'+e(j.id)+'" data-download-kind="video" href="'+e(jobArtifactUrl(j,'video',true))+'" download>Скачать</a>'+(caps.features.telegram_delivery===false?'':'<button data-deliver="'+j.id+'">Отправить в TG</button>')+'</div>':'<p class="clip-phase">'+e(j.error||phases[j.phase]||statuses[j.status])+jobProgressMarkup(j,true)+'</p><button class="text-button" data-job="'+j.id+'">Подробнее →</button>')+'</div></article>').join('')+'</div>':'<section class="empty"><div class="empty-icon">'+icon('clips')+'</div><h2>'+(clipFilter==='failed'?'Неудачных монтажей нет':'Пока нет роликов')+'</h2><p>'+(clipFilter==='failed'?'И пусть так и остаётся.':'Загрузи первое видео — готовый монтаж появится здесь.')+'</p>'+(clipFilter==='ready'?'<button class="primary" data-page="montage">Начать монтаж</button>':'')+'</section>');
}
function detail(){const j=jobs.find(x=>x.id===detailId);if(!j)return `<p>Ролик загружается…</p>`;const color=caps.colors.find(c=>c.key===j.settings.color);const format=outputFormat(j.settings);return `<button data-page="clips">← Все ролики</button><div class="detail"><div>${j.status==='completed'?completedPlayerMarkup(j):`<div class="card empty"><div class="symbol">${j.status==='failed'?'!':'▷'}</div><h2>${statuses[j.status]}</h2><p>${e(j.error||'Исходник сохранён. Результат появится здесь.')}</p></div>`}</div><div><div class="eyebrow">${date(j.created)}</div><h2>${e(j.name)}</h2>${['queued','running','cancelling'].includes(j.status)?`<div class="phase" role="status"><i class="pulse"></i>${e(phases[j.phase]||statuses[j.status])}${jobProgressMarkup(j)}<button id="cancel-job" ${j.status==='cancelling'?'disabled':''}>Отменить обработку</button></div>`:''}${j.result?`<div class="stats"><div class="stat"><b>${j.result.duration.toFixed(1)}</b><span>секунд на выходе</span></div><div class="stat"><b>${j.result.removed_seconds.toFixed(1)}</b><span>секунд убрано</span></div><div class="stat"><b>${e(format[0])}</b><span>${e(format[1])}</span></div></div>`:''}<section class="card"><h3>Настройки этого ролика</h3>${[['Стиль',j.settings.style],['Сценарий',montagePresetLabel(j.settings.montage_preset)],['Цвет',color.ru],['Шрифт',j.settings.font],['Размер',labels[j.settings.size]],['Положение',labels[j.settings.position]],['Появление',labels[j.settings.animation]],['Модель',modelLabel(j.settings.model)],['Режиссура',labels[j.settings.director]],['Умная нарезка',j.settings.smart_cut?'Включена':'Выключена'],['Нарезка пауз',j.settings.cut_pauses?'Включена':'Выключена'],['Плашки',j.settings.panels?'Включены':'Выключены'],['Движение',j.settings.motion?'Включено':'Выключено'],['Начальный наезд',j.settings.opening_zoom?'Включён':'Выключен'],['Звуковые акценты',j.settings.sound_effects?'Включены':'Выключены'],['Фоновая музыка',j.settings.background_music?'Включена':'Выключена'],['Эмодзи',j.settings.emoji?'Включены':'Выключены'],['Медиа-карточки',j.settings.media_cards?'Включены':'Выключены'],['Хук-заголовок',j.settings.hook?'Включён':'Выключен'],['Обложка',j.settings.designed_cover?'Дизайнерская':'Кадр видео']].map(([k,v])=>`<div class="kv"><span>${k}</span><b>${e(v)}</b></div>`).join('')}</section>${featureSummary(j)}${j.result?.warnings.length?`<div class="notice"><strong>Проверь перед публикацией</strong><ul>${j.result.warnings.map(w=>`<li>${e(w)}</li>`).join('')}</ul></div>`:''}${['completed','failed','cancelled'].includes(j.status)?`<button id="retry-job">${j.settings.model==='small'?'Повторить с '+modelLabel(caps.default_model||'turbo'):'Повторить с теми же настройками'}</button><p class="preview-description">Создаст отдельную задачу из сохранённого исходника. Предыдущий результат не изменится.</p>`:''}</div></div>`;}
function balance(){
  return '<h1>Баланс</h1><section class="card balance-card"><span>'+(vpsPipeline()?'Обработка':'Твой тариф')+'</span><b class="balance-total">'+(vpsPipeline()?'На сервере':'Бесплатно')+'</b><p>'+(vpsPipeline()?'Анализ расходует кредиты OpenRouter владельца':'Локальная обработка · без платных API')+'</p><button class="pill-light" data-page="clips">История монтажей</button></section><section class="card"><h2>Твоя статистика</h2><div class="stats"><div class="stat"><b>'+jobs.filter(j=>j.status==='completed').length+'</b><span>готовых роликов</span></div><div class="stat"><b>'+jobs.filter(j=>['queued','running','cancelling'].includes(j.status)).length+'</b><span>в очереди и работе</span></div></div></section>'+usagePanel()+'<section class="card"><h2>Как это работает</h2><p>'+(vpsPipeline()?'Монтаж выполняется на сервере; баланс OpenRouter здесь не отображается.':'Покупать токены не нужно. Монтаж выполняется на компьютере владельца.')+' Личные лимиты защищают общую очередь, в ней до '+caps.limits.queue_size+' задач.</p><p>Платёжных пакетов, подписок и реферальных выплат пока нет.</p></section>';
}
function referrals(){return invitationView();}
function profileRow(target,name,ico,detail){return '<button type="button" class="profile-row" data-page="'+e(target)+'">'+icon(ico)+'<span>'+e(name)+'</span>'+(detail===undefined?'':'<b class="profile-row-detail">'+e(detail)+'</b>')+icon('arrow')+'</button>';}
function profileHelpRow(key,name,ico){return '<button type="button" class="profile-row" data-help="'+e(key)+'">'+(ico?icon(ico):'')+'<span>'+e(name)+'</span>'+icon('arrow')+'</button>';}
function profileClipLabel(total){return total%10===1&&total%100!==11?'Смонтирован ролик':'Смонтировано роликов';}
function profileCount(){
  const total=jobs.filter(j=>j.status==='completed').length;
  return '<button type="button" class="profile-panel profile-count" data-page="clips" data-profile-clips aria-label="Мои ролики: '+total+'"><span class="profile-count-icon" aria-hidden="true">'+icon('clips')+'</span><span class="profile-count-copy"><b data-profile-total>'+total+'</b><span data-profile-caption>'+profileClipLabel(total)+'</span></span></button>';
}
function updateProfileCount(){
  const card=document.querySelector('[data-profile-clips]');if(!card)return;
  const total=jobs.filter(j=>j.status==='completed').length;
  card.setAttribute('aria-label','Мои ролики: '+total);
  card.querySelector('[data-profile-total]').textContent=total;
  card.querySelector('[data-profile-caption]').textContent=profileClipLabel(total);
}
function profile(){
  return '<div class="profile-screen"><h1 class="sr-only">Профиль</h1><section class="profile-panel profile-account" aria-label="Учётная запись"><h2>'+icon('profile')+(operator?'Кабинет владельца':'Мой кабинет')+'</h2><p>'+(linked?'Telegram подключён':'Локальная Studio')+'</p></section>'+
    profileCount()+
    '<section class="profile-menu" aria-label="Меню профиля">'+profileRow('balance','Баланс и лимиты','coins')+profileRow('support','Поддержка','lifebuoy')+profileRow('referrals','Пригласить участника','referrals')+profileHelpRow('about','О сервисе','info')+'</section>'+
    '<section class="profile-panel language-card" aria-label="Язык приложения"><h2>Язык</h2><div class="language-options" role="group" aria-label="Язык интерфейса"><button type="button" aria-pressed="true" data-help="language">Русский</button><button type="button" aria-pressed="false" data-help="language" aria-label="English — информация о доступности">English</button></div></section>'+
    '<section class="profile-docs" aria-labelledby="profile-docs-title"><h2 id="profile-docs-title">Информация</h2><div class="profile-menu">'+profileHelpRow('privacy','Данные и хранение')+'</div></section>'+
    (operator?'<details class="profile-settings" data-disclosure="owner"><summary>Управление и подключение Telegram</summary>'+telegramPanel()+operationsPanel(true)+'</details>':'')+'</div>';
}
function support(){
  const faq=vpsPipeline()?[
    ['Как работает монтаж?','Выбери оформление, загрузи видео и нажми «Создать ролик». Сервер распознает речь, проанализирует звук и изображение, соберёт MP4. Результат и SRT появятся в разделе «Ролики».'],
    ['Какие видео подходят?','MP4, MOV, M4V, WebM и MKV. До '+Math.floor(caps.limits.max_seconds/60)+' минут и '+Math.floor(caps.limits.max_bytes/1024/1024)+' МиБ, в пределах оставшегося лимита хранения.'],
    ['Сколько стоит обработка?','Анализ Qwen расходует кредиты OpenRouter владельца. Автоматических повторов платных запросов после ошибки нет. Кнопка «Повторить» запускает отдельную обработку.'],
    ['Какие функции пока недоступны?',caps.settings_notice+' Исправление готовой расшифровки и отправка результата ботом также пока не подключены. MP4 и SRT можно скачать в приложении.'],
    ['Где хранятся данные?','Исходники и результаты хранятся на сервере Reel Lab. Для анализа облегчённая копия видео со звуком и данные анализа передаются Qwen через OpenRouter. Участник видит только свои ролики; владелец сервиса имеет доступ к файлам. Автоматическое удаление пока не включено.'],
    ['Можно закрыть приложение?','После успешной загрузки и постановки задачи в очередь можно закрыть Mini App. Обработка продолжится на сервере.']
  ]:[
    ['Как работает монтаж?','Выбери шрифт, цвет и эффекты, загрузи видео, нажми «Создать ролик». Готовый MP4 появится в разделе «Ролики». При подключённом Telegram бот отправит его в чат.'],
    ['Какие видео подходят?','MP4, MOV, M4V, WebM, MKV и AVI, до 3 минут. Лимит через этот интерфейс: '+Math.floor(caps.limits.max_bytes/1024/1024)+' МиБ. Через облачный Bot API — до 20 МиБ. Нужна разборчивая речь.'],
    ['Сколько стоит монтаж?','Участники используют общую очередь и свои лимиты запусков. При подключённом Codex расходуются лимиты и кредиты ChatGPT владельца.'],
    ['Как обрезать ролик до минуты?',!supportsShortform()?'Сокращение до 60 секунд пока недоступно. Удалить выбранные фразы можно в редакторе готового ролика.':'Включи «Умная нарезка» перед запуском. Qwen выбирает целые фразы по расшифровке. Обязательно проверь связность результата. Для готового длинного ролика есть кнопка «Собрать версию до 60 секунд».'],
    ['Как исправить текст или убрать фразу?','Открой результат → «Исправить текст и монтаж». Исправь слова или отметь «Убрать». Будет создана новая версия, предыдущая и исходник сохранятся. Правка титров не меняет произнесённую речь.'],
    ['Как работают оформление и вставки?',codexEditorial()?'Codex выбирает эмодзи и законченную цитату для заголовка по расшифровке и доступным наблюдениям о кадрах. Текст и кадры — по одному в секунду по всей длине исходного ролика (до 3 минут) — отправляются OpenAI через ChatGPT. GigaAM распознаёт звук локально; Codex его не слушает. На анализ кадров отведено до 60 секунд, затем один запрос оформления — ещё до 60 секунд. Выборка может пропустить события между снимками. Если анализ кадров недоступен, используем только текст; если запрос оформления недоступен — локальные правила. Codex не исправляет ошибки распознавания и не меняет речь. Иллюстрации, музыка и звуковые эффекты работают по прежним локальным правилам.':localNoLLM()?'Плашки, движение и тени — экранные эффекты 2.5D. Иллюстрации рисуются по поддерживаемым темам речи, эмодзи выбираются по контекстным правилам, хук — законченная цитата из видео. Возможные пропуски указаны в результате.':'Это экранные слои, тени и движение — 2.5D. Иллюстрации создаёт локальная SD, эмодзи выбираются по темам, заголовок — по речи. Трекинга сцены в 3D нет. Шрифтовые пары — наши интерпретации. Сгенерированные картинки не являются реальными кадрами.'],
    ['Как долго хранятся ролики?','На компьютере владельца, автоматического удаления пока нет. Для удаления файлов отправь обращение ниже. Команда /delete_my_data отключает Telegram и удаляет настройки бота, но не видео.'],
    ['Когда сервис доступен?','Пока компьютер владельца включён, не спит, а сервис и HTTPS-туннель запущены. При сетевой ошибке бот повторит соединение.']
  ];
  return '<button class="back-link" data-page="profile">‹ Профиль</button><h1>Поддержка</h1><p class="lede">Здесь ответы на частые вопросы.<br>Если нужна помощь — напиши владельцу ниже.</p><section class="card faq">'+faq.map(([q,a])=>'<details><summary>'+q+'</summary><p>'+e(a)+'</p></details>').join('')+'</section>'+operationsPanel(false);
}
function telegramPanel(){return `<section class="card"><h2>Подключить мой Telegram</h2><p>Только для владельца: эта кнопка связывает Telegram с уже сохранёнными роликами локального кабинета. Других пользователей приглашай во вкладке «Пригласить» — у них будут отдельные библиотеки.</p><p>${linked?'Telegram подключён. Кнопка «Студия ✨» в боте открывает твои ролики.':'Telegram владельца ещё не подключён.'}</p><button id="pair">Подключить мой Telegram</button>${linked?' <button id="unlink">Отключить Telegram</button>':''}<div id="pair-result" role="status"></div></section>`;}
function render(){
  stopCompactPreview();
  stopCaptionPreview();
  const strips=[...document.querySelectorAll('[data-strip]')].map(x=>[x.dataset.strip,x.scrollLeft]);
  const opened=[...document.querySelectorAll('[data-disclosure][open]')].map(x=>x.dataset.disclosure);
  const focused=document.activeElement;
  const focusKey=focused?.hasAttribute('data-cycle')?'data-cycle':focused?.hasAttribute('data-option')?'data-option':focused?.hasAttribute('data-font')?'data-font':focused?.hasAttribute('data-color')?'data-color':null;
  const focusValue=focusKey?focused.getAttribute(focusKey):null;
  app.innerHTML='<div class="shell">'+header()+'<main class="workspace">'+(detailId?detail():({montage,clips,balance,referrals,profile,support}[page]||montage)())+'</main>'+nav()+'</div>';
  wire();showSaveStatus();mountOperations();mountEditor();mountCompactPreview();mountCaptionPreview();
  strips.forEach(([key,left])=>{const el=document.querySelector('[data-strip="'+key+'"]');if(el)el.scrollLeft=left;});
  document.querySelectorAll('[data-strip]').forEach(el=>{
    if(strips.some(([key])=>key===el.dataset.strip))return;
    const chosen=el.querySelector('[aria-pressed="true"]');
    if(chosen)el.scrollLeft=chosen.offsetLeft-el.offsetLeft-(el.clientWidth-chosen.offsetWidth)/2;
  });
  opened.forEach(key=>{const el=document.querySelector('[data-disclosure="'+key+'"]');if(el)el.open=true;});
  if(focusKey){[...document.querySelectorAll('['+focusKey+']')].find(x=>x.getAttribute(focusKey)===focusValue)?.focus({preventScroll:true});}
}
function helpIllustration(illustration){
  if(!illustration)return '';
  const classes='help-illustration'+(illustration.portrait?' help-illustration-portrait':'');
  const image='<img src="'+e(illustration.src)+'" alt="'+e(illustration.alt)+'" width="'+illustration.width+'" height="'+illustration.height+'"';
  if(!illustration.crop)return image+' class="'+classes+'">';
  const crop=illustration.crop;
  return '<div class="'+classes+' help-reference-crop" style="aspect-ratio:'+crop.width+'/'+crop.height+'">'+image+
    ' style="width:'+(illustration.width/crop.width*100)+'%;left:'+(-crop.x/crop.width*100)+'%;top:'+(-crop.y/crop.height*100)+'%"></div>';
}
function helpDescription(description){
  if(!Array.isArray(description))return '<p id="help-description">'+e(description)+'</p>';
  return '<div id="help-description" class="help-paragraphs">'+description.map(text=>'<p>'+e(text)+'</p>').join('')+'</div>';
}
function helpContent(key){
  if(vpsPipeline()){
    const help={
      privacy:['Данные и хранение','Исходники и результаты хранятся на сервере Reel Lab. Для анализа облегчённая копия видео со звуком и данные анализа передаются Qwen через OpenRouter. Каждый участник видит только свои ролики. Владелец сервиса имеет доступ к файлам. Автоматическое удаление пока не включено.'],
      about:['О сервисе','Reel Lab — монтаж в Telegram. Сервер распознаёт речь, анализирует звук и кадр с Qwen и собирает ролик в выбранном оформлении. Готовый результат нужно проверить перед публикацией.'],
      emoji:['Эмодзи в субтитрах','Qwen подбирает эмодзи по смыслу слов. Эмодзи появляется внутри строки субтитров сразу после выбранного слова, вместе с ним. Если подходящего слова нет, вставку пропускаем.'],
      media_cards:['Медиа-карточки','Qwen выбирает подходящие моменты для карточек с кадрами твоего исходника. Они появляются поверх видео, если соответствуют содержанию. Если подходящего кадра или места нет, карточку пропускаем.'],
      position:['Расположение','Qwen отмечает лица и важные области. Система проверяет размещение текста; при нехватке места использует отдельную панель. Это не размещение текста за человеком.'],
      size:['Размер текста','Размер субтитров выбранной пары шрифтов. Текст, который невозможно безопасно разместить, останавливает сборку вместо обрезки слов.'],
      spatial_text:['Текст за человеком','Этот эффект ещё не подключён к серверной обработке. Защита лиц при размещении субтитров работает отдельно.'],
    }; if(help[key])return help[key];
    if(['hook','designed_cover','background_music'].includes(key))return [interfaceHelp[key]?.[0]||'Функция','Эта функция ещё не подключена к серверной обработке.'];
  }
  const codex={
    emoji:['Эмодзи в субтитрах','Codex выбирает редкие эмодзи по расшифровке и доступным наблюдениям о кадрах. Текст и кадры — по одному в секунду по всей длине исходного ролика (до 3 минут) — отправляются OpenAI через ChatGPT. GigaAM распознаёт звук локально; Codex его не слушает. Выборка может пропустить события между снимками. Codex не исправляет ошибки распознавания и не меняет слова субтитров. Вставки, закрывающие лицо или титры, пропускаем. Если анализ кадров недоступен, используем только текст; если запрос оформления недоступен — локальные правила. Причину указываем в результате.'],
    hook:['Хук к видео','Codex выбирает законченную цитату из расшифровки для заголовка и обложки с учётом доступных наблюдений о кадрах. Текст и кадры — по одному в секунду по всей длине исходного ролика (до 3 минут) — отправляются OpenAI через ChatGPT. GigaAM распознаёт звук локально; Codex его не слушает. Выборка может пропустить события между снимками. Codex не исправляет ошибки распознавания и не меняет речь. Если подходящей цитаты или места нет, заголовок пропускаем. Если анализ кадров недоступен, используем только текст; если запрос оформления недоступен — локальные правила. Причину указываем в результате.'],
    privacy:['Данные и хранение','Если включена умная нарезка, текст отправляется OpenAI через ChatGPT. Если включены эмодзи, хук или оформление обложки, текст и кадры — по одному в секунду по всей длине исходного ролика (до 3 минут) — отправляются OpenAI через ChatGPT. GigaAM распознаёт звук локально; Codex его не слушает, видеофайл целиком не отправляется Codex. Выборка может пропустить события между снимками. Codex не исправляет ошибки распознавания. При включённой умной нарезке текст также используется для поиска съёмочных ремарок и повторов. Загрузки в Mini App проходят через Cloudflare, сообщения бота — через Telegram. Каждый участник видит только свои ролики. Владелец сервиса имеет доступ к файлам. Автоудаление не включено; для удаления обратитесь в поддержку.']
  };
  if(codexEditorial()&&codex[key])return codex[key];
  const local={
    emoji:['Эмодзи в субтитрах','Выбираем редкие эмодзи по словам и соседним фразам: например, инструменты для ремонта или деньги для стоимости. Учитываем известные отрицания и переносные выражения. Если тема неоднозначна или значок закрывает лицо, пропускаем вставку. Проверь соответствие речи в результате.'],
    media_cards:['Медиа-карточки','Добавляем нарисованные иллюстрации по темам речи: дом, бассейн, ремонт, стоимость и другие поддерживаемые темы. Карточка появляется у соответствующего слова, если не закрывает лицо и титры. Это иллюстрации, а не фотографии объектов из видео.'],
    hook:['Хук к видео','Выбираем короткую законченную фразу из расшифровки и показываем её заголовком в начале. Приветствия и реплики для съёмки исключаем. Голос и порядок речи сохраняются; новые факты и обещания не придумываются. Если подходящей фразы или места для неё нет, причина будет указана в результате.']
  };
  return localNoLLM()&&local[key]?local[key]:interfaceHelp[key];
}
function showHelp(key){
  if(key==='cuts'&&caps?.features?.semantic_cuts){interfaceHelp.cuts=['Умная нарезка',['Убирает явные съёмочные ремарки, повторные дубли и неудачные старты фраз. Основной рассказ и порядок мыслей сохраняются.','Не задаёт длину в 60 секунд и не меняет настройку сокращения тихих пауз.']];}

  const content=helpContent(key);if(!content)return;
  const description=key==='video'?(vpsPipeline()?'MP4, MOV, M4V, WebM или MKV. До ':'MP4, MOV, M4V, WebM, MKV или AVI. До ')+Math.floor((caps.limits.max_seconds||180)/60)+' минут, до '+Math.floor(caps.limits.max_bytes/1024/1024)+' МиБ. '+(vpsPipeline()?'Исходники хранятся на сервере Reel Lab.':'Нужна звуковая дорожка с разборчивой речью. Исходники хранятся на компьютере владельца.'):content[1];
  const illustration=localNoLLM()&&['media_cards','hook'].includes(key)?null:interfaceHelpIllustrations[key];
  document.querySelector('#help-dialog')?.remove();
  const trigger=document.activeElement;
  const dialog=document.createElement('dialog');dialog.id='help-dialog';dialog.className='help-dialog help-sheet'+(referenceHelpKeys.has(key)?' help-sheet-reference':'');
  dialog.setAttribute('aria-labelledby','help-title');
  dialog.setAttribute('aria-describedby','help-description');
  dialog.innerHTML=helpIllustration(illustration)+
    '<h2 id="help-title">'+e(content[0])+'</h2>'+helpDescription(description)+
    (content[2]?'<dl class="help-options">'+content[2].map(item=>'<div><dt>'+e(item.title)+(item.recommended?'<span class="help-recommendation"><span aria-hidden="true">★</span> Рекомендуем</span>':'')+'</dt><dd>'+e(item.text)+'</dd></div>').join('')+'</dl>':'')+
    '<button type="button" class="help-confirm">Понятно</button>';
  document.body.append(dialog);dialog.showModal();
  dialog.querySelector('button').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const bounds=dialog.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
  });
  dialog.addEventListener('close',()=>{
    dialog.remove();
    if(trigger?.isConnected)trigger.focus({preventScroll:true});
  },{once:true});
}
function demoDialogContent(){
  return '<div class="demo-dialog-heading"><h2 id="demo-title">Видеопример Reel Lab</h2><button type="button" class="icon-btn" data-demo-close aria-label="Закрыть видеопример">×</button></div>'+
    '<p id="demo-description">24 секунды: титры Cinema, движение, цвет и карточки. Постановочный пример на ИИ-фото, без живой речи. Оформление здесь фиксированное — настройки твоего ролика не меняются.</p>'+
    '<video class="demo-player" controls playsinline preload="metadata" poster="/assets/studio-demo-poster-v1.jpg" src="/assets/studio-demo-v1.mp4" aria-label="Демонстрация оформления Reel Lab"></video>'+
    '<p class="demo-playback-status" role="status" aria-live="polite"></p>'+
    '<div class="demo-dialog-actions"><button type="button" class="primary" data-demo-close>Понятно</button><a href="/assets/studio-demo-v1.mp4" download="reel-lab-demo.mp4">Скачать пример</a></div>';
}
function showDemo(){
  const existing=document.querySelector('#demo-dialog');
  if(existing){existing.focus();return;}
  const trigger=document.activeElement;
  const dialog=document.createElement('dialog');dialog.id='demo-dialog';dialog.className='help-dialog demo-dialog';
  dialog.setAttribute('aria-labelledby','demo-title');dialog.setAttribute('aria-describedby','demo-description');
  dialog.innerHTML=demoDialogContent();document.body.append(dialog);
  const video=dialog.querySelector('video'),status=dialog.querySelector('[role="status"]');
  const fallback=()=>{if(dialog.isConnected)status.textContent='Нажми ▶ в плеере, чтобы запустить пример.';};
  video.addEventListener('playing',()=>{status.textContent='';});
  video.addEventListener('error',()=>{status.textContent='Не удалось загрузить видео. Закрой и открой пример ещё раз или скачай его по ссылке ниже.';});
  dialog.querySelectorAll('[data-demo-close]').forEach(button=>button.onclick=()=>dialog.close());
  dialog.addEventListener('close',()=>{
    video.pause();video.removeAttribute('src');video.load();dialog.remove();
    if(trigger?.isConnected)trigger.focus({preventScroll:true});
  },{once:true});
  dialog.showModal();
  // User-initiated only; no audio or media download merely from opening Studio.
  try{const playback=video.play();if(playback?.catch)playback.catch(fallback);}catch{fallback();}
}
function wireStudio(){
  wireDownloads();
  const fontRetry=document.querySelector('[data-font-retry]');if(fontRetry)fontRetry.onclick=()=>{if(captionFontsRetryable())mountCaptionPreview();};
  const smartCut=document.querySelector('[data-smart-cut]');if(smartCut)smartCut.onclick=()=>{draft.smart_cut=!draft.smart_cut;save();render();};
  const demo=document.querySelector('#show-demo');if(demo)demo.onclick=showDemo;
  document.querySelectorAll('[data-help]').forEach(b=>b.onclick=()=>showHelp(b.dataset.help));
  document.querySelectorAll('[data-font]').forEach(b=>b.onclick=()=>{if(draft.font===b.dataset.font)return;draft.font=b.dataset.font;save();refreshMontageAppearance();});
  document.querySelectorAll('[data-cycle]').forEach(b=>b.onclick=()=>{
    const key=b.dataset.cycle,values=b.dataset.values.split(',');
    draft[key]=values[(values.indexOf(draft[key])+1)%values.length];
    save();render();
  });
  document.querySelectorAll('[data-style-cycle]').forEach(b=>b.onclick=()=>{previewStyle=(previewStyle+Number(b.dataset.styleCycle)+caps.styles.length)%caps.styles.length;render();});
  document.querySelectorAll('[data-style-index]').forEach(b=>b.onclick=()=>{previewStyle=Number(b.dataset.styleIndex);render();});
  document.querySelectorAll('[data-clip-filter]').forEach(b=>b.onclick=()=>{clipFilter=b.dataset.clipFilter;render();});
  document.querySelectorAll('[data-deliver]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try{await api('/api/jobs/'+b.dataset.deliver+'/deliver',{method:'POST'});toast('Отправка поставлена в очередь. Бот пришлёт ролик в личный чат.');}
    catch(err){toast(err.message);}finally{b.disabled=false;}
  });
}
function showSaveStatus(){const label=document.querySelector('#save-status');if(label)label.textContent=saveCount||saveTimer?'Сохраняем…':saveFailed?'Ошибка сохранения':'Настройки сохранены';}
function save(){clearTimeout(saveTimer);saveTimer=null;saveCount++;draft=processingSettings(draft);const snapshot=structuredClone(draft);showSaveStatus();saveChain=saveChain.catch(()=>{}).then(()=>api('/api/draft',{method:'POST',data:snapshot})).then(()=>{saveFailed=false;}).catch(err=>{saveFailed=true;toast(err.message);}).finally(()=>{saveCount--;showSaveStatus();});}
function flushSave(){if(saveTimer)save();}
function navigate(next){flushSave();page=next;detailId=null;history.replaceState(null,'',`#${page}`);render();window.scrollTo({top:0});}
function wire(){
  wireStudio();
  mountDurationMode();
  document.querySelector('#theme').onclick=()=>{document.body.classList.toggle('light');syncTelegramHeader();localStorage.setItem('reel-theme',document.body.classList.contains('light')?'light':'dark');};
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
  document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{page='clips';detailId=b.dataset.job;render();});
  document.querySelectorAll('[data-option]').forEach(input=>{
    const update=()=>{draft[input.dataset.option]=input.type==='checkbox'?input.checked:input.value;};
    input.addEventListener('change',()=>{update();save();if(input.tagName!=='TEXTAREA')render();});
    if(input.tagName==='TEXTAREA')input.addEventListener('input',()=>{update();clearTimeout(saveTimer);saveTimer=setTimeout(save,400);showSaveStatus();});
  });
  document.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{draft.color=b.dataset.color;save();render();});
  wireUpload();
  const run=document.querySelector('#run');if(run)run.onclick=createJob;
  const clear=document.querySelector('#clear-file');if(clear)clear.onclick=clearUploadSelection;
  const cancel=document.querySelector('#cancel-job');if(cancel)cancel.onclick=async()=>{cancel.disabled=true;try{await api(`/api/jobs/${detailId}/cancel`,{method:'POST'});await refresh(true);}catch(err){toast(err.message);cancel.disabled=false;}};
  const retry=document.querySelector('#retry-job');if(retry){retry.disabled=!processingAvailable();retry.onclick=async()=>{if(!processingAvailable())return;retry.disabled=true;try{const j=await api(`/api/jobs/${detailId}/retry`,{method:'POST',data:{request_id:crypto.randomUUID()}});detailId=j.id;await refresh(true);}catch(err){toast(err.message);retry.disabled=!processingAvailable();}};}
  const pair=document.querySelector('#pair');if(pair)pair.onclick=async()=>{pair.disabled=true;try{const code=await api('/api/telegram/pair',{method:'POST'});const target=document.querySelector('#pair-result');target.replaceChildren();const p=document.createElement('p');p.textContent='Перейди к нашему боту и нажми «Начать». Telegram подключится автоматически, вводить команду не нужно. Ссылка действует 10 минут — не передавай её другим людям.';target.append(p);if(code.url){const link=document.createElement('a');link.href=code.url;link.target='_blank';link.rel='noopener noreferrer';link.className='connect-link';link.textContent='Открыть бота и подключить';target.append(link);}else{const pre=document.createElement('code');pre.className='pair-code';pre.textContent=code.command;target.append(pre);}}catch(err){toast(err.message);}finally{pair.disabled=false;}};
  const unlink=document.querySelector('#unlink');if(unlink)unlink.onclick=async()=>{try{await api('/api/telegram/unlink',{method:'POST'});linked=null;render();toast('Доступ Telegram отключён. Ролики сохранены.');}catch(err){toast(err.message);}};
}
function uploadStatus(){
  if(batch.length)return batchStatus();
  if(busy)return '<div class="file-info"><strong>'+e(selectedFile?.name||resumeTransfer?.name||upload?.name)+'</strong><p id="progress-text">'+e(uploadPhase)+'</p><progress id="progress" max="100" value="'+uploadPercent+'"></progress></div>';
  if(resumeTransfer&&resumeTransfer.status!=='ready')return '<div class="file-info">'+pendingUploadStatus(resumeTransfer)+(uploadError?'<p role="alert">'+e(uploadError)+'</p>':'')+((selectedFile||transferCanFinish(resumeTransfer))?'<button id="retry-upload">Повторить загрузку</button>':'')+'<button id="clear-file">Убрать из выбора</button></div>';
  if(uploadError)return '<div class="notice" role="alert">'+e(uploadError)+(selectedFile?'<br><button id="retry-upload">Повторить загрузку</button>':'')+(resumeTransfer?'<button id="clear-file">Убрать из выбора</button>':'')+'</div>';
  return upload?'<div class="file-info"><strong>✓ '+e(upload.name)+'</strong><p>Загружено · '+upload.media.duration_seconds.toFixed(1)+' с · '+mb(upload.media.size_bytes)+'</p><button id="clear-file">Убрать из выбора</button></div>':'';
}
function wireUpload(){
  const file=document.querySelector('#file'),choose=document.querySelector('#choose-file');
  if(!file||!choose)return;
  choose.onclick=()=>{
    if(!uploadAvailable()||busy)return;
    // Keep native picker activation synchronous with the trusted user gesture.
    // No render, fetch or await before it: replacing the input loses WebKit's picker.
    file.value='';
    try{if(typeof file.showPicker==='function')file.showPicker();else file.click();}
    catch{file.click();}
    document.querySelector('#picker-status').textContent='Выбери видео в системном окне. Если его нет — раскрой подсказку ниже.';
    const fallback=document.querySelector('.picker-help');if(fallback)fallback.hidden=false;
  };
  for(const input of [file,document.querySelector('#file-fallback')]){
    input.onchange=()=>{if(input.files.length)sendFiles(Array.from(input.files));};
    input.addEventListener('cancel',()=>{document.querySelector('#picker-status').textContent='Выбор отменён. Можно выбрать видео ещё раз.';});
  }
  const zone=document.querySelector('#upload-zone');
  zone.ondragover=ev=>{ev.preventDefault();if(!busy&&uploadAvailable())zone.classList.add('is-dragover');};
  zone.ondragleave=ev=>{if(!zone.contains(ev.relatedTarget))zone.classList.remove('is-dragover');};
  zone.ondrop=ev=>{ev.preventDefault();zone.classList.remove('is-dragover');sendFiles(Array.from(ev.dataTransfer.files));};
  const retryBatch=document.querySelector('#retry-batch');if(retryBatch)retryBatch.onclick=()=>uploadBatch();
  const clearBatch=document.querySelector('#clear-batch');if(clearBatch)clearBatch.onclick=clearUploadSelection;
  const retry=document.querySelector('#retry-upload');if(retry)retry.onclick=()=>selectedFile?sendUpload(selectedFile):finishRestoredUploads();
}
function setUploadProgress(percent,phase){
  uploadPercent=percent;uploadPhase=phase;
  const p=document.querySelector('#progress');if(p)p.value=percent;
  const t=document.querySelector('#progress-text');if(t)t.textContent=phase;
}
async function prepareUploadSession(){
  const session=await api('/api/upload-session');acceptSession(session);
  if(!session.limits||!Number.isFinite(session.limits.max_bytes)||session.limits.max_bytes<=0||
      !Number.isFinite(session.limits.max_seconds)||session.limits.max_seconds<=0)
    throw new Error('Не удалось получить лимиты загрузки. Повтори запрос.');
  caps.limits={...caps.limits,...session.limits};
}
function resumableUploads(){return caps?.resumable_upload===true;}
function releaseUploadPreview(){if(blob?.startsWith('blob:'))URL.revokeObjectURL(blob);blob=null;}
function transferPercent(state){return Math.floor(state.offset/state.size_bytes*100);}
function transferCanFinish(state){return state?.status==='receiving'&&state.offset===state.size_bytes;}
function pendingUploadStatus(state,showName=true){
  const name=showName?'<strong>'+e(state.name)+'</strong>':'';
  if(state.status==='rejected')return name+'<p role="alert">'+e(state.error||'Видео не прошло проверку. Выберите другой исходник.')+'</p>';
  const percent=transferPercent(state);
  return name+'<p>На сервере сохранено '+percent+'% · '+mb(state.offset)+' из '+mb(state.size_bytes)+'</p><progress max="100" value="'+percent+'"></progress><p>'+(transferCanFinish(state)?'Видео отправлено. Осталось проверить файл.':'Выберите это же видео, чтобы продолжить с сохранённого места.')+'</p>';
}
function checkedTransfer(state,{file,fingerprint}={}){
  if(!state||!/^[a-f0-9]{32}$/.test(state.id)||!['receiving','ready','rejected'].includes(state.status)||
      !Number.isSafeInteger(state.size_bytes)||state.size_bytes<=0||!Number.isSafeInteger(state.offset)||state.offset<0||state.offset>state.size_bytes||
      !Number.isSafeInteger(state.chunk_bytes)||state.chunk_bytes<=0||state.chunk_bytes>4194304||
      !(/^[a-f0-9]{64}$/.test(state.fingerprint)||(state.status==='ready'&&state.fingerprint==='legacy:'+state.id))||
      typeof state.name!=='string'||(state.status==='ready'&&(!state.upload||!/^[a-f0-9]{32}$/.test(state.upload.id))))
    throw new Error('Не удалось восстановить загрузку. Повторите запрос.');
  if(file&&(state.size_bytes!==file.size||state.fingerprint!==fingerprint))
    throw new Error('Выбран другой файл. Сохранённые части не будут смешаны с новым видео.');
  return state;
}
async function uploadDigest(bytes){
  if(!globalThis.crypto?.subtle)throw new Error('Этот клиент не поддерживает безопасное продолжение загрузки. Обновите Telegram.');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}
async function uploadFingerprint(file){
  // Picker timestamps and exported filenames can change on iPhone. Identify
  // byte-compatible selections using only bounded samples, never a full copy.
  const sample=65536;
  const [first,last]=await Promise.all([file.slice(0,Math.min(sample,file.size)).arrayBuffer(),
    file.slice(Math.max(0,file.size-sample),file.size).arrayBuffer()]);
  const size=new TextEncoder().encode(String(file.size)),bytes=new Uint8Array(first.byteLength+last.byteLength+size.length);
  bytes.set(new Uint8Array(first));bytes.set(new Uint8Array(last),first.byteLength);bytes.set(size,first.byteLength+last.byteLength);
  return uploadDigest(bytes);
}
async function verifyUploadPrefix(file,state){
  // The sampled fingerprint finds a candidate only. Exact committed receipts
  // prove that a newly selected File has the same saved prefix before append.
  if(!state.offset)return;
  if(!Array.isArray(state.chunks)||!state.chunks.length||state.chunks.length>512)
    throw new Error('Не удалось сверить сохранённые части. Повторите запрос.');
  setUploadProgress(transferPercent(state),'Проверяем сохранённые части…');
  let offset=0;
  for(const receipt of state.chunks){
    if(!receipt||!Number.isSafeInteger(receipt.offset)||receipt.offset!==offset||
        !Number.isSafeInteger(receipt.size_bytes)||receipt.size_bytes!==Math.min(state.chunk_bytes,file.size-offset)||
        receipt.size_bytes<=0||offset+receipt.size_bytes>state.offset||!/^[a-f0-9]{64}$/.test(receipt.sha256))
      throw new Error('Не удалось сверить сохранённые части. Повторите запрос.');
    const bytes=await file.slice(offset,offset+receipt.size_bytes).arrayBuffer();
    if(await uploadDigest(bytes)!==receipt.sha256)
      throw new Error('Выбрано другое видео: сохранённые части не совпадают. Уберите видео из выбора, затем выберите новый файл.');
    offset+=receipt.size_bytes;
  }
  if(offset!==state.offset)throw new Error('Не удалось сверить сохранённые части. Повторите запрос.');
}
function uploadChunkRequest(state,part,digest){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('POST',`/api/upload-transfers/${state.id}/chunk?offset=${state.offset}`);
  xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',csrf);
  xhr.setRequestHeader('X-Upload-Chunk-SHA256',digest);xhr.timeout=180000;
  // Transport progress can advance within a chunk; the transfer's durable
  // offset changes only after the server ACK and remains the resume position.
  const sentPercent=loaded=>Math.min(99,Math.floor((state.offset+Math.min(part.size,Math.max(0,loaded)))/state.size_bytes*100));
  xhr.upload.onprogress=event=>{
    if(event.lengthComputable&&Number.isFinite(event.loaded)&&event.loaded>=0&&event.total>0){
      const percent=sentPercent(event.loaded);setUploadProgress(percent,`Загрузка ${percent}%`);
    }
  };
  xhr.upload.onload=()=>setUploadProgress(sentPercent(part.size),'Часть отправлена. Сохраняем на сервере…');
  xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{reject(responseError({},xhr.status));return;}
    if(xhr.status!==200)reject(responseError(result,xhr.status));else resolve(result);};
  xhr.onerror=xhr.ontimeout=xhr.onabort=()=>{setUploadProgress(transferPercent(state),'Загрузка прервана. Сохранённые части остаются на сервере.');reject(new Error('Загрузка прервана. Сохранённые части остаются на сервере. Повторите загрузку или выберите это же видео после открытия студии.'));};
  xhr.send(part);
});}
async function finishUploadTransfer(state,onState){
  setUploadProgress(100,'Видео отправлено. Проверяем файл…');
  state=checkedTransfer(await api(`/api/upload-transfers/${state.id}/finish`,{method:'POST',data:{}}));onState(state);
  if(state.status!=='ready')throw new Error(state.error||'Видео не прошло проверку.');
  return state.upload;
}
async function uploadResumable(file,{replace=true,onState=()=>{},fingerprint}={}){
  fingerprint=fingerprint||await uploadFingerprint(file);
  let state=checkedTransfer(await api('/api/upload-transfers',{method:'POST',
    data:{name:file.name,size_bytes:file.size,fingerprint,replace}}),{file,fingerprint});onState(state);
  setUploadProgress(transferPercent(state),`Загрузка ${transferPercent(state)}%`);
  // Reconcile after a lost acknowledgement instead of guessing/replaying bytes.
  state=checkedTransfer(await api(`/api/upload-transfers/${state.id}`),{file,fingerprint});onState(state);
  await verifyUploadPrefix(file,state);
  let recovered=false;
  while(state.status==='receiving'&&state.offset<state.size_bytes){
    setUploadProgress(transferPercent(state),`Загрузка ${transferPercent(state)}%`);
    const offset=state.offset,part=file.slice(offset,Math.min(file.size,offset+state.chunk_bytes));
    const digest=await uploadDigest(await part.arrayBuffer());
    try{
      const next=checkedTransfer(await uploadChunkRequest(state,part,digest),{file,fingerprint});
      if(next.offset!==offset+part.size)throw new Error('Сервер подтвердил другой размер части. Повторите загрузку.');
      state=next;onState(state);
    }catch(err){
      if(recovered||!['session_expired','csrf_stale'].includes(err.code))throw err;
      recovered=true;await recoverSession();await prepareUploadSession();validateFile(file);
      state=checkedTransfer(await api(`/api/upload-transfers/${state.id}`),{file,fingerprint});onState(state);
      await verifyUploadPrefix(file,state);
    }
  }
  if(state.status==='ready')return state.upload;
  if(state.status==='rejected')throw new Error(state.error||'Видео не прошло проверку.');
  return finishUploadTransfer(state,onState);
}
function restoreUploadSelection(selection){
  if(!resumableUploads()||!Array.isArray(selection))return;
  releaseUploadPreview();selectedFile=null;upload=null;uploadError='';resumeTransfer=null;batch=[];
  const states=selection.map(state=>checkedTransfer(state));
  if(states.length===1){
    resumeTransfer=states[0];upload=resumeTransfer.status==='ready'?resumeTransfer.upload:null;
    if(upload)blob=`/api/uploads/${upload.id}/source`;
  }else if(states.length>1){
    batch=states.map(state=>({file:null,name:state.name,transfer:state,
      upload:state.status==='ready'?state.upload:null,job:null,error:state.error||'',status:'',request_id:crypto.randomUUID()}));
  }
}
async function finishRestoredUploads(){
  if(!resumableUploads()||busy||creatingJob)return;
  const items=batch.length?batch.filter(item=>transferCanFinish(item.transfer)):
    transferCanFinish(resumeTransfer)?[{transfer:resumeTransfer}]:[];
  if(!items.length)return;
  busy=true;
  try{
    await prepareUploadSession();
    for(const item of items){
      item.uploading=true;setUploadProgress(100,'Видео отправлено. Проверяем файл…');render();
      const update=state=>{item.transfer=state;if(!batch.length)resumeTransfer=state;};
      try{
        const state=checkedTransfer(await api(`/api/upload-transfers/${item.transfer.id}`));update(state);
        if(state.status==='rejected')throw new Error(state.error||'Видео не прошло проверку.');
        item.upload=state.status==='ready'?state.upload:await finishUploadTransfer(state,update);
        item.error='';if(!batch.length){upload=item.upload;uploadError='';releaseUploadPreview();blob=`/api/uploads/${upload.id}/source`;}
      }catch(err){item.error=err.message;if(!batch.length)uploadError=err.message;}
      finally{item.uploading=false;}
    }
  }catch(err){uploadError=err.message;toast(err.message);}
  finally{busy=false;render();}
}
async function clearUploadSelection(){
  if(busy||creatingJob)return;
  if(resumableUploads()){
    busy=true;setUploadProgress(0,'Убираем видео из выбора…');render();
    try{await api('/api/upload-selection/clear',{method:'POST',data:{}});}
    catch(err){toast(err.message);busy=false;render();return;}
    busy=false;
  }
  upload=null;resumeTransfer=null;batch=[];selectedFile=null;uploadError='';jobRequest=null;releaseUploadPreview();render();
}
function uploadRequest(file){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/uploads?name='+encodeURIComponent(file.name));
  xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Token',csrf);xhr.timeout=vpsPipeline()?1800000:600000;
  xhr.upload.onprogress=ev=>{if(ev.lengthComputable&&ev.total>0){
    const percent=Math.min(99,Math.round(ev.loaded/ev.total*100));
    setUploadProgress(percent,`Загрузка ${percent}%`);
  }};
  xhr.upload.onload=()=>setUploadProgress(100,'Видео отправлено. Проверяем файл…');
  xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{reject(responseError({},xhr.status));return;}
    if(xhr.status!==201)reject(responseError(result,xhr.status));else resolve(result);};
  xhr.onerror=xhr.ontimeout=()=>reject(new Error('Загрузка прервана. Проверь соединение и нажми «Повторить загрузку».'));
  xhr.send(file);
});}
async function sendAuthenticatedUpload(file,options={}){
  validateFile(file);setUploadProgress(resumableUploads()&&options.initialState?transferPercent(options.initialState):0,'Загружаем на сервер монтажа…');
  if(resumableUploads())return uploadResumable(file,options);
  try{return await uploadRequest(file);}catch(err){
    if(!['session_expired','csrf_stale'].includes(err.code))throw err;
    // Only explicit pre-body authentication failures may resend this source.
    await recoverSession();await prepareUploadSession();validateFile(file);
    setUploadProgress(0,'Загружаем на сервер монтажа…');return uploadRequest(file);
  }
}
async function sendUpload(file){
  if(!uploadAvailable()||busy||!file)return;
  if(!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)||!file.size){toast('Выбери непустое видео MP4, MOV, M4V, WebM, MKV или AVI.');return;}
  selectedFile=file;upload=null;uploadError='';uploadPercent=resumableUploads()&&resumeTransfer?transferPercent(resumeTransfer):0;uploadPhase='Проверяем подключение…';busy=true;render();
  try{
    // Recover authentication BEFORE sending a potentially large video body.
    await prepareUploadSession();
    const result=await sendAuthenticatedUpload(file,{initialState:resumeTransfer,onState:state=>{resumeTransfer=state;}});
    upload=result;releaseUploadPreview();blob=URL.createObjectURL(file);selectedFile=null;
    toast(processingAvailable()?'Исходник загружен. Можно запускать монтаж.':'Исходник загружен. Монтаж временно недоступен.');
  }catch(err){uploadError=err.message;toast(err.message);}
  finally{busy=false;render();document.querySelector('#upload-status')?.scrollIntoView({block:'center',behavior:'smooth'});}
}
function batchStatus(){
  return '<div class="file-info"><strong>Выбрано видео: '+batch.length+'</strong><p>Одинаковые настройки применяются к каждому видео. После запуска можно закрыть студию — очередь хранится на сервере.</p><ol>'+batch.map(item=>'<li><strong>'+e(item.name||item.file?.name||item.transfer?.name)+'</strong> · '+e(item.job?'В очереди':item.error||(item.upload?'Загружено':item.status||'Ожидает загрузки'))+(item.uploading?'<p id="progress-text">'+e(uploadPhase)+'</p><progress id="progress" max="100" value="'+uploadPercent+'"></progress>':item.transfer&&!item.upload?pendingUploadStatus(item.transfer,false):'')+(item.error?'<p role="alert">'+e(item.error)+'</p>':'')+'</li>').join('')+'</ol>'+(!busy&&!creatingJob?'<button id="clear-batch">Убрать из выбора</button>':'')+(!busy&&batch.some(x=>!x.upload&&(x.file||transferCanFinish(x.transfer)))?'<button id="retry-batch">Повторить незавершённые загрузки</button>':'')+'</div>';
}
function queueSummary(){
  if(!queue)return '';
  return '<p class="upload-limit" role="status" data-queue-status>'+e(queueText())+'</p>';
}
function queueText(){return 'В работе: '+queue.running+' · в очереди: '+queue.queued+' · одновременно до '+queue.concurrency+' видео';}
function validateFile(file,{checkSize=true}={}){
  if(!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)||!file.size)throw new Error('Выбери непустые видео MP4, MOV, M4V, WebM, MKV или AVI.');
  if(checkSize&&file.size>caps.limits.max_bytes)throw new Error(file.name+': файл больше '+Math.floor(caps.limits.max_bytes/1024/1024)+' МиБ.');
}
async function sendFiles(files){
  if(!uploadAvailable()||busy||creatingJob||!files.length)return;
  if(resumableUploads()&&batch.some(item=>item.transfer&&!item.upload&&!item.file))return attachRestoredFiles(files);
  if(files.length===1){batch=[];return sendUpload(files[0]);}
  const maximum=operator?caps.limits.queue_size:(caps.limits.user_active||1);
  if(files.length>maximum){toast('Можно выбрать до '+maximum+' видео за один раз.');return;}
  // Format checks are immediate; byte limits are refreshed before each send.
  try{files.forEach(file=>validateFile(file,{checkSize:false}));}catch(err){toast(err.message);return;}
  releaseUploadPreview();upload=null;resumeTransfer=null;selectedFile=null;uploadError='';
  batch=files.map((file,index)=>({file,upload:null,job:null,error:'',status:'Ожидает загрузки',replaceSelection:index===0,request_id:crypto.randomUUID()}));
  return uploadBatch();
}
async function attachRestoredFiles(files){
  let matches;
  busy=true;setUploadProgress(0,'Проверяем подключение…');render();
  try{
    await prepareUploadSession();files.forEach(file=>validateFile(file));
    const used=new Set();matches=[];
    for(const file of files){
      const fingerprint=await uploadFingerprint(file);
      const item=batch.find(value=>!used.has(value)&&value.transfer&&value.transfer.status==='receiving'&&
        value.transfer.size_bytes===file.size&&value.transfer.fingerprint===fingerprint&&
        value.transfer.name.split('.').pop().toLowerCase()===file.name.split('.').pop().toLowerCase());
      if(!item){matches=null;break;}
      used.add(item);matches.push({item,file,fingerprint});
    }
  }catch(err){toast(err.message);return;}
  finally{busy=false;render();}
  if(matches){
    for(const {item,file,fingerprint} of matches){item.file=file;item.fingerprint=fingerprint;item.replaceSelection=false;item.error='';}
    return uploadBatch();
  }
  // Selecting different bytes explicitly replaces the selection; never append
  // them to an unrelated partial transfer or silently drop a matched batch item.
  batch=[];resumeTransfer=null;return sendFiles(files);
}
async function uploadBatch(){
  if(!uploadAvailable()||busy||creatingJob)return;
  busy=true;render();
  try{
    await prepareUploadSession();
    for(const item of batch){
      if(item.upload)continue;
      if(!item.file&&!transferCanFinish(item.transfer))continue;
      item.status='Загружаем…';item.error='';item.uploading=true;
      uploadPercent=resumableUploads()&&item.transfer?transferPercent(item.transfer):0;uploadPhase='Загружаем на сервер монтажа…';render();
      try{
        const update=state=>{item.transfer=state;};
        item.upload=item.file?await sendAuthenticatedUpload(item.file,{replace:item.replaceSelection===true,
          fingerprint:item.fingerprint,initialState:item.transfer,onState:update}):await finishUploadTransfer(item.transfer,update);
        item.replaceSelection=false;
        item.status='Загружено';
      }catch(err){item.error=err.message;item.status='Ошибка загрузки';}
      finally{item.uploading=false;render();}
    }
  }catch(err){toast(err.message);}finally{busy=false;render();}
}
async function createBatch(){
  if(!processingAvailable()||busy||creatingJob||!batch.some(item=>item.upload&&!item.job))return;
  creatingJob=true;flushSave();if(saveFailed)save();render();
  try{
    await saveChain;if(saveFailed)throw new Error('Настройки не сохранены. Повтори запуск после восстановления связи.');
    const settings=processingSettings(draft);
    for(const item of batch){
      if(!item.upload||item.job)continue;
      // Persist payload/key across ambiguous response failures; successful jobs
      // are never submitted again by a retry of the remaining batch.
      item.payload??={upload_id:item.upload.id,settings,request_id:item.request_id};
      item.error='';
      try{item.job=await api('/api/jobs',{method:'POST',data:item.payload});}
      catch(err){item.error=err.message;}
    }
    await refresh();
    if(batch.every(item=>item.job)){batch=[];page='clips';detailId=null;render();toast('Видео приняты в очередь. Можно закрыть студию.');}
    else toast('Часть видео не принята. Причины показаны возле каждого файла; повторный запуск продолжит только оставшиеся.');
  }catch(err){toast(err.message);}finally{creatingJob=false;render();}
}
async function createJob(){
  if(!processingAvailable())return;
  if(batch.length)return createBatch();
  if(!upload||busy||creatingJob)return;
  creatingJob=true;flushSave();if(saveFailed)save();
  const b=document.querySelector('#run');if(b)b.disabled=true;
  const payload={upload_id:upload.id,settings:processingSettings(draft)},key=JSON.stringify(payload);
  // Keep the same idempotency key after a lost response: a retry must not create
  // a second render if the server already accepted the first request.
  if(jobRequest?.key!==key)jobRequest={key,data:{...payload,request_id:crypto.randomUUID()}};
  try{
    await saveChain;if(saveFailed)throw new Error('Не удалось сохранить настройки. Проверь соединение и повтори запуск.');
    const j=await api('/api/jobs',{method:'POST',data:jobRequest.data});detailId=j.id;page='clips';await refresh(true);
    jobRequest=null;
  }catch(err){toast(err.message);}
  finally{creatingJob=false;const button=document.querySelector('#run');if(button)button.disabled=!processingAvailable()||!upload||busy;}
}
async function refresh(force=false){
  const data=await api('/api/jobs');
  const before=jobViewSnapshot(jobs);
  jobs=data.jobs;queue=data.queue||queue;
  updateJobProgressText();
  if(queue)document.querySelectorAll('[data-queue-status]').forEach(node=>{node.textContent=queueText();});
  if(page==='profile')updateProfileCount();
  if(page==='balance')usage=await api('/api/usage');
  const after=jobViewSnapshot(jobs);
  if(force||((page==='clips'||page==='balance')&&before!==after)){
    const player=detailId&&document.querySelector('.player'),completed=jobs.find(j=>j.id===detailId);
    if(player&&completed?.status==='completed'&&!force){updateCompletedPlayer(completed,player);return;}
    render();
  }
}
async function start(){
  if(starting)return;
  starting=true;telegramReady();void waitTelegramSDK();
  try{
    let data;
    try{data=await requestJSON('/api/bootstrap');}
    catch(err){
      if(err.code!=='session_expired')throw err;
      const session=await api('/api/session',{method:'POST',data:{init_data:await currentTelegramInit()}});
      acceptSession(session);data=await api('/api/bootstrap');
    }
    acceptSession(data);
    caps=data.capabilities;draft=processingSettings(data.draft);jobs=data.jobs;queue=data.queue||null;
    linked=data.telegram;operator=data.admin;usage=data.usage;
    restoreUploadSelection(data.upload_selection);
    page=['montage','clips','balance','referrals','profile','support'].includes(location.hash.slice(1))?location.hash.slice(1):'montage';
    try{document.body.classList.toggle('light',localStorage.getItem('reel-theme')==='light');}catch{}
    render();telegramReady();setupTelegramWindow();
    void finishRestoredUploads();
    clearInterval(poll);poll=setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},2500);setupJobProgressResume();
  }catch(err){
    app.innerHTML=`<main class="loading"><h1>Студия недоступна</h1><p>${e(err.message)}</p><button id="reload">Повторить</button></main>`;
    document.querySelector('#reload').onclick=start;
  }finally{starting=false;telegramReady();}
}
function mountDurationMode(){
  phases.PLANNING_SHORTFORM='Отбираем историю до 60 секунд';
  phases.PLANNING_EMOJI='Подбираем эмодзи по смыслу';
  const pause=document.querySelector('[data-option="cut_pauses"]');
  if(supportsShortform()&&pause&&!document.querySelector('[data-option="duration_mode"]')){
    const block=document.createElement('div');
    block.innerHTML=durationControl()+'<p class="preview-description">До минуты: локальная Qwen выбирает целые фразы и убирает второстепенные темы. Исходный порядок сохраняется. Проверь смысл перед публикацией. Если план не проходит проверку, длинный ролик не будет выдан вместо короткого.</p>';
    pause.closest('label').before(block);
    pause.closest('label').querySelector('small').textContent='Дополнительно сокращать тишину между сохранёнными фразами';
  }
  const job=jobs.find(j=>j.id===detailId);
  if(job){
    const settings=document.querySelector('.detail > div:last-child > section.card');
    const row=document.createElement('div');row.className='kv';
    row.innerHTML=`<span>Длительность</span><b>${job.settings.duration_mode==='short60'?'До 60 секунд':'Без лимита'}</b>`;
    settings?.append(row);
    const report=job.result?.shortform;
    const assets=job.result?.additions;
    if(assets){
      const card=document.createElement('section');card.className='card';card.id='creative-report';
      card.innerHTML='<h3>Графика этого ролика</h3><p>Добавлено слоёв: '+e(assets.overlay_count||0)+'</p>'+
        (assets.title?'<p>Заголовок: '+e(assets.title)+'</p>':'')+
        (assets.media_model?'<p>Иллюстрации сгенерированы локально. На карточках есть отметка ИИ.</p>':'')+
        ((assets.skipped||[]).length?'<ul>'+assets.skipped.map(x=>'<li>'+e(x)+'</li>').join('')+'</ul>':'');
      settings?.after(card);
    }
    if(report){
      const reportText=report.status==='planned'?`ИИ выбрал ${report.kept_sentences.length} групп фраз в исходном порядке. Итоговая длительность: ${job.result.duration.toFixed(1)} с.`:report.reason;
      const card=document.createElement('section');card.className='card';card.id='shortform-report';
      card.innerHTML=`<h3>Как собран минутный ролик</h3><p>${e(reportText)}</p>${report.kept_sentences?`<details><summary>Что осталось (${report.kept_sentences.length} групп)</summary>${report.kept_sentences.map(s=>`<p>${s.start.toFixed(1)}–${s.end.toFixed(1)} с: ${e(s.text)}</p>`).join('')}</details><details><summary>Что убрал ИИ (${report.removed_sentences.length} групп)</summary>${report.removed_sentences.map(s=>`<p>${s.start.toFixed(1)}–${s.end.toFixed(1)} с: ${e(s.text)}</p>`).join('')}</details>`:''}<small>Таймкоды исходника. Текст — из распознавания; ИИ не оценивает интонацию и изображение.</small>`;
      settings?.after(card);
    }
  }
  // VPS support() already renders its own FAQ. This legacy post-render update
  // needs a DOM node; FAQ data must never be treated as a queryable element.
  if(vpsPipeline())return;
  const faq=[...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Почему автоматическая нарезка убирает мало?');
  const answer=faq?.querySelector('p');
  if(answer)answer.textContent=supportsShortform()?'«Без лимита» сокращает только паузы и выбранные вручную фразы. «До 60 секунд» автоматически отбирает целые предложения по смыслу. Готовый MP4 проверяется на длительность; при неудачном плане задача завершается ошибкой, а исходник сохраняется.':'Сохраняется вся речь в исходном порядке. Сокращаются только безопасные тихие паузы, если эта настройка включена. Отдельные фразы можно убрать вручную в редакторе готового ролика.';
}
start();
