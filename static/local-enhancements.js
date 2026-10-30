/* Local controls layered onto the supplied Reel Lab interface.
   The server receives every value as part of the existing draft contract. */
(() => {
  const presets = {
    talking_head: {
      audio_preset: 'clear_speech', noise_reduction: 'medium', normalize_audio: true,
      video_enhancement: 'balanced', color_grade: 'natural', output_resolution: 'vertical_1080',
      video_quality: 'high', export_audio: true,
    },
    podcast: {
      audio_preset: 'podcast', noise_reduction: 'medium', normalize_audio: true,
      video_enhancement: 'balanced', color_grade: 'natural', output_resolution: 'horizontal_1080',
      video_quality: 'high', export_audio: true,
    },
    dynamic_reel: {
      audio_preset: 'clear_speech', noise_reduction: 'light', normalize_audio: true,
      video_enhancement: 'strong', color_grade: 'vivid', output_resolution: 'vertical_1080',
      video_quality: 'high', export_audio: true,
    },
    original: {
      audio_preset: 'original', noise_reduction: 'off', normalize_audio: false,
      video_enhancement: 'none', color_grade: 'none', output_resolution: 'source',
      video_quality: 'balanced', export_audio: true,
    },
  };
  const field = (key, label, options) => {
    const selected = String(draft?.[key] ?? "");
    return '<label class="local-field"><span>' + label + '</span><select data-local-setting="' + key + '">' +
      options.map(([value, text]) => '<option value="' + value + '" ' + (selected === value ? 'selected' : '') + '>' + text + '</option>').join('') +
      '</select></label>';
  };
  const toggle = (key, label, note = '') =>
    '<label class="local-toggle"><span><strong>' + label + '</strong>' + (note ? '<small>' + note + '</small>' : '') +
    '</span><input type="checkbox" data-local-setting="' + key + '" ' + (draft?.[key] ? 'checked' : '') + '></label>';

  const time = seconds => {
    seconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds - minutes * 60;
    return String(minutes).padStart(2, '0') + ':' + remainder.toFixed(1).padStart(4, '0');
  };

  function trimCard() {
    const duration = Number(upload?.media?.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      return '<article class="local-control-card local-trim-control"><h3>Обрезка по времени</h3><p class="local-note">Сначала загрузите видео. После этого здесь появятся два ползунка: начало и конец готового ролика.</p></article>';
    }
    let start = Math.max(0, Math.min(Number(draft?.trim_start) || 0, duration));
    let end = draft?.trim_end == null ? duration : Math.max(0, Math.min(Number(draft.trim_end), duration));
    if (end - start < 0.1) { start = 0; end = duration; }
    return '<article class="local-control-card local-trim-control" data-trim-duration="' + duration + '">' +
      '<h3>Обрезка по времени</h3><p class="local-note">Оставьте нужный фрагмент. Исходный файл не изменится.</p>' +
      '<label class="local-trim-field"><span>Начало <b data-trim-start-label>' + time(start) + '</b></span><input type="range" min="0" max="' + duration + '" step="0.1" value="' + start + '" data-trim="start"></label>' +
      '<label class="local-trim-field"><span>Конец <b data-trim-end-label>' + time(end) + '</b></span><input type="range" min="0" max="' + duration + '" step="0.1" value="' + end + '" data-trim="end"></label>' +
      '<p class="local-trim-summary">В готовом ролике: <b data-trim-summary>' + time(end - start) + '</b></p></article>';
  }

  function wireTrim(section) {
    const card = section.querySelector('[data-trim-duration]');
    if (!card || !draft) return;
    const duration = Number(card.dataset.trimDuration);
    const startInput = card.querySelector('[data-trim="start"]');
    const endInput = card.querySelector('[data-trim="end"]');
    const startLabel = card.querySelector('[data-trim-start-label]');
    const endLabel = card.querySelector('[data-trim-end-label]');
    const summary = card.querySelector('[data-trim-summary]');
    const update = (changed, persist) => {
      let start = Number(startInput.value), end = Number(endInput.value);
      if (changed === 'start' && start > end - 0.1) end = Math.min(duration, start + 0.1);
      if (changed === 'end' && end < start + 0.1) start = Math.max(0, end - 0.1);
      startInput.value = String(start);
      endInput.value = String(end);
      draft.trim_start = Number(start.toFixed(3));
      draft.trim_end = end >= duration - 0.05 ? null : Number(end.toFixed(3));
      startLabel.textContent = time(start);
      endLabel.textContent = time(end);
      summary.textContent = time(end - start);
      if (persist) { save(); toast('Фрагмент для монтажа сохранён'); }
    };
    startInput.addEventListener('input', () => update('start', false));
    endInput.addEventListener('input', () => update('end', false));
    startInput.addEventListener('change', () => update('start', true));
    endInput.addEventListener('change', () => update('end', true));
  }

  function setSetting(input) {
    const key = input.dataset.localSetting;
    if (!key || !draft) return;
    draft[key] = input.type === 'checkbox' ? input.checked : input.value;
    if (key === 'montage_preset') Object.assign(draft, presets[input.value] || {});
    save();
    toast(key === 'montage_preset' ? 'Сценарий применён. При желании настройте детали ниже.' : 'Настройка сохранена');
  }

  function addControls() {
    if (page !== 'montage' || detailId || document.querySelector('#local-studio-controls')) return;
    const anchor = document.querySelector('.video-section');
    if (!anchor) return;
    const section = document.createElement('section');
    section.id = 'local-studio-controls';
    section.className = 'settings-section local-controls';
    section.innerHTML =
      '<div class="section-heading"><h2>Глубокая обработка</h2><span class="local-chip">Работает локально</span></div>' +
      '<p class="preview-description">Настройки применяются к готовому MP4. Тяжёлые ИИ-функции — распознавание речи, нейроапскейл и смысловой монтаж — подключаются на сервере позднее.</p>' +
      '<div class="local-settings-grid">' +
      '<article class="local-control-card"><h3>Голос и звук</h3>' +
      field('audio_preset', 'Профиль', [
        ['original', 'Без изменения голоса'],
        ['clear_speech', 'Чистая речь'],
        ['podcast', 'Подкаст / интервью'],
      ]) +
      field('noise_reduction', 'Подавление шума', [
        ['off', 'Выключено'], ['light', 'Лёгкое'], ['medium', 'Среднее'], ['strong', 'Сильное'],
      ]) +
      toggle('normalize_audio', 'Выровнять громкость', 'Подготовка для Telegram, Reels и Shorts') +
      toggle('export_audio', 'Сохранить MP3', 'Отдельная аудиодорожка появится у готового ролика') +
      '</article>' +
      '<article class="local-control-card"><h3>Картинка и экспорт</h3>' +
      field('montage_preset', 'Сценарий', [
        ['talking_head', 'Говорящая голова · вертикально'],
        ['podcast', 'Подкаст / интервью · горизонтально'],
        ['dynamic_reel', 'Динамичный Reel · ярче и резче'],
        ['original', 'Сохранить оригинал'],
      ]) +
      '<small class="local-note">Сценарий применяет готовый набор настроек. Смысловые склейки и автоматическая нарезка подключаются на сервере с ИИ.</small>' +
      field('video_enhancement', 'Очистка и резкость', [
        ['none', 'Без улучшения'], ['balanced', 'Сбалансированно'], ['strong', 'Максимально'],
      ]) +
      field('color_grade', 'Цвет', [
        ['none', 'Без коррекции'], ['natural', 'Естественный'], ['warm', 'Тёплый'], ['vivid', 'Яркий'],
      ]) +
      field('output_resolution', 'Кадр', [
        ['vertical_1080', '9:16 · 1080 × 1920'],
        ['vertical_720', '9:16 · 720 × 1280'],
        ['horizontal_1080', '16:9 · 1920 × 1080'],
        ['source', 'Сохранить исходный кадр'],
      ]) +
      field('video_quality', 'Качество файла', [
        ['high', 'Высокое'], ['balanced', 'Сбалансированное'], ['compact', 'Компактное'],
      ]) +
      '</article>' + trimCard() + '</div>';
    anchor.before(section);
    section.querySelectorAll('[data-local-setting]').forEach(input => input.addEventListener('change', () => setSetting(input)));
    wireTrim(section);
  }

  function addResultTools() {
    const job = detailId && jobs.find(value => value.id === detailId);
    if (!job || job.status !== 'completed' || document.querySelector('#local-result-tools')) return;
    const target = document.querySelector('.detail > div:last-child');
    if (!target) return;
    const card = document.createElement('section');
    card.id = 'local-result-tools';
    card.className = 'card local-result-tools';
    const hasAudio = job.result?.audio_available === true;
    card.innerHTML =
      '<h3>Инструменты результата</h3><p>Можно скачать отдельную дорожку или получить рекомендации для следующей версии ролика.</p>' +
      '<div class="actions">' +
      (hasAudio ? '<a class="pill-light" href="/api/jobs/' + job.id + '/audio?download=1">↓ Скачать MP3</a>' : '') +
      '<button type="button" data-local-advice>Подготовить план монтажа</button></div>' +
      '<div class="local-advice" aria-live="polite"></div>';
    target.append(card);
    card.querySelector('[data-local-advice]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      const output = card.querySelector('.local-advice');
      output.textContent = 'Анализируем параметры исходника…';
      try {
        const plan = await api('/api/jobs/' + job.id + '/assistant', {method: 'POST', data: {}});
        output.replaceChildren();
        const intro = document.createElement('p');
        intro.textContent = plan.summary;
        output.append(intro);
        for (const recommendation of plan.recommendations || []) {
          const item = document.createElement('article');
          item.className = 'local-recommendation';
          const title = document.createElement('strong');
          const text = document.createElement('p');
          const apply = document.createElement('button');
          title.textContent = recommendation.title;
          text.textContent = recommendation.text;
          apply.textContent = 'Применить к новой версии';
          apply.addEventListener('click', () => {
            Object.assign(draft, recommendation.settings || {});
            save();
            page = 'montage';
            detailId = null;
            render();
            toast('Рекомендованные настройки перенесены в новую версию.');
          });
          item.append(title, text, apply);
          output.append(item);
        }
      } catch (error) {
        output.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  const suppliedRender = render;
  render = function localRender() {
    suppliedRender();
    addControls();
    addResultTools();
  };
  setTimeout(() => {
    addControls();
    addResultTools();
  }, 0);
})();
