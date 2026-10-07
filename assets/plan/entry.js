/*
 * Hidden entry to /plan/: two quick clicks (or taps) on the sidebar avatar.
 * Counts clicks itself instead of using dblclick, which phones handle inconsistently.
 */
(function () {
  "use strict";

  // Forget an expired "remember this device" record (see plan-remember.js),
  // even if /plan/ is never opened again.
  try {
    var exp = Number(localStorage.getItem("pq-remember-exp"));
    if (exp && !(exp > Date.now() && exp - Date.now() <= 24 * 60 * 60 * 1000)) {
      localStorage.removeItem("pq-remember-exp");
      indexedDB.deleteDatabase("plan-remember");
    }
  } catch (e) { /* storage blocked */ }

  var DOUBLE_MS = 400;
  var target = document.currentScript && document.currentScript.dataset.target;
  var img = document.querySelector(".author__avatar img");
  if (!img || !target) return;

  // Stop a double tap from zooming the page or selecting the image.
  img.style.touchAction = "manipulation";
  img.style.userSelect = "none";
  img.style.webkitUserSelect = "none";

  var last = 0;
  img.addEventListener("click", function () {
    var now = Date.now();
    if (now - last < DOUBLE_MS) {
      last = 0;
      window.location.href = target;
    } else {
      last = now;
    }
  });
})();
