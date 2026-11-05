// Keep the dialog in the top layer until its exit animation finishes.
export function presentVoicePreview(dialog: HTMLDialogElement, join: () => void) {
  let closing = false;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dismiss = async (connect = false) => {
    if (closing) return;
    closing = true;
    dialog.classList.add('is-closing');
    if (!reduceMotion) {
      const animations = dialog.getAnimations();
      await Promise.allSettled(animations.map(animation => animation.finished));
    }
    dialog.close();
    dialog.remove();
    if (connect) join();
  };
  dialog.querySelector('[data-voice-close]')?.addEventListener('click', () => void dismiss());
  dialog.querySelector('[data-voice-join]')?.addEventListener('click', () => void dismiss(true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && event.clientY < dialog.getBoundingClientRect().top) void dismiss(); });
  document.body.append(dialog);
  dialog.showModal();
}
