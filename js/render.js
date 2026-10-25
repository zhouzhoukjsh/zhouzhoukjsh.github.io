// 前台数据读取与渲染
// 索引只存 id / 标题 / 日期（很小），正文与图片在详情页才加载
const DATA = {
  videos: 'data/videos.json',
  articles: 'data/articles.json',
  post: id => 'data/posts/' + encodeURIComponent(id) + '.json'
};

function bust(url) {
  return url + (url.indexOf('?') > -1 ? '&' : '?') + 't=' + Date.now();
}

async function fetchJSON(url) {
  try {
    const res = await fetch(bust(url), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('读取失败:', url, e);
    return null;
  }
}

async function loadJSON(url) {
  const data = await fetchJSON(url);
  return data && Array.isArray(data.items) ? data.items : [];
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
  if (!ul) return;
  ul.innerHTML = '';
  if (!items.length) {
    for (let i = 0; i < 3; i++) ul.appendChild(emptyRow('无'));
    return;
  }
  items.forEach(it => ul.appendChild(postRow(it, hrefOf(it))));
}

const idOf = name => new URLSearchParams(location.search).get(name);

// 取单篇内容：优先读独立详情文件，老数据回退到索引里的内嵌正文
async function loadPost(kind, id) {
  if (kind === 'videos') {
    const list = await loadJSON(DATA.videos);
    return list.find(x => String(x.id) === String(id)) || null;
  }
  const post = await fetchJSON(DATA.post(id));
  if (post && post.title) return post;

  // 兼容早期把正文塞在索引里的数据
  const list = await loadJSON(DATA.articles);
  return list.find(x => String(x.id) === String(id)) || null;
}

// 详情页渲染
async function renderDetail(kind) {
  const box = document.getElementById('detail');
  if (!box) return;

  const id = idOf('id');
  if (!id) {
    box.innerHTML = '<p class="detail-empty">没有指定内容。</p>';
    return;
  }

  const item = await loadPost(kind, id);
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
    // 正文开头的一级标题若与文章标题重复，去掉一个
    const first = body.firstElementChild;
    if (first && first.tagName === 'H1' &&
        first.textContent.trim() === item.title.trim()) {
      first.remove();
    }
    box.appendChild(body);
  }

  if (item.docPath) {
    const p = document.createElement('p');
    p.className = 'doc-download';
    p.innerHTML = '<a href="' + item.docPath + '" target="_blank" rel="noopener" download>下载 Word 原文件</a>';
    box.appendChild(p);
  }
}
