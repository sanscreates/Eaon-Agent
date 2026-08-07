// A small, dependency-free markdown renderer with just enough syntax
// highlighting to make agent output readable. Everything is escaped before it
// reaches the DOM — model output is never trusted as HTML.

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// syntax highlighting
// ---------------------------------------------------------------------------

const KEYWORDS = {
  js: 'as async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined',
  ts: 'abstract any as async await boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace new number of private protected public readonly return static string super switch this throw try type typeof var void while yield true false null undefined',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda none nonlocal not or pass raise return true false try while with yield self',
  sh: 'if then else elif fi for while do done case esac function return export local set unset echo cd source exit trap read',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while',
  json: 'true false null',
  css: 'important media import keyframes from to',
  html: '',
};

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  golang: 'go', rs: 'rust',
  yml: 'yaml',
};

/** Token scanner shared by every language; the keyword set does the rest. */
const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/gi;

export function highlight(code, lang) {
  const key = ALIASES[(lang || '').toLowerCase()] ?? (lang || '').toLowerCase();
  const words = KEYWORDS[key];
  if (words === undefined) return escapeHtml(code);
  const keywords = new Set(words.split(' ').filter(Boolean));
  const hashComments = key === 'py' || key === 'sh' || key === 'yaml';

  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(code))) {
    const [text, comment, string, number, word] = m;
    // `#` only starts a comment in languages that say so, and `//` never does
    // in a shell script.
    if (comment && ((comment.startsWith('#') && !hashComments) || (comment.startsWith('//') && hashComments))) continue;
    out += escapeHtml(code.slice(last, m.index));
    last = m.index + text.length;
    if (comment) out += `<span class="tok-comment">${escapeHtml(text)}</span>`;
    else if (string) out += `<span class="tok-string">${escapeHtml(text)}</span>`;
    else if (number) out += `<span class="tok-number">${escapeHtml(text)}</span>`;
    else if (word && keywords.has(word.toLowerCase())) out += `<span class="tok-keyword">${escapeHtml(text)}</span>`;
    else out += escapeHtml(text);
  }
  return out + escapeHtml(code.slice(last));
}

/** Colorize a unified diff (used by the diff viewer and edit previews). */
export function renderDiff(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-file';
      else if (line.startsWith('@@')) cls = 'diff-hunk';
      else if (line.startsWith('+')) cls = 'diff-add';
      else if (line.startsWith('-')) cls = 'diff-del';
      else if (/^(diff |index |new file|deleted file|similarity)/.test(line)) cls = 'diff-meta';
      return `<span class="diff-line ${cls}">${escapeHtml(line) || '&nbsp;'}</span>`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// inline markdown
// ---------------------------------------------------------------------------

function inline(src) {
  let html = escapeHtml(src);
  const codes = [];
  html = html.replace(/`([^`]+)`/g, (_, body) => {
    codes.push(body);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

function codeBlock(lang, body) {
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span class="code-lang">text</span>';
  const isDiff = /^(diff|patch)$/i.test(lang || '') || /^(---|\+\+\+|@@|diff --git)/m.test(body);
  const inner = isDiff ? renderDiff(body) : highlight(body, lang);
  return (
    `<figure class="code-block" data-code="${escapeHtml(body)}">` +
    `<figcaption>${label}<button class="code-copy" type="button" data-copy>Copy</button></figcaption>` +
    `<pre><code>${inner}</code></pre></figure>`
  );
}

function tableBlock(rows) {
  const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    head.map((c) => `<th>${inline(c)}</th>`).join('') +
    '</tr></thead><tbody>' +
    body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
    '</tbody></table></div>'
  );
}

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      out.push(codeBlock(lang, body.join('\n')));
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // table
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
      out.push(tableBlock(rows));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line);
      const tag = isOrdered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && (isOrdered ? ordered : bullet).test(lines[i])) {
        let item = lines[i++].replace(isOrdered ? ordered : bullet, '');
        // continuation lines indented under the bullet
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !ordered.test(lines[i])) {
          item += '\n' + lines[i++].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !bullet.test(lines[i]) && !ordered.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('\n');
}
