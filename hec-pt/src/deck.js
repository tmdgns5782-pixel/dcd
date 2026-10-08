// 화면에서 볼 때 슬라이드를 창 폭에 맞춰 축소한다. 인쇄(PDF 저장) 시에는 원래 크기.
(function () {
  var root = document.documentElement;
  function fit() {
    var w = parseFloat(getComputedStyle(root).getPropertyValue('--W')) || 1920;
    var s = Math.min(1, (window.innerWidth - 48) / w);
    root.style.setProperty('--s', s > 0 ? s : 1);
  }
  if (root.classList.contains('static')) return;
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', function () { root.style.setProperty('--s', 1); });
  window.addEventListener('afterprint', fit);
})();
