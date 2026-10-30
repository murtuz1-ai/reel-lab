'use strict';
function invitationView(){
  return `<h1>Приглашай друзей</h1><p class="lede">Монтаж бесплатный. У каждого участника отдельная библиотека — свои исходники, настройки и результаты.</p>${operator?`<section class="card"><h2>Личное приглашение</h2><p>Одно приглашение — один Telegram-аккаунт. Действует 48 часов. По умолчанию: 5 запусков за 24 часа, одна активная задача и 512 МиБ исходников на участника.</p><button class="primary" id="invite-create">Создать приглашение</button><div id="invite-result" role="status"></div></section><section class="card"><h2>Приглашения</h2><div id="invite-list">Загружаем…</div></section>`:`<section class="card"><h2>Закрытый тест сервиса</h2><p>Новые приглашения выдаёт владелец. Реферальных начислений и платежей сейчас нет. Не передавайте чужим людям свой доступ.</p></section>`}`;
}
function operationsPanel(adminOnly=false){
  if(adminOnly)return operator?'<section class="card"><h2>Управление сервисом</h2><p>Только локально на компьютере владельца. Отключение участника останавливает его задачи и запрещает дальнейший доступ.</p><div id="operator-panel">Загружаем…</div></section>':'';
  return '<section class="card"><h2>Написать в поддержку</h2><p>Обращение увидит владелец сервиса. Ответ появится здесь.</p><form id="support-form"><label class="field"><span>Описание проблемы</span><textarea name="text" required minlength="3" maxlength="2000" aria-label="Описание проблемы"></textarea></label><button type="submit" class="primary">Отправить обращение</button></form><div id="support-list"></div></section>';
}
function usagePanel(){
  if(!usage)return '';
  return `<section class="card"><h2>Мои лимиты</h2><div class="kv"><span>Запусков за 24 часа</span><b>${usage.jobs_24h} / ${usage.daily_limit??'без личного лимита'}</b></div><div class="kv"><span>Активных задач</span><b>${usage.active}</b></div><div class="kv"><span>Исходники на диске</span><b>${mb(usage.storage_bytes)} / ${mb(usage.storage_limit)}</b></div><p>Ошибочные запуски учитываются для защиты очереди; отменённые — нет. Платежей и списаний денег нет.</p></section>`;
}
async function mountOperations(){
  const target=document.querySelector('#operator-panel'), list=document.querySelector('#invite-list');
  if(operator&&(target||list)){
    try{
      const data=await api('/api/admin');
      if(target?.isConnected){
        target.innerHTML=`<div class="stats"><div class="stat"><b>${data.accounts.length}</b><span>участников</span></div><div class="stat"><b>${data.jobs.filter(j=>['queued','running','cancelling'].includes(j.status)).length}</b><span>активных задач</span></div><div class="stat"><b>${data.deliveries.length}</b><span>проблем доставки</span></div></div>${data.accounts.map(a=>`<form class="account-form" data-owner="${e(a.owner)}"><h3>Telegram ${a.user_id??e(a.owner)}</h3><p>${a.usage.jobs_24h} запусков за 24 ч · ${mb(a.usage.storage_bytes)} исходников</p><label class="toggle"><span>Доступ включён</span><input type="checkbox" name="enabled" ${a.enabled?'checked':''}></label><label class="field"><span>Запусков за 24 часа</span><input type="number" name="limit" min="1" max="20" value="${a.daily_limit}"></label><button>Сохранить лимиты</button></form>`).join('')||'<p>Участников пока нет. Создай приглашение во вкладке «Пригласить».</p>'}${data.deliveries.length?`<h3>Доставка</h3>${data.deliveries.map(d=>`<p>${e(d.owner)} · ${e(d.job_id.slice(0,8))} · ${e(d.error)} · попыток ${d.attempts}. Пользователь может запросить /get ${e(d.job_id)}.</p>`).join('')}`:''}${data.tickets.length?`<h3>Обращения участников</h3>${data.tickets.map(t=>`<form class="ticket-reply" data-id="${t.id}"><p><b>${e(t.owner)}</b> · ${date(t.created)}</p><p class="plain-text">${e(t.text)}</p><label class="field"><span>Ответ</span><textarea name="reply" maxlength="2000" required>${e(t.reply||'')}</textarea></label><button>Сохранить ответ</button><small>Участник увидит ответ в профиле или через /support.</small></form>`).join('')}`:''}`;
        target.querySelectorAll('.account-form').forEach(form=>form.onsubmit=async ev=>{ev.preventDefault();await action(form,()=>api('/api/admin/account',{method:'POST',data:{owner:form.dataset.owner,enabled:form.elements.enabled.checked,daily_limit:Number(form.elements.limit.value)}}));});
        target.querySelectorAll('.ticket-reply').forEach(form=>form.onsubmit=async ev=>{ev.preventDefault();await action(form,()=>api('/api/admin/reply',{method:'POST',data:{id:form.dataset.id,reply:form.elements.reply.value}}));});
      }
      if(list?.isConnected){
        list.innerHTML=data.invites.map(i=>`<div class="invite-row"><span>${date(i.created)} · ${i.used_by?'Принято':i.revoked?'Отозвано':i.expires<Date.now()/1000?'Истекло':'Действует'} ${i.used_by?e(i.used_by):''}</span>${!i.revoked&&!i.used_by&&i.expires>Date.now()/1000?`<button data-revoke="${i.id}">Отозвать</button>`:''}</div>`).join('')||'<p>Приглашений пока нет.</p>';
        list.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{try{await api('/api/admin/revoke',{method:'POST',data:{id:b.dataset.revoke}});mountOperations();}catch(err){toast(err.message);}});
      }
    }catch(err){if(target?.isConnected)target.textContent=err.message;if(list?.isConnected)list.textContent=err.message;}
  }
  const invite=document.querySelector('#invite-create');
  if(invite)invite.onclick=async()=>{invite.disabled=true;try{const data=await api('/api/admin/invite',{method:'POST'});const result=document.querySelector('#invite-result');if(result){result.innerHTML=`<p>Передай ссылку одному человеку. Она показывается только сейчас:</p><code class="pair-code">${e(data.url||data.command)}</code><p>Действует до ${date(data.expires)}. После открытия нужно нажать «Начать» в боте.</p>`;}mountOperations();}catch(err){toast(err.message);}finally{invite.disabled=false;}};
  const form=document.querySelector('#support-form');
  if(form){form.onsubmit=async ev=>{ev.preventDefault();await action(form,async()=>{await api('/api/support',{method:'POST',data:{text:form.elements.text.value}});form.reset();mountOperations();});};
    const support=document.querySelector('#support-list');
    try{const data=await api('/api/support');if(support?.isConnected)support.innerHTML=data.tickets.map(t=>`<details><summary>${date(t.created)} · ${t.reply?'Есть ответ':'Ожидает ответа'}</summary><p class="plain-text">${e(t.text)}</p><p class="plain-text">${e(t.reply||'Обращение сохранено для владельца сервиса.')}</p></details>`).join('');}catch(err){if(support?.isConnected)support.textContent=err.message;}
  }
}
async function action(form,fn){const button=form.querySelector('button');button.disabled=true;try{await fn();toast('Сохранено');}catch(err){toast(err.message);}finally{button.disabled=false;}}
