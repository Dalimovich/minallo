// Sets body[data-ss-ready="1"] when the app signals it's mounted.
// CSS uses this to hide #ss-splash. Lives in an external file because
// CSP blocks inline scripts.
window.addEventListener('ss-ready', function () {
  document.body.setAttribute('data-ss-ready', '1');
});
