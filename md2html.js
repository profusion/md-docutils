#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const process = require('process');
const hljs = require('highlight.js');
const marked = require('marked');
const mkdirp = require('mkdirp');
const mustache = require('mustache');
const DOMParser = require('xmldom').DOMParser;
const xpath = require('xpath');

const defaultInputDir = './reports';
const defaultOutputDir = './out';
const defaultToCTitle = 'Table of Contents';
const defaultHighlightTheme = 'github';

const hljsStylesDir = path.join(require.resolve('highlight.js'), '../../styles');
const hljsThemes = fs.readdirSync(hljsStylesDir)
      .filter(fname => fname.endsWith('.css'))
      .map(fname => path.basename(fname, '.css'))
      .sort();

const yargs = require('yargs')
      .usage('Usage:\n$0 file1.md [... fileN.md]')
      .option('title', {
        alias: 't',
        describe: 'Document Title to use, otherwise based on filename. Exposed to Mustache template.',
        default: process.env.TITLE,
      })
      .option('author', {
        alias: 'a',
        describe: 'Document Author to use, otherwise empty. Exposed to Mustache template.',
        default: process.env.AUTHOR,
      })
      .option('date', {
        alias: 'd',
        describe: 'Document Date to use (passed as-is), otherwise empty. Exposed to Mustache template.',
        default: process.env.DATE,
      })
      .option('var', {
        alias: 'v',
        describe: 'Extra variables to use in replacements (key=value). These are exposed to Mustache template.',
        array: true,
      })
      .option('css', {
        alias: 'c',
        describe: 'CSS files to include (inline).',
        array: true,
      })
      .option('js', {
        alias: 'j',
        describe: 'JavaScript files to include (inline).',
        array: true,
      })
      .option('front-page', {
        alias: 'f',
        describe: 'Front Page to file include (inline, HTML with Mustache templates).',
        default: process.env.FRONT_PAGE,
      })
      .option('back-page', {
        alias: 'b',
        describe: 'Back (last) Page to file include (inline, HTML with Mustache templates).',
        default: process.env.BACK_PAGE,
      })
      .option('toc', {
        alias: 'T',
        describe: 'Generate Table of Contents. May contain a string to state section text.',
        default: process.env.TOC,
      })
      .option('highlight-theme', {
        alias: 'H',
        describe: 'Highlight.js theme name (CSS file name).',
        default: process.env.HIGHLIGHT_THEME || defaultHighlightTheme,
        choices: hljsThemes,
      })
      .option('output-dir', {
        alias: 'o',
        describe: 'Output directory to place each file.',
        default: process.env.OUTPUT_DIR || defaultOutputDir,
      })
      .alias({
        h: 'help',
      })
      .help('help')
      .version(false);

const argv = yargs.argv;

function envOptionAsArray(str) {
  if (!str) {
    return [];
  }
  try {
    return JSON.parse(str);
  } catch (exc) {
    if (str.indexOf('"') === -1 && str.indexOf('\'') === -1) {
      const array = str.split(';');
      if (array.length > 1) {
        return array;
      }
      return array[0].split(',');
    } else {
      throw new Error(`unexpected serialized array: ${str}. Use proper JSON! ${exc}`);
    }
  }
}

function arrayToMap(array) {
  const ret = {};
  for (let i = 0; i < array.length; i += 1) {
    const parts = array[i].split('=');
    if (parts.length < 2) {
      throw new Error(`Invalid map format. Expected key=value, got: ${array[i]}`);
    }
    const k = parts[0];
    const v = parts.slice(1).join('=');
    ret[k] = v;
  }
  return ret;
}

function saveFile(fname, contents) {
  mkdirp.sync(path.dirname(fname));
  return fs.writeFileSync(fname, contents, { encoding: 'utf8' });
}

function loadFile(fname) {
  if (!fname) {
    return '';
  }
  return fs.readFileSync(fname, { encoding: 'utf8' });
}

function loadFiles(array) {
  return array.map(fname => loadFile(fname)).join('\n');
}

function loadHighlightTheme(theme) {
  const fname = path.isAbsolute(theme) ? theme : `${hljsStylesDir}/${theme}.css`;
  return loadFile(fname);
}

function fname2title(fname) {
  return fname
    .replace(/[.]md$/, '')
    .replace(/[^A-Za-z0-9]/g, ' ')
    .replace(/\s+/g, ' ');
}

function getNodeContents(n, options) {
  const { noLink } = options;
  let txt = '';
  for (let i = 0; i < n.childNodes.length; i += 1) {
    const c = n.childNodes[i];
    if (noLink && c.nodeName === 'a') {
      txt += getNodeContents(c, options);
    } else {
      txt += c.toString();
    }
  }
  return txt;
}

function genToc(title, htmlInnerContents) {
  const toc = [
    '<h1 id="toc">' + title + '</h1>',
    '<ul id="toc-contents">',
  ];

  const doc = new DOMParser().parseFromString('<html>' + htmlInnerContents + '</html>');
  const nodes = xpath.select('//h1 | //h2 | //h3 | //h4 | //h5', doc);
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const nid = n.getAttribute('id');
    const ntext = getNodeContents(n, { noLink: true } );
    toc.push(`<li class="toc-${n.nodeName} toc-item"><a href="#${nid}">${ntext}</a></li>`);
  }

  toc.push('</ul>');

  return toc.join('\n');
}

function escaped(text) {
  return text.replace('<', '&lt;').replace('>', '&gt;');
}

function md2html(fname, options = {}) {
  const replacements = {
    title: options.title || fname2title(fname),
    author: options.author,
    date: options.date,
    ...options.vars,
  };

  const highlightTheme = loadHighlightTheme(options.highlightTheme);
  const mdContents = loadFile(fname);
  const htmlInnerContents = marked(mdContents);
  const htmlContents = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escaped(replacements.title)}</title>`,
    replacements.author ? `<meta name="author" content="${escaped(replacements.author)}" />` : '',
    replacements.date ? `<meta name="date" content="${escaped(replacements.date)}" />` : '',
    '<style type="text/css">',
    highlightTheme,
    options.css,
    '</style>',
    ...(options.js ? ['<script type="text/javascript">', options.js, '</script>' ] : []),
    '</head>',
    '<body>',
    mustache.render(options.frontPage, replacements),
    options.toc ? genToc(options.toc === true ? defaultToCTitle : options.toc, htmlInnerContents) : '',
    '<div id="md-contents">',
    htmlInnerContents,
    '</div>',
    mustache.render(options.backPage, replacements),
    '</body>',
    '</html>',
  ];
  const outFile = path.join(options.outputDir, fname.replace(/[.]md$/, '.html'));
  saveFile(outFile, htmlContents.join('\n'));
  return outFile;
}

function listDirectoryMds(dirname) {
  return fs.readdirSync(dirname, { encoding: 'utf8' })
    .filter(fname => fname.endsWith('.md'))
    .map(fname => path.join(dirname, fname));
}

let mds = [];
if (argv._.length === 0) {
  mds.push(...listDirectoryMds(defaultInputDir));
} else {
  for (let i = 0; i < argv._.length; i += 1) {
    const md = argv._[i];
    const st = fs.statSync(md);
    if (st.isDirectory()) {
      mds.push(...listDirectoryMds(md));
    } else {
      mds.push(md);
    }
  }
}

const options = {
  title: argv.title,
  author: argv.author,
  date: argv.date,
  vars: arrayToMap(argv.var || envOptionAsArray(process.env.VAR)),
  css: loadFiles(argv.css || envOptionAsArray(process.env.CSS)),
  js: loadFiles(argv.js || envOptionAsArray(process.env.JS)),
  frontPage: loadFile(argv.frontPage),
  backPage: loadFile(argv.backPage),
  toc: argv.toc,
  outputDir: argv.outputDir || defaultOutputDir,
  highlightTheme: argv.highlightTheme,
};

marked.setOptions({
  highlight: function (code, lang) {
    try {
      return hljs.highlight(lang, code).value;
    } catch (exc) {
      console.error(`ERROR: failed to highlight using ${lang}: ${exc}. Try 'auto'.`);
      return hljs.highlightAuto(code).value;
    }
  }
});

for (let i = 0; i < mds.length; i += 1) {
  const outFile = md2html(mds[i], options);
  console.log(`${mds[i]} => ${outFile}`);
}
