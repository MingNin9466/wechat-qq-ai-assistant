/**
 * 查询 GitHub Release 的资产列表（只读，不下载）。
 * 用法：node tools/list-release.mjs <owner/repo> <tag>
 */
const [repo, tag] = process.argv.slice(2);
if (!repo || !tag) {
  console.error('用法: node tools/list-release.mjs tom-snow/wechat-windows-versions v3.9.12.17');
  process.exit(1);
}

const urls = [
  `https://api.github.com/repos/${repo}/releases/tags/${tag}`,
  `https://gh-proxy.com/https://api.github.com/repos/${repo}/releases/tags/${tag}`,
];

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wechat-bot-setup',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

for (const url of urls) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    if (!res.ok) {
      console.log(`✖ ${url} → HTTP ${res.status}`);
      continue;
    }
    const data = await res.json();
    console.log(`✔ ${url}`);
    console.log(`版本：${data.tag_name}  发布：${data.published_at}`);
    console.log(`资产数：${(data.assets ?? []).length}\n`);
    for (const a of data.assets ?? []) {
      const mb = (a.size / 1024 / 1024).toFixed(1);
      console.log(`- ${a.name}  ${mb} MB  downloads=${a.download_count}`);
      console.log(`  ${a.browser_download_url}`);
    }
    process.exit(0);
  } catch (err) {
    console.log(`✖ ${url} → ${err.message}`);
  }
}
console.error('两个地址都失败了');
process.exit(1);
