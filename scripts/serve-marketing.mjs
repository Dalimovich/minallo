// Local built-artifact preview. No API proxy or authenticated user data.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const root = resolve(process.env.MARKETING_DIR || 'dist');
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
};
createServer((req, res) => {
  let path;
  try {
    path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== root && !path.startsWith(root + sep)) throw new Error('outside root');
    if (statSync(path).isDirectory()) path = resolve(path, 'index.html');
    res.setHeader(
      'Content-Type',
      `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`
    );
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      res.end(readFileSync(resolve(root, '404.html')));
    } catch {
      res.end('Not found');
    }
  }
}).listen(Number(process.env.PORT || 4178), '127.0.0.1', () => {
  console.log(`Marketing preview: http://127.0.0.1:${process.env.PORT || 4178}`);
});
