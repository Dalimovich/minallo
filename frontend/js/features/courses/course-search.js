export function initCourseSearch(context) {
    const inp = document.getElementById('courseSearchInput');
    const drop = document.getElementById('courseSearchDrop');
    const addBtn = document.getElementById('courseAddBtn');
    if (!inp || !drop || !addBtn)
        return;
    let selectedSubject = null;
    function getDropBg() {
        return document.body.classList.contains('night')
            ? 'rgba(13,20,40,.97)'
            : 'rgba(240,245,255,.98)';
    }
    function showDrop(items) {
        if (!items.length) {
            drop.style.display = 'none';
            return;
        }
        drop.style.background = getDropBg();
        drop.innerHTML = '';
        items.forEach((s) => {
            const opt = document.createElement('div');
            opt.textContent = s.name;
            opt.style.cssText =
                'padding:9px 14px;cursor:pointer;font-size:.88rem;border-bottom:1px solid rgba(37,99,235,.1);color:inherit';
            opt.addEventListener('mouseenter', () => {
                opt.style.background = 'rgba(37,99,235,.12)';
            });
            opt.addEventListener('mouseleave', () => {
                opt.style.background = '';
            });
            opt.addEventListener('mousedown', (e) => {
                e.preventDefault();
                selectedSubject = s;
                inp.value = s.name;
                drop.style.display = 'none';
            });
            drop.appendChild(opt);
        });
        drop.style.display = 'block';
    }
    inp.addEventListener('input', () => {
        selectedSubject = null;
        const q = inp.value.trim().toLowerCase();
        if (!q) {
            drop.style.display = 'none';
            return;
        }
        const userMajor = context.getUserMajor();
        const userVertiefung = context.getUserVertiefung();
        const subjectList = context.getSubjectList();
        const isMB = !userMajor || userMajor === 'Maschinenbau';
        const isET = userMajor === 'Elektrotechnik und Informationstechnik';
        let matches;
        if (isMB) {
            matches = subjectList.filter((s) => {
                const inCat = s.cat === 'grundlagen' || s.cat === userVertiefung;
                return inCat && s.name.toLowerCase().includes(q);
            });
        }
        else if (isET) {
            matches = subjectList.filter((s) => {
                const inCat = s.cat === 'et-grundlagen' || s.cat === userVertiefung;
                return inCat && s.name.toLowerCase().includes(q);
            });
        }
        else {
            const primary = subjectList.filter((s) => s.cat === userMajor && s.name.toLowerCase().includes(q));
            const secondary = subjectList.filter((s) => s.cat !== userMajor && s.name.toLowerCase().includes(q));
            matches = primary.concat(secondary);
        }
        showDrop(matches.slice(0, 10));
    });
    inp.addEventListener('blur', () => {
        setTimeout(() => {
            drop.style.display = 'none';
        }, 150);
    });
    function addCourse() {
        const name = inp.value.trim();
        if (!name)
            return;
        const subject = selectedSubject || { name, short: name.slice(0, 8) };
        const sems = context.getSems();
        const sem = sems[context.getActiveSemesterId()];
        if (!sem)
            return;
        if (sem.courses.find((c) => c.name.toLowerCase() === subject.name.toLowerCase())) {
            inp.value = '';
            selectedSubject = null;
            drop.style.display = 'none';
            return;
        }
        sem.courses.push({
            id: 'uc_' + Date.now(),
            name: subject.name,
            short: subject.short,
            meta: '',
            files: [],
        });
        context.saveUserCourses();
        context.renderCourses();
        inp.value = '';
        selectedSubject = null;
        drop.style.display = 'none';
    }
    addBtn.addEventListener('click', addCourse);
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            addCourse();
    });
}
//# sourceMappingURL=course-search.js.map