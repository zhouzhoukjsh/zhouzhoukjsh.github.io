// 移动端菜单开关
(function () {
  const menuBtn = document.getElementById('menuBtn');
  const nav = document.querySelector('.nav');

  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () {
      nav.classList.toggle('is-open');
      menuBtn.classList.toggle('is-open');
    });
  }

  // 页脚年份
  const yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
})();
