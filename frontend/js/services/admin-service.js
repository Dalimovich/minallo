function _adminFetch(body) {
    return fetch('/api/admin-users', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (window._sbToken || ''),
        },
        body: JSON.stringify(body),
    });
}
export async function checkAdminStatus() {
    const res = await _adminFetch({ action: 'status' });
    if (!res.ok)
        return null;
    return res.json().catch(() => null);
}
export async function searchUsers(query) {
    const res = await _adminFetch({ action: 'search', query });
    return res.json();
}
export async function setUserPlan(userId, plan) {
    await _adminFetch({ action: 'setplan', userId, plan });
}
export async function reindexUserCourse(userId, courseId, dryRun) {
    const res = await fetch('/api/documents/reindex-course', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (window._sbToken || ''),
        },
        body: JSON.stringify({ userId, courseId, dryRun }),
    });
    return res.json().catch(() => ({ error: 'Bad response' }));
}
//# sourceMappingURL=admin-service.js.map