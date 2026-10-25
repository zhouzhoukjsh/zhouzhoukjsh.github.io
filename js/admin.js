// ========== 后台逻辑：通过 GitHub Contents API 读写数据 ==========

const CFG_KEY = 'zzblog_cfg';

const state = {
  token: '',
  owner: '',
  repo: '',
  branch: 'main',
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

function gitUrl(path) {
  return 'https://api.github.com/repos/' + state.owner + '/' + state.repo + path;
}

async function ghRequest(url, method, body) {
  const opt = {
    method: method,
    headers: {
      Authorization: 'Bearer ' + state.token,
      Accept: 'application/vnd.github+json'
    }
  };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  if (!res.ok) {
    const t = await res.text();
    const err = new Error('HTTP ' + res.status + ' ' + t.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return res.json();
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 一次提交写入多个文件（Git Data API）。
 * changes: [{ path, content: base64 }] 新增/覆盖
 *          [{ path, remove: true }]    删除
 * 整篇内容只产生 1 个 commit；失败不会留下半截文件。
 */
async function commitMany(changes, message) {
  if (!changes.length) return null;

  // 1. 先把所有文件内容上传为 blob（与提交解耦，重试时可复用）
  const blobShas = await Promise.all(changes.map(async c => {
    if (c.remove) return null;
    const blob = await ghRequest(gitUrl('/git/blobs'), 'POST', {
      content: c.content,
      encoding: 'base64'
    });
    return blob.sha;
  }));

  const entries = changes.map((c, i) => ({
    path: c.path,
    mode: '100644',
    type: 'blob',
    sha: c.remove ? null : blobShas[i]
  }));

  // 2. 基于最新 HEAD 建 tree → commit → 移动分支指针；冲突则重试
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ref = await ghRequest(gitUrl('/git/ref/heads/' + encodeURIComponent(state.branch)), 'GET');
      const parentSha = ref.object.sha;

      const parent = await ghRequest(gitUrl('/git/commits/' + parentSha), 'GET');

      const tree = await ghRequest(gitUrl('/git/trees'), 'POST', {
        base_tree: parent.tree.sha,
        tree: entries
      });

      const commit = await ghRequest(gitUrl('/git/commits'), 'POST', {
        message: message,
        tree: tree.sha,
        parents: [parentSha]
      });

      await ghRequest(gitUrl('/git/refs/heads/' + encodeURIComponent(state.branch)), 'PATCH', {
        sha: commit.sha,
        force: false
      });

      return commit;
    } catch (e) {
      lastErr = e;
      if (attempt === 3) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error('提交失败：' + (lastErr ? lastErr.message : '未知错误'));
}

// 构造索引内容（只保留轻量字段）
function buildIndexJSON(items) {
  const index = items.map(it => ({ id: it.id, title: it.title, date: it.date }));
  return JSON.stringify({ items: index }, null, 2);
}

// ---------- 数据读写 ----------
async function loadData() {
  const v = await ghGet('data/videos.json');
  state.videos = v ? (JSON.parse(b64Decode(v.content)).items || []) : [];

  const a = await ghGet('data/articles.json');
  state.articles = a ? (JSON.parse(b64Decode(a.content)).items || []) : [];

  await migrateLegacy();
}

// 早期版本把正文（含 base64 图片）直接塞在索引里。
// 这里把它拆成：图片 → docs/images/，正文 → data/posts/<id>.json，索引只留标题日期。
// 整个过程合并成一次提交。
async function migrateLegacy() {
  const legacy = state.articles.filter(it => it.content || it.iframe);
  if (!legacy.length) return;

  setMsg($('loginMsg'), '正在整理历史数据，共 ' + legacy.length + ' 篇…');

  const changes = [];
  for (const it of legacy) {
    const exists = await ghGet('data/posts/' + it.id + '.json');
    if (exists) continue;

    let content = it.content || '';
    const images = extractInlineImages(content);
    const imgPaths = [];
    for (let i = 0; i < images.length; i++) {
      const p = 'docs/images/' + it.id + '_' + (i + 1) + '.' + images[i].ext;
      changes.push({ path: p, content: images[i].b64 });
      imgPaths.push(p);
      content = content.split(images[i].full).join(p);
    }

    changes.push({
      path: 'data/posts/' + it.id + '.json',
      content: b64Encode(JSON.stringify({
        id: it.id,
        title: it.title,
        date: it.date,
        docPath: it.docPath || '',
        images: imgPaths,
        content: content
      }, null, 2))
    });

    delete it.content;
    delete it.iframe;
    delete it.docPath;
    delete it.images;
  }

  if (!changes.length) {
    setMsg($('loginMsg'), '');
    return;
  }

  changes.push({
    path: 'data/articles.json',
    content: b64Encode(buildIndexJSON(state.articles))
  });

  await commitMany(changes, '整理历史图文数据（拆分为索引 + 单篇）');
  setMsg($('loginMsg'), '历史数据已整理完成');
}

function videosPayload() {
  return JSON.stringify({ items: state.videos }, null, 2);
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

  const removed = list.splice(idx, 1)[0];
  const changes = [];
  if (kind === 'video') {
    changes.push({ path: 'data/videos.json', content: b64Encode(videosPayload()) });
  } else {
    changes.push({ path: 'data/posts/' + item.id + '.json', remove: true });
    changes.push({ path: 'data/articles.json', content: b64Encode(buildIndexJSON(state.articles)) });
  }

  const msgEl = kind === 'video' ? $('videoMsg') : $('articleMsg');
  try {
    await commitMany(changes, '删除' + (kind === 'video' ? '视频' : '图文') + '：' + item.title);
    refreshLists();
    setMsg(msgEl, '已删除', 'ok');
  } catch (e) {
    // 提交失败则还原内存状态
    list.splice(idx, 0, removed);
    setMsg(msgEl, e.message, 'err');
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
  const item = {
    id: Date.now(),
    title: title,
    date: date,
    iframe: iframe
  };
  state.videos.push(item);
  try {
    await commitMany(
      [{ path: 'data/videos.json', content: b64Encode(videosPayload()) }],
      '发布视频教程：' + title
    );
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

    // 2. 收集所有要写入的文件，最后一次性提交
    const changes = [];
    const imgPaths = [];

    for (let i = 0; i < images.length; i++) {
      const imgPath = 'docs/images/' + stamp + '_' + (i + 1) + '.' + images[i].ext;
      changes.push({ path: imgPath, content: images[i].b64 });
      imgPaths.push(imgPath);
      content = content.split(images[i].full).join(imgPath);
    }

    const docName = 'docs/' + stamp + '_' + safeName(file.name);
    changes.push({ path: docName, content: arrayBufferToBase64(arrayBuffer) });

    newItem = {
      id: stamp,
      title: title,
      date: date,
      docPath: docName,
      images: imgPaths,
      content: content
    };
    changes.push({
      path: 'data/posts/' + stamp + '.json',
      content: b64Encode(JSON.stringify(newItem, null, 2))
    });

    // 3. 索引也放进同一次提交
    state.articles.push(newItem);
    changes.push({
      path: 'data/articles.json',
      content: b64Encode(buildIndexJSON(state.articles))
    });

    setMsg($('articleMsg'),
      '正在提交（' + (images.length + 3) + ' 个文件，1 次提交）…');
    await commitMany(changes, '发布图文：' + title);

    $('articleTitle').value = '';
    $('articleFile').value = '';
    $('articleDate').value = '';
    refreshLists();
    setMsg($('articleMsg'), '发布成功：' + chars + ' 字、' + images.length + ' 张图。站点约 1 分钟后生效', 'ok');
  } catch (e) {
    // 一次提交要么全成，要么全不成，只需回滚内存状态
    if (newItem) {
      const i = state.articles.findIndex(x => x.id === newItem.id);
      if (i > -1) state.articles.splice(i, 1);
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
