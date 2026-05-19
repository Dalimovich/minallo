// Top-bar + portal-shell UI: night toggle, mobile sidebar, sidebar nav.
const NIGHT_ICON_SUN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
const NIGHT_ICON_MOON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

export interface PortalUiOptions {
  getNightOn: () => boolean;
  setNightOn: (toNight: boolean) => void;
  saveState?: () => void;
  showStudip: () => void;
  showStudipResume?: () => boolean;
  pushHistory: (state: unknown, hash: string) => void;
}

export function bindIf(id: string, ev: string, fn: (this: HTMLElement, ev: Event) => void): void {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn as EventListener);
}

export function initPortalUi(options: PortalUiOptions): { applyTheme: (toNight: boolean, originEl?: Element) => void } {
  function applyTheme(toNight: boolean, originEl?: Element): void {
    const rect = originEl
      ? originEl.getBoundingClientRect()
      : ({
          left: window.innerWidth / 2,
          top: window.innerHeight / 2,
          width: 0,
          height: 0,
        } as DOMRect);
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    function commitTheme(): void {
      options.setNightOn(toNight);
      document.body.classList.toggle('night', toNight);
      const nbIcon = document.getElementById('nightIcon');
      if (nbIcon) {
        nbIcon.innerHTML = toNight ? NIGHT_ICON_MOON : NIGHT_ICON_SUN;
        const nbLbl = document.getElementById('nightLabel');
        if (nbLbl) nbLbl.textContent = toNight ? 'Night' : 'Day';
      }
      const dm = document.getElementById('settingsDarkMode') as HTMLInputElement | null;
      if (dm) dm.checked = toNight;
      localStorage.setItem('ss_dark', toNight ? '1' : '0');
      if (typeof options.saveState === 'function') options.saveState();
    }

    if (typeof document.startViewTransition !== 'function') {
      commitTheme();
      return;
    }
    const transition = document.startViewTransition(commitTheme);
    transition.ready.then(() => {
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );
      document.documentElement.animate(
        {
          clipPath: [
            'circle(0px at ' + x + 'px ' + y + 'px)',
            'circle(' + endRadius + 'px at ' + x + 'px ' + y + 'px)',
          ],
        },
        {
          duration: 500,
          easing: 'ease-in-out',
          pseudoElement: '::view-transition-new(root)',
        }
      );
    });
  }

  (function syncNightButton(): void {
    const isNight = !!options.getNightOn();
    const bIcon = document.getElementById('nightIcon');
    if (bIcon) bIcon.innerHTML = isNight ? NIGHT_ICON_MOON : NIGHT_ICON_SUN;
    const bLbl = document.getElementById('nightLabel');
    if (bLbl) bLbl.textContent = isNight ? 'Night' : 'Day';
  })();

  bindIf('nightBtn', 'click', function () {
    applyTheme(!options.getNightOn(), this);
  });

  (function initMobileSidebar(): void {
    const ham = document.getElementById('portalHamburger');
    const scrim = document.getElementById('mobScrim');
    const sb = document.querySelector<HTMLElement>('#portal .sidebar');
    if (!ham || !scrim || !sb) return;
    function openMobSb(): void {
      sb!.classList.add('mob-open');
      scrim!.classList.add('show');
    }
    function closeMobSb(): void {
      sb!.classList.remove('mob-open');
      scrim!.classList.remove('show');
    }
    ham.addEventListener('click', openMobSb);
    scrim.addEventListener('click', closeMobSb);
    sb.addEventListener('click', (e: Event) => {
      const target = e.target as Element | null;
      if (window.innerWidth <= 768 && target && target.closest('.sb-item')) closeMobSb();
    });
  })();

  bindIf('pcStudip', 'click', () => {
    const resumed =
      typeof options.showStudipResume === 'function' ? options.showStudipResume() : false;
    if (resumed) return;
    options.showStudip();
    options.pushHistory({ view: 'studip' }, '#studip');
  });
  bindIf('pcMail', 'click', () => {
    window.open('https://mail.tu-braunschweig.de', '_blank');
  });
  bindIf('pcConnect', 'click', () => {
    window.open('https://connect.tu-braunschweig.de', '_blank');
  });
  bindIf('pcTT', 'click', () => {
    window.open('https://connect.tu-braunschweig.de', '_blank');
  });
  bindIf('pcCert', 'click', () => {
    window.open('https://connect.tu-braunschweig.de', '_blank');
  });
  bindIf('pcWeb', 'click', () => {
    window.open('https://www.tu-braunschweig.de', '_blank');
  });

  return { applyTheme };
}
