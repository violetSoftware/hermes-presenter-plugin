import './navigation.css';

/** One visible control pair; Reveal remains the sole navigation state owner. */
export function mountNavigation(reveal) {
  if (reveal.getConfig().controls) return; // Never duplicate explicitly enabled native controls.
  const nav = document.createElement('nav'); nav.className = 'slide-navigation';
  nav.setAttribute('aria-label', 'Slide navigation');
  const make = (label, text, action) => {
    const button = document.createElement('button'); button.textContent = text;
    button.setAttribute('aria-label', label); button.title = label;
    button.onclick = () => { action(); update(); }; nav.append(button); return button;
  };
  const prev = make('Previous slide', '‹', () => reveal.prev());
  const next = make('Next slide', '›', () => reveal.next());
  const update = () => {
    const fragments = reveal.availableFragments(), loop = reveal.getConfig().loop;
    // Mobile Reveal scroll view reparents each section into its own page. Its
    // isLastSlide sibling check then misidentifies every page as the last slide.
    const slides = reveal.getSlides(), index = slides.indexOf(reveal.getCurrentSlide());
    const first = reveal.isScrollView() ? index === 0 : reveal.isFirstSlide();
    const last = reveal.isScrollView() ? index === slides.length - 1 : reveal.isLastSlide();
    prev.disabled = !loop && first && !fragments.prev;
    next.disabled = !loop && last && !fragments.next;
  };
  // Preserve native button activation; do not run Reveal's shortcuts a second time.
  nav.addEventListener('keydown', event => event.stopPropagation());
  document.body.append(nav);
  for (const event of ['slidechanged', 'fragmentshown', 'fragmenthidden', 'slideschanged']) reveal.on(event, update);
  update();
}
