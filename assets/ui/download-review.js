'use strict';
(async () => {
  const api = window.downloadReviewAPI;
  try {
    const info = await api.getInfo();
    document.querySelector('#download-name').textContent = info.filename;
    document.querySelector('#download-project').textContent = `归属剧本：${info.projectName}`;
    const choose = value => { document.querySelectorAll('button').forEach(button => { button.disabled = true; }); api.choose(value); };
    document.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => choose(button.dataset.choice)));
    document.querySelector('#cancel').addEventListener('click', () => choose('cancel'));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); choose('cancel'); } });
    document.querySelector('#cancel').focus();
  } catch (error) { document.querySelector('#error').textContent = error.message; }
})();
