// Sidebar sprite-icon binder. Mirrors frontend/js/config/icons.ts so the
// portal shell can bind its own icons without depending on the config
// module. Kept duplicated for now because portal-ui imports this directly.

export function initSidebarIcons(): void {
  const ICONS: Record<string, string> = {
    home: 'assets/icon-home.png',
    courses: 'assets/icon-courses.png',
    notes: 'assets/icon-notes.png',
    lounge: 'assets/icon-lounge.png',
    editor: 'assets/icon-editor.png',
    chat: 'assets/icon-chat.png',
    notifications: 'assets/icon-notifications.png',
    games: 'assets/icon-games.png',
    chatbot: 'assets/icon-chatbot.png',
    profile: 'assets/icon-profile.png',
    settings: 'assets/icon-settings.png',
    subscription: 'assets/icon-subscription.png',
  };
  Object.keys(ICONS).forEach((name) => {
    document
      .querySelectorAll<HTMLElement>('.sb-sprite[data-sprite="' + name + '"]')
      .forEach((el) => {
        el.style.backgroundImage = 'url("' + ICONS[name] + '")';
      });
  });
}
