/* 视频音轨试听与人物音色截取。两个资产预览共用，不改变原视频。 */
(() => {
  'use strict';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const seconds = value => Number(value).toFixed(2);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, className = '') => {
    const element = node('button', `voice-button ${className}`, text);
    element.type = 'button';
    return element;
  };

  function mount({ host, actions, item, video, getProjectId, onSaved, exportAudio }) {
    if (!host || !actions || item?.type !== 'video') return { destroy() {} };
    const projectId = getProjectId();
    const dialog = host.closest('dialog');
    const trigger = button('人物音频');
    trigger.setAttribute('aria-expanded', 'false');
    actions.prepend(trigger);
    const panel = node('section', 'voice-clip-panel');
    panel.setAttribute('aria-label', '提取人物音频');
    panel.hidden = true;
    host.append(panel);
    const heading = node('div', 'voice-heading');
    const title = node('strong', '', '人物音频');
    const collapse = button('收起');
    heading.append(title, collapse);
    const status = node('p', 'voice-status', '提取原音轨，可试听后截取；不会自动分离人物或背景音乐。');
    status.setAttribute('role', 'status');
    const editor = node('div', 'voice-editor');
    editor.hidden = true;
    panel.append(heading, status, editor);

    const audio = node('audio', 'voice-track');
    audio.controls = true;
    audio.preload = 'auto';
    audio.setAttribute('aria-label', '试听完整音轨');
    const wave = node('div', 'voice-wave');
    const canvas = node('canvas');
    canvas.setAttribute('aria-label', '音轨波形，拖动蓝色选区或两端调整截取范围');
    canvas.setAttribute('role', 'img');
    const selection = node('div', 'voice-selection');
    const startHandle = button('', 'voice-handle voice-start');
    const endHandle = button('', 'voice-handle voice-end');
    for (const [handle, label] of [[startHandle, '截取开始时间'], [endHandle, '截取结束时间']]) {
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', label);
    }
    const playhead = node('div', 'voice-playhead');
    playhead.hidden = true;
    wave.append(canvas, selection, startHandle, endHandle, playhead);

    const range = node('div', 'voice-range');
    function timeInput(label) {
      const wrap = node('label', 'voice-time', label);
      const input = node('input');
      input.type = 'number'; input.min = '0'; input.step = '0.01';
      input.setAttribute('aria-label', label);
      wrap.append(input, node('span', '', '秒'));
      range.append(wrap);
      return input;
    }
    const startInput = timeInput('开始');
    const endInput = timeInput('结束');
    const duration = node('span', 'voice-duration');
    const lockLabel = node('label', 'voice-check');
    const lock = node('input'); lock.type = 'checkbox'; lock.checked = true;
    lockLabel.append(lock, document.createTextNode('锁定 2.1 秒'));
    range.append(duration, lockLabel);
    const listenRow = node('div', 'voice-listen');
    const listen = button('试听片段', 'voice-listen-button');
    const loopLabel = node('label', 'voice-check');
    const loop = node('input'); loop.type = 'checkbox'; loop.checked = true;
    loopLabel.append(loop, document.createTextNode('循环试听'));
    const hint = node('span', 'voice-hint', '选人物单独说话的一小段');
    listenRow.append(listen, loopLabel, hint);
    const saveRow = node('div', 'voice-save');
    const name = node('input'); name.type = 'text'; name.maxLength = 120;
    name.placeholder = '例如：林知意-平静音色';
    name.setAttribute('aria-label', '音频名称');
    name.value = `${String(item.name || '视频').replace(/\.[^.]+$/, '')}-音色`;
    const save = button('保存到本剧', 'voice-primary');
    saveRow.append(name, save);
    const notes = node('details', 'voice-notes');
    notes.append(node('summary', '', '人物与音色备注（可选）'));
    const notesRow = node('div', 'voice-notes-fields');
    const character = node('input'); character.type = 'text'; character.maxLength = 120;
    character.placeholder = '人物名称'; character.setAttribute('aria-label', '人物名称');
    const description = node('textarea'); description.rows = 2; description.maxLength = 2000;
    description.placeholder = '音色描述，例如：清亮、平静、说话稍慢';
    description.setAttribute('aria-label', '音色描述');
    notesRow.append(character, description); notes.append(notesRow);
    const result = node('div', 'voice-result'); result.hidden = true;
    const savedName = node('span');
    const download = button('另存为…');
    result.append(savedName, download);
    editor.append(audio, wave, range, listenRow, saveRow, notes, result);

    let disposed = false;
    let prepared = null;
    let controller = null;
    let saving = false;
    let start = 0;
    let end = 0;
    let selectedPlaying = false;
    let frame = 0;
    let saved = null;
    let drag = null;
    const resizeObserver = new ResizeObserver(drawWave);
    resizeObserver.observe(wave);

    async function request(action, body, signal) {
      const response = await fetch(`/api/voice-clips/${action}?project=${encodeURIComponent(projectId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, projectId }), signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '音频处理失败');
      return payload;
    }
    function release(token) {
      if (token) request('release', { token }).catch(() => {});
    }
    function busy(value) {
      saving = value;
      for (const control of editor.querySelectorAll('input, textarea, button')) control.disabled = value;
      save.textContent = value ? '保存中…' : '保存到本剧';
      // 保存过程中仍可关闭整个预览；服务端会完成已开始的写入。
    }
    function hide() {
      panel.hidden = true;
      dialog?.classList.remove('voice-editing');
      trigger.setAttribute('aria-expanded', 'false');
      stop();
    }
    async function open() {
      if (!panel.hidden) { hide(); return; }
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      dialog?.classList.add('voice-editing');
      video?.pause();
      if (prepared) { drawWave(); return; }
      if (controller) return;
      status.textContent = '正在提取音轨…';
      controller = new AbortController();
      trigger.disabled = true;
      try {
        const track = await request('prepare', { sourcePath: item.path }, controller.signal);
        if (disposed) { release(track.token); return; }
        prepared = track;
        title.textContent = `人物音频 · ${track.projectName}`;
        audio.src = `/api/voice-clips/preview?project=${encodeURIComponent(projectId)}&token=${encodeURIComponent(track.token)}`;
        start = clamp(Number(video?.currentTime) || 0, 0, Math.max(0, track.duration - 2.1));
        end = Math.min(track.duration, start + 2.1);
        editor.hidden = false;
        status.textContent = '拖动选区定位对白。保存为 WAV，自动进入本剧音频库；保留来源和截取时间。';
        updateRange(); drawWave();
      } catch (error) {
        if (!disposed && error.name !== 'AbortError') status.textContent = `${error.message}；点击“人物音频”收起后可重试。`;
      } finally { controller = null; trigger.disabled = false; }
    }
    function drawWave() {
      if (disposed || !prepared || panel.hidden) return;
      const width = wave.clientWidth;
      if (!width) return;
      const height = 82;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#7c98bd';
      const { peaks } = prepared;
      const bars = Math.max(1, Math.floor(width / 3));
      for (let index = 0; index < bars; index++) {
        const first = Math.floor(index * peaks.length / bars);
        const last = Math.max(first + 1, Math.ceil((index + 1) * peaks.length / bars));
        let peak = 0;
        for (let p = first; p < Math.min(last, peaks.length); p++) peak = Math.max(peak, peaks[p]);
        const size = Math.max(2, peak * 70);
        context.fillRect(index * width / bars, (height - size) / 2, 2, size);
      }
    }
    function updateRange() {
      if (!prepared) return;
      startInput.value = seconds(start); endInput.value = seconds(end);
      startInput.max = endInput.max = String(prepared.duration);
      duration.textContent = `${seconds(end - start)} 秒`;
      selection.style.left = startHandle.style.left = `${start / prepared.duration * 100}%`;
      selection.style.width = `${(end - start) / prepared.duration * 100}%`;
      endHandle.style.left = `${end / prepared.duration * 100}%`;
      for (const [handle, value] of [[startHandle, start], [endHandle, end]]) {
        handle.setAttribute('aria-valuemin', '0');
        handle.setAttribute('aria-valuemax', String(prepared.duration));
        handle.setAttribute('aria-valuenow', seconds(value));
        handle.setAttribute('aria-valuetext', `${seconds(value)} 秒`);
      }
      if (selectedPlaying && (audio.currentTime < start || audio.currentTime >= end)) audio.currentTime = start;
    }
    function setEdge(edge, value) {
      if (!prepared) return;
      if (!Number.isFinite(value)) { updateRange(); return; }
      const total = prepared.duration;
      if (lock.checked) {
        const size = Math.min(2.1, total);
        start = clamp(edge === 'end' ? value - size : value, 0, Math.max(0, total - size));
        end = start + size;
      } else if (edge === 'start') start = clamp(value, 0, end - .02);
      else end = clamp(value, start + .02, total);
      updateRange();
    }
    function stop() {
      selectedPlaying = false; audio.pause();
      listen.textContent = '试听片段';
      cancelAnimationFrame(frame); frame = 0;
    }
    function tick() {
      if (disposed || audio.paused) { frame = 0; return; }
      if (selectedPlaying && audio.currentTime >= end - .008) {
        if (loop.checked) audio.currentTime = start;
        else stop();
      }
      playhead.hidden = false;
      playhead.style.left = `${clamp(audio.currentTime / prepared.duration, 0, 1) * 100}%`;
      if (!audio.paused) frame = requestAnimationFrame(tick);
    }
    async function playSelection() {
      if (selectedPlaying && !audio.paused) { stop(); return; }
      selectedPlaying = true; audio.currentTime = start;
      listen.textContent = '停止试听';
      try { await audio.play(); }
      catch { stop(); status.textContent = '音轨暂时无法播放，请重新提取后重试。'; }
    }
    function position(event) {
      const bounds = wave.getBoundingClientRect();
      return clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * prepared.duration;
    }
    wave.addEventListener('pointerdown', event => {
      if (!prepared || saving || event.button !== 0) return;
      event.preventDefault();
      const edge = event.target === startHandle ? 'start' : event.target === endHandle ? 'end' : '';
      const value = position(event);
      if (edge) drag = { edge };
      else {
        const size = end - start;
        const inside = value >= start && value <= end;
        drag = { edge: 'move', offset: inside ? value - start : size / 2, size };
        start = clamp(value - drag.offset, 0, Math.max(0, prepared.duration - size)); end = start + size;
        updateRange();
      }
      wave.setPointerCapture(event.pointerId);
    });
    wave.addEventListener('pointermove', event => {
      if (!drag) return;
      const value = position(event);
      if (drag.edge === 'move') {
        start = clamp(value - drag.offset, 0, Math.max(0, prepared.duration - drag.size));
        end = start + drag.size; updateRange();
      } else setEdge(drag.edge, value);
    });
    const stopDrag = () => { drag = null; };
    wave.addEventListener('pointerup', stopDrag);
    wave.addEventListener('pointercancel', stopDrag);
    wave.addEventListener('lostpointercapture', stopDrag);
    for (const [handle, edge] of [[startHandle, 'start'], [endHandle, 'end']]) {
      handle.addEventListener('keydown', event => {
        if (saving || !prepared || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const value = edge === 'start' ? start : end;
        setEdge(edge, event.key === 'Home' ? 0 : event.key === 'End' ? prepared.duration : value + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? .1 : .01));
      });
    }
    startInput.addEventListener('change', () => setEdge('start', startInput.valueAsNumber));
    endInput.addEventListener('change', () => setEdge('end', endInput.valueAsNumber));
    lock.addEventListener('change', () => { if (lock.checked) setEdge('start', start); });
    trigger.addEventListener('click', open);
    collapse.addEventListener('click', hide);
    listen.addEventListener('click', playSelection);
    audio.addEventListener('play', () => { if (!frame) frame = requestAnimationFrame(tick); });
    audio.addEventListener('pause', () => { cancelAnimationFrame(frame); frame = 0; listen.textContent = '试听片段'; });
    audio.addEventListener('pointerdown', () => { selectedPlaying = false; listen.textContent = '试听片段'; });
    audio.addEventListener('ended', () => {
      if (selectedPlaying && loop.checked && !disposed) { audio.currentTime = start; audio.play().catch(stop); }
      else stop();
    });
    save.addEventListener('click', async () => {
      if (saving || !prepared) return;
      if (!name.value.trim()) { name.focus(); status.textContent = '请先填写音频名称。'; return; }
      stop(); busy(true);
      try {
        const data = await request('save', { token: prepared.token, start, end,
          name: name.value, characterName: character.value, description: description.value });
        if (disposed) return;
        saved = data.item;
        savedName.textContent = `已存入本剧音频：${saved.filename} · ${seconds(saved.duration)} 秒`;
        result.hidden = false;
        status.textContent = '已保存，可在音频库复用；继续调整可截取下一段。';
        // 文件已成功保存，界面刷新失败不应误报为保存失败或引导重复写入。
        try { await onSaved?.(saved); } catch { status.textContent = '音频已保存，刷新资产库即可查看。'; }
      } catch (error) { if (!disposed) status.textContent = error.message; }
      finally { if (!disposed) busy(false); }
    });
    download.addEventListener('click', async () => {
      if (!saved) return;
      try {
        if (typeof exportAudio === 'function') await exportAudio(saved.path);
        else {
          const link = node('a');
          link.href = `/api/creative-assets/file?project=${encodeURIComponent(projectId)}&p=${encodeURIComponent(saved.path)}`;
          link.download = saved.filename;
          document.body.append(link); link.click(); link.remove();
        }
      } catch (error) { status.textContent = error.message || '另存音频失败'; }
    });
    return {
      destroy() {
        if (disposed) return;
        disposed = true; controller?.abort(); stop(); resizeObserver.disconnect();
        audio.removeAttribute('src'); audio.load();
        release(prepared?.token); prepared = null;
        dialog?.classList.remove('voice-editing');
        panel.remove(); trigger.remove();
      },
    };
  }
  window.VoiceClipEditor = Object.freeze({ mount });
})();
