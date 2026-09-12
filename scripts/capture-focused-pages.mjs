import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'artifacts', `focused-course-chat-screenshots-${stamp}`);

const css = `
html,body{margin:0;background:#050816;color:#f8fafc;font-family:Inter,Arial,sans-serif}
body{width:1440px;min-height:1000px;overflow:hidden}
.shell{display:grid;grid-template-columns:278px 1fr;min-height:1000px;background:radial-gradient(circle at 70% 30%,rgba(37,99,235,.22),transparent 34%),#070b1a}
.side{margin:38px 0 38px 14px;border-radius:28px;background:#0d1426;border:1px solid rgba(255,255,255,.12);padding:18px 22px;display:flex;flex-direction:column;align-items:center;gap:24px}
.logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:#17366f;font-weight:900;box-shadow:0 0 24px rgba(59,130,246,.45)}
.nav{display:grid;gap:12px;margin-top:8px}.nav div{width:58px;height:58px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);display:grid;place-items:center;color:#94a3b8;font-weight:900}.nav .on{background:rgba(37,99,235,.22);border-color:rgba(96,165,250,.55);color:#fff;box-shadow:0 0 0 2px rgba(59,130,246,.18)}
.main{padding:24px 28px 40px}.top{height:64px;border-bottom:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:space-between;margin:-24px -28px 24px;padding:0 28px;background:rgba(15,23,42,.62)}
button{border:0;border-radius:999px;padding:11px 16px;color:#fff;font-weight:850;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.primary{background:linear-gradient(135deg,#fb7185,#f59e0b)}.study{background:linear-gradient(135deg,#2563eb,#06b6d4)}
.hero{border-radius:26px;padding:30px;background:linear-gradient(135deg,rgba(37,99,235,.24),rgba(15,23,42,.8));border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 80px rgba(0,0,0,.28)}
h1{margin:0 0 10px;font-size:42px;line-height:1.05;letter-spacing:0}p{color:rgba(226,232,240,.75);line-height:1.5}
.progress{margin-top:22px;display:grid;grid-template-columns:170px 1fr;gap:18px;align-items:center}.val{font-size:34px;font-weight:900}.track{height:12px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}.fill{width:58%;height:100%;background:linear-gradient(90deg,#22c55e,#38bdf8)}
.tabs{display:flex;gap:10px;margin:20px 0}.tab{padding:12px 18px;border-radius:14px;background:rgba(255,255,255,.06);color:rgba(226,232,240,.72);border:1px solid rgba(255,255,255,.1);font-weight:850}.tab.on{background:rgba(59,130,246,.24);color:#fff;border-color:rgba(96,165,250,.45)}
.panel{border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:24px;background:rgba(15,23,42,.72);box-shadow:0 22px 70px rgba(0,0,0,.24)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.panel h2{margin:0 0 4px;font-size:28px}.actions{display:flex;gap:10px;flex-wrap:wrap}
.course-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:20px}.course-card{border-radius:22px;padding:22px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);min-height:210px}.course-card h3{font-size:22px;margin:0 0 8px}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}.chip{padding:8px 10px;border-radius:999px;background:rgba(96,165,250,.14);color:#bfdbfe;font-size:13px;font-weight:800}
.files{display:grid;gap:12px}.file{display:grid;grid-template-columns:46px 1fr auto;gap:14px;align-items:center;padding:16px;border-radius:18px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09)}.icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:rgba(96,165,250,.16);color:#93c5fd;font-weight:900}.name{font-size:16px;font-weight:850}.meta{margin-top:4px;color:rgba(226,232,240,.58);font-size:13px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{min-height:230px;border-radius:20px;padding:22px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09)}.card h3{margin:0 0 10px;font-size:21px}.card ul{margin:12px 0 0;padding-left:20px;color:rgba(226,232,240,.78);line-height:1.8}
.chatbot{display:grid;grid-template-columns:270px 1fr 330px;gap:16px;height:850px}.pane{border:1px solid rgba(255,255,255,.1);border-radius:24px;background:rgba(15,23,42,.72);padding:20px;overflow:hidden}.chat-list{display:grid;gap:10px;margin-top:18px}.chat-row{padding:14px;border-radius:16px;background:rgba(255,255,255,.06)}.chat-row.on{background:rgba(59,130,246,.2);border:1px solid rgba(96,165,250,.35)}
.messages{display:flex;flex-direction:column;gap:14px;margin-top:18px}.msg{max-width:72%;padding:14px 16px;border-radius:18px;background:rgba(255,255,255,.08)}.msg.user{align-self:flex-end;background:linear-gradient(135deg,#2563eb,#06b6d4)}.input{margin-top:22px;border-radius:20px;background:rgba(255,255,255,.06);padding:16px;color:rgba(226,232,240,.7)}
.chat-app{display:grid;grid-template-columns:280px 1fr 260px;gap:16px;height:850px}.room{padding:14px;border-radius:16px;background:rgba(255,255,255,.06);margin-top:10px}.member{display:flex;gap:10px;align-items:center;padding:10px 0;color:rgba(226,232,240,.78)}.dot{width:9px;height:9px;border-radius:50%;background:#22c55e}
`;

function shell(inner, active = 'courses') {
  const on = (name) => (name === active ? 'on' : '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
  <div class="shell"><aside class="side"><div class="logo">S</div><div class="nav">
    <div>⌂</div><div class="${on('courses')}">▤</div><div>▣</div><div>✎</div><div class="${on('chatbot')}">AI</div><div class="${on('chat')}">☰</div><div>⚙</div>
  </div></aside><main class="main"><div class="top"><button>← Back</button><button class="study">Study</button></div>${inner}</main></div>
  </body></html>`;
}

function courseHero(activeTab = 'overview') {
  const tabs = ['overview', 'files', 'quiz', 'flashcards']
    .map((t) => `<div class="tab ${t === activeTab ? 'on' : ''}">${t === 'overview' ? 'Overview' : t[0].toUpperCase() + t.slice(1)}</div>`)
    .join('');
  return `<section class="hero"><h1>Screenshot QA Course</h1><p>Manage files, generate quizzes, study flashcards, and open AI or notes inside this course.</p><div class="progress"><div><div class="val">58%</div><p>Study progress</p></div><div class="track"><div class="fill"></div></div></div></section><nav class="tabs">${tabs}</nav>`;
}

const pages = {
  '01-courses-overview.png': shell(`
    <section class="hero"><h1>Courses</h1><p>Organize your semester, upload lecture files, and open AI, notes, or summaries directly from each subject.</p></section>
    <div class="course-grid">
      <article class="course-card"><h3>Screenshot QA Course</h3><p>Deterministic screenshot course</p><div class="chips"><span class="chip">2 files</span><span class="chip">Quiz ready</span><span class="chip">Flashcards</span></div></article>
      <article class="course-card"><h3>Mechanics I</h3><p>Forces, equilibrium, beams, and moments.</p><div class="chips"><span class="chip">8 files</span><span class="chip">4 notes</span></div></article>
      <article class="course-card"><h3>Linear Algebra</h3><p>Matrices, eigenvalues, and vector spaces.</p><div class="chips"><span class="chip">6 files</span><span class="chip">Review</span></div></article>
    </div>`),
  '02-course-files.png': shell(`${courseHero('files')}<section class="panel"><div class="panel-head"><div><h2>Files</h2><p>Organized lecture material ready for AI, notes, quiz, and flashcard generation.</p></div><div class="actions"><button>Select multiple</button><button>New folder</button><button class="primary">Upload files</button></div></div><div class="files"><div class="file"><div class="icon">PDF</div><div><div class="name">sample-lecture.pdf</div><div class="meta">24 KB · Uploaded Today · AI indexed</div></div><button>Open</button></div><div class="file"><div class="icon">PDF</div><div><div class="name">exercise-sheet-01.pdf</div><div class="meta">18 KB · Uploaded Today · AI indexed</div></div><button>Open</button></div></div></section>`),
  '03-course-quiz.png': shell(`${courseHero('quiz')}<section class="panel"><div class="panel-head"><div><h2>Quiz</h2><p>Practice exam-style questions generated from the indexed course files.</p></div><button class="primary">Generate quiz</button></div><div class="cols"><div class="card"><h3>Ready Topics</h3><ul><li>Free-body diagrams</li><li>Equilibrium equations</li><li>Moment balance</li></ul></div><div class="card"><h3>Suggested Question</h3><p>A beam is supported at two points and loaded at an angle. Which equations solve the support reactions?</p></div></div></section>`),
  '04-course-flashcards.png': shell(`${courseHero('flashcards')}<section class="panel"><div class="panel-head"><div><h2>Flashcards</h2><p>Turn lecture concepts and formulas into spaced-repetition cards.</p></div><button class="primary">Generate cards</button></div><div class="cols"><div class="card"><h3>Select a deck</h3><p>Mechanics basics · 18 cards · recently studied</p></div><div class="card"><h3>Preview</h3><p><strong>Front:</strong> What is required for static equilibrium?</p><p><strong>Back:</strong> Sum of forces and moments must equal zero.</p></div></div></section>`),
  '05-chatbot.png': shell(`<div class="chatbot"><aside class="pane"><h2>Chats</h2><button class="primary">New chat</button><div class="chat-list"><div class="chat-row on">Mechanics tutor<br><small>2 messages</small></div><div class="chat-row">Lecture summary<br><small>Yesterday</small></div></div></aside><section class="pane"><h1>Minallo AI Tutor</h1><p>Ask questions, solve exercises, summarize lectures, or generate notes.</p><div class="messages"><div class="msg user">Explain exercise 6 using my lecture notes.</div><div class="msg">Start with a free-body diagram, split every angled force into components, then apply equilibrium equations.</div></div><div class="input">Ask anything about your course...</div></section><aside class="pane"><h2>Study panel</h2><div class="tabs"><span class="tab on">Files</span><span class="tab">Sources</span><span class="tab">Notes</span></div><p>sample-lecture.pdf attached</p><button>Import course file</button></aside></div>`, 'chatbot'),
  '06-chat.png': shell(`<div class="chat-app"><aside class="pane"><h2>Rooms</h2><div class="room"># mechanics-study</div><div class="room"># exam-prep</div><div class="room"># general</div></aside><section class="pane"><h1># mechanics-study</h1><p>Course discussion, pinned resources, and study-group messages.</p><div class="messages"><div class="msg">Mina: Does anyone have the formula sheet?</div><div class="msg user">I uploaded it to the course folder.</div><div class="msg">Alex: Nice, I’ll generate flashcards from it.</div></div><div class="input">Message #mechanics-study</div></section><aside class="pane"><h2>Members</h2><div class="member"><span class="dot"></span> Mina</div><div class="member"><span class="dot"></span> Alex</div><div class="member"><span class="dot"></span> Screenshot User</div></aside></div>`, 'chat')
};

await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
for (const [name, html] of Object.entries(pages)) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(outDir, name), fullPage: false });
  console.log(path.join(outDir, name));
}
await browser.close();

const links = Object.keys(pages)
  .map((name) => `<a href="${name}"><figure><img src="${name}"><figcaption>${name}</figcaption></figure></a>`)
  .join('\n');
await fs.writeFile(
  path.join(outDir, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Focused screenshots</title><style>body{margin:0;background:#10131a;color:#fff;font-family:Arial,sans-serif}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:20px;padding:24px}figure{margin:0;background:#181c25;border:1px solid rgba(255,255,255,.14);border-radius:8px;overflow:hidden}img{width:100%;height:260px;object-fit:cover;object-position:top left;display:block}figcaption{padding:12px 14px;color:#d8deea}a{color:inherit;text-decoration:none}h1{padding:18px 24px;margin:0;border-bottom:1px solid rgba(255,255,255,.12)}</style></head><body><h1>Focused Screenshots</h1><main>${links}</main></body></html>`
);
console.log(`SCREENSHOT_DIR=${outDir}`);
