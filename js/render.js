// 前台数据读取与渲染
const DATA = {
  videos: 'data/videos.json',
  articles: 'data/articles.json'
};

async function loadJSON(url) {
  try {
    const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    console.warn('读取失败:', url, e);
    return [];
  }
}

function byDateDesc(list) {
  return list.slice().sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da === db) return (b.id || 0) - (a.id || 0);
    return db.localeCompare(da);
  });
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'post-item';
  const span = document.createElement('span');
  span.className = 'post-title';
  span.textContent = text || '无';
  li.appendChild(span);
  return li;
}

function postRow(item, href) {
  const li = document.createElement('li');
  li.className = 'post-item';
  const a = document.createElement('a');
  a.className = 'post-link';
  a.href = href;
  const t = document.createElement('span');
  t.className = 'post-title';
  t.textContent = item.title;
  const d = document.createElement('span');
  d.className = 'post-date';
  d.textContent = item.date || '';
  a.appendChild(t);
  a.appendChild(d);
  li.appendChild(a);
  return li;
}

// 填充列表：items 有数据就渲染，否则填 3 行「无」
function fillList(ul, items, hrefOf) {
  ul.innerHTML = '';
  if (!items.length) {
    for (let i = 0; i < 3; i++) ul.appendChild(emptyRow('无'));
    return;
  }
  items.forEach(it => ul.appendChild(postRow(it, hrefOf(it))));
}

const idOf = name => new URLSearchParams(location.search).get(name);

// 详情页渲染
function renderDetail(kind) {
  const box = document.getElementById('detail');
  if (!box) return;
  const id = idOf('id');
  loadJSON(DATA[kind]).then(list => {
    const item = list.find(x => String(x.id) === String(id));
    if (!item) {
      box.innerHTML = '<p class="detail-empty">没有找到这篇内容，可能已被删除。</p>';
      return;
    }
    document.title = item.title + ' - 舟舟博客';

    const h1 = document.createElement('h1');
    h1.className = 'detail-title';
    h1.textContent = item.title;
    box.appendChild(h1);

    const meta = document.createElement('p');
    meta.className = 'detail-meta';
    meta.textContent = item.date || '';
    box.appendChild(meta);

    if (item.iframe) {
      const wrap = document.createElement('div');
      wrap.className = 'video-wrap';
      wrap.innerHTML = item.iframe;
      box.appendChild(wrap);
    }

    if (item.content) {
      const body = document.createElement('div');
      body.className = 'doc-body';
      body.innerHTML = item.content;
      box.appendChild(body);
    }

    if (item.docPath) {
      const p = document.createElement('p');
      p.className = 'doc-download';
      p.innerHTML = '<a href="' + item.docPath + '" target="_blank" rel="noopener" download>下载 Word 原文件</a>';
      box.appendChild(p);
    }
  });
}
