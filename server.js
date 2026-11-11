// Servidor do Controle de Patrimônio e OS - New END.
// Requer Node.js 18 ou superior. Exclusões são protegidas por sessão administrativa.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SENHA = process.env.SENHA || '';
const ADMIN_SENHA = process.env.ADMIN_SENHA || '';
const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'dados.json');
const BK = path.join(DIR, 'backups');
const AUDIT = path.join(DIR, 'auditoria.json');
const LOC_PHOTOS = path.join(DIR, 'locacao-fotos');
fs.mkdirSync(LOC_PHOTOS, { recursive: true });
const BACKUP_DAYS = 365;
const COLS = ['eq', 'os', 'cli', 'pes', 'vei', 'tip', 'blo', 'loc'];
const TIPOS_PADRAO = ['Aparelho', 'Cabeçote', 'Scanner', 'Bateria', 'Carregador', 'Fonte', 'Encoder', 'Sapata'];
const sessions = new Map();

fs.mkdirSync(BK, { recursive: true });
let db = {};
COLS.forEach(c => db[c] = {});
let semTipos = true;
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  COLS.forEach(c => { if (saved[c] && typeof saved[c] === 'object') db[c] = saved[c]; });
  semTipos = saved.tip === undefined;
} catch (_) {}
// Primeira execução com o cadastro de tipos: cria os tipos padrão (uma única vez).
if (semTipos) {
  TIPOS_PADRAO.forEach(nome => {
    const id = 'tip_' + nome.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
    db.tip[id] = { id, nome };
  });
  try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('Falha ao criar tipos padrão:', e.message); }
}

function persist() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
function audit(action, collection, id, record) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(AUDIT, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch (_) {}
  entries.push({ date: new Date().toISOString(), action, collection, id, admin: true, record: record || null });
  if (entries.length > 10000) entries = entries.slice(-10000);
  fs.writeFileSync(AUDIT, JSON.stringify(entries, null, 2));
}
function backup() {
  try {
    if (!fs.existsSync(FILE)) return;
    const day = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(FILE, path.join(BK, `dados-${day}.json`));
    const cutoff = Date.now() - BACKUP_DAYS * 86400000;
    for (const name of fs.readdirSync(BK)) {
      const match = /^dados-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (match && new Date(match[1] + 'T00:00:00Z').getTime() < cutoff) fs.unlinkSync(path.join(BK, name));
    }
  } catch (e) { console.error('Falha no backup:', e.message); }
}
backup();
setInterval(backup, 6 * 60 * 60 * 1000);

function send(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(obj));
}
function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) { reject(new Error('payload grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (_) { reject(new Error('json inválido')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
  }));
}
function isAdmin(req) {
  const token = cookies(req).newend_admin;
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
  const calc = n => { let soma = 0, pos = n - 7; for (let i = n; i >= 1; i--) { soma += Number(c[n - i]) * pos--; if (pos < 2) pos = 9; } const r = soma % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'ControleOS-NewEND' } });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const foneBR = t => { const d = String(t || '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}` : d.length === 11 ? `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}` : String(t || '').trim(); };
async function consultarCnpj(c) {
  // 1) BrasilAPI  2) ReceitaWS (reserva)
  let notFound = false;
  try {
    const { status, data } = await getJson('https://brasilapi.com.br/api/cnpj/v1/' + c);
    if (status === 200 && data && data.razao_social) {
      return { cnpj: c, nome: data.razao_social, fantasia: data.nome_fantasia || '', situacao: data.descricao_situacao_cadastral || '',
        municipio: data.municipio || '', uf: data.uf || '', telefone: foneBR(data.ddd_telefone_1), email: data.email || '',
        endereco: [data.descricao_tipo_de_logradouro, data.logradouro, data.numero, data.bairro, data.cep].filter(Boolean).join(', ') };
    }
    if (status === 404) notFound = true;
  } catch (_) {}
  try {
    const { status, data } = await getJson('https://receitaws.com.br/v1/cnpj/' + c);
    if (status === 200 && data && data.status !== 'ERROR' && data.nome) {
      return { cnpj: c, nome: data.nome, fantasia: data.fantasia || '', situacao: data.situacao || '',
        municipio: data.municipio || '', uf: data.uf || '', telefone: foneBR(String(data.telefone || '').split('/')[0]), email: data.email || '',
        endereco: [data.logradouro, data.numero, data.bairro, data.cep].filter(Boolean).join(', ') };
    }
    if (data && data.status === 'ERROR' && /inv[aá]lido|n[aã]o encontrado/i.test(data.message || '')) notFound = true;
  } catch (_) {}
  return notFound ? { erro: 'CNPJ não encontrado na base da Receita.', code: 404 }
                  : { erro: 'Não foi possível consultar agora. Verifique se o servidor tem acesso à internet e tente novamente em instantes.', code: 502 };
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const server = http.createServer(async (req, res) => {
  try {
    if (SENHA) {
      const auth = (req.headers.authorization || '').split(' ')[1] || '';
      let supplied = '';
      try { supplied = Buffer.from(auth, 'base64').toString().split(':').slice(1).join(':'); } catch (_) {}
      if (!safeEqual(supplied, SENHA)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Controle de OS"' });
        return res.end('Senha necessária');
      }
    }

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/logo.png' && req.method === 'GET') {
      const logo = path.join(__dirname, 'public', 'logo.png');
      if (!fs.existsSync(logo)) { res.writeHead(404); return res.end('Logo não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(logo).pipe(res);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (parts[0] !== 'api' && parts[0] !== 'locacao-fotos') { res.writeHead(404); return res.end('Não encontrado'); }

    if (url.pathname === '/api/admin/status' && req.method === 'GET')
      return send(res, 200, { admin: isAdmin(req), configured: !!ADMIN_SENHA });

    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      if (!ADMIN_SENHA) return send(res, 503, { erro: 'Senha administrativa ainda não configurada no servidor.' });
      const body = await readBody(req);
      if (!safeEqual(body.password || '', ADMIN_SENHA)) return send(res, 401, { erro: 'Senha administrativa inválida.' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `newend_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
    }
    if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
      const token = cookies(req).newend_admin;
      if (token) sessions.delete(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'newend_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    // Fotos de locação: arquivos separados do banco JSON para manter a sincronização leve.
    if (url.pathname === '/api/locacao-fotos' && req.method === 'POST') {
      const body = await readBody(req, 12 * 1024 * 1024);
      const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = allowed[body.mime];
      if (!ext || typeof body.data !== 'string' || body.data.length > 10 * 1024 * 1024)
        return send(res, 400, { erro: 'Imagem inválida. Use JPG, PNG ou WEBP de até 7 MB.' });
      const raw = body.data.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '');
      if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return send(res, 400, { erro: 'Arquivo de imagem inválido.' });
      const bytes = Buffer.from(raw, 'base64');
      if (!bytes.length || bytes.length > 7 * 1024 * 1024) return send(res, 413, { erro: 'A imagem deve ter até 7 MB.' });
      const name = crypto.randomBytes(18).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(LOC_PHOTOS, name), bytes, { flag: 'wx' });
      return send(res, 201, { name, url: '/locacao-fotos/' + name, mime: body.mime });
    }
    if (parts[0] === 'locacao-fotos' && parts[1] && req.method === 'GET') {
      const name = path.basename(parts[1]);
      if (name !== parts[1] || !/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(name)) { res.writeHead(400); return res.end('Arquivo inválido'); }
      const file = path.join(LOC_PHOTOS, name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Foto não encontrada'); }
      const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }

    if (parts[1] === 'cnpj' && parts[2] && req.method === 'GET') {
      const c = decodeURIComponent(parts[2]).replace(/\D/g, '');
      if (!cnpjValido(c)) return send(res, 400, { erro: 'CNPJ inválido. Confira os números digitados.' });
      const r = await consultarCnpj(c);
      return r.erro ? send(res, r.code, { erro: r.erro }) : send(res, 200, r);
    }

    // Reativar OS finalizada (somente administrador, com registro de auditoria)
    if (parts[1] === 'os' && parts[2] && parts[3] === 'reativar' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { erro: 'Somente o administrador pode reativar OS.' });
      const oid = decodeURIComponent(parts[2]);
      const o = db.os[oid];
      if (!o) return send(res, 404, { erro: 'OS não encontrada.' });
      if (o.status === 'Aberta') return send(res, 409, { erro: 'Esta OS já está em andamento.' });
      const ids = new Set((o.items || []).map(i => i.id).filter(Boolean));
      const conflitos = [];
      Object.values(db.os).forEach(x => { if (x.id !== oid && x.status === 'Aberta' && (x.items || []).some(i => ids.has(i.id))) conflitos.push(x.no || x.id); });
      if (conflitos.length) return send(res, 409, { erro: 'Não é possível reativar: há equipamento(s) ou bloco(s) desta OS em outra OS em andamento (' + [...new Set(conflitos)].join(', ') + '). Registre a devolução dela antes.' });
      const novo = { ...o, status: 'Aberta', reativacoes: [...(o.reativacoes || []), { date: new Date().toISOString() }] };
      delete novo.ret;
      db.os[oid] = novo;
      persist();
      audit('reativação', 'os', oid, { no: o.no || '', cliente: o.cliente || o.dest || '', statusAnterior: o.status, retornoAnterior: o.ret || null, statusNovo: 'Aberta', itens: (o.items || []).map(i => i.pat || i.desc) });
      return send(res, 200, { ok: 1, os: novo });
    }

    const collection = parts[1];
    const id = parts[2] && decodeURIComponent(parts[2]);
    if (!COLS.includes(collection)) return send(res, 404, { erro: 'coleção não encontrada' });
    if (req.method === 'GET' && !id) return send(res, 200, Object.values(db[collection]));
    if (req.method === 'PUT' && id) {
      const body = await readBody(req);
      // Uma OS devolvida só volta a "Aberta" pela rota de reativação (administrador + auditoria).
      if (collection === 'os' && db.os[id] && db.os[id].status === 'Devolvida' && body.status === 'Aberta')
        return send(res, 403, { erro: 'Para reativar uma OS finalizada use a opção "Reativar OS" (administrador).' });
      // Impede que o mesmo equipamento ou bloco fique simultaneamente em duas OS abertas.
      if (collection === 'os' && body.status === 'Aberta') {
        const ids = new Set((body.items || []).map(i => i.id).filter(Boolean));
        const conflitos = [];
        Object.values(db.os).forEach(x => {
          if (x.id !== id && x.status === 'Aberta' && (x.items || []).some(i => ids.has(i.id)))
            conflitos.push(x.no || x.id);
        });
        if (conflitos.length)
          return send(res, 409, { erro: 'Não é possível salvar esta OS: equipamento(s) ou bloco(s) já vinculado(s) a outra OS aberta (' + [...new Set(conflitos)].join(', ') + '). Registre a devolução antes.' });
      }
      body.id = id;
      db[collection][id] = body;
      persist();
      return send(res, 200, { ok: 1 });
    }
    if (req.method === 'DELETE' && id) {
      if (!isAdmin(req)) return send(res, 403, { erro: 'Somente o administrador pode excluir registros.' });
      const old = db[collection][id];
      delete db[collection][id];
      persist();
      audit('exclusão', collection, id, old);
      return send(res, 200, { ok: 1 });
    }
    return send(res, 405, { erro: 'método não permitido' });
  } catch (e) {
    console.error('Erro na requisição:', e.message);
    if (!res.headersSent) send(res, 400, { erro: 'Não foi possível processar a solicitação.' });
    else res.end();
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\nERRO: a porta ${PORT} já está em uso. Provavelmente o servidor antigo ainda está rodando (outra janela do iniciar.bat, serviço ou PM2). Feche-o e inicie novamente.`);
  else console.error('Erro no servidor:', e.message);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  const pagina = path.join(__dirname, 'public', 'index.html');
  try { console.log(`Página servida: ${pagina}\nÚltima alteração do arquivo: ${fs.statSync(pagina).mtime.toLocaleString('pt-BR')}`); }
  catch (_) { console.error(`ATENÇÃO: não encontrei ${pagina}. O index.html precisa ficar dentro da pasta public.`); }
  console.log(`Controle de Patrimônio e OS rodando na porta ${PORT}. Acesse http://localhost:${PORT}`);
  if (!ADMIN_SENHA) console.warn('ATENÇÃO: configure ADMIN_SENHA para habilitar o acesso administrativo.');
  console.log(`Backups diários: retenção de ${BACKUP_DAYS} dias.`);
});
