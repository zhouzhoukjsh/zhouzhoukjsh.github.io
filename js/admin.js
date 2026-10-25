// ========== 后台逻辑：通过 GitHub Contents API 读写数据 ==========

const CFG_KEY = 'zzblog_cfg';

const state = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
  videosSha: null,
  articlesSha: null,
  videos: [],
  articles: []
};

// ---------- 工具 ----------
const $ = id => document.getElementById(id);

function setMsg(el, text, type) {
  el.textContent = text || '';
  el.className = 'admin-msg' + (type ? ' ' + type : '');
}

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// UTF-8 安全 base64
function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function b64Decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------- GitHub API ----------
function apiUrl(path) {
  return 'https://api.github.com/repos/' + state.owner + '/' + state.repo + '/contents/' + path;
}

async function ghGet(path) {
  const res = await fetch(apiUrl(path) + '?ref=' + encodeURIComponent(state.branch), {
    headers: {
      Authorization: 'Bearer ' + state.token,
      Accept: 'application/vnd.github+json'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error('读取 ' + path + ' 失败：HTTP ' + res.status + ' ' + t.slice(0, 200));
  }
  return res.json();
}

async function ghPut(path, contentB64, message, sha) {
  const body = {
    message: message,
    content: contentB64,
    branch: state.branch
  };
  if (sha) body.sha = sha;

  const res = await fetch(apiUrl(path), {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + state.token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('提交 ' + path + ' 失败：HTTP ' + res.status + ' ' + t.slice(0, 300));
  }
  return res.json();
}

async function ghDelete(path, message, sha) {
  const res = await fetch(apiUrl(path), {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer ' + state.token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: message, sha: sha, branch: state.branch })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('删除 ' + path + ' 失败：HTTP ' + res.status + ' ' + t.slice(0, 300));
  }
  return res.json();
}

// ---------- 数据读写 ----------
async function loadData() {
  const v = await ghGet('data/videos.json');
  state.videosSha = v ? v.sha : null;
  state.videos = v ? (JSON.parse(b64Decode(v.content)).items || []) : [];

  const a = await ghGet('data/articles.json');
  state.articlesSha = a ? a.sha : null;
  state.articles = a ? (JSON.parse(b64Decode(a.content)).items || []) : [];

  await migrateLegacy();
}

// 早期版本把正文（含 base64 图片）直接塞在索引里。
// 这里把它拆成：图片 → docs/images/，正文 → data/posts/<id>.json，索引只留标题日期。
async function migrateLegacy() {
  const legacy = state.articles.filter(it => it.content || it.iframe);
  if (!legacy.length) return;

  setMsg($('loginMsg'), '正在整理历史数据，共 ' + legacy.length + ' 篇…');

  for (const it of legacy) {
    const exists = await ghGet('data/posts/' + it.id + '.json');
    if (exists) continue;

    let content = it.content || '';
    const images = extractInlineImages(content);
    const imgPaths = [];
    for (let i = 0; i < images.length; i++) {
      const p = 'docs/images/' + it.id + '_' + (i + 1) + '.' + images[i].ext;
      await ghPut(p, images[i].b64, '整理历史图片：' + it.title, null);
      imgPaths.push(p);
      content = content.split(images[i].full).join(p);
    }

    await savePost({
      id: it.id,
      title: it.title,
      date: it.date,
      docPath: it.docPath || '',
      images: imgPaths,
      content: content
    });

    // 迁移完把内存里的老字段清掉，避免再次迁移
    delete it.content;
    delete it.iframe;
    delete it.docPath;
    delete it.images;
  }

  await saveArticles();
  setMsg($('loginMsg'), '历史数据已整理完成');
}

async function saveVideos() {
  const json = JSON.stringify({ items: state.videos }, null, 2);
  const res = await ghPut('data/videos.json', b64Encode(json), '后台更新视频教程', state.videosSha);
  state.videosSha = res.content.sha;
}

async function saveArticles() {
  // 索引只保留轻量字段，正文写到 data/posts/<id>.json
  const index = state.articles.map(it => ({
    id: it.id,
    title: it.title,
    date: it.date
  }));
  const json = JSON.stringify({ items: index }, null, 2);
  const res = await ghPut('data/articles.json', b64Encode(json), '后台更新图文教程索引', state.articlesSha);
  state.articlesSha = res.content.sha;
}

// 写入单篇正文
async function savePost(item) {
  const json = JSON.stringify(item, null, 2);
  await ghPut('data/posts/' + item.id + '.json', b64Encode(json), '发布图文：' + item.title, null);
}

// 删除单篇正文（不存在则忽略）
async function deletePost(id) {
  const path = 'data/posts/' + id + '.json';
  const f = await ghGet(path);
  if (!f) return;
  await ghDelete(path, '删除图文：' + id, f.sha);
}

// ---------- 渲染已有列表 ----------
function renderAdminList(ul, items, kind) {
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'admin-empty';
    li.textContent = '暂无内容';
    ul.appendChild(li);
    return;
  }
  items.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(it => {
    const li = document.createElement('li');
    li.className = 'admin-item';

    const info = document.createElement('div');
    info.className = 'admin-item-info';
    const t = document.createElement('span');
    t.className = 'admin-item-title';
    t.textContent = it.title;
    const d = document.createElement('span');
    d.className = 'admin-item-date';
    d.textContent = it.date || '';
    info.appendChild(t);
    info.appendChild(d);

    const del = document.createElement('button');
    del.className = 'btn btn-danger btn-sm';
    del.textContent = '删除';
    del.addEventListener('click', () => handleDelete(kind, it));

    li.appendChild(info);
    li.appendChild(del);
    ul.appendChild(li);
  });
}

async function handleDelete(kind, item) {
  if (!confirm('确定删除「' + item.title + '」吗？此操作会直接提交到仓库。')) return;
  const list = kind === 'video' ? state.videos : state.articles;
  const idx = list.findIndex(x => x.id === item.id);
  if (idx === -1) return;
  list.splice(idx, 1);
  try {
    if (kind === 'video') {
      await saveVideos();
    } else {
      await deletePost(item.id);
      await saveArticles();
    }
    refreshLists();
    setMsg(kind === 'video' ? $('videoMsg') : $('articleMsg'), '已删除', 'ok');
  } catch (e) {
    setMsg(kind === 'video' ? $('videoMsg') : $('articleMsg'), e.message, 'err');
  }
}

function refreshLists() {
  renderAdminList($('videoList'), state.videos, 'video');
  renderAdminList($('articleList'), state.articles, 'article');
}

// ---------- 视频教程 ----------
function extractIframe(html) {
  const m = html.match(/<iframe[\s\S]*?<\/iframe>/i);
  return m ? m[0] : '';
}

async function addVideo() {
  const title = $('videoTitle').value.trim();
  const rawIframe = $('videoIframe').value.trim();
  const date = $('videoDate').value || today();

  if (!title) { setMsg($('videoMsg'), '请填写标题', 'err'); return; }
  const iframe = extractIframe(rawIframe);
  if (!iframe) { setMsg($('videoMsg'), '没有识别到 iframe 代码，请粘贴完整的嵌入代码', 'err'); return; }

  const btn = $('addVideoBtn');
  btn.disabled = true;
  setMsg($('videoMsg'), '正在提交到 GitHub…');
  try {
    state.videos.push({
      id: Date.now(),
      title: title,
      date: date,
      iframe: iframe
    });
    await saveVideos();
    $('videoTitle').value = '';
    $('videoIframe').value = '';
    $('videoDate').value = '';
    refreshLists();
    setMsg($('videoMsg'), '发布成功，站点约 1 分钟后生效', 'ok');
  } catch (e) {
    state.videos.pop();
    setMsg($('videoMsg'), e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 图文教程 ----------
function safeName(name) {
  return name.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
}

// 从 HTML 中提取 base64 内嵌图片
function extractInlineImages(html) {
  const regex = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/g;
  const found = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    found.push({
      full: m[0],
      ext: ext,
      b64: m[2].replace(/\s/g, '')
    });
  }
  return found;
}

// 去掉标签后统计正文字数
function textLength(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s/g, '').length;
}

async function addArticle() {
  const titleInput = $('articleTitle').value.trim();
  const file = $('articleFile').files[0];
  const date = $('articleDate').value || today();

  if (!file) { setMsg($('articleMsg'), '请选择 Word 文档', 'err'); return; }
  if (!/\.docx$/i.test(file.name)) {
    setMsg($('articleMsg'), '只支持 .docx 文件，请在 Word 里另存为 .docx', 'err');
    return;
  }

  const btn = $('addArticleBtn');
  btn.disabled = true;
  setMsg($('articleMsg'), '正在解析 Word…');

  let newItem = null;
  const uploadedPaths = [];
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
    let content = result.value;

    const baseName = file.name.replace(/\.docx$/i, '');
    const title = titleInput || baseName;
    const stamp = Date.now();

    // 1. 统计正文与图片（仅用于提示，不做限制）
    const chars = textLength(content);
    const images = extractInlineImages(content);

    // 2. 逐张上传图片，替换正文中的 base64
    for (let i = 0; i < images.length; i++) {
      setMsg($('articleMsg'), '正在上传图片 ' + (i + 1) + ' / ' + images.length + '…');
      const imgPath = 'docs/images/' + stamp + '_' + (i + 1) + '.' + images[i].ext;
      await ghPut(imgPath, images[i].b64, '上传图文图片：' + title, null);
      uploadedPaths.push(imgPath);
      content = content.split(images[i].full).join(imgPath);
    }

    // 3. 上传 Word 原文件
    setMsg($('articleMsg'), '正在上传 Word 文件…');
    const docName = 'docs/' + stamp + '_' + safeName(file.name);
    const binB64 = arrayBufferToBase64(arrayBuffer);
    await ghPut(docName, binB64, '上传 Word：' + file.name, null);
    uploadedPaths.push(docName);

    // 4. 保存：正文单独成文件，索引只存标题日期
    setMsg($('articleMsg'), '正在保存教程…');
    newItem = {
      id: stamp,
      title: title,
      date: date,
      docPath: docName,
      images: uploadedPaths.filter(p => p.startsWith('docs/images/')),
      content: content
    };
    await savePost(newItem);
    state.articles.push(newItem);
    await saveArticles();

    $('articleTitle').value = '';
    $('articleFile').value = '';
    $('articleDate').value = '';
    refreshLists();
    setMsg($('articleMsg'), '发布成功：' + chars + ' 字、' + images.length + ' 张图。站点约 1 分钟后生效', 'ok');
  } catch (e) {
    if (newItem) {
      const i = state.articles.findIndex(x => x.id === newItem.id);
      if (i > -1) state.articles.splice(i, 1);
      try { await deletePost(newItem.id); } catch (err) { /* 忽略 */ }
    }
    // 回滚已上传的文件，避免仓库里留下孤儿文件
    for (const p of uploadedPaths) {
      try {
        const f = await ghGet(p);
        if (f) await ghDelete(p, '回滚：发布失败清理文件', f.sha);
      } catch (err) { /* 清理失败不影响主流程 */ }
    }
    setMsg($('articleMsg'), e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------- 连接 ----------
async function connect() {
  const token = $('tokenInput').value.trim();
  const repoFull = $('repoInput').value.trim();
  const branch = $('branchInput').value.trim() || 'main';

  if (!token) { setMsg($('loginMsg'), '请填写 Token', 'err'); return; }
  if (!/^[^/]+\/[^/]+$/.test(repoFull)) {
    setMsg($('loginMsg'), '仓库格式应为 用户名/仓库名', 'err');
    return;
  }

  const parts = repoFull.split('/');
  state.token = token;
  state.owner = parts[0];
  state.repo = parts[1];
  state.branch = branch;

  setMsg($('loginMsg'), '正在验证…');
  try {
    await loadData();
    state.storedToken = token;
    localStorage.setItem(CFG_KEY, JSON.stringify({
      token: token,
      repo: repoFull,
      branch: branch
    }));
    enterAdmin();
  } catch (e) {
    setMsg($('loginMsg'), e.message, 'err');
  }
}

function enterAdmin() {
  $('loginPanel').hidden = true;
  $('adminArea').hidden = false;
  $('statusText').textContent = '已连接 ' + state.owner + '/' + state.repo + '（' + state.branch + '）';
  $('videoDate').value = today();
  $('articleDate').value = today();
  refreshLists();
}

function logout() {
  localStorage.removeItem(CFG_KEY);
  location.reload();
}

// ---------- 启动 ----------
document.addEventListener('DOMContentLoaded', function () {
  const saved = localStorage.getItem(CFG_KEY);
  if (saved) {
    try {
      const cfg = JSON.parse(saved);
      $('tokenInput').value = cfg.token || '';
      $('repoInput').value = cfg.repo || 'zhouzhoukjsh/zhouzhoukjsh.github.io';
      $('branchInput').value = cfg.branch || 'main';
    } catch (e) { /* 忽略损坏的配置 */ }
  }

  $('connectBtn').addEventListener('click', connect);
  $('logoutBtn').addEventListener('click', logout);
  $('addVideoBtn').addEventListener('click', addVideo);
  $('addArticleBtn').addEventListener('click', addArticle);

  // 已保存过 Token 就自动连一次
  if ($('tokenInput').value) connect();
});
