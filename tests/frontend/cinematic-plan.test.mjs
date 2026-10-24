import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan } from '../../frontend/js/pages/cinematic/plan.js';

test('starter plans use every answer and allocate exactly the available time', () => {
  for (const path of ['student', 'german']) {
    for (const challenge of ['understand', 'practice', 'organize']) {
      for (const duration of ['20', '45', '90']) {
        const plan = createPlan({ path, subject: ' My goal ', challenge, duration, deadline: '7' });
        assert.equal(plan.title, 'Your My goal starting path');
        assert.equal(
          plan.tasks.reduce((sum, [, time]) => sum + time, 0),
          Number(duration)
        );
        assert.ok(plan.tasks.every(([task, time]) => task && time > 0));
        assert.match(plan.description, /week or less/);
      }
    }
  }
  const input = { subject: 'B1', challenge: 'understand', duration: '45', path: 'german' };
  assert.match(createPlan({ ...input, deadline: '21' }).description, /three weeks/);
  assert.match(createPlan({ ...input, deadline: '60' }).description, /more time/);
  assert.match(createPlan({ ...input, deadline: '7' }).tasks[0][0], /grammar/);
});
