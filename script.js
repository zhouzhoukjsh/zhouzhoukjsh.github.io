// 搜索框交互
document.addEventListener('DOMContentLoaded', function() {
    const searchIcon = document.getElementById('searchIcon');
    const searchBox = document.getElementById('searchBox');
    const searchInput = document.getElementById('searchInput');

    searchIcon.addEventListener('click', function(e) {
        e.stopPropagation();
        if (searchBox.style.display === 'block') {
            searchBox.style.display = 'none';
        } else {
            searchBox.style.display = 'block';
            setTimeout(() => searchInput.focus(), 50);
        }
    });

    // 点击页面其他地方隐藏搜索框
    document.addEventListener('click', function(e) {
        if (!searchIcon.contains(e.target) && !searchBox.contains(e.target)) {
            searchBox.style.display = 'none';
        }
    });

    // 回车搜索（示例）
    searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && this.value.trim()) {
            alert(`搜索: ${this.value}`);
            searchBox.style.display = 'none';
        }
    });
});