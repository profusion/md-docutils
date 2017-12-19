#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const process = require('process');
const cheerio = require('cheerio');
const spawn = require('child_process').spawn;
const EventEmitter = require('events').EventEmitter;
const XRegExp = require('xregexp/xregexp-all');

const defaultInputDir = './reports';
const defaultOutputDir = './out/spellchecked';
const defaultIgnoreElements = [ 'pre', 'code', 'a', 'svg', 'script', 'style' ];
const defaultAspellOption = [ '--encoding=utf-8', '--guess', '--run-together' ];
const spellCheckedSuffix = '-spellchecked.html';

const yargs = require('yargs')
      .usage('Usage:\n$0 file1.html [... fileN.html]')
      .option('root-element', {
        alias: 'r',
        describe: 'JQuery-like selector to get the root element to start spellcheck on.',
        default: process.env.ROOT || '#md-contents',
      })
      .option('lang', {
        alias: 'l',
        describe: 'Native (main) language for the document',
        default: process.env.LANG || 'en_US',
      })
      .option('element-lang', {
        alias: 'e',
        describe: 'Map the given HTML element to the given language (ie: em=pt_BR)',
        array: true,
      })
      .option('ignore-element', {
        alias: 'i',
        describe: 'Ignore the given element (ie: "code", "pre")',
        default: defaultIgnoreElements,
        array: true,
      })
      .option('personal-dict', {
        alias: 'p',
        describe: 'Use the given dict for a language (ie: en_US=mydict-en_US.pws)',
        array: true,
      })
      .option('aspell-option', {
        alias: 'A',
        describe: 'Define arguments to provide to aspell.',
        default: process.env.ASPELL_OPTIONS || defaultAspellOption,
        array: true,
      })
      .option('fail-fast', {
        alias: 'f',
        describe: 'Fail fast, exit on the first document that fails.',
        default: process.env.FAIL_FAST || false,
        type: 'boolean',
      })
      .option('output-dir', {
        alias: 'o',
        describe: 'Output directory to place each file.',
        default: process.env.OUTPUT_DIR || defaultOutputDir,
      })
      .option('verbose', {
        alias: 'v',
        describe: 'Be verbose while spell check',
        default: process.env.VERBOSE || 0,
        type: 'count',
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

function cleanupLang(lang) {
  return lang.replace(/[.@].*$/, '').replace('-', '_');
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

class Aspell extends EventEmitter {
  constructor(lang, args) {
    super();
    this.queue = [];
    this.proc = spawn('aspell', [ '-a', `--lang=${lang}` ].concat(args || []))
      .on('error', (err) => {
        this.emit('error', {
          category: 'spawn',
          message: err.toString(),
        });
      });

    this.proc.stderr
      .on('data', (data) => {
        this.emit('error', {
          category: 'stderr',
          message: data.toString(),
        });
      })
      .on('error', (err) => {
        this.emit('error', {
          category: 'stderr',
          message: err.toString(),
        });
      });

    this.proc.stdin
      .on('error', (err) => {
        this.emit('error', {
          category: 'stdin',
          message: err.toString(),
        });
      });

    this.buffer = '';
    this.proc.stdout
      .on('data', (chunk) => {
        const lines = (this.buffer + chunk).split(/\r?\n/);
        this.buffer = lines.pop();
        for (let i = 0; i < lines.length; i += 1) {
          const result = this.parseLine(lines[i]);
          if (result) {
            this.emit('result', result);
          }
        }
      })
      .on('end', function() {
        this.emit('finished');
      });
  }

  checkWord(word, info) {
    if (!Aspell.isWord(word)) {
      throw new Error('aspell should get only words (letters and numbers)!');
    }
    this.queue.push({ word, info });
    this.proc.stdin.write(word + '\n');
  }

  end() {
    this.proc.stdin.end();
  }

  parseLine(line) {
    if (line.length <= 0) {
      return { type: 'line-break' }
    }

    const c = line[0];
    if (c === '@') {
      return { type: 'comment' }
    }

    const q = this.queue.splice(0, 1)[0];
    const result = {
      type: Aspell.aspellToEventMap[c],
      word: q.word,
      info: q.info,
    }

    if (c === '&' || c === '#') {
      const parts = line.split(/:?,?\s/g);
      const word = parts[1];
      if (word !== q.word) {
        throw new Error('expected word: ' + q.word + ', got: ' + word);
      }
      result.position = parseInt(c === '#' ? parts[2] : parts[3]);
      result.alternatives = parts.slice(4);
    }

    return result;
  }

  static isWord(str) {
    return !!str.match(Aspell.isWordRegExp);
  }

  static splitWordsAndSpaces(str) {
    return str.split(Aspell.splitWordsAndSpacesRegExp).filter(p => !!p);
  }
}

Aspell.wordRegExp = '\\pL\\pN';
Aspell.isWordRegExp = XRegExp(`^[${Aspell.wordRegExp}]+$`);
Aspell.splitWordsAndSpacesRegExp = XRegExp(`([${Aspell.wordRegExp}]+|[^${Aspell.wordRegExp}]+)`);
Aspell.aspellToEventMap = {
  '*': 'ok',
  '-': 'run-together',
  '&': 'misspelling', /* with suggestions */
  '#': 'misspelling', /* no suggestions */
};

async function spellCheckChildren(node, options, lang) {
  const misspellings = [];
  const children = node.children;
  for (let i = 0; i < children.length; i += 1) {
    misspellings.push(... await spellCheckNode(children[i], options, lang));
    if (misspellings.length > 0 && options.failFast) {
      break;
    }
  }

  return misspellings;
}

function spellCheckText(node, options, lang) {
  const { data } = node;
  const parts = Aspell.splitWordsAndSpaces(data);
  const promises = [];
  const checker = options.checkers[lang];
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const word = parts[i];
    if (Aspell.isWord(word)) {
      promises.push(new Promise(function (resolve, reject) {
        checker.checkWord(word, { resolve, reject, offset, lang });
      }));
    } else {
      promises.push(Promise.resolve({ success: true, word, offset, lang }));
    }
    offset += word.length;
  }
  return Promise.all(promises).then((spellCheckResults) => {
    if (spellCheckResults.every(r => r.success)) {
      return [];
    }
    return [ { node, spellCheckResults } ];
  });
}

function spellCheckTag(node, options, parentNodeLang) {
  const { name, children } = node;
  if (options.ignoreElement.indexOf(name) !== -1) {
    if (options.verbose > 1) {
      console.error('DEBUG: ignored element:', node);
    }
    return [];
  }

  const lang = options.elementLang[name] || parentNodeLang;
  if (children) {
    return spellCheckChildren(node, options, lang);
  }
  console.error('UNHANDLED: spell check without children:', node);
  return [];
}

async function spellCheckNode(node, options, parentNodeLang) {
  switch (node.type) {
    case 'text':
      return spellCheckText(node, options, parentNodeLang);
    case 'tag': {
      return spellCheckTag(node, options, parentNodeLang);
    }
    default:
      console.error(`UNHANDLED: unexpected node type: ${node.type}, name: ${node.name}`);
      return [];
  }
}

function getAspellOptionsForLang(options, lang) {
  const pws = options.personalDict[lang];
  if (!pws) {
    return options.aspellOption;
  }
  return options.aspellOption.concat([ `--personal=${pws}` ]);
}

async function spellCheckHtml(fname, baseOptions) {
  const contents = loadFile(fname);
  const doc = cheerio.load(contents);
  const root = doc(baseOptions.rootElement)[0];
  const options = {
    ...baseOptions,
    doc,
    root,
  };
  if (!root || root.length === 0) {
    throw new Error(`Could not find root element using JQuery selector: ${options.rootElement}`);
  }

  return spellCheckChildren(root, options, options.lang)
    .then((misspellings) => {
      if (misspellings.length === 0) {
        return null;
      }

      for (let i = 0; i < misspellings.length; i += 1) {
        const { node, spellCheckResults } = misspellings[i];
        doc(node).replaceWith(spellCheckResults.map((r) => {
          if (r.success) {
            return r.word;
          }
          const { lang } = r.info;
          if (options.verbose > 0) {
            console.error(`${fname} misspelled ${lang}: ${r.word}`);
          }
          return doc(`<abbr class="misspelling lang-${lang}" />`)
            .text(r.word)
            .attr('title', r.alternatives.join(', ') + '?');
        }));
      }

      const outFile = path.join(options.outputDir, fname.replace(/[.]html$/, spellCheckedSuffix));
      doc('head').append(doc('<style type="text/css" />').text('abbr.misspelling { text-decoration: underline red; background-color: rgba(255, 40, 100, 0.25); }'));
      saveFile(outFile, doc.html());
      return outFile;
    });
}

function parsePersonalDict(array, lang) {
  // allow single list to omit the language
  if (array && array.length === 1 && array[0].indexOf('=') == -1) {
    return { [cleanupLang(lang)]: array[0] };
  }
  return arrayToMap(array);
}

function listDirectoryHtmls(dirname) {
  return fs.readdirSync(dirname, { encoding: 'utf8' })
    .filter(fname => fname.endsWith('.html') && !fname.endsWith(spellCheckedSuffix))
    .map(fname => path.join(dirname, fname));
}

let htmls = [];
if (argv._.length === 0) {
  htmls.push(...listDirectoryHtmls(defaultInputDir));
} else {
  for (let i = 0; i < argv._.length; i += 1) {
    const html = argv._[i];
    const st = fs.statSync(html);
    if (st.isDirectory()) {
      htmls.push(...listDirectoryHtmls(html));
    } else {
      htmls.push(html);
    }
  }
}

const options = {
  rootElement: argv.rootElement,
  lang: cleanupLang(argv.lang),
  elementLang: arrayToMap(argv.elementLang || envOptionAsArray(process.env.ELEMENT_LANG)),
  ignoreElement: argv.ignoreElement || envOptionAsArray(process.env.IGNORE_ELEMENT),
  personalDict: parsePersonalDict(argv.personalDict || envOptionAsArray(process.env.PERSONAL_DICT), argv.lang),
  aspellOption: argv.aspellOption || envOptionAsArray(process.env.ASPELL_OPTIONS),
  outputDir: argv.outputDir || defaultOutputDir,
  failFast: argv.failFast,
  verbose: argv.verbose,
  checkers: {},
};

options.checkers[options.lang] = new Aspell(options.lang, getAspellOptionsForLang(options, options.lang));
for (const el in options.elementLang) {
  if (options.elementLang.hasOwnProperty(el)) {
    const lang = options.elementLang[el];
    if (!options.checkers[lang]) {
      options.checkers[lang] = new Aspell(lang, getAspellOptionsForLang(options, lang));
    }
  }
}

for (const name in options.checkers) {
  if (options.checkers.hasOwnProperty(name)) {
    options.checkers[name]
      .on('result', function (result) {
        const { word, info, alternatives } = result;
        switch (result.type) {
          case 'ok':
            result.info.resolve({ success: true, word, info });
            break;
          case 'misspelling':
          case 'run-together': {
            result.info.resolve({ success: false, word, info, alternatives });
            break;
          }
          case 'line-break':
          case 'comment':
            if (options.verbose > 2) {
              console.error('ignored aspell result:', result);
            }
            break;
          default:
            console.error(`unexpected result type ${result.type}`, result);
        }
      })
      .on('error', function (error) {
        console.error('Failed to run aspell:', error.category);
        console.error(error.message);
        if (error.category !== 'stdin') {
          // wait 'spawn' or 'stderr' before exit.
          process.exit(1);
        }
      });
  }
}


async function main(htmls, options) {
  let exitStatus = 0;
  for (let i = 0; i < htmls.length; i += 1) {
    const outFile = await spellCheckHtml(htmls[i], options);
    console.log(`${htmls[i]} => ${outFile ? 'Failed: ' + outFile : 'Ok!'}`);
    if (outFile) {
      exitStatus = 1;
      if (options.failFast) {
        break;
      }
    }
  }
  return exitStatus;
}

main(htmls, options)
  .then(process.exit)
  .catch(exc => {
    console.error('ERROR:', exc);
    process.exit(1);
  });
