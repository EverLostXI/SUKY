/**
 * viewManager.js — 3D 摄像机转场系统
 */
import state from '../core/state.js';

let useWaapi = true;

try {
  CSS.registerProperty({ name: '--cam-rx', syntax: '<angle>', inherits: true, initialValue: '0deg' });
  CSS.registerProperty({ name: '--cam-tz', syntax: '<length>', inherits: true, initialValue: '0px' });
} catch (e) {
  if (e?.name !== 'InvalidModificationError') {
    useWaapi = false;
  }
}

const scene = document.querySelector('.scene-3d');
const playbackView = document.getElementById('playback-view');
const tableMachine = document.querySelector('.table-cd-machine');
const playbackMachineWrap = document.querySelector('.cd-player-main');
const playbackMachine = document.getElementById('cd-machine-container');

const CAM_TARGET_ANGLE = 95;
const PHASE_B_DURATION = 700;
const PHASE_B_DELAY = 80;
const VIEW_CROSSFADE_DURATION = 140;
const CD_DROP_DURATION = 400;

const CAM_EASE_DOWN = 'cubic-bezier(0.45, 0, 0.15, 1)';
const CAM_EASE_UP = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

state.transitioning = false;
let capturedPlaybackMachineTransform = '';

export function showMain() {
  document.body.classList.remove('in-playback');
  playbackView.classList.add('inactive');
  state.set('view', 'main');
}

export function showPlayback() {
  playbackView.classList.remove('inactive');
  state.set('view', 'playback');
}

export async function transitionToPlayback(onMidpoint) {
  if (state.transitioning) return;
  state.transitioning = true;

  scene.style.willChange = 'transform';

  await delay(PHASE_B_DELAY);
  await animateCam(0, CAM_TARGET_ANGLE, PHASE_B_DURATION, CAM_EASE_DOWN);

  const cdDisc = document.getElementById('cd-disc');
  const cdShadow = document.querySelector('.cd-disc-shadow');
  cdDisc.style.opacity = '0';
  cdDisc.style.transform = 'translateY(-120vh) rotate(0deg)';
  cdShadow.style.opacity = '0';

  await onMidpoint?.();
  playbackView.style.transition = 'none';
  playbackView.style.visibility = 'hidden';
  playbackView.style.opacity = '0';
  showPlayback();
  void playbackView.offsetHeight;

  capturePlaybackMachineTransformFromTable();
  applyCapturedPlaybackMachineTransform();
  playbackView.style.visibility = '';
  playbackView.style.transition = `opacity ${VIEW_CROSSFADE_DURATION}ms ease`;
  playbackView.style.opacity = '0';
  void playbackView.offsetHeight;
  playbackView.style.opacity = '1';
  await delay(VIEW_CROSSFADE_DURATION);
  scene.style.visibility = 'hidden';
  playbackView.style.transition = '';
  playbackView.style.opacity = '';
  scene.style.setProperty('--cam-rx', '0deg');
  scene.style.willChange = '';

  const shadowFade = cdShadow.animate(
    [
      { opacity: 0 },
      { opacity: 1 }
    ],
    {
      duration: Math.max(180, Math.round(CD_DROP_DURATION * 0.65)),
      easing: 'ease',
      fill: 'forwards'
    }
  );
  const cdDropAnim = cdDisc.animate(
    [
      { transform: 'translateY(-120vh) rotate(0deg)', opacity: 0 },
      { transform: 'translateY(0) rotate(0deg)', opacity: 1 }
    ],
    {
      duration: CD_DROP_DURATION,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards'
    }
  );

  await Promise.all([shadowFade.finished, cdDropAnim.finished]);
  shadowFade.cancel();
  cdDropAnim.cancel();
  cdDisc.style.transform = '';
  cdDisc.style.opacity = '';
  cdShadow.style.opacity = '';
  document.body.classList.add('in-playback');

  state.transitioning = false;
}

export async function transitionToMain() {
  if (state.transitioning) return;
  state.transitioning = true;

  const cdDisc = document.getElementById('cd-disc');
  const cdFlyOut = cdDisc.animate(
    [
      { transform: 'translateY(0) rotate(0deg)', opacity: 1 },
      { transform: 'translateY(-120vh) rotate(0deg)', opacity: 0 }
    ],
    {
      duration: 400,
      easing: 'cubic-bezier(0.4, 0, 1, 1)',
      fill: 'forwards'
    }
  );

  await cdFlyOut.finished;
  cdFlyOut.cancel();

  scene.style.setProperty('--cam-rx', `${CAM_TARGET_ANGLE}deg`);
  scene.style.willChange = 'transform';
  scene.style.visibility = '';
  scene.style.opacity = '';
  resetPlaybackMachineTransform();

  playbackView.style.transition = 'none';
  playbackView.classList.add('inactive');
  void playbackView.offsetHeight;
  playbackView.style.transition = '';
  document.body.classList.remove('in-playback');
  state.set('view', 'main');

  await delay(50);
  await animateCam(CAM_TARGET_ANGLE, 0, 800, CAM_EASE_UP);

  scene.style.setProperty('--cam-rx', '0deg');
  scene.style.willChange = '';
  cdDisc.style.transform = '';
  cdDisc.style.opacity = '';

  state.transitioning = false;
}

async function animateCam(fromDeg, toDeg, duration, easing) {
  if (!scene) return;

  if (useWaapi) {
    const animation = scene.animate(
      [
        { '--cam-rx': `${fromDeg}deg` },
        { '--cam-rx': `${toDeg}deg` }
      ],
      {
        duration,
        easing,
        fill: 'forwards'
      }
    );

    await animation.finished;
    animation.cancel();
    scene.style.setProperty('--cam-rx', `${toDeg}deg`);
    return;
  }

  const start = performance.now();
  await new Promise(resolve => {
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const value = fromDeg + (toDeg - fromDeg) * easeInOut(t);
      scene.style.setProperty('--cam-rx', `${value}deg`);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function capturePlaybackMachineTransformFromTable() {
  if (!tableMachine || !playbackMachineWrap || !playbackMachine) return;

  const tableRect = tableMachine.getBoundingClientRect();
  const playbackRect = playbackMachine.getBoundingClientRect();
  if (!tableRect.width || !playbackRect.width) return;

  const tableCx = tableRect.left + tableRect.width / 2;
  const tableCy = tableRect.top + tableRect.height / 2;
  const playbackCx = playbackRect.left + playbackRect.width / 2;
  const playbackCy = playbackRect.top + playbackRect.height / 2;

  const dx = tableCx - playbackCx;
  const dy = tableCy - playbackCy;
  const scale = tableRect.width / playbackRect.width;

  capturedPlaybackMachineTransform = `translate(${dx}px, ${dy-20}px) scale(${scale * .97})`;
}

function applyCapturedPlaybackMachineTransform() {
  if (!playbackMachineWrap) return;
  playbackMachineWrap.style.transformOrigin = 'center center';
  playbackMachineWrap.style.transform = capturedPlaybackMachineTransform || '';
  
  if (playbackMachine) {
    const rect = playbackMachine.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    playbackView.style.setProperty('--cd-center-y', `${centerY}px`);
  }
}

function resetPlaybackMachineTransform() {
  if (!playbackMachineWrap) return;
  playbackMachineWrap.style.transform = '';
  playbackMachineWrap.style.transformOrigin = '';
  playbackView.style.removeProperty('--cd-center-y');
  capturedPlaybackMachineTransform = '';
}
