export const ICONS: Record<string, string> = {
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

export function applySidebarIcons(): void {
  Object.keys(ICONS).forEach((name) => {
    document
      .querySelectorAll<HTMLElement>('.sb-sprite[data-sprite="' + name + '"]')
      .forEach((el) => {
        el.style.backgroundImage = 'url("' + ICONS[name] + '")';
      });
  });
}
