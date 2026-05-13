export interface TranslationMap {
  [key: string]: string;
}

export const translations: Record<string, TranslationMap> = {
  en: {
    nav_home: 'Home',
    nav_profile: 'Profile',
    nav_settings: 'Settings',
    nav_subscription: 'Subscription',
    auth_email_label: 'Email',
    auth_password_label: 'Password',
    auth_confirm_label: 'Confirm Password',
    auth_title_signin: 'Sign in to your account',
    auth_title_signup: 'Create your account',
    auth_submit_signin: 'Sign In',
    auth_submit_signup: 'Create Account',
    auth_google_btn: 'Continue with Google',
    auth_stay: 'Stay signed in',
    auth_stay_timeout: '(30 min timeout)',
    auth_switch_signin: "Don't have an account? Sign up",
    auth_switch_signup: 'Already have an account? Sign in',
    ob_step1: "Let's set up your profile — step 1 of 2",
    ob_step2: 'Almost there — step 2 of 2',
    ob_first_name: 'First Name',
    ob_last_name: 'Last Name',
    ob_age: 'Age',
    ob_email: 'TU-Mail',
    ob_programme: 'Study Programme',
    ob_semester: 'Semester',
    ob_matrikel: 'Matrikel Nr.',
    ob_continue_btn: 'Continue →',
    ob_back_btn: '← Back',
    ob_finish_btn: "🎓 Let's go!",
    settings_save_btn: 'Save Changes',
    card_studip_desc: 'Courses & materials',
    card_mail_desc: 'Outlook Web Access',
    card_connect_desc: 'Exams & grades',
    card_timetable_name: 'Timetable',
    card_timetable_desc: 'Semester schedule',
    card_cert_name: 'Certificates',
    card_cert_desc: 'Enrolment docs',
    profile_label_name: 'Full name',
    profile_label_email: 'Email',
    profile_label_university: 'University',
    profile_label_programme: 'Study programme',
    profile_label_matrikel: 'Matrikel number',
    profile_save_btn: '💾 Save changes',
    settings_appearance: 'Appearance',
    settings_dark_mode: 'Dark mode',
    settings_language: 'Language',
    settings_ai_section: 'AI Assistant',
    settings_auto_open: 'Auto-open on text select',
    settings_save_chat: 'Save chat history per PDF',
    settings_notifications: 'Notifications',
    settings_sync_alerts: 'Lecture note sync alerts',
    settings_mail_alerts: 'New mail alerts',
    settings_data: 'Data',
    settings_clear_chat: 'Clear all AI chat history',
    settings_clear_btn: 'Clear history',
    settings_account: 'Account',
    settings_signout: 'Sign out of Minallo',
    settings_logout_btn: 'Log out',
    ln_title: '🎬 Lecture Notes',
    ln_sync_btn: 'Sync from Extension',
    sb_subjects: '📚 Subjects',
    sb_timetable: '🗓️ Timetable',
    sb_mails: '✉️ Mails',
    sb_back: '← All subjects',
    back_btn: '← Back',
    welcome_title: 'Select a file to read',
    welcome_sub:
      'Open a subject in the sidebar and click any file — it loads here as a real document.',
    welcome_hint: '💡 Select any text or formula → AI automatically asks if you need help',
    pdf_fit: 'Fit',
    pdf_single: 'Single page',
    pdf_download: '⬇ Download',
    ai_ready: 'Ready to help',
    chip_summarise: '✨ Summarise',
    chip_formulas: '🔢 Formulas',
    chip_quiz: '📝 Quiz me',
    chip_keyideas: '💡 Key ideas',
    chip_analogy: '🔗 Analogy',
    depth_label: 'Depth:',
    chip_brief: 'Brief',
    chip_standard: 'Standard',
    chip_thorough: 'In-depth',
    level_label: 'Level:',
    chip_easy: 'Easy',
    chip_medium: 'Medium',
    chip_hard: 'Hard',
    stop_btn: '⏹ Stop generating',
    ai_placeholder: 'Ask anything about this document…',
    ai_welcome: "Hey! 👋 Open a PDF, select any text or formula and I'll help you understand it!",
    ai_tip_no_pdf: '💡 Tip: open a PDF first so I can answer from the actual document!',
    ai_file_loaded_post:
      "loaded! Ask me anything about it — I'll answer based on the document content. 🎓",
    ai_chat_cleared_msg: 'Chat cleared! What would you like to know? 😊',
    chat_restored: '— chat history restored —',
    no_file_open: 'No file open',
    loading_pdf: 'Loading PDF…',
    not_in_demo: 'This file is not available in the demo.',
    not_in_demo_multi: 'not available in demo',
    download_failed: 'Download failed.',
    copy_btn: 'Copy',
    you_label: 'You',
    nothing_yet: 'Nothing here yet',
    studip_subtitle: 'TU Braunschweig · Your courses & materials',
    studip_back: '← Portal',
    sd_subjects: '📚 Subjects',
    sd_timetable: '🗓️ Timetable',
    sd_mails: '✉️ Mails',
    sel_explain: 'Explain this',
    sel_formula: 'Break down formula',
    sel_dismiss: 'Dismiss',
    sel_preview: '📌 You selected:',
    sync_syncing: 'Syncing…',
    sync_synced: 'Synced ✓',
    sync_no_ext: 'Extension not detected',
    toast_saved: '💾 Saved to Lecture Notes',
    toast_new_summary_pre: '📝 New summary: ',
    toast_tap_view: 'Tap View to open your lecture notes',
    toast_synced_s: 'note synced',
    toast_synced_p: 'notes synced',
    toast_no_notes: '⚠️ No notes found',
    toast_summarize_first: 'Summarize a lecture in the extension first',
    toast_sign_in: '⚠️ Sign in to save',
    toast_profile_saved: '✅ Profile saved',
    toast_profile_saved_sub: 'Saved to your account',
    toast_save_failed: '❌ Save failed',
    toast_chat_cleared: '🗑️ Chat history cleared',
    toast_chat_cleared_sub: 'All saved chats have been removed',
    toast_settings_saved: '✅ Settings saved',
    toast_settings_saved_sub: 'Your preferences have been updated',
    toast_signed_out: '👋 Signed out',
    toast_signed_out_sub: 'See you next time!',
    toast_coming_soon: '🚀 Coming soon',
    toast_coming_soon_sub: 'Payment integration coming soon!',
    toast_inactivity: '⏰ Signed out due to inactivity',
    toast_inactivity_sub: 'Sign in again to continue',
    err_connection: 'Connection error — please refresh the page',
    err_fill_fields: 'Please fill in all fields',
    err_confirm_pw: 'Please confirm your password',
    err_pw_mismatch: 'Passwords do not match',
    err_pw_length: 'Password must be at least 8 characters',
    err_account_created:
      '✅ Account created! Check your email and click the confirmation link to get started.',
    err_confirm_email: '⚠️ Please confirm your email first — check your inbox for the link.',
    err_wrong_pw:
      '⚠️ Incorrect password — or did you sign up with Google? Try the Google button below, or use the link to create a new account.',
    err_network: 'Network error — check your connection.',
    aip_new_chat: 'New chat',
    aip_chats_label: 'Chats',
    aip_no_chats: 'No chats yet',
    aip_subtitle: 'Where should we start?',
    aip_landing_ph: 'Ask me anything…',
    aip_followup_ph: 'Ask a follow-up…',
    aip_upload_btn: 'Upload photos & files',
  },
  de: {
    nav_home: 'Startseite',
    nav_profile: 'Profil',
    nav_settings: 'Einstellungen',
    nav_subscription: 'Abonnement',
    auth_email_label: 'E-Mail',
    auth_password_label: 'Passwort',
    auth_confirm_label: 'Passwort bestätigen',
    auth_title_signin: 'Bei deinem Konto anmelden',
    auth_title_signup: 'Konto erstellen',
    auth_submit_signin: 'Anmelden',
    auth_submit_signup: 'Konto erstellen',
    auth_google_btn: 'Mit Google fortfahren',
    auth_stay: 'Angemeldet bleiben',
    auth_stay_timeout: '(30 Min. Timeout)',
    auth_switch_signin: 'Kein Konto? Registrieren',
    auth_switch_signup: 'Bereits ein Konto? Anmelden',
    ob_step1: 'Profil einrichten — Schritt 1 von 2',
    ob_step2: 'Fast geschafft — Schritt 2 von 2',
    ob_first_name: 'Vorname',
    ob_last_name: 'Nachname',
    ob_age: 'Alter',
    ob_email: 'TU-Mail',
    ob_programme: 'Studiengang',
    ob_semester: 'Semester',
    ob_matrikel: 'Matrikelnummer',
    ob_continue_btn: 'Weiter →',
    ob_back_btn: '← Zurück',
    ob_finish_btn: "🎓 Los geht's!",
    settings_save_btn: 'Änderungen speichern',
    card_studip_desc: 'Kurse & Materialien',
    card_mail_desc: 'Outlook Web-Zugang',
    card_connect_desc: 'Prüfungen & Noten',
    card_timetable_name: 'Stundenplan',
    card_timetable_desc: 'Semesterplan',
    card_cert_name: 'Zertifikate',
    card_cert_desc: 'Immatrikulationsdokumente',
    profile_label_name: 'Vollständiger Name',
    profile_label_email: 'E-Mail',
    profile_label_university: 'Universität',
    profile_label_programme: 'Studiengang',
    profile_label_matrikel: 'Matrikelnummer',
    profile_save_btn: '💾 Änderungen speichern',
    settings_appearance: 'Erscheinungsbild',
    settings_dark_mode: 'Dunkelmodus',
    settings_language: 'Sprache',
    settings_ai_section: 'KI-Assistent',
    settings_auto_open: 'Automatisch bei Textauswahl öffnen',
    settings_save_chat: 'Chatverlauf pro PDF speichern',
    settings_notifications: 'Benachrichtigungen',
    settings_sync_alerts: 'Vorlesungsnotiz-Synchronisierung',
    settings_mail_alerts: 'Neue E-Mail-Benachrichtigungen',
    settings_data: 'Daten',
    settings_clear_chat: 'Gesamten KI-Chatverlauf löschen',
    settings_clear_btn: 'Verlauf löschen',
    settings_account: 'Konto',
    settings_signout: 'Von Minallo abmelden',
    settings_logout_btn: 'Abmelden',
    ln_title: '🎬 Vorlesungsnotizen',
    ln_sync_btn: 'Von Erweiterung synchronisieren',
    sb_subjects: '📚 Fächer',
    sb_timetable: '🗓️ Stundenplan',
    sb_mails: '✉️ E-Mails',
    sb_back: '← Alle Fächer',
    back_btn: '← Zurück',
    welcome_title: 'Datei auswählen',
    welcome_sub:
      'Öffne ein Fach in der Seitenleiste und klicke auf eine Datei — sie wird hier als Dokument angezeigt.',
    welcome_hint: '💡 Markiere Text oder eine Formel → KI fragt automatisch, ob du Hilfe brauchst',
    pdf_fit: 'Anpassen',
    pdf_single: 'Einzelseite',
    pdf_download: '⬇ Herunterladen',
    ai_ready: 'Bereit zu helfen',
    chip_summarise: '✨ Zusammenfassen',
    chip_formulas: '🔢 Formeln',
    chip_quiz: '📝 Quiz',
    chip_keyideas: '💡 Kernideen',
    chip_analogy: '🔗 Analogie',
    depth_label: 'Tiefe:',
    chip_brief: 'Kurz',
    chip_standard: 'Standard',
    chip_thorough: 'Ausführlich',
    level_label: 'Niveau:',
    chip_easy: 'Einfach',
    chip_medium: 'Mittel',
    chip_hard: 'Schwer',
    stop_btn: '⏹ Stopp',
    ai_placeholder: 'Stelle eine Frage zu diesem Dokument…',
    ai_welcome: 'Hey! 👋 Öffne ein PDF, markiere Text oder eine Formel und ich helfe dir!',
    ai_tip_no_pdf: '💡 Tipp: Öffne zuerst ein PDF, damit ich aus dem Dokument antworten kann!',
    ai_file_loaded_post:
      'geladen! Stelle mir beliebige Fragen — ich antworte anhand des Dokuments. 🎓',
    ai_chat_cleared_msg: 'Chat gelöscht! Was möchtest du wissen? 😊',
    chat_restored: '— Chatverlauf wiederhergestellt —',
    no_file_open: 'Keine Datei geöffnet',
    loading_pdf: 'PDF wird geladen…',
    not_in_demo: 'Diese Datei ist in der Demo nicht verfügbar.',
    not_in_demo_multi: 'in der Demo nicht verfügbar',
    download_failed: 'Download fehlgeschlagen.',
    copy_btn: 'Kopieren',
    you_label: 'Du',
    nothing_yet: 'Noch nichts hier',
    studip_subtitle: 'TU Braunschweig · Deine Kurse & Materialien',
    studip_back: '← Portal',
    sd_subjects: '📚 Fächer',
    sd_timetable: '🗓️ Stundenplan',
    sd_mails: '✉️ E-Mails',
    sel_explain: 'Erklären',
    sel_formula: 'Formel aufschlüsseln',
    sel_dismiss: 'Schließen',
    sel_preview: '📌 Du hast ausgewählt:',
    sync_syncing: 'Synchronisiere…',
    sync_synced: 'Synchronisiert ✓',
    sync_no_ext: 'Erweiterung nicht gefunden',
    toast_saved: '💾 In Vorlesungsnotizen gespeichert',
    toast_new_summary_pre: '📝 Neue Zusammenfassung: ',
    toast_tap_view: 'Tippe auf Ansehen um deine Notizen zu öffnen',
    toast_synced_s: 'Notiz synchronisiert',
    toast_synced_p: 'Notizen synchronisiert',
    toast_no_notes: '⚠️ Keine Notizen gefunden',
    toast_summarize_first: 'Fasse zuerst eine Vorlesung in der Erweiterung zusammen',
    toast_sign_in: '⚠️ Anmelden zum Speichern',
    toast_profile_saved: '✅ Profil gespeichert',
    toast_profile_saved_sub: 'In deinem Konto gespeichert',
    toast_save_failed: '❌ Speichern fehlgeschlagen',
    toast_chat_cleared: '🗑️ Chatverlauf gelöscht',
    toast_chat_cleared_sub: 'Alle gespeicherten Chats wurden entfernt',
    toast_settings_saved: '✅ Einstellungen gespeichert',
    toast_settings_saved_sub: 'Deine Einstellungen wurden aktualisiert',
    toast_signed_out: '👋 Abgemeldet',
    toast_signed_out_sub: 'Bis zum nächsten Mal!',
    toast_coming_soon: '🚀 Demnächst',
    toast_coming_soon_sub: 'Zahlungsintegration kommt bald!',
    toast_inactivity: '⏰ Wegen Inaktivität abgemeldet',
    toast_inactivity_sub: 'Melde dich erneut an um fortzufahren',
    err_connection: 'Verbindungsfehler — bitte Seite neu laden',
    err_fill_fields: 'Bitte alle Felder ausfüllen',
    err_confirm_pw: 'Bitte Passwort bestätigen',
    err_pw_mismatch: 'Passwörter stimmen nicht überein',
    err_pw_length: 'Passwort muss mindestens 8 Zeichen haben',
    err_account_created: '✅ Konto erstellt! Prüfe deine E-Mail und klicke den Bestätigungslink.',
    err_confirm_email: '⚠️ Bitte bestätige zuerst deine E-Mail — schau in deinen Posteingang.',
    err_wrong_pw:
      '⚠️ Falsches Passwort — oder hast du dich mit Google angemeldet? Versuche den Google-Button unten oder erstelle ein neues Konto.',
    err_network: 'Netzwerkfehler — überprüfe deine Verbindung.',
    aip_new_chat: 'Neuer Chat',
    aip_chats_label: 'Chats',
    aip_no_chats: 'Noch keine Chats',
    aip_subtitle: 'Womit fangen wir an?',
    aip_landing_ph: 'Frag mich alles…',
    aip_followup_ph: 'Stelle eine Folgefrage…',
    aip_upload_btn: 'Fotos & Dateien hochladen',
  },
};

export function t(key: string): string {
  const lang = localStorage.getItem('ss_lang') || 'en';
  return (translations[lang] || translations.en!)[key] || key;
}

export function applyLanguage(lang: string): void {
  const _lang = lang === 'de' ? 'de' : 'en';
  localStorage.setItem('ss_lang', _lang);
  window._lang = _lang;
  window._t = (key: string): string =>
    (translations[_lang] || translations.en!)[key] || key;
  const tr = translations[_lang]!;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key && tr[key] !== undefined) el.textContent = tr[key]!;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key && tr[key] !== undefined) {
      (el as HTMLInputElement).placeholder = tr[key]!;
    }
  });
  const langSel = document.getElementById('settingsLanguage') as HTMLSelectElement | null;
  if (langSel) langSel.value = _lang;
  if (typeof window._setAuthMode === 'function') {
    window._setAuthMode((window._authMode as 'signin' | 'signup') || 'signin');
  }
  const obSub = document.getElementById('obSub');
  if (obSub) {
    const key = obSub.getAttribute('data-i18n');
    if (key) obSub.textContent = tr[key] || obSub.textContent;
  }
  const ssb = document.getElementById('saveSettingsBtn');
  if (ssb) ssb.textContent = tr.settings_save_btn || ssb.textContent;
  const chipName = document.getElementById('aiFileChipName');
  if (
    chipName &&
    (chipName.textContent === translations.en!.no_file_open ||
      chipName.textContent === translations.de!.no_file_open)
  ) {
    chipName.textContent = tr.no_file_open!;
  }
  const aiFileLabel = document.getElementById('aiFileLabel');
  if (
    aiFileLabel &&
    (aiFileLabel.textContent === translations.en!.ai_ready ||
      aiFileLabel.textContent === translations.de!.ai_ready)
  ) {
    aiFileLabel.textContent = tr.ai_ready!;
  }
  const studipSub = document.getElementById('studipSubtitle');
  if (studipSub) studipSub.textContent = tr.studip_subtitle!;
  const studipBackBtn = document.getElementById('studipBack');
  if (studipBackBtn) studipBackBtn.textContent = tr.studip_back!;
  const sdSubj = document.getElementById('sdSubjectsLabel');
  if (sdSubj) sdSubj.textContent = tr.sd_subjects!;
  const sdTT = document.getElementById('sdTimetableLabel');
  if (sdTT) sdTT.textContent = tr.sd_timetable!;
  const sdMail = document.getElementById('sdMailsLabel');
  if (sdMail) sdMail.textContent = tr.sd_mails!;
  const landingBtn = document.getElementById('landingLangBtn');
  if (landingBtn && typeof window._toggleLandingLang !== 'undefined') {
    landingBtn.textContent = _lang === 'de' ? 'EN' : 'DE';
  }
}
