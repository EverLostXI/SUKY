export function createStartupOverlay() {
  const overlay = document.getElementById('startup-overlay');
  const eyebrow = document.getElementById('startup-eyebrow');
  const title = document.getElementById('startup-title');
  const description = document.getElementById('startup-description');
  const hint = document.getElementById('startup-hint');
  const progress = document.getElementById('startup-progress');
  const progressFill = document.getElementById('startup-progress-fill');
  const progressText = document.getElementById('startup-progress-text');
  const primaryBtn = document.getElementById('startup-primary-btn');
  const secondaryBtn = document.getElementById('startup-secondary-btn');

  function show() {
    overlay?.classList.remove('hidden');
  }

  function hide() {
    overlay?.classList.add('hidden');
  }

  function setButton(button, { label, onClick, visible = true, disabled = false } = {}) {
    if (!button) return;
    button.textContent = label || '';
    button.disabled = disabled;
    button.classList.toggle('hidden', !visible);
    button.onclick = onClick || null;
  }

  function setProgress(done, total) {
    if (!progress || !progressFill || !progressText) return;
    const safeDone = Number.isFinite(done) ? Math.max(0, done) : 0;
    const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
    const ratio = safeTotal > 0 ? safeDone / safeTotal : 0;

    progress.classList.remove('hidden');
    progressFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    progressText.textContent = safeTotal > 0
      ? `扫描 ${safeDone} / ${safeTotal}`
      : '正在准备媒体库';
  }

  function hideProgress() {
    progress?.classList.add('hidden');
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '';
  }

  function setContent({
    eyebrowText = '本地媒体库',
    titleText,
    descriptionText,
    hintText = '',
    primaryAction,
    secondaryAction,
    showProgress = false
  }) {
    show();
    if (eyebrow) eyebrow.textContent = eyebrowText;
    if (title) title.textContent = titleText || '';
    if (description) description.textContent = descriptionText || '';
    if (hint) hint.textContent = hintText;

    setButton(primaryBtn, primaryAction);
    setButton(secondaryBtn, secondaryAction);

    if (showProgress) {
      if (progress && progress.classList.contains('hidden')) {
        setProgress(0, 0);
      }
    } else {
      hideProgress();
    }
  }

  return {
    hide,
    showWelcome(onChooseDirectory) {
      setContent({
        titleText: '选择音乐文件夹',
        descriptionText: '请选择含有音乐文件的目录，目录内的音乐文件应把每个专辑放在独立的子文件夹内，以便 Suky 正确识别和展示。',
        hintText: '我们需要目录读写权限来在您的目录内创建一些缓存文件（.suky 文件夹），以便更快地加载和更新媒体库。请放心，我们不会修改您的音乐文件。',
        primaryAction: {
          label: '选择音乐文件夹',
          onClick: onChooseDirectory,
          visible: true
        },
        secondaryAction: {
          visible: false
        }
      });
    },
    showPermissionRequest(onContinue, onChooseAnother) {
      setContent({
        titleText: '点击以继续',
        descriptionText: '已找到上次选择的目录，但浏览器还需要一次显式授权才能继续扫描和更新 .suky 缓存。',
        hintText: '如果当前目录已经不可用，也可以直接改选其他目录。',
        primaryAction: {
          label: '继续访问目录',
          onClick: onContinue,
          visible: true
        },
        secondaryAction: {
          label: '更换目录',
          onClick: onChooseAnother,
          visible: true
        }
      });
    },
    showScanning(done = 0, total = 0, descriptionText = '正在扫描音乐目录并同步虚拟数据路径。') {
      setContent({
        titleText: '正在扫描媒体库',
        descriptionText,
        hintText: '首次扫描或目录变更较大时会稍慢一些。',
        primaryAction: {
          label: '扫描中',
          visible: true,
          disabled: true
        },
        secondaryAction: {
          visible: false
        },
        showProgress: true
      });
      setProgress(done, total);
    },
    updateProgress(done, total) {
      setProgress(done, total);
    },
    showError(error, { onRetry, onChooseDirectory } = {}) {
      const message = error instanceof Error ? error.message : String(error || '未知错误');
      setContent({
        eyebrowText: '初始化失败',
        titleText: '无法准备本地媒体库',
        descriptionText: message,
        hintText: '如果是权限或环境问题，重新选择目录通常更稳妥。',
        primaryAction: {
          label: onRetry ? '重试' : '刷新页面',
          onClick: onRetry || (() => window.location.reload()),
          visible: true
        },
        secondaryAction: {
          label: '更换目录',
          onClick: onChooseDirectory,
          visible: Boolean(onChooseDirectory)
        }
      });
    }
  };
}
