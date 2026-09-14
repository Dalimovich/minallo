import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Authenticated real-app smoke test for the new Hören (listening) workspace
 * (see practice.js's Hören IIFE). Runs through the actual login flow and the
 * real German Practice UI entry points — a lighter local harness already
 * verified the JS logic directly, but this proves the real portal shell
 * wires the new dedicated view, CSS bundle, and (critically) the shared
 * navigation teardown together end to end.
 *
 * The real, primary entry point for every German skill (confirmed by
 * reading chatbot.html) is the "Learning panel" in the right-side chatbot
 * panel: buttons like [data-testid="german-panel-listening"] with
 * data-workspace-skill="listening", handled by experience-mode.ts's
 * transitionLearnerWorkspace(). This deep-links straight into the skill,
 * bypassing the #glHome skill grid entirely — so this test uses that path
 * rather than #glHome's skill cards, which are a secondary/consistency
 * entry point (every other skill has one too) but not how a real learner
 * normally gets here.
 *
 * SpeechSynthesis is stubbed (Chromium under Playwright can throw
 * "parameter 1 is not of type SpeechSynthesisUtterance" against the native
 * implementation in headless mode, and real TTS audio can't be asserted on
 * anyway) — the stub lets us assert on *when* speech is invoked/stopped
 * without depending on real OS voices being installed in CI.
 */
async function switchToLearner(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
    w._userType = 'learner';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

async function stubSpeechSynthesis(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as unknown as { __speakCalls: string[] }).__speakCalls = [];
    (window as unknown as { __cancelCalls: number }).__cancelCalls = 0;
    function FakeUtterance(this: Record<string, unknown>, text: string) {
      this.text = text;
      this.lang = '';
      this.voice = null;
      this.rate = 1;
      this.onend = null;
      this.onerror = null;
    }
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [
          { name: 'Anna', lang: 'de-DE', localService: true },
          { name: 'Google Deutsch', lang: 'de-DE', localService: false },
        ],
        addEventListener() {},
        speak(u: { text: string; onend?: () => void }) {
          (window as unknown as { __speakCalls: string[] }).__speakCalls.push(u.text);
          setTimeout(() => { if (u.onend) u.onend(); }, 10);
        },
        cancel() { (window as unknown as { __cancelCalls: number }).__cancelCalls++; },
        pause() {},
        resume() {},
      },
    });
  });
}

test.describe('Hören listening workspace (authenticated)', () => {
  test('full session flow: play, wrong answer, evidence replay, transcript, weak-area retry, teardown on leave', async ({ page }) => {
    test.setTimeout(90000);
    await mockAiEndpoints(page, 'success');
    await stubSpeechSynthesis(page);

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await app.navigateTo('chatbot');

    // Real primary entry point: the Learning panel's "Hören" link.
    const listenPanelLink = page.locator('[data-testid="german-panel-listening"]');
    await expect(listenPanelLink).toBeVisible();
    await listenPanelLink.click();

    const listenView = page.locator('#glListeningView');
    await expect(listenView).toBeVisible();
    await expect(page.locator('#glReadingView')).toBeHidden();
    await expect(page.locator('#glGrammarView')).toBeHidden();
    await expect(page.locator('#glVocabularyView')).toBeHidden();

    // No internal Home/Back button inside the dedicated view itself (the
    // shell-level "Home" button lives outside #glListeningView, in the
    // shared #glSkillView chrome).
    await expect(
      listenView.locator('button:has-text("Back"), button:has-text("Home")')
    ).toHaveCount(0);

    // Transcript hidden by default.
    await expect(page.locator('.gl-listen-transcript-box')).toHaveCount(0);

    // Play full recording, then pause/resume, then change speed.
    await page.click('#glListenPlayBtn');
    await page.waitForFunction(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length > 0);
    await expect(page.locator('#glListenPlayBtn')).toHaveAttribute('aria-label', 'Pause audio');
    await page.click('#glListenPlayBtn'); // pause
    await expect(page.locator('#glListenPlayBtn')).toHaveAttribute('aria-label', 'Play audio');
    await page.click('#glListenPlayBtn'); // resume
    await page.click('.gl-listen-speed[data-speed="1.25"]');
    await expect(page.locator('.gl-listen-speed[data-speed="1.25"]')).toHaveClass(/active/);

    // Answer Q1 (main-idea) WRONG on purpose to exercise the tightened
    // transcript-gating flow: Wrong -> Replay evidence -> Try again -> ... -> transcript.
    await page.click('#glListenTaskPanel .gl-listen-option[data-opt="A"]');
    await page.click('#glListenCheckBtn');
    await expect(page.locator('.gl-listen-feedback-title')).toHaveText('Not quite.');
    // Transcript must NOT be offered yet after only one wrong attempt.
    await expect(page.locator('#glListenTranscriptBtn')).toHaveCount(0);

    const speakCountBeforeReplay = await page.evaluate(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length);
    await page.click('#glListenReplayEvidenceBtn');
    await page.waitForFunction(
      (n) => (window as unknown as { __speakCalls: string[] }).__speakCalls.length > n,
      speakCountBeforeReplay
    );

    await page.click('#glListenRetryBtn');
    // Second attempt, correct this time.
    await page.click('#glListenTaskPanel .gl-listen-option[data-opt="B"]');
    await page.click('#glListenCheckBtn');
    await expect(page.locator('#glListenTranscriptBtn')).toBeVisible();
    await page.click('#glListenTranscriptBtn');
    await expect(page.locator('.gl-listen-transcript-box')).toBeVisible();

    // Walk to the end of the session.
    for (let i = 0; i < 10; i++) {
      const nextBtn = page.locator('#glListenNextQBtn');
      if (!(await nextBtn.isVisible().catch(() => false))) break;
      const label = await nextBtn.innerText();
      await nextBtn.click();
      if (label === 'Finish') break;
    }
    await expect(page.locator('#glListenEnd')).toBeVisible();
    await expect(page.locator('.gl-listen-end-score')).toBeVisible();

    // "Practice weak areas" starts a new session rather than replaying the same one.
    const weakBtn = page.locator('#glListenWeakBtn');
    if (await weakBtn.isVisible().catch(() => false)) {
      await weakBtn.click();
      await expect(page.locator('#glListenPractice')).toBeVisible();
      await expect(page.locator('#glListenEnd')).toBeHidden();
    }

    // Hören -> Grammatik via the Learning panel (staying inside the practice
    // workspace, switching skill): must go through practice.js's
    // window._glOpenSkill, whose top-of-function teardown hook stops audio.
    await page.click('#glListenPlayBtn');
    await page.waitForFunction(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length > 0);
    const cancelCountBeforeSwitch = await page.evaluate(() => (window as unknown as { __cancelCalls: number }).__cancelCalls);
    await page.locator('[data-testid="german-panel-grammar"]').click();
    await expect(page.locator('#glGrammarView')).toBeVisible();
    await expect(listenView).toBeHidden();
    const cancelCountAfterSwitch = await page.evaluate(() => (window as unknown as { __cancelCalls: number }).__cancelCalls);
    expect(cancelCountAfterSwitch).toBeGreaterThan(cancelCountBeforeSwitch);

    // Back to Hören via the panel, then leave the practice workspace
    // entirely via the shell's "Home" button (relabeled by
    // experience-mode.ts, which calls transitionLearnerWorkspace('chat')
    // directly via a capturing listener that bypasses
    // window._glBackToHome — this is the path the shell-level teardown fix
    // added alongside this feature specifically covers).
    await page.locator('[data-testid="german-panel-listening"]').click();
    await expect(listenView).toBeVisible();
    await page.click('#glListenPlayBtn');
    await page.waitForFunction(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length > 0);
    const cancelCountBeforeHome = await page.evaluate(() => (window as unknown as { __cancelCalls: number }).__cancelCalls);
    await page.click('#glBackBtn');
    await expect(listenView).toBeHidden();
    const cancelCountAfterHome = await page.evaluate(() => (window as unknown as { __cancelCalls: number }).__cancelCalls);
    expect(cancelCountAfterHome).toBeGreaterThan(cancelCountBeforeHome);

    // Return to Hören: session persists (still on the same question/segment
    // position) but audio stays paused — no new speak call fires on its own.
    const speakCountBeforeReturn = await page.evaluate(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length);
    await page.locator('[data-testid="german-panel-listening"]').click();
    await expect(listenView).toBeVisible();
    await page.waitForTimeout(300);
    const speakCountAfterReturn = await page.evaluate(() => (window as unknown as { __speakCalls: string[] }).__speakCalls.length);
    expect(speakCountAfterReturn).toBe(speakCountBeforeReturn);
    await expect(page.locator('#glListenPlayBtn')).toHaveAttribute('aria-label', 'Play audio');
  });
});
